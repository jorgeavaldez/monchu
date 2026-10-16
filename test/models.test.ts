import { createProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openModels, resolveRoles } from "../src/models/index.ts";
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
      "faux",
    ]);
    const config = await loadConfig(value.directory);
    expect(() => resolveRoles(models, config)).not.toThrow();
    expect(() =>
      resolveRoles(models, { ...config, worker: { ...fauxRole, modelId: "absent" } }),
    ).toThrow("no configured model faux/absent");
    expect(() =>
      resolveRoles(models, {
        ...config,
        classifier: { provider: "faux", modelId: "faux-1" },
      }),
    ).toThrow("no configured classifier model faux/faux-1");
    expect(() =>
      resolveRoles(models, {
        ...config,
        classifier: { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef" },
      }),
    ).not.toThrow();
    expect(models.getModel("cloudflare-workers-ai", "@cf/cloudflare/clef")).toBeUndefined();
    expect(await readFile(join(value.directory, "auth.json"), "utf8")).toBe("{}\n");
  });

  it("logs in to Cloudflare locally and reopens its key/account without exposing them to the catalog", async () => {
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
    await expect(openModels(value.directory)).rejects.toThrow(/^Invalid Monchu auth.json/);
    await expect(openModels(value.directory)).rejects.not.toThrow("test-secret");
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
    const moduleUrl = new URL("../src/models/index.ts", import.meta.url).href;
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
