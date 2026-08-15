import { spawn } from "node:child_process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { describeInterpreterInlineEval } from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import {
  evaluateShellAllowlistWithAuthorization,
  resolveExecApprovalsLocked,
  resolveExecModePolicy,
  minSecurity,
  requiresExecApproval,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import type { SafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { evaluateSystemRunPolicy } from "../node-host/exec-policy.js";
import { killProcessTree } from "../process/kill-tree.js";
import { resolveTrustedWindowsCmdExe } from "../process/windows-command.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import type { CronJobPrecheck } from "./types-shared.js";
import type { CronRunDiagnostics, CronRunOutcome } from "./types.js";

/** Fixed POSIX transport shell — never honor inherited SHELL (dangerous env). */
const TRUSTED_POSIX_SHELL = "/bin/sh";

/**
 * Resolve a trusted shell executable for unattended precheck.
 * Do not select from raw SHELL/ComSpec after authorization — poisoned Gateway
 * env must not replace the authorized transport.
 */
export function resolveTrustedPrecheckShellCommand(
  command: string,
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { shell: string; args: string[] } {
  if (platform === "win32") {
    // Fixed System32 cmd.exe (or cmd.exe off-Windows); ignore ComSpec.
    const shell = resolveTrustedWindowsCmdExe(platform);
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  return { shell: TRUSTED_POSIX_SHELL, args: ["-c", command] };
}

function resolveShellCommand(command: string): { shell: string; args: string[] } {
  return resolveTrustedPrecheckShellCommand(command);
}

/** Canonical host-exec env for precheck analysis + spawn (same as system.run). */
function resolvePrecheckExecEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  return sanitizeHostExecEnv({ baseEnv: env ?? process.env });
}

/** Stable skip / error reason codes for run logs and operators. */
export const PRECHECK_NO_WORK_REASON = "precheck-no-work";
/** onError=skip for unexpected probe failures — distinct from quiet no-work. */
export const PRECHECK_SKIPPED_ERROR_REASON = "precheck-skipped-error";
export const PRECHECK_POLICY_DENIED_REASON = "precheck-policy-denied";
const PRECHECK_ERROR_REASON = "precheck-error";
const PRECHECK_TIMEOUT_REASON = "precheck-timeout";
const PRECHECK_INVALID_REASON = "precheck-invalid";
const PRECHECK_TRIGGERS_DISABLED =
  "cron precheck is a host-shell command and is disabled; set cron.triggers.enabled=true to allow unattended precheck scripts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_CHARS = 4_000;

/** Result of evaluating a cron job precheck gate (no model involved). */
type CronJobPrecheckResult =
  | { decision: "run"; exitCode: number | null; stdout: string; stderr: string }
  | {
      decision: "skip";
      reason: typeof PRECHECK_NO_WORK_REASON | typeof PRECHECK_SKIPPED_ERROR_REASON;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }
  | {
      decision: "error";
      reason: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

function clip(text: string, max = MAX_CAPTURE_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function resolveTimeoutMs(precheck: CronJobPrecheck): number {
  const raw = precheck.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Parse a finish/line-oriented precheck protocol from command output.
 * Prefer exit codes when contract is exit-code; begin-line prefixes always win when present.
 */
export function interpretPrecheckOutput(params: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  contract?: CronJobPrecheck["contract"];
  workExitCodes?: number[];
  noWorkExitCodes?: number[];
  workStdoutPrefix?: string;
  noWorkStdoutPrefix?: string;
  onError?: CronJobPrecheck["onError"];
}): CronJobPrecheckResult {
  const stdout = params.stdout ?? "";
  const stderr = params.stderr ?? "";
  const head = stdout.trimStart();
  // Empty prefixes must never match (String#startsWith("") is always true).
  const workPrefixRaw = params.workStdoutPrefix ?? "WORK_NEEDED";
  const noWorkPrefixRaw = params.noWorkStdoutPrefix ?? "NO_WORK";
  const workPrefix = workPrefixRaw.trim().length > 0 ? workPrefixRaw : "WORK_NEEDED";
  const noWorkPrefix = noWorkPrefixRaw.trim().length > 0 ? noWorkPrefixRaw : "NO_WORK";

  if (noWorkPrefix.length > 0 && head.startsWith(noWorkPrefix)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: params.exitCode,
      stdout,
      stderr,
    };
  }
  if (workPrefix.length > 0 && head.startsWith(workPrefix)) {
    return { decision: "run", exitCode: params.exitCode, stdout, stderr };
  }

  const contract = params.contract ?? "exit-code";
  const workCodes = params.workExitCodes?.length ? params.workExitCodes : [0];
  const noWorkCodes = params.noWorkExitCodes?.length ? params.noWorkExitCodes : [2];
  const code = params.exitCode ?? 1;

  if (contract === "stdout-prefix") {
    // No recognized prefix — treat as error unless exit 0 and empty = no work.
    if (code === 0 && !stdout.trim()) {
      return {
        decision: "skip",
        reason: PRECHECK_NO_WORK_REASON,
        exitCode: code,
        stdout,
        stderr,
      };
    }
    return {
      decision: "error",
      reason: `${PRECHECK_ERROR_REASON}: stdout did not start with ${workPrefix} or ${noWorkPrefix}`,
      exitCode: code,
      stdout,
      stderr,
    };
  }

  // exit-code (default) or dual when no prefix matched
  if (noWorkCodes.includes(code)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  if (workCodes.includes(code)) {
    return { decision: "run", exitCode: code, stdout, stderr };
  }

  const onError = params.onError ?? "fail";
  if (onError === "skip") {
    return {
      decision: "skip",
      reason: PRECHECK_SKIPPED_ERROR_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  return {
    decision: "error",
    reason: `${PRECHECK_ERROR_REASON}: unexpected exit code ${code}`,
    exitCode: code,
    stdout,
    stderr,
  };
}

type ExecToolConfigLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  /** Require approval for interpreter inline-eval carriers (python -c, etc.). */
  strictInlineEval?: boolean;
  /** Global/agent tools.exec.safeBins — same surface as system.run. */
  safeBins?: string[] | null;
  safeBinProfiles?: SafeBinProfileFixtures | null;
  safeBinTrustedDirs?: string[] | null;
};

type CronJobPrecheckAuthz = {
  /** Operator must enable unattended cron scripts/triggers (same gate as script payloads). */
  triggersEnabled: boolean;
  /** Optional agent id for exec-approvals agent scope. */
  agentId?: string;
  /**
   * Caller's requested exec security contract (tools.exec.security). Host approvals
   * file may only tighten further via minSecurity inside resolve. Defaults to the
   * resolved approvals agent security when omitted.
   */
  security?: ExecSecurity;
  /**
   * Global `tools.exec` config layer (same as system.run). Applied before agent layer.
   * When set, layered policy becomes the requested security ceiling (not approvals alone).
   */
  toolsExec?: ExecToolConfigLayer;
  /**
   * Per-agent `agents.entries.<id>.tools.exec` config layer (same as system.run).
   */
  agentToolsExec?: ExecToolConfigLayer;
  /**
   * Explicit strictInlineEval override (tests). When omitted, OR of global/agent
   * tools.exec.strictInlineEval layers (same as system.run).
   */
  strictInlineEval?: boolean;
  /**
   * When true, skip live approvals resolution and use `security` (or deny) only.
   * Tests inject this to assert policy denial without host file side effects.
   */
  securityOverrideOnly?: boolean;
};

/** Normalize security strings; invalid values fail closed to deny. */
function normalizeExecSecurity(value: unknown): ExecSecurity | undefined {
  if (value === "deny" || value === "allowlist" || value === "full") {
    return value;
  }
  return undefined;
}

/**
 * Authorize a cron precheck command under the same host-shell policy surface as
 * the gateway exec tool: `cron.triggers.enabled` plus exec security
 * deny|allowlist|full (allowlist analysis via evaluateShellAllowlist*).
 * Unattended cron never prompts for approvals — effective ask that would
 * require a prompt fails closed (policy-denied).
 */
export async function authorizeCronJobPrecheckCommand(params: {
  command: string;
  cwd?: string;
  authz: CronJobPrecheckAuthz;
  env?: NodeJS.ProcessEnv;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!params.authz.triggersEnabled) {
    return { allowed: false, reason: PRECHECK_TRIGGERS_DISABLED };
  }

  const requested = normalizeExecSecurity(params.authz.security);

  if (params.authz.securityOverrideOnly) {
    const security = requested ?? "deny";
    if (security === "deny") {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
      };
    }
    if (security === "full") {
      const strictInlineEval =
        params.authz.strictInlineEval === true ||
        params.authz.toolsExec?.strictInlineEval === true ||
        params.authz.agentToolsExec?.strictInlineEval === true;
      if (strictInlineEval) {
        const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
          global: params.authz.toolsExec,
          local: params.authz.agentToolsExec,
        });
        const allowlistEval = await evaluateShellAllowlistWithAuthorization({
          command: params.command,
          allowlist: [],
          safeBins: safeBinPolicy.safeBins,
          safeBinProfiles: safeBinPolicy.safeBinProfiles,
          trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
          cwd: params.cwd,
          env: resolvePrecheckExecEnv(params.env),
          platform: process.platform,
        });
        const inlineEvalHit = detectPolicyInlineEval(allowlistEval.segments ?? []);
        if (inlineEvalHit !== null) {
          return {
            allowed: false,
            reason:
              `${PRECHECK_POLICY_DENIED_REASON}: ` +
              `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode ` +
              `(unattended cron cannot prompt)`,
          };
        }
      }
      return { allowed: true };
    }
    // allowlist without live file → evaluate command against empty allowlist
    const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
      global: params.authz.toolsExec,
      local: params.authz.agentToolsExec,
    });
    const allowlistEval = await evaluateShellAllowlistWithAuthorization({
      command: params.command,
      allowlist: [],
      safeBins: safeBinPolicy.safeBins,
      safeBinProfiles: safeBinPolicy.safeBinProfiles,
      trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
      cwd: params.cwd,
      env: resolvePrecheckExecEnv(params.env),
      platform: process.platform,
    });
    const isWindows = process.platform === "win32";
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied: allowlistEval.allowlistSatisfied,
      approvalDecision: null,
      isWindows,
      // Precheck always launches via cmd.exe /d /s /c on Windows — classify as such.
      cmdInvocation: isWindows,
      shellWrapperInvocation: isWindows,
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
      };
    }
    return { allowed: true };
  }

  // Mirror resolveEffectiveSystemRunExecPolicy / resolveExecHostApprovalContext:
  // 1) start from OpenClaw defaults (allowlist/off) or an explicit security ceiling
  // 2) layer global + per-agent tools.exec (canonical system.run path) — including ask
  // 3) resolveExecModePolicy with effective ask (not forced off)
  // 4) approvals file may only tighten via minSecurity / ask max-strictness
  // Unattended cron cannot prompt: if effective ask would require approval, deny.
  const normalizeAsk = (value: unknown): ExecAsk | undefined => {
    if (value === "off" || value === "on-miss" || value === "always") {
      return value;
    }
    return undefined;
  };
  const normalizeLayer = (
    layer: ExecToolConfigLayer | undefined,
  ): ExecToolConfigLayer | undefined => {
    if (!layer) {
      return undefined;
    }
    return {
      mode:
        layer.mode === "deny" ||
        layer.mode === "allowlist" ||
        layer.mode === "ask" ||
        layer.mode === "auto" ||
        layer.mode === "full"
          ? layer.mode
          : undefined,
      security: normalizeExecSecurity(layer.security),
      ask: normalizeAsk(layer.ask),
      ...(layer.strictInlineEval === true ? { strictInlineEval: true as const } : {}),
    };
  };
  const toolsExecLayer = normalizeLayer(params.authz.toolsExec);
  const agentToolsExecLayer = normalizeLayer(params.authz.agentToolsExec);
  const hasConfigLayers = toolsExecLayer !== undefined || agentToolsExecLayer !== undefined;
  // Canonical system.run default is allowlist when exec security is unspecified
  // (node-host/invoke.ts). Do not widen unconfigured prechecks to full.
  const basePolicy = {
    security: (requested ?? "allowlist") as ExecSecurity,
    ask: "off" as ExecAsk,
  };
  const layered = hasConfigLayers
    ? applyExecPolicyLayer(applyExecPolicyLayer(basePolicy, toolsExecLayer), agentToolsExecLayer)
    : basePolicy;
  // Explicit authz.security remains a hard ceiling when config layers are also present.
  const ceilingSecurity =
    requested !== undefined
      ? minSecurity(normalizeExecSecurity(layered.security) ?? "allowlist", requested)
      : (normalizeExecSecurity(layered.security) ?? "allowlist");
  const layeredMode: ExecMode | undefined =
    "mode" in layered &&
    (layered.mode === "deny" ||
      layered.mode === "allowlist" ||
      layered.mode === "ask" ||
      layered.mode === "auto" ||
      layered.mode === "full")
      ? layered.mode
      : undefined;
  const layeredAsk = normalizeAsk(layered.ask) ?? "off";
  const modePolicy = resolveExecModePolicy({
    mode: layeredMode,
    security: ceilingSecurity ?? "allowlist",
    ask: layeredAsk,
  });
  const approvals = await resolveExecApprovalsLocked(params.authz.agentId, {
    security: modePolicy.security,
    ask: modePolicy.ask,
  });
  const hostSecurity = minSecurity(
    modePolicy.security,
    normalizeExecSecurity(approvals.agent.security) ?? "deny",
  );
  // Ask max-strictness: always > on-miss > off (approvals file can only tighten).
  const askRank = (ask: ExecAsk): number => (ask === "always" ? 2 : ask === "on-miss" ? 1 : 0);
  const approvalsAsk = normalizeAsk(approvals.agent.ask) ?? "off";
  const effectiveAsk: ExecAsk =
    askRank(approvalsAsk) >= askRank(modePolicy.ask) ? approvalsAsk : modePolicy.ask;

  if (hostSecurity === "deny") {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
    };
  }

  const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
    global: params.authz.toolsExec,
    local: params.authz.agentToolsExec,
  });
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: safeBinPolicy.safeBins,
    safeBinProfiles: safeBinPolicy.safeBinProfiles,
    trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
    cwd: params.cwd,
    env: resolvePrecheckExecEnv(params.env),
    platform: process.platform,
  });

  const isWindows = process.platform === "win32";
  const allowlistSatisfied = hostSecurity === "allowlist" ? allowlistEval.allowlistSatisfied : true;
  // Honor tools.exec.strictInlineEval (system.run parity): unattended precheck cannot
  // prompt, so inline-eval carriers fail closed when the policy is enabled.
  const strictInlineEval =
    params.authz.strictInlineEval === true ||
    params.authz.toolsExec?.strictInlineEval === true ||
    params.authz.agentToolsExec?.strictInlineEval === true;
  if (strictInlineEval) {
    const inlineEvalHit = detectPolicyInlineEval(allowlistEval.segments ?? []);
    if (inlineEvalHit !== null) {
      return {
        allowed: false,
        reason:
          `${PRECHECK_POLICY_DENIED_REASON}: ` +
          `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode ` +
          `(unattended cron cannot prompt)`,
      };
    }
  }
  // Unattended cron has no interactive approval path. Fail closed when the
  // effective ask policy would require a prompt (tools.exec.ask or approvals).
  if (
    requiresExecApproval({
      ask: effectiveAsk,
      security: hostSecurity,
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied: false,
    })
  ) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec ask=${effectiveAsk} requires approval (unattended cron cannot prompt)`,
    };
  }

  const decision = evaluateSystemRunPolicy({
    security: hostSecurity,
    ask: effectiveAsk,
    analysisOk: allowlistEval.analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied: false,
    approvalDecision: null,
    isWindows,
    // Precheck always launches via cmd.exe /d /s /c on Windows — classify as such.
    cmdInvocation: isWindows,
    shellWrapperInvocation: isWindows,
  });

  if (!decision.allowed) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
    };
  }
  return { allowed: true };
}

/** Run the precheck shell command and map protocol → run | skip | error. */
export async function runCronJobPrecheck(
  precheck: CronJobPrecheck,
  opts?: {
    abortSignal?: AbortSignal;
    spawnImpl?: typeof spawn;
    /** Required for host execution: triggers + exec security policy. */
    authz?: CronJobPrecheckAuthz;
  },
): Promise<CronJobPrecheckResult> {
  const command = normalizeOptionalString(precheck.command) ?? "";
  if (!command) {
    return {
      decision: "error",
      reason: `${PRECHECK_INVALID_REASON}: empty command`,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }

  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  const cwd = normalizeOptionalString(precheck.cwd) || undefined;

  // Fail closed: without authz (or explicitly allow via tests spawn only),
  // production timer path always passes authz. Direct API callers must pass it.
  const authz: CronJobPrecheckAuthz = opts?.authz ?? {
    triggersEnabled: false,
    security: "deny",
    securityOverrideOnly: true,
  };
  const auth = await authorizeCronJobPrecheckCommand({
    command,
    cwd,
    authz,
  });
  if (!auth.allowed) {
    return {
      decision: "error",
      reason: auth.reason,
      exitCode: null,
      stdout: "",
      stderr: auth.reason,
    };
  }

  // Recheck cancellation after awaited authorization — cancel during authz must
  // not still spawn a host shell (ClawSweeper P1).
  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  const timeoutMs = resolveTimeoutMs(precheck);
  const spawnFn = opts?.spawnImpl ?? spawn;
  const { shell, args: shellArgs } = resolveShellCommand(command);

  return await new Promise<CronJobPrecheckResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Detached process group on POSIX so timeout/abort can terminate the full tree
    // (shell + background descendants), matching system-run lifecycle.
    const child = spawnFn(shell, shellArgs, {
      cwd,
      env: resolvePrecheckExecEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const terminateChildTree = () => {
      const pid = child.pid;
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        try {
          killProcessTree(pid, {
            force: true,
            detached: process.platform !== "win32",
          });
        } catch {
          // fall through to direct kill
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

    const finish = (result: CronJobPrecheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts?.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree();
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    }, timeoutMs);

    const onAbort = () => {
      terminateChildTree();
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || "aborted"),
      });
    };
    opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS * 2) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS * 2) {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      finish({
        decision: "error",
        reason: `${PRECHECK_ERROR_REASON}: ${err.message}`,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || err.message),
      });
    });

    child.on("close", (code) => {
      if (timedOut || settled) {
        return;
      }
      const result = interpretPrecheckOutput({
        exitCode: code,
        stdout: clip(stdout),
        stderr: clip(stderr),
        contract: precheck.contract,
        workExitCodes: precheck.workExitCodes,
        noWorkExitCodes: precheck.noWorkExitCodes,
        workStdoutPrefix: precheck.workStdoutPrefix,
        noWorkStdoutPrefix: precheck.noWorkStdoutPrefix,
        onError: precheck.onError,
      });
      finish(result);
    });
  });
}

/** Map a precheck result into a CronRunOutcome (+ diagnostics) for the timer path. */
export function cronRunOutcomeFromPrecheck(
  result: CronJobPrecheckResult,
  nowMs: () => number = () => Date.now(),
): CronRunOutcome {
  if (result.decision === "run") {
    return { status: "ok" };
  }
  if (result.decision === "skip") {
    const ts = nowMs();
    const diagnostics: CronRunDiagnostics = {
      summary: result.reason,
      entries: [
        {
          ts,
          source: "cron-preflight",
          severity: "info",
          message: result.reason,
          exitCode: result.exitCode,
        },
        ...(result.stdout.trim()
          ? [
              {
                ts,
                source: "exec" as const,
                severity: "info" as const,
                message: clip(result.stdout, 500),
              },
            ]
          : []),
      ],
    };
    return {
      status: "skipped",
      error: result.reason,
      summary: result.reason,
      diagnostics,
    };
  }
  return {
    status: "error",
    error: result.reason,
    diagnostics: createCronRunDiagnosticsFromError("cron-preflight", result.reason, {
      severity: "error",
      nowMs,
      exitCode: result.exitCode,
    }),
  };
}

/** Lightweight structural validation / normalization of a precheck object. */
export function normalizeCronJobPrecheck(value: unknown): CronJobPrecheck | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const command = normalizeOptionalString(rec.command);
  if (!command) {
    return undefined;
  }
  const kind = rec.kind === "exec" || rec.kind === undefined ? ("exec" as const) : undefined;
  if (!kind) {
    return undefined;
  }
  const timeoutMs =
    typeof rec.timeoutMs === "number" && Number.isFinite(rec.timeoutMs) && rec.timeoutMs > 0
      ? Math.min(Math.floor(rec.timeoutMs), MAX_TIMEOUT_MS)
      : undefined;
  const contract =
    rec.contract === "exit-code" || rec.contract === "stdout-prefix" || rec.contract === "dual"
      ? rec.contract
      : undefined;
  const onError = rec.onError === "fail" || rec.onError === "skip" ? rec.onError : undefined;
  const toIntList = (v: unknown): number[] | undefined => {
    if (!Array.isArray(v)) {
      return undefined;
    }
    const nums = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return nums.length ? nums.map((n) => Math.trunc(n)) : undefined;
  };
  const workExitCodes = toIntList(rec.workExitCodes);
  const noWorkExitCodes = toIntList(rec.noWorkExitCodes);
  const cwd = normalizeOptionalString(rec.cwd);
  const workStdoutPrefix = normalizeOptionalString(rec.workStdoutPrefix);
  const noWorkStdoutPrefix = normalizeOptionalString(rec.noWorkStdoutPrefix);
  if (workStdoutPrefix !== undefined && workStdoutPrefix.trim().length === 0) {
    throw new Error("precheck.workStdoutPrefix must be non-empty when set");
  }
  if (noWorkStdoutPrefix !== undefined && noWorkStdoutPrefix.trim().length === 0) {
    throw new Error("precheck.noWorkStdoutPrefix must be non-empty when set");
  }
  return {
    kind: "exec",
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(contract ? { contract } : {}),
    ...(onError ? { onError } : {}),
    ...(workExitCodes ? { workExitCodes } : {}),
    ...(noWorkExitCodes ? { noWorkExitCodes } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workStdoutPrefix ? { workStdoutPrefix } : {}),
    ...(noWorkStdoutPrefix ? { noWorkStdoutPrefix } : {}),
  };
}
