/**
 * The core as the server's child process: it takes the home's lock, opens the store and its Chord host upstream of
 * the server, and says it is ready. It closes the way Monchu always closes (Durable's `close`) when the server asks it
 * to, and also when the server is gone without asking (killed, crashed), so it never runs on as an orphan.
 */
import { ipcLink, type IpcChannel, type Link } from "@earendil-works/chord";
import { childControl } from "@earendil-works/chord/node";
import { Server } from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import { openCoreHost, type CoreHost } from "./host.ts";

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
 * the server, which replaces this core while every client keeps its socket. `close` closes the host, then the backend.
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
  let closing: Promise<void> | undefined;
  return {
    host,
    close: () => {
      closing ??= (async () => {
        stop();
        server.release();
        try {
          await host.close();
        } finally {
          await (restarting ? backend.restart() : backend.close());
        }
      })();
      return closing;
    },
  };
}
