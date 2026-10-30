/**
 * The front's stream as an inbox: a bar that filters it to asks, milestones or updates, and to one goal, with that
 * goal's card on top (`goals.tsx`), so the person catches up on one workstream without the rest.
 */
import { run } from "./commands.ts";
import { GOAL_GLYPH, GOAL_TONE } from "./goals.tsx";
import { secretRequests } from "./secrets.tsx";
import { filter, goalList, inbox, sheet, type Filter } from "./state.ts";

/** Each kind as a glyph, the same as the leader's filter keys: asks ?, done ✓, updates …; all is ∗. */
const KINDS: [NonNullable<Filter["kind"]>, string, string][] = [
  ["ask", "?", "asks"],
  ["milestone", "✓", "done"],
  ["update", "…", "updates"],
];

/**
 * The bar under the top bar: lenses on the front's stream. The kinds as glyphs (asks with the open count, secret
 * requests included), then at
 * the right ★ for the pins and ◎ for the goals, the followed one's state and id once one is.
 */
export function FilterBar() {
  const current = filter.value;
  const followed = current.goal;
  const goal = goalList.value.find((each) => each.id === followed);
  // A pending secret request is an ask too.
  const open =
    inbox.value.filter((item) => item.state === "open").length + secretRequests.value.length;
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
        aria-label={followed === undefined ? "goal…" : `goal: ${followed}`}
        title="goals (spc g)"
        aria-pressed={followed !== undefined}
        aria-expanded={sheet.value?.kind === "goals"}
        onClick={() => run("feed.goal")}
      >
        <span
          aria-hidden="true"
          class={`glyph ${goal === undefined ? "" : GOAL_TONE[goal.status]}`}
        >
          {goal === undefined ? "◎" : GOAL_GLYPH[goal.status]}
        </span>
        {followed === undefined ? "" : ` ${followed}`} ▾
      </button>
    </nav>
  );
}
