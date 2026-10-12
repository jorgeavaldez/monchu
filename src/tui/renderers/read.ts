/*
Adapted from Pi packages/coding-agent/src/core/tools/renderers/read.ts.

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
import { basename, dirname, relative, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode, type Theme } from "../theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions, RenderArgs, RenderResult } from "./types.ts";
import { getTextOutput, renderToolPath, replaceTabs } from "./utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";

interface CompactReadClassification {
  kind: "resource" | "skill";
  label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);
function formatReadLineRange(args: RenderArgs, theme: Theme): string {
  // Strict tool schemas make models send null for omitted optional fields.
  if (args?.offset == null && args?.limit == null) return "";
  const startLine = args.offset ?? 1;
  const endLine = args.limit != null ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}
function formatReadCall(args: RenderArgs, theme: Theme, cwd: string): string {
  const pathDisplay = renderToolPath(args.path, theme, cwd);
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}
function getCompactReadClassification(
  args: RenderArgs,
  cwd: string,
): CompactReadClassification | undefined {
  const rawPath = args.path;
  if (!rawPath) return undefined;

  const absolutePath = resolve(cwd, rawPath);
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
  }

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: relative(cwd, absolutePath) || absolutePath };
  }

  return undefined;
}
function formatCompactReadCall(
  classification: CompactReadClassification,
  args: RenderArgs,
  theme: Theme,
): string {
  const expandHint = theme.fg("dim", " (ctrl+o to expand)");
  if (classification.kind === "skill") {
    return (
      theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
      theme.fg("customMessageText", classification.label) +
      formatReadLineRange(args, theme) +
      expandHint
    );
  }

  return (
    theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
    " " +
    theme.fg("accent", classification.label) +
    formatReadLineRange(args, theme) +
    expandHint
  );
}
function formatReadResult(
  args: RenderArgs,
  result: RenderResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  showImages: boolean,
  isError: boolean,
): string {
  if (!options.expanded && !isError) {
    return "";
  }

  const rawPath = args.path;
  const output = getTextOutput(result, showImages);
  const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
  const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
  const lines = trimTrailingEmptyLines(renderedLines);
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${theme.fg("muted", "ctrl+o to expand")}${theme.fg("muted", ")")}`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }
  return text;
}

export const readRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const classification = !context.expanded
      ? getCompactReadClassification(args, context.cwd)
      : undefined;
    text.setText(
      classification
        ? formatCompactReadCall(classification, args, theme)
        : formatReadCall(args, theme, context.cwd),
    );
    return text;
  },
  renderResult(result, options, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(
      formatReadResult(context.args, result, options, theme, context.showImages, context.isError),
    );
    return text;
  },
};
