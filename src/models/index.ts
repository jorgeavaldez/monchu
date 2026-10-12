import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { MonchuConfig } from "../config.ts";
import { Cloudflare } from "./cloudflare.ts";
import { createCodexProvider } from "./codex.ts";
import { FileCredentials } from "./credentials.ts";

export { createDevProvider } from "./dev.ts";

/**
 * Monchu's public models seam. Providers are code modules using pi-ai's native Provider contract.
 * Add a provider module and register it here; every role uses this same collection and credential store.
 * Only the explicit dev entry point and tests supply a faux provider. No catalogs are fetched or persisted.
 */
export async function openModels(home: string, devProvider?: Provider): Promise<Models> {
  const credentials = new FileCredentials(join(home, "auth.json"));
  // Validate existing credentials and initialize a fresh store before opening Durable.
  await credentials.list();
  const models = createModels({ credentials });
  models.setProvider(createCodexProvider());
  models.setProvider(Cloudflare);
  if (devProvider !== undefined)
    models.setProvider(
      devProvider.id === "openai-codex" ? createCodexProvider(devProvider) : devProvider,
    );
  return models;
}

/** Resolve configured roles by their operation type, without requiring credentials or falling back. */
export function resolveRoles(models: Models, config: MonchuConfig): void {
  for (const role of [config.front, config.worker]) {
    if (models.getModel(role.provider, role.modelId) === undefined)
      throw new Error(`Monchu has no configured model ${role.provider}/${role.modelId}`);
  }
  if (
    config.classifier !== null &&
    models.getModelOfType("classifier", config.classifier.provider, config.classifier.modelId) ===
      undefined
  )
    throw new Error(
      `Monchu has no configured classifier model ${config.classifier.provider}/${config.classifier.modelId}`,
    );
}
