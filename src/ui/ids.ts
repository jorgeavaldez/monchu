import type { EntryRecord } from "@earendil-works/pi-durable";
import { shortId } from "../api/ids.ts";
import { escalationSummary } from "../api/notices.ts";

/**
 * The entries a client labels with their short id: the user's input, worker reports and updates, and replies with
 * text. Routing advice, tool results and context markers stay unlabeled.
 */
export function addressable(entry: EntryRecord): boolean {
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return escalationSummary(text) === undefined;
  }
  return (
    entry.kind === "pi.assistant" &&
    message?.role === "assistant" &&
    message.content.some((part) => part.type === "text" && part.text.trim() !== "")
  );
}

/**
 * The short ids one conversation shows, kept sorted for their shortest unique prefixes, as jj highlights change ids:
 * that prefix is all a reader must type to name the entry among the ones in view. A new id can only lengthen its
 * sorted neighbours' prefixes, so clients repaint just those.
 */
export class ShortIds {
  private readonly sorted: string[] = [];

  /** Adds an entry's short id; returns the ids whose prefix changed, the new one included. Adding twice is a no-op. */
  add(id: number): string[] {
    return this.addCode(shortId(id));
  }

  /** `add` for an id already written as its short id, such as a root's. */
  addCode(code: string): string[] {
    const index = this.search(code);
    if (this.sorted[index] === code) return [];
    const neighbours = [this.sorted[index - 1], this.sorted[index]].filter(
      (other) => other !== undefined,
    );
    const before = neighbours.map((other) => this.prefix(other));
    this.sorted.splice(index, 0, code);
    return [code, ...neighbours.filter((other, i) => this.prefix(other) !== before[i])];
  }

  /** How many leading letters of `code` no other id here shares; at least one, at most the whole id. */
  prefix(code: string): number {
    const index = this.search(code);
    const shared = (other: string | undefined) => {
      if (other === undefined || other === code) return 0;
      let length = 0;
      while (length < code.length && code[length] === other[length]) length++;
      return length;
    };
    const next = this.sorted[index] === code ? index + 1 : index;
    return Math.min(
      code.length,
      Math.max(shared(this.sorted[index - 1]), shared(this.sorted[next])) + 1,
    );
  }

  /** The short id split into its unique prefix and the rest, for a client to style apart. */
  split(id: number): { code: string; unique: string; rest: string } {
    const code = shortId(id);
    const length = this.prefix(code);
    return { code, unique: code.slice(0, length), rest: code.slice(length) };
  }

  clear(): void {
    this.sorted.length = 0;
  }

  private search(code: string): number {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.sorted[middle] ?? "") < code) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** When an addressable entry was sent: a reply when its request finished, input when it was accepted. */
export function sentAt(entry: EntryRecord): number | undefined {
  const message = entry.model?.[0];
  if (message?.role === "assistant") return message.timestamp + (message.durationMs ?? 0);
  return message?.role === "user" ? message.timestamp : undefined;
}

/** When an entry was sent, in local time: the time alone today, with the date otherwise. */
export function stamp(at: number, now = Date.now()): string {
  const date = new Date(at);
  return new Date(now).toDateString() === date.toDateString()
    ? date.toLocaleTimeString(undefined, { timeStyle: "short" })
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
