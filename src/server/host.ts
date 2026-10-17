/**
 * The core's Chord host: it serves the backend to the facets as `Core` and loads them. Connections come in through
 * `socket.ts` and `web.ts`, which stamp each one's principal and hand its link to `accept`.
 */
import { createHost, webSocketLink, type Host, type WebSocketLike } from "@earendil-works/chord";
import { principalKey, type Principal } from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import session, { Core } from "./session.ts";

export type CoreHost = Host<Principal>;

/** Open the core's host over a running backend; the caller closes the host, then the backend. */
export async function openCoreHost(backend: Monchu): Promise<CoreHost> {
  const host = createHost<Principal>({
    name: "core",
    self: { kind: "core" },
    principalKey,
    onError: (error) =>
      backend.log.write("warn", "server.chord", "background failure", {
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  host.serve(
    Core,
    (_input, _principal, self) => ({
      monchu: self.expose(self.resource("monchu", { version: 1, open: () => backend })),
    }),
    { lifetime: "host" },
  );
  await host.load([{ name: "monchu.session", ...session }]);
  return host;
}

/** Calls one client may have running at once: far above what a person does, low enough to bound a runaway page. */
const MAX_CALLS = 64;

/**
 * Serve one authenticated client socket: every request on it acts as `principal`. Large payloads go out deflated, and
 * the client may not send packed frames (a small message could inflate to anything). Resolves when it closes.
 */
export function acceptClient(
  host: CoreHost,
  socket: WebSocketLike,
  principal: Principal,
): Promise<string> {
  const link = webSocketLink(socket, { compress: true, acceptPacked: false });
  const closed = new Promise<string>((done) => link.onClose(done));
  host.accept(link, { principal, kind: "client", maxCalls: MAX_CALLS });
  return closed;
}
