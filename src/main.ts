#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { resolve } from "node:path";
import { chooseRoot, type RootChoice } from "./api/roots.ts";
import { monchuHome, seedHome } from "./core/home.ts";

/** The home of the core a process runs inside, if any. */
const CORE_HOME_ENV = "MONCHU_CORE_HOME";

// Before the dynamic imports below, so startup and /restart reuse compiled code. Node keys the cache by version and
// source hash in its default temp directory; NODE_DISABLE_COMPILE_CACHE turns it off.
enableCompileCache();

try {
  const home = await monchuHome(process.env.MONCHU_DEV_FAUX === "1");
  // Inherited by /restart so smoke mode reopens the same isolated home.
  if (process.env.MONCHU_DEV_FAUX === "1") process.env.MONCHU_DEV_HOME = home;
  if (process.argv[2] === "update") {
    // Checks the store's lock without opening it, so it can refuse while Monchu runs.
    const { runUpdate } = await import("./core/update.ts");
    process.exitCode = await runUpdate(process.argv.slice(3), {
      home,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
  } else if (process.argv[2] === "mcp") {
    // Configures MCP servers without opening the store, so it runs next to a running Monchu.
    const { runMcpCommand } = await import("./core/mcp/cli.ts");
    const { openModels } = await import("./core/models/index.ts");
    const models = await openModels(home);
    process.exitCode = await runMcpCommand(process.argv.slice(3), {
      home,
      env: process.env,
      providerToken: async (provider) => (await models.getAuth(provider))?.auth.apiKey,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
  } else if (process.argv[2] === "__core") {
    // Inherited by everything the core runs (tool shells, plugins' children), so a `monchu stop` from there refuses.
    process.env[CORE_HOME_ENV] = resolve(home);
    // The server's child: it owns the store. Seeding happens here, so its notes reach every client's first screen.
    const seeded = await seedHome(home);
    const { runCore } = await import("./server/child.ts");
    // Set by the server when the last core failed: safe mode opens without home plugins.
    const { readRecovery } = await import("./server/process.ts");
    const recovery = readRecovery(process.env);
    const safe = recovery?.safe ?? false;
    await runCore(async () => {
      const { Monchu } = await import("./core/backend.ts");
      const backend =
        process.env.MONCHU_DEV_FAUX === "1"
          ? await (await import("./core/dev-faux.ts")).openDevMonchu(home, { safe })
          : await Monchu.open(home, undefined, { safe });
      backend.addNotes(...seeded);
      // Left by the server this one came back from after /update.
      const updated = process.env.MONCHU_UPDATE_OUTCOME;
      if (updated) backend.updated(updated);
      if (recovery !== undefined) backend.recovered(recovery);
      return backend;
    });
  } else {
    // The web client only when asked for: `monchu --web` or `monchu serve --web`.
    const web = process.argv.includes("--web");
    const args = process.argv.slice(2).filter((arg) => arg !== "--web");
    const command = args[0];
    const { socketPath } = await import("./server/socket.ts");
    const path = socketPath(home);
    if (command === "serve" || command === "server") {
      if (args.length !== 1) throw new Error(`Unknown arguments: ${args.join(" ")}`);
      // `serve` runs in the foreground and keeps the core; `server` is what a terminal starts in the background.
      const updated = process.env.MONCHU_UPDATE_OUTCOME;
      delete process.env.MONCHU_UPDATE_OUTCOME;
      const say = (line: string) => console.log(`monchu · ${line}`);
      const stopped = new Promise<string>((done) => {
        // A closed terminal (SIGHUP) stops it as cleanly as Ctrl-C or a service manager.
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
          process.once(signal, () => done(signal));
      });
      const { runServer } = await import("./server/server.ts");
      const end = await runServer({
        home,
        mode: command === "serve" ? "serve" : "background",
        web,
        core: { entry: process.argv[1] ?? "", args: ["__core"] },
        firstCoreEnv: updated ? { MONCHU_UPDATE_OUTCOME: updated } : {},
        env: process.env,
        signal: stopped,
        say,
      });
      if (end.kind === "updated") {
        // The new release's server and core: clients redial and pick up where they were.
        process.env.MONCHU_UPDATE_OUTCOME = end.outcome;
        const { reexecute } = await import("./reexec.ts");
        await reexecute();
      }
    } else if (command === "stop") {
      if (args.length !== 1) throw new Error(`Unknown arguments: ${args.join(" ")}`);
      // An agent's shell stopping the Monchu it runs in ends itself and every other conversation's work.
      if (process.env[CORE_HOME_ENV] === resolve(home))
        throw new Error(
          `This runs inside the Monchu of ${home}, which it would stop. Use /restart, or stop it from a terminal of your own.`,
        );
      const { stopServer } = await import("./server/socket.ts");
      console.log(
        (await stopServer(path))
          ? `monchu · stopped the Monchu of ${home}`
          : `monchu · no Monchu runs for ${home}`,
      );
    } else {
      const { randomUUID } = await import("node:crypto");
      // Which root this terminal opens: the current one, one by id, or a new one.
      const choice: RootChoice =
        command === "new" && args.length === 1
          ? { kind: "new", requestId: randomUUID() }
          : command === "resume" && args.length === 2 && args[1] !== undefined
            ? { kind: "resume", prefix: args[1] }
            : { kind: "current" };
      const usage =
        command === "new"
          ? args.length === 1
          : command === "resume"
            ? args.length === 2
            : args.length === 0;
      if (!usage)
        throw new Error(
          `Unknown arguments: ${args.join(" ")}. Usage: monchu [new | resume <id> | serve | stop] [--web]`,
        );
      // Checked before anything starts: a terminal that can't show the TUI leaves no server behind.
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("Monchu's TUI needs an interactive terminal.");
      const { attachOrStart } = await import("./server/socket.ts");
      const notes: string[] = [];
      const { spawn } = await import("node:child_process");
      const { mkdirSync, openSync } = await import("node:fs");
      const { join } = await import("node:path");
      const attached = await attachOrStart(path, () => {
        // Detached, so it outlives this terminal; its output goes to the run directory, after the last one's, so a
        // crash's stack outlasts the next start.
        mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
        const output = openSync(join(home, "run", "server.log"), "a", 0o600);
        spawn(
          process.execPath,
          [...process.execArgv, process.argv[1] ?? "", "server", ...(web ? ["--web"] : [])],
          { detached: true, stdio: ["ignore", output, output], windowsHide: true },
        ).unref();
      });
      // A running server serves the web client too once `--web` asks it.
      if (attached.started === false && web) {
        const { Server } = await import("./api/contract.ts");
        const server = await attached.client.host.get(Server, {}).catch(() => undefined);
        try {
          if (server?.variant !== "owner") throw new Error("the running server can't start it");
          notes.push(`web · ${await server.web({})}`);
        } catch (error) {
          notes.push(`web is off: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          server?.release();
        }
      }
      const { runTerminal } = await import("./tui/app.ts");
      const { herdrAgent } = await import("./tui/herdr-agent.ts");
      try {
        const rootId = await chooseRoot(attached.client, choice);
        await runTerminal(attached.client, rootId, undefined, herdrAgent(process.env), notes);
      } finally {
        await attached.close();
      }
    }
  }
} catch (error) {
  console.error(`system · error · ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

// Storage is closed and accepted work stays recoverable. Anything still holding the event loop (a dependency's
// socket or timer) must not keep `/quit` hanging; the unref'd timer only fires if something does.
setTimeout(() => process.exit(), 1000).unref();
