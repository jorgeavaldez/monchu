/**
 * The web client's state: what the page shows, which the views read, and the root it shows. Everything about a root
 * lives in its `Showing`, and the page reads only the one on screen. The page's state is written here and by its
 * intents (`intents.ts`), which the rest of the page reaches through `commands.ts`; every other module reads it.
 */
import { computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Attachment } from "../api/attachments.ts";
import type {
  Client,
  Draft,
  JobEvent,
  PinnedMessage,
  RootClient,
  RootSummary,
} from "../api/client.ts";
import type { WhenBusy } from "../api/notices.ts";
import { shortId } from "../api/ids.ts";
import { releaseNotices } from "../api/release.ts";
import type { Connection } from "../api/remote.ts";
import { formatJobEvent } from "../ui/jobs.ts";
import { loginHints } from "../ui/login.ts";
import type { Marks, MenuItem } from "./menu.tsx";
import { Showing, type Filter, type NoticeKind } from "./showing.ts";

export type { Filter } from "./showing.ts";

/** A line under the transcript; one with a `root` shows only while that root is shown. */
export type Notice = {
  id: number;
  at: number;
  text: string;
  kind: NoticeKind;
  root?: string;
  /** A job's event, which shows as a folded job box instead of a line. */
  job?: JobEvent;
  /** Per attached conversation, the newest entry it showed when this was posted (-1 for none); it follows that entry. */
  after: ReadonlyMap<ConversationView["conversation"]["id"], number>;
};

/** A choice the user makes over the editor, typing to filter: a login prompt, a model, a thinking level, a worker. */
export type Choice = {
  title: string;
  options: MenuItem[];
  /** What the filter starts with, such as `/model`'s search. */
  query?: string;
  choose(id: string, alternate: boolean): void;
  cancel(): void;
  /** The alternate action's label (Shift+Enter or the toggle), such as saving a model as the default. */
  alternate?: string;
  /** The rows a filter shows, in place of the menu's own matching: search ranks its own. */
  rows?: (query: string) => MenuItem[];
  /** How its rows mark what the filter matched, where it isn't each word's first place: search marks its own. */
  marks?: Marks;
  /** What an empty list says. */
  empty?: string;
  /** A style for the list: `search` gives the label the row and the detail a column after it. */
  class?: string;
  /** Asked for by the core, such as a provider's choice during a login: nothing the person opens replaces it. */
  requested?: boolean;
};

/** A typed answer the user gives in place of the editor: a login code, key or pasted URL. */
export type Ask = {
  title: string;
  secret: boolean;
  /** Asked for by the core, such as a login code: nothing the person opens replaces it. */
  requested?: boolean;
  placeholder?: string;
  answer(value: string): void;
  cancel(): void;
};

/** This server's page an MCP sign-in redirects to, and the channel it hands the redirect to the waiting page on. */
export const MCP_CALLBACK = "/mcp/callback";

/** The page's state that isn't any one root's. Only this module and the page's intents write it. */
export const page = {
  /** The link to the core, as the status bar's dot shows it; a drop and its redial never write to the transcript. */
  connection: signal<Connection | "connecting">("connecting"),
  /** Why the page is not connected, and when it tries again. */
  linkError: signal<string | undefined>(undefined),
  /** Every root, archived ones included, as the core reports them. */
  roots: signal<readonly RootSummary[]>([]),
  /** The panel open in place of the transcript, one at a time; Esc or ✕ closes it. */
  panel: signal<"client" | "secrets" | "goals" | "jobs" | "pins" | undefined>(undefined),
  notices: signal<readonly Notice[]>([]),
  mode: signal<WhenBusy>("followUp"),
  expandAll: signal(false),
  /** Counts expand-all presses: a card opened or closed by hand keeps that only until the next press. */
  expandPresses: signal(0),
  /** What Esc does in the prompt once nothing else takes it: stop the run (the terminal's way), or, with a key plugin, leave the prompt. */
  escapeLeaves: signal(false),
  /** Whether the editor's typeahead is open, for a page plugin's sense of what has the keys. */
  menuOpen: signal(false),
  /** A page plugin's passing hint, such as the keys that may follow a leader. */
  pageHint: signal<string | undefined>(undefined),
  /** A slash command begun from a key (`:`), with the draft it set aside and where focus was: Esc puts both back. */
  commandLine: signal<{ draft: string; fromPrompt: boolean } | undefined>(undefined),
  /** The prompt drafts set aside on this device, oldest first, from every client. */
  promptDrafts: signal<readonly Draft[]>([]),
  /** The messages pinned on this device, oldest first, from every client. */
  pins: signal<readonly PinnedMessage[]>([]),
  /** The words the pins panel starts filtering by, new with each `/pins`, even open, so each one starts afresh. */
  pinsQuery: signal({ text: "" }),
  /** What stands in for the editor: one pick or one typed answer at a time, never both. */
  standing: signal<{ kind: "pick"; pick: Choice } | { kind: "ask"; ask: Ask } | undefined>(
    undefined,
  ),
  /** What a login shows while it waits: its message, a link to open, a code to read. */
  loginStatus: signal<{ message: string; url?: string; code?: string } | undefined>(undefined),
  /** The newest job event this page heard, so the jobs panel lists them afresh. */
  jobEvent: signal(0),
  /** Bumped when the user sends a message, so the transcript goes back to its end and follows it. */
  following: signal(0),
  /** The editor's text, so a stopped front's queued messages can come back into it. Kept through a reload of the tab. */
  draft: signal(sessionStorage.getItem("draft") ?? ""),
  /** A queued message open in the editor: whose queue, its id, and the draft set aside for it. */
  editing: signal<{ name: string | undefined; id: number; draft: string } | undefined>(undefined),
};

type Reading<T> = {
  readonly [K in keyof T]: T[K] extends Signal<infer V> ? ReadonlySignal<V> : never;
};
const reading: Reading<typeof page> = page;
export const {
  connection,
  linkError,
  roots,
  panel,
  notices,
  mode,
  expandAll,
  expandPresses,
  escapeLeaves,
  menuOpen,
  pageHint,
  promptDrafts,
  pins,
  pinsQuery,
  loginStatus,
  jobEvent,
  following,
  draft,
  editing,
} = reading;

// What a reload of the tab brings back: the draft, or the one set aside while a queued message is open; that one stays
// queued.
effect(() => sessionStorage.setItem("draft", editing.value?.draft ?? draft.value));

/** The pick standing in for the editor, if that's what does. */
export const choice = computed(() =>
  page.standing.value?.kind === "pick" ? page.standing.value.pick : undefined,
);
/** The typed answer standing in for the editor, if that's what does. */
export const ask = computed(() =>
  page.standing.value?.kind === "ask" ? page.standing.value.ask : undefined,
);

/**
 * Take the editor's place for a pick or a question. What stands there now settles first, cancelled, so every one
 * opened resolves exactly once; but what the core asks during a login (`requested`) never gives way to the person's
 * own, which is refused instead (false).
 */
function claim(requested: boolean): boolean {
  const now = page.standing.value;
  const held = now?.kind === "pick" ? now.pick : now?.ask;
  if (held?.requested === true && !requested) return false;
  held?.cancel();
  return true;
}

/** The root on screen. */
const here = signal<Showing | undefined>(undefined);
const NONE: readonly never[] = [];
const ALL: Filter = {};
/** The root this page shows, by full id. */
export const rootId = computed(() => here.value?.id);
/** The conversation shown: the front (undefined) or a worker. */
export const shown = computed(() => here.value?.shown.value);
export const workers = computed(() => here.value?.workers.value ?? NONE);
/** The shown root's inbox: its front's messages with their labels. */
export const inbox = computed(() => here.value?.inbox.value ?? NONE);
/** What the front's stream shows. */
export const filter = computed(() => here.value?.filter.value ?? ALL);
/** The shown root's goals, for the goal filter and its briefer. */
export const goalList = computed(() => here.value?.goals.value ?? NONE);

/** What the person types; the editor's own. */
export function setDraft(text: string): void {
  page.draft.value = text;
}

/** Open a panel in place of the transcript, or close it. */
export function setPanel(name: (typeof page.panel)["value"]): void {
  page.panel.value = name;
}

/** The link's state, as the page's connection reports it. */
export function setConnection(state: Connection | "connecting"): void {
  page.connection.value = state;
}

/** Why the page isn't connected yet, while it tries again; undefined once it is. */
export function setLinkError(error: string | undefined): void {
  page.linkError.value = error;
}

/** For the editor: whether its typeahead is open. */
export function setMenuOpen(open: boolean): void {
  page.menuOpen.value = open;
}

/** For a page plugin: what Esc does in the prompt, and its passing hint. */
export function setEscapeLeaves(leaves: boolean): void {
  page.escapeLeaves.value = leaves;
}
export function setPageHint(text: string | undefined): void {
  page.pageHint.value = text;
}

/** Take the slash command begun from a key, ending it; undefined when none is under way. */
export function takeCommandLine(): (typeof page.commandLine)["value"] {
  const line = page.commandLine.value;
  page.commandLine.value = undefined;
  return line;
}

/** Put back a slash command `takeCommandLine` ended, as when a send it led to waits. */
export function keepCommandLine(line: (typeof page.commandLine)["value"]): void {
  page.commandLine.value = line;
}

let core: Client | undefined;
let nextNotice = 1;

export function client(): Client {
  if (core === undefined) throw new Error("Not connected");
  return core;
}

/**
 * The root on screen, for an intent to capture as it starts: its client and notices are that root's, and whatever it
 * writes there after the page moved on lands where nothing reads it.
 */
export function showing(): Showing {
  if (here.value === undefined) throw new Error("Not connected");
  return here.value;
}

/** The shown root's client, for a component's one call (read it as the call starts, never after an await). */
export function root(): RootClient {
  return showing().root;
}

/** A notice about the shown root, or with `home` one every root shows. */
export function notice(text: string, kind: NoticeKind = "system", home = false): void {
  rootNotice(text, kind, home ? undefined : rootId.value);
}

/** A notice that only `root` shows, or every root when undefined. */
function rootNotice(
  text: string,
  kind: NoticeKind,
  root: string | undefined,
  job?: JobEvent,
): void {
  const after = new Map<ConversationView["conversation"]["id"], number>();
  for (const each of here.value?.views.value.values() ?? []) {
    const value = each.state.value;
    after.set(value.conversation.id, value.entries.at(-1)?.id ?? -1);
  }
  page.notices.value = [
    ...page.notices.value,
    {
      id: nextNotice++,
      at: Date.now(),
      text,
      kind,
      after,
      ...(root === undefined ? {} : { root }),
      ...(job === undefined ? {} : { job }),
    },
  ].slice(-200);
}

/** The shown root's view of a conversation, once attached. */
export function view(name: string | undefined): Signal<ConversationView> | undefined {
  return here.value?.views.value.get(name ?? "")?.state;
}

/** Stores a file the user attaches, for the next message. */
export function attachFile(name: string, data: Uint8Array): Promise<Attachment> {
  return root().attach(name, data);
}

/** The text of a failed send was edited or cleared: whatever is sent next is a new message. */
export function forgetRetry(): void {
  sessionStorage.removeItem("retry");
}

/** The root a page load shows: the one in its address, else this tab's last, else the current root. */
async function initialRoot(connected: Client): Promise<string> {
  const asked = new URL(location.href).searchParams.get("root") ?? sessionStorage.getItem("root");
  if (asked !== null && asked !== "")
    try {
      return await connected.findRoot(asked);
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), "warning", true);
    }
  return connected.currentRoot();
}

/**
 * Show a root in this page: its front, crew, assessments and routing state, in place of the one shown. The address
 * names it, so a reload comes back here; `push` adds a history entry, so Back returns to the root before. Everything
 * it starts belongs to this showing: what arrives after another root is shown changes nothing on the page.
 */
export async function openRoot(id: string, push = false): Promise<void> {
  const connected = client();
  here.value?.close();
  const at = new Showing(id, connected.root(id), (text, kind) => rootNotice(text, kind, id));
  // A pick or question the person opened belongs to the root they left; the core's (a login) belongs to the connection.
  if (choice.value?.requested !== true) choice.value?.cancel();
  if (ask.value?.requested !== true) ask.value?.cancel();
  here.value = at;
  sessionStorage.setItem("root", id);
  const url = new URL(location.href);
  if (url.searchParams.get("root") !== id) {
    url.searchParams.set("root", id);
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  await at.attach(undefined);
  await at.refreshWorkers();
  const front = at.views.value.get("");
  let lastEntry = front?.state.value.entries.at(-1)?.id;
  let lastHead = front?.state.value.entries[0]?.id;
  if (front !== undefined)
    at.own(
      front.state.subscribe((value) => {
        // A compaction commits a new head marker, far above the reader; one shown on opening is not news.
        const head = value.entries[0];
        if (head !== undefined && head.id !== lastHead) {
          lastHead = head.id;
          if (head.kind === "pi.compaction") {
            const reason =
              typeof head.data === "object" && head.data !== null && "reason" in head.data
                ? head.data.reason
                : undefined;
            at.notice(`context compacted${typeof reason === "string" ? ` · ${reason}` : ""}`);
          }
        }
        const newest = value.entries.at(-1)?.id;
        if (newest === lastEntry) return;
        lastEntry = newest;
        void at.refreshWorkers().catch(() => {});
      }),
    );
  at.own(
    await at.root.watchInbox((items) => {
      at.inbox.value = items;
    }),
  );
  void at.refreshGoals().catch(() => {});
  // Plugins' lines from before this view opened stay unshown; their status lines show once now.
  let last: number | undefined;
  at.own(
    await at.root.watchNotices((items) => {
      for (const item of items)
        if (last !== undefined && item.id > last) at.notice(item.text, "event");
      last = Math.max(last ?? 0, ...items.map((item) => item.id));
    }),
  );
  for (const line of await at.root.statusLines()) at.notice(line, "event");
}

/** Bind to a connected client: attach the root, follow reports, assessments and job events. */
export async function start(connected: Client): Promise<void> {
  core = connected;
  // The terminal's first screen: the header, the core's startup notes, then what still needs a login.
  notice(`Monchu ${connected.release.version} · /help · home ${connected.home}`);
  for (const line of connected.notes) notice(line);
  let release = connected.release;
  for (const line of releaseNotices(undefined, release)) notice(line);
  connected.onRelease((next) => {
    for (const line of releaseNotices(release, next)) notice(line, "system", true);
    release = next;
  });
  for (const line of loginHints(await connected.loginNeeds(), true, connected.logins()))
    notice(line);
  await connected.watchRoots((list) => {
    page.roots.value = list;
  });
  await connected.watchPins((state) => {
    page.pins.value = state.items;
  });
  await connected.watchDrafts((state) => {
    page.promptDrafts.value = state.drafts;
  });
  await openRoot(await initialRoot(connected));
  // Back and Forward move between the roots this tab showed.
  addEventListener("popstate", () => {
    const id = new URL(location.href).searchParams.get("root");
    if (id !== null && id !== rootId.value)
      void openRoot(id).catch((error: unknown) =>
        notice(error instanceof Error ? error.message : String(error), "warning"),
      );
  });
  connected.onReport((message) => notice(message, "warning", true), { connection: false });
  await connected.watchJobEvents((await connected.jobs()).nextEvent - 1, (events) => {
    // Each job event shows in its own root; an event from before roots belongs to the first.
    const first = roots.value.reduce<RootSummary | undefined>(
      (oldest, each) => (oldest === undefined || each.createdAt < oldest.createdAt ? each : oldest),
      undefined,
    );
    page.jobEvent.value = Math.max(jobEvent.value, ...events.map((event) => event.id));
    for (const event of events)
      rootNotice(
        formatJobEvent(event),
        "event",
        event.rootId === undefined ? first?.id : shortId(event.rootId),
        event,
      );
  });
}

/** Put the caret at the end of the editor: focused within a tap, so a phone opens its keyboard. */
export function typeInEditor(): void {
  const area = document.querySelector("textarea");
  area?.focus();
  // The draft renders on the next frame.
  requestAnimationFrame(() => area?.setSelectionRange(area.value.length, area.value.length));
}

const inPrompt = (element: Element | null) =>
  element instanceof HTMLTextAreaElement && element.closest(".editor") !== null;

/** Whether the editor takes focus when it appears again; false once a question asked from the page is answered. */
let promptOnMount = true;

/** For the editor as it mounts: whether to take focus, once. */
export function focusOnMount(): boolean {
  const take = promptOnMount;
  promptOnMount = true;
  return take;
}

/**
 * Where focus goes when an overlay closes: back where it was when it opened, the prompt or the page, so leaving a pick
 * or a question never lands in the prompt by itself. Call it as the overlay opens; call what it returns as it closes.
 */
export function focusReturn(): () => void {
  const before = document.activeElement;
  const prompt = inPrompt(before);
  return () => {
    const area = document.querySelector<HTMLTextAreaElement>(".editor textarea");
    if (prompt) {
      // A question stands in for the editor, which focuses itself as it comes back.
      area?.focus();
      return;
    }
    if (area === null) promptOnMount = false;
    if (before instanceof HTMLElement && before !== document.body && before.isConnected)
      return before.focus({ preventScroll: true });
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  };
}

/** Pick one of `options` in place of the editor; resolves with its id, or `undefined` when cancelled. */
export function pick(
  title: string,
  options: Choice["options"],
  alternate?: string,
  query?: string,
  more: Pick<Choice, "rows" | "marks" | "empty" | "class" | "requested"> & {
    signal?: AbortSignal;
  } = {},
): Promise<{ id: string; alternate: boolean } | undefined> {
  if (!claim(more.requested === true)) {
    notice("finish the sign-in first", "warning");
    return Promise.resolve(undefined);
  }
  const { signal: ends, ...looks } = more;
  const back = focusReturn();
  return new Promise((resolve) => {
    // Settles once; a late call from a pick already replaced never touches the one shown now.
    let settled = false;
    const settle = (value: { id: string; alternate: boolean } | undefined) => {
      if (settled) return;
      settled = true;
      if (choice.value === mine) {
        page.standing.value = undefined;
        back();
      }
      resolve(value);
    };
    const mine: Choice = {
      title,
      options,
      ...(alternate === undefined ? {} : { alternate }),
      ...(query ? { query } : {}),
      ...looks,
      choose: (id, second) => settle({ id, alternate: second }),
      cancel: () => settle(undefined),
    };
    // A login that ends takes its choice with it.
    ends?.addEventListener("abort", () => settle(undefined), { once: true });
    page.standing.value = { kind: "pick", pick: mine };
  });
}

/** Ask for typed text in place of the editor; rejects when cancelled or `signal` aborts. */
export function prompted(
  title: string,
  secret: boolean,
  signal: AbortSignal,
  placeholder?: string,
  requested = true,
): Promise<string> {
  if (!claim(requested)) return Promise.reject(new Error("finish the sign-in first"));
  const back = focusReturn();
  return new Promise((resolve, reject) => {
    let mine: Ask | undefined;
    const close = () => {
      signal.removeEventListener("abort", cancel);
      if (ask.value !== mine) return;
      page.standing.value = undefined;
      back();
    };
    const cancel = () => {
      close();
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    mine = {
      title,
      secret,
      requested,
      ...(placeholder === undefined ? {} : { placeholder }),
      answer: (value) => {
        close();
        resolve(value);
      },
      cancel,
    };
    page.standing.value = { kind: "ask", ask: mine };
  });
}
