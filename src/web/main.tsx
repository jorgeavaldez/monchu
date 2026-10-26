/** Connect to the core over the page's own WebSocket, then render. A dropped connection reconnects by itself. */
import { startPages } from "./pages.ts";
import { render } from "preact";
import { webSocketLink, type Link, type WebSocketLike } from "@earendil-works/chord";
import { Wake } from "../api/awake.ts";
import { connectRemote, OUTDATED_CORE } from "../api/connect.ts";
import type { RemoteClient } from "../api/remote.ts";
import { App } from "./app.tsx";
import { startClient } from "./client.tsx";
import { startSecrets } from "./secrets.tsx";
import { run } from "./commands.ts";
import {
  loginStatus,
  MCP_CALLBACK,
  notice,
  setConnection,
  setLinkError,
  start,
  view,
} from "./state.ts";
import { telemetry } from "./telemetry.ts";

/**
 * Whether the server answers at all. Browsers delay new WebSockets to an endpoint that just refused one, so a plain
 * request goes first while the core restarts; behind a tunnel a down origin answers 502 or 530.
 */
async function up(): Promise<boolean> {
  const response = await fetch("/", {
    method: "HEAD",
    cache: "no-store",
    // A network that went away under a sleeping phone can leave a request hanging long after it is back.
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
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

/** Every wait to connect again, cut short when the page is shown again or the network comes back. */
const wake = new Wake();
const sleep = (ms: number) => wake.wait(ms);

/** The wait before the next try: doubling from 2 s to 30 s, kept through reloads and cleared once the page is up. */
function backoff(): number {
  const wait = Math.min(Number(sessionStorage.getItem("wait") ?? 1000) * 2, 30_000);
  sessionStorage.setItem("wait", String(wait));
  return wait;
}

/** The page's link to the core, and when it last heard anything on it: the core pings every 15 s. */
let line: { link: Link; heard: number } | undefined;

async function dial(): Promise<Link | undefined> {
  if (!(await up())) return undefined;
  return new Promise((resolve) => {
    const opened = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`,
    );
    // Wrapped at once, so the core's first frames are never missed.
    const link = webSocketLink(socketLike(opened));
    const current = { link, heard: Date.now() };
    opened.addEventListener("message", () => {
      current.heard = Date.now();
    });
    const late = setTimeout(() => {
      opened.close();
      resolve(undefined);
    }, 10_000);
    opened.addEventListener("open", () => {
      clearTimeout(late);
      line = current;
      resolve(link);
    });
    // Refused or signed out: the page reloads into the login once the core is reachable again.
    opened.addEventListener("error", () => {
      clearTimeout(late);
      resolve(undefined);
    });
  });
}

/**
 * Back from a locked screen, the background or no network: try again now rather than at the next wait's end, and drop a
 * socket the core went quiet on. A phone's network can go away under a frozen page without the socket ever hearing,
 * and it would otherwise wait out its 45 s ping timeout looking connected.
 */
function resumed(): void {
  if (document.visibilityState !== "visible") return;
  wake.wake();
  page?.wake();
  const shown = line;
  // Frames a frozen page missed arrive just after it thaws: a link that is up has spoken by then.
  setTimeout(() => {
    // Closed here, not through the socket: a dead socket's closing handshake can take a minute to give up.
    if (
      shown === line &&
      shown !== undefined &&
      !shown.link.closed &&
      Date.now() - shown.heard > 20_000
    )
      shown.link.close("quiet");
  }, 2000);
}

/** The connected client, the core's version this page was loaded with, and a wake for its redial. */
let page: { client: RemoteClient; version: string; wake: () => void } | undefined;

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
        setLinkError(undefined);
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
    setLinkError(`${reason} · trying again in ${wait / 1000}s`);
    if (reason !== said) notice(`not connected · ${(said = reason)}`, "warning", true);
    await sleep(wait);
  }
}

/** Given up on: a fresh page holds everything anew, once the core answers again. */
let recovering = false;
async function recover(): Promise<void> {
  if (recovering) return;
  recovering = true;
  setConnection("gone");
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
    run("login.cancel");
  });
  addEventListener("visibilitychange", resumed);
  addEventListener("pageshow", resumed);
  addEventListener("online", resumed);
  document.addEventListener("resume", resumed);
  const { client, wake: redial } = await connect();
  page = { client, version: client.release.version, wake: redial };
  const watch = telemetry(client);
  // An update replaced the page's own files: load the new ones, once the new core says so.
  client.onRelease((release) => {
    if (release.updating === null && release.version !== page?.version) location.reload();
  });
  client.onConnection((state) => {
    setConnection(state);
    if (state === "gone") void recover();
  });
  await start(client);
  await startSecrets(client);
  startPages(client);
  setConnection(client.connected ? "live" : "lost");
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
