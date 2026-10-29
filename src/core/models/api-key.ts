import { hasApi, type Api, type AnyModel, type Provider } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * OpenCode's gateway takes no tools added mid-conversation, whatever the model behind it supports: a Kimi-style
 * `{ role: "system", tools }` message anywhere but last fails the request with "Invalid request parameters", and a
 * tool declared there is never called. Its models declare every tool up front instead.
 */
function toolsUpFront<T extends AnyModel>(model: T): T {
  if (!hasApi(model, "openai-completions") || model.compat?.supportsMidConvoToolAdditions !== true)
    return model;
  return { ...model, compat: { ...model.compat, supportsMidConvoToolAdditions: false } };
}

function withToolsUpFront<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return {
    ...provider,
    getModels: () => provider.getModels().map(toolsUpFront),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(toolsUpFront),
  };
}

/**
 * pi-ai's API-key providers: bundled catalogs, a stored key from /login, else the environment (`OPENCODE_API_KEY`
 * for both OpenCode plans, `OPENROUTER_API_KEY`).
 */
export const OpenCodeGo = withToolsUpFront(opencodeGoProvider());
export const OpenCodeZen = withToolsUpFront(opencodeProvider());
export const OpenRouter = openrouterProvider();
