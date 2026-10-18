import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shortId } from "../src/api/ids.ts";
import { answerRequests, SecretsDoc } from "../src/core/secrets/requests.ts";
import { createSecrets, fillPlaceholders } from "../src/core/secrets/tool.ts";
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
});
