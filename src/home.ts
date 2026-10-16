import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the home without importing Pi; smoke mode must isolate even SDK import-time paths. `MONCHU_HOME` points
 * Monchu at another home, such as a fresh one to try onboarding; `~/` at its start is the user's home directory.
 */
export async function monchuHome(smoke: boolean): Promise<string> {
  if (!smoke) {
    const configured = process.env.MONCHU_HOME?.trim();
    if (!configured) return join(homedir(), ".monchu");
    return resolve(
      configured === "~" || configured.startsWith("~/") || configured.startsWith(`~${sep}`)
        ? join(homedir(), configured.slice(1))
        : configured,
    );
  }
  const home = process.env.MONCHU_DEV_HOME ?? (await mkdtemp(join(tmpdir(), "monchu-smoke-")));
  if (dirname(resolve(home)) !== resolve(tmpdir()) || !basename(home).startsWith("monchu-smoke-"))
    throw new Error(
      "MONCHU_DEV_HOME must be a monchu-smoke-* directory directly inside the OS temp directory",
    );
  return resolve(home);
}

/** The starter home shipped with Monchu: generic manuals, empty memories, and the runtime `.gitignore`. */
const TEMPLATE = fileURLToPath(new URL("../home-template/", import.meta.url));

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

/**
 * Give a home the starter files it lacks; existing files are never touched. A home that did not exist yet also becomes
 * a jj repository when jj is installed, so its edits can be versioned and synced. Returns what it did, for the user.
 */
export async function seedHome(home: string): Promise<string[]> {
  const existing = await readdir(home).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Home skills load from here; an empty directory spares a missing-path warning.
  await mkdir(join(home, "skills"), { recursive: true });
  const added: string[] = [];
  for (const file of await files(TEMPLATE)) {
    const target = join(home, file);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(join(TEMPLATE, file), target, constants.COPYFILE_EXCL);
      added.push(file.split(sep).join("/"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  if (added.length === 0) return [];
  const notes = [`seeded ${home} · ${added.join(", ")}`];
  if (existing === undefined || existing.length === 0) {
    const repo = await jjInit(home);
    notes.push(
      repo
        ? "home is a new jj repository; push it to a private remote to share it across devices"
        : "jj not found; the home is a plain directory",
    );
  }
  notes.push(
    "make it yours: edit SOUL.md and memories/USER.md, or ask Monchu to use the onboard skill",
  );
  return notes;
}

function jjInit(home: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("jj", ["git", "init"], { cwd: home, stdio: "ignore" });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}
