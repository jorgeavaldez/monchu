/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/visual-truncate.ts.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by tool renderers and bash-execution.ts for consistent behavior.
 */

import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

interface VisualTruncateResult {
  /** The visual lines to display */
  visualLines: string[];
  /** Number of visual lines that were skipped (hidden) */
  skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines.
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @param keep - Which visual lines to keep: the last ones (default) or the first ones.
 * @returns The truncated visual lines and count of skipped lines
 */
function truncateToVisualLines(
  text: string,
  maxVisualLines: number,
  width: number,
  paddingX: number = 0,
  keep: "start" | "end" = "end",
): VisualTruncateResult {
  if (!text) {
    return { visualLines: [], skippedCount: 0 };
  }

  // Create a temporary Text component to render and get visual lines
  const tempText = new Text(text, paddingX, 0);
  const allVisualLines = tempText.render(width);

  if (allVisualLines.length <= maxVisualLines) {
    return { visualLines: allVisualLines, skippedCount: 0 };
  }

  const truncatedLines =
    keep === "start"
      ? allVisualLines.slice(0, maxVisualLines)
      : allVisualLines.slice(-maxVisualLines);
  const skippedCount = allVisualLines.length - maxVisualLines;

  return { visualLines: truncatedLines, skippedCount };
}

interface VisualLinePreviewOptions {
  /** Styled text; may contain newlines. */
  text: string;
  maxVisualLines: number;
  /** Which visual lines to keep. The hint goes before kept end lines and after kept start lines. */
  keep: "start" | "end";
  /** Styled hint line for the given number of hidden visual lines. */
  formatHint: (hidden: number) => string;
}

/**
 * Collapsed tool output limited to a number of visual lines, like bash output. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen.
 * Caches its lines per width, since it renders on every frame for every result in the transcript.
 */
export class VisualLinePreview implements Component {
  private options: VisualLinePreviewOptions;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(options: VisualLinePreviewOptions) {
    this.options = options;
  }

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const { text, maxVisualLines, keep, formatHint } = this.options;
      const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
      const lines = preview.visualLines;
      if (preview.skippedCount > 0) {
        const hint = truncateToWidth(formatHint(preview.skippedCount), width, "...");
        this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
      } else {
        this.cachedLines = lines;
      }
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
