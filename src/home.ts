import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve the home without importing Pi; smoke mode must isolate even SDK import-time paths. */
export async function monchuHome(smoke: boolean): Promise<string> {
  if (!smoke) return join(homedir(), ".monchu");
  const home = process.env.MONCHU_DEV_HOME ?? (await mkdtemp(join(tmpdir(), "monchu-smoke-")));
  if (dirname(resolve(home)) !== resolve(tmpdir()) || !basename(home).startsWith("monchu-smoke-"))
    throw new Error(
      "MONCHU_DEV_HOME must be a monchu-smoke-* directory directly inside the OS temp directory",
    );
  return resolve(home);
}
