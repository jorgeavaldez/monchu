import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Monchu } from "./backend.ts";
import { createDevProvider } from "./models/index.ts";
import { MemoryStore } from "./secrets/vault.ts";

/**
 * Explicit offline smoke mode. Its home and Pi resources stay in a throwaway temp directory. The faux roles are
 * rewritten each time; plugin and run settings already in `config.json` stay (Clef is off unless they set it), and a `web.json`
 * beside them is untouched, so plugins and the web server can be tried offline too. Secrets stay in memory, so smoke
 * runs need no secret store plugin and leave nothing behind, unless `pluginSecrets` asks for the plugins' store.
 */
export async function openDevMonchu(
  home: string,
  options: { safe?: boolean; pluginSecrets?: boolean } = {},
): Promise<Monchu> {
  await mkdir(join(home, "agent"), { recursive: true });
  const path = join(home, "config.json");
  // Plugin and run settings already there stay; the roles are always the faux ones.
  const kept: { plugins?: object; settings?: object } = {};
  try {
    const config: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof config === "object" && config !== null) {
      if ("plugins" in config && typeof config.plugins === "object" && config.plugins !== null)
        kept.plugins = config.plugins;
      if ("settings" in config && typeof config.settings === "object" && config.settings !== null)
        kept.settings = config.settings;
    }
  } catch {
    // A new or broken smoke home: the defaults.
  }
  await writeFile(
    path,
    JSON.stringify({
      front: { provider: "faux", modelId: "front", thinkingLevel: "off" },
      worker: { provider: "faux", modelId: "worker", thinkingLevel: "off" },
      plugins: { clef: null, ...kept.plugins },
      ...(kept.settings === undefined ? {} : { settings: kept.settings }),
    }),
  );
  return Monchu.open(home, createDevProvider(), {
    ...(options.pluginSecrets === true ? {} : { secretStore: new MemoryStore() }),
    safe: options.safe ?? false,
  });
}
