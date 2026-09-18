// Cron status/list/add command registration and create-payload normalization.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { CronJob } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { CronCliError } from "./cron-cli-error.js";
import { listCronJobsFromGateway } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import { registerCronMutationOptions } from "./register.cron-options.js";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  handleCronCliError,
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronIntegerOption,
  parseCronNoOutputTimeoutOption,
  parseCronStringList,
  printCronJson,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";
import { normalizeCronSessionTargetOption, parseCronThreadIdOption } from "./thread-id-shared.js";
import { readCronPayloadScript, readCronTriggerScript } from "./trigger-options.js";

export function registerCronStatusCommand(cron: Command) {
  addGatewayClientOptions(
    createCronOutputCommand(cron, "status")
      .description("Show automations scheduler status")
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronListCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("list")
      .description("List automations")
      .option("--all", "Include disabled jobs", false)
      .option("--agent <id>", "Filter by agent id")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const listParams: { includeDisabled: boolean; agentId?: string } = {
            includeDisabled: Boolean(opts.all),
          };
          const agentId = normalizeOptionalString(opts.agent);
          if (typeof opts.agent === "string" && !agentId) {
            throw new CronCliError("--agent must not be blank");
          }
          if (agentId) {
            listParams.agentId = sanitizeAgentId(agentId);
          }
          const res = await listCronJobsFromGateway(opts, listParams);
          if (opts.json) {
            printCronJson(enrichCronJsonWithStatus(res));
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          const deliveryPreviews = coerceCronDeliveryPreviews(res);
          printCronList(jobs, defaultRuntime, { deliveryPreviews });
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronAddCommand(cron: Command) {
  addGatewayClientOptions(
    registerCronMutationOptions(
      createCronOutputCommand(cron, "add")
        .description("Add an automation")
        .argument("[scheduleOrName]", "Schedule string, or job name when using --at/--every/--cron")
        .argument("[message]", "Agent message when using a positional schedule"),
      "add",
    )
      .option("--declaration-key <key>", "Idempotent declaration identity key")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated|current|session:<id>)")
      .option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option(
        "--at <when>",
        "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes",
      )
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--pacing-min <duration>", "Minimum delay accepted from a dynamic next check")
      .option("--pacing-max <duration>", "Maximum delay accepted from a dynamic next check")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option(
        "--on-exit <shell>",
        "Fire once when this watched command exits (event trigger; survives turn teardown)",
      )
      .option("--on-exit-cwd <path>", "Working directory for the --on-exit watched command")
      .option("--stream-command <json>", "Stream source argv as a JSON array of strings")
      .option("--stream-cwd <path>", "Working directory for the stream source")
      .option("--stream-mode <mode>", "Stream line selection mode (line|match)")
      .option("--stream-match <regex>", "Regex source required for stream match mode")
      .option("--stream-batch-ms <n>", "Quiet-window batch delay in milliseconds")
      .option("--stream-max-batch-bytes <n>", "Maximum UTF-8 bytes per stream batch")
      .option(
        "--tz <iana>",
        "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)",
        "",
      )
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--trigger-script <path|->", "Condition script file, or - for stdin")
      .option("--trigger-once", "Disable after the first successful triggered run", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--script <file|->", "Headless script payload file, or - for stdin")
      .option("--script-timeout-seconds <n>", "Script wall-clock timeout seconds")
      .option("--script-tool-budget <n>", "Maximum script tool calls")
      .option("--command <shell>", "Command payload run as sh -lc <shell> on the Gateway")
      .option("--command-argv <json>", "Command payload argv as JSON array of strings")
      .option("--command-cwd <path>", "Working directory for command payloads")
      .option(
        "--command-env <KEY=VALUE>",
        "Environment override for command payloads (repeatable)",
        (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
      )
      .option("--command-input <text>", "stdin for command payloads")
      .option("--thinking <level>", `Thinking level for agent jobs (${THINKING_LEVELS_HELP})`)
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--fallbacks <list>", "Fallback model list for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent or command jobs")
      .option("--no-output-timeout-seconds <n>", "No-output timeout seconds for command jobs")
      .option("--output-max-bytes <n>", "Maximum captured stdout/stderr bytes for command jobs")
      .option("--light-context", "Use lightweight bootstrap context for agent jobs", false)
      .option(
        "--precheck-command <shell>",
        "Zero-token shell gate before the payload (exit 0=work, 2=skip; see #112371)",
      )
      .option(
        "--precheck-timeout-ms <n>",
        "Timeout for --precheck-command in milliseconds (default 30000)",
      )
      .option("--precheck-cwd <path>", "Working directory for --precheck-command")
      .option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)")
      .option("--announce", "Fallback-deliver final text to a chat", false)
      .option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.")
      .option("--no-deliver", "Disable runner fallback delivery")
      .option("--webhook <url>", "POST the finished payload to a webhook URL")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--thread-id <id>", "Telegram forum topic thread id")
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)      .action(
        async (
          nameArg: string | undefined,
          messageArg: string | undefined,
          opts: GatewayRpcOpts & Record<string, unknown>,
          cmd: Command,
        ) => {
          try {
            const hasScheduleFlag =
              typeof opts.at === "string" ||
              typeof opts.cron === "string" ||
              typeof opts.every === "string" ||
              typeof opts.onExit === "string" ||
              typeof opts.streamCommand === "string";
            const positionalSchedule = hasScheduleFlag ? undefined : nameArg;
            const schedule = resolveCronCreateScheduleFromArgs({ ...opts, positionalSchedule });

            const wakeMode = normalizeOptionalString(opts.wake) ?? "now";
            if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
              throw new CronCliError("--wake must be now or next-heartbeat");
            }

            const rawAgentId = normalizeOptionalString(opts.agent);
            const agentId = rawAgentId ? sanitizeAgentId(rawAgentId) : undefined;

            const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
            const hasNoDeliver = opts.deliver === false;
            const webhookUrl =
              typeof opts.webhook === "string" ? normalizeHttpWebhookUrl(opts.webhook) : null;
            if (typeof opts.webhook === "string" && !webhookUrl) {
              throw new CronCliError("--webhook must be a valid http(s) URL");
            }
            const hasWebhook = Boolean(webhookUrl);
            const deliveryFlagCount = [hasAnnounce, hasNoDeliver, hasWebhook].filter(
              Boolean,
            ).length;
            if (deliveryFlagCount > 1) {
              throw new CronCliError(
                "Choose at most one of --announce, --no-deliver, or --webhook",
              );
            }

            const resolvedPayload = await (async () => {
              // Main-session jobs use system events; isolated/current/session jobs use messages.
              const systemEvent = normalizeOptionalString(opts.systemEvent) ?? "";
              const optionMessage = normalizeOptionalString(opts.message);
              const positionalMessage = normalizeOptionalString(messageArg);
              const commandShell = normalizeOptionalString(opts.command);
              const commandArgv = parseCronCommandArgv(opts.commandArgv);
              // File arguments identify exact local paths; trimming can select another file.
              const scriptPath = readNonBlankString(opts.script);
              if (typeof opts.script === "string" && !scriptPath) {
                throw new CronCliError("--script must not be blank");
              }
              const toolsAllow = parseCronStringList(opts.tools);
              if (optionMessage && positionalMessage && optionMessage !== positionalMessage) {
                throw new CronCliError(
                  "Pass the automation message either positionally or with --message, not both.",
                );
              }
              const message = optionMessage ?? positionalMessage ?? "";
              if (commandShell && commandArgv) {
                throw new CronCliError(
                  "Pass command payload either with --command or --command-argv, not both.",
                );
              }
              const chosen = [
                Boolean(systemEvent),
                Boolean(message),
                Boolean(commandShell) || Boolean(commandArgv),
                Boolean(scriptPath),
              ].filter(Boolean).length;
              if (chosen !== 1) {
                throw new CronCliError(
                  "Choose exactly one payload: --system-event, --message, --command, or --script",
                );
              }
              if (systemEvent) {
                return {
                  kind: "systemEvent" as const,
                  text: systemEvent,
                  ...(toolsAllow ? { toolsAllow } : {}),
                };
              }
              if (scriptPath) {
                if (opts.timeoutSeconds !== undefined) {
                  throw new CronCliError(
                    "Use --script-timeout-seconds for script jobs, not --timeout-seconds.",
                  );
                }
                const scriptTimeoutSeconds = parseCronIntegerOption(
                  opts.scriptTimeoutSeconds,
                  "--script-timeout-seconds",
                );
                const scriptToolBudget = parseCronIntegerOption(
                  opts.scriptToolBudget,
                  "--script-tool-budget",
                );
                return {
                  kind: "script" as const,
                  timeoutSeconds: scriptTimeoutSeconds,
                  toolBudget: scriptToolBudget,
                  toolsAllow,
                  script: await readCronPayloadScript(scriptPath),
                };
              }
              const timeoutSeconds = parseCronIntegerOption(
                opts.timeoutSeconds,
                "--timeout-seconds",
                "non-negative",
              );
              if (commandShell || commandArgv) {
                const noOutputTimeoutSeconds = parseCronNoOutputTimeoutOption(opts);
                const outputMaxBytes = parseCronIntegerOption(
                  opts.outputMaxBytes,
                  "--output-max-bytes",
                );
                return {
                  kind: "command" as const,
                  argv: commandArgv ?? ["sh", "-lc", commandShell ?? ""],
                  cwd: normalizeOptionalString(opts.commandCwd),
                  env: parseCronCommandEnv(opts.commandEnv),
                  input: typeof opts.commandInput === "string" ? opts.commandInput : undefined,
                  timeoutSeconds,
                  noOutputTimeoutSeconds,
                  outputMaxBytes,
                  ...(toolsAllow ? { toolsAllow } : {}),
                };
              }
              return {
                kind: "agentTurn" as const,
                message,
                model: normalizeOptionalString(opts.model),
                fallbacks: parseCronStringList(opts.fallbacks),
                thinking: normalizeOptionalString(opts.thinking),
                timeoutSeconds,
                lightContext: opts.lightContext === true ? true : undefined,
                toolsAllow,
              };
            })();

            const sessionSource = cmd.getOptionValueSource("session");
            const sessionTargetRaw = normalizeOptionalString(opts.session) ?? "";
            const inferredSessionTarget =
              resolvedPayload.kind === "agentTurn" ||
              resolvedPayload.kind === "command" ||
              resolvedPayload.kind === "script"
                ? "isolated"
                : "main";
            const sessionTarget =
              sessionSource === "cli"
                ? normalizeCronSessionTargetOption(sessionTargetRaw) || ""
                : inferredSessionTarget;
            const isCustomSessionTarget =
              normalizeLowercaseStringOrEmpty(sessionTarget).startsWith("session:") &&
              Boolean(normalizeOptionalString(sessionTarget.slice(8)));
            const isIsolatedLikeSessionTarget =
              sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
            if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) {
              throw new CronCliError("--session must be main, isolated, current, or session:<id>");
            }

            if (opts.deleteAfterRun && opts.keepAfterRun) {
              throw new CronCliError("Choose --delete-after-run or --keep-after-run, not both");
            }

            if (
              sessionTarget === "main" &&
              resolvedPayload.kind !== "systemEvent" &&
              resolvedPayload.kind !== "script"
            ) {
              throw new CronCliError("Main jobs require --system-event or --script.");
            }
            if (
              resolvedPayload.kind === "script" &&
              sessionTarget !== "main" &&
              sessionTarget !== "isolated"
            ) {
              throw new CronCliError("Script jobs require --session main or --session isolated.");
            }
            if (
              isIsolatedLikeSessionTarget &&
              resolvedPayload.kind !== "agentTurn" &&
              resolvedPayload.kind !== "command" &&
              resolvedPayload.kind !== "script"
            ) {
              throw new CronCliError("Isolated jobs require --message, --command, or --script.");
            }
            if (
              (opts.announce || typeof opts.deliver === "boolean") &&
              (!isIsolatedLikeSessionTarget ||
                (resolvedPayload.kind !== "agentTurn" &&
                  resolvedPayload.kind !== "command" &&
                  resolvedPayload.kind !== "script"))
            ) {
              throw new CronCliError(
                "--announce/--no-deliver require a non-main agentTurn, command, or script session target.",
              );
            }

            const accountId = normalizeOptionalString(opts.account);
            const threadId = parseCronThreadIdOption(opts.threadId);
            const hasThreadId = typeof threadId === "number";
            const hasChatDeliveryTarget =
              cmd.getOptionValueSource("channel") === "cli" ||
              typeof opts.to === "string" ||
              Boolean(accountId) ||
              hasThreadId;

            if (
              hasChatDeliveryTarget &&
              (!isIsolatedLikeSessionTarget ||
                (resolvedPayload.kind !== "agentTurn" &&
                  resolvedPayload.kind !== "command" &&
                  resolvedPayload.kind !== "script"))
            ) {
              throw new CronCliError(
                "--channel, --to, --account, and --thread-id require a non-main agentTurn, command, or script job with delivery.",
              );
            }
            if (hasWebhook && hasChatDeliveryTarget) {
              throw new CronCliError("--webhook cannot be combined with chat delivery options.");
            }

            const deliveryMode = hasWebhook
              ? "webhook"
              : isIsolatedLikeSessionTarget &&
                  (resolvedPayload.kind === "agentTurn" ||
                    resolvedPayload.kind === "command" ||
                    resolvedPayload.kind === "script")
                ? hasAnnounce
                  ? "announce"
                  : hasNoDeliver
                    ? "none"
                    : "announce"
                : undefined;

            const optionName = normalizeOptionalString(opts.name);
            const positionalName = hasScheduleFlag ? normalizeOptionalString(nameArg) : undefined;
            if (optionName && positionalName && optionName !== positionalName) {
              throw new CronCliError(
                "Pass the automation name either positionally or with --name, not both.",
              );
            }
            const name = optionName ?? positionalName ?? "";
            if (!name) {
              throw new CronCliError("Cron job name is required. Pass a name or --name <name>.");
            }

            const description = normalizeOptionalString(opts.description);
            const declarationKey = normalizeOptionalString(opts.declarationKey);
            if (typeof opts.declarationKey === "string" && !declarationKey) {
              throw new CronCliError("--declaration-key must not be blank");
            }
            const displayName = normalizeOptionalString(opts.displayName);
            if (typeof opts.displayName === "string" && !displayName) {
              throw new CronCliError("--display-name must not be blank");
            }
            const pacingMin = normalizeOptionalString(opts.pacingMin);
            const pacingMax = normalizeOptionalString(opts.pacingMax);
            if (typeof opts.pacingMin === "string" && !pacingMin) {
              throw new CronCliError("--pacing-min must not be blank");
            }
            if (typeof opts.pacingMax === "string" && !pacingMax) {
              throw new CronCliError("--pacing-max must not be blank");
            }

            const sessionKey = normalizeOptionalString(opts.sessionKey);
            const triggerScriptPath = readNonBlankString(opts.triggerScript);
            if ((opts.triggerOnce || opts.triggerScript !== undefined) && !triggerScriptPath) {
              throw new CronCliError(
                `--trigger-${opts.triggerOnce ? "once requires --trigger-script" : "script must not be blank"}`,
              );
            }
            const trigger = triggerScriptPath && {
              script: await readCronTriggerScript(triggerScriptPath),
              ...(opts.triggerOnce ? { once: true } : {}),
            };

            if (
              (resolvedPayload.kind === "agentTurn" || resolvedPayload.kind === "script") &&
              !agentId
            ) {
              defaultRuntime.error(
                theme.warn(
                  "No --agent specified; the job will run with the configured default agent. " +
                    "Specify --agent to choose a specific agent, or set agents.defaults.systemAgent.agentId.",
                ),
              );
            }

            const params = {
              name,
              declarationKey,
              displayName,
              description,
              ...(declarationKey && cmd.getOptionValueSource("disabled") !== "cli"
                ? {}
                : { enabled: !opts.disabled }),
              deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
              agentId,
              sessionKey,
              schedule,
              ...(pacingMin || pacingMax
                ? {
                    pacing: {
                      ...(pacingMin ? { min: pacingMin } : {}),
                      ...(pacingMax ? { max: pacingMax } : {}),
                    },
                  }
                : {}),
              trigger,
              sessionTarget,
              wakeMode,
              payload: resolvedPayload,
              ...(() => {
                const precheckCommand = normalizeOptionalString(opts.precheckCommand);
                if (!precheckCommand) {
                  return {};
                }
                const timeoutMs = parseStrictPositiveInteger(opts.precheckTimeoutMs);
                if (opts.precheckTimeoutMs !== undefined && timeoutMs === undefined) {
                  throw new Error("Invalid --precheck-timeout-ms (must be a positive integer).");
                }
                return {
                  precheck: {
                    kind: "exec" as const,
                    command: precheckCommand,
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                    ...(normalizeOptionalString(opts.precheckCwd)
                      ? { cwd: normalizeOptionalString(opts.precheckCwd) }
                      : {}),
                  },
                };
              })(),
              delivery: deliveryMode
                ? {
                    mode: deliveryMode,
                    channel: hasWebhook ? undefined : normalizeOptionalString(opts.channel),
                    to: hasWebhook ? webhookUrl : normalizeOptionalString(opts.to),
                    threadId: hasWebhook ? undefined : threadId,
                    accountId: hasWebhook ? undefined : accountId,
                    bestEffort: opts.bestEffortDeliver ? true : undefined,
                  }
                : undefined,
            };

            const res = await callGatewayFromCli("cron.add", opts, params);
            printCronJson(res);
            await warnIfCronSchedulerDisabled(opts);
          } catch (err) {
            handleCronCliError(err);
          }
        },
      ),
  );
}
