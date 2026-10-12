import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function home(config?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "monchu-config-"));
  directories.push(directory);
  if (config !== undefined) await writeFile(join(directory, "config.json"), JSON.stringify(config));
  return directory;
}

describe("config", () => {
  it("defaults every role when the file is missing", async () => {
    expect(await loadConfig(await home())).toEqual({
      front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
      worker: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
      classifier: { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef-flash" },
      cloudflareAccountId: undefined,
      settings: {},
      claude: { executable: undefined, plan: "pro", longContextExtraUsage: false },
    });
  });

  it("reads roles, turns the classifier off with null, and keeps the account override", async () => {
    const config = await loadConfig(
      await home({
        worker: { provider: "openai", modelId: "gpt-6-sol" },
        classifier: null,
        cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      }),
    );
    expect(config.worker).toEqual({
      provider: "openai",
      modelId: "gpt-6-sol",
      thinkingLevel: "high",
    });
    expect(config.classifier).toBeNull();
    expect(config.cloudflareAccountId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("validates the run-settings subset without loading a Pi settings file", async () => {
    const settings = {
      theme: "light/dark",
      httpIdleTimeoutMs: 0,
      shellPath: "bash",
      shellCommandPrefix: "echo prefix;",
      defaultTools: ["read", "bash"],
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
      retry: {
        enabled: false,
        maxRetries: 2,
        baseDelayMs: 10,
        maxAgentDelayMs: 100,
        provider: { timeoutMs: 500, maxRetries: 1, maxRetryDelayMs: 1000 },
      },
      terminal: { images: false, hyperlinks: "auto", trueColor: true },
    };
    expect((await loadConfig(await home({ settings }))).settings).toEqual(settings);
  });

  it.each([
    [{ bogus: 1 }, "unknown fields: bogus"],
    [{ front: { provider: "p", modelId: "m", thinkingLevel: "huge" } }, "front.thinkingLevel"],
    [{ cloudflareAccountId: "nope" }, "cloudflareAccountId"],
    [{ classifier: "clef" }, "classifier must be an object"],
    [{ settings: { retry: { enabled: "yes" } } }, "settings.retry.enabled"],
    [{ settings: { retry: { provider: { timeoutMs: 0 } } } }, "settings.retry.provider.timeoutMs"],
    [{ settings: { compaction: { reserveTokens: -1 } } }, "settings.compaction.reserveTokens"],
    [{ settings: { httpIdleTimeoutMs: 0.5 } }, "settings.httpIdleTimeoutMs"],
    [{ settings: { defaultTools: ["bash", "-edit"] } }, "must not mix"],
    [{ settings: { defaultTools: ["bad"] } }, "unknown built-in"],
    [{ settings: { defaultTools: "read" } }, "string array"],
    [{ front: { provider: "p", modelId: "m", thinkingLevel: null } }, "front.thinkingLevel"],
    [{ settings: { theme: "missing" } }, "settings.theme"],
    [{ settings: { retry: { typo: 1 } } }, "unknown fields: typo"],
    [{ settings: { terminal: { images: true } } }, "settings.terminal.images"],
    [{ front: { provider: "p", modelId: "m", key: "secret" } }, "unknown fields: key"],
  ])("rejects %j", async (config, message) => {
    await expect(loadConfig(await home(config))).rejects.toThrow(message);
  });
});
