import {
  getCapabilities,
  hyperlink,
  sliceByColumn,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * A URL on rows of its own with no padding, cut at the width rather than wrapped at word breaks, so a selection copies
 * exactly the URL. Each row is an OSC 8 link to the whole URL where the terminal supports them.
 */
export class LinkRows implements Component {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  render(width: number): string[] {
    const rows: string[] = [];
    const total = visibleWidth(this.url);
    for (let start = 0; start < total; start += Math.max(1, width))
      rows.push(sliceByColumn(this.url, start, Math.max(1, width)));
    const link = getCapabilities().hyperlinks;
    return rows.map((row) => theme.fg("accent", link ? hyperlink(row, this.url) : row));
  }

  invalidate(): void {}
}
