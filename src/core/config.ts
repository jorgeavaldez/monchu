/*
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TerminalCapabilities } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ModelRole = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

/** A named worker model choice; `use` says what work it is for, which the front and the routing helper read. */
export type WorkerProfile = ModelRole & { use: string };

export type RunSettings = {
  theme?: string;
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxAgentDelayMs?: number;
    provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  };
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  httpIdleTimeoutMs?: number;
  shellPath?: string;
  shellCommandPrefix?: string;
  defaultTools?: string[];
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  terminal?: {
    hyperlinks?: boolean | "auto";
    images?: false | "auto" | "kitty" | "iterm2";
    trueColor?: boolean | "auto";
  };
};

export type Settings = ReturnType<typeof resolveSettings>;

/** Resolve the validated config into one in-memory snapshot; no settings-file I/O. */
export function resolveSettings(settings: RunSettings) {
  let defaultTools: string[] | undefined;
  if (settings.defaultTools !== undefined) {
    const entries = settings.defaultTools;
    defaultTools = entries.some((name) => /^[+-]/.test(name))
      ? ["read", "bash", "edit", "write", "fffind", "ffgrep"]
      : [...entries];
    for (const entry of entries) {
      const name = entry.slice(1);
      const index = defaultTools.indexOf(name);
      if (entry.startsWith("+") && index === -1) defaultTools.push(name);
      if (entry.startsWith("-") && index !== -1) defaultTools.splice(index, 1);
    }
  }
  const terminal = settings.terminal;
  const images = terminal?.images;
  const terminalCapabilities: Partial<TerminalCapabilities> = {
    ...(images === "kitty" || images === "iterm2"
      ? { images }
      : images === false
        ? { images: null }
        : {}),
    ...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
    ...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
  };
  return {
    theme: settings.theme,
    retry: {
      enabled: settings.retry?.enabled ?? true,
      maxRetries: settings.retry?.maxRetries ?? 3,
      baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
      maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60000,
    },
    compaction: {
      enabled: settings.compaction?.enabled ?? true,
      reserveTokens: settings.compaction?.reserveTokens ?? 16384,
      keepRecentTokens: settings.compaction?.keepRecentTokens ?? 20000,
    },
    providerRetry: {
      timeoutMs: settings.retry?.provider?.timeoutMs,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    },
    httpIdleTimeoutMs: settings.httpIdleTimeoutMs ?? 300000,
    shellPath: settings.shellPath,
    shellCommandPrefix: settings.shellCommandPrefix,
    defaultTools,
    steeringMode: settings.steeringMode ?? "one-at-a-time",
    followUpMode: settings.followUpMode ?? "one-at-a-time",
    terminalCapabilities,
  };
}

export type ClaudeConfig = {
  executable: string | undefined;
  plan: "pro" | "max";
  longContextExtraUsage: boolean;
};

/**
 * The web client's server, from `<home>/web.json`: per device, never synced, since each device has its own host, port
 * and login client. Used only with `--web`. It listens on 127.0.0.1 alone; a tunnel on the same host publishes it. Every request needs an identity on `allow`, from an access proxy's signed JWT or this
 * server's own OIDC login; with neither configured, `--web` refuses to start.
 */
export type WebConfig = {
  port: number;
  /** The public host a tunnel serves it on; requests for any other host than it and localhost are refused. */
  host: string | undefined;
  /** An identity-aware proxy that signs each request (`Cf-Access-Jwt-Assertion`), checked against its keys. */
  access:
    | {
        /** Its issuer, such as `https://<team>.cloudflareaccess.com`; keys come from `/cdn-cgi/access/certs`. */
        teamDomain: string;
        audience: string;
        /** The claim naming the user, as a dotted path (for example `custom.sub` for the upstream identity provider's). */
        subjectClaim: string;
      }
    | undefined;
  /** This server's own login: OpenID Connect authorization code with PKCE. */
  oidc:
    | {
        issuer: string;
        clientId: string;
        /** The environment variable holding a client secret, for providers that require one. */
        clientSecretEnv: string | undefined;
        scopes: string[];
        subjectClaim: string;
      }
    | undefined;
  /** Who may use it: `sub:<subject>`, `email:<address>`, or `service:<client id>` for a proxy's service token. */
  allow: string[];
};

/** Host config from `<home>/config.json`. Credentials live in `<home>/auth.json`. */
export type MonchuConfig = {
  front: ModelRole;
  worker: ModelRole;
  /** Named worker model choices for `start_worker` and `message_worker`, by name. */
  profiles: Record<string, WorkerProfile>;
  settings: RunSettings;
  claude: ClaudeConfig;
  /** Each plugin's own settings, by plugin name, as written; the plugin validates its own. */
  plugins: Record<string, JsonValue>;
  /** What reading the file noticed that the user should fix, such as a setting that moved. */
  warnings?: string[];
  /** Roles `config.json` sets. The others follow the provider the user has logged in to. */
  chosen: { front: boolean; worker: boolean };
};

const defaults: MonchuConfig = {
  front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
  worker: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
  profiles: {},
  plugins: {},
  settings: {},
  claude: { executable: undefined, plan: "pro", longContextExtraUsage: false },
  chosen: { front: false, worker: false },
};

/** The built-in defaults, used for any field `config.json` leaves out. */
export function defaultConfig(): MonchuConfig {
  return defaults;
}

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return thinkingLevels.some((level) => level === value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a string`);
  return value;
}

function modelRole(value: unknown, field: string, fallback: ModelRole): ModelRole {
  if (value === undefined) return fallback;
  object(value, field, ["provider", "modelId", "thinkingLevel"]);
  const thinkingLevel =
    value.thinkingLevel === undefined ? fallback.thinkingLevel : value.thinkingLevel;
  if (!isThinkingLevel(thinkingLevel))
    throw new Error(`${field}.thinkingLevel must be one of ${thinkingLevels.join(", ")}`);
  return {
    provider: text(value.provider, `${field}.provider`),
    modelId: text(value.modelId, `${field}.modelId`),
    thinkingLevel,
  };
}

function profiles(value: unknown, worker: ModelRole): Record<string, WorkerProfile> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error("profiles must be an object");
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(name))
        throw new Error(`profiles.${name}: names are lowercase letters, digits, and dashes`);
      const field = `profiles.${name}`;
      object(item, field, ["provider", "modelId", "thinkingLevel", "use"]);
      const { use, ...role } = item;
      return [name, { ...modelRole(role, field, worker), use: text(use, `${field}.use`) }];
    }),
  );
}

/**
 * A top-level `classifier` became the classifier plugin's `plugins.classifier`: an old file keeps working, read there unless `plugins.classifier` is
 * set too, with a warning to move it.
 */
function movedClassifier(
  value: unknown,
  plugins: Record<string, JsonValue>,
): { plugins: Record<string, JsonValue>; warnings?: string[] } {
  if (value === undefined) return { plugins };
  if (!isJsonValue(value)) throw new Error("classifier must be JSON");
  const set = Object.hasOwn(plugins, "classifier");
  return {
    plugins: set ? plugins : { ...plugins, classifier: value },
    warnings: [
      set
        ? '"classifier" in config.json is ignored: "plugins": { "classifier": ... } sets it. Remove it'
        : '"classifier" in config.json is now "plugins": { "classifier": ... }; it still works there for now. Move it',
    ],
  };
}

function pluginSettings(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (!isObject(value) || !isJsonValue(value)) throw new Error("plugins must be a JSON object");
  for (const name of Object.keys(value))
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name))
      throw new Error(`plugins.${name}: a plugin's name is lowercase letters, digits and dashes`);
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) => (isJsonValue(item) ? [[name, item]] : [])),
  );
}

function object(
  value: unknown,
  field: string,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length === 0) return;
  if (ignoring === undefined) throw new Error(`${field}: unknown fields: ${unknown.join(", ")}`);
  for (const key of unknown) ignoring.add(`${field}.${key}`);
}

function integer(value: unknown, field: string, min = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > 2147483647
  )
    throw new Error(`${field} must be an integer between ${min} and 2147483647`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function queue(value: unknown, field: string): "all" | "one-at-a-time" | undefined {
  if (value === undefined || value === "all" || value === "one-at-a-time") return value;
  throw new Error(`${field} must be all or one-at-a-time`);
}

function url(value: unknown, field: string): string {
  const raw = text(value, field);
  // Plain http only for an identity provider on this machine.
  const parsed = URL.canParse(raw) ? new URL(raw) : undefined;
  const loopback = parsed?.hostname === "127.0.0.1" || parsed?.hostname === "localhost";
  if (
    parsed === undefined ||
    !(parsed.protocol === "https:" || (loopback && parsed.protocol === "http:"))
  )
    throw new Error(`${field} must be an https URL`);
  return raw.replace(/\/+$/, "");
}

function webConfig(value: unknown): WebConfig {
  object(value, "web", ["port", "host", "access", "oidc", "allow"]);
  let access: WebConfig["access"];
  if (value.access !== undefined) {
    object(value.access, "web.access", ["teamDomain", "audience", "subjectClaim"]);
    access = {
      teamDomain: url(value.access.teamDomain, "web.access.teamDomain"),
      audience: text(value.access.audience, "web.access.audience"),
      subjectClaim:
        value.access.subjectClaim === undefined
          ? "sub"
          : text(value.access.subjectClaim, "web.access.subjectClaim"),
    };
  }
  let oidc: WebConfig["oidc"];
  if (value.oidc !== undefined) {
    object(value.oidc, "web.oidc", [
      "issuer",
      "clientId",
      "clientSecretEnv",
      "scopes",
      "subjectClaim",
    ]);
    const scopes = value.oidc.scopes ?? ["openid", "profile", "email"];
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string"))
      throw new Error("web.oidc.scopes must be a list of strings");
    if (!scopes.includes("openid")) throw new Error("web.oidc.scopes must include openid");
    oidc = {
      issuer: url(value.oidc.issuer, "web.oidc.issuer"),
      clientId: text(value.oidc.clientId, "web.oidc.clientId"),
      clientSecretEnv:
        value.oidc.clientSecretEnv === undefined
          ? undefined
          : text(value.oidc.clientSecretEnv, "web.oidc.clientSecretEnv"),
      scopes,
      subjectClaim:
        value.oidc.subjectClaim === undefined
          ? "sub"
          : text(value.oidc.subjectClaim, "web.oidc.subjectClaim"),
    };
  }
  const listed: unknown = value.allow ?? [];
  const allow: string[] = [];
  if (Array.isArray(listed))
    for (const item of listed) {
      const entry: unknown = item;
      if (typeof entry === "string" && /^(sub|email|service):.+$/.test(entry)) allow.push(entry);
    }
  if (!Array.isArray(listed) || allow.length !== listed.length)
    throw new Error("web.allow must list sub:<subject>, email:<address> or service:<client id>");
  const host = value.host === undefined ? undefined : text(value.host, "web.host");
  if (host !== undefined && !/^[a-z0-9.-]+(:\d+)?$/i.test(host))
    throw new Error("web.host must be a host name, without a scheme or path");
  return {
    port: value.port === undefined ? 7420 : integer(value.port, "web.port", 1),
    host,
    access,
    oidc,
    allow,
  };
}

function runSettings(value: unknown): RunSettings {
  if (value === undefined) return {};
  object(value, "settings", [
    "theme",
    "retry",
    "compaction",
    "httpIdleTimeoutMs",
    "shellPath",
    "shellCommandPrefix",
    "defaultTools",
    "steeringMode",
    "followUpMode",
    "terminal",
  ]);
  const settings: RunSettings = {};
  for (const key of ["theme", "shellPath", "shellCommandPrefix"] as const)
    if (value[key] !== undefined) settings[key] = text(value[key], `settings.${key}`);
  if (
    settings.theme !== undefined &&
    !["system", "light", "dark", "light/dark", "dark/light"].includes(settings.theme)
  )
    throw new Error("settings.theme must use built-in light/dark themes or system");
  if (value.httpIdleTimeoutMs !== undefined)
    settings.httpIdleTimeoutMs = integer(value.httpIdleTimeoutMs, "settings.httpIdleTimeoutMs");
  for (const key of ["steeringMode", "followUpMode"] as const) {
    const mode = queue(value[key], `settings.${key}`);
    if (mode !== undefined) settings[key] = mode;
  }
  if (value.defaultTools !== undefined) {
    if (
      !Array.isArray(value.defaultTools) ||
      !value.defaultTools.every((item): item is string => typeof item === "string")
    )
      throw new Error("settings.defaultTools must be a string array");
    const modified = value.defaultTools.filter((name) => /^[+-]/.test(name));
    if (modified.length !== 0 && modified.length !== value.defaultTools.length)
      throw new Error("settings.defaultTools must not mix names with +/- modifiers");
    const names = ["read", "write", "edit", "bash", "fffind", "ffgrep", "powershell"];
    if (value.defaultTools.some((name) => !names.includes(name.replace(/^[+-]/, ""))))
      throw new Error("settings.defaultTools contains an unknown built-in");
    settings.defaultTools = value.defaultTools;
  }
  if (value.compaction !== undefined) {
    object(value.compaction, "settings.compaction", [
      "enabled",
      "reserveTokens",
      "keepRecentTokens",
    ]);
    settings.compaction = {};
    if (value.compaction.enabled !== undefined)
      settings.compaction.enabled = boolean(
        value.compaction.enabled,
        "settings.compaction.enabled",
      );
    for (const key of ["reserveTokens", "keepRecentTokens"] as const)
      if (value.compaction[key] !== undefined)
        settings.compaction[key] = integer(value.compaction[key], `settings.compaction.${key}`, 1);
  }
  if (value.retry !== undefined) {
    object(value.retry, "settings.retry", [
      "enabled",
      "maxRetries",
      "baseDelayMs",
      "maxAgentDelayMs",
      "provider",
    ]);
    settings.retry = {};
    if (value.retry.enabled !== undefined)
      settings.retry.enabled = boolean(value.retry.enabled, "settings.retry.enabled");
    for (const key of ["maxRetries", "baseDelayMs", "maxAgentDelayMs"] as const)
      if (value.retry[key] !== undefined)
        settings.retry[key] = integer(value.retry[key], `settings.retry.${key}`);
    if (value.retry.provider !== undefined) {
      object(value.retry.provider, "settings.retry.provider", [
        "timeoutMs",
        "maxRetries",
        "maxRetryDelayMs",
      ]);
      settings.retry.provider = {};
      for (const key of ["timeoutMs", "maxRetries", "maxRetryDelayMs"] as const)
        if (value.retry.provider[key] !== undefined)
          settings.retry.provider[key] = integer(
            value.retry.provider[key],
            `settings.retry.provider.${key}`,
            key === "timeoutMs" ? 1 : 0,
          );
    }
  }
  if (value.terminal !== undefined) {
    object(value.terminal, "settings.terminal", ["hyperlinks", "images", "trueColor"]);
    const { hyperlinks, images, trueColor } = value.terminal;
    if (hyperlinks !== undefined && hyperlinks !== "auto" && typeof hyperlinks !== "boolean")
      throw new Error("settings.terminal.hyperlinks must be boolean or auto");
    if (trueColor !== undefined && trueColor !== "auto" && typeof trueColor !== "boolean")
      throw new Error("settings.terminal.trueColor must be boolean or auto");
    if (
      images !== undefined &&
      images !== false &&
      images !== "auto" &&
      images !== "kitty" &&
      images !== "iterm2"
    )
      throw new Error("settings.terminal.images must be false, auto, kitty or iterm2");
    settings.terminal = {
      ...(hyperlinks === undefined ? {} : { hyperlinks }),
      ...(images === undefined ? {} : { images }),
      ...(trueColor === undefined ? {} : { trueColor }),
    };
  }
  return settings;
}

/** The file's text, or `undefined` when it does not exist. */
async function readRaw(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** This device's web server settings from `<home>/web.json`; `undefined` when it has none. */
export async function loadWebConfig(home: string): Promise<WebConfig | undefined> {
  const path = join(home, "web.json");
  const raw = await readRaw(path);
  if (raw === undefined) return undefined;
  try {
    return webConfig(parseJson(raw, path));
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A missing file means defaults. An invalid field throws, so a reload refuses it and keeps what runs; unknown keys are
 * ignored with a warning.
 */
export async function loadConfig(home: string): Promise<MonchuConfig> {
  const path = join(home, "config.json");
  const raw = await readRaw(path);
  return raw === undefined ? defaults : parseConfig(parseJson(raw, path), path);
}

/**
 * `config.json` as Monchu opens with it, which never throws: a field that is invalid keeps its default and the rest of
 * the file applies; a file that can't be read or isn't JSON means the defaults. Each says why in `warnings`.
 */
export async function loadStartupConfig(home: string): Promise<MonchuConfig> {
  const path = join(home, "config.json");
  try {
    const raw = await readRaw(path);
    return raw === undefined ? defaults : parseConfig(parseJson(raw, path), path, true);
  } catch (error) {
    return {
      ...defaults,
      warnings: [
        `${error instanceof Error ? error.message : String(error)}. Using the built-in defaults until it is fixed`,
      ],
    };
  }
}

/**
 * Save one role's default into `<home>/config.json`, keeping every other field as written. A role missing from the file starts from `effective`, the one in use. The whole result passes the
 * startup validator and `check` before a temporary file atomically replaces it; an invalid file is never rewritten.
 */
export async function saveRole(
  home: string,
  role: "front" | "worker",
  change: Partial<ModelRole>,
  check: (saved: ModelRole) => void,
  effective: ModelRole,
): Promise<ModelRole> {
  const path = join(home, "config.json");
  const raw = await readRaw(path);
  const value = raw === undefined ? {} : parseJson(raw, path);
  const current = parseConfig(value, path);
  if (!isObject(value)) throw new Error(`Invalid ${path}: expected a JSON object`);
  // A role the file leaves out starts from the one in use, which may follow the logged-in provider.
  const base = current.chosen[role] ? current[role] : effective;
  const next = { ...value, [role]: { ...base, ...change } };
  const saved = parseConfig(next, path)[role];
  check(saved);
  await replaceFile(path, next);
  return saved;
}

/**
 * Save a plugin's settings as `plugins.<name>` in `<home>/config.json` (`undefined` removes them), keeping every other
 * field as written. As `saveRole`, the result passes the startup validator first and an invalid file is never rewritten.
 */
export async function savePluginSettings(
  home: string,
  name: string,
  settings: JsonValue | undefined,
): Promise<void> {
  const path = join(home, "config.json");
  const raw = await readRaw(path);
  const value = raw === undefined ? {} : parseJson(raw, path);
  parseConfig(value, path);
  if (!isObject(value)) throw new Error(`Invalid ${path}: expected a JSON object`);
  const plugins = isObject(value.plugins) ? { ...value.plugins } : {};
  if (settings === undefined) delete plugins[name];
  else plugins[name] = settings;
  const next: Record<string, unknown> = { ...value, plugins };
  if (Object.keys(plugins).length === 0) delete next.plugins;
  parseConfig(next, path);
  await replaceFile(path, next);
}

/** Atomically replace `path` with `value` as formatted JSON. */
export async function replaceFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(value, null, 2)}
`,
    { flag: "wx" },
  );
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Keys `config.json` has that this version doesn't know, collected while `parseConfig` runs: a file another version
 * of Monchu wrote, one with a setting that moved, or a typo. They are ignored with a warning, never an error, so a
 * change to the file's shape can't stop any device from reading it.
 */
let ignoring: Set<string> | undefined;

/** `claude`: settings the Claude Code host reads at startup. */
function claudeConfig(value: unknown): ClaudeConfig {
  if (value === undefined) return defaults.claude;
  object(value, "claude", ["executable", "plan", "longContextExtraUsage"]);
  const plan = value.plan ?? defaults.claude.plan;
  if (plan !== "pro" && plan !== "max") throw new Error("claude.plan must be pro or max");
  return {
    executable:
      value.executable === undefined ? undefined : text(value.executable, "claude.executable"),
    plan,
    longContextExtraUsage:
      value.longContextExtraUsage === undefined
        ? false
        : boolean(value.longContextExtraUsage, "claude.longContextExtraUsage"),
  };
}

/**
 * Read `config.json`'s value. Unknown keys are ignored with a warning. An invalid field throws, unless `fallback`: then
 * it keeps its default with a warning, and the rest of the file still applies, as at startup.
 */
function parseConfig(value: unknown, path: string, fallback = false): MonchuConfig {
  if (!isObject(value)) {
    if (!fallback) throw new Error(`Invalid ${path}: expected a JSON object`);
    return {
      ...defaults,
      warnings: [
        `Invalid ${path}: expected a JSON object. Using the built-in defaults until it is fixed`,
      ],
    };
  }
  const invalid: string[] = [];
  /** One field of the file: its default when it is invalid. */
  const field = <T>(parse: () => T, otherwise: T): { value: T; valid: boolean } => {
    try {
      return { value: parse(), valid: true };
    } catch (error) {
      invalid.push(error instanceof Error ? error.message : String(error));
      return { value: otherwise, valid: false };
    }
  };
  const known = ["front", "worker", "profiles", "plugins", "classifier", "settings", "claude"];
  const warnings: string[] = [];
  if ("web" in value)
    warnings.push(`${path}: "web" is ignored: web settings are per device now, in web.json`);
  ignoring = new Set(Object.keys(value).filter((key) => key !== "web" && !known.includes(key)));
  try {
    const claude = field(() => claudeConfig(value.claude), defaults.claude);
    const worker = field(() => modelRole(value.worker, "worker", defaults.worker), defaults.worker);
    const front = field(() => modelRole(value.front, "front", defaults.front), defaults.front);
    const workerProfiles = field(() => profiles(value.profiles, worker.value), {});
    const plugins = field(() => movedClassifier(value.classifier, pluginSettings(value.plugins)), {
      plugins: {},
    });
    const settings = field(() => runSettings(value.settings), {});
    if (invalid.length > 0 && !fallback) throw new Error(`Invalid ${path}: ${invalid.join("; ")}`);
    for (const problem of invalid)
      warnings.push(`Invalid ${path}: ${problem}. Using its default until it is fixed`);
    if (ignoring.size > 0)
      warnings.push(
        `${path}: ignored ${[...ignoring].map((key) => `"${key}"`).join(", ")}, which this version of Monchu doesn't know`,
      );
    warnings.push(...(plugins.value.warnings ?? []));
    return {
      claude: claude.value,
      front: front.value,
      worker: worker.value,
      profiles: workerProfiles.value,
      plugins: plugins.value.plugins,
      settings: settings.value,
      chosen: {
        front: value.front !== undefined && front.valid,
        worker: value.worker !== undefined && worker.valid,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    ignoring = undefined;
  }
}
