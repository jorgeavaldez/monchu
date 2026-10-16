import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Goal } from "../../goals.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { age } from "./agents-panel.ts";

/** A goal as the panel lists it: `changed` since the user last opened it. */
export type GoalRow = Goal & { changed: boolean };

const isOpen = (goal: Goal) => goal.status === "active" || goal.status === "waiting";

/** A goal's status as a colored mark, and as a colored word. */
function mark(status: Goal["status"]): string {
  return status === "active"
    ? theme.fg("accent", "●")
    : status === "waiting"
      ? theme.bold(theme.fg("warning", "◐"))
      : status === "done"
        ? theme.fg("success", "✓")
        : theme.fg("dim", "✗");
}

function word(status: Goal["status"]): string {
  return status === "active"
    ? theme.fg("accent", "active")
    : status === "waiting"
      ? theme.fg("warning", "waiting")
      : status === "done"
        ? theme.fg("success", "done")
        : theme.fg("dim", "dropped");
}

/** `text` wrapped under an indent, each stored line break kept. */
function block(text: string, indent: number, width: number): string[] {
  const pad = " ".repeat(indent);
  return text
    .split(/\r\n|\r|\n/)
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - indent)))
    .map((line) => truncateToWidth(`${pad}${line}`, width, ""));
}

/**
 * Goals in the editor's place: a concise list, one row per goal, marking goals that changed since last opened (`•`)
 * and goals waiting on the user (`wait`); Enter drills into the goal itself, what is happening now and its next
 * step, and Esc comes back. Open goals show first; Tab adds the recently closed ones. The panel takes 60% of the rows,
 * more on a short screen, and scrolls within it, re-measured every frame.
 */
export class GoalsPanel implements Component, Focusable {
  focused = false;
  private readonly goals: GoalRow[];
  private readonly seen: (goal: Goal) => void;
  private readonly rows: () => number;
  private readonly close: () => void;
  private closed = false;
  private selected: string | undefined;
  private detail: string | undefined;
  private offset = 0;
  private visible = 1;

  constructor(
    goals: readonly GoalRow[],
    seen: (goal: Goal) => void,
    rows: () => number,
    close: () => void,
  ) {
    this.goals = goals.map((goal) => ({ ...goal }));
    this.seen = seen;
    this.rows = rows;
    this.close = close;
    this.selected = this.shown()[0]?.id;
  }

  private shown(): GoalRow[] {
    // Open goals in their stored order, then the newest closed ones first.
    const open = this.goals.filter(isOpen);
    return this.closed
      ? [...open, ...this.goals.filter((goal) => !isOpen(goal)).toReversed()]
      : open;
  }

  render(width: number): string[] {
    const list = getSelectListTheme();
    const rule = list.description("─".repeat(width));
    const goal = this.goals.find((item) => item.id === this.detail);
    const body = goal === undefined ? this.list(width) : this.goal(goal, width);
    // The panel takes 60% of the rows, and more on a short screen, such as a phone with its keyboard open, where the
    // transcript above it keeps a few rows.
    const rows = this.rows();
    const room = Math.max(3, Math.floor(rows * 0.6) - 4, rows - 10);
    this.visible = Math.min(body.lines.length, room);
    if (body.focus !== undefined)
      this.offset = Math.min(
        Math.max(this.offset, body.focus.end - this.visible),
        body.focus.start,
      );
    this.offset = Math.max(0, Math.min(this.offset, body.lines.length - this.visible));
    const scroll =
      body.lines.length > this.visible
        ? ` · ${this.offset + 1}-${this.offset + this.visible} of ${body.lines.length}`
        : "";
    return [
      rule,
      truncateToWidth(body.title, width, "..."),
      ...body.lines.slice(this.offset, this.offset + this.visible),
      truncateToWidth(list.description(`${body.hint}${scroll}`), width, "..."),
      rule,
    ];
  }

  private list(width: number): {
    title: string;
    lines: string[];
    hint: string;
    focus: { start: number; end: number } | undefined;
  } {
    const list = getSelectListTheme();
    const open = this.goals.filter(isOpen).length;
    const waiting = this.goals.filter((goal) => goal.status === "waiting").length;
    const closed = this.goals.length - open;
    const title = ` ${list.selectedText("Goals")}${list.description(` · ${open} open`)}${
      waiting ? `${list.description(" · ")}${theme.fg("warning", `${waiting} waiting`)}` : ""
    }${closed ? list.description(` · ${closed} closed`) : ""}`;
    const hint = ` Enter open · Tab ${this.closed ? "hide" : "show"} closed · Esc`;
    const goals = this.shown();
    if (goals.length === 0)
      return {
        title,
        lines: [list.description(this.closed ? "  No goals." : "  No open goals.")],
        hint,
        focus: undefined,
      };
    const lines: string[] = [];
    let focus: { start: number; end: number } | undefined;
    for (const goal of goals) {
      const selected = goal.id === this.selected;
      // Right-aligned, shortest first: changed since last opened, waiting on the user, then age.
      const waiting = goal.status === "waiting";
      const when = ` ${goal.changed ? `${theme.fg("accent", "•")} ` : ""}${
        waiting ? theme.fg("warning", "wait ") : ""
      }${list.description(age(goal.updatedAt))}`;
      const head = `${selected ? list.selectedText("›") : " "} ${mark(goal.status)} `;
      const room = Math.max(1, width - visibleWidth(head) - visibleWidth(when) - 1);
      const name = truncateToWidth(goal.title.replace(/\s+/g, " "), room, "...");
      const styled = waiting ? theme.fg("warning", name) : name;
      const row = `${head}${selected ? theme.bold(styled) : styled}`;
      const start = lines.length;
      lines.push(
        `${row}${" ".repeat(Math.max(1, width - visibleWidth(row) - visibleWidth(when)))}${when}`,
      );
      // The list stays one row per goal; the selected row stays in view while scrolling.
      if (selected) focus = { start, end: lines.length };
    }
    return { title, lines, hint, focus };
  }

  private goal(goal: Goal, width: number) {
    const list = getSelectListTheme();
    const label = (text: string) => ` ${theme.fg("accent", text)}`;
    // Just the goal: what is happening now, then the next step.
    const lines = [
      truncateToWidth(
        ` ${word(goal.status)}${list.description(` · ${goal.kind} · ${age(goal.updatedAt)} ago`)}`,
        width,
        "...",
      ),
      "",
      label("Now"),
      ...block(goal.workstream, 3, width),
      "",
      label("Next"),
      ...block(goal.next, 3, width),
    ];
    return {
      title: ` ${mark(goal.status)} ${theme.bold(list.selectedText(goal.title.replace(/\s+/g, " ")))}`,
      lines,
      hint: " ↑↓ scroll · Esc back",
      focus: undefined,
    };
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.detail !== undefined) {
      if (keys.matches(data, "tui.select.up")) this.offset -= 1;
      else if (keys.matches(data, "tui.select.down")) this.offset += 1;
      else if (keys.matches(data, "tui.select.pageUp")) this.offset -= this.visible;
      else if (keys.matches(data, "tui.select.pageDown")) this.offset += this.visible;
      else if (
        keys.matches(data, "tui.select.cancel") ||
        matchesKey(data, "left") ||
        matchesKey(data, "backspace")
      ) {
        this.detail = undefined;
        this.offset = 0;
      } else if (matchesKey(data, "ctrl+c") || data === "q") this.close();
      // render clamps the offset to the content it measures.
      this.offset = Math.max(0, this.offset);
      return;
    }
    const goals = this.shown();
    const index = goals.findIndex((goal) => goal.id === this.selected);
    if (keys.matches(data, "tui.select.up"))
      this.selected = goals[Math.max(0, index - 1)]?.id ?? this.selected;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = goals[Math.min(goals.length - 1, index + 1)]?.id ?? this.selected;
    else if (matchesKey(data, "tab")) {
      this.closed = !this.closed;
      if (!this.shown().some((goal) => goal.id === this.selected))
        this.selected = this.shown()[0]?.id;
    } else if (
      (keys.matches(data, "tui.select.confirm") || matchesKey(data, "right")) &&
      this.selected !== undefined
    ) {
      this.detail = this.selected;
      this.offset = 0;
      const goal = this.goals.find((item) => item.id === this.selected);
      if (goal?.changed) {
        goal.changed = false;
        this.seen(goal);
      }
    } else if (
      keys.matches(data, "tui.select.cancel") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    )
      this.close();
  }

  invalidate(): void {}
}
