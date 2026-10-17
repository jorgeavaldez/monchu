#!/usr/bin/env node
import { enableCompileCache } from "node:module";
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
    const args = process.argv.slice(2);
    const serve = args[0] === "serve";
    // The web client only when asked for: `monchu --web` or `monchu serve --web`.
    const web = args.includes("--web");
    const unknown = args.filter((arg, index) => !(index === 0 && serve) && arg !== "--web");
    if (unknown.length > 0)
      throw new Error(`Unknown arguments: ${unknown.join(" ")}. Usage: monchu [serve] [--web]`);
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
        await runTerminal(attached.client, undefined, herdrAgent(process.env), seeded);
      } finally {
        await attached.close();
      }
    } else {
      const backend = await openCore();
      const notes = [...seeded];
      let server: { close(): Promise<void> } | undefined;
      try {
        server = await serveSocket(backend, path, (message) => backend.report(message));
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
          site = await (await import("./server/web.ts")).serveWeb(backend, config, process.env);
          notes.push(
            `web · ${site.url}${config.host === undefined ? "" : ` · public host ${config.host}`}`,
          );
        } catch (error) {
          notes.push(`web is off: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      backend.addNotes(...notes);
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
            await backend.restart();
          }
        } else {
          const { runTerminal } = await import("./tui/app.ts");
          const { herdrAgent } = await import("./tui/herdr-agent.ts");
          outcome = await runTerminal(backend, undefined, herdrAgent(process.env));
        }
      } finally {
        await site?.close();
        await server?.close();
        await backend.close();
      }
      // Inside the try: the exit backstop below must not cut a Windows child short.
      if (outcome === "restart") await (await import("./reexec.ts")).reexecute();
    }
  }
} catch (error) {
  console.error(`system · error · ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

// Storage is closed and accepted work stays recoverable. Anything still holding the event loop (a dependency's
// socket or timer) must not keep `/quit` hanging; the unref'd timer only fires if something does.
setTimeout(() => process.exit(), 1000).unref();
