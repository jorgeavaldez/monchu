import {
  getKeybindings,
  Input,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { PinnedMessage, RootSummary } from "../../api/client.ts";
import { stamp } from "../../ui/ids.ts";
import { findPins, pinRoot } from "../../ui/pins.ts";
import { age } from "../../ui/state.ts";
import { getMarkdownTheme, getSelectListTheme, theme } from "../theme/theme.ts";

/**
 * Pinned messages in the editor's place: one row per pin, newest pinned first, filtered by what is typed; Enter opens
 * the message in full, Delete unpins, Esc goes back and then closes. It follows the pins as other clients change them.
 * The panel takes 60% of the rows, more on a short screen, and scrolls within it, re-measured every frame.
 */
export class PinsPanel implements Component, Focusable {
  private readonly search = new Input();
  private pins: readonly PinnedMessage[];
  private roots: readonly RootSummary[];
  private readonly unpin: (pin: PinnedMessage) => void;
  private readonly rows: () => number;
  private readonly close: () => void;
  private selected: string | undefined;
  private detail: string | undefined;
  private offset = 0;
  private visible = 1;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.detail === undefined;
  }

  constructor(
    pins: readonly PinnedMessage[],
    roots: readonly RootSummary[],
    query: string,
    unpin: (pin: PinnedMessage) => void,
    rows: () => number,
    close: () => void,
  ) {
    this.pins = pins;
    this.roots = roots;
    this.unpin = unpin;
    this.rows = rows;
    this.close = close;
    this.search.setValue(query);
    this.selected = this.shown()[0]?.code;
  }

  /** The pins and roots as they are now; a pin another client unpinned closes if it was open. */
  update(pins: readonly PinnedMessage[], roots: readonly RootSummary[] = this.roots): void {
    this.pins = pins;
    this.roots = roots;
    if (!pins.some((pin) => pin.code === this.detail)) this.detail = undefined;
    if (!this.shown().some((pin) => pin.code === this.selected))
      this.selected = this.shown()[0]?.code;
  }

  private shown(): PinnedMessage[] {
    return findPins(this.pins, this.search.getValue(), this.roots);
  }

  render(width: number): string[] {
    const list = getSelectListTheme();
    const rule = list.description("─".repeat(width));
    const pin = this.pins.find((item) => item.code === this.detail);
    const body = pin === undefined ? this.list(width) : this.message(pin, width);
    const rows = this.rows();
    const room = Math.max(3, Math.floor(rows * 0.6) - 5, rows - 11);
    this.visible = Math.min(body.lines.length, room);
    if (body.focus !== undefined)
      this.offset = Math.min(Math.max(this.offset, body.focus + 1 - this.visible), body.focus);
    this.offset = Math.max(0, Math.min(this.offset, body.lines.length - this.visible));
    const scroll =
      body.lines.length > this.visible
        ? ` · ${this.offset + 1}-${this.offset + this.visible} of ${body.lines.length}`
        : "";
    return [
      rule,
      truncateToWidth(body.title, width, "..."),
      ...(pin === undefined ? this.search.render(width) : []),
      ...body.lines.slice(this.offset, this.offset + this.visible),
      truncateToWidth(list.description(`${body.hint}${scroll}`), width, "..."),
      rule,
    ];
  }

  private list(width: number) {
    const list = getSelectListTheme();
    const pins = this.shown();
    const title = ` ${list.selectedText("Pins")}${list.description(
      ` · ${pins.length === this.pins.length ? this.pins.length : `${pins.length} of ${this.pins.length}`}`,
    )}`;
    const hint = " type to filter · Enter open · Delete unpin · Esc";
    if (pins.length === 0)
      return {
        title,
        lines: [
          list.description(
            this.pins.length === 0 ? "  Nothing pinned yet: /pin <id>." : "  No pin matches.",
          ),
        ],
        hint,
        focus: undefined,
      };
    let focus: number | undefined;
    const lines = pins.map((pin, index) => {
      const selected = pin.code === this.selected;
      if (selected) focus = index;
      const when = ` ${list.description(`${pin.from} · ${pinRoot(pin, this.roots)} · ${age(pin.sentAt)}`)}`;
      const head = `${selected ? list.selectedText("›") : " "} ${theme.fg("warning", "★")} `;
      const room = Math.max(
        1,
        width - visibleWidth(head) - Math.min(visibleWidth(when), width / 2),
      );
      const name = truncateToWidth(pin.headline || pin.code, room, "...");
      const row = `${head}${selected ? theme.bold(name) : name}`;
      return truncateToWidth(
        `${row}${" ".repeat(Math.max(1, width - visibleWidth(row) - visibleWidth(when)))}${when}`,
        width,
        "...",
      );
    });
    return { title, lines, hint, focus };
  }

  private message(pin: PinnedMessage, width: number) {
    const list = getSelectListTheme();
    const meta = ` ${list.description(`${pin.code} · ${pin.from} · ${pinRoot(pin, this.roots)} · ${stamp(pin.sentAt)}`)}`;
    const text = new Markdown(pin.text, 1, 0, getMarkdownTheme()).render(width);
    return {
      title: ` ${theme.fg("warning", "★")} ${theme.bold(list.selectedText(pin.headline || pin.code))}`,
      lines: [truncateToWidth(meta, width, "..."), "", ...text],
      hint: " ↑↓ scroll · Delete unpin · Esc back",
      focus: undefined,
    };
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const pin = this.pins.find((item) => item.code === this.detail);
    if (pin !== undefined) {
      if (keys.matches(data, "tui.select.up")) this.offset -= 1;
      else if (keys.matches(data, "tui.select.down")) this.offset += 1;
      else if (keys.matches(data, "tui.select.pageUp")) this.offset -= this.visible;
      else if (keys.matches(data, "tui.select.pageDown")) this.offset += this.visible;
      else if (matchesKey(data, "delete")) {
        this.unpin(pin);
        this.back();
      } else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "left")) this.back();
      else if (matchesKey(data, "ctrl+c")) this.close();
      this.offset = Math.max(0, this.offset);
      return;
    }
    const pins = this.shown();
    const index = pins.findIndex((item) => item.code === this.selected);
    if (keys.matches(data, "tui.select.up"))
      this.selected = pins[Math.max(0, index - 1)]?.code ?? this.selected;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = pins[Math.min(pins.length - 1, index + 1)]?.code ?? this.selected;
    else if (keys.matches(data, "tui.select.confirm")) {
      if (this.selected === undefined) return;
      this.detail = this.selected;
      this.offset = 0;
      this.search.focused = false;
    } else if (matchesKey(data, "delete")) {
      const picked = pins[index];
      if (picked !== undefined) this.unpin(picked);
    } else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) this.close();
    else {
      this.search.handleInput(data);
      this.selected = this.shown()[0]?.code;
      this.offset = 0;
    }
  }

  private back(): void {
    this.detail = undefined;
    this.offset = 0;
    this.search.focused = this._focused;
  }

  invalidate(): void {
    this.search.invalidate();
  }
}
