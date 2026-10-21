import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shortId } from "../src/api/ids.ts";
import { answerRequests, SecretsDoc } from "../src/core/secrets/requests.ts";
import {
  commandSecrets,
  createSecrets,
  fillPlaceholders,
  redacting,
} from "../src/core/secrets/tool.ts";
import { MemoryStore, StreamRedactor, Vault, redact } from "../src/core/secrets/vault.ts";
import { ageIdentity, FnoxStore } from "../src/plugins/fnox/index.ts";
import {
  cleanup,
  context,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  waitFor,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

/** Every byte the store wrote, its sidecars included, as text to search. */
async function storeBytes(directory: string): Promise<string> {
  let text = "";
  for (const name of await readdir(directory))
    if (name.startsWith("monchu.sqlite"))
      text += (await readFile(join(directory, name))).toString("latin1");
  return text;
}

/**
 * The front makes `calls` in order, one per user turn, then answers each later turn plainly. Tool results land in
 * `outputs`, and each later input the front heard in `outputs.heard`.
 */
function script(
  value: Setup,
  calls: ReturnType<typeof fauxToolCall>[],
): string[] & { heard: string[] } {
  const heard: string[] = [];
  const outputs = Object.assign<string[], { heard: string[] }>([], { heard });
  const step: FauxResponseStep = (request) => {
    const last = lastMessage(request.messages);
    if (last?.role === "toolResult") {
      outputs.push(textOf(last));
      return fauxAssistantMessage("ok");
    }
    const call = calls.shift();
    if (call !== undefined) return fauxAssistantMessage([call], { stopReason: "toolUse" });
    outputs.heard.push(textOf(last));
    return fauxAssistantMessage("heard");
  };
  route(value.faux, step);
  return outputs;
}

describe("vault", () => {
  it("lists names only, keeps a login's two keys, and refuses bad names and clashes", async () => {
    const store = new MemoryStore();
    const audit: string[] = [];
    const dir = join(await mkdtemp(join(tmpdir(), "monchu-vault-")), "secrets");
    const vault = new Vault(dir, {
      store,
      audit: (body, attributes) => audit.push(`${body} ${JSON.stringify(attributes)}`),
    });
    await vault.set({ name: "API_TOKEN", kind: "value", value: "token-value-1" });
    await vault.set({
      name: "SHOP",
      kind: "login",
      site: "https://shop.example/login",
      username: "me@example.com",
      password: "pass-word-2",
    });
    const listed = await vault.list();
    expect(listed.map(({ name, kind, site }) => ({ name, kind, site }))).toEqual([
      { name: "API_TOKEN", kind: "value", site: undefined },
      { name: "SHOP", kind: "login", site: "https://shop.example" },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/token-value-1|pass-word-2/);
    expect([...store.values.keys()].toSorted()).toEqual([
      "API_TOKEN",
      "SHOP_PASSWORD",
      "SHOP_USERNAME",
    ]);
    await expect(vault.set({ name: "bad-name", kind: "value", value: "x" })).rejects.toThrow(
      /name is A-Z/,
    );
    await expect(vault.set({ name: "SHOP_PASSWORD", kind: "value", value: "x" })).rejects.toThrow(
      "SHOP_PASSWORD is already a key of the secret SHOP",
    );
    await expect(vault.set({ name: "EMPTY", kind: "value", value: "" })).rejects.toThrow("empty");

    // Unknown keys (an ordinary `$HOME`) are left out; a use is audited by name.
    expect(
      await vault.resolve(["HOME", "SHOP_PASSWORD"], { tool: "bash", conversation: "kkkk" }),
    ).toEqual({ SHOP_PASSWORD: "pass-word-2" });
    expect(audit.at(-1)).toBe('secret used {"name":"SHOP","tool":"bash","conversation":"kkkk"}');
    expect(audit.join("\n")).not.toMatch(/token-value-1|pass-word-2/);
    expect((await vault.info("SHOP"))?.usedAt).toBeTypeOf("number");

    await vault.delete("SHOP");
    expect([...store.values.keys()]).toEqual(["API_TOKEN"]);
    // The index outlives the process: a new vault over the same folder lists the same names.
    const again = new Vault(dir, { store });
    expect((await again.list()).map(({ name }) => name)).toEqual(["API_TOKEN"]);
  });

  it("deletes warm values and both login keys without reviving them on later use or restart", async () => {
    const store = new MemoryStore();
    const dir = join(await mkdtemp(join(tmpdir(), "monchu-vault-")), "secrets");
    const vault = new Vault(dir, { store });
    const changes: string[][] = [];
    vault.onChange((secrets) => changes.push(secrets.map(({ name }) => name)));
    await vault.set({ name: "TOKEN", kind: "value", value: "delete-token-value" });
    await vault.set({ name: "KEEP", kind: "value", value: "keep-token-value" });
    await vault.set({
      name: "SHOP",
      kind: "login",
      username: "shop-user",
      password: "shop-password",
    });
    const use = { tool: "bash", conversation: "test" };
    await vault.resolve(["TOKEN", "SHOP_PASSWORD"], use);
    expect(await vault.known()).toHaveLength(4);
    await vault.delete("TOKEN");
    await vault.delete("SHOP");
    await vault.delete("TOKEN"); // Tool replay has the same outcome.
    expect(await store.readAll()).toEqual({ KEEP: "keep-token-value" });
    expect(await vault.resolve(["TOKEN", "SHOP_USERNAME", "SHOP_PASSWORD"], use)).toEqual({});
    expect(await vault.known()).toEqual([{ key: "KEEP", value: "keep-token-value" }]);
    expect(await vault.owner("SHOP_PASSWORD")).toBeUndefined();
    expect(changes.at(-1)).toEqual(["KEEP"]);
    const again = new Vault(dir, { store });
    expect((await again.list()).map(({ name }) => name)).toEqual(["KEEP"]);
    expect(await again.resolve(["TOKEN", "SHOP_PASSWORD"], use)).toEqual({});
    expect(await readFile(join(dir, "index.json"), "utf8")).not.toMatch(/TOKEN|SHOP/);
  });

  it("finishes an in-flight read before delete, never caching or auditing a deleted value afterward", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class SlowStore extends MemoryStore {
      override async readAll(): Promise<Record<string, string>> {
        const values = await super.readAll();
        started.resolve();
        await release.promise;
        return values;
      }
    }
    const store = new SlowStore();
    const audit: string[] = [];
    const vault = new Vault(join(await mkdtemp(join(tmpdir(), "monchu-vault-")), "secrets"), {
      store,
      audit: (body) => audit.push(body),
    });
    await vault.set({ name: "TOKEN", kind: "value", value: "old-token-value" });
    await vault.set({ name: "KEEP", kind: "value", value: "keep-token-value" });
    const use = { tool: "bash", conversation: "test" };
    const reading = vault.resolve(["TOKEN"], use);
    await started.promise;
    const deleting = vault.delete("TOKEN");
    const later = vault.resolve(["TOKEN"], use);
    release.resolve();
    await reading; // A use accepted before deletion may already have received the value.
    await deleting;
    expect(await later).toEqual({});
    expect(audit.slice(-2)).toEqual(["secret used", "secret deleted"]);
    expect(await vault.known()).toEqual([{ key: "KEEP", value: "keep-token-value" }]);
    expect(await vault.info("TOKEN")).toBeUndefined();
  });

  it("redacts values, also when a stream splits one across chunks", () => {
    const known = [{ key: "TOKEN", value: "abcdef123456" }];
    expect(redact("x abcdef123456 y abcdef123456", known)).toBe(
      "x [secret TOKEN] y [secret TOKEN]",
    );
    const stream = new StreamRedactor(known);
    const out = ["start abc", "def12", "3456 end, and abc", "!"].map((chunk) => stream.push(chunk));
    expect(out.join("") + stream.end()).toBe("start [secret TOKEN] end, and abc!");
    // Text that can't start a value never waits.
    expect(new StreamRedactor(known).push("plain text")).toBe("plain text");
  });

  it("keeps a job's injected values redacted when deletion races its redaction snapshot", async () => {
    const vault = new Vault(join(await mkdtemp(join(tmpdir(), "monchu-vault-")), "secrets"), {
      store: new MemoryStore(),
    });
    await vault.set({ name: "TOKEN", kind: "value", value: "job-token-value" });
    const command = commandSecrets(vault, 'echo "$TOKEN"', { tool: "job", conversation: "test" });
    const deleting = vault.delete("TOKEN");
    const { env, redactor } = await command;
    await deleting;
    expect(env.TOKEN).toBe("job-token-value");
    expect(redactor.push(env.TOKEN ?? "") + redactor.end()).toBe("[secret TOKEN]");
    expect(await vault.known()).toEqual([]);
  });

  it("fills placeholders only on a login's own site", async () => {
    const vault = new Vault(join(await mkdtemp(join(tmpdir(), "monchu-vault-")), "secrets"), {
      store: new MemoryStore(),
    });
    await vault.set({
      name: "SHOP",
      kind: "login",
      site: "https://shop.example",
      username: "me",
      password: "pass-word-2",
    });
    const use = { tool: "agent_browser", conversation: "kkkk" };
    await expect(
      fillPlaceholders(vault, ["fill", "@e2", "{{secret:SHOP_PASSWORD}}"], {
        ...use,
        origin: async () => "https://evil.example",
      }),
    ).rejects.toThrow("SHOP is only for https://shop.example; the page is on https://evil.example");
    expect(
      await fillPlaceholders(vault, ["fill", "@e2", "{{secret:SHOP_PASSWORD}}"], {
        ...use,
        origin: async () => "https://shop.example",
      }),
    ).toEqual(["fill", "@e2", "pass-word-2"]);
    await expect(fillPlaceholders(vault, ["fill", "@e2", "{{secret:NOPE}}"], use)).rejects.toThrow(
      "No secret NOPE",
    );
  });

  it("makes age keys in age's own format", () => {
    const { identity, recipient } = ageIdentity();
    expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9AC-HJ-NP-Z]{58}$/);
    expect(recipient).toMatch(/^age1[0-9ac-hj-np-z]{58}$/);
    const keygen = spawnSync("age-keygen", ["-y"], { input: identity, encoding: "utf8" });
    // Where age is installed, it derives the same recipient.
    if (keygen.status === 0) expect(keygen.stdout.trim()).toBe(recipient);
  });

  const fnox = spawnSync("fnox", ["--version"]).status === 0;
  it.skipIf(!fnox)("stores, reads and removes values with fnox under its own config", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "monchu-fnox-")), "secrets");
    try {
      const store = new FnoxStore(dir);
      await store.write("MONCHU_TEST_ONE", "first value");
      await store.write("MONCHU_TEST_TWO", "second value");
      await store.write("MONCHU_TEST_ONE", "rotated value");
      // Only Monchu's config: none of the user's own fnox secrets come along.
      expect(await store.readAll()).toEqual({
        MONCHU_TEST_ONE: "rotated value",
        MONCHU_TEST_TWO: "second value",
      });
      await store.remove("MONCHU_TEST_TWO");
      await store.remove("MONCHU_TEST_TWO");
      expect(Object.keys(await store.readAll())).toEqual(["MONCHU_TEST_ONE"]);
      expect(await readFile(join(dir, "fnox.toml"), "utf8")).not.toContain("rotated value");
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("secrets in tools", () => {
  it("puts a named secret in a bash command's environment and never in results or the store", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    const secret = "s3cr3t-token-value";
    await value.vault.set({ name: "API_TOKEN", kind: "value", value: secret });
    const outputs = script(value, [
      fauxToolCall("bash", { command: 'printf "%s|%sx" "$API_TOKEN" "${API_TOKEN}"' }),
      fauxToolCall("secret", { action: "list" }),
    ]);
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "use it" }, context)).wait(context);
      await (await root.submit({ type: "input", content: "list" }, context)).wait(context);
    } finally {
      await harness.close(context);
    }
    expect(outputs[0]).toBe("[secret API_TOKEN]|[secret API_TOKEN]x");
    expect(outputs[1]).toContain('"name":"API_TOKEN"');
    expect(outputs.join("\n")).not.toContain(secret);
    expect(await storeBytes(value.directory)).not.toContain(secret);
  });

  it("imports a value from a file or one line of a .env, never showing it", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    const files = await mkdtemp(join(tmpdir(), "monchu-import-"));
    await writeFile(join(files, "token"), "file-token-value\n");
    await writeFile(join(files, ".env"), 'OTHER=x\nexport API_KEY="env-key-value"\n');
    const outputs = script(value, [
      fauxToolCall("secret", { action: "import", name: "FILE_TOKEN", path: join(files, "token") }),
      fauxToolCall("secret", {
        action: "import",
        name: "API_KEY",
        path: join(files, ".env"),
        key: "API_KEY",
      }),
      fauxToolCall("secret", {
        action: "import",
        name: "MISSING",
        path: join(files, ".env"),
        key: "NOPE",
      }),
      fauxToolCall("bash", { command: 'printf "%s|%s" "$FILE_TOKEN" "$API_KEY"' }),
    ]);
    const { harness, root } = await open(value);
    try {
      for (const content of ["file", "env", "missing", "use"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
    } finally {
      await harness.close(context);
      await rm(files, { recursive: true, force: true });
    }
    expect(outputs[0]).toMatch(/^Stored FILE_TOKEN from /);
    expect(outputs[1]).toMatch(/^Stored API_KEY from .* \(API_KEY\)/);
    expect(outputs[2]).toContain("has no NOPE= line");
    expect(outputs[3]).toBe("[secret FILE_TOKEN]|[secret API_KEY]");
    expect(
      await value.vault.resolve(["FILE_TOKEN", "API_KEY"], { tool: "t", conversation: "c" }),
    ).toEqual({ FILE_TOKEN: "file-token-value", API_KEY: "env-key-value" });
    expect(outputs.join("\n")).not.toMatch(/file-token-value|env-key-value/);
    expect(await storeBytes(value.directory)).not.toMatch(/file-token-value|env-key-value/);
  });

  it("deletes through the agent tool, including a login, with no later injection or resurrection", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    await value.vault.set({ name: "TOKEN", kind: "value", value: "delete-token-value" });
    await value.vault.set({
      name: "SHOP",
      kind: "login",
      username: "shop-user",
      password: "shop-password",
    });
    const outputs = script(value, [
      fauxToolCall("bash", { command: 'printf "%s|%s" "$TOKEN" "$SHOP_PASSWORD"' }),
      fauxToolCall("secret", { action: "delete", name: "TOKEN" }),
      fauxToolCall("secret", { action: "delete", name: "SHOP" }),
      fauxToolCall("secret", { action: "delete", name: "TOKEN" }),
      fauxToolCall("secret", { action: "delete", name: "bad-name" }),
      fauxToolCall("bash", {
        command: 'printf "token=%s|user=%s|password=%s" "$TOKEN" "$SHOP_USERNAME" "$SHOP_PASSWORD"',
      }),
      fauxToolCall("secret", { action: "list" }),
    ]);
    const { harness, root } = await open(value);
    try {
      for (let index = 0; index < 7; index++)
        await (
          await root.submit({ type: "input", content: `step ${index}` }, context)
        ).wait(context);
    } finally {
      await harness.close(context);
    }
    expect(outputs[0]).toBe("[secret TOKEN]|[secret SHOP_PASSWORD]");
    expect(outputs[1]).toContain("Deleted TOKEN");
    expect(outputs[2]).toContain("Deleted SHOP");
    expect(outputs[3]).toContain("Deleted TOKEN");
    expect(outputs[4]).toContain("delete needs a name");
    expect(outputs[5]).toBe("token=|user=|password=");
    expect(JSON.parse(outputs[6] ?? "")).toEqual({ secrets: [], pending: [] });
    expect(await value.vault.known()).toEqual([]);
    expect(await storeBytes(value.directory)).not.toMatch(
      /delete-token-value|shop-password|shop-user/,
    );
  });

  it("still redacts a running call's result when its secret is deleted before the call finishes", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    await value.vault.set({ name: "TOKEN", kind: "value", value: "inflight-token-value" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    value.registry.install(
      defineExtension({
        name: "test.inflight",
        tools: [
          redacting(
            defineTool({
              name: "inflight",
              description: "Return a secret already received by a running call",
              parameters: Type.Object({}),
              execute: async (_args, api) => {
                const env = await value.vault.resolve(["TOKEN"], {
                  tool: "inflight",
                  conversation: "test",
                });
                started.resolve();
                await release.promise;
                const text = env.TOKEN ?? "missing";
                api.output(text);
                return { output: [{ type: "text", text }], details: { text } };
              },
            }),
            value.vault,
          ),
        ],
      }),
    );
    const outputs = script(value, [fauxToolCall("inflight", {})]);
    const { harness, root } = await open(value);
    try {
      const run = await root.submit({ type: "input", content: "use" }, context);
      await started.promise;
      await value.vault.delete("TOKEN");
      release.resolve();
      await run.wait(context);
      expect(outputs[0]).toBe("[secret TOKEN]");
      expect(await value.vault.known()).toEqual([]);
    } finally {
      release.resolve();
      await harness.close(context);
    }
    expect(await storeBytes(value.directory)).not.toContain("inflight-token-value");
  });

  it("asks for a secret without waiting, and tells whoever asked once it is set", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    const outputs = script(value, [
      fauxToolCall("secret", { action: "request", name: "GH_TOKEN", reason: "push to GitHub" }),
    ]);
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "push" }, context)).wait(context);
      expect(outputs[0]).toMatch(/^Asked\./);
      const requests = (await harness.snapshot(SecretsDoc, context))?.requests ?? [];
      expect(requests.map(({ name, reason, by }) => ({ name, reason, by }))).toEqual([
        { name: "GH_TOKEN", reason: "push to GitHub", by: `${shortId(root.id)} front` },
      ]);
      const info = await value.vault.set({ name: "GH_TOKEN", kind: "value", value: "gh-value-99" });
      expect(await answerRequests(harness, "GH_TOKEN", info, context)).toBe(1);
      expect((await harness.snapshot(SecretsDoc, context))?.requests).toEqual([]);
      // The notice starts the front's next turn and names the secret, never its value.
      await waitFor(() => outputs.heard.some((text) => text.includes("secret GH_TOKEN is set")));
      expect(outputs.heard.join("\n")).not.toContain("gh-value-99");
    } finally {
      await harness.close(context);
    }
    expect(await storeBytes(value.directory)).not.toContain("gh-value-99");
  });

  it("tells an agent that carried on at its next step, not once its run ends", async () => {
    const value = await setup();
    value.registry.install(createSecrets(value.vault));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    value.registry.install(
      defineExtension({
        name: "test.hold",
        tools: [
          defineTool({
            name: "hold",
            description: "Other work",
            parameters: Type.Object({}),
            execute: async () => {
              started.resolve();
              await release.promise;
              return { output: [{ type: "text", text: "held" }] };
            },
          }),
        ],
      }),
    );
    const calls = [
      fauxToolCall("secret", { action: "request", name: "GH_TOKEN", reason: "push to GitHub" }),
      fauxToolCall("hold", {}),
    ];
    const finals: string[] = [];
    route(value.faux, (request) => {
      const call = calls.shift();
      if (call !== undefined) return fauxAssistantMessage([call], { stopReason: "toolUse" });
      finals.push(request.messages.map(textOf).join("\n"));
      return fauxAssistantMessage("done");
    });
    const { harness, root } = await open(value);
    try {
      const run = await root.submit({ type: "input", content: "push" }, context);
      await started.promise;
      const info = await value.vault.set({ name: "GH_TOKEN", kind: "value", value: "gh-value-99" });
      expect(await answerRequests(harness, "GH_TOKEN", info, context)).toBe(1);
      release.resolve();
      await run.wait(context);
      // The run's own last step already heard it.
      expect(finals[0]).toContain("secret GH_TOKEN is set");
    } finally {
      await harness.close(context);
    }
  });
});
