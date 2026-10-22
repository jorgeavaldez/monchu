/**
 * The keys plugin's page module: reads keys through the page API and runs the page's actions. Desktop only: where the
 * main pointer is a finger (a phone, a tablet) it does nothing, and Esc keeps stopping the run. A laptop's touch screen
 * or a docked phone with a mouse has a fine main pointer, so it gets the keys.
 */
import type { PageApi, PageKey } from "../../plugin.ts";
import {
  FILTER_HINT,
  GROUP_HINT,
  IDLE,
  keyRows,
  REPEATS,
  step,
  type KeyState,
  type Token,
} from "./keymap.ts";

const TOUCH = "(pointer: coarse)";
/** How long a sequence waits for its next key, and when its hint shows. */
const WAIT_MS = 2500;
const HINT_MS = 200;

/** The machine's token for a key, or undefined for one it never reads (another modifier, a dead key). */
function token(event: PageKey): Token | undefined {
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Slash") return "C-/";
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
  if (event.key === " ") return "spc";
  if (event.key === "Escape") return "esc";
  if (event.key === "Enter") return "enter";
  return event.key.length === 1 ? event.key : undefined;
}

export default function keys(page: PageApi): () => void {
  const touch = matchMedia(TOUCH);
  // On a touch screen the keys do nothing, so `/keys` doesn't list them and Esc keeps stopping the run.
  const policy = () => {
    page.escape(touch.matches ? "stop" : "leave");
    page.keys(touch.matches ? [] : keyRows());
  };
  policy();
  touch.addEventListener("change", policy);
  let state: KeyState = IDLE;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const reset = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    state = IDLE;
    page.hint(undefined);
  };
  // Focus moving ends a sequence: its next key belongs to wherever focus went.
  addEventListener("focusin", reset);
  page.onKey((event, snapshot) => {
    if (touch.matches || event.isComposing) return false;
    // Pressing a modifier alone is part of the next key, never a key of its own.
    if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(event.key)) return false;
    const key = token(event);
    if (key === undefined) {
      if (state.pending !== "") reset();
      return false;
    }
    if (event.repeat && !(state.pending === "" && REPEATS.has(key))) return state.pending !== "";
    const next = step(state, key, snapshot);
    reset();
    state = next.state;
    if (state.pending !== "") {
      timers.push(setTimeout(reset, WAIT_MS));
      const hint =
        state.pending === "f" ? FILTER_HINT : state.pending === "g" ? undefined : GROUP_HINT;
      if (hint !== undefined) timers.push(setTimeout(() => page.hint(hint), HINT_MS));
    }
    if (next.run !== undefined && !page.run(next.run)) page.notice(`${next.run} · not now`);
    return next.take;
  });
  return () => {
    reset();
    touch.removeEventListener("change", policy);
    removeEventListener("focusin", reset);
  };
}
