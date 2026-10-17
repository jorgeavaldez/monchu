import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { connectRemote } from "../api/connect.ts";
import type { Monchu } from "../core/backend.ts";
import { serveConnection } from "./session.ts";

/** The owner's local socket: `<home>/run/monchu.sock`, or a named pipe on Windows, where sockets are not files. */
export function socketPath(home: string): string {
  if (process.platform !== "win32") return join(home, "run", "monchu.sock");
  return `\\\\.\\pipe\\monchu-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}`;
}

/** Feed newline-separated messages from a socket to `receive`. */
function lines(socket: Socket, receive: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) receive(line);
    }
  });
}

/**
 * Serve the core on its local socket: each connection gets its own session. The caller owns the home's lock, so a
 * socket file left there is stale. Only the user can reach it: the run directory is 0700.
 */
export async function serveSocket(
  backend: Monchu,
  path: string,
): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "win32") {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await rm(path, { force: true });
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const attached = performance.now();
    backend.log.write("info", "server.socket", "client attached", { clients: sockets.size });
    // Only the user reaches the socket: its directory is theirs alone.
    const connection = serveConnection(backend, { updates: true }, (text) => {
      if (!socket.destroyed) socket.write(`${text}\n`);
    });
    lines(socket, (line) => connection.receive(line));
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      connection.dispose();
      backend.log.write("info", "server.socket", "client left", {
        clients: sockets.size,
        ms: Math.round(performance.now() - attached),
      });
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
        // End each connection so answers already written still arrive; a client that lingers is cut.
        for (const socket of sockets) {
          socket.end();
          setTimeout(() => socket.destroy(), 500).unref();
        }
        server.close(() => done());
      }),
  };
}

function connectTo(path: string, timeoutMs: number): Promise<Socket | undefined> {
  return new Promise((done) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      done(undefined);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
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
  return connectRemote(
    async () => {
      const socket = await connectTo(path, 500);
      if (socket === undefined) return undefined;
      socket.on("error", () => {});
      return {
        send: (text) => {
          if (!socket.destroyed) socket.write(`${text}\n`);
        },
        close: () => socket.destroy(),
        listen: (onMessage, onClose) => {
          lines(socket, onMessage);
          socket.once("close", onClose);
        },
      };
    },
    { onError },
  );
}
