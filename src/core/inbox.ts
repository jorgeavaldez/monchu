/**
 * The inbox: every message a root's front sends the user with text in it is an item, named by the short id the clients
 * already show beside it, with its headline (the first line) and, once the routing helper or the front labels it, a
 * kind and the goal it belongs to. Clients filter the stream by them and push the kinds a person asks for; `/answer`
 * replies to one by id. Items are kept in the front's own `monchu.inbox` document, so compaction and `/new` keep them.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { shortId } from "../api/ids.ts";
import { GoalsDoc } from "./agents/goals.ts";
import { rootRecord, RootsDoc } from "./agents/roots.ts";

const INBOX_KINDS = ["ask", "milestone", "update", "reply"] as const;
/**
 * `ask`: waits on the user's input or decision. `milestone`: something delivered, finished or closed. `update`:
 * progress or status, nothing asked or finished. `reply`: an answer to the user, or conversation.
 */
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxItem = {
  entry: EntryId;
  /** When the message was sent. */
  at: number;
  headline: string;
  kind?: InboxKind;
  /** The goal's id, `null` when it belongs to none; absent until labeled. */
  goal?: string | null;
  /** Who set the label, with the classifier's probability for its kind; the front's label is final. */
  by?: "clef" | "front";
  probability?: number;
  labeledAt?: number;
  /** An ask's state: open until the user answers or the front closes it. */
  state?: "open" | "answered" | "closed";
  /** The start of the user's answer. */
  answer?: string;
  /** Pushed to devices once, when it was first labeled one of their kinds. */
  pushed?: boolean;
};

/** Items kept per front, newest last. */
const KEPT = 500;

export const InboxItemsDoc = defineDoc<{ cursor?: EntryId; items: InboxItem[] }>({
  kind: "monchu.inbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
});

/** A reply's text, its parts joined; empty for one with none, such as a bare tool call. */
export function replyText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/** A message's headline: its first line with text, without markdown markers, cut at a word. */
export function headlineOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((each) =>
        each
          .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")
          .replace(/[*_`]+/g, "")
          .trim(),
      )
      .find((each) => each !== "") ?? "";
  if (line.length <= 140) return line;
  const cut = line.slice(0, 140);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 100))}…`;
}

/**
 * Adds the front's replies committed since the last call as items, inside a commit, and returns them. Called after
 * each commit that adds a reply to a root; a reply missed by a crash joins at the next one.
 */
export async function noteReplies(tx: Tx, front: ConversationId): Promise<InboxItem[]> {
  const doc = await tx.doc(InboxItemsDoc, front);
  const fresh: InboxItem[] = [];
  const add = (entry: EntryRecord) => {
    const text = replyText(entry);
    const message = entry.model?.[0];
    if (text === "" || message?.role !== "assistant") return;
    fresh.push({
      entry: entry.id,
      at: message.timestamp + (message.durationMs ?? 0),
      headline: headlineOf(text),
    });
  };
  if (doc.cursor === undefined) {
    // A front's inbox starts at its newest entry: older replies stay out of it.
    const newest = (await tx.scanEntries({ conversationId: front, order: "descending" }, 1))
      .items[0];
    if (newest !== undefined) {
      add(newest);
      doc.cursor = newest.id;
    }
  } else {
    const from = doc.cursor;
    for (let cursor: Cursor | undefined, more = true; more;) {
      const page = await tx.scanEntries(
        { conversationId: front, minEntryId: from, order: "ascending" },
        50,
        cursor,
      );
      for (const entry of page.items) if (entry.id !== from) add(entry);
      cursor = page.next;
      more = cursor !== undefined && page.items.length > 0;
      const last = page.items.at(-1);
      if (last !== undefined) doc.cursor = last.id;
    }
  }
  doc.items.push(...fresh);
  doc.items.splice(0, Math.max(0, doc.items.length - KEPT));
  return fresh;
}

/** What labels an item: a kind, a goal id or `null` for none, and who says so. */
export type InboxLabel = {
  kind?: InboxKind;
  goal?: string | null;
  by: "clef" | "front";
  probability?: number;
};

/** Labels an item inside a commit; the classifier never overrides the front. False when there is no such item. */
export async function labelItem(
  tx: Tx,
  front: ConversationId,
  entry: EntryId,
  label: InboxLabel,
): Promise<boolean> {
  const item = (await tx.doc(InboxItemsDoc, front)).items.find((each) => each.entry === entry);
  if (item === undefined || (label.by === "clef" && item.by === "front")) return false;
  if (label.kind !== undefined) {
    if (label.kind === "ask" && item.kind !== "ask") item.state = "open";
    if (label.kind !== "ask") delete item.state;
    item.kind = label.kind;
  }
  if (label.goal !== undefined) item.goal = label.goal;
  item.by = label.by;
  if (label.probability === undefined) delete item.probability;
  else item.probability = label.probability;
  item.labeledAt = Date.now();
  return true;
}

/** The item a unique prefix of its id names; unknown and ambiguous prefixes throw naming the candidates. */
export function findItem(items: readonly InboxItem[], prefix: string): InboxItem {
  const code = prefix.trim().replace(/^#/, "").toLowerCase();
  if (!/^[k-z]+$/.test(code)) throw new Error(`${prefix} is not a message id`);
  const matches = items.filter((item) => shortId(item.entry).startsWith(code));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new Error(`No message ${code} in this root's inbox`);
  throw new Error(
    `${code} names several messages: ${matches
      .slice(-6)
      .map((item) => `${shortId(item.entry)} (${item.headline})`)
      .join(", ")}`,
  );
}

const describe = (item: InboxItem) =>
  [
    shortId(item.entry),
    item.kind === undefined ? "unlabeled" : item.kind === "ask" ? `ask (${item.state})` : item.kind,
    item.goal ?? "no goal",
    item.headline,
  ].join(" · ");

/**
 * The front sees its open asks and latest milestones by id, so it can cite them and close asks the user no longer owes.
 * Only those: the section changes when they do, not with every reply, and each change joins the transcript once.
 */
function inboxSection(items: readonly InboxItem[]): string {
  const open = items.filter((item) => item.state === "open").slice(-10);
  const done = items.filter((item) => item.kind === "milestone").slice(-5);
  return [
    "The user reads your messages as an inbox: each is labeled an ask, milestone, update or reply, by the routing helper or by you with the inbox tool, which also closes an ask that no longer waits on the user. Cite a message as #id.",
    open.length === 0 ? "No open asks." : "Open asks:",
    ...open.map((item) => `- ${describe(item)}`),
    ...(done.length === 0
      ? []
      : ["Latest milestones:", ...done.map((item) => `- ${describe(item)}`)]),
  ].join("\n");
}

/** The inbox section and tool; part of the root's selection, so workers inherit them but have no inbox of their own. */
export const Inbox = defineExtension({
  name: "monchu.inbox",
  sections: [
    // Always there for a front, so its first item never re-sends the prompt; never for a worker.
    section("inbox", async (input, context) => {
      const roots = await input.read.snapshot(RootsDoc, context);
      if (roots === undefined || rootRecord(roots, input.conversationId) === undefined)
        return undefined;
      return inboxSection(
        (await input.read.snapshot(InboxItemsDoc, input.conversationId, context))?.items ?? [],
      );
    }),
  ],
  tools: [
    defineTool({
      name: "inbox",
      description:
        "Fronts only: relabel one of your messages in the user's inbox by its id (the inbox section lists them): its kind (ask: waits on the user; milestone: something delivered, finished or closed; update: progress or status; reply: an answer or conversation), its goal id (empty for none), or an ask's state (closed once it no longer waits on the user). Your label is final.",
      parameters: Type.Object(
        {
          id: Type.String({ minLength: 1, description: "The message id, or a unique prefix" }),
          kind: Type.Optional(StringEnum(INBOX_KINDS)),
          goal: Type.Optional(
            Type.String({ maxLength: 48, description: "Goal id; empty for none" }),
          ),
          state: Type.Optional(StringEnum(["open", "closed"] as const)),
        },
        { additionalProperties: false },
      ),
      replay: "safe",
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const result = await api.commit(async (tx) => {
          if (rootRecord(await tx.doc(RootsDoc), api.conversationId) === undefined)
            throw new Error("Only a root's front has an inbox");
          const doc = await tx.doc(InboxItemsDoc, api.conversationId);
          const item = findItem(doc.items, args.id);
          const goal = args.goal === undefined ? undefined : args.goal.trim() || null;
          if (
            goal !== undefined &&
            goal !== null &&
            !(await tx.doc(GoalsDoc, api.conversationId)).goals.some((each) => each.id === goal)
          )
            throw new Error(`No goal ${goal}; list_goals lists them`);
          await labelItem(tx, api.conversationId, item.entry, {
            by: "front",
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(goal === undefined ? {} : { goal }),
          });
          if (args.state !== undefined) {
            if (item.kind !== "ask") throw new Error(`${shortId(item.entry)} is not an ask`);
            item.state = args.state;
          }
          return describe(item);
        }, context);
        return { output: [{ type: "text", text: result }] };
      },
    }),
  ],
});
