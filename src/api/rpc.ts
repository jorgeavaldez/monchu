/**
 * Monchu's wire between the core and a remote client: calls and watches as JSON messages, one per line on the local
 * socket and one per frame on a WebSocket. A watch sends a snapshot, then delta ops (Durable's own op format, through
 * the `chord/delta` it ships with). Browser-safe: every remote client uses the client half here; `src/server/rpc.ts`
 * is the core half.
 */
import {
  applyImmutable,
  decoder,
  type Decoder,
  type Op,
  type WireOp,
} from "@earendil-works/chord/delta";

/** Bumped on any change an older peer can't follow: a web page then reloads, a terminal must restart. */
export const PROTOCOL = 1;

/** A message from a client to the core. Args and keys are JSON; the core checks them before use. */
type ToCore =
  | { t: "hello"; protocol: number }
  | { t: "call"; id: number; method: string; args: unknown }
  | { t: "watch"; id: number; topic: string; key: unknown }
  | { t: "unwatch"; id: number };

/** A message from the core to a client. A watch's `ops` only follow its `snap`; `end` is its last message. */
export type ToClient =
  | { t: "hello"; protocol: number }
  | { t: "result"; id: number; value?: unknown }
  | { t: "error"; id: number; message: string }
  | { t: "snap"; id: number; value: unknown }
  | { t: "ops"; id: number; ops: WireOp[] }
  | { t: "end"; id: number; reason: string };

/** What a core says to a client that sends the old Chord envelope or skips the hello. */
export const OUTDATED_CLIENT =
  "This client is older than Monchu's core: reload the page or restart it";
/** What a client says when the core speaks another protocol. */
export const OUTDATED_CORE = "Monchu's core speaks another protocol than this client: restart it";

/** How long a client waits for the core's hello: an older core never answers it. */
const HELLO_TIMEOUT_MS = 5_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** One JSON object message, or `undefined` for anything else. */
export function parseMessage(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return record(value);
  } catch {
    return undefined;
  }
}

/** One open connection: send one message; the owner of the connection feeds received ones to `receive`. */
type Line = { send(text: string): void };

/** A value kept current from the core: the shape clients render from, the same as Durable's attached states. */
export interface Watched<T> {
  readonly value: T;
  /** Hears the current value once, soon, then every new one; returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
  dispose(): void;
}

/** A watch from `Rpc`: also says when the core ended it or refused it after a reconnect. */
export interface Watch<T> extends Watched<T> {
  /** Settles with the reason once the core ends this watch; never after `dispose`. */
  readonly ended: Promise<string>;
}

/**
 * A pending result or watch. Values arrive as JSON from the trusted core and are typed only, never checked: the
 * method's bivariant parameter is where a caller's `Promise<R>` takes the core's word for `R`.
 */
type Settle = { resolve(value: unknown): void; reject(error: Error): void };

/** A value the core keeps current, which outlives reconnects: it keeps its last value until a fresh snapshot. */
class RemoteWatch implements Watch<unknown> {
  private readonly listeners = new Set<(value: unknown) => void>();
  private decode: Decoder = decoder();
  private disposed = false;
  readonly ended: Promise<string>;
  end: (reason: string) => void = () => {};
  value: unknown;
  private readonly release: () => void;
  constructor(value: unknown, release: () => void) {
    this.value = value;
    this.release = release;
    this.ended = new Promise((resolve) => {
      this.end = resolve;
    });
  }

  snap(value: unknown): void {
    this.decode = decoder();
    this.publish(value);
  }

  ops(ops: readonly unknown[]): void {
    const decoded: Op[] = this.decode.decode(ops);
    this.publish(applyImmutable(this.value, decoded));
  }

  private publish(value: unknown): void {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }

  subscribe(listener: (value: unknown) => void): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      if (this.listeners.has(listener)) listener(this.value);
    });
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.release();
  }
}

/**
 * The client half: calls and watches over whatever connection is attached. When the connection drops, calls in flight
 * fail and watches keep their last value; `attach` with a new connection says hello again and rewatches them, and each
 * picks up from a fresh snapshot.
 */
export class Rpc {
  private line: Line | undefined;
  private nextId = 1;
  private readonly calls = new Map<number, Settle>();
  /** Live watches by id: what they watch, and their value once the first snapshot came. */
  private readonly watches = new Map<
    number,
    { topic: string; key: unknown; watch?: RemoteWatch; first?: Settle }
  >();
  private greeting: { settle: Settle; timer: ReturnType<typeof setTimeout> } | undefined;

  /**
   * Use this connection from now on: say hello, and rewatch every live watch. Resolves once the core answered with
   * the same protocol; rejects with `OUTDATED_CORE` otherwise.
   */
  attach(line: Line): Promise<void> {
    this.line = line;
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.greeted(undefined), HELLO_TIMEOUT_MS);
      this.greeting = { settle: { resolve: () => resolve(), reject }, timer };
    });
    this.send({ t: "hello", protocol: PROTOCOL });
    for (const [id, { topic, key }] of this.watches) this.send({ t: "watch", id, topic, key });
    return hello;
  }

  /** The connection is gone: fail what waits on it. Watches keep their values. */
  detach(reason: string): void {
    this.line = undefined;
    const error = new Error(reason);
    if (this.greeting !== undefined) {
      clearTimeout(this.greeting.timer);
      this.greeting.settle.reject(error);
      this.greeting = undefined;
    }
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
    for (const [id, entry] of this.watches) {
      if (entry.first === undefined) continue;
      // A watch that never had a value has nothing to keep.
      entry.first.reject(error);
      this.watches.delete(id);
    }
  }

  get connected(): boolean {
    return this.line !== undefined;
  }

  private send(message: ToCore): void {
    this.line?.send(JSON.stringify(message));
  }

  private greeted(protocol: number | undefined): void {
    const greeting = this.greeting;
    if (greeting === undefined) return;
    this.greeting = undefined;
    clearTimeout(greeting.timer);
    if (protocol === PROTOCOL) greeting.settle.resolve(undefined);
    else greeting.settle.reject(new Error(OUTDATED_CORE));
  }

  /** One message from the core. */
  receive(text: string): void {
    const message = parseMessage(text);
    if (message === undefined) return;
    if (message.t === "hello")
      return this.greeted(typeof message.protocol === "number" ? message.protocol : undefined);
    const id = typeof message.id === "number" ? message.id : -1;
    const call = this.calls.get(id);
    if (call !== undefined) {
      this.calls.delete(id);
      if (message.t === "error")
        call.reject(new Error(typeof message.message === "string" ? message.message : "Failed"));
      else call.resolve(message.value);
      return;
    }
    const entry = this.watches.get(id);
    if (entry === undefined) return;
    switch (message.t) {
      case "snap": {
        if (entry.watch !== undefined) return entry.watch.snap(message.value);
        entry.watch = new RemoteWatch(message.value, () => {
          if (this.watches.delete(id)) this.send({ t: "unwatch", id });
        });
        entry.first?.resolve(entry.watch);
        delete entry.first;
        return;
      }
      case "ops":
        if (Array.isArray(message.ops)) entry.watch?.ops(message.ops);
        return;
      case "error":
      case "end": {
        // Refused, or the core ended it: the last value stays readable, and no reconnect brings it back.
        this.watches.delete(id);
        const given = message.t === "end" ? message.reason : message.message;
        const reason = typeof given === "string" ? given : "ended";
        entry.first?.reject(new Error(reason));
        entry.watch?.end(reason);
        return;
      }
    }
  }

  /** Call a core method. Its result is typed by the caller's contract, not checked. */
  call<R>(method: string, args: unknown): Promise<R> {
    const line = this.line;
    if (line === undefined) return Promise.reject(new Error("Not connected to Monchu"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ t: "call", id, method, args });
    });
  }

  /** Watch a topic: resolves with its first snapshot. Its value type is the caller's contract, not checked. */
  watch<T>(topic: string, key: unknown): Promise<Watch<T>> {
    if (this.line === undefined) return Promise.reject(new Error("Not connected to Monchu"));
    const id = this.nextId++;
    return new Promise<Watch<T>>((resolve, reject) => {
      this.watches.set(id, { topic, key, first: { resolve, reject } });
      this.send({ t: "watch", id, topic, key });
    });
  }
}
