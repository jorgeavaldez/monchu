import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** The release tarball's URL. */
function releaseUrl(root: string, release: string): string {
  const tag = release === "edge" ? "edge" : `v${release}`;
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

/**
 * Install a planned release with npm, passing its output to `output` line by line. Resolves with npm's exit code and
 * the last lines it printed; a timeout counts as a failure. The caller must have closed the core first: npm replaces
 * files under the running process.
 */
export function install(
  plan: UpdatePlan,
  output: (line: string) => void,
): Promise<{ code: number; tail: string[] }> {
  const args = [
    "install",
    "-g",
    "--allow-remote=root",
    "--no-audit",
    "--no-fund",
    "--prefix",
    plan.prefix,
    plan.url,
  ];
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
      resolve({ code: 1, tail: [...tail, error.message] });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, tail });
    });
  });
}

/** The installed version after an install, read fresh from disk. */
export function installedVersion(root: string = PACKAGE): string {
  return String(packageJson(root).version);
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
  const { code } = await install(plan, io.log);
  if (code !== 0) {
    io.error(`npm install failed (${code}); the installed version is unchanged.`);
    return code;
  }
  io.log(`monchu ${VERSION} → ${installedVersion()}. Start monchu again.`);
  return 0;
}
