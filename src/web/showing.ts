/**
 * One root as this page shows it: its client and everything the page holds about it. The page reads only the showing
 * of the root on screen, so a reply an older one receives after the page moved on lands where nothing reads it, and
 * nothing from a root that is no longer shown ever changes the page. What a showing subscribes to stops when it
 * closes; a subscription that arrives after that stops at once.
 */
import { signal, type Signal } from "@preact/signals";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Goal, InboxItem, RootClient, WorkerSummary } from "../api/client.ts";

/** What the front's stream shows: every message, or only one kind, one goal's, or both. */
export type Filter = { kind?: "ask" | "milestone" | "update"; goal?: string };

/** How a notice shows: a plain line, a warning, or something that happened. */
export type NoticeKind = "system" | "warning" | "event";

/** A conversation's view, attached on first use and kept while its root is shown. */
type Attached = { state: Signal<ConversationView> };

export class Showing {
  /** The conversation shown: the front (undefined) or a worker. */
  readonly shown = signal<string | undefined>(undefined);
  readonly workers = signal<readonly WorkerSummary[]>([]);
  /** The front's messages with their labels. */
  readonly inbox = signal<readonly InboxItem[]>([]);
  readonly filter = signal<Filter>({});
  /** The root's goals, for the goal filter and its briefer. */
  readonly goals = signal<readonly Goal[]>([]);
  /** Attached views by conversation; a signal itself, so a view attached later re-renders whoever asked for it. */
  readonly views = signal<ReadonlyMap<string, Attached>>(new Map());
  #open = true;
  #stops: (() => void)[] = [];

  readonly id: string;
  readonly root: RootClient;
  readonly #post: (text: string, kind: NoticeKind) => void;

  /** Root `id` through `root`; its notices go to `post`. */
  constructor(id: string, root: RootClient, post: (text: string, kind: NoticeKind) => void) {
    this.id = id;
    this.root = root;
    this.#post = post;
  }

  /** Whether this root is still the one shown. */
  get open(): boolean {
    return this.#open;
  }

  /** Stop `stop` when this showing closes, or now if it already has; false when it has. */
  own(stop: () => void): boolean {
    if (this.#open) this.#stops.push(stop);
    else stop();
    return this.#open;
  }

  /** A notice under this root's feed, while it is shown; one arriving after the page moved on is dropped. */
  notice(text: string, kind: NoticeKind = "system"): void {
    if (this.#open) this.#post(text, kind);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    for (const stop of this.#stops.splice(0)) stop();
  }

  /** Attach a conversation's view once; a second ask while the first is on its way waits for nothing. */
  async attach(name: string | undefined): Promise<void> {
    const key = name ?? "";
    if (this.views.value.has(key)) return;
    const attached = await this.root.viewState(name);
    if (this.views.value.has(key)) return attached.dispose();
    const state = signal(attached.value);
    const stop = attached.subscribe((value) => {
      state.value = value;
    });
    const attachedHere = this.own(() => {
      stop();
      attached.dispose();
    });
    if (attachedHere) this.views.value = new Map(this.views.value).set(key, { state });
  }

  async refreshWorkers(): Promise<void> {
    this.workers.value = await this.root.workers();
  }

  async refreshGoals(): Promise<void> {
    this.goals.value = await this.root.goals();
  }
}
