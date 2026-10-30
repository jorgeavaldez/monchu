/**
 * The drafts menu, a sheet over the editor (the key bar's ✎): the prompt drafts set aside on this device, newest first,
 * one line each, filtered by every word typed. Right of the box: save what is typed, delete the selection, or restore it
 * into the editor, as taking it does. Drafts follow every client's changes.
 */
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Marked, matching } from "./menu.tsx";
import { selectedRow, SheetView, tapRow, type SheetSpec } from "./sheet.tsx";
import { age } from "../ui/state.ts";
import { draft, promptDrafts, sheet, type Sheet } from "./state.ts";
import type { Draft } from "../api/client.ts";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The drafts the filter finds, newest first. */
function draftRows(open: Sheet): Draft[] {
  const listed = promptDrafts.value.toReversed();
  const byId = new Map(listed.map((each) => [String(each.id), each]));
  return matching(
    listed.map((each) => ({ id: String(each.id), label: oneLine(each.text) })),
    open.query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

const chosen = (open: Sheet, rows: readonly Draft[]): Draft | undefined =>
  rows[
    selectedRow(
      open,
      rows.map((each) => String(each.id)),
    )
  ];

const selected = (): Draft | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : chosen(open, draftRows(open));
};

function restore(each: Draft | undefined): void {
  if (each !== undefined) run("draft.restore", each.id);
}

function remove(each: Draft | undefined): void {
  if (each !== undefined) run("draft.delete", each.id);
}

export const DRAFTS: SheetSpec = {
  keys: () =>
    sheet.value === undefined ? [] : draftRows(sheet.value).map((each) => String(each.id)),
  take: (index) => restore(sheet.value === undefined ? undefined : draftRows(sheet.value)[index]),
  chords: () => [
    { key: "s", glyph: "↓", label: "save what is typed", run: () => run("draft.save") },
    { key: "x", glyph: "⌫", label: "delete", run: () => remove(selected()) },
    { key: "r", glyph: "↥", label: "restore", run: () => restore(selected()) },
  ],
};

export function DraftsSheet({ open }: { open: Sheet }) {
  const rows = draftRows(open);
  const each = chosen(open, rows);
  const typed = oneLine(draft.value);
  return (
    <SheetView
      open={open}
      spec={DRAFTS}
      label="drafts"
      class="draftsMenu"
      detail={
        typed === "" ? null : (
          <p class="typed" title="what is typed: save keeps it">
            ✎ {typed}
          </p>
        )
      }
      empty={
        rows.length > 0
          ? undefined
          : promptDrafts.value.length === 0
            ? "no drafts yet"
            : "nothing matches"
      }
    >
      {rows.map((one) => (
        <li
          key={one.id}
          role="option"
          aria-selected={one === each}
          class={one === each ? "selected" : ""}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => tapRow(DRAFTS, String(one.id))}
        >
          <span class="enter">
            <span class="name">
              <Marked text={oneLine(one.text)} query={open.query} />
            </span>
            <span class="age">{age(one.at)}</span>
          </span>
        </li>
      ))}
    </SheetView>
  );
}

/** A floppy disk: save, where no text glyph draws one. */
const SAVE = (
  <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2.5 1.5h9l2 2v11h-11z M5 1.5v4h6v-4 M4.5 14.5v-5h7v5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
    />
  </svg>
);

/** Right of the box: save what is typed, delete or restore the selection. */
export function DraftsActions({ open }: { open: Sheet }) {
  const each = chosen(open, draftRows(open));
  const typed = draft.value.trim() !== "";
  return (
    <>
      <Key
        class="icon"
        label="save"
        title={typed ? "save what is typed (spc s)" : "nothing typed to save"}
        disabled={!typed}
        onPress={() => run("draft.save")}
      >
        {SAVE}
      </Key>
      <Key
        class="icon"
        label="delete"
        title="delete (spc x)"
        disabled={each === undefined}
        onPress={() => remove(each)}
      >
        ⌫
      </Key>
      <Key
        class="icon"
        label="restore"
        title="restore into the editor (Enter)"
        disabled={each === undefined}
        onPress={() => restore(each)}
      >
        ↥
      </Key>
    </>
  );
}
