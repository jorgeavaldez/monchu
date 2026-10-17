import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * pi-ai's API-key providers, unchanged: bundled catalogs, a stored key from /login, else the environment
 * (`OPENCODE_API_KEY` for both OpenCode plans, `OPENROUTER_API_KEY`).
 */
export const OpenCodeGo = opencodeGoProvider();
export const OpenCodeZen = opencodeProvider();
export const OpenRouter = openrouterProvider();
