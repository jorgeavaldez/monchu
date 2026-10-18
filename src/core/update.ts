import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseRelease } from "../api/release.ts";

const HELP = `Usage: monchu update [edge | <version>]

Installs a release of the global monchu command with npm: the newest build of main (edge, the default) or a tagged
version such as 1.2.0. Quit Monchu first, or type /update in it instead.`;

/** The package this command runs from: an installed release, or a checkout that `npm link` or a source run points at. */
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

/** How long an install may take before it counts as failed, so a hung npm never keeps Monchu down. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

function packageJson(root: string): { version?: unknown; homepage?: unknown } {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

/** The installed package's version, such as `1.0.0-edge.42.g1a2b3c4` for an edge build. Read once, at startup. */
export const VERSION = String(packageJson(PACKAGE).version);

/** Whether a Monchu holds the home's ownership lock, without creating the lock file. */
function running(home: string): boolean {
  const path = join(home, "owner.sqlite");
  if (!existsSync(path)) return false;
  const owner = new DatabaseSync(path);
  try {
    owner.exec("BEGIN EXCLUSIVE");
    owner.exec("ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    owner.close();
  }
}

/** The GitHub repository the package's homepage names, so a fork updates from itself. */
function repository(root: string): string {
  const { homepage } = packageJson(root);
  const match =
    typeof homepage === "string"
      ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(homepage)
      : null;
  if (match?.[1] === undefined)
    throw new Error(`package.json homepage is not a GitHub repository: ${String(homepage)}`);
  return match[1];
}

/** The release tarball's URL: GitHub's, or `$MONCHU_RELEASES/<tag>/monchu.tgz` from a mirror of them. */
function releaseUrl(root: string, release: string): string {
  const tag = release === "edge" ? "edge" : `v${release}`;
  const mirror = process.env.MONCHU_RELEASES;
  if (mirror) return `${mirror.replace(/\/+$/, "")}/${tag}/monchu.tgz`;
  return `https://github.com/${repository(root)}/releases/download/${tag}/monchu.tgz`;
}

/**
 * The npm prefix a global install of `root` lives under: `<prefix>/lib/node_modules/monchu`, or
 * `<prefix>/node_modules/monchu` on Windows. Installing there replaces the running copy, wherever npm's own prefix is.
 */
function installPrefix(root: string): string {
  const modules = dirname(root);
  if (basename(modules) !== "node_modules")
    throw new Error(`${root} is not a global npm install; update it with npm by hand`);
  const above = dirname(modules);
  return process.platform !== "win32" && basename(above) === "lib" ? dirname(above) : above;
}

/** A checked install: the tarball and the prefix it goes into. */
export type UpdatePlan = { release: string; url: string; prefix: string };

/**
 * Check an update can run before anything stops: a release install, not a checkout, and a tarball that exists. Throws
 * with what is wrong. `root` and `fetch` are the running package and the network, unless a test passes its own.
 */
export async function planUpdate(
  release: string,
  root: string = PACKAGE,
  probe: typeof fetch = fetch,
  url: string = releaseUrl(root, release),
): Promise<UpdatePlan> {
  if (existsSync(join(root, "tsconfig.build.json")))
    throw new Error(
      `monchu runs the checkout at ${root} (npm link or a source run). Update it there: pull, then build.\n` +
        `To switch to a release instead: npm install -g --allow-remote=root ${url}`,
    );
  const prefix = installPrefix(root);
  const response = await probe(url, { method: "HEAD", redirect: "follow" }).catch(
    (error: unknown) => {
      throw new Error(
        `Can't reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  if (!response.ok) throw new Error(`No release ${release} at ${url} (HTTP ${response.status})`);
  return { release, url, prefix };
}

/** Run npm with `args`, passing its output to `output` line by line; resolves with its exit code and last lines. */
function npm(args: readonly string[], output: (line: string) => void): Promise<Installed> {
  // npm is a .cmd script on Windows, which only a shell runs; the URL holds no shell metacharacters and a Windows path
  // no quotes.
  const child =
    process.platform === "win32"
      ? spawn(`npm ${args.map((arg) => `"${arg}"`).join(" ")}`, { shell: true })
      : spawn("npm", args);
  const tail: string[] = [];
  const read = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      output(line);
      tail.push(line);
      if (tail.length > 8) tail.shift();
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
  return new Promise((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "npm could not run", tail: [...tail, error.message] });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, reason: `npm exited ${code ?? 1}`, tail });
    });
  });
}

/** Where a global install under `prefix` puts the package, as npm lays it out on this platform. */
function packageUnder(prefix: string): string {
  return process.platform === "win32"
    ? join(prefix, "node_modules", "monchu")
    : join(prefix, "lib", "node_modules", "monchu");
}

/** How long a new release may take to start in its check before it counts as broken. */
const CHECK_TIMEOUT_MS = 120_000;

/**
 * Start the package at `root` as `monchu serve` in smoke mode (faux models, a scratch home in the temp directory) until
 * its core is ready, then stop it. Nothing of the user's home is read or written. Not ready, the last lines it printed
 * say why.
 */
export async function bootCheck(root: string): Promise<Installed> {
  const home = await mkdtemp(join(tmpdir(), "monchu-smoke-"));
  try {
    const child = spawn(process.execPath, [join(root, "dist", "main.js"), "serve"], {
      env: { ...process.env, MONCHU_DEV_FAUX: "1", MONCHU_DEV_HOME: home, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let output = "";
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
      const settle = (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      };
      const read = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("core ready")) settle(true);
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", (error) => {
        output += `\n${error.message}`;
        settle(false);
      });
      void closed.then(() => settle(false));
    });
    // A signal stops `serve` as Ctrl-C does: its core closes, then it exits.
    child.kill();
    let grace: ReturnType<typeof setTimeout> | undefined;
    const gone = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((done) => (grace = setTimeout(() => done(false), 30_000))),
    ]);
    clearTimeout(grace);
    if (!gone) child.kill("SIGKILL");
    if (ready) return { ok: true };
    return {
      ok: false,
      reason: "the new release did not start",
      // Its error's message, not the stack frames under it.
      tail: output
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/^\s+at /.test(line))
        .slice(-8),
    };
  } finally {
    // A Windows core can still hold its store for a moment; a leftover scratch home is harmless.
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/** An install's result: done, or why not with npm's or the release's last lines. */
export type Installed = { ok: true } | { ok: false; reason: string; tail: string[] };

/**
 * Install a planned release, passing npm's output to `output` line by line. The release is downloaded once, installed
 * into a scratch prefix and started there first (`bootCheck`); only a release that starts replaces the running copy, so
 * a broken build never takes a device down. A timeout counts as a failure. The caller must have closed the core first:
 * npm replaces files under the running process.
 */
export async function install(
  plan: UpdatePlan,
  output: (line: string) => void,
): Promise<Installed> {
  const scratch = await mkdtemp(join(tmpdir(), "monchu-update-"));
  try {
    const tarball = join(scratch, "monchu.tgz");
    try {
      const response = await fetch(plan.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      return {
        ok: false,
        reason: "the download failed",
        tail: [`${plan.url}: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const flags = ["install", "-g", "--no-audit", "--no-fund", "--prefix"];
    const stage = join(scratch, "stage");
    output("installing it aside first, to check it starts");
    const staged = await npm([...flags, stage, tarball], output);
    if (!staged.ok) return staged;
    const checked = await bootCheck(packageUnder(stage));
    if (!checked.ok) return checked;
    output("it starts; installing it");
    return await npm([...flags, plan.prefix, tarball], output);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** The installed version after an install, read fresh from disk. */
export function installedVersion(root: string = PACKAGE): string {
  return String(packageJson(root).version);
}

/**
 * What a successful install changed. It can land on the running build when the release's new tarball was not up yet;
 * saying "updated" there would hide why the update hint stays.
 */
export function installOutcome(before: string, after: string): string {
  return before === after
    ? `warning · no change: the release still served ${after}; try again in a few minutes`
    : `updated · ${before} → ${after}`;
}

/**
 * The commit the `edge` release was built from, when this is an edge build whose commit differs; `undefined` when it is
 * current or not an edge build. A hint only: nothing installs it.
 */
export async function newerEdge(
  version: string = VERSION,
  root: string = PACKAGE,
  probe: typeof fetch = fetch,
): Promise<string | undefined> {
  const installed = /-edge\.\d+\.g([0-9a-f]+)$/.exec(version)?.[1];
  if (installed === undefined) return undefined;
  const response = await probe(
    `https://api.github.com/repos/${repository(root)}/git/ref/tags/edge`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the edge tag`);
  const body: unknown = await response.json();
  const target =
    typeof body === "object" && body !== null && "object" in body ? body.object : undefined;
  const sha =
    typeof target === "object" && target !== null && "sha" in target ? target.sha : undefined;
  if (typeof sha !== "string") throw new Error("GitHub's edge tag has no commit");
  return sha.startsWith(installed) ? undefined : sha.slice(0, installed.length);
}

interface UpdateIo {
  home: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** `monchu update`: replace the installed package with a release. Returns the exit code. */
export async function runUpdate(args: readonly string[], io: UpdateIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(HELP);
    return 0;
  }
  const [text = "edge", ...rest] = args;
  const release = parseRelease(text);
  if (rest.length > 0 || release === undefined) {
    io.error(HELP);
    return 2;
  }
  // npm would replace files under the running process, and its later imports would mix two versions.
  if (running(io.home)) {
    io.error(`Monchu is running on ${io.home}. Type /update in it, or quit it (/quit) first.`);
    return 1;
  }
  let plan: UpdatePlan;
  try {
    plan = await planUpdate(release);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.log(`Installing ${plan.url} into ${plan.prefix}`);
  const installed = await install(plan, io.log);
  if (!installed.ok) {
    io.error(`Update failed: ${installed.reason}; the installed version is unchanged.`);
    for (const line of installed.tail) io.error(line);
    return 1;
  }
  const after = installedVersion();
  io.log(installOutcome(VERSION, after));
  if (after !== VERSION) io.log("Start monchu again.");
  return 0;
}
