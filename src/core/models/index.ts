import {
  createModels,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { join } from "node:path";
import { defaultConfig, type ClaudeConfig, type ModelRole, type MonchuConfig } from "../config.ts";
import { OpenCodeGo, OpenCodeZen, OpenRouter } from "./api-key.ts";
import { createClaudeCodeProvider } from "./claude-code.ts";
import { createCodexProvider } from "./codex.ts";
import { FileCredentials } from "./credentials.ts";

export { createDevProvider } from "./dev.ts";

/**
 * Monchu's public models seam. Providers are code modules using pi-ai's native Provider contract.
 * Add a provider module and register it here; every role uses this same collection and credential store.
 * Only the explicit dev entry point and tests supply a faux provider. Catalogs are pi-ai's bundled ones: none are
 * fetched or persisted.
 */
export async function openModels(
  home: string,
  devProvider?: Provider,
  claude: ClaudeConfig = { executable: undefined, plan: "pro", longContextExtraUsage: false },
): Promise<MutableModels> {
  const credentials = new FileCredentials(join(home, "auth.json"));
  // Validate existing credentials and initialize a fresh store before opening Durable.
  await credentials.list();
  const models = createModels({ credentials });
  models.setProvider(createCodexProvider());
  models.setProvider(createClaudeCodeProvider(home, claude));
  models.setProvider(OpenCodeGo);
  models.setProvider(OpenCodeZen);
  models.setProvider(OpenRouter);
  if (devProvider !== undefined)
    models.setProvider(
      devProvider.id === "openai-codex" ? createCodexProvider(devProvider) : devProvider,
    );
  return models;
}

/** What is wrong with a configured role's model, with the valid choices; `undefined` when it resolves. */
function roleProblem(
  models: Models,
  field: string,
  role: { provider: string; modelId: string },
): string | undefined {
  if (models.getModel(role.provider, role.modelId) !== undefined) return undefined;
  if (models.getProvider(role.provider) === undefined)
    return `Monchu has no configured model ${role.provider}/${role.modelId} (${field}); providers: ${models
      .getProviders()
      .map((provider) => provider.id)
      .join(", ")}`;
  const ids = models.getModels(role.provider).map((model) => model.id);
  return `Monchu has no configured model ${role.provider}/${role.modelId} (${field}); ${role.provider} has ${ids.join(", ") || "none"}`;
}

function problems(models: Models, config: MonchuConfig) {
  return {
    front: roleProblem(models, "front", config.front),
    worker: roleProblem(models, "worker", config.worker),
    profiles: Object.entries(config.profiles).flatMap(([name, profile]) => {
      const problem = roleProblem(models, `profiles.${name}`, profile);
      return problem === undefined ? [] : [{ name, problem }];
    }),
  };
}

/** Each chat provider's front and worker defaults, in the order a home without chosen roles tries them. */
const PROVIDER_ROLES: readonly { provider: string; front: ModelRole; worker: ModelRole }[] = [
  { provider: "openai-codex", front: defaultConfig().front, worker: defaultConfig().worker },
  {
    provider: "claude-code",
    front: { provider: "claude-code", modelId: "claude-sonnet-5-5", thinkingLevel: "low" },
    worker: { provider: "claude-code", modelId: "claude-opus-5-5", thinkingLevel: "medium" },
  },
];

/** The chat providers whose defaults a home without chosen roles follows, in the order it tries them. */
export function defaultProviders(): string[] {
  return PROVIDER_ROLES.map((entry) => entry.provider);
}

async function hasAuth(models: Models, provider: string): Promise<boolean> {
  return (await models.checkAuth(provider).catch(() => undefined)) !== undefined;
}

/**
 * The roles Monchu runs with. Roles `config.json` leaves out follow the first chat provider with credentials (Codex
 * when there is none), so logging in to one provider is enough. A role naming an unknown provider or model must not
 * stop Monchu: it keeps `running`'s role (on reload) or that default (at startup), and each
 * replacement comes back as a warning, so the user can fix it from inside Monchu.
 */
export async function configuredRoles(
  models: Models,
  config: MonchuConfig,
  running?: MonchuConfig,
): Promise<{ config: MonchuConfig; warnings: string[] }> {
  let roles = PROVIDER_ROLES[0];
  for (const entry of PROVIDER_ROLES)
    if (await hasAuth(models, entry.provider)) {
      roles = entry;
      break;
    }
  const next = { ...config };
  if (roles !== undefined) {
    if (!config.chosen.front) next.front = roles.front;
    if (!config.chosen.worker) next.worker = roles.worker;
  }
  const found = problems(models, next);
  const warnings: string[] = [...(config.warnings ?? [])];
  const using = (problem: string, role: { provider: string; modelId: string }) =>
    `${problem}. Using ${role.provider}/${role.modelId} until config.json is fixed`;
  for (const field of ["front", "worker"] as const) {
    const problem = found[field];
    const fallback = running?.[field] ?? roles?.[field];
    if (problem === undefined || fallback === undefined) continue;
    next[field] = fallback;
    warnings.push(using(problem, fallback));
  }
  if (found.profiles.length) {
    next.profiles = { ...config.profiles };
    for (const { name, problem } of found.profiles) {
      delete next.profiles[name];
      warnings.push(`${problem}. Profile ${name} is off until config.json is fixed`);
    }
  }
  return { config: next, warnings };
}
