import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { shortId } from "../../api/ids.ts";

/** One root: an ownerless front conversation with its own crew. Never deleted; archiving only hides it. */
export type RootRecord = {
  id: ConversationId;
  /** From the first message (`named` false), or the user's own. Empty until the first message. */
  label: string;
  named: boolean;
  createdAt: number;
  lastInputAt?: number;
  /** When the root was last shown in a client, for the indicator's `done`. */
  seenAt?: number;
  archived?: true;
  /** The request that created it, so a retried create returns the same root. */
  requestId?: string;
};

/** Every root of the home, in creation order. The first is Durable's reserved root. */
export const RootsDoc = defineDoc<{ roots: RootRecord[] }>({
  kind: "monchu.roots",
  version: 1,
  scope: "session",
  initial: () => ({ roots: [] }),
});

export function rootRecord(
  state: { readonly roots: readonly RootRecord[] },
  id: ConversationId,
): RootRecord | undefined {
  return state.roots.find((root) => root.id === id);
}

/**
 * The root a unique prefix of its short id names, among `roots`. Unknown and ambiguous prefixes throw, naming the
 * candidates, so nobody lands in the wrong root.
 */
export function findRoot<T extends { id: ConversationId; label: string }>(
  roots: readonly T[],
  prefix: string,
): T {
  const text = prefix.trim().toLowerCase();
  if (!/^[k-z]+$/.test(text)) throw new Error(`Not a root id: ${prefix}. Root ids use letters k-z`);
  const matches = roots.filter((root) => shortId(root.id).startsWith(text));
  const [match] = matches;
  if (matches.length === 1 && match !== undefined) return match;
  const list = (items: readonly T[]) =>
    items.map((root) => `${shortId(root.id)} (${root.label || "new"})`).join(", ");
  if (matches.length === 0) throw new Error(`No root ${text}; roots: ${list(roots) || "none"}`);
  throw new Error(`Root ${text} is ambiguous: ${list(matches)}`);
}
