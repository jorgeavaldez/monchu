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
    const seeded = await seedHome(home);
    const { Monchu } = await import("./core/backend.ts");
    const { runTerminal } = await import("./tui/app.ts");
    const { herdrAgent } = await import("./tui/herdr-agent.ts");
    const backend =
      process.env.MONCHU_DEV_FAUX === "1"
        ? await (await import("./core/dev-faux.ts")).openDevMonchu(home)
        : await Monchu.open(home);
    try {
      await runTerminal(backend, undefined, herdrAgent(process.env), seeded);
    } finally {
      await backend.close();
    }
  }
} catch (error) {
  console.error(`system · error · ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

// Storage is closed and accepted work stays recoverable. Anything still holding the event loop (a dependency's
// socket or timer) must not keep `/quit` hanging; the unref'd timer only fires if something does.
setTimeout(() => process.exit(), 1000).unref();
