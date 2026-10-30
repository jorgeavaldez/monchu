/**
 * One root as this page shows it: its client and everything the page holds about it. The page reads only the showing
 * of the root on screen, so a reply an older one receives after the page moved on lands where nothing reads it, and
 * nothing from a root that is no longer shown ever changes the page. What a showing subscribes to stops when it
 * closes; a subscription that arrives after that stops at once.
 */
import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { Goal, InboxItem, RootClient, WorkerSummary } from "../api/client.ts";

/**
 * What the front's stream shows: every message, or only one kind, one goal's, or both. `reply` keeps the front's replies
 * with the person's messages they answer.
 */
export type Filter = { kind?: "ask" | "milestone" | "update" | "reply"; goal?: string };

/** How a notice shows: a plain line, a warning, or something that happened. */
export type NoticeKind = "system" | "warning" | "event";

/**
 * What a conversation said outside its view's active context, as far back as the page loaded it: oldest first, whether
 * older remains, and whether a page is on its way.
 */
export type Earlier = { entries: readonly EntryRecord[]; more: boolean; loading: boolean };

/**
 * A conversation's view, attached on first use and kept while its root is shown: its active context (`state`), what was
 * said before it (`earlier`), and both as one transcript (`whole`).
 */
type Attached = {
  state: Signal<ConversationView>;
  earlier: Signal<Earlier>;
  whole: ReadonlySignal<ConversationView>;
};

/** The view's context marker, when it has one: everything said before it that the view doesn't hold is history. */
function marker(view: ConversationView): EntryRecord | undefined {
  const head = view.entries[0];
  return head?.head === undefined ? undefined : head;
}

/** Whether the view holds an entry: its marker, or another entry from where its context starts. */
function holds(view: ConversationView, entry: EntryRecord): boolean {
  const head = marker(view);
  if (head === undefined) return true;
  return entry.id === head.id || (entry.head === undefined && entry.id >= (head.head ?? 0));
}

/** Both lists' entries once each, oldest first. */
function merge(some: readonly EntryRecord[], more: readonly EntryRecord[]): readonly EntryRecord[] {
  const known = new Set(some.map((entry) => entry.id));
  return [...some, ...more.filter((entry) => !known.has(entry.id))].toSorted((x, y) => x.id - y.id);
}

/**
 * What was said before a view, in the order a transcript shows it. A context marker goes where its context starts, just
 * above the first entry it kept, so it divides what the model still sees from what it no longer does; all of it sits
 * above the view, whose own marker heads it.
 */
function ordered(earlier: readonly EntryRecord[]): readonly EntryRecord[] {
  const place = (entry: EntryRecord) => (entry.head === undefined ? entry.id : entry.head - 0.5);
  return earlier.toSorted((x, y) => place(x) - place(y));
}

export class Showing {
  /** The conversation shown: the front (undefined) or a worker. */
  readonly shown = signal<string | undefined>(undefined);
  readonly workers = signal<readonly WorkerSummary[]>([]);
  /** The front's messages with their labels. */
  readonly inbox = signal<readonly InboxItem[]>([]);
  readonly filter = signal<Filter>({});
  /** The root's goals, each with whether it changed since the person last looked: the goals menu and the goal card. */
  readonly goals = signal<readonly (Goal & { changed: boolean })[]>([]);
  /** Attached views by conversation; a signal itself, so a view attached later re-renders whoever asked for it. */
  readonly views = signal<ReadonlyMap<string, Attached>>(new Map());
  #open = true;
  #stops: (() => void)[] = [];
  /** The history loads in turn, so each starts where the last left off. */
  #loads = Promise.resolve();

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
    const earlier = signal<Earlier>({
      entries: [],
      more: marker(attached.value) !== undefined,
      loading: false,
    });
    const stop = attached.subscribe((value) => {
      const before = state.peek();
      const head = marker(value);
      // A new context marker drops entries from the view; the page keeps them as history, and loads what was said
      // between the last entry it saw and the marker, as after a reconnect that skipped ahead.
      if (head !== undefined && head.id !== before.entries[0]?.id) {
        const known = earlier.peek();
        const dropped = before.entries.filter((entry) => !holds(value, entry));
        earlier.value = { ...known, entries: merge(known.entries, dropped) };
        const seen = Math.max(0, ...before.entries.map((entry) => entry.id));
        void this.#queue(() => this.#fill(name, seen, head.id)).catch((error: unknown) =>
          this.notice(
            `history: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          ),
        );
      }
      state.value = value;
    });
    const attachedHere = this.own(() => {
      stop();
      attached.dispose();
    });
    const above = computed(() => ordered(earlier.value.entries));
    if (attachedHere)
      this.views.value = new Map(this.views.value).set(key, {
        state,
        earlier,
        whole: computed(() => {
          const before = above.value;
          const view = state.value;
          return before.length === 0 ? view : { ...view, entries: [...before, ...view.entries] };
        }),
      });
  }

  /**
   * Load what a conversation said before its view: one page more, or with `until`, back to that entry. Loads run one at a
   * time, each from where the last one left off; nothing loads once the start is loaded.
   */
  loadEarlier(name: string | undefined, until?: number): Promise<void> {
    return this.#queue(() => this.#loadEarlier(name, until));
  }

  #queue(load: () => Promise<void>): Promise<void> {
    const done = this.#loads.then(load);
    this.#loads = done.catch(() => {});
    return done;
  }

  async #loadEarlier(name: string | undefined, until: number | undefined): Promise<void> {
    const attached = this.views.value.get(name ?? "");
    if (attached === undefined) return;
    const { earlier, state } = attached;
    for (let pages = 0; this.#open; pages++) {
      const known = earlier.value;
      const before = known.entries[0]?.id ?? marker(state.value)?.id;
      if (!known.more || before === undefined) return;
      if (until === undefined ? pages > 0 : before <= until) return;
      if (state.value.entries.some((entry) => entry.id === until)) return;
      earlier.value = { ...known, loading: true };
      try {
        const page = await this.root.history(before, name);
        const now = earlier.value;
        earlier.value = {
          entries: merge(
            now.entries,
            page.entries.filter((entry) => !holds(state.value, entry)),
          ),
          more: page.more,
          loading: false,
        };
      } catch (error) {
        earlier.value = { ...earlier.value, loading: false };
        throw error;
      }
    }
  }

  /** Load the history said after entry `after` and before `before`, newest page first, that the view doesn't hold. */
  async #fill(name: string | undefined, after: number, before: number): Promise<void> {
    const attached = this.views.value.get(name ?? "");
    if (attached === undefined) return;
    const { earlier, state } = attached;
    for (let next = before; next > after + 1 && this.#open;) {
      const page = await this.root.history(next, name);
      const found = page.entries.filter((entry) => entry.id > after && !holds(state.value, entry));
      earlier.value = { ...earlier.value, entries: merge(earlier.value.entries, found) };
      const oldest = page.entries[0]?.id;
      if (!page.more || oldest === undefined) return;
      next = oldest;
    }
  }

  async refreshWorkers(): Promise<void> {
    this.workers.value = await this.root.workers();
  }

  /** Read the goals again; a read that a newer one overtook changes nothing. */
  async refreshGoals(): Promise<void> {
    const read = ++this.#goalsRead;
    const goals = await this.root.goals();
    if (read === this.#goalsRead) this.goals.value = goals;
  }
  #goalsRead = 0;
}
