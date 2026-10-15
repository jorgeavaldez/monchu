/*
Adapted from Pi packages/coding-agent/src/modes/interactive/theme/theme.ts.

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
import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  parseColor,
  type MarkdownTheme,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage, type HighlightTheme } from "./syntax-highlight.ts";
import { dark, light } from "./colors.ts";

type ThemeColor = Exclude<keyof typeof dark, ThemeBg>;
type ThemeBg =
  | "selectedBg"
  | "searchMatchBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg"
  | "workerMessageBg";

function isBackground(token: string): token is ThemeBg {
  return (
    token === "selectedBg" ||
    token === "searchMatchBg" ||
    token === "userMessageBg" ||
    token === "customMessageBg" ||
    token === "toolPendingBg" ||
    token === "toolSuccessBg" ||
    token === "toolErrorBg" ||
    token === "workerMessageBg"
  );
}
function isForeground(token: string): token is ThemeColor {
  return token in dark && !isBackground(token);
}

class Theme {
  private readonly fgAnsi = new Map<ThemeColor, string>();
  private readonly bgAnsi = new Map<ThemeBg, string>();

  constructor(colors: typeof dark) {
    const mode = getTerminalColorMode();
    for (const token of Object.keys(colors)) {
      if (isBackground(token)) {
        const value = colors[token];
        this.bgAnsi.set(token, value === "" ? "\x1b[49m" : backgroundAnsi(parseColor(value), mode));
      } else if (isForeground(token)) {
        const value = colors[token];
        this.fgAnsi.set(token, value === "" ? "\x1b[39m" : foregroundAnsi(parseColor(value), mode));
      }
    }
  }

  fg(color: ThemeColor, text: string): string {
    const ansi = this.fgAnsi.get(color);
    if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`;
  }

  bg(color: ThemeBg, text: string): string {
    const ansi = this.bgAnsi.get(color);
    if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[49m`;
  }

  bold(text: string): string {
    return chalk.bold(text);
  }
  italic(text: string): string {
    return chalk.italic(text);
  }
  underline(text: string): string {
    return chalk.underline(text);
  }
  inverse(text: string): string {
    return chalk.inverse(text);
  }
  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }
}

export type { Theme };
export let theme = new Theme(dark);

export function initTheme(name: string = "dark"): void {
  if (name !== "dark" && name !== "light") throw new Error(`Unknown built-in theme: ${name}`);
  theme = new Theme(name === "light" ? light : dark);
}

let cachedHighlightThemeFor: Theme | undefined;
let cachedHighlightTheme: HighlightTheme | undefined;

function buildHighlightTheme(t: Theme): HighlightTheme {
  return {
    keyword: (s: string) => t.fg("syntaxKeyword", s),
    built_in: (s: string) => t.fg("syntaxType", s),
    literal: (s: string) => t.fg("syntaxNumber", s),
    number: (s: string) => t.fg("syntaxNumber", s),
    regexp: (s: string) => t.fg("syntaxString", s),
    string: (s: string) => t.fg("syntaxString", s),
    comment: (s: string) => t.fg("syntaxComment", s),
    doctag: (s: string) => t.fg("syntaxComment", s),
    meta: (s: string) => t.fg("muted", s),
    function: (s: string) => t.fg("syntaxFunction", s),
    title: (s: string) => t.fg("syntaxFunction", s),
    class: (s: string) => t.fg("syntaxType", s),
    type: (s: string) => t.fg("syntaxType", s),
    tag: (s: string) => t.fg("syntaxPunctuation", s),
    name: (s: string) => t.fg("syntaxKeyword", s),
    attr: (s: string) => t.fg("syntaxVariable", s),
    variable: (s: string) => t.fg("syntaxVariable", s),
    params: (s: string) => t.fg("syntaxVariable", s),
    operator: (s: string) => t.fg("syntaxOperator", s),
    punctuation: (s: string) => t.fg("syntaxPunctuation", s),
    emphasis: (s: string) => t.italic(s),
    strong: (s: string) => t.bold(s),
    link: (s: string) => t.underline(s),
    addition: (s: string) => t.fg("toolDiffAdded", s),
    deletion: (s: string) => t.fg("toolDiffRemoved", s),
  };
}

function getHighlightTheme(t: Theme): HighlightTheme {
  if (cachedHighlightThemeFor !== t || !cachedHighlightTheme) {
    cachedHighlightThemeFor = t;
    cachedHighlightTheme = buildHighlightTheme(t);
  }
  return cachedHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
  // Validate language before highlighting to avoid stderr spam from cli-highlight
  const validLang = lang && supportsLanguage(lang) ? lang : undefined;
  // Skip highlighting when no valid language is specified. cli-highlight's
  // auto-detection is unreliable and can misidentify prose as AppleScript,
  // LiveCodeServer, etc., coloring random English words as keywords.
  if (!validLang) {
    return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
  }
  const opts = {
    language: validLang,
    ignoreIllegals: true,
    theme: getHighlightTheme(theme),
  };
  try {
    return highlight(code, opts).split("\n");
  } catch {
    return code.split("\n");
  }
}

/**
 * Get language identifier from file path extension.
 */
const extToLang: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  perl: "perl",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  vim: "vim",
  graphql: "graphql",
  proto: "protobuf",
  tf: "hcl",
  hcl: "hcl",
};

export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? extToLang[ext] : undefined;
}

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => theme.strikethrough(text),
    highlightCode: (code: string, lang?: string): string[] => {
      // Validate language before highlighting to avoid stderr spam from cli-highlight
      const validLang = lang && supportsLanguage(lang) ? lang : undefined;
      // Skip highlighting when no valid language is specified. cli-highlight's
      // auto-detection is unreliable and can misidentify prose as AppleScript,
      // LiveCodeServer, etc., coloring random English words as keywords.
      if (!validLang) {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
      const opts = {
        language: validLang,
        ignoreIllegals: true,
        theme: getHighlightTheme(theme),
      };
      try {
        return highlight(code, opts).split("\n");
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    },
  };
}

export function getSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}
