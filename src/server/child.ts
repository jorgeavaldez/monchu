/**
 * The core as the server's child process: it takes the home's lock, opens the store and its Chord host upstream of
 * the server, and says it is ready. It closes the way Monchu always closes (Durable's `close`) when the server asks it
 * to, and also when the server is gone without asking (killed, crashed), so it never runs on as an orphan.
 */
import { ChordError, ipcLink, type IpcChannel, type Link } from "@earendil-works/chord";
import { childControl } from "@earendil-works/chord/node";
import { Server } from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import { containPluginFault } from "../core/plugins.ts";
import { openCoreHost, Reloads, type CoreHost } from "./host.ts";

/** The IPC channel to the server: a forked child always has one. */
function channel(): IpcChannel {
  const send = process.send?.bind(process);
  if (send === undefined) throw new Error("The core runs only as the server's child");
  return {
    get connected() {
      return process.connected;
    },
    send: (message, callback) => send(message, undefined, undefined, callback),
    on: (event: "message" | "disconnect", listener: (message: unknown) => void) =>
      process.on(event, listener),
    off: (event: "message" | "disconnect", listener: (message: unknown) => void) =>
      process.off(event, listener),
  };
}

/** Run the core until it is told to close or its parent goes; resolves once it closed. */
export async function runCore(open: () => Promise<Monchu>): Promise<void> {
  // A plugin's own uncaught failure is told and the core runs on; any other still stops it, as Node would.
  const fatal = (error: unknown) => {
    if (containPluginFault(error)) return;
    console.error(error);
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  const control = childControl();
  try {
    await control.lock();
  } catch (error) {
    control.fatal(error);
    return;
  }
  let backend: Monchu;
  try {
    backend = await open();
  } catch (error) {
    control.fatal(error);
    return;
  }
  const core = await serveUpstream(backend, ipcLink(channel()));
  const closed = Promise.withResolvers<void>();
  const close = () => core.close().finally(() => closed.resolve());
  control.onShutdown(close);
  process.once("disconnect", () => void close());
  // A service manager signals every process of the service at once, and a console's Ctrl-C reaches a Windows child:
  // the core closes as cleanly then as when its server asks.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void close());
  control.ready();
  await closed.promise;
}

/**
 * Serve a backend to the server over `link`: the core's host, and `/restart` and `/update` from any client handed to
 * the server, which replaces this core while every client keeps its socket, and `/reload` through the server. `close`
 * closes the backend, which closes the host first.
 */
export async function serveUpstream(
  backend: Monchu,
  link: Link,
): Promise<{ host: CoreHost; close: () => Promise<void> }> {
  const host = await openCoreHost(backend, link);
  const server = host.hold(Server, {});
  // A person approved a restart: closing clears the model's restart request, as `/restart` always did.
  let restarting = false;
  const stop = backend.onRestartRequest(() => {
    restarting = true;
    void (async () => {
      await server.ready;
      if (server.variant !== "core") return;
      // After `/update` the server installs first, and runs the new release.
      const plan = backend.plannedUpdate;
      await (plan === undefined ? server.replace() : server.update({ plan }));
    })().catch((error: unknown) =>
      backend.log.write("warn", "server.child", "restart failed", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  // A reload runs across the server and this core, so both move to the new code version together.
  const solo = backend.coordinateReloads(async (modules, signal) => {
    let reloads;
    try {
      reloads = await host.get(Reloads, {}, { signal });
    } catch (error) {
      // A server started before hot reload doesn't serve it: it has to start again with the new code.
      if (error instanceof ChordError && error.code !== "aborted")
        throw new Error(
          "This server predates hot reload: quit every client, then start Monchu again",
          {
            cause: error,
          },
        );
      throw error;
    }
    try {
      await host.root((ctx) => reloads.reload({ modules: [...modules] }, ctx), { signal });
    } finally {
      reloads.release();
    }
  });
  let closing: Promise<void> | undefined;
  return {
    host,
    close: () => {
      closing ??= (async () => {
        stop();
        solo();
        server.release();
        // The backend closes the host first, then its store.
        await (restarting ? backend.restart() : backend.close());
      })();
      return closing;
    },
  };
}
