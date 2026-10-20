import type { Context, JsonValue } from "@earendil-works/chord";
import {
  cleanupSessionResources,
  getSupportedThinkingLevels,
  type Models,
  StringEnum,
  Type,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  UserEntry,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { noticeText, type WhenBusy } from "../../api/notices.ts";
import { thinkingLevels, type ModelRole, type WorkerProfile } from "../config.ts";
import { preloadGroups, unloadGroups } from "../tools/tool-search.ts";
import { resolveDirectory } from "../workdir.ts";

type WorkerRecords = {
  workers: {
    name: string;
    conversationId: ConversationId;
    reported: EntryId[];
    /** The start of the first brief, which tells the routing helper what the worker is about. */
    brief?: string;
    /** Retired from the active roster; the conversation stays and `reopenWorker` resumes it. Absent means open. */
    closed?: true;
  }[];
  deliveries: { requestId: string; name: string; taskId: TaskId }[];
};

const RECENT_HISTORY = 200;

export const WorkersDoc = defineDoc<WorkerRecords & { started: number }>({
  kind: "monchu.workers",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ workers: [], deliveries: [], started: 0 }),
  // At most 31 replay deltas.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/**
 * The parents of workers handed from one root to another, by worker conversation ID. Durable's owner edge is immutable,
 * so it stays the parent of every worker never handed off.
 */
const HandoffsDoc = defineDoc<{ parents: Record<string, ConversationId> }>({
  kind: "monchu.handoffs",
  version: 1,
  scope: "session",
  initial: () => ({ parents: {} }),
});

/** The conversation a worker reports to: its owner, or the root it was handed to. `undefined` for a root. */
export async function parentOf(tx: Tx, id: ConversationId): Promise<ConversationId | undefined> {
  return (
    (await tx.doc(HandoffsDoc)).parents[String(id)] ??
    (await tx.conversation(id))?.owner?.conversationId
  );
}

/** The root a conversation belongs to, through its parents: itself for a root. */
export async function rootOf(tx: Tx, id: ConversationId): Promise<ConversationId> {
  let root = id;
  for (let parent = await parentOf(tx, root); parent !== undefined;) {
    root = parent;
    parent = await parentOf(tx, root);
  }
  return root;
}

/**
 * Moves an idle worker's record from one parent to another, so its later reports, updates and user messages go there.
 * Refused while it runs, has queued or pending work or busy sub-workers, or when the name is taken there.
 */
export async function moveWorker(
  tx: Tx,
  fromId: ConversationId,
  name: string,
  toId: ConversationId,
): Promise<{ conversationId: ConversationId; brief: string | undefined }> {
  const from = await tx.doc(WorkersDoc, fromId);
  const worker = named(from.workers, name);
  const to = await tx.doc(WorkersDoc, toId);
  if (to.workers.some((item) => item.name === name))
    throw new Error(`The other root already has a worker named ${name}`);
  if (await busyTree(tx, from, worker))
    throw new Error(`${name} is busy; let it finish or stop it before handing it off`);
  from.workers.splice(from.workers.indexOf(worker), 1);
  to.workers.push({ ...worker, reported: [...worker.reported] });
  (await tx.doc(HandoffsDoc)).parents[String(worker.conversationId)] = toId;
  return { conversationId: worker.conversationId, brief: worker.brief };
}

/** Whether a worker or any sub-worker below it runs, has queued input, or has a pending delivery. */
async function busyTree(
  tx: Tx,
  state: WorkerRecords,
  worker: WorkerRecords["workers"][number],
): Promise<boolean> {
  const live = await tx.doc(LiveDoc, worker.conversationId);
  const inbox = await tx.doc(InboxDoc, worker.conversationId);
  if (live.run !== undefined || inbox.items.length > 0) return true;
  // Moving a worker whose report is still posting would orphan that delivery's records in the old parent.
  if (await pendingDelivery(state, worker.name, (id) => tx.task(id), true)) return true;
  const children = await tx.doc(WorkersDoc, worker.conversationId);
  for (const child of children.workers) if (await busyTree(tx, children, child)) return true;
  return false;
}

function named(workers: WorkerRecords["workers"], name: string) {
  const worker = workers.find((item) => item.name === name);
  if (worker === undefined) throw new Error(`No worker named ${name}`);
  return worker;
}

/** The conversation of the parent's worker named `name`. */
export async function workerConversationId(
  reader: Pick<Harness, "snapshot">,
  parentId: ConversationId,
  name: string,
  context: Context,
): Promise<ConversationId> {
  return named((await reader.snapshot(WorkersDoc, parentId, context))?.workers ?? [], name)
    .conversationId;
}

/**
 * Whether the worker has a delivery that has not finished. A delivery that only posts the worker's answer to its parent
 * leaves the worker idle, so it counts only with `reporting`: the parent reads the report before that post finishes.
 */
async function pendingDelivery(
  state: WorkerRecords,
  name: string,
  task: (
    id: TaskId,
  ) => Promise<
    { readonly state: { readonly status: string; readonly checkpoint?: JsonValue } } | undefined
  >,
  reporting = false,
): Promise<boolean> {
  for (const delivery of state.deliveries.filter((item) => item.name === name)) {
    const record = await task(delivery.taskId);
    if (record === undefined || record.state.status === "terminal") continue;
    const { checkpoint } = record.state;
    const answered =
      record.state.status === "completing" ||
      (typeof checkpoint === "object" &&
        checkpoint !== null &&
        !Array.isArray(checkpoint) &&
        checkpoint.phase === "report");
    if (reporting || !answered) return true;
  }
  return false;
}

/** `pendingDelivery` inside a commit, so a change that requires an idle worker cannot race a new delivery. */
export async function hasPendingDelivery(
  tx: Tx,
  parentId: ConversationId,
  name: string,
): Promise<boolean> {
  return pendingDelivery(await tx.doc(WorkersDoc, parentId), name, (id) => tx.task(id));
}

/** Release parked provider resources for a worker and its sub-workers; the next request acquires them again. */
async function releaseProviders(
  reader: Pick<Harness, "snapshot">,
  workerId: ConversationId,
  context: Context,
): Promise<void> {
  const released = [workerId];
  for (const id of released) {
    const provider = await reader.snapshot(ProviderDoc, id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
    const children = await reader.snapshot(WorkersDoc, id, context);
    released.push(...(children?.workers.map((child) => child.conversationId) ?? []));
  }
}

/** Cancel the worker's current work, pending deliveries, and nested background work. */
export async function stopWorker(
  api: Pick<ToolExecutionApi, "snapshot" | "conversation">,
  parentId: ConversationId,
  name: string,
  context: Context,
): Promise<void> {
  const worker = await api.conversation(
    await workerConversationId(api, parentId, name, context),
    context,
  );
  if (worker === undefined) throw new Error("Worker conversation is missing");
  await worker.abort(context, { background: true });
  // Generation signals end at each tool boundary; release parked provider resources for the stopped subtree too.
  await releaseProviders(api, worker.id, context);
}

/**
 * Retire an idle worker from the active roster. Its conversation and history stay; new messages are rejected until
 * `reopenWorker`. Returns false when it was already closed.
 */
export async function closeWorker(
  tx: Tx,
  parentId: ConversationId,
  name: string,
): Promise<boolean> {
  const state = await tx.doc(WorkersDoc, parentId);
  const worker = named(state.workers, name);
  if (worker.closed) return false;
  // Checked in the closing commit, so no delivery or run can start between the check and the close.
  const live = await tx.doc(LiveDoc, worker.conversationId);
  const inbox = await tx.doc(InboxDoc, worker.conversationId);
  if (
    live.run !== undefined ||
    inbox.items.length > 0 ||
    (await pendingDelivery(state, name, (id) => tx.task(id)))
  )
    throw new Error(`${name} is busy; let it finish or stop it before closing`);
  worker.closed = true;
  return true;
}

/** Return a closed worker to the active roster; its conversation continues where it stopped. */
export async function reopenWorker(tx: Tx, parentId: ConversationId, name: string): Promise<void> {
  delete named((await tx.doc(WorkersDoc, parentId)).workers, name).closed;
}

/** The worker's newest failed reply among its latest entries, if its last run ended in one. */
async function latestError(
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ id: EntryId; message: string } | undefined> {
  const { items } = await tx.scanEntries({ conversationId }, 20);
  for (const entry of items) {
    if (!AssistantEntry.is(entry)) continue;
    const message = entry.model?.[0];
    if (message?.role !== "assistant") continue;
    return message.stopReason === "error"
      ? { id: entry.id, message: message.errorMessage ?? "no error message" }
      : undefined;
  }
  return undefined;
}

/** Keep every active delivery and its settled answer, plus a recent completed retry window. */
async function pruneRecords(tx: Tx, parentId: ConversationId, finishing?: TaskId): Promise<void> {
  const state = await tx.doc(WorkersDoc, parentId);
  const active = new Set<TaskId>();
  const answers = new Set<EntryId>();
  for (const delivery of state.deliveries) {
    const task = await tx.task(delivery.taskId);
    if (delivery.taskId === finishing || task?.state.status === "terminal") continue;
    active.add(delivery.taskId);
    const worker = named(state.workers, delivery.name);
    const submission = await tx.submissionByRequest(
      worker.conversationId,
      `worker-message:${delivery.taskId}`,
    );
    if (submission?.type === "input" && submission.status === "done")
      answers.add(submission.answer);
  }
  const recent = new Set(
    state.deliveries
      .filter((item) => !active.has(item.taskId))
      .slice(-RECENT_HISTORY)
      .map((item) => item.taskId),
  );
  // Splice in place: replacing a whole array would store the array in every replay delta.
  for (let index = state.deliveries.length - 1; index >= 0; index--) {
    const taskId = state.deliveries[index]?.taskId;
    if (taskId !== undefined && !active.has(taskId) && !recent.has(taskId))
      state.deliveries.splice(index, 1);
  }
  for (const worker of state.workers) {
    const recentAnswers = new Set(
      worker.reported.filter((id) => !answers.has(id)).slice(-RECENT_HISTORY),
    );
    for (let index = worker.reported.length - 1; index >= 0; index--) {
      const id = worker.reported[index];
      if (id !== undefined && !answers.has(id) && !recentAnswers.has(id))
        worker.reported.splice(index, 1);
    }
  }
}

/**
 * Request IDs of a worker's updates that are registered but not admitted yet, or still wait in its parent's queue. A
 * codemode script interrupted between registration and admission is not replayed, so its ID stays until a stop.
 */
const WorkerUpdatesDoc = defineDoc<{ queued: string[] }>({
  kind: "monchu.worker-updates",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ queued: [] }),
});

/**
 * Withdraw the parent's queued inputs among `requestIds`, except the newest admitted one when `keepNewest`, as
 * `Submission.abort()` does but inside a larger commit. Returns the request IDs not admitted yet or still queued. It
 * ends with table writes, so the caller makes no table reads after it.
 */
async function withdrawQueued(
  tx: Tx,
  parentId: ConversationId,
  requestIds: readonly string[],
  keepNewest: boolean,
): Promise<string[]> {
  const pending: string[] = [];
  const queued: { requestId: string; id: SubmissionId }[] = [];
  for (const requestId of requestIds) {
    const record = await tx.submissionByRequest(parentId, requestId);
    if (record === undefined) pending.push(requestId);
    else if (record.status === "queued") queued.push({ requestId, id: record.id });
  }
  // Submission IDs grow with admission, so every caller agrees on the newest whatever order they run in.
  const newest = keepNewest
    ? queued.reduce<(typeof queued)[number] | undefined>(
        (found, item) => (found === undefined || item.id > found.id ? item : found),
        undefined,
      )
    : undefined;
  const inbox = await tx.doc(InboxDoc, parentId);
  for (const item of queued) {
    if (item === newest) continue;
    tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
    const index = inbox.items.findIndex((queuedItem) => queuedItem.id === item.id);
    if (index >= 0) inbox.items.splice(index, 1);
  }
  return newest === undefined ? pending : [...pending, newest.requestId];
}

type WorkerResult = {
  name: string;
  conversationId: ConversationId;
  requestId: string;
  submissionId: SubmissionId;
  text: string;
} & ({ status: "completed"; answerId: EntryId } | { status: "failed" });

/** Front inputs that are not the user's own words: worker and root notices, routing-helper follow-ups and system notices. */
const NOT_THE_USER = /^\[(Worker |Background worker |Root [k-z]+ |Routing advice|System notice)/;

/** The settlement reason of an input the user deleted from a queue; a deleted report is dropped, not posted again. */
export const DELETED_FROM_QUEUE = "deleted";

/**
 * How a worker's report or update reaches its busy parent. A worker parent is often waiting on it, so it joins that run
 * after the current tool round; a front hears it after its answer.
 */
async function reportWhenBusy(tx: Tx, parentId: ConversationId): Promise<WhenBusy> {
  return (await parentOf(tx, parentId)) === undefined ? "followUp" : "steer";
}

/** A report is posted again after stopping the front withdraws it; each post has its own request ID. */
function reportRequestId(taskId: TaskId, attempt: number): string {
  return attempt === 0 ? `worker-report:${taskId}` : `worker-report:${taskId}:${attempt}`;
}

const Anchor = defineTask<null, { phase: "finish" }, null>({
  name: "monchu.worker-anchor",
  version: 1,
  initial: () => ({ phase: "finish" }),
  phases: {
    finish: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type DeliveryInput = {
  parentId: ConversationId;
  name: string;
  message: string;
  requestId: string;
  whenBusy: WhenBusy;
  /** The parent hears the worker's answer only when it starts with `NEEDS USER` (`needsUser`); failures always. */
  quiet?: true;
};

/** Whether a quiet delivery's answer asks the parent to bring something to the user. */
function needsUser(text: string): boolean {
  return /^\s*NEEDS USER\b/.test(text);
}

const Delivery = defineTask<
  DeliveryInput,
  { phase: "deliver" } | { phase: "report"; result: WorkerResult | null; whenBusy: WhenBusy },
  null
>({
  name: "monchu.worker-delivery",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const worker = await runtime.conversation(runtime.conversationId, context);
      if (worker === undefined) throw new Error("Worker conversation is missing");
      const submission = await worker.submit(
        {
          type: "input",
          content: task.input.message,
          whenBusy: task.input.whenBusy,
          requestId: `worker-message:${task.id}`,
        },
        context,
      );
      const settled = await submission.wait(context);
      await runtime.commit(async (tx) => {
        let result: WorkerResult | null = null;
        const base = {
          name: task.input.name,
          conversationId: runtime.conversationId,
          requestId: task.input.requestId,
          submissionId: submission.id,
        };
        if (settled.status === "unanswered") {
          // Messages queued into one run all go unanswered when it fails: report that failure once, with its error.
          const state = await tx.doc(WorkersDoc, task.input.parentId);
          const record = state.workers.find(
            (item) => item.conversationId === runtime.conversationId,
          );
          if (record === undefined) throw new Error("Worker record is missing");
          const error = await latestError(tx, runtime.conversationId);
          if (error === undefined) result = { ...base, status: "failed", text: settled.reason };
          else if (!record.reported.includes(error.id)) {
            record.reported.push(error.id);
            result = { ...base, status: "failed", text: `${settled.reason}: ${error.message}` };
          }
        } else if (settled.type === "input") {
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const text = (entry?.model ?? [])
            .flatMap((message) => (message.role === "assistant" ? message.content : []))
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          const state = await tx.doc(WorkersDoc, task.input.parentId);
          const record = state.workers.find(
            (item) => item.conversationId === runtime.conversationId,
          );
          if (record === undefined) throw new Error("Worker record is missing");
          // Inputs that joined one run share its answer, so the first delivery that reports it claims it. A quiet one that
          // stays quiet claims nothing: an ask answered in the same run still reports it.
          if (!record.reported.includes(settled.answer)) {
            if (entry === undefined) throw new Error("Worker answer is missing");
            if (task.input.quiet !== true || needsUser(text)) {
              record.reported.push(settled.answer);
              result = { ...base, status: "completed", answerId: settled.answer, text };
            }
          }
        }
        return {
          status: "running",
          checkpoint: {
            phase: "report",
            result,
            whenBusy: await reportWhenBusy(tx, task.input.parentId),
          },
        };
      }, context);
    },
    report: async (task, runtime, context) => {
      const { parentId } = task.input;
      const { result, whenBusy } = task.state.checkpoint;
      if (result !== null) {
        const parent = await runtime.conversation(parentId, context);
        if (parent === undefined) throw new Error("Worker parent conversation is missing");
        // The report starts the parent's turn when idle, or joins it as `reportWhenBusy` says. Stopping the parent withdraws
        // queued input, so a withdrawn report is posted again; recovery replays this request ID chain without duplicates.
        for (let attempt = 0; ; attempt++) {
          const submission = await parent.submit(
            {
              type: "input",
              content: noticeText(result),
              whenBusy,
              requestId: reportRequestId(task.id, attempt),
            },
            context,
          );
          // Finish once the parent's transcript holds the report, not after its answer: the worker is idle meanwhile.
          let record = await submission.status(context);
          while (record.status === "queued") {
            await runtime.sleep(runtime.now() + 250, context);
            const idle = (await runtime.snapshot(LiveDoc, parentId, context))?.run === undefined;
            record = await submission.status(context);
            // An aborted run ends without placing input queued during its abort; withdraw it and post again.
            if (idle && record.status === "queued") await submission.abort(context);
          }
          if (record.entry !== undefined || record.reason === DELETED_FROM_QUEUE) break;
          // Only a withdrawn input settles without an entry.
          if (record.reason !== "aborted")
            throw new Error(`Worker report was not placed: ${record.reason}`);
          // Post again after the aborted run ends, so the report starts a turn instead of queueing behind it.
          await parent.waitForIdle(context);
        }
      }
      await runtime.commit(async (tx) => {
        await pruneRecords(tx, parentId, task.id);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      const { parentId } = task.input;
      await pruneRecords(tx, parentId, task.id);
      // Stopping a worker also withdraws what it posted that the parent has not placed yet.
      const reports: string[] = [];
      for (let attempt = 0; ; attempt++) {
        const requestId = reportRequestId(task.id, attempt);
        if ((await tx.submissionByRequest(parentId, requestId)) === undefined) break;
        reports.push(requestId);
      }
      const updates = await tx.doc(WorkerUpdatesDoc, runtime.conversationId);
      await withdrawQueued(tx, parentId, [...reports, ...updates.queued], false);
      // The stop's abort mark came first: a registered update not admitted yet never will be, as admission commits
      // reject once its tool call is marked.
      updates.queued = [];
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
});

export async function startWorker(
  tx: Tx,
  parentId: ConversationId,
  name: string,
  message: string,
  cwd: string,
  requestId: string,
  role: ModelRole,
  preload: readonly string[] = [],
  quiet = false,
): Promise<ConversationId> {
  const state = await tx.doc(WorkersDoc, parentId);
  const previous = state.deliveries.find((item) => item.requestId === requestId);
  if (previous !== undefined) return named(state.workers, previous.name).conversationId;
  const existing = state.workers.find((item) => item.name === name);
  if (existing?.closed)
    throw new Error(`${name} is closed; reopen it with reopen_worker or choose another name`);
  if (existing !== undefined) throw new Error(`${name} already exists; send it a message instead`);
  await pruneRecords(tx, parentId);
  const anchor = await tx.createTask(Anchor, null, {
    conversationId: parentId,
    ownership: { kind: "conversation" },
    background: true,
  });
  const worker = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
  // The copied agent carries the parent's loaded tool groups; a worker loads what its own domain needs.
  await unloadGroups(tx, worker.id);
  await configure(tx, worker.id, {
    model: { provider: role.provider, modelId: role.modelId },
    thinkingLevel: role.thinkingLevel,
    cwd,
    instructions: `You are Monchu's background worker ${name}, a standing worker that owns a domain for the user. Your brief names the domain and the first ask; later asks in that domain will reach you too, so keep your context across them. Own each outcome end to end: decide the approach, and let the scope follow the outcome the user wants rather than the brief's wording. The front relies on your judgment: when the brief is ambiguous or seems to prescribe, read the user's own words with user_messages, and say so when the ask should go elsewhere or be split. Your final answer to each ask is reported to Monchu automatically: say what you did, what you checked and how, what failed or is left, and anything worth remembering about the user or the work; Monchu decides what to save. Use post_update for progress worth hearing before you finish. If a decision belongs to the user, stop and say so in your answer. Follow the device rules for the machine you run on.`,
  });
  await preloadGroups(tx, worker.id, preload);
  state.workers.push({
    name,
    conversationId: worker.id,
    reported: [],
    brief: message.slice(0, 300),
  });
  const input: DeliveryInput = {
    parentId,
    name,
    message,
    requestId,
    whenBusy: "followUp",
    ...(quiet ? { quiet: true } : {}),
  };
  const taskId = await tx.createTask(Delivery, input, {
    // Keeping deliveries inside the worker's abort scope prevents a pending delivery resurrecting stopped work.
    conversationId: worker.id,
    ownership: { kind: "conversation" },
    background: true,
  });
  state.deliveries.push({ requestId, name, taskId });
  state.started++;
  return worker.id;
}

export async function messageWorker(
  tx: Tx,
  parentId: ConversationId,
  name: string,
  message: string,
  requestId: string,
  whenBusy: WhenBusy,
  quiet = false,
): Promise<ConversationId> {
  const state = await tx.doc(WorkersDoc, parentId);
  const worker = named(state.workers, name);
  if (!state.deliveries.some((item) => item.requestId === requestId)) {
    if (worker.closed) throw new Error(`${name} is closed; reopen it with reopen_worker first`);
    await pruneRecords(tx, parentId);
    const input: DeliveryInput = {
      parentId,
      name,
      message,
      requestId,
      whenBusy,
      ...(quiet ? { quiet: true } : {}),
    };
    const taskId = await tx.createTask(Delivery, input, {
      conversationId: worker.conversationId,
      ownership: { kind: "conversation" },
      background: true,
    });
    state.deliveries.push({ requestId, name, taskId });
    state.started++;
  }
  return worker.conversationId;
}

/**
 * When a worker last did something (its newest message; a reply counts from when it ended) and the context size its
 * newest reply reported, unless a compaction or reset came after it. Scans only the newest entries.
 */
async function lastActivity(
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ at?: number; contextTokens?: number }> {
  const found: { at?: number; contextTokens?: number } = {};
  const { items } = await tx.scanEntries({ conversationId }, 50);
  let settled = false;
  for (const entry of items) {
    // Replies before a context's head marker measured the context it replaced.
    if (entry.head !== undefined) settled = true;
    for (const message of (entry.model ?? []).toReversed()) {
      if (message.role === "system") continue;
      if (found.at === undefined)
        found.at =
          message.timestamp + (message.role === "assistant" ? (message.durationMs ?? 0) : 0);
      if (message.role === "assistant" && !settled) {
        const { input, cacheRead, cacheWrite, output } = message.usage;
        const tokens = input + cacheRead + cacheWrite + output;
        if (tokens > 0) {
          found.contextTokens = tokens;
          settled = true;
        }
      }
      if (found.at !== undefined && settled) return found;
    }
  }
  return found;
}

/** Open workers, or every worker with `includeClosed`. */
export async function listWorkers(
  reader: Pick<Harness, "snapshot" | "getTask">,
  parentId: ConversationId,
  context: Context,
  includeClosed = false,
) {
  const state = await reader.snapshot(WorkersDoc, parentId, context);
  if (state === undefined) return [];
  return Promise.all(
    state.workers
      .filter((worker) => includeClosed || worker.closed !== true)
      .map(async (worker) => {
        const live = await reader.snapshot(LiveDoc, worker.conversationId, context);
        const agent = await reader.snapshot(AgentDoc, worker.conversationId, context);
        return {
          name: worker.name,
          conversationId: worker.conversationId,
          cwd: agent?.cwd,
          model:
            agent?.model === undefined
              ? undefined
              : `${agent.model.provider}/${agent.model.modelId}`,
          thinking: agent?.thinkingLevel,
          closed: worker.closed === true,
          busy:
            live?.run !== undefined ||
            (await pendingDelivery(state, worker.name, (id) => reader.getTask(id, context))),
          // The tools its current round is running, so a call that hangs shows by name.
          running: (live?.tools ?? []).flatMap(({ name, status }) =>
            status === "running" ? [name] : [],
          ),
        };
      }),
  );
}

/**
 * `listWorkers`, each with when it last did something (`activeAt`: while busy, its newest message, so a long silence
 * shows) and the context size its newest reply reported.
 */
export async function listWorkersWithActivity(
  reader: Pick<Harness, "snapshot" | "getTask" | "commit">,
  parentId: ConversationId,
  context: Context,
  includeClosed = false,
) {
  const workers = await listWorkers(reader, parentId, context, includeClosed);
  const activity = await reader.commit(
    (tx) => Promise.all(workers.map((worker) => lastActivity(tx, worker.conversationId))),
    context,
  );
  return workers.map((worker, index) => {
    const { at, contextTokens } = activity[index] ?? {};
    return { ...worker, activeAt: at, contextTokens };
  });
}

/** Names of open sub-workers at any depth below `workerId` that are running or have a pending delivery. */
async function busySubWorkers(
  reader: Pick<Harness, "snapshot" | "getTask">,
  workerId: ConversationId,
  context: Context,
): Promise<string[]> {
  const busy: string[] = [];
  for (const child of await listWorkers(reader, workerId, context)) {
    if (child.busy) busy.push(child.name);
    busy.push(...(await busySubWorkers(reader, child.conversationId, context)));
  }
  return busy;
}

/** Close the calling conversation's worker `name` and release its providers; the line to report for it. */
async function closeNamed(
  api: Pick<ToolExecutionApi, "conversationId" | "commit" | "snapshot" | "getTask">,
  name: string,
  context: Context,
): Promise<string> {
  const workerId = await workerConversationId(api, api.conversationId, name, context);
  // Sub-workers start only from the worker's own runs, which the closing commit rules out.
  const busy = await busySubWorkers(api, workerId, context);
  if (busy.length > 0) throw new Error(`${name} has busy sub-workers: ${busy.join(", ")}`);
  const closed = await api.commit((tx) => closeWorker(tx, api.conversationId, name), context);
  await releaseProviders(api, workerId, context);
  return closed ? `Closed ${name}.` : `${name} was already closed.`;
}

/** A worker's model choice as tools take it: a profile name, or a model and thinking level, each optional. */
type ModelChoice = {
  profile?: string;
  model?: string;
  thinking?: ModelRole["thinkingLevel"];
};

const modelChoice = {
  profile: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(
    Type.String({ minLength: 1, description: "provider/modelId, e.g. openai-codex/gpt-6.1-sol" }),
  ),
  thinking: Type.Optional(StringEnum(thinkingLevels)),
};

function describeRole(role: Pick<ModelRole, "provider" | "modelId" | "thinkingLevel">) {
  return `${role.provider}/${role.modelId}, thinking ${role.thinkingLevel}`;
}

/**
 * The role a choice selects on top of `base`: the profile first, then an explicit model and thinking level. Unknown
 * names, unregistered models, and levels the model doesn't support are errors, never a silent fallback.
 */
export function chooseRole(
  models: Models,
  profiles: Record<string, WorkerProfile>,
  base: ModelRole,
  choice: ModelChoice,
): ModelRole {
  let role = base;
  if (choice.profile !== undefined) {
    const profile = profiles[choice.profile];
    if (profile === undefined)
      throw new Error(
        `No worker profile ${choice.profile}; profiles: ${Object.keys(profiles).join(", ") || "none configured"}`,
      );
    role = {
      provider: profile.provider,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
    };
  }
  if (choice.model !== undefined) {
    const slash = choice.model.indexOf("/");
    if (slash <= 0) throw new Error(`Model ${choice.model} must be provider/modelId`);
    role = {
      ...role,
      provider: choice.model.slice(0, slash),
      modelId: choice.model.slice(slash + 1),
    };
  }
  if (choice.thinking !== undefined) role = { ...role, thinkingLevel: choice.thinking };
  const model = models.getModel(role.provider, role.modelId);
  if (model === undefined)
    throw new Error(`Monchu has no configured model ${role.provider}/${role.modelId}`);
  const levels = getSupportedThinkingLevels(model);
  if (!levels.includes(role.thinkingLevel))
    throw new Error(
      `${role.provider}/${role.modelId} does not support thinking ${role.thinkingLevel} (supported: ${levels.join(", ")})`,
    );
  return role;
}

/** The profiles as the front reads them in the worker tools' descriptions. */
function profileList(profiles: Record<string, WorkerProfile>): string {
  const entries = Object.entries(profiles);
  if (entries.length === 0) return "";
  return ` Profiles: ${entries.map(([name, profile]) => `${name} (${describeRole(profile)}): ${profile.use}`).join(" ")}`;
}

/**
 * Request IDs include the call ID so several calls inside one codemode script stay distinct.
 */
export function createWorkerTools(
  role: () => ModelRole,
  profiles: Record<string, WorkerProfile> = {},
  preload: readonly string[] = [],
) {
  const profilesText = profileList(profiles);
  return defineExtension({
    name: "monchu.workers",
    tasks: [Anchor, Delivery],
    tools: [
      defineTool({
        name: "start_worker",
        description: `Start a standing background worker for a domain (a project, repo, machine, or area like the user's notes) that no open worker owns; check worker_status first, and route asks in an owned domain with message_worker instead. Name it for the domain, not the task. Pass the user's ask in their own words and the outcome they want: the worker reads the shared manual, notes, and skills itself and decides the approach and scope. Returns immediately; results arrive automatically. cwd defaults to this conversation's current directory. Only start work the user authorized. Pick the worker's model with a profile, or model and thinking; omitted, it runs on the worker default (${describeRole(role())}). A worker keeps its model for life, so its prompt cache holds; pick at the start.${profilesText}`,
        parameters: Type.Object({
          name: Type.String({ minLength: 1 }),
          task: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String()),
          ...modelChoice,
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const agent = await api.agent(context);
          if (agent.cwd === undefined) throw new Error("Conversation has no execution directory");
          const cwd = await resolveDirectory(args.cwd ?? agent.cwd, agent.cwd);
          const picked = chooseRole(api.models, profiles, role(), args);
          const id = await api.commit(
            (tx) =>
              startWorker(
                tx,
                api.conversationId,
                args.name,
                args.task,
                cwd,
                `tool:${api.taskId}:${api.callId}`,
                picked,
                preload,
              ),
            context,
          );
          return {
            output: [
              {
                type: "text",
                text: `Started ${args.name} (conversation ${id}) in ${cwd} on ${describeRole(picked)}.`,
              },
            ],
          };
        },
      }),
      defineTool({
        name: "message_worker",
        description:
          "Route an ask to an existing background worker, normally the one that owns its domain. Steers its current run, or starts another run if idle. Returns immediately; the result arrives automatically. The worker keeps its model and thinking level, so its prompt cache holds; only a new worker picks another.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1 }),
          message: Type.String({ minLength: 1 }),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          await api.commit(
            (tx) =>
              messageWorker(
                tx,
                api.conversationId,
                args.name,
                args.message,
                `tool:${api.taskId}:${api.callId}`,
                "steer",
              ),
            context,
          );
          return { output: [{ type: "text", text: `Message committed for ${args.name}.` }] };
        },
      }),
      defineTool({
        name: "worker_status",
        description:
          "List this conversation's persistent background workers: directory, model, whether they have pending work, minutes since each last did something (idleMinutes), and its context size in tokens. Closed workers are listed only with include_closed.",
        parameters: Type.Object({ include_closed: Type.Optional(Type.Boolean()) }),
        replay: "safe",
        execute: async (args, api, context) => {
          const workers = await listWorkersWithActivity(
            api,
            api.conversationId,
            context,
            args.include_closed === true,
          );
          const now = Date.now();
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify(
                  workers.map(({ activeAt, running, ...worker }) => {
                    const minutes =
                      activeAt === undefined
                        ? undefined
                        : Math.max(0, Math.floor((now - activeAt) / 60_000));
                    // A busy worker's silence, with the calls it is running: a long one may be stuck.
                    return worker.busy
                      ? { ...worker, running, quietMinutes: minutes }
                      : { ...worker, idleMinutes: minutes };
                  }),
                ),
              },
            ],
          };
        },
      }),
      defineTool({
        name: "close_workers",
        description:
          "Retire idle workers, any number in one call: a worker whose line of work is done, the user asks, or that has sat idle past its prompt cache (about an hour) with no ask in its line expected soon. Closing is cheap: its conversation and history are kept, reopen_worker resumes it, and it releases the worker's parked model process. A reused worker past the cache window pays to rewrite its whole context either way. Keep a worker whose line has a next step coming soon. A closed worker leaves the active roster and rejects new messages until reopened. A worker closes once it has answered, even while its report is still arriving; one that is running, has queued messages, or has busy sub-workers stays open. Each name is closed or refused on its own. Tell the user in one line which workers you closed.",
        parameters: Type.Object({
          names: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
        }),
        // Closing a closed worker changes nothing, and releasing provider resources again is harmless.
        replay: "safe",
        execute: async (args, api, context) => {
          const lines: string[] = [];
          let refused = false;
          for (const name of args.names) {
            try {
              lines.push(await closeNamed(api, name, context));
            } catch (error) {
              refused = true;
              lines.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (refused) throw new Error(lines.join("\n"));
          return { output: [{ type: "text", text: lines.join("\n") }] };
        },
      }),
      defineTool({
        name: "reopen_worker",
        description:
          "Reopen a closed worker: it returns to the active roster and accepts messages again, continuing its conversation.",
        parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
        replay: "safe",
        execute: async (args, api, context) => {
          await api.commit((tx) => reopenWorker(tx, api.conversationId, args.name), context);
          return { output: [{ type: "text", text: `Reopened ${args.name}.` }] };
        },
      }),
      defineTool({
        name: "post_update",
        description:
          "Workers only: send a short progress update to the conversation that started you, for news worth hearing before you finish. A newer update replaces one still waiting. Your final answer is reported automatically; do not repeat it here.",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
        // Registration and posting are deduplicated by request ID, and every call keeps the same newest update.
        replay: "safe",
        execute: async (args, api, context) => {
          const requestId = `worker-update:${api.taskId}:${api.callId}`;
          const parentId = await api.commit((tx) => parentOf(tx, api.conversationId), context);
          const record =
            parentId === undefined
              ? undefined
              : (await api.snapshot(WorkersDoc, parentId, context))?.workers.find(
                  (item) => item.conversationId === api.conversationId,
                );
          if (parentId === undefined || record === undefined)
            throw new Error("post_update is only available to background workers");
          const parent = await api.conversation(parentId, context);
          if (parent === undefined) throw new Error("Worker parent conversation is missing");
          // Registered before admission, so every later call and a stop's withdrawal see it once it is admitted.
          const whenBusy = await api.commit(async (tx) => {
            const state = await tx.doc(WorkerUpdatesDoc, api.conversationId);
            if (!state.queued.includes(requestId)) state.queued.push(requestId);
            return reportWhenBusy(tx, parentId);
          }, context);
          await parent.submit(
            {
              type: "input",
              content: noticeText({ name: record.name, status: "update", text: args.text }),
              whenBusy,
              requestId,
            },
            context,
          );
          // Keep only the newest queued update; one already placed is part of the parent's transcript and stays.
          await api.commit(async (tx) => {
            const state = await tx.doc(WorkerUpdatesDoc, api.conversationId);
            state.queued = await withdrawQueued(tx, parentId, state.queued, true);
          }, context);
          return { output: [{ type: "text", text: "Update posted." }] };
        },
      }),
      defineTool({
        name: "user_messages",
        description:
          "Workers only: read the user's own recent messages to Monchu's front, newest last, optionally with the front's replies. Use it when a brief is ambiguous, seems to prescribe, or you need what the user actually said. Worker reports and system notices are left out.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          include_replies: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const limit = args.limit ?? 10;
          const lines = await api.commit(async (tx) => {
            // Workers belong, through their parents, to the root the user talks to.
            const rootId = await rootOf(tx, api.conversationId);
            if (rootId === api.conversationId) return undefined;
            // Newest first, until `limit` user messages; bounded so a long transcript can't stall the call.
            const found: { user: boolean; text: string }[] = [];
            let cursor: Parameters<Tx["scanEntries"]>[2];
            for (let page = 0, users = 0; page < 20 && users < limit; page++) {
              const scanned = await tx.scanEntries({ conversationId: rootId }, 100, cursor);
              for (const entry of scanned.items) {
                const user = UserEntry.is(entry);
                if (!user && !(args.include_replies && AssistantEntry.is(entry))) continue;
                const message = entry.model?.[0];
                if (
                  message === undefined ||
                  (message.role !== "user" && message.role !== "assistant")
                )
                  continue;
                const text = (
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("\n")
                ).trim();
                if (text === "" || (user && NOT_THE_USER.test(text))) continue;
                const when = new Date(message.timestamp)
                  .toISOString()
                  .slice(0, 16)
                  .replace("T", " ");
                found.push({ user, text: `${user ? "user" : "front"} · ${when}\n${text}` });
                if (user && ++users === limit) break;
              }
              if (scanned.next === undefined) break;
              cursor = scanned.next;
            }
            return found.reverse();
          }, context);
          if (lines === undefined) throw new Error("user_messages is only available to workers");
          const text = lines.map((line) => line.text).join("\n\n");
          return {
            output: [
              { type: "text", text: text || "No user messages in the front's current context." },
            ],
          };
        },
      }),
      defineTool({
        name: "stop_worker",
        description:
          "Explicitly cancel a worker's current work, queued messages, deliveries, and nested background work. Its conversation remains available. Ordinary chat abort does not stop workers.",
        parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          await stopWorker(api, api.conversationId, args.name, context);
          return { output: [{ type: "text", text: `Stopped ${args.name}.` }] };
        },
      }),
    ],
  });
}
