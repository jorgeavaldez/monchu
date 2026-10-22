/**
 * The top bar, the page's widest context: which conversation of this root is shown, and which root. On the left the
 * crew as counts (● working, ○ idle) then the shown conversation's dot and name, the whole stretch one button that
 * opens the workers menu; at the right edge, in a thumb's reach, the roots as counts (● working, ✓ done and not seen
 * yet, ○ idle) opening the roots menu. Counts show a new worker or a root's change without a tab for each.
 */
import type { ComponentChildren } from "preact";
import { rootLabel, rootTally } from "../ui/roots.ts";
import { presentation } from "../ui/state.ts";
import { run } from "./commands.ts";
import { rootId, roots, sheet, shown, view, workers } from "./state.ts";

/** A state's glyph and how many are in it; nothing while none are. */
function Count({ glyph, state, n }: { glyph: string; state: string; n: number }) {
  if (n === 0) return null;
  return (
    <span class="count">
      <span class={`dot ${state}`}>{glyph}</span>
      {n}
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}`;

function Crew() {
  const busy = workers.value.filter((worker) => worker.busy).length;
  const idle = workers.value.length - busy;
  const name = shown.value ?? "root";
  const state = view(shown.value)?.value;
  const working = state === undefined ? false : presentation(state).busy;
  const open = sheet.value?.kind === "workers";
  const crew = [busy ? `${busy} working` : "", idle ? `${idle} idle` : ""].filter(Boolean);
  return (
    <button
      class={`crew${open ? " on" : ""}`}
      aria-expanded={open}
      aria-label={`${name}, ${working ? "working" : "idle"}${crew.length ? `; workers ${crew.join(", ")}` : ""}`}
      title="workers (spc a)"
      onClick={() => run("workers.toggle")}
    >
      <span aria-hidden="true" class="counts">
        <Count glyph="●" state="working" n={busy} />
        <Count glyph="○" state="idle" n={idle} />
      </span>
      <span aria-hidden="true" class="here">
        <span class={`dot ${working ? "working" : "idle"}`}>{working ? "●" : "○"}</span> {name}{" "}
        {open ? "▴" : "▾"}
      </span>
    </button>
  );
}

function Roots() {
  const here = roots.value.find((root) => root.id === rootId.value);
  if (here === undefined) return null;
  const tally = rootTally(roots.value);
  const open = sheet.value?.kind === "roots";
  const name = rootLabel(here);
  const summary = [
    tally.working ? plural(tally.working, "working") : "",
    tally.done ? plural(tally.done, "done") : "",
    tally.idle ? plural(tally.idle, "idle") : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      class={`roots${open ? " on" : ""}`}
      aria-label={`roots: ${name}; ${summary}`}
      aria-expanded={open}
      title={`${name} · ${summary}`}
      onClick={() => run("roots.toggle")}
    >
      <span aria-hidden="true" class="counts">
        <Count glyph="●" state="working" n={tally.working} />
        <Count glyph="✓" state="done" n={tally.done} />
        <Count glyph="○" state="idle" n={tally.idle} />
      </span>
      <span aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
  );
}

/** The bar, and under it on a phone or between its two ends on a wide screen, the stream's `lenses`. */
export function TopBar({ lenses }: { lenses: ComponentChildren }) {
  return (
    <nav class="agents" aria-label="conversations">
      <Crew />
      {lenses}
      <Roots />
    </nav>
  );
}
