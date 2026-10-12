/*
Adapted from Pi packages/coding-agent/src/core/tools/render-utils.ts.

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
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import {
  getCapabilities,
  getImageDimensions,
  hyperlink,
  imageFallback,
} from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import { stripAnsi } from "./ansi.ts";
import { resolve, isAbsolute } from "node:path";

export function shortenPath(path: string): string {
  const home = os.homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
  if (!getCapabilities().hyperlinks) return styledText;
  const expanded = rawPath.startsWith("~/") ? os.homedir() + rawPath.slice(1) : rawPath;
  const absolutePath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

export function getTextOutput(
  result:
    | { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
    | undefined,
  showImages: boolean,
): string {
  if (!result) return "";

  const textBlocks = result.content.filter((c) => c.type === "text");
  const imageBlocks = result.content.filter((c) => c.type === "image");

  let output = textBlocks
    .map((c) =>
      Array.from(stripAnsi(c.text || ""))
        .filter((character) => {
          const code = character.charCodeAt(0);
          return (code >= 32 || code === 9 || code === 10) && (code < 0xfff9 || code > 0xfffb);
        })
        .join(""),
    )
    .join("\n");

  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const imageIndicators = imageBlocks
      .map((img) => {
        const mimeType = img.mimeType ?? "image/unknown";
        const dims =
          img.data && img.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dims);
      })
      .join("\n");
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
export function formatToolCallWithArgs(
  title: string,
  args: unknown,
  theme: Theme,
  expanded: boolean,
): string {
  const header = theme.fg("toolTitle", theme.bold(title));
  if (args == null) return header;
  const entries: [string, unknown][] =
    typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
  if (entries.length === 0) return header;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text =
        typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
      return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
    });
    return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
  }
  const pairs = entries
    .map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
    .join(" ");
  const preview =
    pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
  return `${header} ${theme.fg("muted", preview)}`;
}

export function invalidArgText(theme: Theme): string {
  return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
  rawPath: string | null,
  theme: Theme,
  cwd: string,
  options?: { emptyFallback?: string },
): string {
  if (rawPath === null) return invalidArgText(theme);
  const value = rawPath || options?.emptyFallback;
  if (!value) return theme.fg("toolOutput", "...");
  return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
