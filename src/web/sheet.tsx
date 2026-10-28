/**
 * A menu that opens from the bottom over the editor (`/roots`): one line per row, an action bar over the filter, and
 * the filter between ✕ back and the menu's primary cell. The editor's box filters it while the draft waits, so the box
 * never moves and a touch keyboard stays up. A tap selects a row, a tap on the selected row or › takes it.
 *
 * Typing filters, arrows move, Enter takes the selection. With a key plugin that leaves the prompt on Esc, the menu is
 * modal like the page: Esc goes to normal mode, where j/k move, Enter or l takes, i or / types again, and Space (or
 * Ctrl+/ anywhere) waits for a chord on the selection with its keys shown; Esc clears the selection, then closes.
 * Without one, Esc closes it.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Key } from "./keys.tsx";
import { closeSheet, escapeLeaves, sheet, updateSheet, type Sheet } from "./state.ts";

/** A key after the leader: it runs, or leads to more keys. */
export type Chord = {
  key: string;
  glyph: string;
  label: string;
  run?: () => void;
  more?: readonly Chord[];
};

/** What a kind of sheet tells the shared keys: its rows' keys in order, how to take one, and its chords. */
export type SheetSpec = {
  keys(): readonly string[];
  take(index: number): void;
  chords(): readonly Chord[];
};

/**
 * The selected row's index among `keys`: its own row wherever the rows moved, else (it left) the one now in its place
 * or the last; -1 for none.
 */
export function selectedRow(open: Sheet, keys: readonly string[]): number {
  const own = open.key === undefined ? -1 : keys.indexOf(open.key);
  return own >= 0 ? own : Math.min(open.selected, keys.length - 1);
}

function select(keys: readonly string[], index: number): void {
  updateSheet({ selected: index, key: keys[index], chord: undefined });
}

function move(open: Sheet, spec: SheetSpec, by: number): void {
  const keys = spec.keys();
  if (keys.length === 0) return;
  const at = selectedRow(open, keys);
  const from = at < 0 ? (by > 0 ? -1 : keys.length) : at;
  select(keys, Math.min(keys.length - 1, Math.max(0, from + by)));
}

function take(open: Sheet, spec: SheetSpec): void {
  const at = selectedRow(open, spec.keys());
  if (at >= 0) spec.take(at);
}

/** The chords that follow the keys typed so far after the leader. */
function chordsAt(spec: SheetSpec, path: readonly string[]): readonly Chord[] {
  let level = spec.chords();
  for (const key of path) level = level.find((chord) => chord.key === key)?.more ?? [];
  return level;
}

/** A key while a chord waits: it goes deeper, runs, or (Esc, or a key with no chord) ends the wait. */
function chordKey(open: Sheet, spec: SheetSpec, key: string): void {
  const path = open.chord ?? [];
  const chord =
    key === "Escape" ? undefined : chordsAt(spec, path).find((each) => each.key === key);
  if (chord?.more !== undefined) return updateSheet({ chord: [...path, key] });
  updateSheet({ chord: undefined });
  chord?.run?.();
}

const leader = (event: KeyboardEvent) =>
  event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Slash";

/** Keys in the filter. True when the key was the sheet's. */
export function filterKey(event: KeyboardEvent, spec: SheetSpec): boolean {
  const open = sheet.value;
  if (open === undefined) return false;
  if (open.chord !== undefined) {
    chordKey(open, spec, event.key);
    return true;
  }
  if (escapeLeaves.value && leader(event)) {
    updateSheet({ chord: [] });
    return true;
  }
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      move(open, spec, event.key === "ArrowDown" ? 1 : -1);
      return true;
    case "Enter":
    case "Tab":
      if (event.shiftKey) return false;
      take(open, spec);
      return true;
    case "Escape":
      if (!escapeLeaves.value) closeSheet();
      else {
        updateSheet({ normal: true });
        // Now, not on the next paint: a key right after this one is the list's.
        document.querySelector<HTMLElement>(".sheet ul")?.focus();
      }
      return true;
  }
  return false;
}

/** Keys on the list in normal mode. True when the key was the sheet's. */
function listKey(event: KeyboardEvent, spec: SheetSpec): boolean {
  const open = sheet.value;
  if (open === undefined) return false;
  if (open.chord !== undefined) {
    chordKey(open, spec, event.key);
    return true;
  }
  if (event.key === " " || leader(event)) {
    updateSheet({ chord: [] });
    return true;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      move(open, spec, 1);
      return true;
    case "k":
    case "ArrowUp":
      move(open, spec, -1);
      return true;
    case "g":
      select(spec.keys(), 0);
      return true;
    case "G": {
      const keys = spec.keys();
      select(keys, keys.length - 1);
      return true;
    }
    case "Enter":
    case "l":
      take(open, spec);
      return true;
    case "i":
    case "/":
      updateSheet({ normal: false });
      return true;
    case "Escape":
      if (selectedRow(open, spec.keys()) >= 0) updateSheet({ selected: -1, key: undefined });
      else closeSheet();
      return true;
  }
  return false;
}

/** ✕ left of the filter: back, as Esc does once nothing is selected. */
export function SheetBack() {
  return (
    <Key class="icon" label="back" title="back (Esc)" onPress={closeSheet}>
      ✕
    </Key>
  );
}

/**
 * The sheet: its rows (each `li` marks itself selected), the action bar (`actions` on the left, then › taking the
 * selection on the right), and the chords' keys while one waits. Normal mode focuses the list, so keys don't type.
 */
export function SheetView(props: {
  open: Sheet;
  spec: SheetSpec;
  label: string;
  class: string;
  actions: ComponentChildren;
  /** Under the rows, over the bar: what the selection shows in full, if anything. */
  detail?: ComponentChildren;
  /** Said in the rows' place when there are none; outside the list, which holds only options. */
  empty: string | undefined;
  children: ComponentChildren;
}) {
  const { open, spec } = props;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open.normal) list.current?.focus();
  }, [open.normal]);
  const keys = spec.keys();
  const at = selectedRow(open, keys);
  // The row selected by place (on opening, after a filter) becomes the one selected: it stays so as rows move. Before
  // the paint, so no change to the rows can come between.
  const key = at < 0 ? undefined : keys[at];
  useLayoutEffect(() => {
    if (open.key === undefined && key !== undefined) updateSheet({ key });
  }, [open.key, key]);
  useEffect(() => {
    list.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }, [at, open.query]);
  const chords = open.chord === undefined ? undefined : chordsAt(spec, open.chord);
  return (
    <div class={`menu sheet ${props.class}${open.normal ? " normal" : ""}`}>
      <h1 class="hidden">{props.label}</h1>
      <ul
        ref={list}
        role="listbox"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (!listKey(event, spec)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {props.children}
      </ul>
      {props.empty === undefined ? null : (
        <p class="help empty" role="status">
          {props.empty}
        </p>
      )}
      {props.detail}
      <div class="bar" role="toolbar" aria-label="actions">
        {props.actions}
        <Key
          class="icon go"
          label="go to the selected"
          title="go (Enter)"
          disabled={at < 0}
          onPress={() => spec.take(at)}
        >
          ›
        </Key>
      </div>
      {chords === undefined ? null : (
        <div class="whichkey" role="status" aria-label="keys">
          {chords.map((chord) => (
            <div key={chord.key}>
              <b>{chord.key}</b> {chord.glyph} <span class="help">{chord.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A click on the row `key`: the first selects it, one on the selected row takes it. */
export function tapRow(spec: SheetSpec, key: string): void {
  const open = sheet.value;
  const keys = spec.keys();
  const index = keys.indexOf(key);
  if (open === undefined || index < 0) return;
  if (selectedRow(open, keys) === index) spec.take(index);
  else select(keys, index);
}
