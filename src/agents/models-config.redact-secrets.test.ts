import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOpenClawModelsJson } from "./models-config.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("./models-config.providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveImplicitProviders: vi.fn(async () => ({})),
    resolveImplicitBedrockProvider: vi.fn(async () => null),
    resolveImplicitCopilotProvider: vi.fn(async () => null),
  };
});

describe("models-config secret redaction", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join("/tmp", "openclaw-redact-test-"));
  });

  afterEach(async () => {
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("preserves env var names in apiKey fields", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            apiKey: "OPENAI_API_KEY",
            models: [{ id: "gpt-4" }],
          },
          anthropic: {
            apiKey: "ANTHROPIC_API_KEY",
            models: [{ id: "claude-3" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const modelsJson = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(modelsJson);

    expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY");
    expect(parsed.providers.anthropic?.apiKey).toBe("ANTHROPIC_API_KEY");
  });

  it("strips resolved secret values that look like API keys", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            // Looks like a resolved OpenAI key
            apiKey: "sk-1234567890abcdefghijklmnop",
            models: [{ id: "gpt-4" }],
          },
          anthropic: {
            // Looks like a resolved Anthropic key
            apiKey: "sk-ant-1234567890abcdefghijklmnop",
            models: [{ id: "claude-3" }],
          },
          xai: {
            // Looks like a resolved xAI key
            apiKey: "xai-1234567890abcdefghijklmnop",
            models: [{ id: "grok-2" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const modelsJson = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(modelsJson);

    // Resolved secrets should be stripped
    expect(parsed.providers.openai?.apiKey).toBeUndefined();
    expect(parsed.providers.anthropic?.apiKey).toBeUndefined();
    expect(parsed.providers.xai?.apiKey).toBeUndefined();

    // But the rest of the provider config should be preserved
    expect(parsed.providers.openai?.models).toEqual([{ id: "gpt-4" }]);
    expect(parsed.providers.anthropic?.models).toEqual([{ id: "claude-3" }]);
    expect(parsed.providers.xai?.models).toEqual([{ id: "grok-2" }]);
  });

  it("preserves special marker values like ollama-local", async () => {
    const config = {
      models: {
        providers: {
          ollama: {
            apiKey: "ollama-local",
            baseUrl: "http://localhost:11434",
            models: [{ id: "llama3" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const modelsJson = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(modelsJson);

    expect(parsed.providers.ollama?.apiKey).toBe("ollama-local");
  });

  it("strips mixed-case resolved secrets", async () => {
    const config = {
      models: {
        providers: {
          custom: {
            // Mixed case = resolved secret, not env var name
            apiKey: "Bearer_Token_12345",
            models: [{ id: "custom-model" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const modelsJson = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(modelsJson);

    expect(parsed.providers.custom?.apiKey).toBeUndefined();
    expect(parsed.providers.custom?.models).toEqual([{ id: "custom-model" }]);
  });

  it("handles providers with aws-sdk auth (apiKey set to env var name)", async () => {
    const config = {
      models: {
        providers: {
          "amazon-bedrock": {
            auth: "aws-sdk",
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            models: [{ id: "anthropic.claude-v2" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const modelsJson = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(modelsJson);

    expect(parsed.providers["amazon-bedrock"]?.auth).toBe("aws-sdk");
    // AWS SDK auth uses AWS_PROFILE env var name - this should be preserved
    expect(parsed.providers["amazon-bedrock"]?.apiKey).toBe("AWS_PROFILE");
  });

  it("sets restrictive file permissions on models.json", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            apiKey: "OPENAI_API_KEY",
            models: [{ id: "gpt-4" }],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(config, agentDir);

    const stats = await fs.stat(path.join(agentDir, "models.json"));
    // 0o600 = owner read/write only
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
