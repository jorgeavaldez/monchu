import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HELP = `Usage: monchu update [edge | <version>]

Installs a release of the global monchu command with npm: the newest build of main (edge, the default) or a tagged
version such as 1.2.0. Quit Monchu first; start it again when the install finishes.`;

/** The package this command runs from: an installed release, or a checkout that `npm link` or a source run points at. */
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

interface UpdateIo {
  home: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

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

async function packageJson(): Promise<{ version?: unknown; homepage?: unknown }> {
  const parsed: unknown = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

/** The release tarball's URL; the repository comes from the package's homepage, so a fork updates from itself. */
async function releaseUrl(release: string): Promise<string> {
  const { homepage } = await packageJson();
  if (typeof homepage !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(homepage))
    throw new Error(`package.json homepage is not a GitHub repository: ${String(homepage)}`);
  const tag = release === "edge" ? "edge" : `v${release.replace(/^v/, "")}`;
  return `${homepage}/releases/download/${tag}/monchu.tgz`;
}

function npmInstall(url: string): Promise<number> {
  const args = ["install", "-g", "--allow-remote=root", url];
  // npm is a .cmd script on Windows, which only a shell runs; the URL holds no shell metacharacters.
  const child =
    process.platform === "win32"
      ? spawn(`npm ${args.join(" ")}`, { shell: true, stdio: "inherit" })
      : spawn("npm", args, { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** `monchu update`: replace the installed package with a release. Returns the exit code. */
export async function runUpdate(args: readonly string[], io: UpdateIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(HELP);
    return 0;
  }
  const [release = "edge", ...rest] = args;
  if (rest.length > 0 || !/^(edge|v?\d+\.\d+\.\d+[\w.-]*)$/.test(release)) {
    io.error(HELP);
    return 2;
  }
  // npm would replace files under the running process, and its later imports would mix two versions.
  if (running(io.home)) {
    io.error(`Monchu is running on ${io.home}. Quit it (/quit), then run monchu update again.`);
    return 1;
  }
  const url = await releaseUrl(release);
  if (existsSync(join(PACKAGE, "tsconfig.build.json"))) {
    io.error(
      `monchu runs the checkout at ${PACKAGE} (npm link or a source run). Update it there: pull, then build.\n` +
        `To switch to a release instead: npm install -g --allow-remote=root ${url}`,
    );
    return 1;
  }
  const before = (await packageJson()).version;
  io.log(`Installing ${url}`);
  const code = await npmInstall(url);
  if (code !== 0) {
    io.error(`npm install failed (${code}); the installed version is unchanged.`);
    return code;
  }
  io.log(
    `monchu ${String(before)} → ${String((await packageJson()).version)}. Start monchu again.`,
  );
  return 0;
}
