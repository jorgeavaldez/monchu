/**
 * The roots menu, a sheet over the editor: the roots in the order picked (newest input first at the start), one line
 * each (status, id, name, workers, jobs, age), the shown one selected. Right of the box: archive or rename the
 * selection, + starts a root. Its view bar shows or hides each status and the archived ones, and orders them.
 */
import type { RootStatus, RootSummary } from "../api/client.ts";
import { rootIds, rootLabel } from "../ui/roots.ts";
import { age } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Marked, matching } from "./menu.tsx";
import {
  lookChords,
  orderOf,
  selectedRow,
  SheetBar,
  SheetView,
  showsStatus,
  sortRows,
  tapRow,
  type Order,
  type Segment,
  type SheetSpec,
} from "./sheet.tsx";
import { closeSheet, rootId, roots, sheet, type Sheet } from "./state.ts";

/** A status as drawn: shapes that differ in grey, colored as the top bar colors them. */
const STATUS_GLYPH: Record<RootStatus, string> = { working: "●", done: "✓", idle: "○" };
const STATUS_WORD: Record<RootStatus, string> = {
  working: "working",
  done: "done, not seen yet",
  idle: "idle",
};
/** In text presentation, so no system draws it as an emoji. */
const JOBS = "⚙\uFE0E";

/** A root's status in the list: the archived ones are their own. */
const statusOf = (root: RootSummary) => (root.archived ? "archived" : root.status);

const recent = (root: RootSummary) => root.lastInputAt ?? root.createdAt;
const RANK: Record<string, number> = { working: 0, done: 1, idle: 2, archived: 3 };

const ORDERS: readonly Order[] = [
  { key: "new", glyph: "◷↓", word: "newest" },
  { key: "old", glyph: "◷↑", word: "oldest" },
  { key: "name", glyph: "a→z", word: "name" },
  { key: "status", glyph: "●→○", word: "status" },
];
const COMPARE: Record<string, (x: RootSummary, y: RootSummary) => number> = {
  new: (x, y) => recent(y) - recent(x),
  old: (x, y) => recent(x) - recent(y),
  name: (x, y) => rootLabel(x).localeCompare(rootLabel(y)),
  status: (x, y) => (RANK[statusOf(x)] ?? 0) - (RANK[statusOf(y)] ?? 0) || recent(y) - recent(x),
};

/** Each status with how many roots have it. */
function segments(): Segment[] {
  const count = (status: string) => roots.value.filter((root) => statusOf(root) === status).length;
  return [
    {
      key: "working",
      glyph: "●",
      tone: "accent",
      word: "working",
      count: count("working"),
      letter: "w",
    },
    { key: "done", glyph: "✓", tone: "green", word: "done", count: count("done"), letter: "d" },
    { key: "idle", glyph: "○", tone: "muted", word: "idle", count: count("idle"), letter: "i" },
    {
      key: "archived",
      glyph: "↧",
      tone: "muted",
      word: "archived",
      count: count("archived"),
      letter: ".",
    },
  ];
}

/** The rows shown: the statuses shown, in the order picked, matched by every typed word. */
function rootRows(open: Sheet): RootSummary[] {
  const listed = sortRows(
    roots.value.filter((root) => showsStatus(open.look, statusOf(root))),
    orderOf(open.look, ORDERS),
    COMPARE,
  );
  const byId = new Map(listed.map((root) => [root.id, root]));
  return matching(
    listed.map((root) => ({ id: root.id, label: rootLabel(root), detail: root.id })),
    open.query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

/** The selected row of `rows`. */
const chosen = (open: Sheet, rows: readonly RootSummary[]): RootSummary | undefined =>
  rows[
    selectedRow(
      open,
      rows.map((root) => root.id),
    )
  ];

const selected = (): RootSummary | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : chosen(open, rootRows(open));
};

function take(root: RootSummary | undefined): void {
  if (root === undefined) return;
  closeSheet();
  run("root.switch", root.id);
}

/** Archive or unarchive; the core refuses a working root, so its cell is off. */
function archive(root: RootSummary | undefined): void {
  if (root === undefined || root.status === "working") return;
  run("root.archive", root.id, !root.archived);
}

function rename(root: RootSummary | undefined): void {
  if (root !== undefined) run("root.rename", root.id);
}

function newRoot(): void {
  closeSheet();
  run("root.new");
}

export const ROOTS: SheetSpec = {
  orders: ORDERS,
  keys: () => (sheet.value === undefined ? [] : rootRows(sheet.value).map((root) => root.id)),
  take: (index) => take(sheet.value === undefined ? undefined : rootRows(sheet.value)[index]),
  chords: () => [
    { key: "a", glyph: "↧", label: "archive", run: () => archive(selected()) },
    { key: "r", glyph: "✎", label: "rename", run: () => rename(selected()) },
    { key: "n", glyph: "+", label: "new root", run: newRoot },
    ...(sheet.value === undefined ? [] : lookChords(sheet.value.look, segments(), ORDERS, false)),
  ],
};

/** A count in its own column: the glyph and the number, nothing when there are none. */
function Count(props: { glyph: string; n: number; tone?: string; said: string }) {
  return (
    <span class={`count ${props.tone ?? ""}`} title={props.said} aria-label={props.said} role="img">
      {props.n ? `${props.glyph}${props.n}` : ""}
    </span>
  );
}

function Row(props: {
  root: RootSummary;
  ids: ReturnType<typeof rootIds>;
  selected: boolean;
  query: string;
}) {
  const { root } = props;
  const { unique, rest } = props.ids(root.id);
  const here = root.id === rootId.value;
  return (
    <li
      role="option"
      aria-selected={props.selected}
      class={`${here ? "here" : ""}${props.selected ? " selected" : ""}`}
      aria-current={here}
      title={`${root.id} · ${STATUS_WORD[root.status]}${here ? " · shown" : ""}`}
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => tapRow(ROOTS, root.id)}
    >
      <span class="enter">
        <span class={`dot ${root.status}`} role="img" aria-label={STATUS_WORD[root.status]}>
          {STATUS_GLYPH[root.status]}
        </span>
        <span class="id">
          <b>{unique}</b>
          {rest}
        </span>
        <span class="name">
          <Marked text={rootLabel(root)} query={props.query} />
        </span>
        <Count
          glyph="●"
          tone="working"
          n={root.workers.busy}
          said={`${root.workers.busy} workers busy`}
        />
        <Count
          glyph="○"
          tone="idle"
          n={root.workers.open - root.workers.busy}
          said={`${root.workers.open - root.workers.busy} workers idle`}
        />
        <Count
          glyph={JOBS}
          n={root.jobs.running + root.jobs.scheduled}
          said={`${root.jobs.running} jobs running, ${root.jobs.scheduled} scheduled`}
        />
        <span class="age" title="since its newest message">
          {age(root.lastInputAt ?? root.createdAt)}
        </span>
      </span>
    </li>
  );
}

export function RootsSheet({ open }: { open: Sheet }) {
  const rows = rootRows(open);
  const ids = rootIds(roots.value);
  const root = chosen(open, rows);
  return (
    <SheetView
      open={open}
      spec={ROOTS}
      label="roots"
      class="rootsMenu"
      empty={rows.length > 0 ? undefined : open.query ? "nothing matches" : "none"}
    >
      {rows.map((each) => (
        <Row key={each.id} root={each} ids={ids} selected={each === root} query={open.query} />
      ))}
    </SheetView>
  );
}

/** Right of the box: archive or rename the selection, and + for a new root. */
export function RootsActions({ open }: { open: Sheet }) {
  const root = chosen(open, rootRows(open));
  return (
    <>
      <Key
        class="icon"
        label={root?.archived === true ? "unarchive" : "archive"}
        title={
          root?.status === "working"
            ? "a working root can't be archived"
            : `${root?.archived === true ? "unarchive" : "archive"} (spc a)`
        }
        disabled={root === undefined || root.status === "working"}
        onPress={() => archive(root)}
      >
        {root?.archived === true ? "↥" : "↧"}
      </Key>
      <Key
        class="icon"
        label="rename"
        title="rename (spc r)"
        disabled={root === undefined}
        onPress={() => rename(root)}
      >
        ✎
      </Key>
      <Key class="icon" label="new root" title="new root (spc n)" onPress={newRoot}>
        +
      </Key>
    </>
  );
}

export function RootsBar({ open }: { open: Sheet }) {
  return <SheetBar open={open} segments={segments()} orders={ORDERS} />;
}
