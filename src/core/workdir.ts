import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export async function resolveDirectory(path: string, base: string): Promise<string> {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const directory = resolve(base, expanded);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  return directory;
}
