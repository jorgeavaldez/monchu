import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { webSocketLink, type Link } from "@earendil-works/chord";
import WebSocket, { WebSocketServer } from "ws";
import { connectRemote } from "../api/connect.ts";
import type { Monchu } from "../core/backend.ts";
import { acceptClient, type CoreHost } from "./host.ts";

/** The owner's local socket: `<home>/run/monchu.sock`, or a named pipe on Windows, where sockets are not files. */
export function socketPath(home: string): string {
  if (process.platform !== "win32") return join(home, "run", "monchu.sock");
  return `\\\\.\\pipe\\monchu-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}`;
}

/**
 * Serve the core on its local socket, a WebSocket per terminal as on the web. The caller owns the home's lock, so a
 * socket file left there is stale. Only the user can reach it: the run directory is 0700, so every connection is a
 * person's.
 */
export async function serveSocket(
  host: CoreHost,
  backend: Monchu,
  path: string,
): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "win32") {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await rm(path, { force: true });
  }
  const server = createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  let next = 1;
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("error", () => {});
      const attached = performance.now();
      backend.log.write("info", "server.socket", "client attached", {
        clients: sockets.clients.size,
      });
      const principal = { kind: "client" as const, connection: `s${next++}`, person: true };
      void acceptClient(host, connection, principal).then(() =>
        backend.log.write("info", "server.socket", "client left", {
          clients: sockets.clients.size,
          ms: Math.round(performance.now() - attached),
        }),
      );
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => {
      server.off("error", fail);
      done();
    });
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return {
    close: () =>
      new Promise<void>((done) => {
        // Answers already written still arrive; a client that lingers is cut.
        for (const client of sockets.clients) {
          client.close(1012, "Monchu is restarting");
          setTimeout(() => client.terminate(), 500).unref();
        }
        sockets.close();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/** A link to the core on its socket, or `undefined` when nothing answers. */
function dial(path: string): Promise<Link | undefined> {
  return new Promise((done) => {
    const socket = new WebSocket("ws://monchu/api", {
      createConnection: () => connect(path),
      handshakeTimeout: 500,
    });
    // Wrapped at once, so the core's first frames are never missed.
    const link = webSocketLink(socket);
    socket.on("error", () => {});
    socket.once("open", () => done(link));
    socket.once("error", () => {
      link.close();
      done(undefined);
    });
  });
}

/**
 * Attach to a running core as a client, or `undefined` when nothing answers. The client reconnects by itself when the
 * core restarts.
 */
export function attachSocket(
  path: string,
  onError: (error: Error) => void,
): ReturnType<typeof connectRemote> {
  return connectRemote(() => dial(path), { onError });
}
