import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ShortIds } from "../../ui/ids.ts";
import { theme } from "../theme/theme.ts";

/** A short id as jj shows one: the unique prefix in the warning color, the rest dim. */
export function shortIdLabel(ids: ShortIds, id: number): string {
  const { unique, rest } = ids.split(id);
  return theme.fg("warning", unique) + theme.fg("dim", rest);
}

/** The muted line under a message: when it was sent and its short id. Read at render, so a longer prefix repaints. */
export class EntryStamp implements Component {
  private readonly ids: ShortIds;
  private readonly id: number;
  private readonly time: string;

  constructor(ids: ShortIds, id: number, time: string) {
    this.ids = ids;
    this.id = id;
    this.time = time;
  }

  render(width: number): string[] {
    return [
      truncateToWidth(
        ` ${theme.fg("dim", `${this.time} · `)}${shortIdLabel(this.ids, this.id)}`,
        width,
      ),
    ];
  }

  invalidate(): void {}
}
