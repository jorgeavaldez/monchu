/**
 * A remote client that keeps itself connected: the same for a terminal on the local socket and a browser on the
 * WebSocket. The caller only dials; this attaches the wire, follows drops, and redials, quickly at first.
 */
import { RemoteClient } from "./remote.ts";
import { WireTransport } from "./wire.ts";

/** One open connection, whatever carries it. */
export type Connection = {
  send(text: string): void;
  close(): void;
  /** Install the handlers; messages before this are not expected. */
  listen(onMessage: (text: string) => void, onClose: () => void): void;
};

/** How long a client keeps trying after the core goes away: long enough for a restart. */
const RECONNECT_FOR_MS = 30_000;
/** The same while the core said it is updating: npm's install comes first. */
const UPDATE_RECONNECT_FOR_MS = 120_000;

/**
 * Connect a client through `dial`, or `undefined` when nothing answers the first time. After a drop it redials for 30
 * seconds, or two minutes for an update, then says so through the client's notices. `onReconnect` hears each successful redial with how long it took.
 */
export async function connectRemote(
  dial: () => Promise<Connection | undefined>,
  options: { onError(error: Error): void; onReconnect?(ms: number): void },
): Promise<{ client: RemoteClient; close(): Promise<void> } | undefined> {
  const transport = new WireTransport();
  let connection = await dial();
  if (connection === undefined) return undefined;
  let closing = false;
  let client: RemoteClient | undefined;
  const use = (connected: Connection) => {
    connection = connected;
    transport.attach({ send: (text) => connected.send(text) });
    connected.listen(
      (text) => transport.receive(text),
      () => void lost(),
    );
  };
  const lost = async () => {
    transport.detach("Connection to Monchu lost");
    if (closing || client === undefined) return;
    const started = Date.now();
    const waitMs = client.release.updating === null ? RECONNECT_FOR_MS : UPDATE_RECONNECT_FOR_MS;
    await client.disconnected();
    for (
      let delay = 50;
      Date.now() < started + waitMs && !closing;
      delay = Math.min(delay * 2, 1000)
    ) {
      await new Promise((wait) => setTimeout(wait, delay));
      const next = await dial();
      if (next === undefined) continue;
      use(next);
      try {
        await client.reconnected();
        options.onReconnect?.(Date.now() - started);
      } catch (error) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
        next.close();
      }
      return;
    }
    if (!closing) client.notice("Monchu is gone; start it again, then reload");
  };
  use(connection);
  try {
    client = await RemoteClient.open(transport, (error) => options.onError(error));
  } catch (error) {
    connection.close();
    throw error;
  }
  return {
    client,
    close: async () => {
      closing = true;
      await client?.close();
      connection?.close();
    },
  };
}
