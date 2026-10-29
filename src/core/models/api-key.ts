import { hasApi, type Api, type AnyModel, type Model, type Provider } from "@earendil-works/pi-ai";
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

/** A model the provider serves before pi-ai's bundled catalog lists it: its catalog sibling, with what differs. */
interface Newer {
  readonly from: string;
  readonly model: Pick<Model<Api>, "id" | "name" | "cost" | "thinkingLevelMap">;
}

/**
 * Adds models a provider serves that its bundled catalog doesn't list yet, each derived from a listed sibling (same
 * API, endpoint and request quirks). A bundled model of the same id wins, so an entry is dead once pi-ai ships it.
 */
function withNewer<TApi extends Api>(
  provider: Provider<TApi>,
  newer: readonly Newer[],
): Provider<TApi> {
  const add = (models: readonly Model<TApi>[]): Model<TApi>[] =>
    newer.flatMap(({ from, model }) => {
      const sibling = models.find((listed) => listed.id === from);
      if (sibling === undefined || models.some((listed) => listed.id === model.id)) return [];
      return [{ ...sibling, ...model }];
    });
  return {
    ...provider,
    getModels: () => {
      const models = provider.getModels();
      return [...models, ...add(models)];
    },
    getAllModels: () => {
      const all = provider.getAllModels?.() ?? provider.getModels();
      return [...all, ...add(provider.getModels())];
    },
  };
}

/**
 * pi-ai's API-key providers: bundled catalogs, a stored key from /login, else the environment (`OPENCODE_API_KEY`
 * for both OpenCode plans, `OPENROUTER_API_KEY`). OpenCode Go also gets the models it serves that the catalog lacks.
 */
export const OpenCodeGo = withToolsUpFront(
  withNewer(opencodeGoProvider(), [
    {
      from: "kimi-k3",
      model: {
        id: "kimi-k3.1-pro",
        name: "Kimi K3.1 Pro",
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      },
    },
    {
      from: "gemini-4-argon-contributor",
      model: {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
          max: null,
        },
      },
    },
  ]),
);
export const OpenCodeZen = withToolsUpFront(opencodeProvider());
export const OpenRouter = openrouterProvider();
