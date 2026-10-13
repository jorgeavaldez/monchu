import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveSettings } from "../src/config.ts";
import { harnessSettings } from "../src/context.ts";
import { setup, cleanup } from "./support.ts";

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
  it("resolves defaults and explicit zero/false overrides into independent snapshots", async () => {
    await setup();
    try {
      const current = { settings: resolveSettings({}), defaults: () => [] };
      const policy = harnessSettings(current);
      expect(policy.stream).toEqual({ timeoutMs: 300000, maxRetryDelayMs: 60000 });
      expect(policy.retry).toEqual({
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        maxAgentDelayMs: 60000,
      });
      expect(policy.compaction).toEqual({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      });
      expect(policy.steeringMode).toBe("one-at-a-time");
      expect(policy.followUpMode).toBe("one-at-a-time");
      expect(current.settings.terminalCapabilities).toEqual({});
      const previous = current.settings;
      current.settings = resolveSettings({
        httpIdleTimeoutMs: 0,
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
        terminal: { images: false, trueColor: false, hyperlinks: "auto" },
      });
      expect(policy.stream?.timeoutMs).toBe(2147483647);
      expect(policy.retry).toEqual({
        enabled: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxAgentDelayMs: 0,
      });
      expect(current.settings.terminalCapabilities).toEqual({ images: null, trueColor: false });
      expect(previous.retry.enabled).toBe(true);
      current.settings = resolveSettings({
        retry: { provider: { timeoutMs: 1234, maxRetries: 0, maxRetryDelayMs: 0 } },
      });
      expect(policy.stream).toEqual({ timeoutMs: 1234, maxRetries: 0, maxRetryDelayMs: 0 });
    } finally {
      await cleanup();
    }
  });

  it("applies tool modifiers in order without mutating the config", async () => {
    await setup();
    try {
      const defaultTools = ["-write", "+powershell", "+powershell", "-read", "+read"];
      expect(resolveSettings({ defaultTools }).defaultTools).toEqual([
        "bash",
        "edit",
        "fffind",
        "ffgrep",
        "powershell",
        "read",
      ]);
      expect(defaultTools).toEqual(["-write", "+powershell", "+powershell", "-read", "+read"]);
      expect(resolveSettings({ defaultTools: [] }).defaultTools).toEqual([]);
      expect(resolveSettings({}).defaultTools).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
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
