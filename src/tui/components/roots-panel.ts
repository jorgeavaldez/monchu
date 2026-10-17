import {
  getKeybindings,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { RootSummary } from "../../api/client.ts";
import { ARCHIVE_HELP, listedRoots, rootCounts, rootIds, rootLabel } from "../../ui/roots.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { age } from "./agents-panel.ts";
import { rootIdText, rootMark } from "./footer.ts";

/** What the panel asks of its owner; each rejects with the reason it was refused. */
export type RootActions = {
  open(id: string): void;
  create(): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  close(): void;
};

/**
 * Every root in the editor's place, newest input first, each with its id, status, crew and label, updated live while
 * open. Archiving asks once more with what it means; archived roots show only on request.
 */
export class RootsPanel implements Component, Focusable {
  private roots: readonly RootSummary[];
  private readonly shown: string;
  private selected: string;
  private archived = false;
  private confirming: string | undefined;
  private renaming: Input | undefined;
  private message: { text: string; error: boolean } | undefined;
  private readonly actions: RootActions;
  private readonly changed: () => void;
  private _focused = false;

  constructor(
    roots: readonly RootSummary[],
    shown: string,
    actions: RootActions,
    changed: () => void,
  ) {
    this.roots = roots;
    this.shown = shown;
    this.selected = shown;
    this.actions = actions;
    this.changed = changed;
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.renaming) this.renaming.focused = value;
  }

  update(roots: readonly RootSummary[]): void {
    this.roots = roots;
    const rows = this.rows();
    if (!rows.some((root) => root.id === this.selected))
      this.selected = rows.find((root) => root.id === this.shown)?.id ?? rows[0]?.id ?? "";
  }

  private rows(): readonly RootSummary[] {
    return listedRoots(this.roots, this.archived);
  }

  render(width: number): string[] {
    const list = getSelectListTheme();
    const dim = (text: string) => theme.fg("dim", text);
    const rule = list.description("─".repeat(width));
    const split = rootIds(this.roots);
    const lines = this.rows().map((root) => {
      const selected = root.id === this.selected;
      const counts = rootCounts(root);
      const status = root.archived ? dim("archived") : rootMark(root.status);
      const head = `${selected ? list.selectedText("›") : " "} ${rootIdText(split(root.id))} ${status} `;
      const tail = [
        ...(counts ? [counts] : []),
        ...(root.status === "idle" ? [age(root.lastInputAt ?? root.createdAt)] : []),
      ].join(" · ");
      const here = root.id === this.shown ? dim(" (here)") : "";
      const label = rootLabel(root);
      // The label gives way before the crew counts, which say whether to look.
      const room = Math.max(
        8,
        width - visibleWidth(head) - visibleWidth(here) - visibleWidth(tail) - 2,
      );
      const name = truncateToWidth(label, room, "…");
      return truncateToWidth(
        `${head}${selected ? list.selectedText(name) : name}${here}${tail ? dim(`  ${tail}`) : ""}`,
        width,
        dim("…"),
      );
    });
    const wrap = (text: string) =>
      wrapTextWithAnsi(text, Math.max(1, width - 1)).map((line) => ` ${line}`);
    const bottom: string[] = [];
    if (this.renaming)
      bottom.push(
        truncateToWidth(list.description(" Label (empty names it from the next message):"), width),
        ...this.renaming.render(width),
        truncateToWidth(list.description(" Enter save · Esc cancel"), width),
      );
    else if (this.confirming !== undefined)
      bottom.push(
        ...wrap(theme.fg("warning", ARCHIVE_HELP)),
        truncateToWidth(list.description(" a again to archive · Esc keep it"), width),
      );
    else {
      if (this.message !== undefined)
        bottom.push(...wrap(theme.fg(this.message.error ? "error" : "success", this.message.text)));
      bottom.push(
        ...wrap(
          list.description(
            `Enter open · n new · r rename · a ${this.archivedSelected() ? "unarchive" : "archive"} · h ${
              this.archived ? "hide" : "show"
            } archived · Esc`,
          ),
        ),
      );
    }
    return [
      rule,
      truncateToWidth(
        ` ${list.selectedText("Roots")}${dim(" · each has its own workers and goals")}`,
        width,
        "…",
      ),
      ...(lines.length ? lines : [dim("  No roots")]),
      ...bottom,
      rule,
    ];
  }

  private archivedSelected(): boolean {
    return this.roots.find((root) => root.id === this.selected)?.archived ?? false;
  }

  private run(action: Promise<void>, done?: string): void {
    this.message = undefined;
    void action.then(
      () => {
        if (done !== undefined) this.message = { text: done, error: false };
        this.changed();
      },
      (error: unknown) => {
        this.message = {
          text: error instanceof Error ? error.message : String(error),
          error: true,
        };
        this.changed();
      },
    );
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const cancel = keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c");
    const id = this.selected;
    if (this.renaming) {
      if (cancel) this.renaming = undefined;
      else if (keys.matches(data, "tui.select.confirm")) {
        const label = this.renaming.getValue();
        this.renaming = undefined;
        this.run(
          this.actions.rename(id, label),
          label.trim() ? "renamed" : "named by its next message",
        );
      } else this.renaming.handleInput(data);
      return;
    }
    if (this.confirming !== undefined) {
      const confirmed = data === "a" && this.confirming === id;
      this.confirming = undefined;
      if (confirmed)
        this.run(this.actions.archive(id, true), "archived · h shows it, nothing was deleted");
      return;
    }
    const rows = this.rows();
    const index = rows.findIndex((root) => root.id === id);
    if (keys.matches(data, "tui.select.up")) this.selected = rows[Math.max(0, index - 1)]?.id ?? id;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = rows[Math.min(rows.length - 1, index + 1)]?.id ?? id;
    else if (keys.matches(data, "tui.select.confirm")) {
      if (id) this.actions.open(id);
    } else if (cancel) this.actions.close();
    else if (data === "n") this.run(this.actions.create());
    else if (data === "h") {
      this.archived = !this.archived;
      this.update(this.roots);
    } else if (!id) return;
    else if (data === "r") {
      const input = new Input();
      const root = this.roots.find((each) => each.id === id);
      if (root?.named) input.setValue(root.label);
      input.focused = this._focused;
      this.renaming = input;
    } else if (data === "a") {
      if (this.archivedSelected()) this.run(this.actions.archive(id, false), "unarchived");
      else this.confirming = id;
    }
  }

  invalidate(): void {}
}
