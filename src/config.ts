import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ModelRole = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

export type ClassifierRole = { provider: string; modelId: string };

/** Host settings from `~/.monchu/config.json`. Credentials stay in Pi's auth storage or the environment. */
export type MonchuConfig = {
  front: ModelRole;
  worker: ModelRole;
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
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const thinkingLevel = value.thinkingLevel ?? fallback.thinkingLevel;
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
  if (!isObject(value)) throw new Error("classifier must be an object or null");
  return {
    provider: text(value.provider, "classifier.provider"),
    modelId: text(value.modelId, "classifier.modelId"),
  };
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
  const value: unknown = JSON.parse(raw);
  try {
    if (!isObject(value)) throw new Error("expected a JSON object");
    const known = ["front", "worker", "classifier", "cloudflareAccountId"];
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
    };
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
