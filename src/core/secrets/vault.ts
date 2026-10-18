/**
 * Monchu's secrets: values the user typed in a signed-in client, used by name and never shown to a model. Values live
 * in the store a plugin registers (the bundled `fnox` plugin's, unless the user swaps it); Monchu has none of its own.
 * `<home>/secrets/index.json` keeps what may be shown: names, kinds, sites, descriptions and times. Host code: it lives
 * as long as the core.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { SecretStore } from "../../plugin.ts";

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
  /** A store given at construction (tests, the smoke home), which plugins' never replace. */
  private readonly fixed: SecretStore | undefined;
  /** The running build's plugin store. */
  private provided: SecretStore | undefined;
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
    this.fixed = options.store;
    this.audit = options.audit ?? (() => {});
  }

  /** Keep values in a plugin's store from now on (`undefined`: none is loaded). A fixed store stays. */
  useStore(provided: SecretStore | undefined): void {
    if (this.fixed !== undefined || provided === this.provided) return;
    this.provided = provided;
    this.cached = undefined;
  }

  private get store(): SecretStore {
    const store = this.fixed ?? this.provided;
    if (store === undefined)
      throw new Error(
        "No secret store is loaded: a plugin keeps secret values (Monchu bundles fnox); turn one on in plugins.local.json",
      );
    return store;
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
