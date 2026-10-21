/**
 * `/goals`, `/jobs` and `/pins` as panels in place of the transcript: one row each, a tap opens the rest. Goals and
 * jobs read the core when they open and again when it changes: goals on the front's next entry, jobs on their next
 * event. Pins follow the device's pinned messages as every client changes them.
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Client, Goal } from "../api/client.ts";
import { shortId } from "../api/ids.ts";
import { clock, stamp } from "../ui/ids.ts";
import { findPins, pinRoot } from "../ui/pins.ts";
import { age, span } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Markdown } from "./markdown.tsx";
import { Panel } from "./panel.tsx";
import { client, jobEvent, pins, pinsQuery, root, rootId, roots, view } from "./state.ts";

type Job = Awaited<ReturnType<Client["jobs"]>>["jobs"][number];

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A row that opens in place: its mark, name and one line, then `children` while open. */
function Row(props: {
  mark: string;
  state: string;
  name: string;
  line: string;
  fresh?: boolean;
  onOpen?: () => void;
  children: ComponentChildren;
}) {
  const open = useSignal(false);
  return (
    <li class={`row ${props.state}`}>
      <button
        type="button"
        class="open"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
          if (open.value) props.onOpen?.();
        }}
      >
        <span class="lines">
          <span class="name">
            <span aria-hidden="true" class="mark">
              {props.mark}
            </span>{" "}
            {props.name}
            {props.fresh ? (
              <span class="fresh" title="changed since you last opened it">
                {" "}
                •
              </span>
            ) : null}
          </span>
          {/* Ages change by themselves; checks that compare runs freeze them. */}
          <span class="help age">{props.line}</span>
        </span>
        <span aria-hidden="true">{open.value ? "▾" : "▸"}</span>
      </button>
      {open.value ? <dl class="detail">{props.children}</dl> : null}
    </li>
  );
}

/** One labelled field of an open row, its stored line breaks kept. */
function Field({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined || value === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/**
 * What `load` gives, read again whenever `deps` change; a failure shows as the panel's outcome. A load that a newer
 * one replaced (another root shown meanwhile) changes nothing.
 */
function useLoaded<T>(load: () => Promise<T>, deps: unknown[]) {
  const value = useSignal<T | undefined>(undefined);
  const problem = useSignal<{ text: string; failed: boolean } | undefined>(undefined);
  useEffect(() => {
    let latest = true;
    load().then(
      (loaded) => {
        if (!latest) return;
        value.value = loaded;
        problem.value = undefined;
      },
      (error: unknown) => {
        if (latest) problem.value = { text: failure(error), failed: true };
      },
    );
    return () => {
      latest = false;
    };
  }, deps);
  return { value, problem };
}

const GOAL_MARK = { active: "●", waiting: "◐", done: "✓", dropped: "✗" };
const isOpen = (goal: Goal) => goal.status === "active" || goal.status === "waiting";

/** `/goals`: open goals in their stored order, closed ones newest first on request; opening a goal marks it seen. */
export function GoalsPanel() {
  const closed = useSignal(false);
  // Read again on the front's next entry: a goal changes with a tool call or a worker's report, each one there.
  const { value: goals, problem } = useLoaded(
    () => root().goals(),
    [view(undefined)?.value.entries.at(-1)?.id, rootId.value],
  );
  const all = goals.value ?? [];
  const open = all.filter(isOpen);
  const ended = all.filter((goal) => !isOpen(goal)).toReversed();
  const waiting = open.filter((goal) => goal.status === "waiting").length;
  const counts = [
    ` · ${open.length} open`,
    waiting ? ` · ${waiting} waiting` : "",
    ended.length ? ` · ${ended.length} closed` : "",
  ].join("");
  const listed = closed.value ? [...open, ...ended] : open;
  return (
    <Panel name="goals" class="listPanel" counts={counts} status={problem.value}>
      {goals.value === undefined ? (
        <p class="help">loading…</p>
      ) : listed.length === 0 ? (
        <p class="help">{closed.value ? "no goals" : "no open goals"}</p>
      ) : (
        <ul>
          {listed.map((goal) => (
            <Row
              key={goal.id}
              mark={GOAL_MARK[goal.status]}
              state={goal.status}
              name={goal.title}
              line={`${goal.status} · ${goal.kind} · ${age(goal.updatedAt)} ago · next: ${goal.next}`}
              fresh={goal.changed}
              onOpen={() => {
                if (!goal.changed) return;
                goals.value = all.map((each) =>
                  each.id === goal.id ? { ...each, changed: false } : each,
                );
                void root()
                  .seeGoal(goal.id, goal.updatedAt)
                  .catch(() => {});
              }}
            >
              <Field label="now" value={goal.workstream} />
              <Field label="next" value={goal.next} />
              <Field label="workers" value={goal.workers.join(", ")} />
              <Field label="project" value={goal.project} />
              <Field label="vault" value={goal.vault} />
            </Row>
          ))}
        </ul>
      )}
      {ended.length === 0 ? null : (
        <label class="help">
          <input
            type="checkbox"
            checked={closed.value}
            onChange={(event) => {
              closed.value = event.currentTarget.checked;
            }}
          />{" "}
          show closed ({ended.length})
        </label>
      )}
    </Panel>
  );
}

/** A job's state as a mark and a word: running or scheduled, paused, or how a `bg` command ended. */
function jobState(job: Job): { mark: string; state: string; word: string } {
  if (job.status === "paused") return { mark: "‖", state: "paused", word: "paused" };
  if (job.ended !== undefined) {
    const ok = job.ended.reason === "exited" && job.ended.code === 0;
    const word =
      job.ended.reason === "exited" ? `exited ${job.ended.code ?? "?"}` : job.ended.reason;
    return { mark: ok ? "✓" : "✗", state: ok ? "done" : "failed", word };
  }
  return job.type === "bg"
    ? { mark: "●", state: "active", word: `running ${span(Date.now() - job.createdAt)}` }
    : { mark: "●", state: "active", word: "active" };
}

/** When a job runs: its schedule and next and last run, or for `bg` when it started or ended. */
function jobWhen(job: Job): string {
  if (job.type === "bg") return job.ended === undefined ? "" : `${age(job.ended.at)} ago`;
  return [
    job.schedule,
    job.status === "active" && job.nextAt !== undefined
      ? `next in ${span(job.nextAt - Date.now())}`
      : "",
    job.lastRunAt === undefined ? "" : `last ${age(job.lastRunAt)} ago`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `/jobs`: this root's jobs, then other roots'; finished `bg` commands last; the recent events under them. */
export function JobsPanel() {
  const { value: state, problem } = useLoaded(() => client().jobs(), [jobEvent.value]);
  const here = rootId.value;
  const jobs = (state.value?.jobs ?? []).toSorted(
    (x, y) =>
      Number(shortId(x.rootId) !== here) - Number(shortId(y.rootId) !== here) ||
      Number(x.status === "done") - Number(y.status === "done"),
  );
  const events = (state.value?.events ?? []).slice(-12).toReversed();
  const running = jobs.filter((job) => job.status === "active").length;
  return (
    <Panel
      name="jobs"
      class="listPanel"
      status={problem.value}
      counts={` · ${running} active${jobs.length > running ? ` · ${jobs.length - running} paused or ended` : ""}`}
    >
      {state.value === undefined ? (
        <p class="help">loading…</p>
      ) : jobs.length === 0 ? (
        <p class="help">no jobs</p>
      ) : (
        <ul>
          {jobs.map((job) => {
            const { mark, state: kind, word } = jobState(job);
            const other = shortId(job.rootId) === here ? "" : ` · root ${shortId(job.rootId)}`;
            return (
              <Row
                key={job.name}
                mark={mark}
                state={kind}
                name={job.name}
                line={[`${job.type} ${word}`, `→ ${job.worker.name}`, jobWhen(job)]
                  .filter(Boolean)
                  .join(" · ")
                  .concat(other)}
              >
                <Field label="command" value={job.command} />
                <Field label="prompt" value={job.prompt} />
                <Field label="cwd" value={job.cwd} />
                <Field label="runs" value={job.type === "bg" ? undefined : String(job.runs)} />
                <Field label="error" value={job.ended?.error} />
                <Field label="log" value={job.log} />
                <Field label="by" value={job.createdBy} />
              </Row>
            );
          })}
        </ul>
      )}
      {events.length === 0 ? null : (
        <>
          <h2 class="help">recent</h2>
          <ol class="events">
            {events.map((event) => (
              <li key={event.id}>
                <span class="time">{clock(event.at)}</span> <b>{event.job}</b> {event.kind}
                {event.worker === undefined ? "" : ` → ${event.worker}`}
                {event.text ? <span class="help"> · {event.text}</span> : null}
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}

/**
 * `/pins`: the device's pinned messages, newest pinned first, each its headline and who, where and when; a tap opens
 * the whole message. The box on top filters by every word typed, over the whole text; `/pins <words>` fills it.
 */
export function PinsPanel() {
  const query = useSignal(pinsQuery.value.text);
  // Each `/pins` starts the box with its words, even with the panel open.
  useEffect(() => {
    query.value = pinsQuery.value.text;
  }, [pinsQuery.value]);
  const shown = findPins(pins.value, query.value, roots.value);
  return (
    <Panel
      name="pins"
      class="listPanel"
      counts={` · ${shown.length === pins.value.length ? pins.value.length : `${shown.length} of ${pins.value.length}`}`}
    >
      <input
        type="search"
        class="filter"
        aria-label="filter pins"
        placeholder="filter"
        value={query.value}
        onInput={(event) => {
          query.value = event.currentTarget.value;
        }}
      />
      {pins.value.length === 0 ? (
        <p class="help">nothing pinned yet: tap ☆ on a message, or /pin &lt;id&gt;</p>
      ) : shown.length === 0 ? (
        <p class="help">no pin matches</p>
      ) : (
        <ul>
          {shown.map((pin) => (
            <Row
              key={pin.code}
              mark="★"
              state="pinned"
              name={pin.headline || pin.code}
              line={`${pin.from} · ${pinRoot(pin, roots.value)} · ${age(pin.sentAt)} ago`}
            >
              <dt>
                {pin.code} · {stamp(pin.sentAt)}
                <button
                  type="button"
                  class="icon"
                  aria-label={`unpin ${pin.code}`}
                  title="unpin"
                  onClick={() => run("unpin", pin.code)}
                >
                  ✕
                </button>
              </dt>
              <dd class="assistant">
                <Markdown text={pin.text} />
              </dd>
            </Row>
          ))}
        </ul>
      )}
    </Panel>
  );
}
