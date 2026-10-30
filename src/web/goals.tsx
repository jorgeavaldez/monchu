/**
 * The root's goals: a sheet over the editor (`/goals`, ◎ in the filter bar) to find one and follow its stream, and the
 * picked goal's card on top of that stream. Both show a goal's state by its glyph, its open asks and its age, and open
 * on request to what it is doing now, what comes next, its workers and its note.
 */
import { useSignal } from "@preact/signals";
import type { Goal, InboxItem } from "../api/client.ts";
import { age } from "../ui/state.ts";
import { run } from "./commands.ts";
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
  type Tone,
} from "./sheet.tsx";
import { filter, goalList, inbox, sheet, workers, type Sheet } from "./state.ts";

type Status = Goal["status"];
type Listed = Goal & { changed: boolean };

/** A status as drawn, and its color: open ones lead, closed ones fade. */
export const GOAL_GLYPH: Record<Status, string> = {
  active: "●",
  waiting: "◐",
  done: "✓",
  dropped: "✗",
};
export const GOAL_TONE: Record<Status, Tone> = {
  active: "accent",
  waiting: "yellow",
  done: "green",
  dropped: "muted",
};
const RANK: Record<Status, number> = { active: 0, waiting: 1, done: 2, dropped: 3 };
/** The letter after the leader's f that shows only one status; a is every one. */
const LETTER: Record<Status, string> = { active: "o", waiting: "w", done: "d", dropped: "x" };

/** A goal's labeled front messages: how many of each kind, its asks still open. */
function tally(items: readonly InboxItem[], id: string) {
  const counts = { asks: 0, done: 0, updates: 0 };
  for (const item of items) {
    if (item.goal !== id) continue;
    if (item.kind === "ask" && item.state === "open") counts.asks++;
    if (item.kind === "milestone") counts.done++;
    if (item.kind === "update") counts.updates++;
  }
  return counts;
}

const asksOf = (id: string) => tally(inbox.value, id).asks;

const ORDERS: readonly Order[] = [
  { key: "new", glyph: "◷↓", word: "newest change" },
  { key: "old", glyph: "◷↑", word: "oldest change" },
  { key: "asks", glyph: "?↓", word: "most asks" },
  { key: "title", glyph: "a→z", word: "title" },
  { key: "status", glyph: "●→✗", word: "status" },
];
const COMPARE: Record<string, (x: Listed, y: Listed) => number> = {
  new: (x, y) => y.updatedAt - x.updatedAt,
  old: (x, y) => x.updatedAt - y.updatedAt,
  asks: (x, y) => asksOf(y.id) - asksOf(x.id) || y.updatedAt - x.updatedAt,
  title: (x, y) => x.title.localeCompare(y.title),
  status: (x, y) => RANK[x.status] - RANK[y.status] || y.updatedAt - x.updatedAt,
};

function segments(): Segment[] {
  const count = (status: Status) => goalList.value.filter((goal) => goal.status === status).length;
  return (["active", "waiting", "done", "dropped"] as const).map((status) => ({
    key: status,
    glyph: GOAL_GLYPH[status],
    tone: GOAL_TONE[status],
    word: status,
    count: count(status),
    letter: LETTER[status],
  }));
}

/** The rows shown: the statuses shown, in the order picked, matched by every typed word. */
function goalRows(open: Sheet): Listed[] {
  const listed = sortRows(
    goalList.value.filter((goal) => showsStatus(open.look, goal.status)),
    orderOf(open.look, ORDERS),
    COMPARE,
  );
  const byId = new Map(listed.map((goal) => [goal.id, goal]));
  return matching(
    listed.map((goal) => ({ id: goal.id, label: goal.title, detail: goal.id })),
    open.query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

const chosen = (open: Sheet, rows: readonly Listed[]): Listed | undefined =>
  rows[
    selectedRow(
      open,
      rows.map((goal) => goal.id),
    )
  ];

export const GOALS: SheetSpec = {
  orders: ORDERS,
  keys: () => (sheet.value === undefined ? [] : goalRows(sheet.value).map((goal) => goal.id)),
  take: (index) => {
    const goal = sheet.value === undefined ? undefined : goalRows(sheet.value)[index];
    if (goal !== undefined) run("goal.follow", goal.id);
  },
  chords: () =>
    sheet.value === undefined ? [] : lookChords(sheet.value.look, segments(), ORDERS, true),
};

/** A goal's workers by name, ● working and ○ idle as this root's crew shows them. */
function Crew({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name) => {
        const busy = workers.value.some((worker) => worker.name === name && worker.busy);
        return (
          <span key={name} class="who">
            <span class={`dot ${busy ? "working" : "idle"}`}>{busy ? "●" : "○"}</span>
            {name}
          </span>
        );
      })}
    </>
  );
}

/** A goal's fields under it: ↻ what is happening now, → what comes next, ⚒ its workers, ▤ its note or project. */
function Fields({ goal, crew = true }: { goal: Goal; crew?: boolean }) {
  const note = goal.vault ?? goal.project;
  return (
    <>
      <div class="field" title="now">
        <span class="k accent">↻</span>
        <span class="v">{goal.workstream}</span>
      </div>
      <div class="field" title="next">
        <span class="k yellow">→</span>
        <span class="v">{goal.next}</span>
      </div>
      {crew && goal.workers.length > 0 ? (
        <div class="field" title="workers">
          <span class="k">⚒</span>
          <span class="v">
            <Crew names={goal.workers} />
          </span>
        </div>
      ) : null}
      {note === undefined ? null : (
        <div class="field" title={goal.vault === undefined ? "project" : "vault"}>
          <span class="k muted">▤</span>
          <span class="v muted">{note}</span>
        </div>
      )}
    </>
  );
}

function Row(props: { goal: Listed; selected: boolean; details: boolean; query: string }) {
  const { goal } = props;
  const here = filter.value.goal === goal.id;
  const asks = asksOf(goal.id);
  return (
    <>
      <li
        role="option"
        aria-selected={props.selected}
        class={`${here ? "here" : ""}${props.selected ? " selected" : ""}`}
        aria-current={here}
        title={`${goal.id} · ${goal.status}`}
        // A tap must not take focus from the editor, or the keyboard closes.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => tapRow(GOALS, goal.id)}
      >
        <span class="enter">
          <span class={`dot ${GOAL_TONE[goal.status]}`} role="img" aria-label={goal.status}>
            {GOAL_GLYPH[goal.status]}
          </span>
          <span class="name">
            <Marked text={goal.title} query={props.query} />
          </span>
          <span class="count yellow" title={asks ? `${asks} open asks` : undefined}>
            {asks ? `?${asks}` : ""}
          </span>
          <span
            class={`age${goal.changed ? " fresh" : ""}`}
            title={goal.changed ? "changed since you last looked" : "since it last changed"}
          >
            {goal.changed ? "•" : ""}
            {age(goal.updatedAt)}
          </span>
        </span>
      </li>
      {props.selected && props.details ? (
        <li class={`open${here ? " here" : ""}`} role="presentation">
          <Fields goal={goal} />
        </li>
      ) : null}
    </>
  );
}

export function GoalsSheet({ open }: { open: Sheet }) {
  const rows = goalRows(open);
  const goal = chosen(open, rows);
  return (
    <SheetView
      open={open}
      spec={GOALS}
      label="goals"
      class="goalsMenu"
      empty={
        rows.length > 0
          ? undefined
          : open.query
            ? "nothing matches"
            : goalList.value.length === 0
              ? "no goals yet"
              : "none shown"
      }
    >
      {rows.map((each) => (
        <Row
          key={each.id}
          goal={each}
          selected={each === goal}
          details={open.look.details}
          query={open.query}
        />
      ))}
    </SheetView>
  );
}

export function GoalsBar({ open }: { open: Sheet }) {
  return <SheetBar open={open} segments={segments()} orders={ORDERS} details="details" />;
}

/**
 * The followed goal on top of its stream: its state, title and age, then its open asks, what it finished and its
 * updates as counts, and its workers; a tap opens what it is doing now, what comes next and its note.
 */
export function GoalCard({ id }: { id: string }) {
  const open = useSignal(false);
  const goal = goalList.value.find((each) => each.id === id);
  if (goal === undefined) return null;
  const { asks, done, updates } = tally(inbox.value, id);
  return (
    <section class={`card brief ${goal.status}`} aria-label={`goal: ${goal.title}`}>
      <button
        type="button"
        class="head"
        aria-expanded={open.value}
        onClick={() => (open.value = !open.value)}
      >
        <span class={`dot ${GOAL_TONE[goal.status]}`} role="img" aria-label={goal.status}>
          {GOAL_GLYPH[goal.status]}
        </span>
        <b>{goal.title}</b>
        <span class="age">{age(goal.updatedAt)}</span>
        <span aria-hidden="true" class="muted">
          {open.value ? "▾" : "▸"}
        </span>
      </button>
      {asks + done + updates + goal.workers.length === 0 ? null : (
        <div class="strip">
          {asks ? (
            <b class="yellow" title="open asks">
              ?{asks}
            </b>
          ) : null}
          {done ? (
            <span class="green" title="done">
              ✓{done}
            </span>
          ) : null}
          {updates ? (
            <span class="muted" title="updates">
              …{updates}
            </span>
          ) : null}
          {goal.workers.length > 0 ? (
            <span class="crew" title="workers">
              ⚒ <Crew names={goal.workers} />
            </span>
          ) : null}
        </div>
      )}
      {open.value ? (
        <div class="fields">
          <Fields goal={goal} crew={false} />
        </div>
      ) : null}
    </section>
  );
}
