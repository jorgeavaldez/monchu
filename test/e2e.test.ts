/**
 * End to end: Monchu's real entry point (`serve`, which forks the core) on a smoke home with faux models, reached as
 * every client reaches it, over the home's socket, and in a real terminal. Each step drives a surface through the real
 * front, so the wiring between server, core, facets, plugin loader and tools is what passes or fails: every core tool,
 * the bundled jj, Clef, herdr, browser and fnox plugins, a home plugin's direct and deferred tools, section, guard and command, an MCP
 * server, workers, jobs, secrets, roots, `/reload` and `/restart`, and the terminal. CI runs it on this checkout and on
 * the installed release tarball (`MONCHU_E2E_ENTRY`). A new surface, tool or plugin gets a step here.
 */
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobEvent, RootClient } from "../src/api/client.ts";
import type { RemoteClient } from "../src/api/remote.ts";
import { Monchu } from "../src/core/backend.ts";
import { attachSocket, socketPath } from "../src/server/socket.ts";
import {
  cleanup,
  entryProcess,
  fixtureServer,
  front,
  runEntry,
  smokeHome,
  textOf,
  waitFor,
  type EntryRun,
} from "./support.ts";

/** A home plugin with every kind of thing a plugin adds; `version` tells its copies apart across a reload. */
const probe = (version: string) => `import { defineTool, Type } from "monchu/plugin";
const reply = (text) => ({ content: [{ type: "text", text }] });
export default (monchu) => {
  monchu.registerTool(defineTool({
    name: "probe_direct", label: "Probe", description: "e2e probe tool", exposure: "direct", replay: "safe",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params, _signal, _update, ctx) => {
      ctx.ui.notify("probe notified " + params.text);
      return reply("probe ${version}: " + params.text);
    },
  }));
  monchu.registerTool(defineTool({
    name: "probe_deferred", label: "Probe later", description: "e2e deferred probe tool", replay: "safe",
    parameters: Type.Object({}),
    namespace: { description: "e2e probe group", instructions: "probe guide: be gentle" },
    execute: async () => reply("deferred probe ran"),
  }));
  monchu.registerSection("marker", () => "probe section ${version}");
  monchu.on("tool_call", (event) =>
    event.toolName === "bash" && String(event.input.command).includes("forbidden")
      ? { block: true, reason: "probe blocks forbidden commands" }
      : undefined,
  );
  monchu.registerCommand("probe", {
    description: "e2e probe command",
    handler: async (args, ctx) => ctx.ui.notify("probe command " + args + " by " + ctx.caller),
  });
};
`;

type Served = {
  home: string;
  /** The root the suite talks to: the first one, whichever root is current later. */
  root: RootClient;
  server: EntryRun;
  client: RemoteClient;
  close: () => Promise<void>;
  /** Every message of the current root's view, oldest first. */
  messages: () => Message[];
  /** Every line the root's clients were notified of (plugins' and Clef's notices). */
  notices: string[];
  /** What the client was told about its connection and the core. */
  reports: string[];
  jobEvents: JobEvent[];
};

let monchu: Served;
let sent = 0;

async function open(env: Record<string, string> = {}): Promise<Served> {
  const home = await smokeHome({ probe: probe("v1") });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: { clef: { provider: "faux", modelId: "clef", waitMs: 5000 } } }),
  );
  const { script, marker } = await fixtureServer(home);
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [script, marker] } },
    }),
  );
  await mkdir(join(home, "work"));
  const server = runEntry(home, ["serve"], "core ready", { env });
  await server.seen;
  const reports: string[] = [];
  const attached = await attachSocket(socketPath(home), (error) => reports.push(error.message));
  if (attached === undefined) throw new Error(`Nothing answers:\n${server.output()}`);
  const { client } = attached;
  client.onReport((report) => reports.push(report));
  const root = await front(client);
  const view = await root.viewState();
  const notices: string[] = [];
  await root.watchNotices((items) => {
    for (const item of items) if (!notices.includes(item.text)) notices.push(item.text);
  });
  const jobEvents: JobEvent[] = [];
  await client.watchJobEvents(0, (events) => jobEvents.push(...events));
  return {
    home,
    root,
    server,
    client,
    reports,
    notices,
    jobEvents,
    messages: () => view.value.entries.flatMap((entry) => entry.model ?? []),
    close: async () => {
      view.dispose();
      await attached.close();
      const stopped = await runEntry(home, ["stop"]).exited;
      expect(stopped.output).toContain("stopped the Monchu of");
      expect((await server.exited).code).toBe(0);
    },
  };
}

const texts = () => monchu.messages().map(textOf);
const count = (text: string) => texts().filter((each) => each.startsWith(text)).length;

/** Send the current front `text` as the user, and wait for a reply that starts with `reply`. */
async function ask(text: string, reply = `Faux reply: ${text}.`): Promise<string> {
  const before = count(reply);
  await monchu.root.submit(text, `e2e:${++sent}`, "followUp");
  await waitFor(() => count(reply) > before, 30_000);
  return texts().findLast((each) => each.startsWith(reply)) ?? "";
}

const results = (tool: string) =>
  monchu
    .messages()
    .filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === tool,
    );

/** Have the front call `tool` with `args`, as a model does, and return its result once the front answered it. */
async function call(tool: string, args: object): Promise<{ text: string; isError: boolean }> {
  const before = results(tool).length;
  await ask(`call ${tool} ${JSON.stringify(args)}`, "Faux tool finished.");
  await waitFor(() => results(tool).length > before);
  const result = results(tool).at(-1);
  return { text: textOf(result), isError: result?.isError ?? false };
}

async function ok(tool: string, args: object): Promise<string> {
  const result = await call(tool, args);
  expect(result.isError, `${tool}: ${result.text}`).toBe(false);
  return result.text;
}

/** What the front's model was given: its tools and prompt section names. */
async function prompt() {
  const [tools = "", sections = ""] = (await ask("prompt", "Faux prompt")).split("\n");
  return {
    tools: tools.replace("Faux prompt · tools: ", "").split(" "),
    sections: sections.replace("sections: ", "").split(" "),
  };
}

/** The text of the prompt section `name` the front's model was last given. */
const section = (name: string) => ask(`section ${name}`, `Faux section ${name}:`);

const installed = (command: string) => spawnSync(command, ["--version"]).status === 0;

describe("Monchu end to end", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    monchu = await open();
  }, 240_000);

  afterAll(async () => {
    try {
      await monchu?.close();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("gives the front every core tool, the bundled plugins' and a home plugin's direct tools and section", async () => {
    const { tools, sections } = await prompt();
    for (const tool of [
      "read",
      "write",
      "edit",
      "bash",
      "fffind",
      "ffgrep",
      "codemode",
      "tool_search",
      "start_worker",
      "message_worker",
      "worker_status",
      "stop_worker",
      "close_workers",
      "reopen_worker",
      "update_goal",
      "list_goals",
      "memory",
      "job",
      "secret",
      "reload_extensions",
      "request_restart",
      "list_roots",
      "message_root",
      "hand_off_worker",
      "herdr",
      "jj",
      "jj_write",
      "probe_direct",
    ])
      expect(tools).toContain(tool);
    expect(tools).not.toContain("probe_deferred");
    expect(sections).toContain("plugins");
    expect(await section("plugins")).toContain("probe section v1");
    // Clef, the bundled routing plugin, assessed each message on the faux classifier.
    await waitFor(() => monchu.notices.some((notice) => notice.startsWith("clef · ")));
  });

  it("runs the file, shell and search tools in the front's directory", async () => {
    const path = join(monchu.home, "work", "note.txt");
    await ok("write", { path, content: "first line\nneedle here\n" });
    expect(await ok("read", { path })).toContain("needle here");
    await ok("edit", { path, edits: [{ oldText: "first line", newText: "edited line" }] });
    expect(await readFile(path, "utf8")).toContain("edited line");
    expect(await ok("bash", { command: "echo shell-ran" })).toContain("shell-ran");
    expect(await ok("fffind", { pattern: "note", path: "work/" })).toContain("work/note.txt");
    expect(await ok("ffgrep", { pattern: "needle", path: "work/" })).toContain("needle here");
    expect(
      await ok("codemode", { code: `return await tools.read({ path: ${JSON.stringify(path)} });` }),
    ).toContain("needle here");
  });

  it("keeps memory and goals", async () => {
    await ok("memory", { action: "add", file: "memory", entry: "e2e remembers this" });
    expect(await readFile(join(monchu.home, "memories", "MEMORY.md"), "utf8")).toContain(
      "e2e remembers this",
    );
    await ok("update_goal", {
      id: "e2e",
      title: "End to end goal",
      kind: "endeavor",
      workstream: "checking every surface",
      next: "the next step",
    });
    expect(await ok("list_goals", {})).toContain("End to end goal");
    const goals = await monchu.root.goals();
    expect(goals.map((goal) => goal.id)).toContain("e2e");
  });

  it("runs the home plugin's direct tool, deferred group, guard and command", async () => {
    expect(await ok("probe_direct", { text: "hi" })).toBe("probe v1: hi");
    await waitFor(() => monchu.notices.includes("probe notified hi"));
    expect(await ok("tool_search", { query: "plugin-probe" })).toContain("probe guide: be gentle");
    expect(await ok("probe_deferred", {})).toBe("deferred probe ran");
    const blocked = await call("bash", { command: "echo forbidden" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("probe blocks forbidden commands");
    expect(monchu.client.commands().map((command) => command.name)).toContain("probe");
    expect(await monchu.root.command("probe", "now")).toContain("probe command now by person");
  });

  it("calls an MCP server's tool from codemode, without loading its group", async () => {
    expect(
      await ok("codemode", {
        code: `return await tools.mcp__fixture__echo({ text: "over mcp" });`,
      }),
    ).toContain(String.raw`echo:{\"text\":\"over mcp\"}`);
  });

  it("runs the bundled jj plugin's tools", async () => {
    const status = await call("jj", { cwd: monchu.home, request: { operation: "status" } });
    const write = await call("jj_write", {
      cwd: join(monchu.home, "work"),
      request: { operation: "describe", revision: "@", message: "e2e" },
    });
    if (installed("jj")) {
      // Structured either way: a repository's status, or jj's own error outside one.
      expect(status.text).toMatch(/"ok":\s*(true|false)/);
      expect(write.text).toMatch(/"ok":\s*(true|false)/);
    } else expect(status.text).toMatch(/jj/);
  });

  it("imports a secret from a file, puts it in a shell's environment, and redacts it", async () => {
    const file = join(monchu.home, "work", "token.env");
    await writeFile(file, "OTHER=1\nE2E_TOKEN=e2e-secret-value-123\n");
    await ok("secret", { action: "import", name: "E2E_TOKEN", path: file, key: "E2E_TOKEN" });
    expect(await ok("secret", { action: "list" })).toContain("E2E_TOKEN");
    const echoed = await ok("bash", { command: "echo $E2E_TOKEN" });
    expect(echoed).toContain("[secret E2E_TOKEN]");
    expect(JSON.stringify(monchu.messages())).not.toContain("e2e-secret-value-123");
  });

  it("runs a background job and tells its worker when it ends", async () => {
    await ok("job", { action: "create", type: "bg", name: "e2e-bg", command: "echo job-done" });
    await waitFor(
      () => monchu.jobEvents.some((event) => event.job === "e2e-bg" && event.kind === "exited"),
      30_000,
    );
    expect((await monchu.client.jobs()).listing).toContain("e2e-bg");
    expect(await ok("job", { action: "output", name: "e2e-bg" })).toContain("job-done");
  });

  it("starts workers that report to the front, and messages, closes a batch, reopens and stops them", async () => {
    const reports = count("Faux front: result received.");
    await ask("work reader inspect", "Faux front: result received.");
    await ask("work writer draft", "Faux front: result received.");
    expect(await ok("worker_status", {})).toContain("reader");
    // Clef sent `work …` to a worker, and the front did start one.
    await waitFor(() => monchu.notices.some((notice) => /clef · .*worker/.test(notice)));
    await ok("message_worker", { name: "reader", message: "more" });
    await waitFor(() => count("Faux front: result received.") >= reports + 3, 30_000);
    const idle = async () =>
      (await monchu.root.workers()).filter((worker) => !worker.busy).length >= 2;
    await waitFor(idle, 30_000);
    // One call closes both; each is gone from the roster until reopened.
    const closed = await ok("close_workers", { names: ["reader", "writer"] });
    expect(closed).toContain("reader");
    expect(closed).toContain("writer");
    const open = await ok("worker_status", {});
    expect(open).not.toContain("reader");
    expect(open).not.toContain("writer");
    expect(await ok("worker_status", { include_closed: true })).toContain("writer");
    await ok("reopen_worker", { name: "reader" });
    await ok("stop_worker", { name: "reader" });
  });

  it("runs the bundled herdr and browser plugins: Herdr only inside Herdr, agent_browser when installed", async () => {
    const herdr = await call("herdr", {
      route: { kind: "local" },
      request: { operation: "workspace_list" },
    });
    expect(herdr.isError).toBe(true);
    expect(herdr.text).toMatch(/Herdr/i);
    const browser = await call("codemode", {
      code: `return await tools.agent_browser({ args: ["--version"] });`,
    });
    if (installed("agent-browser")) expect(browser.isError, browser.text).toBe(false);
    else expect(browser.text).toContain("agent-browser is not installed");
  });

  it("lists roots, messages another root's front, hands a worker over and archives that root", async () => {
    const other = await monchu.client.createRoot("e2e:root");
    expect(await ok("list_roots", {})).toContain(other.slice(0, 4));
    await ok("message_root", { root: other, message: "hello from the first front" });
    await waitFor(async () => {
      const view = await monchu.client.root(other).viewState();
      const seen = view.value.entries.some((entry) =>
        (entry.model ?? []).some((message) =>
          textOf(message).includes("hello from the first front"),
        ),
      );
      view.dispose();
      return seen;
    }, 30_000);
    await ok("hand_off_worker", { name: "reader", root: other });
    expect((await monchu.client.root(other).workers()).map((worker) => worker.name)).toContain(
      "reader",
    );
    await waitFor(async () => {
      try {
        await monchu.client.archiveRoot(other, true);
        return true;
      } catch {
        return false;
      }
    }, 30_000);
  });

  it("reloads a plugin edit through the tool and the client, keeping the conversation", async () => {
    // As another device's sync or an editor changes it: the next reload picks the new copy up.
    await writeFile(join(monchu.home, "plugins", "probe", "index.js"), probe("v2"));
    expect(await ok("reload_extensions", {})).toMatch(/reload/i);
    expect(await ok("probe_direct", { text: "again" })).toBe("probe v2: again");
    expect(await section("plugins")).toContain("probe section v2");
    expect(await monchu.client.reload()).toBeDefined();
    await ask("after reload");
  });

  it("records a restart request without restarting, and /restart keeps the client and its views", async () => {
    await ok("request_restart", { reason: "e2e asks" });
    expect(await section("restart_request")).toContain("Restart requested: e2e asks");
    const before = texts().length;
    await monchu.client.restart();
    await waitFor(() => monchu.reports.includes("reconnected to Monchu"), 60_000);
    // The same view goes on: what was there stays, and the new core answers into it.
    expect(texts().length).toBeGreaterThanOrEqual(before);
    await ask("after restart");
    expect(await ok("probe_direct", { text: "restarted" })).toBe("probe v2: restarted");
    expect(await ok("list_goals", {})).toContain("End to end goal");
    // A person's /restart cleared the request.
    expect(await section("restart_request")).toContain("No restart requested.");
  });

  // A real pseudo-terminal through util-linux `script`; Windows has no such tool, and macOS's takes other arguments.
  const pty = ["linux", "android"].includes(process.platform) && installed("script");
  it.skipIf(!pty)("runs the terminal in a real pty: plain monchu and monchu new", async () => {
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const terminal = async (args: string[], message: string) => {
      const run = entryProcess(monchu.home, args);
      const child = spawn(
        "script",
        [
          "-qfec",
          `stty cols 100 rows 40; exec ${[run.file, ...run.args].map(quote).join(" ")}`,
          "/dev/null",
        ],
        { env: { ...run.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data: Buffer) => (output += data.toString()));
      child.stderr.on("data", (data: Buffer) => (output += data.toString()));
      const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
      const shows = (text: string) =>
        waitFor(() => output.includes(text), 60_000).catch(() => {
          throw new Error(`The terminal never showed ${JSON.stringify(text)}:\n${output}`);
        });
      try {
        await shows("/help");
        child.stdin.write(`${message}\r`);
        await shows(`Faux reply: ${message}.`);
        child.stdin.write("/quit\r");
        expect(await exited).toBe(0);
      } finally {
        child.kill();
      }
    };
    await terminal([], "from the terminal");
    await terminal(["new"], "from a new root");
    let labels: string[] = [];
    const stop = await monchu.client.watchRoots(
      (roots) => (labels = roots.map((root) => root.label)),
    );
    await waitFor(() => labels.includes("from a new root"));
    stop();
  });
});

// The bundled fnox plugin as the home's secret store, with fnox itself; CI installs fnox for it.
describe.skipIf(!installed("fnox"))(
  "Monchu end to end, secrets in fnox",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      monchu = await open({ MONCHU_DEV_SECRETS: "plugins" });
    }, 240_000);

    afterAll(async () => {
      try {
        await monchu?.close();
      } finally {
        await cleanup();
      }
    }, 60_000);

    it("keeps an imported secret encrypted in fnox, injects it, and still has it after a restart", async () => {
      const value = "fnox-e2e-value-7781";
      const file = join(monchu.home, "work", "fnox.env");
      await writeFile(file, `FNOX_E2E=${value}\n`);
      await ok("secret", { action: "import", name: "FNOX_E2E", path: file, key: "FNOX_E2E" });
      // In the plugin's own fnox config under the home, never in plain text there.
      const config = await readFile(join(monchu.home, "secrets", "fnox.toml"), "utf8");
      expect(config).toContain("FNOX_E2E");
      expect(config).not.toContain(value);
      // The command names it only by hash, so nothing in the transcript holds the value.
      const hash = createHash("sha256").update(value).digest("hex");
      const check = `test "$(printf %s "$FNOX_E2E" | sha256sum | cut -c1-64)" = ${hash} && echo matched; echo "$FNOX_E2E"`;
      const used = await ok("bash", { command: check });
      expect(used).toContain("matched");
      expect(used).toContain("[secret FNOX_E2E]");
      // A new core reads it back from fnox: nothing held it in memory.
      await monchu.client.restart();
      await waitFor(() => monchu.reports.includes("reconnected to Monchu"), 60_000);
      expect(await ok("bash", { command: check })).toContain("matched");
      expect(await ok("secret", { action: "list" })).toContain("FNOX_E2E");
      expect(JSON.stringify(monchu.messages())).not.toContain(value);
    });
  },
);

// `/update` as a person runs it, on a release installed as users install one: the tarball CI packs and publishes
// (`MONCHU_E2E_TARBALL`), with a broken and a newer copy of it served as releases from loopback (`MONCHU_RELEASES`).
const tarball = process.env.MONCHU_E2E_TARBALL;
describe.skipIf(tarball === undefined || process.platform === "win32")(
  "Monchu end to end, /update on an installed release",
  { timeout: 900_000 },
  () => {
    afterAll(cleanup);

    it("refuses a release that doesn't start, installs one that does, and comes back on it", async () => {
      if (tarball === undefined) return;
      const home = await smokeHome();
      const work = await mkdtemp(join(tmpdir(), "monchu-e2e-update-"));
      const sh = (command: string, args: string[], cwd = work) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
        if (result.status !== 0)
          throw new Error(`${command} ${args.join(" ")}: ${result.stderr}${result.stdout}`);
        return result.stdout;
      };
      // Each release is the tested tarball with one change, repacked as npm packs it.
      const release = async (tag: string, change: (dir: string) => Promise<void>) => {
        const dir = join(work, tag);
        await mkdir(join(work, "releases", tag), { recursive: true });
        await mkdir(dir);
        sh("tar", ["-xzf", tarball, "-C", dir]);
        await change(join(dir, "package"));
        sh("tar", ["-czf", join(work, "releases", tag, "monchu.tgz"), "-C", dir, "package"]);
      };
      const manifest = async (dir: string): Promise<Record<string, unknown>> => {
        const value: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        if (typeof value !== "object" || value === null) throw new Error(`${dir}: no package.json`);
        return { ...value };
      };
      await release("v6.6.6", async (dir) => {
        await writeFile(join(dir, "dist", "main.js"), 'throw new Error("e2e broken release");\n');
      });
      await release("edge", async (dir) => {
        const pkg = await manifest(dir);
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ ...pkg, version: `${String(pkg.version)}-e2e.newer` }),
        );
      });
      const server = createServer((request, response) => {
        void readFile(join(work, "releases", ...(request.url ?? "/").split("/").filter(Boolean)))
          .then((body) => {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            response.end(request.method === "HEAD" ? undefined : body);
          })
          .catch(() => response.writeHead(404).end());
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
      const prefix = join(work, "prefix");
      const root = join(prefix, "lib", "node_modules", "monchu");
      const version = async () => String((await manifest(root)).version);
      try {
        sh("npm", ["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, tarball]);
        const before = await version();
        const monchu = runEntry(home, ["serve"], "core ready", {
          entry: join(root, "dist", "main.js"),
          env: { MONCHU_RELEASES: base },
        });
        await monchu.seen;
        const attached = await attachSocket(socketPath(home), () => {});
        if (attached === undefined) throw new Error(`Nothing answers:\n${monchu.output()}`);
        const { client } = attached;
        const outcomes: string[] = [];
        client.onRelease((state) => {
          if (state.outcome !== null && !outcomes.includes(state.outcome))
            outcomes.push(state.outcome);
        });
        const answers = async (text: string) => {
          const root = await front(client);
          const view = await root.viewState();
          await root.submit(text, `e2e-update:${text}`, "followUp");
          await waitFor(
            () =>
              view.value.entries.some((entry) =>
                (entry.model ?? []).some((message) =>
                  textOf(message).startsWith(`Faux reply: ${text}.`),
                ),
              ),
            60_000,
          );
          view.dispose();
        };
        await answers("before the update");

        // The broken release never replaces the running one: the same version comes back and says why.
        await client.update("6.6.6");
        await waitFor(() => outcomes.some((each) => each.includes("update failed")), 400_000);
        expect(outcomes.join("\n")).toContain("e2e broken release");
        expect(await version()).toBe(before);
        expect(client.release.version).toBe(before);
        await answers("after the refused update");

        // A release that starts is installed into the running copy's prefix, and Monchu comes back on it.
        await client.update("edge");
        await waitFor(() => outcomes.some((each) => each.startsWith("updated · ")), 600_000);
        expect(outcomes.at(-1)).toBe(`updated · ${before} → ${before}-e2e.newer`);
        expect(await version()).toBe(`${before}-e2e.newer`);
        await waitFor(() => client.release.version === `${before}-e2e.newer`, 60_000);
        await answers("after the update");
        await attached.close();
        expect(
          (
            await runEntry(home, ["stop"], undefined, { entry: join(root, "dist", "main.js") })
              .exited
          ).output,
        ).toContain("stopped the Monchu of");
      } finally {
        server.close();
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
  },
);

/** One Anthropic Messages API answer, streamed as server-sent events the way the API sends them. */
function streamed(
  response: ServerResponse,
  blocks: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: object }
  )[],
  stop: "end_turn" | "tool_use",
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", {
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      send("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    send("content_block_stop", { index });
  }
  send("message_delta", {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", {});
  response.end();
}

// The real Claude Code CLI (on PATH, as on the phone) under the real bridge, with only the Anthropic API faked on
// loopback: the model drops the mcp__monchu__ prefix once, and Claude Code itself must answer it and ask again.
describe.skipIf(!installed("claude") || process.platform === "win32")(
  "Monchu end to end, the real Claude Code CLI",
  { timeout: 180_000 },
  () => {
    afterAll(cleanup);

    it("survives a bare tool name: Claude Code says No such tool, the model retries in the same reply", async () => {
      const home = await smokeHome();
      const seen: { tools: string[]; last: string }[] = [];
      const api = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          if (
            !(request.url ?? "").startsWith("/v1/messages") ||
            request.url?.includes("count_tokens")
          ) {
            response.writeHead(404, { "content-type": "application/json" }).end("{}");
            return;
          }
          const parsed: unknown = JSON.parse(body);
          const field = (value: unknown, key: string): unknown =>
            typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
          const tools = field(parsed, "tools");
          const names = Array.isArray(tools)
            ? tools.map((tool) => String(field(tool, "name")))
            : [];
          const messages = field(parsed, "messages");
          const last = JSON.stringify(Array.isArray(messages) ? messages.at(-1) : null);
          // Side requests (titles, quota) declare no Monchu tools.
          if (!names.includes("mcp__monchu__codemode"))
            return streamed(response, [{ type: "text", text: "side" }], "end_turn");
          seen.push({ tools: names, last });
          if (last.includes("toolu_full"))
            return streamed(response, [{ type: "text", text: "bare retry done" }], "end_turn");
          if (last.includes("toolu_bare"))
            return streamed(
              response,
              [
                {
                  type: "tool_use",
                  id: "toolu_full",
                  name: "mcp__monchu__codemode",
                  input: { code: "return 40 + 2;" },
                },
              ],
              "tool_use",
            );
          streamed(
            response,
            [
              { type: "text", text: "checking" },
              {
                type: "tool_use",
                id: "toolu_bare",
                name: "codemode",
                input: { code: "return 1;" },
              },
            ],
            "tool_use",
          );
        });
      });
      await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
      const address = api.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const wrapper = join(home, "claude-wrapper.sh");
      await writeFile(
        wrapper,
        `#!/bin/sh\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\nexport NO_PROXY=127.0.0.1 no_proxy=127.0.0.1\nexec claude "$@"\n`,
        { mode: 0o755 },
      );
      const role = { provider: "claude-code", modelId: "claude-sonnet-4-6", thinkingLevel: "off" };
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: role,
          worker: role,
          plugins: { clef: null },
          claude: { executable: wrapper },
        }),
      );
      const backend = await Monchu.open(home);
      try {
        await backend.login("claude-code", "oauth", {
          prompt: async () => "sk-ant-oat01-e2e-fake-token",
          notify: () => {},
        });
        const root = await front(backend);
        const view = await root.viewState();
        await root.submit("check", "e2e:claude", "followUp");
        const all = () => view.value.entries.flatMap((entry) => entry.model ?? []);
        await waitFor(
          () =>
            all().some(
              (message) =>
                message.role === "assistant" && textOf(message).includes("bare retry done"),
            ),
          150_000,
        ).catch(() => {
          throw new Error(
            `No final answer. API saw:\n${JSON.stringify(seen, null, 1)}\nTranscript:\n${JSON.stringify(all(), null, 1)}`,
          );
        });
        // Claude Code itself answered the bare name, in the request that carried the model's retry.
        const rejected = seen.find((each) => each.last.includes("toolu_bare"))?.last ?? "";
        console.log(`Claude Code's own answer to the bare call: ${rejected}`);
        expect(rejected).toMatch(/No such tool available: codemode/);
        // Durable ran the full-name call once, and nothing in the transcript is an error.
        const runs = all().filter(
          (message): message is ToolResultMessage =>
            message.role === "toolResult" && message.toolName === "codemode",
        );
        expect(runs).toHaveLength(1);
        expect(textOf(runs[0])).toContain("42");
        expect(JSON.stringify(all())).not.toContain("undeclared tool");
        view.dispose();
      } finally {
        await backend.close();
        api.close();
      }
    });
  },
);
