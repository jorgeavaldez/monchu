/**
 * Monchu's secrets: values the user typed in a signed-in client, used by name and never shown to a model. Values live
 * in fnox under Monchu's own config in `<home>/secrets/` (an age provider with a key Monchu makes for this device), so
 * they never reach the user's shell environment, and fnox never reads the user's own secrets. `index.json` beside it
 * keeps what may be shown: names, kinds, sites, descriptions and times. Host code: it lives as long as the core.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/** Env-var shaped, so a shell command names a secret as `$NAME`. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Longest value accepted: a long token or a key file, not a document. */
const SECRET_MAX_LENGTH = 16_384;
/** Shorter values are not redacted from output: they would hide ordinary text. */
const REDACT_MIN_LENGTH = 4;

export type SecretKind = "value" | "login";

/** What may be shown of a secret: never its value. */
export type SecretInfo = {
  name: string;
  kind: SecretKind;
  /** The origin a login is for; the browser fills it only there. */
  site?: string;
  description?: string;
  setAt: number;
  usedAt?: number;
};

/** What the user enters: a value, or a login's username and password. */
export type SecretInput = { name: string; site?: string; description?: string } & (
  | { kind: "value"; value: string }
  | { kind: "login"; username: string; password: string }
);

/** Where values live: fnox here, or memory in tests. Keys are env-var names. */
export interface SecretStore {
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  readAll(): Promise<Record<string, string>>;
}

/** The environment keys a secret gives: its name, or a login's `_USERNAME` and `_PASSWORD`. */
export function secretKeys(info: Pick<SecretInfo, "name" | "kind">): string[] {
  return info.kind === "login" ? [`${info.name}_USERNAME`, `${info.name}_PASSWORD`] : [info.name];
}

/** A site as its origin, or an error naming what is wrong. */
export function siteOrigin(site: string): string {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new Error(`Not a URL: ${site}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`A site must be http or https: ${site}`);
  return url.origin;
}

/** Thrown messages never carry a value: a failing fnox's own words are kept only with every value removed. */
function quiet(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value !== "") out = out.split(value).join("[secret]");
  const line = out.split(/\r?\n/).find((each) => each.trim() !== "") ?? "";
  return line.trim().slice(0, 200);
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (const [bit, generator] of GENERATOR.entries()) if ((top >>> bit) & 1) check ^= generator;
  }
  return check >>> 0;
}

/** BIP 173 bech32, as age writes its keys. */
function bech32(prefix: string, data: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const expanded = Array.from(Buffer.from(prefix, "ascii"));
  const mod =
    polymod([
      ...expanded.map((code) => code >>> 5),
      0,
      ...expanded.map((code) => code & 31),
      ...words,
      0,
      0,
      0,
      0,
      0,
      0,
    ]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (mod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((word) => BECH32[word] ?? "").join("")}`;
}

/** A new age X25519 identity and its recipient, made with Node alone, so no `age-keygen` is needed. */
export function ageIdentity(): { identity: string; recipient: string } {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.d === undefined || jwk.x === undefined) throw new Error("Could not make an age key");
  return {
    identity: bech32("age-secret-key-", Buffer.from(jwk.d, "base64url")).toUpperCase(),
    recipient: bech32("age", Buffer.from(jwk.x, "base64url")),
  };
}

/** A TOML basic string: JSON's escapes are TOML's. */
const toml = (text: string) => JSON.stringify(text);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * fnox under Monchu's own config: `FNOX_CONFIG_DIR` points at the secrets folder, so fnox's global config is never the
 * user's, and the working directory is that folder, so no project's `fnox.toml` joins in. Values go in on stdin.
 */
export class FnoxStore implements SecretStore {
  private readonly dir: string;
  private readonly config: string;
  constructor(dir: string) {
    this.dir = dir;
    this.config = join(dir, "fnox.toml");
  }

  /** The folder, the device's age key and fnox's config, made on first use; an existing config is used as it is. */
  private async ready(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    if (await exists(this.config)) return;
    const key = join(this.dir, "age.txt");
    const { identity, recipient } = ageIdentity();
    await writeAtomic(
      key,
      `# Monchu's secrets key for this device. Never share or sync it.\n${identity}\n`,
    );
    await writeAtomic(
      this.config,
      [
        "# Monchu's secrets on this device: values are age-encrypted with age.txt beside this file.",
        "# Another fnox provider (1password, keychain, ...) works too: Monchu stores with provider `monchu`.",
        "[providers.monchu]",
        'type = "age"',
        `recipients = [${toml(recipient)}]`,
        `key_file = ${toml(key)}`,
        "",
        "[secrets]",
        "",
      ].join("\n"),
    );
  }

  private run(args: readonly string[], input = ""): Promise<string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && !name.startsWith("FNOX_")) env[name] = value;
    env.FNOX_CONFIG_DIR = this.dir;
    const argv = [
      "--config",
      this.config,
      "--profile",
      "default",
      "--no-daemon",
      "--non-interactive",
      ...args,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("fnox", argv, { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === "ENOENT"
              ? "fnox is not installed or not on PATH here; Monchu keeps secrets with fnox (https://fnox.jdx.dev)"
              : `fnox could not start (${error.code ?? "error"})`,
          ),
        ),
      );
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `fnox ${args[0] ?? ""} failed (exit ${code ?? "signal"}): ${quiet(stderr, [input])}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  async write(key: string, value: string): Promise<void> {
    await this.ready();
    // fnox 1.39 stores no value when `set` also gets a description: descriptions live in Monchu's index.
    await this.run(["set", key, "--provider", "monchu"], value);
  }

  async remove(key: string): Promise<void> {
    if (!(await exists(this.config))) return;
    await this.run(["remove", key]).catch((error: unknown) => {
      // Already gone is what removing wants.
      if (!(error instanceof Error && /not[ _]found/i.test(error.message))) throw error;
    });
  }

  async readAll(): Promise<Record<string, string>> {
    if (!(await exists(this.config))) return {};
    const text = await this.run(["export", "--format", "json"]);
    const parsed: unknown = JSON.parse(text);
    const values: Record<string, string> = {};
    const secrets =
      typeof parsed === "object" && parsed !== null && "secrets" in parsed
        ? parsed.secrets
        : undefined;
    if (typeof secrets === "object" && secrets !== null)
      for (const [key, value] of Object.entries(secrets))
        if (typeof value === "string") values[key] = value;
    return values;
  }
}

/** Values kept in memory only: for tests and smoke homes, never a real home. */
export class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
  async readAll(): Promise<Record<string, string>> {
    return Object.fromEntries(this.values);
  }
}

/** Every stored value by key, longest first, so a value inside another is replaced after it. */
type Known = readonly { key: string; value: string }[];

/** Replaces every stored value in text with `[secret KEY]`. */
export function redact(text: string, known: Known): string {
  let out = text;
  for (const { key, value } of known)
    if (out.includes(value)) out = out.split(value).join(`[secret ${key}]`);
  return out;
}

/**
 * Redacts a stream: text that might be the start of a value waits for the next chunk, so a value split across chunks
 * is still caught. `end` returns what waited.
 */
export class StreamRedactor {
  private held = "";
  private readonly known: Known;
  constructor(known: Known) {
    this.known = known;
  }
  push(chunk: string): string {
    const text = redact(this.held + chunk, this.known);
    let keep = 0;
    for (const { value } of this.known)
      for (let length = Math.min(value.length - 1, text.length); length > keep; length--)
        if (text.endsWith(value.slice(0, length))) {
          keep = length;
          break;
        }
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }
  end(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }
}

const Entry = Type.Object({
  kind: Type.Union([Type.Literal("value"), Type.Literal("login")]),
  setAt: Type.Number(),
  site: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  usedAt: Type.Optional(Type.Number()),
});
type Index = { secrets: Record<string, Static<typeof Entry>> };

/** The index as written; an entry that doesn't parse is left out rather than trusted. */
function readIndex(text: string): Index {
  const parsed: unknown = JSON.parse(text);
  const secrets: Index["secrets"] = {};
  const entries =
    typeof parsed === "object" && parsed !== null && "secrets" in parsed
      ? parsed.secrets
      : undefined;
  if (typeof entries === "object" && entries !== null)
    for (const [name, entry] of Object.entries(entries))
      if (SECRET_NAME.test(name) && Check(Entry, entry)) secrets[name] = { ...entry };
  return { secrets };
}

/** Who uses a secret, for the audit record: never the value. */
type SecretUse = { tool: string; conversation: string };

/**
 * The secrets of one home. Values are read from the store once and kept in memory until a set or delete, for injection
 * and redaction; each use is audited by name.
 */
export class Vault {
  private readonly indexPath: string;
  private readonly store: SecretStore;
  private readonly audit: (body: string, attributes: Record<string, string>) => void;
  private index: Index | undefined;
  private cached: Promise<Record<string, string>> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(secrets: readonly SecretInfo[]) => void>();

  constructor(
    dir: string,
    options: {
      store?: SecretStore;
      audit?: (body: string, attributes: Record<string, string>) => void;
    } = {},
  ) {
    this.indexPath = join(dir, "index.json");
    this.store = options.store ?? new FnoxStore(dir);
    this.audit = options.audit ?? (() => {});
  }

  private async loadIndex(): Promise<Index> {
    if (this.index !== undefined) return this.index;
    const text = await readFile(this.indexPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    this.index = text === undefined ? { secrets: {} } : readIndex(text);
    return this.index;
  }

  private async saveIndex(index: Index): Promise<void> {
    await mkdir(join(this.indexPath, ".."), { recursive: true, mode: 0o700 });
    await writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  /** One change at a time: the store and the index move together. */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.writing.then(change);
    this.writing = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Every secret by name, sorted: never values. */
  async list(): Promise<SecretInfo[]> {
    const index = await this.loadIndex();
    return Object.entries(index.secrets)
      .map(([name, entry]) => ({ name, ...entry }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async info(name: string): Promise<SecretInfo | undefined> {
    const entry = (await this.loadIndex()).secrets[name];
    return entry === undefined ? undefined : { name, ...entry };
  }

  /** Hears the list after each change; returns an unsubscribe function. */
  onChange(listener: (secrets: readonly SecretInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async changed(): Promise<void> {
    const secrets = await this.list();
    for (const listener of this.listeners) listener(secrets);
  }

  /** Stores a secret, replacing one of the same name. Errors never carry the value. */
  set(input: SecretInput): Promise<SecretInfo> {
    if (!SECRET_NAME.test(input.name))
      return Promise.reject(
        new Error("A secret's name is A-Z, 0-9 and _, starting with a letter, at most 64"),
      );
    const values =
      input.kind === "login"
        ? { [`${input.name}_USERNAME`]: input.username, [`${input.name}_PASSWORD`]: input.password }
        : { [input.name]: input.value };
    for (const value of Object.values(values)) {
      if (value === "") return Promise.reject(new Error("A secret can't be empty"));
      if (value.length > SECRET_MAX_LENGTH)
        return Promise.reject(new Error(`A secret is at most ${SECRET_MAX_LENGTH} characters`));
    }
    let site: string | undefined;
    try {
      site = input.site === undefined || input.site === "" ? undefined : siteOrigin(input.site);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.serial(async () => {
      const index = await this.loadIndex();
      const keys = Object.keys(values);
      for (const [other, entry] of Object.entries(index.secrets)) {
        if (other === input.name) continue;
        const taken = secretKeys({ name: other, kind: entry.kind }).find((key) =>
          keys.includes(key),
        );
        if (taken !== undefined)
          throw new Error(`${taken} is already a key of the secret ${other}`);
      }
      const previous = index.secrets[input.name];
      if (previous !== undefined && previous.kind !== input.kind)
        for (const key of secretKeys({ name: input.name, kind: previous.kind }))
          if (!keys.includes(key)) await this.store.remove(key);
      this.cached = undefined;
      for (const [key, value] of Object.entries(values)) await this.store.write(key, value);
      const description = input.description?.trim();
      const entry = {
        kind: input.kind,
        setAt: Date.now(),
        ...(site === undefined ? {} : { site }),
        ...(description === undefined || description === "" ? {} : { description }),
      };
      index.secrets[input.name] = entry;
      await this.saveIndex(index);
      this.audit("secret set", { name: input.name, kind: input.kind });
      await this.changed();
      return { name: input.name, ...entry };
    });
  }

  delete(name: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.loadIndex();
      const entry = index.secrets[name];
      if (entry === undefined) throw new Error(`No secret named ${name}`);
      this.cached = undefined;
      for (const key of secretKeys({ name, kind: entry.kind })) await this.store.remove(key);
      delete index.secrets[name];
      await this.saveIndex(index);
      this.audit("secret deleted", { name });
      await this.changed();
    });
  }

  /** Every stored value by key; one store read until the next change. */
  private async values(): Promise<Record<string, string>> {
    const index = await this.loadIndex();
    if (Object.keys(index.secrets).length === 0) return {};
    const read = (this.cached ??= this.store.readAll());
    try {
      return await read;
    } catch (error) {
      if (this.cached === read) this.cached = undefined;
      throw error;
    }
  }

  /** Stored values to redact, longest first; empty when there are none, without reading the store. */
  async known(): Promise<Known> {
    const values = await this.values();
    return Object.entries(values)
      .filter(([, value]) => value.length >= REDACT_MIN_LENGTH)
      .map(([key, value]) => ({ key, value }))
      .toSorted((a, b) => b.value.length - a.value.length);
  }

  /** The secret a key belongs to: its name, or a login's `_USERNAME`/`_PASSWORD`. */
  async owner(key: string): Promise<SecretInfo | undefined> {
    for (const info of await this.list()) if (secretKeys(info).includes(key)) return info;
    return undefined;
  }

  /**
   * The values of the given keys that are stored, for one use: audited by secret name, and its last use recorded.
   * Unknown keys are left out.
   */
  async resolve(keys: readonly string[], use: SecretUse): Promise<Record<string, string>> {
    // Names come from the index first, so a command naming none (only `$HOME`, say) never reads the store.
    const owners = new Map<string, string>();
    for (const key of new Set(keys)) {
      const owner = await this.owner(key);
      if (owner !== undefined) owners.set(key, owner.name);
    }
    if (owners.size === 0) return {};
    const values = await this.values();
    const found: Record<string, string> = {};
    const used = new Set<string>();
    for (const [key, name] of owners) {
      const value = values[key];
      if (value === undefined)
        throw new Error(
          `${key} is listed but its value is missing from the store: ask the user to set ${name} again`,
        );
      found[key] = value;
      used.add(name);
    }
    if (used.size > 0)
      await this.serial(async () => {
        const index = await this.loadIndex();
        const now = Date.now();
        for (const name of used) {
          const entry = index.secrets[name];
          if (entry !== undefined) entry.usedAt = now;
          this.audit("secret used", { name, tool: use.tool, conversation: use.conversation });
        }
        await this.saveIndex(index);
        await this.changed();
      });
    return found;
  }
}
