/** Connect to the core over the page's own WebSocket, then render. A dropped connection reconnects by itself. */
import { render } from "preact";
import { webSocketLink, type Link, type WebSocketLike } from "@earendil-works/chord";
import { connectRemote, OUTDATED_CORE } from "../api/connect.ts";
import type { RemoteClient } from "../api/remote.ts";
import { App } from "./app.tsx";
import { startClient } from "./client.tsx";
import { startSecrets } from "./secrets.tsx";
import {
  cancelLogin,
  connection,
  linkError,
  loginStatus,
  MCP_CALLBACK,
  notice,
  start,
  view,
} from "./state.ts";
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

const sleep = (ms: number) => new Promise((wait) => setTimeout(wait, ms));

/** The wait before the next try: doubling from 2 s to 30 s, kept through reloads and cleared once the page is up. */
function backoff(): number {
  const wait = Math.min(Number(sessionStorage.getItem("wait") ?? 1000) * 2, 30_000);
  sessionStorage.setItem("wait", String(wait));
  return wait;
}

async function dial(): Promise<Link | undefined> {
  if (!(await up())) return undefined;
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`,
    );
    // Wrapped at once, so the core's first frames are never missed.
    const link = webSocketLink(socketLike(socket));
    socket.addEventListener("open", () => resolve(link));
    // Refused or signed out: the page reloads into the login once the core is reachable again.
    socket.addEventListener("error", () => resolve(undefined));
  });
}

/** The connected client, and the core's version this page was loaded with. */
let page: { client: RemoteClient; version: string } | undefined;

const options = {
  // A core that came back on another protocol or newer contracts, or from an update, serves a newer page: load it.
  onError: (error: Error) => {
    if (error.message === OUTDATED_CORE) location.reload();
    else if (page !== undefined && page.client.release.updating !== null) location.reload();
  },
  onReconnect: (ms: number) => page?.client.record("web", "reconnected", { ms }),
};

/**
 * Connect, or say why not and try again, waiting longer each time. The test is the core answering, not just the
 * server: a core that can't start (or is being installed) is said here and asked again, never reloaded into. Only a
 * socket the answering server refused (signed out) reloads, through the login.
 */
async function connect(): Promise<NonNullable<Awaited<ReturnType<typeof connectRemote>>>> {
  let said = "";
  for (;;) {
    let reason = "Monchu's server doesn't answer";
    try {
      const attached = await connectRemote(dial, options);
      if (attached !== undefined) {
        linkError.value = undefined;
        return attached;
      }
      if (await up()) {
        await sleep(backoff());
        location.reload();
        return new Promise(() => {});
      }
    } catch (error) {
      if (error instanceof Error && error.message === OUTDATED_CORE) location.reload();
      // The server's own wait is the page's to say, as its next try.
      reason = (error instanceof Error ? error.message : String(error))
        .replace(/^[a-z_]+: /, "")
        .replace(/ · next try in \d+s$/, "");
    }
    const wait = backoff();
    linkError.value = `${reason} · trying again in ${wait / 1000}s`;
    if (reason !== said) notice(`not connected · ${(said = reason)}`, "warning", true);
    await sleep(wait);
  }
}

/** Given up on: a fresh page holds everything anew, once the core answers again. */
let recovering = false;
async function recover(): Promise<void> {
  if (recovering) return;
  recovering = true;
  connection.value = "gone";
  await sleep(backoff());
  await (await connect()).close();
  location.reload();
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) return;
  if (location.pathname === MCP_CALLBACK) {
    // An MCP sign-in came back: the page that started it takes it from here.
    new BroadcastChannel(MCP_CALLBACK).postMessage(location.href);
    root.textContent = "Back to Monchu to finish signing in.";
    return;
  }
  startClient();
  render(<App />, root);
  // As in the terminal, Esc cancels a login wherever focus is, such as while a device code waits.
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || loginStatus.value === undefined) return;
    event.preventDefault();
    cancelLogin();
  });
  const { client } = await connect();
  page = { client, version: client.release.version };
  const watch = telemetry(client);
  // An update replaced the page's own files: load the new ones, once the new core says so.
  client.onRelease((release) => {
    if (release.updating === null && release.version !== page?.version) location.reload();
  });
  client.onConnection((state) => {
    connection.value = state;
    if (state === "gone") void recover();
  });
  await start(client);
  await startSecrets(client);
  connection.value = client.connected ? "live" : "lost";
  sessionStorage.removeItem("wait");
  view(undefined)?.subscribe(() => watch.painted(performance.now()));
  client.record("web", "ready", { ms: Math.round(performance.now()) });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/sw.js")
      .catch(() => notice("offline shell unavailable", "warning"));
}

// A page that connected but couldn't start tries again with a fresh load once the core answers, waiting longer each time.
void boot().catch(recover);
