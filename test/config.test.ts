import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadMcpServers, resolveSettings, saveRole } from "../src/config.ts";
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
      profiles: {},
      classifier: { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef" },
      settings: {},
      claude: { executable: undefined, plan: "pro", longContextExtraUsage: false },
    });
  });

  it("reads MCP servers from mcp.json in Pi's shape", async () => {
    const directory = await home();
    const ketch = {
      command: "fnox",
      args: ["exec", "--", "ketch", "mcp", "serve"],
      env: { KETCH_MCP_TOOLS: "search,scrape" },
      description: "web research",
      exposure: "deferred",
      toolExposure: { search: "direct" },
      preload: true,
    };
    await writeFile(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { ketch } }));
    expect(await loadMcpServers(directory)).toEqual({ ketch });
  });

  it.each([
    [{ mcpServers: { Bad_Name: { command: "x" } } }, "lowercase letters"],
    [{ mcpServers: { a: {} } }, "exactly one of command or url"],
    [{ mcpServers: { a: { command: "x", url: "https://x" } } }, "exactly one of command or url"],
    [{ mcpServers: { a: { url: "ftp://x" } } }, "http or https"],
    [{ mcpServers: { a: { url: "https://x", env: {} } } }, "a.env needs command"],
    [{ mcpServers: { a: { command: "x", exposure: "hidden" } } }, "direct or deferred"],
    [{ mcpServers: { a: { command: "x", typo: 1 } } }, "unknown fields: typo"],
    [{ mcpServers: { a: { command: "x", preload: "yes" } } }, "a.preload must be a boolean"],
  ])("rejects mcp.json %j", async (mcp, message) => {
    const directory = await home();
    await writeFile(join(directory, "mcp.json"), JSON.stringify(mcp));
    await expect(loadMcpServers(directory)).rejects.toThrow(message);
  });

  it("reads roles and turns the classifier off with null", async () => {
    const config = await loadConfig(
      await home({
        worker: { provider: "openai", modelId: "gpt-6-sol" },
        classifier: null,
      }),
    );
    expect(config.worker).toEqual({
      provider: "openai",
      modelId: "gpt-6-sol",
      thinkingLevel: "high",
    });
    expect(config.classifier).toBeNull();
  });

  it("reads worker profiles, filling an omitted thinking level from the worker default", async () => {
    const config = await loadConfig(
      await home({
        worker: { provider: "p", modelId: "m", thinkingLevel: "medium" },
        profiles: {
          quick: { provider: "p", modelId: "m", thinkingLevel: "low", use: "small clear work" },
          standard: { provider: "p", modelId: "m", use: "normal work" },
        },
      }),
    );
    expect(config.profiles).toEqual({
      quick: { provider: "p", modelId: "m", thinkingLevel: "low", use: "small clear work" },
      standard: { provider: "p", modelId: "m", thinkingLevel: "medium", use: "normal work" },
    });
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
    [
      { cloudflareAccountId: "0123456789abcdef0123456789abcdef" },
      "unknown fields: cloudflareAccountId",
    ],
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
    [{ profiles: [] }, "profiles must be an object"],
    [{ profiles: { Quick: { provider: "p", modelId: "m", use: "u" } } }, "profiles.Quick: names"],
    [{ profiles: { quick: { provider: "p", modelId: "m" } } }, "profiles.quick.use"],
    [{ profiles: { quick: { provider: "p", modelId: "m", use: "u", x: 1 } } }, "unknown fields: x"],
  ])("rejects %j", async (config, message) => {
    await expect(loadConfig(await home(config))).rejects.toThrow(message);
  });

  it("saves one role default atomically, keeping every other field and filling the role from its effective value", async () => {
    const directory = await home({
      worker: { provider: "openai", modelId: "gpt-6-sol" },
      settings: { theme: "light" },
    });
    const accept = () => {};
    expect(await saveRole(directory, "worker", { thinkingLevel: "low" }, accept)).toEqual({
      provider: "openai",
      modelId: "gpt-6-sol",
      thinkingLevel: "low",
    });
    expect(
      await saveRole(
        directory,
        "front",
        { provider: "claude-code", modelId: "claude-opus-5-5" },
        accept,
      ),
    ).toEqual({ provider: "claude-code", modelId: "claude-opus-5-5", thinkingLevel: "low" });
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))).toEqual({
      worker: { provider: "openai", modelId: "gpt-6-sol", thinkingLevel: "low" },
      settings: { theme: "light" },
      front: { provider: "claude-code", modelId: "claude-opus-5-5", thinkingLevel: "low" },
    });
    expect(await readdir(directory)).toEqual(["config.json"]);
    // A missing file starts from the defaults and writes only the saved role.
    const fresh = await home();
    await saveRole(fresh, "front", { thinkingLevel: "medium" }, accept);
    expect(JSON.parse(await readFile(join(fresh, "config.json"), "utf8"))).toEqual({
      front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium" },
    });
  });

  it("never rewrites an invalid file or writes a role that fails validation or the caller's check", async () => {
    const accept = () => {};
    const invalid = await home({ bogus: 1 });
    const before = await readFile(join(invalid, "config.json"), "utf8");
    await expect(saveRole(invalid, "front", { thinkingLevel: "low" }, accept)).rejects.toThrow(
      "unknown fields: bogus",
    );
    expect(await readFile(join(invalid, "config.json"), "utf8")).toBe(before);
    const valid = await home({});
    await expect(saveRole(valid, "worker", { modelId: " " }, accept)).rejects.toThrow(
      "worker.modelId must be a string",
    );
    const reject = (saved: { thinkingLevel: string }) => {
      throw new Error(`no ${saved.thinkingLevel}`);
    };
    await expect(saveRole(valid, "worker", { thinkingLevel: "max" }, reject)).rejects.toThrow(
      "no max",
    );
    expect(await readFile(join(valid, "config.json"), "utf8")).toBe("{}");
    expect(await readdir(valid)).toEqual(["config.json"]);
  });
});
