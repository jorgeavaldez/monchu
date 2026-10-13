/*
Tool logic ported from @ff-labs/pi-fff 0.11.0:
https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff
Copyright (c) 2025 Dmitriy Kovalenko
MIT License

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
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import {
  FileFinder,
  type FileFinderApi,
  type GrepCursor,
  type GrepMode,
  type GrepResult,
  type SearchResult,
} from "@ff-labs/fff-node";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
const GREP_MAX_MATCHES_PER_FILE = 200;
const GREP_CONTEXT_MAX = 20;
const GREP_MAX_LINE_LENGTH = 500;
const GREP_TIME_BUDGET_MS = 10_000;

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// Clamp caller-supplied context to a non-negative bounded integer so a large
// value cannot multiply output size past the model window.
function clampContext(context: number | undefined): number {
  if (!context || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

// DO NOT ATTEMPT TO RESORT OUTPUT HERE IT ONLY CONFUSES MODELS
function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";

  // Build file-grouped output in the order files first appear in the result.
  // This preserves native frecency ordering across files without re-sorting.
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    const before = match.contextBefore ?? [];
    before.forEach((line, i) => {
      const lineNum = match.lineNumber - before.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber + 1 + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

// Weak-match threshold is derived from the query length, matching the
// scoring formula in crates/fff-core/src/score.rs: a perfect match scores
// `len * 12`, so we treat anything below 50% of that as scattered fuzzy noise.
// When the top score is weak, trim output to a small sample instead of dumping
// the full limit worth of noise into the agent's context.
const FIND_WEAK_SAMPLE_SIZE = 5;

interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

function formatFindOutput(result: SearchResult, limit: number, pattern: string): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  // NO CUSTOM SORTING — trust native frecency order from the engine.

  // Peek at the top native score to decide whether results are scattered
  // fuzzy noise (query length-scaled threshold from score.rs).
  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < Math.floor((pattern.length * 12 * 50) / 100);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = result.items.slice(0, effective);

  return {
    output: shown.map((p) => `${p.relativePath}${fffFileAnnotation(p)}`).join("\n"),
    weak,
    shownCount: shown.length,
  };
}

function normalizePathConstraint(pathConstraint: string, cwd: string): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
    if (relative === "") return null;
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
    }
    trimmed = relative;
  }

  if (trimmed === "." || trimmed === "./") return null;
  // Strip a leading `./` so `./**/*.rs` and `**/*.rs` behave identically.
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // wif we left with the ** it means anything so treat it as a cwd path
  if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return null;

  // FFF's glob matcher can treat a hidden directory root glob such as
  // `.agents/**` as empty, while the tool contract says this means "inside
  // this directory". Collapse simple trailing recursive directory globs to the
  // directory-prefix constraint understood by the parser. Keep real file globs
  // such as `src/**/*.ts` unchanged.
  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  // Already signals path-constraint syntax to the parser.
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  // Globs (`*.ts`, `src/**/*.cc`, `{src,lib}`) are handled by the parser.
  if (/[*?[{]/.test(trimmed)) return trimmed;
  // Filename with extension (`main.rs`, `config.json`) → FilePath constraint.
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  // Bare directory prefix → append `/` so the parser sees a PathSegment.
  return `${trimmed}/`;
}

// Exclusions are emitted as `!<constraint>` tokens, which the Rust parser
// understands (crates/fff-query-parser/src/parser.rs). We normalize each one
// the same way as the include path so bare dirs become PathSegment excludes.
// Tolerate callers passing already-negated forms like `!src/` by stripping
// the leading `!` before normalizing so we never double-negate (`!!src/`).
function normalizeExcludes(exclude: string | string[] | undefined, cwd: string): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

function buildQuery(
  path: string | undefined,
  pattern: string,
  exclude: string | string[] | undefined,
  cwd: string,
): string {
  const parts: string[] = [];
  if (path) {
    const pathConstraint = normalizePathConstraint(path, cwd);
    if (pathConstraint) parts.push(pathConstraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  parts.push(pattern);
  return parts.join(" ");
}

// Split an absolute path into an existing directory (the aux root) and a
// remainder usable as a fuzzy path constraint relative to that root. Glob and
// nonexistent segments both go into the suffix: we walk up to the nearest
// existing ancestor so partially-wrong paths still resolve to a search root.
function resolveAuxRoot(absPath: string): { root: string; suffix: string } | null {
  const trimmed = path.normalize(absPath.trim()).replace(/\/+$/, "") || "/";
  if (!path.isAbsolute(trimmed)) return null;
  if (trimmed === path.sep) return { root: path.sep, suffix: "" };

  const parts = trimmed.split(path.sep);
  const firstGlob = parts.findIndex((p) => /[*?[{]/.test(p));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;

  // Deepest existing non-glob prefix wins; everything below it is suffix.
  for (let i = boundary; i > 0; i--) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      return {
        root: parts.slice(0, i - 1).join(path.sep) || path.sep,
        suffix: parts.slice(i - 1).join("/"),
      };
    }
    return { root: candidate, suffix: parts.slice(i).join("/") };
  }
  return null;
}

// Decide whether a `path` parameter should route to the workspace finder or
// to an aux finder. Accepts absolute paths, `~`-prefixed paths, and relative
// paths escaping the workspace (`../other-project`); everything is resolved
// against cwd first. Returns null to signal "no rerouting" (workspace finder).
function routePathConstraint(
  pathConstraint: string | undefined,
  cwd: string,
): { root: string; suffix: string } | null {
  if (!pathConstraint) return null;
  let candidate = pathConstraint.trim();
  if (!candidate) return null;
  if (candidate === "~" || candidate.startsWith("~/"))
    candidate = path.join(homedir(), candidate.slice(1));
  if (!path.isAbsolute(candidate)) {
    // Plain workspace-relative constraints stay on the workspace finder.
    if (candidate !== ".." && !candidate.startsWith("../")) return null;
    candidate = path.resolve(cwd, candidate);
  }
  const rel = path.relative(cwd, candidate);
  if (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)) return null;
  return resolveAuxRoot(candidate);
}

function rootCovers(root: string, target: string): boolean {
  if (root === target) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

type FinderEntry = {
  root: string;
  ready: Promise<FileFinderApi>;
  users: number;
  lastUsed: number;
};

/** One host owns native handles and Monchu-local databases across reloads.
 * Leases keep concurrent calls from destroying each other's indexes.
 */
export class FffFinders {
  private readonly entries = new Map<string, FinderEntry>();
  private dbDisabled = false;
  private closed = false;

  private readonly home: string;
  private readonly report: (warning: string) => void;

  constructor(home: string, report: (warning: string) => void) {
    this.home = home;
    this.report = report;
  }

  private async create(root: string): Promise<FileFinderApi> {
    const options = {
      basePath: root,
      aiMode: true,
      enableHomeDirScanning: true,
      followSymlinks: true,
    };
    let result = FileFinder.create({
      ...options,
      ...(this.dbDisabled
        ? {}
        : {
            frecencyDbPath: path.join(this.home, "fff", "frecency"),
            historyDbPath: path.join(this.home, "fff", "history"),
          }),
    });
    if (!result.ok && !this.dbDisabled) {
      const failure = result.error;
      const dbLess = FileFinder.create(options);
      if (dbLess.ok) {
        result = dbLess;
        this.dbDisabled = true;
        this.report(
          `(fff): Failed to open frecency/history database (${failure}). Continuing without frecency persistence.`,
        );
      }
    }
    if (!result.ok)
      throw new Error(`Failed to create FFF file picker for ${root}: ${result.error}`);
    const finder = result.value;
    try {
      // Like Pi, bound scan startup to 15 seconds, not a guarantee of a complete index.
      await finder.waitForScan(15_000);
      return finder;
    } catch (error) {
      finder.destroy();
      throw error;
    }
  }

  private sweep(): void {
    const idle = [...this.entries.values()]
      .filter((entry) => entry.users === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (this.entries.size <= 4 && Date.now() - entry.lastUsed <= 5 * 60 * 1000) continue;
      this.entries.delete(entry.root);
      void entry.ready.then(
        (finder) => finder.destroy(),
        () => {},
      );
    }
  }

  async use<T>(
    cwd: string,
    search: { pattern: string; path?: string; exclude?: string | string[] },
    resumed: { root: string; query: string } | undefined,
    run: (finder: FileFinderApi, query: string, root: string) => T,
  ): Promise<T> {
    if (this.closed) throw new Error("FFF finders are closed");
    this.sweep();
    const route = resumed === undefined ? routePathConstraint(search.path, cwd) : null;
    const root = path.resolve(resumed?.root ?? route?.root ?? cwd);
    let entry = this.entries.get(root);
    if (entry === undefined && route !== null) {
      for (const candidate of this.entries.values()) {
        if (
          rootCovers(candidate.root, root) &&
          (entry === undefined || candidate.root.length > entry.root.length)
        )
          entry = candidate;
      }
    }
    if (entry === undefined) {
      entry = { root, ready: this.create(root), users: 0, lastUsed: Date.now() };
      this.entries.set(root, entry);
    }
    const leased = entry;
    leased.users++;
    try {
      const finder = await leased.ready;
      const suffix =
        route === null
          ? search.path
          : [path.relative(leased.root, route.root).replaceAll(path.sep, "/"), route.suffix]
              .filter(Boolean)
              .join("/");
      const query =
        resumed?.query ??
        buildQuery(suffix || undefined, search.pattern, search.exclude, leased.root);
      return run(finder, query, leased.root);
    } catch (error) {
      // Failed initialization must not poison subsequent searches.
      void leased.ready.catch(() => {
        if (this.entries.get(leased.root) === leased) this.entries.delete(leased.root);
      });
      throw error;
    } finally {
      leased.users--;
      leased.lastUsed = Date.now();
      this.sweep();
    }
  }

  /** Called only after Durable has settled every invocation. */
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const finder = await entry.ready.catch(() => undefined);
        finder?.destroy();
      }),
    );
  }
}

export function createFffTools(finders: FffFinders) {
  const cursorCache = new Map<string, GrepCursor>();
  let cursorCounter = 0;

  function storeCursor(cursor: GrepCursor): string {
    const id = `fff_c${++cursorCounter}`;
    cursorCache.set(id, cursor);
    if (cursorCache.size > 200) {
      const first = cursorCache.keys().next().value;
      if (first) cursorCache.delete(first);
    }
    return id;
  }

  // Find pagination uses a page-index cursor: native `fileSearch` takes
  // pageIndex/pageSize, so the cursor is just the next page index paired with
  // the query+limit that produced it. Stored tokens are opaque IDs to the agent.
  interface FindCursor {
    query: string;
    pattern: string;
    pageSize: number;
    nextPageIndex: number;
    root: string;
  }

  const findCursorCache = new Map<string, FindCursor>();
  let findCursorCounter = 0;

  function storeFindCursor(cursor: FindCursor): string {
    const id = `${++findCursorCounter}`;
    findCursorCache.set(id, cursor);
    if (findCursorCache.size > 200) {
      const first = findCursorCache.keys().next().value;
      if (first) findCursorCache.delete(first);
    }
    return id;
  }

  const grepSchema = Type.Object({
    pattern: Type.String({
      description: "Search pattern (literal text or regex)",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
      }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        description: `Context lines before+after each match (0-${GREP_CONTEXT_MAX})`,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
  });

  const grep = defineTool({
    name: "ffgrep",
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
    parameters: grepSchema,
    replay: "safe",

    async execute(params, api, context) {
      const signal = context.abortSignal;
      if (api.env === undefined) throw new Error("FFF tools require a local execution environment");
      if (signal?.aborted) throw new Error("Operation aborted");

      const pattern = params.pattern;
      return finders.use(api.env.cwd, params, undefined, (picker, query) => {
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
        // pageSize caps TOTAL matches across all files (soft cap: the current file
        // is always finished first). maxMatchesPerFile stays decoupled at the engine
        // default so same-file overflow remains reachable via cursor (#825).
        const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
        const context = clampContext(params.context);

        // Auto-detect: regex if the pattern has regex metacharacters AND parses
        // as a valid regex, otherwise plain literal. The fuzzy fallback below
        // only kicks in for plain mode — regex queries are intentional.
        const hasRegexSyntax = pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
        if (mode === "regex") {
          try {
            new RegExp(pattern);
          } catch {
            mode = "plain";
          }
        }

        // Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
        // to try to read a whole file. That's not what grep is for — return a terse error
        // steering them to a real pattern, preventing dozens of wasted retries.
        const p = pattern.trim();
        const isWildcardOnly =
          hasRegexSyntax &&
          /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
            p,
          );

        if (isWildcardOnly) {
          return {
            content: [
              {
                type: "text",
                text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
              },
            ],
            details: { totalMatched: 0, totalFiles: 0 },
          };
        }

        // caseSensitive override flips smartCase off; omitting it keeps smart-case
        // (case-insensitive when pattern is all lowercase).
        const smartCase = params.caseSensitive !== true;

        if (signal?.aborted) throw new Error("Operation aborted");
        const grepResult = picker.grep(query, {
          mode,
          smartCase,
          maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
          pageSize,
          cursor: (params.cursor ? cursorCache.get(params.cursor) : null) ?? null,
          beforeContext: context,
          afterContext: context,
          classifyDefinitions: true,
          timeBudgetMs: GREP_TIME_BUDGET_MS,
        });

        if (!grepResult.ok) throw new Error(grepResult.error);

        if (signal?.aborted) throw new Error("Operation aborted");
        let result = grepResult.value;
        let fuzzyNotice: string | null = null;

        // if we hit the timeout do not run the fuzzy fallback
        // cause it will only consumer more time
        if (result.items.length === 0 && !result.nextCursor && !params.cursor && mode !== "regex") {
          // When the caller pinned a specific file (path has an extension), the
          // fuzzy fallback broadens across the whole picker — the file may just
          // be misnamed. For directory constraints (or no path), we keep the
          // constrained query so the fallback does not leak matches from
          // excluded / out-of-scope directories.
          const lastSeg = params.path?.split(/[\\/]/).pop() ?? "";
          const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSeg);
          const fuzzyQuery = pathTargetsFile ? pattern : query;
          const fuzzy = picker.grep(fuzzyQuery, {
            mode: "fuzzy",
            smartCase,
            maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
            pageSize,
            cursor: null,
            beforeContext: 0,
            afterContext: 0,
            classifyDefinitions: true,
            timeBudgetMs: GREP_TIME_BUDGET_MS,
          });

          if (fuzzy.ok && fuzzy.value.items.length > 0) {
            fuzzyNotice = `0 exact matches. Maybe you meant this?`;
            result = fuzzy.value;
          }
        }

        let output = formatGrepOutput(result);
        const notices: string[] = [];
        if (result.regexFallbackError) {
          notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
        }
        if (result.nextCursor) {
          notices.push(`Continue with cursor="${storeCursor(result.nextCursor)}"`);
        }

        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
        if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            totalMatched: result.totalMatched,
            totalFiles: result.totalFiles,
          },
        };
      });
    },
  });
  const findSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
  });

  const find = defineTool({
    name: "fffind",
    description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
    parameters: findSchema,
    replay: "safe",

    async execute(params, api, context) {
      const signal = context.abortSignal;
      if (api.env === undefined) throw new Error("FFF tools require a local execution environment");
      if (signal?.aborted) throw new Error("Operation aborted");

      // if resumed we use the same picker as before
      const resumed = params.cursor ? findCursorCache.get(params.cursor) : undefined;
      return finders.use(api.env.cwd, params, resumed, (picker, query, root) => {
        const effectiveLimit = resumed
          ? resumed.pageSize
          : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);

        const pattern = resumed ? resumed.pattern : params.pattern;
        const pageIndex = resumed?.nextPageIndex ?? 0;

        if (signal?.aborted) throw new Error("Operation aborted");
        const searchResult = picker.fileSearch(query, {
          pageIndex,
          pageSize: effectiveLimit,
        });
        if (!searchResult.ok) throw new Error(searchResult.error);

        if (signal?.aborted) throw new Error("Operation aborted");
        const result = searchResult.value;
        const formatted = formatFindOutput(result, effectiveLimit, pattern);
        let output = formatted.output;

        // Infer hasMore: native fileSearch fills pageSize when more results
        // exist, so if we got a full page AND totalMatched exceeds what we've
        // shown so far there's another page to fetch.
        const shownSoFar = pageIndex * effectiveLimit + result.items.length;
        const hasMore = result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

        const notices: string[] = [];
        if (formatted.weak && formatted.shownCount > 0)
          notices.push(
            `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
          );

        if (!formatted.weak && hasMore) {
          const remaining = result.totalMatched - shownSoFar;
          const cursorId = storeFindCursor({
            query,
            pattern,
            pageSize: effectiveLimit,
            nextPageIndex: pageIndex + 1,
            root,
          });
          notices.push(
            `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
          );
        }

        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
        return {
          content: [{ type: "text", text: output }],
          details: {
            totalMatched: result.totalMatched,
            totalFiles: result.totalFiles,
            pageIndex,
            hasMore,
          },
        };
      });
    },
  });

  return [find, grep];
}
