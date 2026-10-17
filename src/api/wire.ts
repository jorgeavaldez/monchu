/**
 * The wire between the core and a remote client: Chord's service calls, snapshots and updates as JSON messages, one per
 * line on the local socket and one per frame on a WebSocket. Chord owns the semantics; this owns only the envelope and
 * the per-subscription path codecs. Browser-safe, so every client uses it.
 */
import {
  createServiceStateDecoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  isJsonValue,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  type Context,
  type JsonValue,
  type RemoteServiceTransport,
  type ServiceCall,
  type ServiceProviderUpdate,
  type ServiceSubscription,
  type WireServiceProviderUpdate,
  type WireServiceSubscriptionSnapshot,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** A message from a client to the core. */
type ToCore = { t: "invoke"; id: number; call: ServiceCall };

/** A message from the core to a client. */
export type ToClient =
  | { t: "result"; id: number; value?: JsonValue | WireServiceSubscriptionSnapshot }
  | { t: "error"; id: number; message: string }
  | { t: "update"; subscription: string; update: WireServiceProviderUpdate };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** One JSON message, or `undefined` for anything else. */
export function parseMessage(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return record(value);
  } catch {
    return undefined;
  }
}

/** One open connection: send one message; the owner of the connection feeds received ones to `receive`. */
export type Line = { send(text: string): void };

/**
 * The client half: a Chord `RemoteServiceTransport` over whatever connection is attached. When the connection drops,
 * calls in flight fail and subscriptions end; a binding `rebind` over a new connection resubscribes.
 */
export class WireTransport implements RemoteServiceTransport {
  private line: Line | undefined;
  private nextId = 1;
  private nextSubscription = 1;
  private readonly calls = new Map<
    number,
    { resolve(value: JsonValue | undefined): void; reject(error: Error): void }
  >();
  private readonly subscriptions = new Map<
    string,
    { deliver(update: JsonValue): void; end(): void }
  >();

  /** Use this connection from now on. */
  attach(line: Line): void {
    this.line = line;
  }

  /** The connection is gone: fail what waits on it. */
  detach(reason: string): void {
    this.line = undefined;
    for (const call of this.calls.values()) call.reject(new Error(reason));
    this.calls.clear();
    for (const subscription of this.subscriptions.values()) subscription.end();
    this.subscriptions.clear();
  }

  get connected(): boolean {
    return this.line !== undefined;
  }

  /** One message from the core. */
  receive(text: string): void {
    const message = parseMessage(text);
    if (message === undefined) return;
    if (message.t === "update") {
      const subscription = typeof message.subscription === "string" ? message.subscription : "";
      const update: unknown = message.update;
      if (isJsonValue(update)) this.subscriptions.get(subscription)?.deliver(update);
      return;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const call = this.calls.get(id);
    if (call === undefined) return;
    this.calls.delete(id);
    if (message.t === "error")
      call.reject(new Error(typeof message.message === "string" ? message.message : "Failed"));
    else {
      const value: unknown = message.value;
      call.resolve(value === undefined ? undefined : isJsonValue(value) ? value : null);
    }
  }

  invoke(call: ServiceCall, _context: Context): Promise<JsonValue | undefined> {
    const line = this.line;
    if (line === undefined) return Promise.reject(new Error("Not connected to Monchu"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      const message: ToCore = { t: "invoke", id, call };
      line.send(JSON.stringify(message));
    });
  }

  async subscribe(
    serviceId: string,
    mode: "singleton" | "keyed",
    listener: (update: ServiceProviderUpdate, context: Context) => void,
    context: Context,
  ): Promise<ServiceSubscription> {
    const subscriptionId = `s${this.nextSubscription++}`;
    const decoder = createServiceStateDecoder();
    // Updates can arrive before Chord activates the subscription; they wait, in order.
    let pending: JsonValue[] | undefined = [];
    const deliver = (update: JsonValue) =>
      listener(decoder.decodeUpdate(parseWireServiceProviderUpdate(update)), BACKGROUND_CONTEXT);
    this.subscriptions.set(subscriptionId, {
      deliver: (update) => (pending === undefined ? deliver(update) : pending.push(update)),
      // Only a singleton has an `unavailable` update; a binding's rebind tears keyed instances down.
      end: () => {
        if (mode === "singleton") listener({ type: "unavailable" }, BACKGROUND_CONTEXT);
      },
    });
    let result: JsonValue | undefined;
    try {
      result = await this.invoke(
        createServiceSubscribeCall(subscriptionId, serviceId, mode),
        context,
      );
    } catch (error) {
      this.subscriptions.delete(subscriptionId);
      throw error;
    }
    const snapshot = decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(result));
    return {
      snapshot,
      activate: () => {
        const waiting = pending ?? [];
        pending = undefined;
        for (const update of waiting) deliver(update);
      },
      close: async () => {
        if (!this.subscriptions.delete(subscriptionId)) return;
        // A dead connection has nothing left to close.
        await this.invoke(createServiceUnsubscribeCall(subscriptionId), BACKGROUND_CONTEXT).catch(
          () => {},
        );
      },
    };
  }
}
