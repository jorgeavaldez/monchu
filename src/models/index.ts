import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { defaultConfig, type ClaudeConfig, type MonchuConfig } from "../config.ts";
import { createClaudeCodeProvider } from "./claude-code.ts";
import { Cloudflare } from "./cloudflare.ts";
import { createCodexProvider } from "./codex.ts";
import { FileCredentials } from "./credentials.ts";

export { createDevProvider } from "./dev.ts";

/**
 * Monchu's public models seam. Providers are code modules using pi-ai's native Provider contract.
 * Add a provider module and register it here; every role uses this same collection and credential store.
 * Only the explicit dev entry point and tests supply a faux provider. No catalogs are fetched or persisted.
 */
export async function openModels(
  home: string,
  devProvider?: Provider,
  claude: ClaudeConfig = { executable: undefined, plan: "pro", longContextExtraUsage: false },
): Promise<Models> {
  const credentials = new FileCredentials(join(home, "auth.json"));
  // Validate existing credentials and initialize a fresh store before opening Durable.
  await credentials.list();
  const models = createModels({ credentials });
  models.setProvider(createCodexProvider());
  models.setProvider(Cloudflare);
  models.setProvider(createClaudeCodeProvider(home, claude));
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
  type: "chat" | "classifier",
): string | undefined {
  const found =
    type === "chat"
      ? models.getModel(role.provider, role.modelId)
      : models.getModelOfType("classifier", role.provider, role.modelId);
  if (found !== undefined) return undefined;
  const label = type === "chat" ? "model" : "classifier model";
  if (models.getProvider(role.provider) === undefined)
    return `Monchu has no configured ${label} ${role.provider}/${role.modelId} (${field}); providers: ${models
      .getProviders()
      .map((provider) => provider.id)
      .join(", ")}`;
  const ids = (
    type === "chat"
      ? models.getModels(role.provider)
      : models.getModelsOfType("classifier", role.provider)
  ).map((model) => model.id);
  return `Monchu has no configured ${label} ${role.provider}/${role.modelId} (${field}); ${role.provider} has ${ids.join(", ") || "none"}`;
}

function problems(models: Models, config: MonchuConfig) {
  return {
    front: roleProblem(models, "front", config.front, "chat"),
    worker: roleProblem(models, "worker", config.worker, "chat"),
    classifier:
      config.classifier === null
        ? undefined
        : roleProblem(models, "classifier", config.classifier, "classifier"),
  };
}

/** Resolve configured roles by their operation type, without requiring credentials or falling back. */
export function resolveRoles(models: Models, config: MonchuConfig): void {
  const found = problems(models, config);
  const first = found.front ?? found.worker ?? found.classifier;
  if (first !== undefined) throw new Error(first);
}

/**
 * At startup a bad role must not keep Monchu from opening: it takes the built-in default (the classifier turns off)
 * and each replacement is returned as a warning, so the user can fix it from inside Monchu.
 */
export function startupRoles(
  models: Models,
  config: MonchuConfig,
): { config: MonchuConfig; warnings: string[] } {
  const found = problems(models, config);
  const defaults = defaultConfig();
  const warnings: string[] = [];
  const next = { ...config };
  if (found.front !== undefined) {
    next.front = defaults.front;
    warnings.push(
      `${found.front}. Using ${defaults.front.provider}/${defaults.front.modelId} until config.json is fixed`,
    );
  }
  if (found.worker !== undefined) {
    next.worker = defaults.worker;
    warnings.push(
      `${found.worker}. Using ${defaults.worker.provider}/${defaults.worker.modelId} until config.json is fixed`,
    );
  }
  if (found.classifier !== undefined) {
    next.classifier = null;
    warnings.push(`${found.classifier}. Routing advice is off until config.json is fixed`);
  }
  return { config: next, warnings };
}
