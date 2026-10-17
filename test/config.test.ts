import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  loadConfig,
  loadWebConfig,
  resolveSettings,
  saveRole,
} from "../src/core/config.ts";
import { loadMcpConfig, validateMcpServer } from "../src/core/mcp/config.ts";

const codex = defaultConfig();
import { harnessSettings } from "../src/core/context.ts";
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
      expect(policy.stream).toEqual({
        cacheRetention: "long",
        timeoutMs: 300000,
        maxRetryDelayMs: 60000,
      });
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
      expect(policy.stream).toEqual({
        cacheRetention: "long",
        timeoutMs: 1234,
        maxRetries: 0,
        maxRetryDelayMs: 0,
      });
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
      chosen: { front: false, worker: false },
    });
  });

  it("reads Pi's mcp.json unchanged, leaving out only invalid entries", async () => {
    const directory = await home();
    // Pi's own entries: stdio ketch through fnox, and Notion over HTTP, which signs in with OAuth.
    const ketch = {
      command: "fnox",
      args: ["--no-daemon", "--non-interactive", "exec", "--", "ketch", "mcp", "serve"],
      env: { KETCH_MCP_TOOLS: "search,code,scrape,crawl,tag" },
      description: "web research",
      exposure: "deferred",
      toolExposure: { search: "direct", scrape: "direct" },
      preload: true,
    };
    const notion = { url: "https://mcp.notion.com/mcp", exposure: "deferred" };
    const linear = {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Team": "${TEAM}" },
      oauth: {
        clientId: "abc",
        clientSecret: "!pass show linear",
        callbackPort: 8765,
        scope: "read",
      },
      timeout: 30,
      toolExposure: { "list_*": "direct", delete_issue: "codemode-deferred" },
    };
    await writeFile(
      join(directory, "mcp.json"),
      JSON.stringify({
        mcpServers: { ketch, notion, linear, broken: { command: 1 }, "bad name": {} },
      }),
    );
    const { servers, errors } = await loadMcpConfig(directory);
    expect(servers).toEqual({
      ketch,
      notion,
      linear: { ...linear, toolExposure: { "list_*": "direct", delete_issue: "codemode" } },
    });
    expect(errors).toEqual([
      `${join(directory, "mcp.json")}: server "broken" needs either "command" (stdio) or "url" (streamable HTTP)`,
      `${join(directory, "mcp.json")}: invalid server name "bad name" (use letters, digits, "_" and "-")`,
    ]);
  });

  it.each([
    [{ url: "ftp://x" }, "url must be an http or https URL"],
    [{ type: "sse", url: "https://x" }, "legacy SSE transport is not supported"],
    [{ command: "x", exposure: "loud" }, "exposure must be one of"],
    [{ command: "x", timeout: 0 }, "timeout must be a positive number of seconds"],
    [{ command: "x", preload: "yes" }, "preload must be a boolean"],
    [{ url: "http://example.com", auth: { provider: "p" } }, "auth requires an https URL"],
    [{ url: "https://x", oauth: { callbackUrl: "https://example.com/cb" } }, "oauth.callbackUrl"],
  ])("rejects the MCP server %j", (raw, message) => {
    const result = validateMcpServer("s", raw);
    expect(typeof result === "string" ? result : "valid").toContain(message);
  });

  it("reads web.json with generic defaults and refuses anything unsafe or unknown", async () => {
    const webHome = async (web: unknown) => {
      const directory = await home();
      await writeFile(join(directory, "web.json"), JSON.stringify(web));
      return directory;
    };
    expect(await loadWebConfig(await home({}))).toBeUndefined();
    await expect(loadConfig(await home({ web: {} }))).rejects.toThrow("move them to web.json");
    expect(
      await loadWebConfig(
        await webHome({
          host: "monchu.example.test",
          access: { teamDomain: "https://team.example.test/", audience: "aud" },
          oidc: { issuer: "http://127.0.0.1:9000", clientId: "client" },
          allow: ["sub:abc", "email:a@example.test", "service:id"],
        }),
      ),
    ).toEqual({
      port: 7420,
      host: "monchu.example.test",
      access: { teamDomain: "https://team.example.test", audience: "aud", subjectClaim: "sub" },
      oidc: {
        issuer: "http://127.0.0.1:9000",
        clientId: "client",
        clientSecretEnv: undefined,
        scopes: ["openid", "profile", "email"],
        subjectClaim: "sub",
      },
      allow: ["sub:abc", "email:a@example.test", "service:id"],
    });
    for (const [web, message] of [
      [
        { oidc: { issuer: "http://idp.example.test", clientId: "c" } },
        "web.oidc.issuer must be an https URL",
      ],
      [
        { oidc: { issuer: "https://idp.example.test", clientId: "c", scopes: ["email"] } },
        "must include openid",
      ],
      [{ allow: ["anyone"] }, "web.allow must list"],
      [{ host: "https://monchu.example.test/" }, "web.host must be a host name"],
      [{ bind: "0.0.0.0" }, "web: unknown fields: bind"],
    ] as const)
      await expect(loadWebConfig(await webHome(web))).rejects.toThrow(message);
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
    expect(
      await saveRole(directory, "worker", { thinkingLevel: "low" }, accept, codex.worker),
    ).toEqual({
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
        codex.front,
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
    await saveRole(fresh, "front", { thinkingLevel: "medium" }, accept, codex.front);
    expect(JSON.parse(await readFile(join(fresh, "config.json"), "utf8"))).toEqual({
      front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium" },
    });
    // A role the file leaves out starts from the one in use, such as the logged-in provider's default.
    const claude = await home();
    const opus = {
      provider: "claude-code",
      modelId: "claude-opus-5-5",
      thinkingLevel: "medium",
    } as const;
    await saveRole(claude, "worker", { thinkingLevel: "high" }, accept, opus);
    expect(JSON.parse(await readFile(join(claude, "config.json"), "utf8"))).toEqual({
      worker: { ...opus, thinkingLevel: "high" },
    });
  });

  it("never rewrites an invalid file or writes a role that fails validation or the caller's check", async () => {
    const accept = () => {};
    const invalid = await home({ bogus: 1 });
    const before = await readFile(join(invalid, "config.json"), "utf8");
    await expect(
      saveRole(invalid, "front", { thinkingLevel: "low" }, accept, codex.front),
    ).rejects.toThrow("unknown fields: bogus");
    expect(await readFile(join(invalid, "config.json"), "utf8")).toBe(before);
    const valid = await home({});
    await expect(saveRole(valid, "worker", { modelId: " " }, accept, codex.worker)).rejects.toThrow(
      "worker.modelId must be a string",
    );
    const reject = (saved: { thinkingLevel: string }) => {
      throw new Error(`no ${saved.thinkingLevel}`);
    };
    await expect(
      saveRole(valid, "worker", { thinkingLevel: "max" }, reject, codex.worker),
    ).rejects.toThrow("no max");
    expect(await readFile(join(valid, "config.json"), "utf8")).toBe("{}");
    expect(await readdir(valid)).toEqual(["config.json"]);
  });
});
