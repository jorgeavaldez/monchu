/**
 * What the page can do, in one place: the slash commands (the core's, skills, and this page's own), and the page's
 * actions, which every control runs through one executor (`run`). The palette lists them all, `/keys` lists the keys,
 * and `/search` finds a message in the feed on screen. A key plugin binds keys to these actions; nothing here needs one.
 */
import type { Attachment } from "../api/attachments.ts";
import type { Client, QueueChange } from "../api/client.ts";
import { clientCommands } from "../ui/commands.ts";
import { clock } from "../ui/ids.ts";
import { listedRoots } from "../ui/roots.ts";
import { presentation, type QueuedItem } from "../ui/state.ts";
import { signal } from "@preact/signals";
import { openClient } from "./client.tsx";
import { feedRows, jumpTo, scrollFeed, type ScrollKind } from "./feed.ts";
import { ranges, search, snippet } from "./fuzzy.ts";
// oxlint-disable-next-line no-restricted-imports -- this is the executor, the one module that runs intents.
import {
  archiveRoot,
  beginEdit,
  cancelLogin,
  clearFilter,
  editQueued,
  endEdit,
  filterKind,
  interrupt,
  loggingIn,
  newRoot,
  openDrafts,
  pickGoal,
  renameRoot,
  replyDraft,
  send,
  show,
  startCommandLine,
  submit,
  switchRoot,
  toggleExpandAll,
  toggleMode,
  togglePin,
  toggleRoots,
  unpin,
} from "./intents.ts";
import type { MenuItem } from "./menu.tsx";
import { openSecrets } from "./secrets.tsx";
import {
  client,
  connection,
  editing,
  escapeLeaves,
  type Filter,
  filter,
  notice,
  pick,
  rootId,
  roots,
  setDraft,
  setPanel,
  shown,
  typeInEditor,
  view,
} from "./state.ts";

const command = (label: string, usage: string, detail: string): MenuItem => ({
  id: label,
  label,
  usage,
  detail,
});

/** Commands only this page has, run here and never sent to the core. */
const WEB_COMMANDS: { item: MenuItem; run: (text: string) => unknown }[] = [
  {
    item: command("/palette", "", "web only · every action and command"),
    run: () => openPalette(),
  },
  {
    item: command("/search", "[text]", "web only · find a message in this feed"),
    run: (text) => openSearch(text),
  },
  { item: command("/keys", "", "web only · keys and what they do"), run: () => openKeys() },
  {
    item: command("/client", "", "web only · this client: app name, install, theme"),
    run: () => openClient(),
  },
  {
    item: command(
      "/secrets",
      "",
      "web only · secrets agents use by name: requests, add, replace, delete",
    ),
    run: () => openSecrets(),
  },
];

/** Every slash command: the core's and skills once a client is there, this page's own always. */
export function slashCommands(core: Client | undefined): MenuItem[] {
  return [
    ...(core === undefined ? [] : clientCommands("web", core.commands())).map(
      ([name, { usage, help }]) => command(name, usage, help),
    ),
    ...WEB_COMMANDS.map((each) => each.item),
    ...(core?.skills() ?? []).map((skill) =>
      command(`/skill:${skill.name}`, "[text]", skill.description),
    ),
  ];
}

/** Run `text` when it is one of this page's commands; false when it isn't, so it goes to the core. */
export function runWebCommand(text: string): boolean {
  const line = text.trim();
  const name = line.split(/\s/, 1)[0] ?? "";
  const found = WEB_COMMANDS.find((each) => each.item.label === name);
  if (found === undefined) return false;
  void Promise.resolve(found.run(line.slice(name.length).trim())).catch((error: unknown) =>
    notice(error instanceof Error ? error.message : String(error), "warning"),
  );
  return true;
}

/**
 * Something the page can do. One with a label is listed (the palette, `/keys`, a page plugin's keys) and takes no
 * parameters; the rest are the page's controls (a root's row, a queued message, a feed tab) and take theirs.
 */
type Action<P extends unknown[] = []> = {
  label?: string;
  detail?: string;
  /** Whether it can run now; checked again each time it runs. */
  available?: () => boolean;
  run: (...params: P) => unknown;
};

const listed = (
  label: string,
  detail: string,
  run: () => unknown,
  available?: () => boolean,
): Action => ({ label, detail, run, ...(available === undefined ? {} : { available }) });

const front = () => shown.value === undefined;

/** The shown root's neighbour in the roots list (newest first), wrapping around. */
function nextRoot(step: 1 | -1): Promise<void> | void {
  const order = listedRoots(roots.value, false);
  if (order.length < 2) return notice("no other root");
  const at = order.findIndex((each) => each.id === rootId.value);
  const next = order[(at + step + order.length) % order.length];
  if (next !== undefined) return switchRoot(next.id);
}

const FEEDS = [undefined, "ask", "milestone", "update"] as const;

/** The next or previous feed tab, wrapping around. */
function cycleFeed(step: 1 | -1): void {
  const at = FEEDS.indexOf(filter.value.kind);
  filterKind(FEEDS[(at + step + FEEDS.length) % FEEDS.length]);
}

/** The last search's hits, best first, which one is shown, and the feed they're from; `n` and `N` walk them. */
let hits: { codes: readonly string[]; at: number; feed: string; query: string } = {
  codes: [],
  at: 0,
  feed: "",
  query: "",
};

/** The feed on screen: the root, the conversation shown and the front's filter. */
const feedKey = () => JSON.stringify([rootId.value, shown.value, filter.value]);

function nextHit(step: 1 | -1): void {
  if (hits.codes.length === 0 || hits.feed !== feedKey())
    return notice("no search in this feed yet · /search");
  hits = { ...hits, at: (hits.at + step + hits.codes.length) % hits.codes.length };
  const code = hits.codes[hits.at];
  if (code !== undefined) jumpTo.value = { code, query: hits.query };
}

/** Leave the prompt for the page, where a key plugin's keys act. */
function leavePrompt(): void {
  const area = document.querySelector("textarea");
  if (document.activeElement === area) area?.blur();
}

const feed = (kind: Filter["kind"], label: string): Action =>
  listed(
    `feed: ${label}`,
    kind === undefined ? "the whole stream" : `only ${label}`,
    () => filterKind(kind),
    front,
  );

const scroll = (label: string, kind: ScrollKind, step: 1 | -1): Action =>
  listed(label, "the feed", () => scrollFeed(kind, step));

const busy = () => {
  const state = view(undefined)?.value;
  return front() && state !== undefined && presentation(state).busy;
};

/** Everything the page can do, by id; the palette lists the listed ones in this order. */
const ACTIONS = {
  prompt: listed("focus the prompt", "type a message", typeInEditor),
  "prompt.leave": listed("leave the prompt", "for the page's keys", leavePrompt),
  // Like vim's `:`: Esc gives back the draft and where focus was.
  slash: listed("slash command", "the prompt with /", startCommandLine),
  palette: listed("palette", "/palette", () => openPalette()),
  "search.next": listed("next search hit", "the last /search", () => nextHit(1)),
  "search.previous": listed("previous search hit", "the last /search", () => nextHit(-1)),
  "feed.next": listed("next feed", "all, asks, done, updates", () => cycleFeed(1), front),
  "feed.previous": listed("previous feed", "all, asks, done, updates", () => cycleFeed(-1), front),
  "scroll.down": scroll("scroll down", "line", 1),
  "scroll.up": scroll("scroll up", "line", -1),
  "scroll.halfDown": scroll("half a page down", "half", 1),
  "scroll.halfUp": scroll("half a page up", "half", -1),
  "scroll.top": scroll("to the oldest", "top", -1),
  "scroll.end": scroll("to the newest, following", "end", 1),
  agents: listed("agents", "/agents", () => submit("/agents")),
  model: listed("model", "/model", () => submit("/model")),
  queue: listed("queue", "/queue", () => submit("/queue")),
  jobs: listed("jobs", "/jobs", () => setPanel("jobs")),
  search: listed("search this feed", "/search", () => openSearch("")),
  "feed.all": feed(undefined, "all"),
  "feed.ask": feed("ask", "asks"),
  "feed.milestone": feed("milestone", "done"),
  "feed.update": feed("update", "updates"),
  "feed.goal": listed("feed: goal", "one goal's stream", pickGoal, front),
  "root.next": listed("next root", "the next older root", () => nextRoot(1)),
  "root.previous": listed("previous root", "the next newer root", () => nextRoot(-1)),
  roots: listed("roots", "switch, start, rename, archive", () => toggleRoots(true)),
  expand: listed("expand all", "open or fold every card", toggleExpandAll),
  mode: listed("steer or follow-up", "what a message to a busy run does", toggleMode),
  drafts: listed("drafts", "save what is typed, or restore one", openDrafts),
  stop: listed(
    "stop the run",
    "the root's; queued messages come back",
    interrupt,
    // A login under way stops first, as Esc stops it.
    () => loggingIn() || busy(),
  ),
  keys: listed("keys", "/keys", () => openKeys()),
  // The page's controls.
  send: { run: send } satisfies Action<[string, readonly Attachment[]]>,
  "feed.clear": { run: clearFilter, available: front } satisfies Action,
  "feed.kind": { run: filterKind, available: front } satisfies Action<[Filter["kind"]]>,
  show: { run: show } satisfies Action<[string | undefined]>,
  reply: { run: replyDraft } satisfies Action<[string]>,
  pin: { run: togglePin } satisfies Action<[string]>,
  unpin: { run: unpin } satisfies Action<[string]>,
  "roots.toggle": { run: () => toggleRoots() } satisfies Action,
  "root.switch": { run: switchRoot } satisfies Action<[string]>,
  "root.new": { run: newRoot } satisfies Action,
  "root.rename": { run: renameRoot } satisfies Action<[string]>,
  "root.archive": { run: archiveRoot } satisfies Action<[string, boolean]>,
  "queue.open": {
    run: beginEdit,
    available: () => editing.value === undefined,
  } satisfies Action<[QueuedItem]>,
  "queue.change": { run: editQueued } satisfies Action<[number, QueueChange]>,
  "edit.leave": { run: () => endEdit() } satisfies Action,
  "edit.save": { run: (text: string) => endEdit(text) } satisfies Action<[string]>,
  "login.cancel": { run: cancelLogin } satisfies Action,
};

type Actions = typeof ACTIONS;
export type ActionId = keyof Actions;

/** Every action, as the executor sees one: what it takes is checked where it is named. */
const TABLE: Readonly<Record<string, Action<never[]>>> = ACTIONS;

/**
 * The page's one way to do something: the palette, the keys, the key bar, a page plugin and the page's controls all
 * come here. It checks the action can run now, runs it, and says what failed; false when it can't run now.
 */
export function run<K extends ActionId>(id: K, ...params: Parameters<Actions[K]["run"]>): boolean {
  return execute(TABLE[id], params);
}

/** Run a listed action by its id, as the palette or a page plugin names it; false when there's none or it can't run now. */
export function runListed(id: string): boolean {
  const action = Object.hasOwn(TABLE, id) ? TABLE[id] : undefined;
  return action?.label !== undefined && execute(action, []);
}

function execute(action: Action<never[]> | undefined, params: readonly unknown[]): boolean {
  if (action === undefined || !(action.available?.() ?? true)) return false;
  try {
    const result: unknown = Reflect.apply(action.run, undefined, params);
    void Promise.resolve(result).catch(failed);
  } catch (error) {
    failed(error);
  }
  return true;
}

const failed = (error: unknown) =>
  notice(error instanceof Error ? error.message : String(error), "warning");

/** The listed actions, with whether each can run now: what the palette and a page plugin offer. */
export function actions(): { id: string; label: string; detail: string; available: boolean }[] {
  return Object.entries(TABLE).flatMap(([id, { label, detail = "", available }]) =>
    label === undefined ? [] : [{ id, label, detail, available: available?.() ?? true }],
  );
}

/** Keys a page plugin added, for `/keys`: each key or sequence and what it does. */
export const pluginKeys = signal<readonly { keys: string; label: string }[]>([]);

/** Keys the page itself has, in the editor and its menus. */
const EDITOR_KEYS = (): readonly [string, string][] => [
  ["Enter", "send; in a menu, take the row"],
  ["Shift+Enter", "new line; in a pick, take the row with its toggle (such as save as default)"],
  [
    "Esc",
    `close the menu, leave an edit, else ${escapeLeaves.value ? "leave the prompt" : "stop the root's run"}`,
  ],
  ["Tab", "take the menu's row"],
  ["↑ ↓", "move in a menu"],
  ["/", "commands, as the first character"],
];

/** Commands a mistaken pick would cost something: the palette puts them in the editor, for Enter to send. */
const CAREFUL = new Set(["/new", "/compact", "/stop", "/reload", "/restart", "/update"]);

/**
 * Run a command as if typed. One that needs an argument, a skill (its text follows) or a careful one fills the editor
 * instead.
 */
function runCommand(item: MenuItem): void {
  if (item.usage?.startsWith("<") || item.label.startsWith("/skill:") || CAREFUL.has(item.label)) {
    setDraft(`${item.label} `);
    typeInEditor();
    return;
  }
  if (runWebCommand(item.label)) return;
  void submit(item.label);
}

/** `/palette`: every action and command, typing to filter; the one taken runs. */
async function openPalette(): Promise<void> {
  const listedNow = actions().filter((action) => action.available);
  const commands = slashCommands(connection.value === "connecting" ? undefined : client()).filter(
    (item) => item.label !== "/palette",
  );
  const picked = await pick("Palette", [
    ...listedNow.map((action) => ({
      id: `action:${action.id}`,
      label: action.label,
      detail: action.detail,
    })),
    ...commands.map((item) => ({ ...item, id: `command:${item.id}` })),
  ]);
  if (picked === undefined) return;
  if (picked.id.startsWith("action:")) {
    // Checked again: what was open when the palette was may have changed while it was.
    if (!runListed(picked.id.slice("action:".length))) notice("that can't run now", "warning");
    return;
  }
  const item = commands.find((each) => `command:${each.id}` === picked.id);
  if (item !== undefined) runCommand(item);
}

/** `/keys`: every key and what it does. */
async function openKeys(): Promise<void> {
  await pick("Keys", [
    ...EDITOR_KEYS().map(([key, what]) => ({ id: key, label: key, detail: what })),
    ...pluginKeys.value.map(({ keys, label }) => ({
      id: `plugin:${keys}`,
      label: keys,
      detail: label,
    })),
  ]);
}

/**
 * `/search`: fuzzy find a message in the feed on screen, newest first among equals; the one taken scrolls into view.
 * The feed's text is read once when it opens, then each keystroke only scores it.
 */
async function openSearch(text: string): Promise<void> {
  const rows = feedRows();
  if (rows.length === 0) return notice("nothing to search in this feed", "warning");
  let listed: readonly string[] = [];
  let typed = text;
  const picked = await pick("Search this feed", [], undefined, text, {
    empty: "nothing matches",
    class: "search",
    marks: ranges,
    rows: (query) => {
      typed = query;
      const found =
        query.trim() === ""
          ? []
          : search(rows, query).map(({ item, at, end }) => ({
              id: item.code,
              label: snippet(item.text, at, end),
              detail: `${item.who} · ${clock(item.at)}`,
            }));
      listed = found.map((row) => row.id);
      return found;
    },
  });
  if (picked === undefined) return;
  hits = {
    codes: listed,
    at: Math.max(0, listed.indexOf(picked.id)),
    feed: feedKey(),
    query: typed,
  };
  jumpTo.value = { code: picked.id, query: typed };
}
