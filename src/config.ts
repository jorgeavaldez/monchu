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

export type ClassifierRole = { provider: string; modelId: string };

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
 * One MCP server from `<home>/mcp.json`, in the `mcpServers` shape Pi and other MCP clients use. A server runs a local
 * `command` over stdio or talks to a streamable HTTP `url`. `${NAME}` in `env` and `headers` values expands from the
 * environment Monchu started with, so secrets stay out of the file.
 */
export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** What the server is for; shown in the deferred-tools prompt section. */
  description?: string;
  /** `deferred` (default) keeps the server's tools out of the prompt until `tool_search` loads them. */
  exposure?: McpExposure;
  /** Per-tool overrides of `exposure`, by the server's own tool name. */
  toolExposure?: Record<string, McpExposure>;
  /** `false` leaves the server configured but unused. */
  enabled?: boolean;
};

export type McpExposure = "direct" | "deferred";

/** Host config from `<home>/config.json`. Credentials live in `<home>/auth.json`. */
export type MonchuConfig = {
  front: ModelRole;
  worker: ModelRole;
  settings: RunSettings;
  claude: ClaudeConfig;
  /** `null` turns classification off explicitly. */
  classifier: ClassifierRole | null;
  /** Overrides the account ID from Pi's Cloudflare credentials. Not a secret. */
  cloudflareAccountId: string | undefined;
};

const defaults: MonchuConfig = {
  front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
  worker: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
  classifier: { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef" },
  cloudflareAccountId: undefined,
  settings: {},
  claude: { executable: undefined, plan: "pro", longContextExtraUsage: false },
};

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

function classifierRole(value: unknown): ClassifierRole | null {
  if (value === null) return null;
  if (value === undefined) return defaults.classifier;
  object(value, "classifier", ["provider", "modelId"]);
  return {
    provider: text(value.provider, "classifier.provider"),
    modelId: text(value.modelId, "classifier.modelId"),
  };
}

function object(
  value: unknown,
  field: string,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${field}: unknown fields: ${unknown.join(", ")}`);
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

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    throw new Error(`${field} must be a string array`);
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`${field}.${key} must be a string`);
    map[key] = item;
  }
  return map;
}

function exposure(value: unknown, field: string): McpExposure {
  if (value === "direct" || value === "deferred") return value;
  throw new Error(`${field} must be direct or deferred`);
}

function mcpServer(value: unknown, field: string): McpServerConfig {
  object(value, field, [
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "description",
    "exposure",
    "toolExposure",
    "enabled",
  ]);
  if ((value.command === undefined) === (value.url === undefined))
    throw new Error(`${field} needs exactly one of command or url`);
  const server: McpServerConfig = {};
  for (const key of ["command", "cwd", "url", "description"] as const)
    if (value[key] !== undefined) server[key] = text(value[key], `${field}.${key}`);
  if (server.url !== undefined && !/^https?:\/\//.test(server.url))
    throw new Error(`${field}.url must be an http or https URL`);
  if (value.command === undefined)
    for (const key of ["args", "env", "cwd"] as const)
      if (value[key] !== undefined) throw new Error(`${field}.${key} needs command`);
  if (value.url === undefined && value.headers !== undefined)
    throw new Error(`${field}.headers needs url`);
  if (value.args !== undefined) server.args = strings(value.args, `${field}.args`);
  if (value.env !== undefined) server.env = stringMap(value.env, `${field}.env`);
  if (value.headers !== undefined) server.headers = stringMap(value.headers, `${field}.headers`);
  if (value.exposure !== undefined) server.exposure = exposure(value.exposure, `${field}.exposure`);
  if (value.toolExposure !== undefined) {
    if (!isObject(value.toolExposure)) throw new Error(`${field}.toolExposure must be an object`);
    server.toolExposure = Object.fromEntries(
      Object.entries(value.toolExposure).map(([tool, item]) => [
        tool,
        exposure(item, `${field}.toolExposure.${tool}`),
      ]),
    );
  }
  if (value.enabled !== undefined) server.enabled = boolean(value.enabled, `${field}.enabled`);
  return server;
}

/** `<home>/mcp.json`: `{ "mcpServers": { "<name>": { ... } } }`. Names become tool prefixes such as `ketch_search`. */
function parseMcp(value: unknown, path: string): Record<string, McpServerConfig> {
  try {
    object(value, "mcp.json", ["mcpServers"]);
    if (value.mcpServers === undefined) return {};
    if (!isObject(value.mcpServers)) throw new Error("mcpServers must be an object");
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(value.mcpServers)) {
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(name))
        throw new Error(
          `mcpServers.${name}: names are lowercase letters, digits and hyphens, at most 24`,
        );
      servers[name] = mcpServer(server, `mcpServers.${name}`);
    }
    return servers;
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A missing file means defaults. Invalid content fails startup instead of guessing. */
export async function loadConfig(home: string): Promise<MonchuConfig> {
  const path = join(home, "config.json");
  const raw = await readRaw(path);
  return raw === undefined ? defaults : parseConfig(parseJson(raw, path), path);
}

/** MCP servers from `<home>/mcp.json`, by name; none when it is missing. Invalid content fails like `config.json`. */
export async function loadMcpServers(home: string): Promise<Record<string, McpServerConfig>> {
  const path = join(home, "mcp.json");
  const raw = await readRaw(path);
  return raw === undefined ? {} : parseMcp(parseJson(raw, path), path);
}

/**
 * Save one role's default into `<home>/config.json`, keeping every other field as written. The whole result passes the
 * startup validator and `check` before a temporary file atomically replaces it; an invalid file is never rewritten.
 */
export async function saveRole(
  home: string,
  role: "front" | "worker",
  change: Partial<ModelRole>,
  check: (saved: ModelRole) => void,
): Promise<ModelRole> {
  const path = join(home, "config.json");
  const raw = await readRaw(path);
  const value = raw === undefined ? {} : parseJson(raw, path);
  const current = parseConfig(value, path);
  if (!isObject(value)) throw new Error(`Invalid ${path}: expected a JSON object`);
  const next = { ...value, [role]: { ...current[role], ...change } };
  const saved = parseConfig(next, path)[role];
  check(saved);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(next, null, 2)}
`,
    { flag: "wx" },
  );
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return saved;
}

function parseConfig(value: unknown, path: string): MonchuConfig {
  try {
    if (!isObject(value)) throw new Error("expected a JSON object");
    const known = ["front", "worker", "classifier", "cloudflareAccountId", "settings", "claude"];
    const unknown = Object.keys(value).filter((key) => !known.includes(key));
    if (unknown.length) throw new Error(`unknown fields: ${unknown.join(", ")}`);
    const accountId = value.cloudflareAccountId;
    if (
      accountId !== undefined &&
      (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId))
    )
      throw new Error("cloudflareAccountId must be a 32-character hex ID");
    let claude = defaults.claude;
    if (value.claude !== undefined) {
      object(value.claude, "claude", ["executable", "plan", "longContextExtraUsage"]);
      const plan = value.claude.plan ?? defaults.claude.plan;
      if (plan !== "pro" && plan !== "max") throw new Error("claude.plan must be pro or max");
      claude = {
        executable:
          value.claude.executable === undefined
            ? undefined
            : text(value.claude.executable, "claude.executable"),
        plan,
        longContextExtraUsage:
          value.claude.longContextExtraUsage === undefined
            ? false
            : boolean(value.claude.longContextExtraUsage, "claude.longContextExtraUsage"),
      };
    }
    return {
      claude,
      front: modelRole(value.front, "front", defaults.front),
      worker: modelRole(value.worker, "worker", defaults.worker),
      classifier: classifierRole(value.classifier),
      cloudflareAccountId: accountId,
      settings: runSettings(value.settings),
    };
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
