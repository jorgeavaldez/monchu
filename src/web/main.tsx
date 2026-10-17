/** Connect to the core over the page's own WebSocket, then render. A dropped connection reconnects by itself. */
import { render } from "preact";
import { connectRemote, type Connection } from "../api/connect.ts";
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

async function dial(): Promise<Connection | undefined> {
  if (!(await up())) return undefined;
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`,
    );
    socket.addEventListener("open", () =>
      resolve({
        send: (text) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        close: () => socket.close(),
        listen: (onMessage, onClose) => {
          socket.addEventListener("message", (event) => {
            const data: unknown = event.data;
            if (typeof data === "string") onMessage(data);
          });
          socket.addEventListener("close", () => {
            connected("lost");
            onClose();
          });
        },
      }),
    );
    // Refused or signed out: the page reloads into the login once the core is reachable again.
    socket.addEventListener("error", () => resolve(undefined));
  });
}

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
    onError: () => {},
    onReconnect: (ms) => {
      connected("open");
      attached?.client.record("web", "reconnected", { ms });
    },
  });
  if (attached === undefined) {
    connection.value = "gone";
    // Not reachable, or not signed in: a navigation goes through the login, then back here.
    setTimeout(() => location.reload(), 3000);
    return;
  }
  const { client } = attached;
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
