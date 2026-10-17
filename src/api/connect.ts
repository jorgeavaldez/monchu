/**
 * A remote client that keeps itself connected: the same for a terminal on the local socket and a browser on the
 * WebSocket. The caller only dials a link; this connects a Chord client host over it, follows drops, and redials,
 * quickly at first. A reconnect re-holds every reference over the new link.
 */
import { createHost, type Link } from "@earendil-works/chord";
import type { Principal } from "./contract.ts";
import { RemoteClient } from "./remote.ts";

/** What a client says when the core speaks another protocol: a web page reloads, a terminal must restart. */
export const OUTDATED_CORE = "Monchu's core speaks another protocol than this client: restart it";

/**
 * Connect a client through `dial`, or `undefined` when nothing answers the first time. After a drop it redials for 30
 * seconds, or two minutes for an update, then says so through the client's notices. `onReconnect` hears each
 * time the core answers again (a redial, or a restarted core), with how long it was out of reach; `onError` hears a core that can't be used, such as another protocol's.
 */
export async function connectRemote(
  dial: () => Promise<Link | undefined>,
  options: { onError: (error: Error) => void; onReconnect?: (ms: number) => void },
): Promise<{ client: RemoteClient; close: () => Promise<void> } | undefined> {
  let link = await dial();
  if (link === undefined) return undefined;
  const host = createHost<Principal>({
    name: "client",
    kind: "client",
    self: { kind: "core" },
    onError: () => {},
  });
  let closing = false;
  let reconnecting = false;
  let client: RemoteClient | undefined;
  /** Connect over `next`; the promise rejects once it closes, with `OUTDATED_CORE` for another protocol. */
  const use = (next: Link) => {
    link = next;
    let outdated = false;
    const closed = new Promise<never>((_resolve, reject) =>
      next.onClose((reason) => {
        if (reason.startsWith("protocol-version")) outdated = true;
        reject(new Error(outdated ? OUTDATED_CORE : "Connection to Monchu lost"));
        if (link === next && !outdated) void lost();
      }),
    );
    // The first failure is the caller's to read; later ones only end a wait.
    closed.catch(() => {});
    host.connect(next, {
      principal: { kind: "core" },
      onProtocolMismatch: () => {
        outdated = true;
      },
    });
    return closed;
  };
  const lost = async () => {
    if (closing || reconnecting || client === undefined) return;
    reconnecting = true;
    try {
      await reconnect(client);
    } finally {
      reconnecting = false;
    }
  };
  const reconnect = async (current: RemoteClient) => {
    const started = Date.now();
    const waitMs = current.patience();
    for (
      let delay = 50;
      Date.now() < started + waitMs && !closing;
      delay = Math.min(delay * 2, 1000)
    ) {
      await new Promise((wait) => setTimeout(wait, delay));
      const next = await dial();
      if (next === undefined) continue;
      try {
        // The client tells its own reconnect once the session answers again.
        await Promise.race([use(next), current.live()]);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (failure.message !== OUTDATED_CORE) continue;
        options.onError(failure);
        next.close();
      }
      return;
    }
    if (!closing) current.notice("Monchu is gone; start it again, then reload");
  };
  const closed = use(link);
  const opening = RemoteClient.open(host);
  // Whichever loses the race below must not reject unheard.
  opening.catch(() => {});
  try {
    client = await Promise.race([closed, opening]);
  } catch (error) {
    link.close();
    await host.close();
    throw error;
  }
  if (options.onReconnect !== undefined) client.onReconnect(options.onReconnect);
  return {
    client,
    close: async () => {
      closing = true;
      client?.close();
      link?.close();
      await host.close();
    },
  };
}
