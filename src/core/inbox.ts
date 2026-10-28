/**
 * The inbox: every message a root's front sends the user with text in it is an item, named by the short id the clients
 * already show beside it, with its headline (the first line) and, once the routing helper or the front labels it, a
 * kind and the goal it belongs to. Clients filter the stream by them and push the kinds a person asks for; `/reply`
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
import { rootRecord, RootsDoc } from "./agents/root-records.ts";

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
  /** Who set the label, with the classifier's probability for its kind; the front's and a plugin's are final. */
  by?: "classifier" | "front" | "plugin";
  probability?: number;
  labeledAt?: number;
  /** An ask's state: open until the user answers or the front closes it. */
  state?: "open" | "answered" | "closed";
  /** The start of the user's answer. */
  answer?: string;
  /** Pushed to devices once, when it was first labeled one of their kinds. */
  pushed?: boolean;
  /** A plugin's ask: its key, to close it by, and the worker it is for. */
  key?: string;
  from?: string;
};

/**
 * An ask a plugin opened, until the notice it sent the front (by `request`, the submission's request ID) is in the
 * front's transcript; it is pushed at once all the same, since the front may be busy for a while.
 */
export type PendingAsk = {
  key: string;
  request: string;
  at: number;
  headline: string;
  from?: string;
  goal: string | null;
  state: "open" | "answered" | "closed";
  pushed?: boolean;
};

/** What a plugin opens an ask with; see `PluginAgents.ask`. */
export type AskInput = {
  readonly key: string;
  readonly requestId: string;
  readonly headline: string;
  readonly from?: string;
  readonly goal?: string | null;
};

/** Items kept per front, newest last. */
const KEPT = 500;

export const InboxItemsDoc = defineDoc<{
  cursor?: EntryId;
  items: InboxItem[];
  pending?: PendingAsk[];
}>({
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

/**
 * A line without markdown markers: code spans keep their text as written; elsewhere `*` goes, and `_` only where it
 * marks emphasis, so `start_worker` keeps its underscore.
 */
const unmarked = (line: string): string =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part.replace(/^`+|`+$/g, "")
        : part.replace(/[*`]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ""),
    )
    .join("");

/** A message's headline: its first line with text, without markdown markers, cut at a word. */
export function headlineOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((each) => unmarked(each.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")).trim())
      .find((each) => each !== "") ?? "";
  if (line.length <= 140) return line;
  const cut = line.slice(0, 140);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 100))}…`;
}

const MARKS: Record<string, InboxKind> = {
  ask: "ask",
  done: "milestone",
  update: "update",
  reply: "reply",
};

/**
 * The label a front writes at the start of its headline, `done · monchu: the inbox shipped` or `ask: ship now?`: the
 * kind (`ask`, `done`, `update`, `reply`), an optional goal, and the headline after it. `undefined` without one. A
 * model names the goal loosely (`ask · web push: `), so any short topic is taken, as a goal id with dashes for spaces.
 */
export function markOf(
  headline: string,
): { kind: InboxKind; goal: string | undefined; headline: string } | undefined {
  const match = /^(ask|done|update|reply)(?:\s*·\s*([^\s:·][^:·]{0,47}?))?\s*:\s+(\S.*)$/i.exec(
    headline,
  );
  const kind = MARKS[match?.[1]?.toLowerCase() ?? ""];
  if (match === null || kind === undefined) return undefined;
  return { kind, goal: match[2]?.toLowerCase().replace(/\s+/g, "-"), headline: match[3] ?? "" };
}

/**
 * Adds the front's replies committed since the last call as items, inside a commit, and returns them. Called after
 * each commit that adds a reply to a root; a reply missed by a crash joins at the next one.
 */
export async function noteReplies(tx: Tx, front: ConversationId): Promise<InboxItem[]> {
  const doc = await tx.doc(InboxItemsDoc, front);
  const fresh: InboxItem[] = [];
  const goals = new Set((await tx.doc(GoalsDoc, front)).goals.map((goal) => goal.id));
  const add = (entry: EntryRecord) => {
    const text = replyText(entry);
    const message = entry.model?.[0];
    if (text === "" || message?.role !== "assistant") return;
    const at = message.timestamp + (message.durationMs ?? 0);
    const headline = headlineOf(text);
    // The front's own label is final, so the routing helper is never asked about it.
    const mark = markOf(headline);
    fresh.push(
      mark === undefined
        ? { entry: entry.id, at, headline }
        : {
            entry: entry.id,
            at,
            headline: mark.headline,
            kind: mark.kind,
            goal: mark.goal !== undefined && goals.has(mark.goal) ? mark.goal : null,
            by: "front",
            labeledAt: Date.now(),
            ...(mark.kind === "ask" ? { state: "open" as const } : {}),
          },
    );
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
  // Plugins' asks join beside the notice they sent, once it is in the transcript.
  const waiting = doc.pending ?? [];
  for (const ask of waiting.slice()) {
    const submission = await tx.submissionByRequest(front, ask.request);
    if (submission?.type !== "input" || submission.entry === undefined) continue;
    waiting.splice(waiting.indexOf(ask), 1);
    doc.items.push({
      entry: submission.entry,
      at: ask.at,
      headline: ask.headline,
      kind: "ask",
      goal: ask.goal,
      by: "plugin",
      labeledAt: ask.at,
      state: ask.state,
      key: ask.key,
      ...(ask.from === undefined ? {} : { from: ask.from }),
      ...(ask.pushed === true ? { pushed: true } : {}),
    });
  }
  if (doc.pending !== undefined && waiting.length === 0) delete doc.pending;
  doc.items.push(...fresh);
  doc.items.splice(0, Math.max(0, doc.items.length - KEPT));
  return fresh;
}

/**
 * Opens a plugin's ask, inside a commit: the user's to answer or act on, tied to `from`'s goal unless `goal` is given.
 * Opening a key again changes nothing, so a replayed call is safe. False for a conversation that isn't a root's front,
 * such as a sub-worker's parent: only fronts have an inbox.
 */
export async function openAsk(tx: Tx, front: ConversationId, ask: AskInput): Promise<boolean> {
  if (rootRecord(await tx.doc(RootsDoc), front) === undefined) return false;
  const doc = await tx.doc(InboxItemsDoc, front);
  if ([...doc.items, ...(doc.pending ?? [])].some((each) => each.key === ask.key)) return true;
  const goals = (await tx.doc(GoalsDoc, front)).goals;
  const goal =
    ask.goal !== undefined
      ? ask.goal
      : ask.from === undefined
        ? null
        : (goals.find(
            (each) =>
              (each.status === "active" || each.status === "waiting") &&
              each.workers.includes(ask.from ?? ""),
          )?.id ?? null);
  // Assigned first, then pushed through the document: a push into the plain array would be lost.
  doc.pending ??= [];
  doc.pending.push({
    key: ask.key,
    request: ask.requestId,
    at: Date.now(),
    headline: ask.headline.replace(/\s+/g, " ").trim().slice(0, 200),
    goal,
    state: "open",
    ...(ask.from === undefined ? {} : { from: ask.from }),
  });
  doc.pending.splice(0, Math.max(0, doc.pending.length - 50));
  return true;
}

/** Closes a plugin's ask by its key, inside a commit; false when the inbox has no such ask. */
export async function closeAsk(
  tx: Tx,
  front: ConversationId,
  key: string,
  state: "answered" | "closed",
): Promise<boolean> {
  if (rootRecord(await tx.doc(RootsDoc), front) === undefined) return false;
  const doc = await tx.doc(InboxItemsDoc, front);
  const ask = [...doc.items, ...(doc.pending ?? [])].find((each) => each.key === key);
  if (ask === undefined) return false;
  ask.state = state;
  return true;
}

/** What labels an item: a kind, a goal id or `null` for none, and who says so. */
export type InboxLabel = {
  kind?: InboxKind;
  goal?: string | null;
  by: "classifier" | "front";
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
  if (
    item === undefined ||
    (label.by === "classifier" && item.by !== undefined && item.by !== "classifier")
  )
    return false;
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
