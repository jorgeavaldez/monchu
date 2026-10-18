/**
 * The front's stream as an inbox: a bar that filters it to asks, milestones or updates, and to one goal, with that
 * goal's briefer on top, so the person catches up on one workstream without the rest.
 */
import { filter, goalList, inbox, pickGoal, type Filter } from "./state.ts";

const KINDS: [NonNullable<Filter["kind"]>, string][] = [
  ["ask", "asks"],
  ["milestone", "done"],
  ["update", "updates"],
];

export function FilterBar() {
  const current = filter.value;
  const open = inbox.value.filter((item) => item.state === "open").length;
  return (
    <nav class="filters" aria-label="filter the stream">
      <button
        type="button"
        aria-pressed={current.kind === undefined && current.goal === undefined}
        onClick={() => {
          filter.value = {};
        }}
      >
        all
      </button>
      {KINDS.map(([kind, label]) => (
        <button
          key={kind}
          type="button"
          aria-pressed={current.kind === kind}
          class={kind === "ask" && open > 0 ? "yellow" : undefined}
          onClick={() => {
            const { kind: _kind, ...rest } = current;
            filter.value = current.kind === kind ? rest : { ...rest, kind };
          }}
        >
          {label}
          {kind === "ask" && open > 0 ? ` ${open}` : ""}
        </button>
      ))}
      <button
        type="button"
        class="goal"
        aria-pressed={current.goal !== undefined}
        onClick={() => void pickGoal()}
      >
        {current.goal ?? "goal"} ▾
      </button>
    </nav>
  );
}

/** The picked goal at a glance: what it is, where it stands, what comes next. */
export function Briefer({ id }: { id: string }) {
  const goal = goalList.value.find((each) => each.id === id);
  if (goal === undefined) return null;
  return (
    <section class="card brief">
      <header>
        <b>{goal.title}</b> · {goal.status}
      </header>
      <div class="body">
        <div>now: {goal.workstream}</div>
        <div>next: {goal.next}</div>
        {goal.workers.length > 0 ? (
          <div class="help">workers: {goal.workers.join(", ")}</div>
        ) : null}
        {goal.vault === undefined ? null : <div class="help">vault: {goal.vault}</div>}
      </div>
    </section>
  );
}
