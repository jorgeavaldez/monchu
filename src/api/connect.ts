/**
 * A remote client that keeps itself connected: the same for a terminal on the local socket and a browser on the
 * WebSocket. The caller only dials a link; this connects a Chord client host over it, follows drops, and redials,
 * quickly at first. A reconnect re-holds every reference over the new link.
 */
import { createHost, type Link } from "@earendil-works/chord";
import { retry, Wake } from "./awake.ts";
import type { Principal } from "./contract.ts";
import { RemoteClient } from "./remote.ts";

/** What a client says when the core speaks another protocol: a web page reloads, a terminal must restart. */
export const OUTDATED_CORE = "Monchu's core speaks another protocol than this client: restart it";

/**
 * Connect a client through `dial`, or `undefined` when nothing answers the first time. After a drop it redials for 30
 * seconds of trying, or two minutes for an update (time the system slept through doesn't count), then says so through
 * the client's notices; `wake` makes its next try now. `onReconnect` hears each time the core answers again (a
 * redial, or a restarted core), with how long it was out of reach; `onError` hears a core that can't be used, such as
 * another protocol's.
 */
export async function connectRemote(
  dial: () => Promise<Link | undefined>,
  options: { onError: (error: Error) => void; onReconnect?: (ms: number) => void },
): Promise<{ client: RemoteClient; close: () => Promise<void>; wake: () => void } | undefined> {
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
  const wake = new Wake();
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
    const answered = await retry(
      async () => {
        const next = await dial();
        if (next === undefined) return false;
        try {
          // The client tells its own reconnect once the session answers again.
          await Promise.race([use(next), current.live()]);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (failure.message !== OUTDATED_CORE) return false;
          options.onError(failure);
          next.close();
        }
        return true;
      },
      { patience: () => current.patience(), stop: () => closing, wake },
    );
    if (!answered && !closing) current.gone();
  };
  const closed = use(link);
  // A core updated to newer contracts refuses this client's references until its code is new too.
  const opening = RemoteClient.open(host, () => options.onError(new Error(OUTDATED_CORE)));
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
    wake: () => wake.wake(),
    close: async () => {
      closing = true;
      client?.close();
      link?.close();
      await host.close();
    },
  };
}
