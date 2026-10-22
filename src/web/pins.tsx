/**
 * The pins menu, a sheet over the editor: the device's pinned messages, newest pinned first, one line each (headline,
 * who, root, age), filtered by every word typed over the whole text. › goes to the message, ☆ unpins it, ⊞ shows its
 * whole text over the bar. Pins follow the device's pinned messages as every client changes them.
 */
import { signal } from "@preact/signals";
import type { PinnedMessage } from "../api/client.ts";
import { findPins, pinRoot } from "../ui/pins.ts";
import { age } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Markdown } from "./markdown.tsx";
import { Marked } from "./menu.tsx";
import { SheetView, tapRow, type SheetSpec } from "./sheet.tsx";
import { closeSheet, pins, roots, sheet, type Sheet } from "./state.ts";

/** Whether the selection's whole text shows. */
const whole = signal(false);

const pinRows = (open: Sheet): PinnedMessage[] => findPins(pins.value, open.query, roots.value);

const selected = (): PinnedMessage | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : pinRows(open)[open.selected];
};

function take(pin: PinnedMessage | undefined): void {
  if (pin === undefined) return;
  closeSheet();
  run("pin.go", pin);
}

function unpin(pin: PinnedMessage | undefined): void {
  if (pin !== undefined) run("unpin", pin.code);
}

export const PINS: SheetSpec = {
  count: () => (sheet.value === undefined ? 0 : pinRows(sheet.value).length),
  take: (index) => take(sheet.value === undefined ? undefined : pinRows(sheet.value)[index]),
  chords: () => [
    { key: "x", glyph: "☆", label: "unpin", run: () => unpin(selected()) },
    { key: "o", glyph: "⊞", label: "whole text", run: () => (whole.value = !whole.value) },
  ],
};

export function PinsSheet({ open }: { open: Sheet }) {
  const rows = pinRows(open);
  const pin = rows[open.selected];
  return (
    <SheetView
      open={open}
      spec={PINS}
      label="pins"
      class="pinsMenu"
      actions={
        <>
          <Key
            class="icon"
            label="unpin"
            title="unpin (spc x)"
            disabled={pin === undefined}
            onPress={() => unpin(pin)}
          >
            ☆
          </Key>
          <Key
            class="icon"
            label="whole text"
            title="whole text (spc o)"
            pressed={whole.value}
            disabled={pin === undefined}
            onPress={() => (whole.value = !whole.value)}
          >
            {whole.value ? "⊟" : "⊞"}
          </Key>
        </>
      }
    >
      {rows.length === 0 ? (
        <li class="help empty">
          {pins.value.length === 0 ? "nothing pinned yet: tap ☆ on a message" : "nothing matches"}
        </li>
      ) : null}
      {rows.map((each, index) => (
        <li
          key={each.code}
          role="option"
          aria-selected={index === open.selected}
          class={index === open.selected ? "selected" : ""}
          // A tap must not take focus from the editor, or the keyboard closes.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => tapRow(PINS, index)}
        >
          <span class="enter">
            <span class="dot" aria-hidden="true">
              ★
            </span>
            <span class="name">
              <Marked text={each.headline || each.code} query={open.query} />
            </span>
            <span class="age">
              {each.from} · {pinRoot(each, roots.value)} · {age(each.sentAt)}
            </span>
          </span>
        </li>
      ))}
      {whole.value && pin !== undefined ? (
        <li class="whole assistant">
          <Markdown text={pin.text} />
        </li>
      ) : null}
    </SheetView>
  );
}
