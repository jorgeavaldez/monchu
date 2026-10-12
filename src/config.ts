import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ModelRole = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

export type ClassifierRole = { provider: string; modelId: string };

export type RunSettings = Pick<
  NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>,
  | "theme"
  | "retry"
  | "compaction"
  | "httpIdleTimeoutMs"
  | "shellPath"
  | "shellCommandPrefix"
  | "defaultTools"
  | "steeringMode"
  | "followUpMode"
  | "terminal"
>;

/** Host config from `<home>/config.json`. Credentials live in `<home>/auth.json`. */
export type MonchuConfig = {
  front: ModelRole;
  worker: ModelRole;
  settings: RunSettings;
  /** `null` turns classification off explicitly. */
  classifier: ClassifierRole | null;
  /** Overrides the account ID from Pi's Cloudflare credentials. Not a secret. */
  cloudflareAccountId: string | undefined;
};

const defaults: MonchuConfig = {
  front: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
  worker: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
  classifier: { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef-flash" },
  cloudflareAccountId: undefined,
  settings: {},
};

const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
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
    const names = ["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"];
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

/** A missing file means defaults. Invalid content fails startup instead of guessing. */
export async function loadConfig(home: string): Promise<MonchuConfig> {
  const path = join(home, "config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaults;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) throw new Error("expected a JSON object");
    const known = ["front", "worker", "classifier", "cloudflareAccountId", "settings"];
    const unknown = Object.keys(value).filter((key) => !known.includes(key));
    if (unknown.length) throw new Error(`unknown fields: ${unknown.join(", ")}`);
    const accountId = value.cloudflareAccountId;
    if (
      accountId !== undefined &&
      (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId))
    )
      throw new Error("cloudflareAccountId must be a 32-character hex ID");
    return {
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
