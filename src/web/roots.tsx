/**
 * The roots menu, a sheet over the editor: the shown root first and selected, then the rest by their newest input, one
 * line each (status, id, name, workers, jobs, age). Its bar archives or renames the selection and filters the list
 * (every open root, one status, or the archived ones); + by the filter starts a root.
 */
import type { RootStatus, RootSummary } from "../api/client.ts";
import { listedRoots, rootIds, rootLabel } from "../ui/roots.ts";
import { age } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Marked, matching } from "./menu.tsx";
import { SheetView, tapRow, type SheetSpec } from "./sheet.tsx";
import {
  closeSheet,
  rootId,
  roots,
  sheet,
  updateSheet,
  type RootsFilter,
  type Sheet,
} from "./state.ts";

/** A status as drawn: shapes that differ in grey, colored as the top bar colors them. */
const STATUS_GLYPH: Record<RootStatus, string> = { working: "●", done: "✓", idle: "○" };
const STATUS_WORD: Record<RootStatus, string> = {
  working: "working",
  done: "done, not seen yet",
  idle: "idle",
};
/** In text presentation, so no system draws it as an emoji. */
const JOBS = "⚙\uFE0E";

const FILTERS: readonly RootsFilter[] = ["all", "working", "done", "idle", "archived"];
const FILTER_GLYPH: Record<RootsFilter, string> = { all: "∗", ...STATUS_GLYPH, archived: "↧" };

/** The rows shown: the filter's roots, the shown one first and the rest by newest input, matched by every typed word. */
function rootRows(open: Sheet): RootSummary[] {
  const { filter, query } = open;
  const archived = filter === "archived";
  const listed = listedRoots(roots.value, archived).filter(
    (root) =>
      root.archived === archived && (filter === "all" || archived || root.status === filter),
  );
  const ordered = [
    ...listed.filter((root) => root.id === rootId.value),
    ...listed.filter((root) => root.id !== rootId.value),
  ];
  const byId = new Map(ordered.map((root) => [root.id, root]));
  return matching(
    ordered.map((root) => ({ id: root.id, label: rootLabel(root), detail: root.id })),
    query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

const selected = (): RootSummary | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : rootRows(open)[open.selected];
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

function filterTo(filter: RootsFilter): void {
  updateSheet({ filter, selected: 0 });
}

export const ROOTS: SheetSpec = {
  count: () => (sheet.value === undefined ? 0 : rootRows(sheet.value).length),
  take: (index) => take(sheet.value === undefined ? undefined : rootRows(sheet.value)[index]),
  chords: () => [
    { key: "a", glyph: "↧", label: "archive", run: () => archive(selected()) },
    { key: "r", glyph: "✎", label: "rename", run: () => rename(selected()) },
    { key: "n", glyph: "+", label: "new root", run: newRoot },
    {
      key: "f",
      glyph: "∗",
      label: "filter…",
      more: (
        [
          ["a", "all"],
          ["w", "working"],
          ["d", "done"],
          ["i", "idle"],
          [".", "archived"],
        ] as const
      ).map(([key, to]) => ({
        key,
        glyph: FILTER_GLYPH[to],
        label: to,
        run: () => filterTo(to),
      })),
    },
  ],
};

/** A root's workers as the top bar counts them: busy ● and idle ○, each only when there are some. */
function Workers({ open, busy }: RootSummary["workers"]) {
  return (
    <span class="count" title={open ? `${busy} of ${open} workers busy` : "no workers"}>
      {busy ? <span class="dot working">●{busy}</span> : null}
      {open - busy ? <span class="dot idle">○{open - busy}</span> : null}
    </span>
  );
}

function Row(props: {
  root: RootSummary;
  ids: ReturnType<typeof rootIds>;
  index: number;
  selected: boolean;
  query: string;
}) {
  const { root } = props;
  const { unique, rest } = props.ids(root.id);
  const here = root.id === rootId.value;
  const jobs = root.jobs.running + root.jobs.scheduled;
  return (
    <li
      role="option"
      aria-selected={props.selected}
      class={`${here ? "here" : ""}${props.selected ? " selected" : ""}`}
      aria-current={here}
      title={`${root.id} · ${STATUS_WORD[root.status]}${here ? " · shown" : ""}`}
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => tapRow(ROOTS, props.index)}
    >
      <span class="enter">
        <span class={`dot ${root.status}`} aria-label={STATUS_WORD[root.status]}>
          {STATUS_GLYPH[root.status]}
        </span>
        <span class="id">
          <b>{unique}</b>
          {rest}
        </span>
        <span class="name">
          <Marked text={rootLabel(root)} query={props.query} />
        </span>
        <Workers {...root.workers} />
        <span
          class={`count${root.jobs.running > 0 ? " busy" : ""}`}
          title={
            jobs ? `${root.jobs.running} running, ${root.jobs.scheduled} scheduled` : "no jobs"
          }
        >
          {jobs ? `${JOBS}${jobs}` : ""}
        </span>
        <span class="age" title="since its newest message">
          {age(root.lastInputAt ?? root.createdAt)}
        </span>
      </span>
    </li>
  );
}

export function RootsSheet({ open }: { open: Sheet }) {
  const rows = rootRows(open);
  const filter = open.filter;
  const ids = rootIds(roots.value);
  const root = rows[open.selected];
  const next = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all";
  const shown =
    filter === "all"
      ? undefined
      : roots.value.filter((each) =>
          filter === "archived" ? each.archived : !each.archived && each.status === filter,
        ).length;
  return (
    <SheetView
      open={open}
      spec={ROOTS}
      label={filter === "archived" ? "archived roots" : "roots"}
      class="rootsMenu"
      actions={
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
          <Key
            class="filter"
            label={`filter: ${filter}`}
            title={`filter: ${filter} · tap for ${next} (spc f)`}
            pressed={filter !== "all"}
            onPress={() => filterTo(next)}
          >
            <span class={`dot ${filter}`}>{FILTER_GLYPH[filter]}</span>
            {shown}
          </Key>
        </>
      }
    >
      {rows.length === 0 ? (
        <li class="help empty">{open.query ? "nothing matches" : "none"}</li>
      ) : null}
      {rows.map((each, index) => (
        <Row
          key={each.id}
          root={each}
          ids={ids}
          index={index}
          selected={index === open.selected}
          query={open.query}
        />
      ))}
    </SheetView>
  );
}

/** + right of the filter, in send's place. */
export function RootsNew() {
  return (
    <Key class="icon" label="new root" title="new root (spc n)" onPress={newRoot}>
      +
    </Key>
  );
}
