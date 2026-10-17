#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { chooseRoot, type RootChoice } from "./api/roots.ts";
import { monchuHome, seedHome } from "./core/home.ts";

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
  } else {
    // The web client only when asked for: `monchu --web` or `monchu serve --web`.
    const web = process.argv.includes("--web");
    const args = process.argv.slice(2).filter((arg) => arg !== "--web");
    const serve = args[0] === "serve";
    const { randomUUID } = await import("node:crypto");
    // Which root this terminal opens: the current one, one by id, or a new one.
    // A /restart re-executes these arguments: it reopens the root its terminal showed, never a new one.
    const reopened = process.env.MONCHU_RESTART_ROOT;
    delete process.env.MONCHU_RESTART_ROOT;
    const choice: RootChoice =
      reopened !== undefined
        ? { kind: "resume", prefix: reopened }
        : args[0] === "new" && args.length === 1
          ? { kind: "new", requestId: randomUUID() }
          : args[0] === "resume" && args.length === 2 && args[1] !== undefined
            ? { kind: "resume", prefix: args[1] }
            : { kind: "current" };
    const usage =
      args[0] === "new"
        ? args.length === 1
        : args[0] === "resume"
          ? args.length === 2
          : args.length === 0 || (serve && args.length === 1);
    if (!usage)
      throw new Error(
        `Unknown arguments: ${args.join(" ")}. Usage: monchu [new | resume <id> | serve] [--web]`,
      );
    const seeded = await seedHome(home);
    const { attachSocket, serveSocket, socketPath } = await import("./server/socket.ts");
    const path = socketPath(home);
    const openCore = async () => {
      const { Monchu } = await import("./core/backend.ts");
      return process.env.MONCHU_DEV_FAUX === "1"
        ? (await import("./core/dev-faux.ts")).openDevMonchu(home)
        : Monchu.open(home);
    };
    // One core owns a home. A plain `monchu` attaches its terminal to the running one, or becomes it.
    const attached = serve ? undefined : await attachSocket(path, () => {});
    if (attached !== undefined && web)
      seeded.push(
        "--web applies only to the process that becomes the core; this terminal attached to a running one",
      );
    if (attached !== undefined) {
      const { runTerminal } = await import("./tui/app.ts");
      const { herdrAgent } = await import("./tui/herdr-agent.ts");
      try {
        const rootId = await chooseRoot(attached.client, choice);
        await runTerminal(attached.client, rootId, undefined, herdrAgent(process.env), seeded);
      } finally {
        await attached.close();
      }
    } else {
      const backend = await openCore();
      const notes = [...seeded];
      const { openCoreHost } = await import("./server/host.ts");
      const host = await openCoreHost(backend);
      let server: { close(): Promise<void> } | undefined;
      try {
        server = await serveSocket(host, backend, path);
      } catch (error) {
        notes.push(
          `other terminals can't attach: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let site: { url: string; close(): Promise<void> } | undefined;
      if (web) {
        const config = backend.web;
        try {
          if (config === undefined) throw new Error("config.json has no web section");
          site = await (
            await import("./server/web.ts")
          ).serveWeb(host, backend, config, process.env);
          notes.push(
            `web · ${site.url}${config.host === undefined ? "" : ` · public host ${config.host}`}`,
          );
        } catch (error) {
          notes.push(`web is off: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      backend.addNotes(...notes);
      // Left by the process this one replaced after /update; once said, it is not carried into later restarts.
      const updated = process.env.MONCHU_UPDATE_OUTCOME;
      delete process.env.MONCHU_UPDATE_OUTCOME;
      if (updated) backend.updated(updated);
      let outcome: "quit" | "restart" = "quit";
      try {
        if (serve) {
          console.log(`monchu · serving ${home} on ${path} · Ctrl-C stops`);
          for (const note of notes) console.log(`monchu · ${note}`);
          outcome = await new Promise<"quit" | "restart">((done) => {
            backend.onRestartRequest(() => done("restart"));
            // A closed terminal (SIGHUP) stops it as cleanly as Ctrl-C or a service manager.
            for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
              process.once(signal, () => done("quit"));
          });
          if (outcome === "restart") {
            await site?.close();
            await server?.close();
            await host.close();
            await backend.restart();
          }
        } else {
          const { runTerminal } = await import("./tui/app.ts");
          const { herdrAgent } = await import("./tui/herdr-agent.ts");
          const rootId = await chooseRoot(backend, choice);
          outcome = await runTerminal(backend, rootId, undefined, herdrAgent(process.env));
          if (outcome === "restart") process.env.MONCHU_RESTART_ROOT = rootId;
        }
      } finally {
        await site?.close();
        await server?.close();
        await host.close();
        await backend.close();
      }
      if (outcome === "restart") {
        // Loaded before npm replaces the package's files under this process.
        const { reexecute } = await import("./reexec.ts");
        const plan = backend.plannedUpdate;
        if (plan !== undefined) {
          const { install, installedVersion, VERSION } = await import("./core/update.ts");
          console.log(`monchu · installing ${plan.url} into ${plan.prefix}`);
          const { code, tail } = await install(plan, (line) => console.log(`npm · ${line}`));
          process.env.MONCHU_UPDATE_OUTCOME =
            code === 0
              ? `updated · ${VERSION} → ${installedVersion()}`
              : `warning · update failed: npm exited ${code}; still on ${VERSION}\n${tail.join("\n")}`;
        }
        // Inside the try: the exit backstop below must not cut a Windows child short.
        await reexecute();
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
