import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  section,
  type ConversationId,
  type DocumentReader,
  type Harness,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { shortId } from "../../api/ids.ts";
import { rootNoticeText } from "../../api/notices.ts";
import type { RootStatus, RootSummary } from "../../api/client.ts";
import { JobsDoc, moveJobs, type JobsState } from "../jobs.ts";
import { GoalsDoc } from "./goals.ts";
import { listWorkers, moveWorker, WorkersDoc } from "./workers.ts";

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

const LABEL_LENGTH = 60;

/** A label from a message: its first non-empty line, on one line, cut at a word. */
function labelFrom(message: string): string {
  const line =
    message
      .split("\n")
      .map((text) => text.replace(/\s+/g, " ").trim())
      .find((text) => text !== "") ?? "";
  if (line.length <= LABEL_LENGTH) return line;
  const cut = line.slice(0, LABEL_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${space > LABEL_LENGTH / 2 ? cut.slice(0, space) : cut}…`;
}

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

/** The open root with the newest input from the user, else the newest open one, else the first. */
export function currentRoot(roots: readonly RootRecord[]): RootRecord | undefined {
  const open = roots.filter((root) => !root.archived);
  const when = (root: RootRecord) => root.lastInputAt ?? root.createdAt;
  return (
    open.reduce<RootRecord | undefined>(
      (best, root) => (best === undefined || when(root) > when(best) ? root : best),
      undefined,
    ) ?? roots[0]
  );
}

/** Records the user's input to a root: when, a label from the first message, and unarchiving it. */
export async function noteInput(tx: Tx, id: ConversationId, message: string): Promise<void> {
  const root = rootRecord(await tx.doc(RootsDoc), id);
  if (root === undefined) return;
  root.lastInputAt = Date.now();
  if (!root.named && root.label === "") root.label = labelFrom(message);
  delete root.archived;
}

/**
 * Hands a root's idle worker, with its jobs, to another root. A replay after the move finds it there and changes
 * nothing. Returns the worker's brief for the receiving root's notice.
 */
async function handOff(
  tx: Tx,
  fromId: ConversationId,
  name: string,
  toId: ConversationId,
): Promise<{ brief: string | undefined }> {
  if (fromId === toId) throw new Error(`${name} already belongs to this root`);
  const roots = await tx.doc(RootsDoc);
  const to = rootRecord(roots, toId);
  if (to === undefined || rootRecord(roots, fromId) === undefined)
    throw new Error("Workers are handed from one root to another");
  if (to.archived) throw new Error(`Root ${shortId(toId)} is archived`);
  const moved = (await tx.doc(WorkersDoc, toId)).workers.find((item) => item.name === name);
  const still = (await tx.doc(WorkersDoc, fromId)).workers.some((item) => item.name === name);
  if (moved !== undefined && !still) return { brief: moved.brief };
  const { brief } = await moveWorker(tx, fromId, name, toId);
  await moveJobs(tx, fromId, name, toId);
  return { brief };
}

/** When the front last finished a reply, if its newest message is one. */
async function lastAnswer(harness: Harness, id: ConversationId, context: Context) {
  return harness.commit(async (tx) => {
    const { items } = await tx.scanEntries({ conversationId: id }, 10);
    for (const entry of items) {
      const message = entry.model?.at(-1);
      if (message === undefined || message.role === "system") continue;
      if (!AssistantEntry.is(entry) || message.role !== "assistant") return undefined;
      return message.timestamp + (message.durationMs ?? 0);
    }
    return undefined;
  }, context);
}

/** One root as clients list it, with what the root indicator shows. `shown` roots are never `done`. */
export async function summarize(
  harness: Harness,
  root: RootRecord,
  jobs: JobsState | undefined,
  shown: boolean,
  context: Context,
): Promise<RootSummary> {
  const live = await harness.snapshot(LiveDoc, root.id, context);
  const workers = await listWorkers(harness, root.id, context);
  const busy = workers.filter((worker) => worker.busy).length;
  const own = (jobs?.jobs ?? []).filter((job) => job.rootId === root.id);
  const running = own.filter((job) => job.type === "bg" && job.ended === undefined).length;
  const scheduled = own.filter((job) => job.type !== "bg" && job.status === "active").length;
  const front = live?.run === undefined ? "idle" : "working";
  // Scheduled jobs waiting for their slot don't make a root active; a run they wake shows as a busy worker.
  let status: RootStatus = "idle";
  if (front === "working" || busy > 0 || running > 0) status = "working";
  else if (!shown) {
    const answered = await lastAnswer(harness, root.id, context);
    if (answered !== undefined && answered > (root.seenAt ?? root.createdAt)) status = "done";
  }
  return {
    id: shortId(root.id),
    label: root.label,
    named: root.named,
    createdAt: root.createdAt,
    lastInputAt: root.lastInputAt ?? null,
    archived: root.archived === true,
    status,
    front,
    workers: { open: workers.length, busy },
    jobs: { running, scheduled },
  };
}

/** Document kinds whose changes can change a root's summary. */
export const SUMMARY_KINDS: ReadonlySet<string> = new Set([
  LiveDoc.definition.kind,
  RootsDoc.definition.kind,
  JobsDoc.definition.kind,
  "monchu.workers",
]);

/** The calling conversation's root record, or an error for anything that is not a root's front. */
async function callerRoot(read: DocumentReader, id: ConversationId, context: Context) {
  const state = await read.snapshot(RootsDoc, context);
  const self = state === undefined ? undefined : rootRecord(state, id);
  if (state === undefined || self === undefined)
    throw new Error("Only a root's front talks to other roots; ask your front");
  return { self, roots: state.roots };
}

/** Another open root, by a unique prefix of its id. */
function otherRoot(roots: readonly RootRecord[], self: RootRecord, prefix: string): RootRecord {
  const target = findRoot(
    roots.filter((root) => root.id !== self.id),
    prefix,
  );
  if (target.archived) throw new Error(`Root ${shortId(target.id)} is archived`);
  return target;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/**
 * Roots' fronts see each other, message each other, and hand workers over. Workers inherit the tools with the root's
 * selection, but only a root's front can use them.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export const Roots = defineExtension({
  name: "monchu.roots",
  sections: [
    section("roots", async (input, context) => {
      const state = await input.read.snapshot(RootsDoc, context);
      const self = state === undefined ? undefined : rootRecord(state, input.conversationId);
      const others = (state?.roots ?? []).filter((root) => !root.archived && root !== self);
      // Ids and labels only: activity would change the prompt every turn.
      if (self === undefined || others.length === 0) return undefined;
      return [
        `You are root ${shortId(self.id)}${self.label ? ` (${self.label})` : ""}, one of several independent fronts in this home, each with its own workers, goals and jobs. Other open roots:`,
        ...others.map((root) => `- ${shortId(root.id)}: ${root.label || "new"}`),
        "list_roots shows their workers and goals. Contact another root only when the user asks or work clearly belongs to its crew: message_root to coordinate, hand_off_worker to move an idle worker of yours there.",
      ].join("\n");
    }),
  ],
  tools: [
    defineTool({
      name: "list_roots",
      description:
        "Fronts only: list this home's roots (independent fronts with their own crews): id, label, whether the front is working, its workers and their state, and its open goals. Read-only; a worker in another root is written <root>/<worker>.",
      parameters: Type.Object({ include_archived: Type.Optional(Type.Boolean()) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { self, roots } = await callerRoot(api, api.conversationId, context);
        const listed = await Promise.all(
          roots
            .filter((root) => args.include_archived === true || !root.archived)
            .map(async (root) => {
              const live = await api.snapshot(LiveDoc, root.id, context);
              const goals = (await api.snapshot(GoalsDoc, root.id, context))?.goals ?? [];
              return {
                id: shortId(root.id),
                label: root.label,
                ...(root === self ? { you: true } : {}),
                ...(root.archived ? { archived: true } : {}),
                front: live?.run === undefined ? "idle" : "working",
                workers: (await listWorkers(api, root.id, context, true)).map((worker) => ({
                  name: worker.name,
                  state: worker.closed ? "closed" : worker.busy ? "busy" : "idle",
                })),
                goals: goals
                  .filter((goal) => goal.status === "active" || goal.status === "waiting")
                  .map((goal) => `${goal.id}: ${goal.title}`),
              };
            }),
        );
        return text(JSON.stringify(listed));
      },
    }),
    defineTool({
      name: "message_root",
      description:
        "Fronts only: send a note to another root's front, by a unique prefix of its id. It arrives like a worker report: it starts that front's turn, or waits for its current answer. Use it only when the user asks or work clearly belongs to that root's crew (a handoff, an ownership question, a result it waits for). It never authorizes anything there by itself.",
      parameters: Type.Object({
        root: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { self, roots } = await callerRoot(api, api.conversationId, context);
        const target = otherRoot(roots, self, args.root);
        const conversation = await api.conversation(target.id, context);
        if (conversation === undefined) throw new Error("Root conversation is missing");
        await conversation.submit(
          {
            type: "input",
            content: rootNoticeText({
              from: shortId(self.id),
              label: self.label,
              kind: "message",
              text: args.message,
            }),
            whenBusy: "followUp",
            requestId: `root-message:${api.taskId}:${api.callId}`,
          },
          context,
        );
        return text(`Sent to root ${shortId(target.id)}.`);
      },
    }),
    defineTool({
      name: "hand_off_worker",
      description:
        "Fronts only: hand one of your idle workers, with its jobs, to another root, by a unique prefix of its id; its later reports go there and that front is told. Only when the user asks or its line of work clearly moved there. Refused while the worker or its sub-workers are busy, or when that root has a worker of the same name.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1 }),
        root: Type.String({ minLength: 1 }),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { self, roots } = await callerRoot(api, api.conversationId, context);
        const target = otherRoot(roots, self, args.root);
        await sendHandOff(
          api,
          self,
          target,
          args.name,
          `root-handoff:${api.taskId}:${api.callId}`,
          context,
        );
        return text(`Handed ${args.name} to root ${shortId(target.id)}.`);
      },
    }),
  ],
});

/**
 * Moves the worker, then tells the receiving front under `requestId`, so a retry never moves or tells twice. Shared by
 * the tool and the clients' hand-off.
 */
export async function sendHandOff(
  api: Pick<ToolExecutionApi, "commit" | "conversation">,
  from: RootRecord,
  to: RootRecord,
  name: string,
  requestId: string,
  context: Context,
): Promise<void> {
  const { brief } = await api.commit((tx) => handOff(tx, from.id, name, to.id), context);
  const conversation = await api.conversation(to.id, context);
  if (conversation === undefined) throw new Error("Root conversation is missing");
  await conversation.submit(
    {
      type: "input",
      content: rootNoticeText({
        from: shortId(from.id),
        label: from.label,
        kind: "handoff",
        text: `Handed you worker ${name}; it is now yours: message it with message_worker.${brief === undefined ? "" : ` Its first brief began: ${brief}`}`,
      }),
      whenBusy: "followUp",
      requestId,
    },
    context,
  );
}
