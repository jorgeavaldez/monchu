import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Monchu } from "./backend.ts";
import { createDevProvider } from "./models/index.ts";

/**
 * Explicit offline smoke mode. Its home and Pi resources stay in a throwaway temp directory. The faux roles are
 * rewritten each time; a `web.json` beside them is untouched, so the web server can be tried offline too.
 */
export async function openDevMonchu(home: string): Promise<Monchu> {
  await mkdir(join(home, "agent"), { recursive: true });
  const path = join(home, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      front: { provider: "faux", modelId: "front", thinkingLevel: "off" },
      worker: { provider: "faux", modelId: "worker", thinkingLevel: "off" },
      classifier: null,
    }),
  );
  return Monchu.open(home, createDevProvider());
}
