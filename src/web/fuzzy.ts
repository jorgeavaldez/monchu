/**
 * Fuzzy search, fff-style: every space-separated term must match, as a substring or as its letters in order within a
 * short span. Smart case: a term with a capital letter matches case exactly, others ignore case. Pure, so it runs per
 * keystroke over a feed's text without touching the page.
 */

/** Where one term matched: its first and last character, and how good the match is. */
type Hit = { at: number; end: number; score: number };

const WORD = /[\p{L}\p{N}]/u;

/** A start of a word: the first character, or one after a non-word character. */
const wordStart = (text: string, at: number) => at === 0 || !WORD.test(text.charAt(at - 1));

/** The term's letters in order from `start`, as close together as they come; undefined past the span limit. */
function spread(text: string, term: string, start: number, limit: number): Hit | undefined {
  const stop = Math.min(text.length, start + limit);
  let at = start;
  // Scanned by hand within the span, so a miss never reads the rest of a long text.
  for (let index = 1; index < term.length; index++) {
    const char = term.charCodeAt(index);
    do at++;
    while (at < stop && text.charCodeAt(at) !== char);
    if (at >= stop) return undefined;
  }
  const span = at - start + 1;
  return {
    at: start,
    end: at,
    score: 50 - (span - term.length) + (wordStart(text, start) ? 5 : 0),
  };
}

/** The best place `term` matches `text` (already in the term's case), or undefined. */
function matchTerm(text: string, term: string): Hit | undefined {
  const exact = text.indexOf(term);
  if (exact >= 0) {
    // A later exact match at a word start beats the first one inside a word.
    let best = exact;
    for (let at = exact, tries = 0; at >= 0 && tries < 32; at = text.indexOf(term, at + 1), tries++)
      if (wordStart(text, at)) {
        best = at;
        break;
      }
    return {
      at: best,
      end: best + term.length - 1,
      score: 100 + (wordStart(text, best) ? 10 : 0),
    };
  }
  if (term.length < 2) return undefined;
  // Letters in order may sit a few characters apart, never scattered across the text.
  const limit = Math.max(term.length * 3, term.length + 6);
  let best: Hit | undefined;
  // A bounded number of starts keeps a keystroke cheap on long texts: a few more after the first hit, to find a
  // tighter one, and none once one is nearly exact.
  let left = 32;
  for (let start = text.indexOf(term.charAt(0)); start >= 0 && left > 0; left--) {
    const hit = spread(text, term, start, limit);
    if (hit !== undefined && (best === undefined || hit.score > best.score)) best = hit;
    if (best !== undefined) {
      if (best.end - best.at <= term.length) break;
      left = Math.min(left, 4);
    }
    start = text.indexOf(term.charAt(0), start + 1);
  }
  return best;
}

export type Searchable = { text: string; lower?: string };

/** A ranked match: the item, its score, and where its first term matched (for a snippet). */
export type Found<T> = { item: T; score: number; at: number; end: number };

/** The query's terms, each with whether it matches case exactly. */
function terms(query: string): { term: string; exact: boolean }[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => ({ term, exact: term !== term.toLowerCase() }));
}

/** Score one text; undefined when a term doesn't match. */
export function score(
  text: string,
  query: string,
  lower = text.toLowerCase(),
): Found<string> | undefined {
  const wanted = terms(query);
  if (wanted.length === 0) return undefined;
  let total = 0;
  let first: Hit | undefined;
  for (const { term, exact } of wanted) {
    const hit = exact ? matchTerm(text, term) : matchTerm(lower, term);
    if (hit === undefined) return undefined;
    total += hit.score;
    first ??= hit;
  }
  return { item: text, score: total, at: first?.at ?? 0, end: first?.end ?? 0 };
}

/**
 * The items matching `query`, best first, ties kept newest first when `items` are oldest first; at most `limit`.
 * `lower` is a cached lowercase copy of each item's text, so a keystroke never lowercases the feed again.
 */
export function search<T extends Searchable>(
  items: readonly T[],
  query: string,
  limit = 50,
): Found<T>[] {
  const found: Found<T>[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item === undefined) continue;
    const hit = score(item.text, query, item.lower);
    if (hit !== undefined) found.push({ item, score: hit.score, at: hit.at, end: hit.end });
  }
  // A stable sort keeps newer first among equal scores.
  return found.toSorted((x, y) => y.score - x.score).slice(0, limit);
}

/** About `width` characters of `text` around a match, on one line, with … where it was cut. */
export function snippet(text: string, at: number, end: number, width = 80): string {
  const flat = text.replace(/\s+/g, " ");
  // Whitespace runs collapse, so map the match into the flattened text by counting what came before it.
  const before = text.slice(0, at).replace(/\s+/g, " ").length;
  const length = Math.max(1, end - at + 1);
  const from = Math.max(
    0,
    Math.min(before - Math.floor((width - length) / 3), flat.length - width),
  );
  const cut = flat.slice(from, from + width).trim();
  return `${from > 0 ? "…" : ""}${cut}${from + width < flat.length ? "…" : ""}`;
}
