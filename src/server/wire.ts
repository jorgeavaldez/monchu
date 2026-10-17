import {
  createRemoteServiceEndpoint,
  createServiceStateEncoder,
  decodeServiceControlCall,
  parseServiceCall,
  parseServiceSubscriptionSnapshot,
  type RemoteServiceProvider,
  type ServiceProviderUpdate,
  type ServiceStateEncoder,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseMessage, type ToClient } from "../api/wire.ts";

/**
 * The core half of the wire for one connection: Chord's endpoint behind the JSON envelope. Each subscription has its
 * own path encoder, and its updates wait until its snapshot is sent, so the client decodes them in order.
 */
export function serveWire(
  provider: RemoteServiceProvider,
  send: (text: string) => void,
): { receive(text: string): void; dispose(): void } {
  const endpoint = createRemoteServiceEndpoint(provider);
  const subscriptions = new Map<
    string,
    { encoder: ServiceStateEncoder; pending: ServiceProviderUpdate[] | undefined }
  >();
  const message = (value: ToClient) => send(JSON.stringify(value));
  const sendUpdate = (
    subscription: string,
    encoder: ServiceStateEncoder,
    update: ServiceProviderUpdate,
  ) => {
    message({ t: "update", subscription, update: encoder.encodeUpdate(update) });
  };
  const publish = (subscriptionId: string, update: ServiceProviderUpdate) => {
    const subscription = subscriptions.get(subscriptionId);
    if (subscription === undefined) return;
    if (subscription.pending !== undefined) subscription.pending.push(update);
    else sendUpdate(subscriptionId, subscription.encoder, update);
  };
  return {
    receive(text) {
      const parsed = parseMessage(text);
      if (parsed?.t !== "invoke" || typeof parsed.id !== "number") return;
      const id = parsed.id;
      void (async () => {
        try {
          const call = parseServiceCall(parsed.call);
          const control = decodeServiceControlCall(call);
          if (control?.type === "subscribe")
            subscriptions.set(control.subscriptionId, {
              encoder: createServiceStateEncoder(),
              pending: [],
            });
          const value = await endpoint.invoke(call, publish, BACKGROUND_CONTEXT);
          if (control?.type === "subscribe") {
            const subscription = subscriptions.get(control.subscriptionId);
            if (subscription === undefined) return;
            message({
              t: "result",
              id,
              value: subscription.encoder.encodeSnapshot(parseServiceSubscriptionSnapshot(value)),
            });
            const waiting = subscription.pending ?? [];
            subscription.pending = undefined;
            for (const update of waiting)
              sendUpdate(control.subscriptionId, subscription.encoder, update);
            return;
          }
          if (control?.type === "unsubscribe") subscriptions.delete(control.subscriptionId);
          message(value === undefined ? { t: "result", id } : { t: "result", id, value });
        } catch (error) {
          message({
            t: "error",
            id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    dispose() {
      subscriptions.clear();
      endpoint.dispose();
    },
  };
}
