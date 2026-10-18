/**
 * A reference that outlasts the core it reaches. Chord itself re-holds references when a client's link reconnects;
 * when the core process behind the server is replaced (`/restart`), the server's link stays up and its references
 * become `gone` instead. A lasting one gets its object again from the new core, and its state keeps the last value
 * until the fresh snapshot arrives. Browser-safe.
 */
import {
  isChordError,
  type AnyContract,
  type GetOptions,
  type Host,
  type InputOf,
  type Readable,
  type Ref,
} from "@earendil-works/chord";
import type { Watched } from "./client.ts";
import type { Principal } from "./contract.ts";

/** Whether the object answers now (`live`), is being reached again (`lost`), or was asked for in vain (`gone`). */
export type Reach = "live" | "lost" | "gone";

/** How long a lost object is asked for before it counts as gone: long enough for a restart. */
const REGAIN_FOR_MS = 30_000;
/** The same while the core said it is updating: npm's install comes first. */
const UPDATE_REGAIN_FOR_MS = 120_000;

export class Lasting<C extends AnyContract> {
  private current: Ref<C>;
  private readonly host: Host<Principal>;
  private readonly type: C;
  private readonly input: InputOf<C>;
  private readonly options: GetOptions<Principal>;
  private readonly refs = new Set<(ref: Ref<C>) => void>();
  private readonly reaches = new Set<(reach: Reach) => void>();
  private stopStatus: () => void;
  private regaining = false;
  private closed = false;
  /** How long to keep asking once lost; the session says longer while an update installs. */
  patience: () => number = () => REGAIN_FOR_MS;
  /** The core runs a newer contract than this client's: asking again can't help, the client's code must change. */
  onOutdated: () => void = () => {};

  private constructor(
    host: Host<Principal>,
    type: C,
    input: InputOf<C>,
    options: GetOptions<Principal>,
    ref: Ref<C>,
  ) {
    this.host = host;
    this.type = type;
    this.input = input;
    this.options = options;
    this.current = ref;
    this.stopStatus = this.follow(ref);
  }

  /** Get the object once; later losses are recovered by themselves. */
  static async open<C extends AnyContract>(
    host: Host<Principal>,
    type: C,
    input: InputOf<C>,
    options: GetOptions<Principal> = {},
  ): Promise<Lasting<C>> {
    return new Lasting(host, type, input, options, await host.get(type, input, options));
  }

  get ref(): Ref<C> {
    return this.current;
  }

  get reach(): Reach {
    return this.current.status === "live" ? "live" : "lost";
  }

  /** Hears each change between live and lost; returns an unsubscribe function. */
  onReach(listener: (reach: Reach) => void): () => void {
    this.reaches.add(listener);
    return () => this.reaches.delete(listener);
  }

  /** Resolves once the object answers again. */
  live(): Promise<void> {
    if (this.reach === "live") return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.onReach((reach) => {
        if (reach !== "live") return;
        stop();
        resolve();
      });
    });
  }

  private tell(reach: Reach): void {
    for (const listener of this.reaches) listener(reach);
  }

  private follow(ref: Ref<C>): () => void {
    return ref.onStatus((status, error) => {
      if (this.closed || ref !== this.current) return;
      if (status === "live") this.tell("live");
      else if (status === "loading") this.tell("lost");
      else if (isChordError(error, "upgrade_required")) this.onOutdated();
      else {
        // Gone, or released by the other side (this one stops following before it releases its own).
        this.tell("lost");
        void this.regain();
      }
    });
  }

  /** Ask again, quickly at first, until the new core answers or patience runs out, which says `gone`. */
  private async regain(): Promise<void> {
    if (this.regaining) return;
    this.regaining = true;
    const until = Date.now() + this.patience();
    try {
      for (let delay = 50; !this.closed && Date.now() < until; delay = Math.min(delay * 2, 1000)) {
        await new Promise((wait) => setTimeout(wait, delay));
        if (this.closed) return;
        let outdated = false;
        const ref = await this.host
          .get(this.type, this.input, { ...this.options, signal: AbortSignal.timeout(10_000) })
          .catch((error: unknown) => {
            outdated = isChordError(error, "upgrade_required");
            return undefined;
          });
        if (outdated) return this.onOutdated();
        if (ref === undefined) continue;
        if (this.closed) return ref.release();
        this.stopStatus();
        this.current.release();
        this.current = ref;
        this.stopStatus = this.follow(ref);
        for (const listener of this.refs) listener(ref);
        this.tell(ref.status === "live" ? "live" : "lost");
        return;
      }
      if (!this.closed) this.tell("gone");
    } finally {
      this.regaining = false;
    }
  }

  /**
   * One state member across every reference this gets: the last value stays readable while lost, and a new
   * reference's snapshot replaces it. `dispose` releases the whole lasting reference when `owned`.
   */
  state<T>(pick: (ref: Ref<C>) => Readable<T>, owned = false): Watched<T> {
    let last = pick(this.current).value;
    const listeners = new Set<(value: T) => void>();
    const publish = (value: T) => {
      last = value;
      for (const listener of listeners) listener(value);
    };
    let stop = pick(this.current).subscribe(publish);
    const swap = (ref: Ref<C>) => {
      stop();
      stop = pick(ref).subscribe(publish);
    };
    this.refs.add(swap);
    return {
      get value() {
        return last;
      },
      subscribe(listener) {
        listeners.add(listener);
        queueMicrotask(() => {
          if (listeners.has(listener)) listener(last);
        });
        return () => listeners.delete(listener);
      },
      dispose: () => {
        listeners.clear();
        stop();
        this.refs.delete(swap);
        if (owned) this.release();
      },
    };
  }

  release(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopStatus();
    this.refs.clear();
    this.reaches.clear();
    this.current.release();
  }
}

export { UPDATE_REGAIN_FOR_MS };
