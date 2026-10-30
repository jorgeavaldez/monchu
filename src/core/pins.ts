/**
 * Pinned messages: messages the user keeps to come back to, in the store-wide `monchu.pins` document. Each is a copy of
 * the message as it was sent, so `/new`, compaction and restarts never touch it, and every client of this device sees
 * the same list. Nothing here reaches a model.
 */
import {
  defineDoc,
  type ConversationId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { parseShortId, shortId } from "../api/ids.ts";
import { addressable, messageOf, sentAt } from "../api/messages.ts";
import { headlineOf, labelOf } from "./inbox.ts";

export type PinnedMessage = {
  /** The message's short id: unique store-wide, the key. */
  code: string;
  /** The short id of the root it came from, and that root's label when it was pinned. */
  root: string;
  rootLabel: string;
  /** Who sent it, as `messageOf` names them. */
  from: string;
  /** The worker whose conversation holds it; none for the root's front. */
  worker?: string;
  headline: string;
  text: string;
  sentAt: number;
  pinnedAt: number;
};
export type PinsState = { items: PinnedMessage[] };

export const PinsDoc = defineDoc<PinsState>({
  kind: "monchu.pins",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/** How many of a conversation's newest entries a prefix is matched against; a whole short id reaches any. */
const WINDOW = 500;

/**
 * The message of `conversation` a unique prefix of its short id names, among its newest entries. A whole short id of
 * one of its messages names that message however old, ahead of longer ids it begins (`nyrv` before `nyrvt`). Unknown
 * and ambiguous prefixes throw naming the candidates.
 */
async function findMessage(
  tx: Tx,
  conversation: ConversationId,
  prefix: string,
): Promise<EntryRecord> {
  const code = prefix.trim().replace(/^#/, "").toLowerCase();
  if (!/^[k-z]+$/.test(code)) throw new Error(`${prefix} is not a message id`);
  const whole = parseShortId(code);
  const matches: EntryRecord[] = [];
  let cursor: Parameters<Tx["scanEntries"]>[2];
  // Newest first: prefixes match in the window; a whole id is looked for further back, down to its own place.
  for (let seen = 0; ;) {
    const page = await tx.scanEntries(
      { conversationId: conversation, order: "descending" },
      100,
      cursor,
    );
    for (const entry of page.items) {
      if (!addressable(entry)) continue;
      if (entry.id === whole) return entry;
      if (seen < WINDOW && shortId(entry.id).startsWith(code)) matches.push(entry);
    }
    seen += page.items.length;
    const last = page.items.at(-1);
    if (page.next === undefined || last === undefined) break;
    if (seen >= WINDOW && (whole === undefined || last.id < whole)) break;
    cursor = page.next;
  }
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return only;
  if (only === undefined) throw new Error(`No message ${code} here`);
  throw new Error(
    `${code} names several messages: ${matches
      .slice(0, 6)
      .map((entry) => `${shortId(entry.id)} (${headlineOf(messageOf(entry)?.text ?? "")})`)
      .join(", ")}`,
  );
}

/**
 * Pins a message of `conversation`, in a commit: a copy of its text with who sent it and where. One already pinned stays
 * as it is, so a retry or a second tap changes nothing; either way the pinned copy comes back, and whether it was.
 */
export async function pinMessage(
  tx: Tx,
  where: { conversation: ConversationId; root: ConversationId; rootLabel: string; worker?: string },
  prefix: string,
): Promise<{ pin: PinnedMessage; existed: boolean }> {
  const entry = await findMessage(tx, where.conversation, prefix);
  const state = await tx.doc(PinsDoc);
  const code = shortId(entry.id);
  const known = state.items.find((item) => item.code === code);
  if (known !== undefined) return { pin: { ...known }, existed: true };
  const message = messageOf(entry, where.worker);
  if (message === undefined) throw new Error(`${code} is not a message`);
  const pin: PinnedMessage = {
    code,
    root: shortId(where.root),
    rootLabel: where.rootLabel,
    from: message.from,
    ...(where.worker === undefined ? {} : { worker: where.worker }),
    headline: labelOf(message.text).headline,
    text: message.text,
    sentAt: sentAt(entry) ?? Date.now(),
    pinnedAt: Date.now(),
  };
  state.items.push(pin);
  return { pin: { ...pin }, existed: false };
}

/** Unpins a message by its short id, in a commit; one already gone changes nothing. */
export async function unpinMessage(tx: Tx, code: string): Promise<void> {
  const state = await tx.doc(PinsDoc);
  state.items = state.items.filter((item) => item.code !== code);
}
