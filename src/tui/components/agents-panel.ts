import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { meterText, shortPath, type Meter } from "./footer.ts";

/** Running now, or not. */
export type AgentStatus = "working" | "idle";

/** One conversation in the agents panel: the root, value `""`, or a worker by name. */
export type AgentRow = {
  value: string;
  name: string;
  status: AgentStatus;
  meter: Meter | undefined;
  cwd: string | undefined;
};

/** A status as a colored mark and word: the same words the dock counts and Herdr shows. */
export function statusText(status: AgentStatus): string {
  return status === "working" ? theme.fg("accent", "● working") : theme.fg("dim", "○ idle");
}

/**
 * The root and every worker in the editor's place, each with its status and context, updated live while open. Rows
 * keep name, status and context on a narrow screen; the directory shows only where it fits.
 */
export class AgentsPanel implements Component, Focusable {
  focused = false;
  private rows: readonly AgentRow[];
  private selected: string;
  private readonly select: (value: string) => void;
  private readonly close: () => void;

  constructor(
    rows: readonly AgentRow[],
    shown: string,
    select: (value: string) => void,
    close: () => void,
  ) {
    this.rows = rows;
    this.selected = shown;
    this.select = select;
    this.close = close;
  }

  update(rows: readonly AgentRow[]): void {
    this.rows = rows;
    // A closed worker leaves the list; the selection returns to the root.
    if (!rows.some((row) => row.value === this.selected)) this.selected = "";
  }

  render(width: number): string[] {
    const list = getSelectListTheme();
    const rule = list.description("─".repeat(width));
    const nameWidth = Math.max(...this.rows.map((row) => visibleWidth(row.name)));
    const lines = this.rows.map((row) => {
      const selected = row.value === this.selected;
      const name = row.name.padEnd(nameWidth);
      const head = `${selected ? list.selectedText("›") : " "} ${
        selected ? list.selectedText(name) : name
      }  ${statusText(row.status)}${" ".repeat(9 - visibleWidth(statusText(row.status)))}${
        row.meter === undefined ? "" : `  ${meterText(row.meter)}`
      }`;
      const cwd = row.cwd === undefined ? "" : theme.fg("dim", `  ${shortPath(row.cwd)}`);
      // The directory only where it fits whole enough to read; never at the cost of the context.
      return visibleWidth(head) + 12 <= width
        ? truncateToWidth(`${head}${cwd}`, width, theme.fg("dim", "..."))
        : truncateToWidth(head, width, "");
    });
    return [
      rule,
      truncateToWidth(` ${list.selectedText("Agents")}`, width, "..."),
      ...lines,
      truncateToWidth(list.description(" Enter view · Esc close"), width, "..."),
      rule,
    ];
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const index = this.rows.findIndex((row) => row.value === this.selected);
    if (keys.matches(data, "tui.select.up"))
      this.selected = this.rows[Math.max(0, index - 1)]?.value ?? this.selected;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = this.rows[Math.min(this.rows.length - 1, index + 1)]?.value ?? this.selected;
    else if (keys.matches(data, "tui.select.confirm")) this.select(this.selected);
    else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) this.close();
  }

  invalidate(): void {}
}
