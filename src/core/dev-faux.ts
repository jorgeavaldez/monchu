import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Monchu } from "./backend.ts";
import { createDevProvider } from "./models/index.ts";
import { MemoryStore } from "./secrets/vault.ts";

/**
 * Explicit offline smoke mode. Its home and Pi resources stay in a throwaway temp directory. The faux roles are
 * rewritten each time; a `web.json` beside them is untouched, so the web server can be tried offline too. Secrets
 * stay in memory, so smoke runs need no secret store plugin and leave nothing behind.
 */
export async function openDevMonchu(
  home: string,
  options: { safe?: boolean } = {},
): Promise<Monchu> {
  await mkdir(join(home, "agent"), { recursive: true });
  const path = join(home, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      front: { provider: "faux", modelId: "front", thinkingLevel: "off" },
      worker: { provider: "faux", modelId: "worker", thinkingLevel: "off" },
      plugins: { clef: null },
    }),
  );
  return Monchu.open(home, createDevProvider(), {
    secretStore: new MemoryStore(),
    safe: options.safe ?? false,
  });
}
