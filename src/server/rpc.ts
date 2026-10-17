/**
 * The core half of the wire for one connection: checks what a client sends, runs its calls, and serves its watches as
 * a snapshot, then delta ops, until it ends. `src/api/rpc.ts` holds the protocol and the client half.
 */
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { diffRevisions, encoder, type Op } from "@earendil-works/chord/delta";
import type { WatchHandle } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { OUTDATED_CLIENT, parseMessage, PROTOCOL, type ToClient } from "../api/rpc.ts";

/** One watch's values: a snapshot, then op batches from it, until the source ends or is stopped. */
export type Source = {
  /** The snapshot, sent before `start`. */
  readonly value: unknown;
  /** Called once, right after the snapshot is sent. */
  start(emit: (ops: readonly Op[]) => void, end: (reason: string) => void): void;
  stop(): void;
};

/** A Durable watch as a source: its acquisition revision, then each frame's ops. */
export function watchSource<T>(handle: WatchHandle<T>): Source {
  return {
    value: handle.value,
    start(emit, end) {
      handle.start(async (_value, ops) => emit(ops));
      void handle.closed.then((result) => {
        if (result.reason !== "stopped") end(result.reason);
      });
    },
    stop: () => void handle.stop(),
  };
}

/** A JSON copy the wire owns: core values stay the core's, and undefined properties drop as in JSON. */
const own = (value: unknown): JsonValue => copyJson(value, { omitUndefinedProperties: true });

/** One of Monchu's own values that watches follow: each change goes out as the ops from the last one. */
export class Published<T> {
  private json: JsonValue;
  private readonly watchers = new Set<{
    emit(ops: readonly Op[]): void;
    end(reason: string): void;
  }>();
  private ended: string | undefined;
  private current: T;

  constructor(current: T) {
    this.current = current;
    this.json = own(current);
  }

  get value(): T {
    return this.current;
  }

  set(value: T): void {
    const json = own(value);
    const ops = diffRevisions(this.json, json);
    this.current = value;
    this.json = json;
    if (ops.length > 0) for (const watcher of this.watchers) watcher.emit(ops);
  }

  /** No more values: every watch of it ends, and later ones end at once. */
  end(reason: string): void {
    this.ended = reason;
    for (const watcher of this.watchers) watcher.end(reason);
    this.watchers.clear();
  }

  source(): Source {
    let watcher: { emit(ops: readonly Op[]): void; end(reason: string): void } | undefined;
    return {
      value: this.json,
      start: (emit, end) => {
        if (this.ended !== undefined) return end(this.ended);
        watcher = { emit, end };
        this.watchers.add(watcher);
      },
      stop: () => {
        if (watcher !== undefined) this.watchers.delete(watcher);
      },
    };
  }
}

const Id = Type.Integer({ minimum: 0 });
const ToCoreSchema = Type.Union([
  Type.Object({ t: Type.Literal("hello"), protocol: Type.Integer() }),
  Type.Object({
    t: Type.Literal("call"),
    id: Id,
    method: Type.String(),
    args: Type.Array(Type.Unknown()),
  }),
  Type.Object({ t: Type.Literal("watch"), id: Id, topic: Type.String(), key: Type.Unknown() }),
  Type.Object({ t: Type.Literal("unwatch"), id: Id }),
]);

/** A contract: the argument schema of each method, and the key schema of each topic. */
type Contract = {
  methods: Record<string, TSchema>;
  topics: Record<string, TSchema>;
};

/** What a connection does with a contract's calls and watches, given args and keys that passed their schemas. */
export type Implementation<C extends Contract> = {
  methods: { [K in keyof C["methods"]]: (args: Static<C["methods"][K]>) => unknown };
  topics: {
    [K in keyof C["topics"]]: (key: Static<C["topics"][K]>) => Source | Promise<Source>;
  };
};

/** Own string keys only: a method named `constructor` or `__proto__` is not on the prototype's say-so. */
function keys<T extends object>(table: T): Extract<keyof T, string>[] {
  return Object.keys(table).filter((key): key is Extract<keyof T, string> =>
    Object.hasOwn(table, key),
  );
}

function checked<S extends TSchema, R>(
  schema: S,
  run: (value: Static<S>) => R,
): (value: unknown) => R {
  return (value) => {
    if (!Check(schema, value)) throw new Error("Invalid arguments");
    return run(value);
  };
}

function table<T extends Record<string, TSchema>, R>(
  schemas: T,
  runs: { [K in keyof T]: (value: Static<T[K]>) => R },
): Map<string, (value: unknown) => R> {
  const result = new Map<string, (value: unknown) => R>();
  for (const key of keys(schemas)) result.set(key, checked(schemas[key], runs[key]));
  return result;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Serve one connection: `send` writes one message to it, and its owner feeds received ones to `receive`. Nothing runs
 * before the client's hello names this protocol; a client that skips it, such as one on the old Chord envelope, gets
 * `OUTDATED_CLIENT` for each request it sends.
 */
export function serveRpc<C extends Contract>(
  contract: C,
  implementation: Implementation<C>,
  send: (text: string) => void,
): { receive(text: string): void; dispose(): void } {
  const methods = table<C["methods"], unknown>(contract.methods, implementation.methods);
  const topics = table<C["topics"], Source | Promise<Source>>(
    contract.topics,
    implementation.topics,
  );
  const watches = new Map<number, { source?: Source }>();
  let greeted: "no" | "yes" | "refused" = "no";
  let disposed = false;
  const message = (value: ToClient) => {
    if (!disposed) send(JSON.stringify(value));
  };

  async function call(id: number, method: string, args: unknown[]): Promise<void> {
    try {
      const run = methods.get(method);
      if (run === undefined) throw new Error(`Unknown method ${method}`);
      const value = await run(args);
      message(value === undefined ? { t: "result", id } : { t: "result", id, value: own(value) });
    } catch (error) {
      message({ t: "error", id, message: messageOf(error) });
    }
  }

  async function watch(id: number, topic: string, key: unknown): Promise<void> {
    if (watches.has(id)) return message({ t: "error", id, message: `Watch ${id} is open` });
    const entry: { source?: Source } = {};
    watches.set(id, entry);
    let source: Source;
    try {
      const open = topics.get(topic);
      if (open === undefined) throw new Error(`Unknown topic ${topic}`);
      source = await open(key);
    } catch (error) {
      if (watches.get(id) === entry) watches.delete(id);
      return message({ t: "error", id, message: messageOf(error) });
    }
    // Unwatched, or the connection went, while it opened.
    if (watches.get(id) !== entry || disposed) return source.stop();
    entry.source = source;
    const encode = encoder();
    message({ t: "snap", id, value: source.value });
    source.start(
      (ops) => {
        if (watches.get(id) === entry) message({ t: "ops", id, ops: encode.encode(ops) });
      },
      (reason) => {
        if (watches.get(id) !== entry) return;
        watches.delete(id);
        message({ t: "end", id, reason });
      },
    );
  }

  return {
    receive(text) {
      const parsed = parseMessage(text);
      if (greeted === "refused") return;
      if (!Check(ToCoreSchema, parsed)) {
        const id = parsed?.id;
        if (typeof id === "number")
          message({
            t: "error",
            id,
            message: greeted === "yes" ? "Invalid message" : OUTDATED_CLIENT,
          });
        return;
      }
      if (parsed.t === "hello") {
        message({ t: "hello", protocol: PROTOCOL });
        greeted = parsed.protocol === PROTOCOL ? "yes" : "refused";
        return;
      }
      if (greeted === "no") return message({ t: "error", id: parsed.id, message: OUTDATED_CLIENT });
      switch (parsed.t) {
        case "call":
          return void call(parsed.id, parsed.method, parsed.args);
        case "watch":
          return void watch(parsed.id, parsed.topic, parsed.key);
        case "unwatch": {
          const entry = watches.get(parsed.id);
          watches.delete(parsed.id);
          entry?.source?.stop();
          return;
        }
      }
    },
    dispose() {
      disposed = true;
      for (const entry of watches.values()) entry.source?.stop();
      watches.clear();
    },
  };
}
