/**
 * The pins menu, a sheet over the editor: the device's pinned messages, newest pinned first, one line each (headline,
 * who, root, age), filtered by every word typed over the whole text. Taking one goes to the message, ☆ unpins it, ⊞ in
 * the view bar shows its whole text under the rows. Pins follow the device's pinned messages as every client changes
 * them.
 */
import type { PinnedMessage } from "../api/client.ts";
import { findPins, pinRoot } from "../ui/pins.ts";
import { age } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Markdown } from "./markdown.tsx";
import { Marked } from "./menu.tsx";
import {
  lookChords,
  orderOf,
  selectedRow,
  SheetBar,
  SheetView,
  tapRow,
  type Order,
  type SheetSpec,
} from "./sheet.tsx";
import { closeSheet, pins, roots, sheet, type Sheet } from "./state.ts";

const ORDERS: readonly Order[] = [
  { key: "new", glyph: "◷↓", word: "newest" },
  { key: "old", glyph: "◷↑", word: "oldest" },
];

/** The pins the filter finds, newest pinned first, or oldest first when asked. */
function pinRows(open: Sheet): PinnedMessage[] {
  const found = findPins(pins.value, open.query, roots.value);
  return orderOf(open.look, ORDERS) === "old" ? found.toReversed() : found;
}

/** The selected row of `rows`. */
const chosen = (open: Sheet, rows: readonly PinnedMessage[]): PinnedMessage | undefined =>
  rows[
    selectedRow(
      open,
      rows.map((pin) => pin.code),
    )
  ];

const selected = (): PinnedMessage | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : chosen(open, pinRows(open));
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
  orders: ORDERS,
  keys: () => (sheet.value === undefined ? [] : pinRows(sheet.value).map((pin) => pin.code)),
  take: (index) => take(sheet.value === undefined ? undefined : pinRows(sheet.value)[index]),
  chords: () => [
    { key: "x", glyph: "☆", label: "unpin", run: () => unpin(selected()) },
    ...(sheet.value === undefined ? [] : lookChords(sheet.value.look, [], ORDERS, true)),
  ],
};

export function PinsSheet({ open }: { open: Sheet }) {
  const rows = pinRows(open);
  const pin = chosen(open, rows);
  return (
    <SheetView
      open={open}
      spec={PINS}
      label="pins"
      class="pinsMenu"
      empty={
        rows.length > 0
          ? undefined
          : pins.value.length === 0
            ? "nothing pinned yet: tap ☆ on a message"
            : "nothing matches"
      }
      detail={
        open.look.details && pin !== undefined ? (
          <div class="whole assistant">
            <Markdown text={pin.text} />
          </div>
        ) : null
      }
    >
      {rows.map((each) => (
        <li
          key={each.code}
          role="option"
          aria-selected={each === pin}
          class={each === pin ? "selected" : ""}
          // A tap must not take focus from the editor, or the keyboard closes.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => tapRow(PINS, each.code)}
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
    </SheetView>
  );
}

/** Right of the box: unpin the selection. */
export function PinsActions({ open }: { open: Sheet }) {
  const pin = chosen(open, pinRows(open));
  return (
    <Key
      class="icon"
      label="unpin"
      title="unpin (spc x)"
      disabled={pin === undefined}
      onPress={() => unpin(pin)}
    >
      ☆
    </Key>
  );
}

export function PinsBar({ open }: { open: Sheet }) {
  return <SheetBar open={open} segments={[]} orders={ORDERS} details="whole text" />;
}
