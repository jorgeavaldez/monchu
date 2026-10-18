import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  install,
  installedVersion,
  installOutcome,
  newerEdge,
  planUpdate,
  runUpdate,
} from "../src/core/update.ts";
import { cleanup, setup } from "./support.ts";

afterEach(cleanup);

async function update(home: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpdate(args, {
    home,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("monchu update", () => {
  it("rejects unknown releases and extra arguments with the usage", async () => {
    const { directory } = await setup();
    const bad = await update(directory, "latest; rm -rf ~");
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/^Usage: monchu update/);
    expect((await update(directory, "edge", "1.0.0")).code).toBe(2);
    const help = await update(directory, "--help");
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^Usage: monchu update/);
  });

  it("refuses while a Monchu holds the home, before touching npm", async () => {
    const { directory } = await setup();
    const owner = new DatabaseSync(join(directory, "owner.sqlite"));
    owner.exec("BEGIN EXCLUSIVE");
    try {
      expect(await update(directory, "1.2.0")).toEqual({
        code: 1,
        out: "",
        err: `Monchu is running on ${directory}. Type /update in it, or quit it (/quit) first.`,
      });
    } finally {
      owner.close();
    }
  });

  it("leaves a checkout alone and names the release to switch to", async () => {
    const { directory } = await setup();
    const result = await update(directory, "v1.2.0");
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^monchu runs the checkout at .+ \(npm link or a source run\)/);
    expect(result.err).toContain(
      "npm install -g --allow-remote=root https://github.com/jorgeavaldez/monchu/releases/download/v1.2.0/monchu.tgz",
    );
  });
});

/** Run npm with arguments, as the update does: through a shell on Windows, where npm is a script. */
function npm(cwd: string, ...args: string[]): Promise<number> {
  const child =
    process.platform === "win32"
      ? spawn(`npm ${args.join(" ")}`, { cwd, shell: true, stdio: "ignore" })
      : spawn("npm", args, { cwd, stdio: "ignore" });
  return new Promise((done) => child.once("close", (code) => done(code ?? 1)));
}

/** A global install's package directory under `prefix`, laid out as npm lays it out on this platform. */
function globalPackage(prefix: string): string {
  return process.platform === "win32"
    ? join(prefix, "node_modules", "monchu")
    : join(prefix, "lib", "node_modules", "monchu");
}

describe("/update's install", () => {
  it("checks the release answers and starts, then installs it into the prefix the running package lives in", async () => {
    const { directory } = await setup();
    // Releases as the build packs them: a package.json and an entry point. A good one serves until it is stopped.
    const manifest = { name: "monchu", version: "9.9.9", homepage: "https://github.com/o/r" };
    const pack = async (name: string, main: string) => {
      const source = join(directory, name);
      await mkdir(join(source, "dist"), { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify(manifest));
      await writeFile(join(source, "dist", "main.js"), main);
      await mkdir(join(directory, "packs", name), { recursive: true });
      expect(await npm(source, "pack", "--pack-destination", join(directory, "packs", name))).toBe(
        0,
      );
      return readFile(join(directory, "packs", name, "monchu-9.9.9.tgz"));
    };
    const tarballs: Record<string, Buffer> = {
      "/good.tgz": await pack(
        "good",
        'console.log("monchu · core ready · pid 1");\nsetInterval(() => {}, 1000);\n',
      ),
      "/broken.tgz": await pack("broken", 'throw new Error("release boom");\n'),
    };
    const server = createServer((request, response) => {
      const tarball = tarballs[request.url ?? ""];
      if (tarball === undefined) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : tarball);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    try {
      // The running copy: an older global install under its own prefix, not npm's.
      const prefix = join(directory, "prefix");
      const running = globalPackage(prefix);
      await mkdir(running, { recursive: true });
      await writeFile(
        join(running, "package.json"),
        JSON.stringify({ ...manifest, version: "1.0.0" }),
      );

      await expect(planUpdate("2.0.0", running, fetch, `${base}/missing.tgz`)).rejects.toThrow(
        "No release 2.0.0 at",
      );
      await expect(planUpdate("edge", directory, fetch, `${base}/good.tgz`)).rejects.toThrow(
        "is not a global npm install",
      );

      // A release that doesn't start is never installed: the running copy stays.
      const broken = await planUpdate("edge", running, fetch, `${base}/broken.tgz`);
      const refused = await install(broken, () => {});
      expect(refused).toMatchObject({ ok: false, reason: "the new release did not start" });
      expect(refused.ok ? "" : refused.tail.join("\n")).toContain("release boom");
      expect(installedVersion(running)).toBe("1.0.0");

      const plan = await planUpdate("edge", running, fetch, `${base}/good.tgz`);
      expect(plan).toEqual({ release: "edge", url: `${base}/good.tgz`, prefix });
      const result = await install(plan, () => {});
      expect(result, JSON.stringify(result)).toEqual({ ok: true });
      expect(installedVersion(running)).toBe("9.9.9");
      expect(installOutcome("1.0.0", installedVersion(running))).toBe("updated · 1.0.0 → 9.9.9");
      expect(await readdir(join(running, ".."))).toEqual(["monchu"]);

      // The release still serving the running build, as when its new tarball is not up yet, is no update.
      expect(installOutcome("9.9.9", installedVersion(running))).toBe(
        "warning · no change: the release still served 9.9.9; try again in a few minutes",
      );
    } finally {
      server.close();
    }
  }, 240_000);

  it("hints at a newer edge build only for an edge build whose commit differs", async () => {
    const root = join(import.meta.dirname, "..");
    const tag =
      (sha: string): typeof fetch =>
      async () =>
        new Response(JSON.stringify({ object: { sha, type: "commit" } }));
    const unreachable: typeof fetch = async () => {
      throw new Error("no network for a release build");
    };
    expect(await newerEdge("1.2.0", root, unreachable)).toBeUndefined();
    expect(await newerEdge("1.0.0-edge.4.gabc1234", root, tag("abc1234def"))).toBeUndefined();
    expect(await newerEdge("1.0.0-edge.4.gabc1234", root, tag("0123456789"))).toBe("0123456");
  });
});
