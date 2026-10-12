/*
Adapted from Pi packages/coding-agent/src/core/tools/renderers/write.ts.

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
import { Container, Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode, type Theme } from "../theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions, RenderArgs } from "./types.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, getTextOutput } from "./utils.ts";

type WriteHighlightCache = {
  rawPath: string | null;
  lang: string;
  rawContent: string;
  normalizedLines: string[];
  highlightedLines: string[];
};
class WriteCallRenderComponent extends Text {
  cache: WriteHighlightCache | undefined;

  constructor() {
    super("", 0, 0);
  }
}
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
function highlightSingleLine(line: string, lang: string): string {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}
function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
  const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
  if (prefixCount === 0) return;
  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlightCode(prefixSource, cache.lang);
  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] =
      prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
  }
}
function rebuildWriteHighlightCacheFull(
  rawPath: string | null,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  const displayContent = normalizeDisplayText(fileContent);
  const normalized = replaceTabs(displayContent);
  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang),
  };
}
function updateWriteHighlightCacheIncremental(
  cache: WriteHighlightCache | undefined,
  rawPath: string | null,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (cache.lang !== lang || cache.rawPath !== rawPath)
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (!fileContent.startsWith(cache.rawContent))
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (fileContent.length === cache.rawContent.length) return cache;

  const deltaRaw = fileContent.slice(cache.rawContent.length);
  const deltaDisplay = normalizeDisplayText(deltaRaw);
  const deltaNormalized = replaceTabs(deltaDisplay);
  cache.rawContent = fileContent;
  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }

  const segments = deltaNormalized.split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  const lastLine = (cache.normalizedLines[lastIndex] ?? "") + (segments[0] ?? "");
  cache.normalizedLines[lastIndex] = lastLine;
  cache.highlightedLines[lastIndex] = highlightSingleLine(lastLine, cache.lang);
  for (const segment of segments.slice(1)) {
    cache.normalizedLines.push(segment);
    cache.highlightedLines.push(highlightSingleLine(segment, cache.lang));
  }
  refreshWriteHighlightPrefix(cache);
  return cache;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}
function formatWriteCall(
  args: RenderArgs,
  options: ToolRenderResultOptions,
  theme: Theme,
  cache: WriteHighlightCache | undefined,
  cwd: string,
): string {
  const rawPath = args.path;
  const fileContent = args.content;
  const pathDisplay = renderToolPath(rawPath, theme, cwd);
  let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

  if (fileContent === null) {
    text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  } else if (fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
    const renderedLines = lang
      ? (cache?.highlightedLines ??
        highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
      : normalizeDisplayText(fileContent).split("\n");
    const lines = trimTrailingEmptyLines(renderedLines);
    const totalLines = lines.length;
    const maxLines = options.expanded ? lines.length : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${theme.fg("muted", "ctrl+o to expand")}${theme.fg("muted", ")")}`;
    }
  }

  return text;
}
export const writeRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const rawPath = args.path;
    const fileContent = args.content;
    const component =
      context.lastComponent instanceof WriteCallRenderComponent
        ? context.lastComponent
        : new WriteCallRenderComponent();
    if (fileContent !== null) {
      component.cache = context.argsComplete
        ? rebuildWriteHighlightCacheFull(rawPath, fileContent)
        : updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
    } else {
      component.cache = undefined;
    }
    component.setText(
      formatWriteCall(
        args,
        { expanded: context.expanded, isPartial: context.isPartial },
        theme,
        component.cache,
        context.cwd,
      ),
    );
    return component;
  },
  renderResult(result, _options, theme, context) {
    const output = context.isError ? getTextOutput(result, context.showImages) : "";
    if (!output) {
      const component =
        context.lastComponent instanceof Container ? context.lastComponent : new Container();
      component.clear();
      return component;
    }
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(`\n${theme.fg("error", output)}`);
    return text;
  },
};
