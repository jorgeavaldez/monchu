/**
 * The jobs menu (`/jobs`), a sheet over the editor: every job, one line each (state, name, the worker it wakes, and
 * when it runs next or ran), followed while it is open. Right of the box: pause or resume the
 * selection. Its view bar shows or hides each state, opens the selection's details, and orders them.
 */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Client } from "../api/client.ts";
import { shortId } from "../api/ids.ts";
import { age, span } from "../ui/state.ts";
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
  type Tone,
} from "./sheet.tsx";
import { changeLook, client, closeSheet, rootId, sheet, workers, type Sheet } from "./state.ts";

type Job = Awaited<ReturnType<Client["jobs"]>>["jobs"][number];
type State = "running" | "scheduled" | "paused" | "ok" | "failed";

/** The jobs as last read; undefined until the first read, or what it failed with. */
const loaded = signal<readonly Job[] | string | undefined>(undefined);
const jobs = () => (typeof loaded.value === "object" ? loaded.value : []);

/** Each state: its glyph, color, word, and the letter after the leader's f that shows only it. */
const STATES: readonly [State, string, Tone, string, string][] = [
  ["running", "●", "accent", "running", "r"],
  ["scheduled", "○", "muted", "scheduled", "s"],
  ["paused", "‖", "yellow", "paused", "p"],
  ["ok", "✓", "green", "ended ok", "o"],
  ["failed", "✗", "red", "failed", "x"],
];
const GLYPH = Object.fromEntries(STATES.map(([state, glyph]) => [state, glyph]));
const TONE = Object.fromEntries(STATES.map(([state, , tone]) => [state, tone]));
const WORD = Object.fromEntries(STATES.map(([state, , , word]) => [state, word]));

/** A job's state: a `bg` command running or how it ended, a schedule running or paused. */
function stateOf(job: Job): State {
  if (job.status === "paused") return "paused";
  if (job.ended !== undefined)
    return job.ended.reason === "exited" && job.ended.code === 0 ? "ok" : "failed";
  return job.type === "bg" ? "running" : "scheduled";
}

/** When it ran last: a `bg` command's end or start, a schedule's last run. */
const lastRan = (job: Job) => job.ended?.at ?? job.lastRunAt ?? job.createdAt;

const ORDERS: readonly Order[] = [
  { key: "next", glyph: "▸↑", word: "next run" },
  { key: "last", glyph: "◷↓", word: "last ran" },
  { key: "name", glyph: "a→z", word: "name" },
];
const COMPARE: Record<string, (x: Job, y: Job) => number> = {
  next: (x, y) => (x.nextAt ?? Infinity) - (y.nextAt ?? Infinity) || lastRan(y) - lastRan(x),
  last: (x, y) => lastRan(y) - lastRan(x),
  name: (x, y) => x.name.localeCompare(y.name),
};

function segments(): Segment[] {
  const all = jobs();
  return STATES.map(([state, glyph, tone, word, letter]) => ({
    key: state,
    glyph,
    tone,
    word,
    count: all.filter((job) => stateOf(job) === state).length,
    letter,
  }));
}

function jobRows(open: Sheet): Job[] {
  const listed = sortRows(
    jobs().filter((job) => showsStatus(open.look, stateOf(job))),
    orderOf(open.look, ORDERS),
    COMPARE,
  );
  const byName = new Map(listed.map((job) => [job.name, job]));
  return matching(
    listed.map((job) => ({ id: job.name, label: job.name, detail: job.worker.name })),
    open.query,
  ).flatMap((item) => byName.get(item.id) ?? []);
}

const chosen = (open: Sheet, rows: readonly Job[]): Job | undefined =>
  rows[
    selectedRow(
      open,
      rows.map((job) => job.name),
    )
  ];

const selected = (): Job | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : chosen(open, jobRows(open));
};

/** The worker a job wakes: in its own root, else that root; with neither to show yet, its details open. */
function take(job: Job | undefined): void {
  if (job === undefined) return;
  const root = shortId(job.rootId);
  const here = workers.value.some((worker) => worker.name === job.worker.name);
  if (root === rootId.value && !here) return changeLook({ details: true });
  closeSheet();
  if (root !== rootId.value) run("root.switch", root);
  else run("show", job.worker.name);
}

/** Pause a running schedule, or resume a paused one; `bg` commands have neither. */
function pause(job: Job | undefined): void {
  if (job === undefined || job.type === "bg") return;
  run("job.control", job.name, job.status === "paused" ? "resume" : "pause");
}

export const JOBS: SheetSpec = {
  orders: ORDERS,
  keys: () => (sheet.value === undefined ? [] : jobRows(sheet.value).map((job) => job.name)),
  take: (index) => take(sheet.value === undefined ? undefined : jobRows(sheet.value)[index]),
  chords: () => [
    { key: "p", glyph: "‖", label: "pause or resume", run: () => pause(selected()) },
    ...(sheet.value === undefined ? [] : lookChords(sheet.value.look, segments(), ORDERS, true)),
  ],
};

/** When it runs: a schedule's next run as ▸ and the time to it, else since it ran. */
function when(job: Job): string {
  if (job.status === "active" && job.nextAt !== undefined)
    return `▸${span(job.nextAt - Date.now())}`;
  return job.status === "paused" && job.lastRunAt === undefined ? "" : age(lastRan(job));
}

/** The selection's details: its schedule and runs, then what it runs. */
function Details({ job }: { job: Job }) {
  const ended = job.ended;
  const runs = [
    job.schedule,
    job.status === "active" && job.nextAt !== undefined
      ? `next in ${span(job.nextAt - Date.now())}`
      : "",
    job.lastRunAt === undefined ? "" : `last ran ${age(job.lastRunAt)} ago`,
    job.type === "bg" ? "" : `${job.runs} runs`,
    ended === undefined
      ? ""
      : `${ended.reason}${ended.code === null ? "" : ` ${ended.code}`} ${age(ended.at)} ago`,
  ].filter(Boolean);
  return (
    <li class="open" role="presentation">
      <div class="field">
        <span class="k">◷</span>
        <span class="v">{runs.join(" · ")}</span>
      </div>
      {job.command === undefined ? null : (
        <div class="field">
          <span class="k">$</span>
          <span class="v">{job.command}</span>
        </div>
      )}
      {job.prompt === "" ? null : (
        <div class="field">
          <span class="k">✎</span>
          <span class="v">{job.prompt}</span>
        </div>
      )}
      {ended?.error === undefined ? null : (
        <div class="field">
          <span class="k red">⚠</span>
          <span class="v">{ended.error}</span>
        </div>
      )}
    </li>
  );
}

function Row(props: { job: Job; selected: boolean; details: boolean; query: string }) {
  const { job } = props;
  const state = stateOf(job);
  const root = shortId(job.rootId);
  return (
    <>
      <li
        role="option"
        aria-selected={props.selected}
        class={props.selected ? "selected" : ""}
        title={`${job.type} · ${WORD[state]}`}
        // A tap must not take focus from the editor, or the keyboard closes.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => tapRow(JOBS, job.name)}
      >
        <span class="enter">
          <span class={`dot ${TONE[state]}`} role="img" aria-label={WORD[state]}>
            {GLYPH[state]}
          </span>
          <span class="name">
            <Marked text={job.name} query={props.query} />
          </span>
          <span class="who" title="who it wakes">
            → {root === rootId.value ? "" : `${root}/`}
            {job.worker.name}
          </span>
          <span class="age">{when(job)}</span>
        </span>
      </li>
      {props.selected && props.details ? <Details job={job} /> : null}
    </>
  );
}

export function JobsSheet({ open }: { open: Sheet }) {
  // Followed while it is open: every change, a run that changed nothing included.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let open = true;
    client()
      .watchJobs((state) => {
        loaded.value = state.jobs;
      })
      .then(
        (stopping) => {
          if (open) stop = stopping;
          else stopping();
        },
        (error: unknown) => {
          loaded.value = error instanceof Error ? error.message : String(error);
        },
      );
    return () => {
      open = false;
      stop?.();
    };
  }, []);
  const rows = jobRows(open);
  const job = chosen(open, rows);
  const failed = typeof loaded.value === "string" ? loaded.value : undefined;
  return (
    <SheetView
      open={open}
      spec={JOBS}
      label="jobs"
      class="jobsMenu"
      empty={
        rows.length > 0
          ? undefined
          : (failed ??
            (loaded.value === undefined
              ? "loading…"
              : open.query
                ? "nothing matches"
                : jobs().length === 0
                  ? "no jobs"
                  : "none shown"))
      }
    >
      {rows.map((each) => (
        <Row
          key={each.name}
          job={each}
          selected={each === job}
          details={open.look.details}
          query={open.query}
        />
      ))}
    </SheetView>
  );
}

/** Right of the box: pause or resume the selection. */
export function JobsActions({ open }: { open: Sheet }) {
  const job = chosen(open, jobRows(open));
  const paused = job?.status === "paused";
  const schedule = job !== undefined && job.type !== "bg";
  return (
    <>
      <Key
        class="icon"
        label={paused ? "resume" : "pause"}
        title={schedule ? `${paused ? "resume" : "pause"} (spc p)` : "only a schedule pauses"}
        disabled={!schedule}
        onPress={() => pause(job)}
      >
        {paused ? "▶\uFE0E" : "‖"}
      </Key>
    </>
  );
}

export function JobsBar({ open }: { open: Sheet }) {
  return <SheetBar open={open} segments={segments()} orders={ORDERS} details="details" />;
}
