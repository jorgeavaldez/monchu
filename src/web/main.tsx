/** Connect to the core over the page's own WebSocket, then render. A dropped connection reconnects by itself. */
import { render } from "preact";
import { webSocketLink, type Link, type WebSocketLike } from "@earendil-works/chord";
import { connectRemote, OUTDATED_CORE } from "../api/connect.ts";
import type { RemoteClient } from "../api/remote.ts";
import { App } from "./app.tsx";
import { cancelLogin, connected, connection, loginStatus, notice, start, view } from "./state.ts";
import { telemetry } from "./telemetry.ts";

/**
 * Whether the server answers at all. Browsers delay new WebSockets to an endpoint that just refused one, so a plain
 * request goes first while the core restarts; behind a tunnel a down origin answers 502 or 530.
 */
async function up(): Promise<boolean> {
  const response = await fetch("/", { method: "HEAD", cache: "no-store" }).catch(() => undefined);
  return response !== undefined && response.status < 500;
}

/** The browser's socket as Chord's link sees it: binary messages arrive as ArrayBuffers. */
function socketLike(socket: WebSocket): WebSocketLike {
  socket.binaryType = "arraybuffer";
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(typeof data === "string" ? data : new Uint8Array(data)),
    close: (code, reason) => socket.close(code, reason),
    addEventListener(
      type: "message" | "open" | "close" | "error",
      listener: (event: { readonly data: unknown }) => void,
    ) {
      socket.addEventListener(type, (event) =>
        listener({ data: event instanceof MessageEvent ? event.data : undefined }),
      );
    },
  };
}

async function dial(): Promise<Link | undefined> {
  if (!(await up())) return undefined;
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`,
    );
    // Wrapped at once, so the core's first frames are never missed.
    const link = webSocketLink(socketLike(socket));
    socket.addEventListener("open", () => {
      socket.addEventListener("close", () => connected("lost"));
      resolve(link);
    });
    // Refused or signed out: the page reloads into the login once the core is reachable again.
    socket.addEventListener("error", () => resolve(undefined));
  });
}

/** The connected client, and the core's version this page was loaded with. */
let page: { client: RemoteClient; version: string } | undefined;

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) return;
  render(<App />, root);
  // As in the terminal, Esc cancels a login wherever focus is, such as while a device code waits.
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || loginStatus.value === undefined) return;
    event.preventDefault();
    cancelLogin();
  });
  const attached = await connectRemote(dial, {
    // A core that came back on another protocol, or from an update, serves a newer page: load it.
    onError: (error) => {
      if (error.message === OUTDATED_CORE) location.reload();
      else if (page !== undefined && page.client.release.updating !== null) location.reload();
    },
    onReconnect: (ms) => {
      // An update replaced the page's own files: load the new ones.
      if (page !== undefined && page.client.release.version !== page.version)
        return location.reload();
      connected("open");
      page?.client.record("web", "reconnected", { ms });
    },
  });
  if (attached === undefined) {
    connection.value = "gone";
    // Not reachable, or not signed in: a navigation goes through the login, then back here.
    setTimeout(() => location.reload(), 3000);
    return;
  }
  const { client } = attached;
  page = { client, version: client.release.version };
  const watch = telemetry(client);
  await start(client);
  connected("open");
  client.onReport((message) => {
    if (message.startsWith("Monchu is gone")) connection.value = "gone";
  });
  view(undefined)?.subscribe(() => watch.painted(performance.now()));
  client.record("web", "ready", { ms: Math.round(performance.now()) });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/sw.js")
      .catch(() => notice("offline shell unavailable", "warning"));
}

void boot();
