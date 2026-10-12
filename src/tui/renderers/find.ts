/*
Adapted from Pi packages/coding-agent/src/core/tools/renderers/find.ts.

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
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions, RenderArgs, RenderResult } from "./types.ts";
import { getTextOutput, invalidArgText, shortenPath } from "./utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

function formatFindCall(args: RenderArgs, theme: Theme): string {
  const pattern = args.pattern;
  const rawPath = args.path;
  const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);
  let text =
    theme.fg("toolTitle", theme.bold("find")) +
    " " +
    (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}
function formatFindResult(
  result: RenderResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  showImages: boolean,
): string {
  const output = getTextOutput(result, showImages).trim();
  let text = "";
  if (output) {
    const lines = output.split("\n");
    const maxLines = options.expanded ? lines.length : 20;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${theme.fg("muted", "ctrl+o to expand")}${theme.fg("muted", ")")}`;
    }
  }

  const resultLimit = result.details?.resultLimitReached;
  const truncation = result.details?.truncation;
  if (resultLimit || truncation?.truncated) {
    const warnings: string[] = [];
    if (resultLimit) warnings.push(`${resultLimit} results limit`);
    if (truncation?.truncated)
      warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
  }
  return text;
}

export const findRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(formatFindCall(args, theme));
    return text;
  },
  renderResult(result, options, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(formatFindResult(result, options, theme, context.showImages));
    return text;
  },
};
