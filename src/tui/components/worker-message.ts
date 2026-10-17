import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { WorkerNotice } from "../../core/agents/workers.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const PREVIEW_LINES = 3;

/**
 * A worker's message, its kind shown by style alone: a reply or failure is a gray card behind a purple rule, apart
 * from the blue user input and the tool cards; a progress update is a muted gray rule and text, without a card.
 * Collapsed to a short preview by default, so the front's own replies stand out. A click toggles one message;
 * Ctrl-O sets them all through `setExpanded`.
 */
export class WorkerMessageComponent implements Component {
  private readonly notice: WorkerNotice;
  private readonly body: Markdown;
  // One row: the kind's rule, then content padded to the width, on the kind's background when it has one.
  private readonly row: (content: string, width: number) => string;
  private readonly changed: (message: WorkerMessageComponent) => void;
  private expanded = false;
  // Clicks toggle only messages that have something hidden; resolved at the last rendered width.
  private long = false;

  constructor(notice: WorkerNotice, changed: (message: WorkerMessageComponent) => void) {
    this.notice = notice;
    this.changed = changed;
    const update = notice.status === "update";
    const background = (text: string) => (update ? text : theme.bg("workerMessageBg", text));
    const rule = background(theme.fg(update ? "borderMuted" : "borderAccent", "│"));
    this.row = (content, width) =>
      rule + background(content + " ".repeat(Math.max(0, width - 1 - visibleWidth(content))));
    this.body = new Markdown(notice.text, 1, 0, getMarkdownTheme(), {
      bgColor: background,
      ...(update ? { color: (text: string) => theme.fg("muted", text) } : {}),
    });
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.changed(this);
  }

  render(width: number): string[] {
    // The rule takes the first column; the body and header fill the rest.
    const inner = Math.max(1, width - 1);
    const line = (content: string) => this.row(truncateToWidth(content, inner, "..."), width);
    const body = this.body.render(inner).map((line) => this.row(line, width));
    this.long = body.length > PREVIEW_LINES;
    const update = this.notice.status === "update";
    const marker = this.long ? (this.expanded ? "▾ " : "▸ ") : "";
    // Only the worker's name: the rule's color says reply or update; a failure says so in the error color.
    const header = line(
      ` ${theme.fg(update ? "muted" : "accent", `${marker}${this.notice.name}`)}${
        this.notice.status === "failed" ? theme.fg("error", " · failed") : ""
      }`,
    );
    // A reply card pads one row above and below, as the user input and tool cards pad theirs; an update stays compact.
    const pad = update ? [] : [line("")];
    if (!this.long || this.expanded) return [...pad, header, ...body, ...pad];
    const hidden = body.length - PREVIEW_LINES;
    const hint = line(
      theme.fg(
        "muted",
        ` … ${hidden} more line${hidden === 1 ? "" : "s"} · click or Ctrl-O to expand`,
      ),
    );
    return [...pad, header, ...body.slice(0, PREVIEW_LINES), hint, ...pad];
  }

  handleMouse(event: TuiMouseEvent) {
    if (!this.long || event.type !== "click" || event.button !== "left") return undefined;
    this.setExpanded(!this.expanded);
    return { handled: true };
  }

  invalidate(): void {
    this.body.invalidate();
  }
}
