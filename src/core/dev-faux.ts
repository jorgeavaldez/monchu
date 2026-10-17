import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Monchu } from "./backend.ts";
import { createDevProvider } from "./models/index.ts";

/**
 * Explicit offline smoke mode. Its home and Pi resources stay in a throwaway temp directory. The faux roles are
 * rewritten each time; a `web` section is kept, so the web server can be tried offline too.
 */
export async function openDevMonchu(home: string): Promise<Monchu> {
  await mkdir(join(home, "agent"), { recursive: true });
  const path = join(home, "config.json");
  let web: unknown;
  try {
    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof written === "object" && written !== null && "web" in written) web = written.web;
  } catch {
    // No file yet, or not ours to keep.
  }
  await writeFile(
    path,
    JSON.stringify({
      front: { provider: "faux", modelId: "front", thinkingLevel: "off" },
      worker: { provider: "faux", modelId: "worker", thinkingLevel: "off" },
      classifier: null,
      ...(web === undefined ? {} : { web }),
    }),
  );
  return Monchu.open(home, createDevProvider());
}
