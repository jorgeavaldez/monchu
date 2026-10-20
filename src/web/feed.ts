/**
 * The feed, as the transcript offers it to the page's actions: its messages for search, scrolling as the reader would,
 * and a message to jump to. The transcript owns all three; this only passes them on, so the actions never import a
 * component.
 */
import { signal } from "@preact/signals";

/** One message as search sees it: its short id, who wrote it, when, and its text with a lowercase copy. */
export type FeedRow = { code: string; who: string; at: number; text: string; lower: string };

/** How far a scroll goes: a line, half a page, or to either end. */
export type ScrollKind = "line" | "half" | "top" | "end";

/**
 * A message a search picked: the shown transcript scrolls to it and marks it, and what the search typed in it. A new
 * object each time, so the same one twice jumps twice.
 */
export const jumpTo = signal<{ code: string; query?: string } | undefined>(undefined);

let rows: (() => FeedRow[]) | undefined;
let scroller: ((kind: ScrollKind, step: 1 | -1) => void) | undefined;

/** For the transcript: how to read the feed's messages, whether or not one is on screen. */
export function offerRows(read: () => FeedRow[]): void {
  rows = read;
}

/** For the transcript on screen: how to scroll it; what it returns withdraws it. */
export function offerScroll(scroll: (kind: ScrollKind, step: 1 | -1) => void): () => void {
  scroller = scroll;
  return () => {
    if (scroller === scroll) scroller = undefined;
  };
}

/** The messages of the feed shown, oldest first. */
export function feedRows(): FeedRow[] {
  return rows?.() ?? [];
}

/**
 * Scroll the shown feed by a line, half a page, or to either end, as the reader would: moving up stops following the
 * newest line, and the end follows it again.
 */
export function scrollFeed(kind: ScrollKind, step: 1 | -1): void {
  scroller?.(kind, step);
}
