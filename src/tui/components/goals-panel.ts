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
import { statusText, type AgentStatus } from "./agents-panel.ts";
import { shortPath } from "./footer.ts";

const isOpen = (goal: Goal) => goal.status === "active" || goal.status === "waiting";

/** A goal's status as a colored mark, and as a colored word. */
function mark(status: Goal["status"]): string {
  return status === "active"
    ? theme.fg("accent", "●")
    : status === "waiting"
      ? theme.fg("warning", "◐")
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

/** Time since a change, compactly: 40s, 12m, 3h, 5d. */
function age(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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
 * Goals in the editor's place: a concise list, one row per goal and a preview of the selected goal's next step; Enter
 * drills into the goal, Esc comes back. Open goals show first; Tab adds the recently closed ones. Linked workers show
 * their live status. The panel takes at most 60% of the rows and scrolls within it, re-measured every frame.
 */
export class GoalsPanel implements Component, Focusable {
  focused = false;
  private readonly goals: readonly Goal[];
  private readonly statuses: () => ReadonlyMap<string, AgentStatus>;
  private readonly rows: () => number;
  private readonly close: () => void;
  private closed = false;
  private selected: string | undefined;
  private detail: string | undefined;
  private offset = 0;
  private visible = 1;

  constructor(
    goals: readonly Goal[],
    statuses: () => ReadonlyMap<string, AgentStatus>,
    rows: () => number,
    close: () => void,
  ) {
    this.goals = goals;
    this.statuses = statuses;
    this.rows = rows;
    this.close = close;
    this.selected = this.shown()[0]?.id;
  }

  private shown(): Goal[] {
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
    const closed = this.goals.length - open;
    const title = ` ${list.selectedText("Goals")}${list.description(
      ` · ${open} open${closed ? ` · ${closed} closed` : ""}`,
    )}`;
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
      const when = list.description(` ${age(goal.updatedAt)}`);
      const head = `${selected ? list.selectedText("›") : " "} ${mark(goal.status)} `;
      const room = Math.max(1, width - visibleWidth(head) - visibleWidth(when) - 1);
      const name = truncateToWidth(goal.title.replace(/\s+/g, " "), room, "...");
      const row = `${head}${selected ? theme.bold(name) : name}`;
      const start = lines.length;
      lines.push(
        `${row}${" ".repeat(Math.max(1, width - visibleWidth(row) - visibleWidth(when)))}${when}`,
      );
      // Only the selected goal previews its next step, in up to two readable rows: the list stays one row per goal.
      if (selected) {
        const next = wrapTextWithAnsi(goal.next.replace(/\s+/g, " "), Math.max(1, width - 9));
        lines.push(
          ...next
            .slice(0, 2)
            .map((line, index) =>
              truncateToWidth(
                `    ${index === 0 ? theme.fg("accent", "next") : "    "} ${theme.fg("text", line)}`,
                width,
                "",
              ),
            ),
        );
        if (next.length > 2)
          lines[lines.length - 1] = truncateToWidth(`${lines.at(-1) ?? ""}…`, width, "…");
        focus = { start, end: lines.length };
      }
    }
    return { title, lines, hint, focus };
  }

  private goal(goal: Goal, width: number) {
    const list = getSelectListTheme();
    const label = (text: string) => ` ${theme.fg("accent", text)}`;
    const statuses = this.statuses();
    const lines = [
      truncateToWidth(
        ` ${word(goal.status)}${list.description(` · ${goal.kind} · ${goal.id} · ${age(goal.updatedAt)} ago`)}`,
        width,
        "...",
      ),
      "",
      // Next leads: it is what to act on, and a short screen shows it without scrolling.
      label("Next"),
      ...block(goal.next, 3, width),
      "",
      label("Now"),
      ...block(goal.workstream, 3, width),
    ];
    if (goal.workers.length) {
      lines.push("", label("Workers"));
      const nameWidth = Math.max(...goal.workers.map((name) => visibleWidth(name)));
      for (const name of goal.workers) {
        const status = statuses.get(name);
        lines.push(
          truncateToWidth(
            `   ${name.padEnd(nameWidth)}  ${status === undefined ? list.description("closed") : statusText(status)}`,
            width,
            "...",
          ),
        );
      }
    }
    if (goal.project !== undefined)
      lines.push(
        "",
        label("Project"),
        ...block(list.description(shortPath(goal.project)), 3, width),
      );
    if (goal.vault !== undefined)
      lines.push("", label("Vault"), ...block(list.description(goal.vault), 3, width));
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
    } else if (
      keys.matches(data, "tui.select.cancel") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    )
      this.close();
  }

  invalidate(): void {}
}
