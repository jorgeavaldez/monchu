import {
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { WorkerNotice } from "../../workers.ts";
import { getMarkdownTheme, getSelectListTheme, theme } from "../theme/theme.ts";

const PREVIEW_LINES = 3;

// A neutral gray card, apart from the blue user input and the tool cards' green and blue-gray.
const background = (text: string) => theme.bg("workerMessageBg", text);

/**
 * A worker update or report: collapsed to a short preview by default, so the front's own replies stand out.
 * A click toggles one message; Ctrl-O sets them all through `setExpanded`.
 */
export class WorkerMessageComponent implements Component {
  private readonly notice: WorkerNotice;
  private readonly body: Markdown;
  private readonly changed: (message: WorkerMessageComponent) => void;
  private expanded = false;
  // Clicks toggle only messages that have something hidden; resolved at the last rendered width.
  private long = false;

  constructor(notice: WorkerNotice, changed: (message: WorkerMessageComponent) => void) {
    this.notice = notice;
    this.changed = changed;
    this.body = new Markdown(notice.text, 1, 0, getMarkdownTheme(), { bgColor: background });
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.changed(this);
  }

  render(width: number): string[] {
    const body = this.body.render(width);
    this.long = body.length > PREVIEW_LINES;
    const list = getSelectListTheme();
    const marker = this.long ? (this.expanded ? "▾ " : "▸ ") : "";
    const header = new Text(
      list.selectedText(`${marker}worker · ${this.notice.name} · ${this.notice.status}`),
      1,
      0,
      background,
    ).render(width);
    if (!this.long || this.expanded) return [...header, ...body];
    const hidden = body.length - PREVIEW_LINES;
    const hint = truncateToWidth(
      list.description(
        ` … ${hidden} more line${hidden === 1 ? "" : "s"} · click or Ctrl-O to expand`,
      ),
      width,
      "...",
    );
    return [
      ...header,
      ...body.slice(0, PREVIEW_LINES),
      background(hint + " ".repeat(Math.max(0, width - visibleWidth(hint)))),
    ];
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
