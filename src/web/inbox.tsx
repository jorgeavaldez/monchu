/**
 * The front's stream as an inbox: a bar that filters it to asks, milestones or updates, and to one goal, with that
 * goal's briefer on top, so the person catches up on one workstream without the rest.
 */
import { run } from "./commands.ts";
import { filter, goalList, inbox, sheet, type Filter } from "./state.ts";

/** Each kind as a glyph, the same as the leader's filter keys: asks ?, done ✓, updates …; all is ∗. */
const KINDS: [NonNullable<Filter["kind"]>, string, string][] = [
  ["ask", "?", "asks"],
  ["milestone", "✓", "done"],
  ["update", "…", "updates"],
];

/**
 * The bar under the top bar: lenses on the front's stream. The kinds as glyphs (asks with the open count), then at
 * the right ★ for the pins and ◎ for a goal, its id once one is picked.
 */
export function FilterBar() {
  const current = filter.value;
  const open = inbox.value.filter((item) => item.state === "open").length;
  return (
    <nav class="filters" aria-label="filter the stream">
      <button
        type="button"
        class="icon"
        aria-label="all"
        title="all (spc f a)"
        aria-pressed={current.kind === undefined && current.goal === undefined}
        onClick={() => run("feed.clear")}
      >
        ∗
      </button>
      {KINDS.map(([kind, glyph, label]) => (
        <button
          key={kind}
          type="button"
          class={`icon${kind === "ask" && open > 0 ? " yellow" : ""}`}
          aria-label={kind === "ask" && open > 0 ? `${label}: ${open} open` : label}
          title={`${label} (spc f ${kind === "ask" ? "?" : (label[0] ?? "")})`}
          aria-pressed={current.kind === kind}
          onClick={() => run("feed.kind", current.kind === kind ? undefined : kind)}
        >
          {glyph}
          {kind === "ask" && open > 0 ? <span class="n">{open}</span> : null}
        </button>
      ))}
      <button
        type="button"
        class="icon pins"
        aria-label="pins"
        title="pins (spc p)"
        aria-pressed={sheet.value?.kind === "pins"}
        onClick={() => run("pins.toggle")}
      >
        ★
      </button>
      <button
        type="button"
        class="goal"
        aria-label={current.goal === undefined ? "goal" : `goal: ${current.goal}`}
        title="goal (spc g)"
        aria-pressed={current.goal !== undefined}
        onClick={() => run("feed.goal")}
      >
        <span aria-hidden="true" class="glyph">
          ◎
        </span>
        {current.goal === undefined ? "" : ` ${current.goal}`} ▾
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
