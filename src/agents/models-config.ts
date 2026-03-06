import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { applyConfigEnvVars } from "../config/env-vars.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

/**
 * Check if a string looks like an environment variable name rather than a
 * resolved secret value. Env var names are UPPER_SNAKE_CASE. Resolved secrets
 * are typically longer and contain mixed-case alphanumeric characters, dashes,
 * underscores in non-UPPER_SNAKE_CASE patterns.
 *
 * Special cases:
 * - "ollama-local" and similar synthetic markers are preserved
 * - "aws-sdk" auth mode markers are preserved
 */
function isEnvVarNameOrMarker(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // Synthetic local provider markers (e.g., "ollama-local")
  if (trimmed === "ollama-local") {
    return true;
  }

  // AWS SDK auth marker
  if (trimmed === "aws-sdk") {
    return true;
  }

  // Environment variable name pattern: UPPER_SNAKE_CASE
  // Must start with letter, contain only uppercase letters, digits, underscores
  // Examples: OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID
  return /^[A-Z][A-Z0-9_]*$/.test(trimmed);
}

/**
 * Redact resolved secret values from provider configs before writing to disk.
 * Preserves env var names (UPPER_SNAKE_CASE) and special markers, but strips
 * actual resolved API keys to prevent plaintext secrets in models.json.
 */
function redactResolvedSecrets(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const redacted: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const { apiKey, ...rest } = provider;

    // If apiKey is undefined or empty, or looks like an env var name/marker, preserve it
    if (
      apiKey === undefined ||
      apiKey === "" ||
      (typeof apiKey === "string" && isEnvVarNameOrMarker(apiKey))
    ) {
      redacted[key] = provider;
    } else {
      // apiKey looks like a resolved secret - strip it
      redacted[key] = rest as ProviderConfig;
    }
  }

  return redacted;
}

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function resolvePreferredTokenLimit(explicitValue: number, implicitValue: number): number {
  // Keep catalog refresh behavior for stale low values while preserving
  // intentional larger user overrides (for example Ollama >128k contexts).
  return explicitValue > implicitValue ? explicitValue : implicitValue;
}

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const implicitById = new Map(
    implicitModels.map((model) => [getId(model), model] as const).filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return explicitModel;
    }

    // Refresh capability metadata from the implicit catalog while preserving
    // user-specific fields (cost, headers, compat, etc.) on explicit entries.
    // reasoning is treated as user-overridable: if the user has explicitly set
    // it in their config (key present), honour that value; otherwise fall back
    // to the built-in catalog default so new reasoning models work out of the
    // box without requiring every user to configure it.
    return {
      ...explicitModel,
      input: implicitModel.input,
      reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      contextWindow: resolvePreferredTokenLimit(
        explicitModel.contextWindow,
        implicitModel.contextWindow,
      ),
      maxTokens: resolvePreferredTokenLimit(explicitModel.maxTokens, implicitModel.maxTokens),
    };
  });

  for (const implicitModel of implicitModels) {
    const id = getId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
  }
  return out;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function resolveProvidersForModelsJson(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({ agentDir, explicitProviders });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });

  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }

  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }
  return providers;
}

function mergeWithExistingProviderSecrets(params: {
  nextProviders: Record<string, ProviderConfig>;
  existingProviders: Record<string, NonNullable<ModelsConfig["providers"]>[string]>;
}): Record<string, ProviderConfig> {
  const { nextProviders, existingProviders } = params;
  const mergedProviders: Record<string, ProviderConfig> = {};
  for (const [key, entry] of Object.entries(existingProviders)) {
    mergedProviders[key] = entry;
  }
  for (const [key, newEntry] of Object.entries(nextProviders)) {
    const existing = existingProviders[key] as
      | (NonNullable<ModelsConfig["providers"]>[string] & {
          apiKey?: string;
          baseUrl?: string;
        })
      | undefined;
    if (!existing) {
      mergedProviders[key] = newEntry;
      continue;
    }
    const preserved: Record<string, unknown> = {};
    if (typeof existing.apiKey === "string" && existing.apiKey) {
      preserved.apiKey = existing.apiKey;
    }
    if (typeof existing.baseUrl === "string" && existing.baseUrl) {
      preserved.baseUrl = existing.baseUrl;
    }
    mergedProviders[key] = { ...newEntry, ...preserved };
  }
  return mergedProviders;
}

async function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  targetPath: string;
  providers: Record<string, ProviderConfig>;
}): Promise<Record<string, ProviderConfig>> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = await readJson(params.targetPath);
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders,
  });
}

async function readRawFile(pathname: string): Promise<string> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch {
    return "";
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
  // available in process.env before implicit provider discovery.  Some
  // callers (agent runner, tools) pass config objects that haven't gone
  // through the full loadConfig() pipeline which applies these.
  applyConfigEnvVars(cfg);

  const providers = await resolveProvidersForModelsJson({ cfg, agentDir });

  if (Object.keys(providers).length === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");
  const mergedProviders = await resolveProvidersForMode({
    mode,
    targetPath,
    providers,
  });

  const normalizedProviders = normalizeProviders({
    providers: mergedProviders,
    agentDir,
  });

  // Redact resolved secrets before writing to disk. This ensures that
  // regardless of how secrets were resolved (env vars, SecretRef providers,
  // etc.), only env var names are persisted, not plaintext API keys.
  // See: https://github.com/OpenClaw/openclaw/issues/37512
  const safeProviders = redactResolvedSecrets(normalizedProviders);
  const next = `${JSON.stringify({ providers: safeProviders }, null, 2)}\n`;
  const existingRaw = await readRawFile(targetPath);

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}
