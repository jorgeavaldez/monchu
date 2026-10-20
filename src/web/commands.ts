/**
 * What the page can do, in one place: the slash commands (the core's, skills, and this page's own), and the page's
 * actions that have no command. The palette lists them all, `/keys` lists the keys, and `/search` finds a message in
 * the feed on screen. A key plugin binds keys to these actions; nothing here needs one.
 */
import type { Client } from "../api/client.ts";
import { clientCommands } from "../ui/commands.ts";
import { listedRoots } from "../ui/roots.ts";
import { presentation } from "../ui/state.ts";
import { openClient } from "./client.tsx";
import { search, snippet } from "./fuzzy.ts";
import type { MenuItem } from "./menu.tsx";
import { openSecrets } from "./secrets.tsx";
import { signal } from "@preact/signals";
import {
  client,
  connection,
  draft,
  escapeLeaves,
  filter,
  panel,
  interrupt,
  notice,
  openDrafts,
  pick,
  pickGoal,
  rootId,
  roots,
  shown,
  submit,
  switchRoot,
  toggleExpandAll,
  toggleMode,
  toggleRoots,
  typeInEditor,
  view,
} from "./state.ts";
import { feedRows, jumpTo, scrollFeed } from "./transcript.tsx";
import { clock } from "../ui/ids.ts";

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

/** An action of the page that has no command of its own. */
type Action = {
  id: string;
  label: string;
  detail: string;
  available?: () => boolean;
  run: () => unknown;
};

const front = () => shown.value === undefined;

/** The shown root's neighbour in the roots list (newest first), wrapping around. */
function nextRoot(step: 1 | -1): Promise<void> | void {
  const listed = listedRoots(roots.value, false);
  if (listed.length < 2) return notice("no other root");
  const at = listed.findIndex((each) => each.id === rootId.value);
  const next = listed[(at + step + listed.length) % listed.length];
  if (next !== undefined) return switchRoot(next.id);
}

const FEEDS = [undefined, "ask", "milestone", "update"] as const;

/** The next or previous feed tab, wrapping around. */
function cycleFeed(step: 1 | -1): void {
  const at = FEEDS.indexOf(filter.value.kind);
  const kind = FEEDS[(at + step + FEEDS.length) % FEEDS.length];
  const { kind: _kind, ...rest } = filter.value;
  filter.value = kind === undefined ? rest : { ...rest, kind };
}

/** The last search's hits, best first, which one is shown, and the feed they're from; `n` and `N` walk them. */
let hits: { codes: readonly string[]; at: number; feed: string } = { codes: [], at: 0, feed: "" };

/** The feed on screen: the root, the conversation shown and the front's filter. */
const feedKey = () => JSON.stringify([rootId.value, shown.value, filter.value]);

function nextHit(step: 1 | -1): void {
  if (hits.codes.length === 0 || hits.feed !== feedKey())
    return notice("no search in this feed yet · /search");
  hits = { ...hits, at: (hits.at + step + hits.codes.length) % hits.codes.length };
  const code = hits.codes[hits.at];
  if (code !== undefined) jumpTo.value = { code };
}

/** Leave the prompt for the page, where a key plugin's keys act. */
function leavePrompt(): void {
  const area = document.querySelector("textarea");
  if (document.activeElement === area) area?.blur();
}

const feed = (kind: "ask" | "milestone" | "update" | undefined, label: string): Action => ({
  id: `feed.${kind ?? "all"}`,
  label: `feed: ${label}`,
  detail: kind === undefined ? "the whole stream" : `only ${label}`,
  available: front,
  run: () => {
    const { kind: _kind, ...rest } = filter.value;
    filter.value = kind === undefined ? rest : { ...rest, kind };
  },
});

const scroll = (
  id: string,
  label: string,
  kind: Parameters<typeof scrollFeed>[0],
  step: 1 | -1,
): Action => ({ id, label, detail: "the feed", run: () => scrollFeed(kind, step) });

const ACTIONS: readonly Action[] = [
  { id: "prompt", label: "focus the prompt", detail: "type a message", run: typeInEditor },
  {
    id: "prompt.leave",
    label: "leave the prompt",
    detail: "for the page's keys",
    run: leavePrompt,
  },
  {
    id: "slash",
    label: "slash command",
    detail: "the prompt with /",
    run: () => {
      draft.value = "/";
      typeInEditor();
    },
  },
  { id: "palette", label: "palette", detail: "/palette", run: () => openPalette() },
  {
    id: "search.next",
    label: "next search hit",
    detail: "the last /search",
    run: () => nextHit(1),
  },
  {
    id: "search.previous",
    label: "previous search hit",
    detail: "the last /search",
    run: () => nextHit(-1),
  },
  {
    id: "feed.next",
    label: "next feed",
    detail: "all, asks, done, updates",
    available: front,
    run: () => cycleFeed(1),
  },
  {
    id: "feed.previous",
    label: "previous feed",
    detail: "all, asks, done, updates",
    available: front,
    run: () => cycleFeed(-1),
  },
  scroll("scroll.down", "scroll down", "line", 1),
  scroll("scroll.up", "scroll up", "line", -1),
  scroll("scroll.halfDown", "half a page down", "half", 1),
  scroll("scroll.halfUp", "half a page up", "half", -1),
  scroll("scroll.top", "to the oldest", "top", -1),
  scroll("scroll.end", "to the newest, following", "end", 1),
  { id: "agents", label: "agents", detail: "/agents", run: () => void submit("/agents") },
  { id: "model", label: "model", detail: "/model", run: () => void submit("/model") },
  { id: "queue", label: "queue", detail: "/queue", run: () => void submit("/queue") },
  {
    id: "jobs",
    label: "jobs",
    detail: "/jobs",
    run: () => {
      panel.value = "jobs";
    },
  },
  { id: "search", label: "search this feed", detail: "/search", run: () => openSearch("") },
  feed(undefined, "all"),
  feed("ask", "asks"),
  feed("milestone", "done"),
  feed("update", "updates"),
  {
    id: "feed.goal",
    label: "feed: goal",
    detail: "one goal's stream",
    available: front,
    run: pickGoal,
  },
  { id: "root.next", label: "next root", detail: "the next older root", run: () => nextRoot(1) },
  {
    id: "root.previous",
    label: "previous root",
    detail: "the next newer root",
    run: () => nextRoot(-1),
  },
  {
    id: "roots",
    label: "roots",
    detail: "switch, start, rename, archive",
    run: () => toggleRoots(true),
  },
  { id: "expand", label: "expand all", detail: "open or fold every card", run: toggleExpandAll },
  {
    id: "mode",
    label: "steer or follow-up",
    detail: "what a message to a busy run does",
    run: toggleMode,
  },
  { id: "drafts", label: "drafts", detail: "save what is typed, or restore one", run: openDrafts },
  {
    id: "stop",
    label: "stop the run",
    detail: "the root's; queued messages come back",
    available: () => {
      const state = view(undefined)?.value;
      return front() && state !== undefined && presentation(state).busy;
    },
    run: interrupt,
  },
  { id: "keys", label: "keys", detail: "/keys", run: () => openKeys() },
];

/** Every action the page has, with whether it can run now. */
export function actions(): { id: string; label: string; detail: string; available: boolean }[] {
  return ACTIONS.map(({ id, label, detail, available }) => ({
    id,
    label,
    detail,
    available: available?.() ?? true,
  }));
}

/** Run an action by id, checking it can run now; false when it can't. */
export function runAction(id: string): boolean {
  const action = ACTIONS.find((each) => each.id === id);
  if (action === undefined || !(action.available?.() ?? true)) return false;
  void Promise.resolve(action.run()).catch((error: unknown) =>
    notice(error instanceof Error ? error.message : String(error), "warning"),
  );
  return true;
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
    draft.value = `${item.label} `;
    typeInEditor();
    return;
  }
  if (runWebCommand(item.label)) return;
  void submit(item.label);
}

/** `/palette`: every action and command, typing to filter; the one taken runs. */
async function openPalette(): Promise<void> {
  const actions = ACTIONS.filter((action) => action.available?.() ?? true);
  const commands = slashCommands(connection.value === "connecting" ? undefined : client()).filter(
    (item) => item.label !== "/palette",
  );
  const picked = await pick("Palette", [
    ...actions.map((action) => ({
      id: `action:${action.id}`,
      label: action.label,
      detail: action.detail,
    })),
    ...commands.map((item) => ({ ...item, id: `command:${item.id}` })),
  ]);
  if (picked === undefined) return;
  const action = ACTIONS.find((each) => `action:${each.id}` === picked.id);
  if (action !== undefined) return void (await action.run());
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
  const picked = await pick("Search this feed", [], undefined, text, {
    empty: "nothing matches",
    class: "search",
    rows: (query) => {
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
  hits = { codes: listed, at: Math.max(0, listed.indexOf(picked.id)), feed: feedKey() };
  jumpTo.value = { code: picked.id };
}
