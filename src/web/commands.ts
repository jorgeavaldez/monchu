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
import {
  client,
  connection,
  draft,
  filter,
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
import { feedRows, jumpTo } from "./transcript.tsx";
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

const ACTIONS: readonly Action[] = [
  { id: "prompt", label: "focus the prompt", detail: "type a message", run: typeInEditor },
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

/** Keys the page itself has, in the editor and its menus. */
const EDITOR_KEYS: readonly [string, string][] = [
  ["Enter", "send; in a menu, take the row"],
  ["Shift+Enter", "new line; in a pick, take the row with its toggle (such as save as default)"],
  ["Esc", "close the menu, leave an edit, else stop the root's run"],
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
  await pick(
    "Keys",
    EDITOR_KEYS.map(([key, what]) => ({ id: key, label: key, detail: what })),
  );
}

/**
 * `/search`: fuzzy find a message in the feed on screen, newest first among equals; the one taken scrolls into view.
 * The feed's text is read once when it opens, then each keystroke only scores it.
 */
async function openSearch(text: string): Promise<void> {
  const rows = feedRows();
  if (rows.length === 0) return notice("nothing to search in this feed", "warning");
  const picked = await pick("Search this feed", [], undefined, text, {
    empty: "nothing matches",
    class: "search",
    rows: (query) =>
      query.trim() === ""
        ? []
        : search(rows, query).map(({ item, at, end }) => ({
            id: item.code,
            label: snippet(item.text, at, end),
            detail: `${item.who} · ${clock(item.at)}`,
          })),
  });
  if (picked !== undefined) jumpTo.value = { code: picked.id };
}
