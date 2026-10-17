import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/** Monchu always uses device-code OAuth, including when tests supply a faux Codex provider. */
export function createCodexProvider(provider: Provider = openaiCodexProvider()): Provider {
  const oauth = provider.auth.oauth;
  if (oauth === undefined) throw new Error("Codex requires OAuth");
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        login: (interaction, options) =>
          oauth.login(
            {
              ...interaction,
              prompt: (prompt) =>
                prompt.type === "select" &&
                prompt.options.some((option) => option.id === "device_code")
                  ? Promise.resolve("device_code")
                  : interaction.prompt(prompt),
            },
            options,
          ),
      },
    },
  };
}
