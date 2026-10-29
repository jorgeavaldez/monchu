import {
  createProvider,
  getSupportedThinkingLevels,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../src/core/config.ts";
import { configuredRoles, openModels } from "../src/core/models/index.ts";
import { LOGIN_PROVIDERS } from "../src/ui/commands.ts";
import { cleanup, fauxRole, setup } from "./support.ts";

afterEach(cleanup);

describe("Monchu models", () => {
  it("registers only its provider modules and resolves every role by operation type", async () => {
    const value = await setup();
    const models = await openModels(value.directory, value.faux.provider);
    expect(models.getProviders().map((provider) => provider.id)).toEqual([
      "openai-codex",
      "cloudflare-workers-ai",
      "claude-code",
      "opencode-go",
      "opencode",
      "openrouter",
      "faux",
    ]);
    const config = await loadConfig(value.directory);
    const warnings = async (change: Partial<typeof config>) =>
      (await configuredRoles(models, { ...config, ...change })).warnings;
    expect(await warnings({})).toEqual([]);
    expect(await warnings({ worker: { ...fauxRole, modelId: "absent" } })).toEqual([
      expect.stringContaining("no configured model faux/absent"),
    ]);
    expect(await readFile(join(value.directory, "auth.json"), "utf8")).toBe("{}\n");
  });

  it("opens with the built-in defaults for a bad role and names the valid choices", async () => {
    const value = await setup();
    const models = await openModels(value.directory, value.faux.provider);
    const config = await loadConfig(value.directory);
    const fixed = await configuredRoles(models, {
      ...config,
      front: { ...fauxRole, modelId: "opus" },
      worker: { ...fauxRole, provider: "codex" },
    });
    expect(fixed.config.front).toEqual(defaultConfig().front);
    expect(fixed.config.worker).toEqual(defaultConfig().worker);
    expect(fixed.warnings).toHaveLength(2);
    expect(fixed.warnings[0]).toContain("no configured model faux/opus (front); faux has");
    expect(fixed.warnings[1]).toContain(
      "providers: openai-codex, cloudflare-workers-ai, claude-code, opencode-go, opencode, openrouter",
    );
    expect(await configuredRoles(models, config)).toEqual({ config, warnings: [] });
    // On reload a bad role keeps the running one instead.
    const running = { ...config, front: { ...fauxRole, thinkingLevel: "low" as const } };
    const kept = await configuredRoles(
      models,
      { ...config, front: { ...fauxRole, modelId: "opus" } },
      running,
    );
    expect(kept.config.front).toEqual(running.front);
    expect(kept.warnings).toEqual([
      expect.stringContaining("Using faux/faux-1 until config.json is fixed"),
    ]);
    // A profile on an unknown model is dropped with a warning; the others stay.
    const profiles = await configuredRoles(models, {
      ...config,
      profiles: {
        good: { ...fauxRole, use: "u" },
        gone: { ...fauxRole, modelId: "absent", use: "u" },
      },
    });
    expect(Object.keys(profiles.config.profiles)).toEqual(["good"]);
    expect(profiles.warnings).toEqual([expect.stringContaining("faux/absent (profiles.gone)")]);
    expect(profiles.warnings[0]).toContain("Profile gone is off");
  });

  it("points roles config.json leaves out at the first chat provider with credentials", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    const config = {
      ...(await loadConfig(value.directory)),
      chosen: { front: false, worker: false },
    };
    expect((await configuredRoles(models, config)).config.front).toEqual(defaultConfig().front);
    await models.login("claude-code", "oauth", {
      prompt: async () => "sk-ant-oat01-scripted",
      notify: () => {},
    });
    const claude = await configuredRoles(models, config);
    expect(claude.config.front).toMatchObject({
      provider: "claude-code",
      modelId: "claude-sonnet-5-5",
    });
    expect(claude.config.worker).toMatchObject({
      provider: "claude-code",
      modelId: "claude-opus-5-5",
    });
    expect(claude.warnings).toEqual([]);
    // A role config.json sets stays as written.
    const codex = defaultConfig().front;
    const front = await configuredRoles(models, {
      ...config,
      front: codex,
      chosen: { front: true, worker: false },
    });
    expect(front.config.front).toEqual(codex);
    expect(front.config.worker.provider).toBe("claude-code");
  });

  it("logs in to Cloudflare locally and reopens its key/account without exposing them", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    const prompts: string[] = [];
    await models.login("cloudflare-workers-ai", "api_key", {
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        return prompt.type === "secret" ? "test-cloudflare-key" : "a".repeat(32);
      },
      notify: () => {},
    });
    expect(prompts).toEqual(["secret", "text"]);
    // An existing valid credential file must also be restricted, not only newly created files.
    await chmod(join(value.directory, "auth.json"), 0o644);
    const reopened = await openModels(value.directory);
    if (process.platform !== "win32")
      expect((await stat(join(value.directory, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await reopened.getAuth("cloudflare-workers-ai")).toEqual({
      auth: { apiKey: "test-cloudflare-key" },
      env: { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
      source: "stored credential",
    });
    expect(await reopened.checkAuth("cloudflare-workers-ai")).toMatchObject({ type: "api_key" });
    expect(JSON.stringify(reopened.getAllModels())).not.toContain("test-cloudflare-key");
    if (process.platform !== "win32")
      expect((await stat(join(value.directory, "auth.json"))).mode & 0o777).toBe(0o600);
    await reopened.logout("cloudflare-workers-ai");
    expect(await readFile(join(value.directory, "auth.json"), "utf8")).toBe("{}\n");
    expect((await readdir(value.directory)).filter((name) => name.startsWith("auth.json"))).toEqual(
      ["auth.json"],
    );
  });

  it.each(["opencode-go", "opencode", "openrouter"])(
    "logs in to %s with an API key that only auth.json holds",
    async (provider) => {
      const value = await setup();
      const models = await openModels(value.directory);
      const prompts: string[] = [];
      await models.login(provider, "api_key", {
        prompt: async (prompt) => {
          prompts.push(prompt.type);
          return "test-provider-key";
        },
        notify: () => {},
      });
      expect(prompts).toEqual(["secret"]);
      const reopened = await openModels(value.directory);
      expect(await reopened.getAuth(provider)).toEqual({
        auth: { apiKey: "test-provider-key" },
        source: "stored credential",
      });
      expect(JSON.stringify(reopened.getAllModels())).not.toContain("test-provider-key");
      expect(reopened.getModels(provider).length).toBeGreaterThan(0);
    },
  );

  it.each(["opencode-go", "opencode"])(
    "declares tools loaded mid-conversation up front to %s's kimi-k3",
    async (provider) => {
      const value = await setup();
      const models = await openModels(value.directory);
      const bodies: string[] = [];
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          bodies.push(body);
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"error":{"message":"captured"}}');
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const model = models.getModel(provider, "kimi-k3");
        const address = server.address();
        if (model === undefined || address === null || typeof address === "string")
          throw new Error(`${provider} has no kimi-k3, or the server no port`);
        const tool = (name: string) => ({
          name,
          description: name,
          parameters: { type: "object" as const, properties: {} },
        });
        const reply = await models.completeSimple(
          { ...model, baseUrl: `http://127.0.0.1:${address.port}/v1` },
          {
            messages: [
              { role: "system", content: "be brief", toolsAdded: [tool("get_time")], timestamp: 1 },
              { role: "user", content: "what time is it", timestamp: 2 },
              { role: "system", content: "", toolsAdded: [tool("get_date")], timestamp: 3 },
              { role: "user", content: "and the date", timestamp: 4 },
            ],
          },
          { apiKey: "test-provider-key", maxRetries: 0 },
        );
        expect(reply.errorMessage).toContain("captured");
        // OpenCode's gateway rejects a mid-conversation `{ role: "system", tools }` message and never calls its tools.
        const sent: unknown = JSON.parse(bodies[0] ?? "{}");
        expect(sent).toMatchObject({
          tools: [{ function: { name: "get_time" } }, { function: { name: "get_date" } }],
        });
        // The top-level declaration is the only `tools` field: no message carries one.
        expect(bodies[0]?.match(/"tools":/g)).toHaveLength(1);
      } finally {
        server.close();
      }
    },
  );

  it("resolves OpenCode and OpenRouter roles, and offers Jev as a classifier", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    // Every /login entry is a registered provider offering the login it asks for.
    for (const entry of LOGIN_PROVIDERS)
      expect(models.getProvider(entry.id)?.auth).toHaveProperty(
        entry.auth === "api_key" ? "apiKey" : "oauth",
      );
    const config = await loadConfig(value.directory);
    const go = models.getModels("opencode-go")[0];
    const router = models.getModels("openrouter")[0];
    if (go === undefined || router === undefined) throw new Error("missing bundled catalogs");
    expect(
      (
        await configuredRoles(models, {
          ...config,
          front: { provider: "opencode-go", modelId: go.id, thinkingLevel: "low" },
          worker: { provider: "openrouter", modelId: router.id, thinkingLevel: "low" },
        })
      ).warnings,
    ).toEqual([]);
    // Jev, which the classifier plugin can use, is a classifier model of both OpenCode Zen and OpenRouter.
    expect(models.getModelOfType("classifier", "opencode", "jev-1.13")?.api).toBe(
      "typesafe-system-one",
    );
    expect(models.getModelOfType("classifier", "opencode", "jev-1.13-free")).toBeDefined();
    expect(models.getModelOfType("classifier", "openrouter", "~typesafe/jev-latest")).toBeDefined();
  });

  it("serves OpenCode Go models newer than the bundled catalog at the levels they take", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    const requests: { url: string; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body });
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"captured"}}');
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const base = `http://127.0.0.1:${address.port}/v1`;
      const ask = async (id: string, reasoning: "max" | "high") => {
        const model = models.getModel("opencode-go", id);
        if (model === undefined) throw new Error(`opencode-go has no ${id}`);
        const reply = await models.completeSimple(
          { ...model, baseUrl: base },
          { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
          { apiKey: "test-provider-key", reasoning, maxRetries: 0 },
        );
        expect(reply.errorMessage).toContain("captured");
        return model;
      };
      const kimi = await ask("kimi-k3.1-pro", "max");
      expect(getSupportedThinkingLevels(kimi)).toEqual(["low", "high", "max"]);
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        model: "kimi-k3.1-pro",
        reasoning_effort: "max",
      });
      const argon = await ask("gemini-4-argon", "high");
      expect(getSupportedThinkingLevels(argon)).toEqual(["low", "medium", "high"]);
      expect(requests[1]?.url).toContain("/models/gemini-4-argon:");
    } finally {
      server.close();
    }
  });

  it.each([
    '{"secret":"test-secret-in-invalid-json"',
    "[]",
    '{"faux":{"type":"oauth","access":"test-secret","refresh":"test-refresh","expires":"invalid"}}',
    '{"faux":{"type":"api_key","key":"test-secret","env":{"ACCOUNT":42}}}',
    '{"faux":{"type":"unknown","key":"test-secret"}}',
  ])("rejects malformed credentials without leaking their contents (%#)", async (raw) => {
    const value = await setup();
    const path = join(value.directory, "auth.json");
    await writeFile(path, raw);
    // Monchu opens, saying so; every use of the file fails the same way, and nothing saves over it.
    const warnings: string[] = [];
    const models = await openModels(value.directory, undefined, undefined, (warning) =>
      warnings.push(warning),
    );
    expect(warnings).toEqual([expect.stringMatching(/^Invalid Monchu auth.json/)]);
    expect(warnings.join("\n")).not.toContain("test-secret");
    await expect(models.getAuth("openai-codex")).rejects.toThrow("Credential store read failed");
    await expect(models.getAuth("openai-codex")).rejects.not.toThrow("test-secret");
    expect(await readFile(path, "utf8")).toBe(raw);
    expect((await readdir(value.directory)).filter((name) => name.startsWith("auth.json"))).toEqual(
      ["auth.json"],
    );
  });

  it("serializes rotated OAuth refreshes, persists despite caller abort, and cancels a waiting logout", async () => {
    const value = await setup();
    const path = join(value.directory, "auth.json");
    const expired: OAuthCredential = {
      type: "oauth",
      access: "expired-access",
      refresh: "original-refresh",
      expires: 0,
      accountId: "test-account",
    };
    await writeFile(path, JSON.stringify({ faux: expired }));
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let refreshes = 0;
    const provider = createProvider({
      id: "faux",
      models: value.faux.models,
      api: value.faux.provider,
      auth: {
        oauth: {
          name: "Scripted subscription",
          login: async () => expired,
          refresh: async (current) => {
            refreshes++;
            started.resolve();
            await finish.promise;
            return {
              ...current,
              access: "refreshed-access",
              refresh: "rotated-refresh",
              expires: Date.now() + 3600000,
            };
          },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    const first = await openModels(value.directory, provider);
    const second = await openModels(value.directory, provider);
    const abort = new AbortController();
    const request = first.getAuth("faux", { signal: abort.signal });
    // Attach the rejection handler before cancelling; the refresh itself continues to persist.
    const cancelled = expect(request).rejects.toThrow();
    try {
      await started.promise;
      const other = second.getAuth("faux");
      const logoutAbort = new AbortController();
      const logout = second.logout("faux", { signal: logoutAbort.signal });
      const cancelledLogout = expect(logout).rejects.toThrow();
      logoutAbort.abort();
      await cancelledLogout;
      abort.abort();
      await cancelled;
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ faux: expired });
      finish.resolve();
      expect(await other).toMatchObject({ auth: { apiKey: "refreshed-access" } });
      expect(refreshes).toBe(1);
      const stored: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(stored).toMatchObject({
        faux: { refresh: "rotated-refresh", accountId: "test-account" },
      });
      expect(
        (await readdir(value.directory)).filter((name) => name.startsWith("auth.json")),
      ).toEqual(["auth.json"]);
    } finally {
      finish.resolve();
      await cancelled;
    }
  });

  it("merges concurrent provider logins from separate processes without losing entries or exposing partial JSON", async () => {
    const value = await setup();
    await openModels(value.directory);
    const moduleUrl = new URL("../src/core/models/index.ts", import.meta.url).href;
    const script = `
      import { createProvider, fauxProvider } from "@earendil-works/pi-ai";
      const { openModels } = await import(${JSON.stringify(moduleUrl)});
      const [home, id] = process.argv.slice(1);
      const faux = fauxProvider({ provider: id });
      const provider = createProvider({
        id,
        models: faux.models,
        api: faux.provider,
        auth: { apiKey: {
          name: "Test key",
          resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key } } : undefined,
          login: async (interaction) => ({
            type: "api_key",
            key: await interaction.prompt({ type: "secret", message: "Key" }),
          }),
        } },
      });
      const models = await openModels(home, provider);
      const start = new Promise((resolve) => process.once("message", resolve));
      process.send("ready");
      await start;
      for (let i = 0; i < 10; i++) {
        await models.login(id, "api_key", {
          prompt: async () => "test-key-" + id + "-" + i,
          notify: () => {},
        });
      }
      process.disconnect();
    `;
    const children = ["one", "two"].map((id) => {
      const ready = Promise.withResolvers<void>();
      const done = Promise.withResolvers<number | null>();
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script, value.directory, id],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeout: 15000,
        },
      );
      let errors = "";
      child.stderr?.on("data", (data: Buffer) => {
        errors += data.toString();
      });
      child.on("message", (message: unknown) => {
        if (message === "ready") ready.resolve();
      });
      child.once("error", (error) => {
        ready.reject(error);
        done.reject(error);
      });
      child.once("close", (code) => {
        ready.reject(new Error(`Credential child exited before readiness: ${errors}`));
        done.resolve(code);
      });
      return { child, ready: ready.promise, done: done.promise, errors: () => errors };
    });
    try {
      await Promise.all(children.map((child) => child.ready));
      for (const { child } of children) child.send("start");
      // Atomic readers need no lock: throughout replacement the public file is complete JSON.
      for (let i = 0; i < 50; i++) {
        const current: unknown = JSON.parse(
          await readFile(join(value.directory, "auth.json"), "utf8"),
        );
        expect(current).toBeTypeOf("object");
      }
      const exits = await Promise.all(children.map((child) => child.done));
      expect(exits, children.map((child) => child.errors()).join("\n")).toEqual([0, 0]);
      const stored: unknown = JSON.parse(
        await readFile(join(value.directory, "auth.json"), "utf8"),
      );
      expect(stored).toEqual({
        one: { type: "api_key", key: "test-key-one-9" },
        two: { type: "api_key", key: "test-key-two-9" },
      });
      expect(
        (await readdir(value.directory)).filter((name) => name.startsWith("auth.json")),
      ).toEqual(["auth.json"]);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.allSettled(children.map((child) => child.done));
    }
  }, 20000);
});
