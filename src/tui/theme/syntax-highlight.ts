/*
Adapted from Pi packages/coding-agent/src/utils/syntax-highlight.ts.

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
import hljs from "highlight.js";
import { decodeHtmlEntityAt } from "./html.ts";

type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

interface HighlightOptions {
  language?: string;
  ignoreIllegals?: boolean;
  languageSubset?: string[];
  theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  if (!classValue) {
    return undefined;
  }

  for (const className of classValue.split(/\s+/)) {
    if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
      return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
    }
  }

  return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
  const exact = theme[scope];
  if (exact) {
    return exact;
  }

  const dotIndex = scope.indexOf(".");
  if (dotIndex !== -1) {
    const prefixFormatter = theme[scope.slice(0, dotIndex)];
    if (prefixFormatter) {
      return prefixFormatter;
    }
  }

  const dashIndex = scope.indexOf("-");
  if (dashIndex !== -1) {
    const prefixFormatter = theme[scope.slice(0, dashIndex)];
    if (prefixFormatter) {
      return prefixFormatter;
    }
  }

  return undefined;
}

function getActiveFormatter(
  scopes: Array<string | undefined>,
  theme: HighlightTheme,
): HighlightFormatter | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) {
      continue;
    }
    const formatter = getScopeFormatter(scope, theme);
    if (formatter) {
      return formatter;
    }
  }
  return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
  if (!html.startsWith("<span", index)) {
    return false;
  }
  const nextChar = html[index + "<span".length];
  return (
    nextChar === ">" ||
    nextChar === " " ||
    nextChar === "\t" ||
    nextChar === "\n" ||
    nextChar === "\r"
  );
}

function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
  let output = "";
  let textBuffer = "";
  const scopes: Array<string | undefined> = [];

  const flushText = () => {
    if (!textBuffer) {
      return;
    }
    const formatter = getActiveFormatter(scopes, theme);
    output += formatter ? formatter(textBuffer) : textBuffer;
    textBuffer = "";
  };

  let index = 0;
  while (index < html.length) {
    if (isSpanOpenTagStart(html, index)) {
      const tagEndIndex = html.indexOf(">", index + 5);
      if (tagEndIndex !== -1) {
        flushText();
        const tag = html.slice(index, tagEndIndex + 1);
        const scope = getScopeFromSpanTag(tag);
        scopes.push(scope);
        index = tagEndIndex + 1;
        continue;
      }
    }

    if (html.startsWith(SPAN_CLOSE, index)) {
      flushText();
      if (scopes.length > 0) {
        scopes.pop();
      }
      index += SPAN_CLOSE.length;
      continue;
    }

    if (html[index] === "&") {
      const decoded = decodeHtmlEntityAt(html, index);
      if (decoded) {
        textBuffer += decoded.text;
        index += decoded.length;
        continue;
      }
    }

    textBuffer += html[index];
    index++;
  }

  flushText();
  return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
  const html = options.language
    ? hljs.highlight(code, {
        language: options.language,
        ignoreIllegals: options.ignoreIllegals ?? true,
      }).value
    : hljs.highlightAuto(code, options.languageSubset).value;
  return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
  return hljs.getLanguage(name) !== undefined;
}
