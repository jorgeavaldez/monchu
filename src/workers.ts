import type { Context } from "@earendil-works/chord";
import { cleanupSessionResources, Type } from "@earendil-works/pi-ai";
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
  type EntryRecord,
  type Harness,
  type SubmissionId,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ModelRole } from "./config.ts";
import { resolveDirectory } from "./workdir.ts";

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

/** Whether the worker has a delivery that has not finished. */
async function pendingDelivery(
  state: WorkerRecords,
  name: string,
  task: (id: TaskId) => Promise<{ readonly state: { readonly status: string } } | undefined>,
): Promise<boolean> {
  for (const delivery of state.deliveries.filter((item) => item.name === name)) {
    const record = await task(delivery.taskId);
    if (record !== undefined && record.state.status !== "terminal") return true;
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

/** A worker report or progress update as the parent receives it: follow-up input that gives the front a turn. */
export type WorkerNotice = {
  name: string;
  status: "completed" | "failed" | "update";
  text: string;
};

const REPORT_LABEL = /^\[Background worker (.+): (completed|failed); not a new user instruction\]$/;
const UPDATE_LABEL = /^\[Worker (.+) update; not a new user instruction\]$/;
// Travels with each notice, so the front's own instructions need no worker-specific workflow.
const NOTICE_GUIDANCE =
  "Tell the user in one or two lines, update the related goal, then continue: start the next step, message the worker, or ask the user only when the decision is theirs. If the worker is blocked or needs something (an answer, access, another worker's help), unblock it now: answer it, relay to the worker that can help, or ask the user; then tell the worker how it gets unblocked.";

/** Front inputs that are not the user's own words: worker notices and routing-helper follow-ups. */
const NOT_THE_USER = /^\[(Worker |Background worker |Routing advice)/;

/** The settlement reason of an input the user deleted from a queue; a deleted report is dropped, not posted again. */
export const DELETED_FROM_QUEUE = "deleted";

export function noticeText(notice: WorkerNotice): string {
  const label =
    notice.status === "update"
      ? `[Worker ${notice.name} update; not a new user instruction]`
      : `[Background worker ${notice.name}: ${notice.status}; not a new user instruction]`;
  return `${label}\n${NOTICE_GUIDANCE}\n${notice.text}`;
}

/** The worker notice an entry carries, for clients that label it; `undefined` for any other entry. */
export function workerNotice(entry: EntryRecord): WorkerNotice | undefined {
  const message = UserEntry.is(entry) ? entry.model?.[0] : undefined;
  if (message?.role !== "user" || typeof message.content !== "string") return undefined;
  return parseWorkerNotice(message.content);
}

/** The worker notice an input's text carries, placed or still queued; `undefined` for any other text. */
export function parseWorkerNotice(content: string): WorkerNotice | undefined {
  const [label = "", guidance, ...text] = content.split("\n");
  if (guidance !== NOTICE_GUIDANCE) return undefined;
  const update = UPDATE_LABEL.exec(label)?.[1];
  if (update !== undefined) return { name: update, status: "update", text: text.join("\n") };
  const [, name, status] = REPORT_LABEL.exec(label) ?? [];
  if (name === undefined) return undefined;
  return { name, status: status === "completed" ? "completed" : "failed", text: text.join("\n") };
}

/** A report is posted again after `/abort` withdraws it; each post has its own request ID. */
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

/** What input does when it reaches a busy conversation: steer the current run, or wait for it to finish. */
export type WhenBusy = "steer" | "followUp";

type DeliveryInput = {
  parentId: ConversationId;
  name: string;
  message: string;
  requestId: string;
  whenBusy: WhenBusy;
};

const Delivery = defineTask<
  DeliveryInput,
  { phase: "deliver" } | { phase: "report"; result: WorkerResult | null },
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
          result = { ...base, status: "failed", text: settled.reason };
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
          if (!record.reported.includes(settled.answer)) {
            if (entry === undefined) throw new Error("Worker answer is missing");
            record.reported.push(settled.answer);
            result = { ...base, status: "completed", answerId: settled.answer, text };
          }
        }
        return { status: "running", checkpoint: { phase: "report", result } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const { parentId } = task.input;
      const result = task.state.checkpoint.result;
      if (result !== null) {
        const parent = await runtime.conversation(parentId, context);
        if (parent === undefined) throw new Error("Worker parent conversation is missing");
        // A follow-up starts the parent's turn when idle, or waits for its current answer. `/abort` withdraws queued
        // input, so a withdrawn report is posted again; recovery replays this request ID chain without duplicates.
        for (let attempt = 0; ; attempt++) {
          const submission = await parent.submit(
            {
              type: "input",
              content: noticeText(result),
              whenBusy: "followUp",
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
  await configure(tx, worker.id, {
    model: { provider: role.provider, modelId: role.modelId },
    thinkingLevel: role.thinkingLevel,
    cwd,
    instructions: `You are Monchu's background worker ${name}, a standing worker that owns a domain for the user. Your brief names the domain and the first ask; later asks in that domain will reach you too, so keep your context across them. Own each outcome end to end: decide the approach, and let the scope follow the outcome the user wants rather than the brief's wording. The front relies on your judgment: when the brief is ambiguous or seems to prescribe, read the user's own words with user_messages, and say so when the ask should go elsewhere or be split. Your final answer to each ask is reported to Monchu automatically: say what you did, what you checked and how, what failed or is left, and anything worth remembering about the user or the work; Monchu decides what to save. Use post_update for progress worth hearing before you finish. If a decision belongs to the user, stop and say so in your answer. Follow the device rules for the machine you run on.`,
  });
  state.workers.push({
    name,
    conversationId: worker.id,
    reported: [],
    brief: message.slice(0, 300),
  });
  const input: DeliveryInput = { parentId, name, message, requestId, whenBusy: "followUp" };
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
): Promise<ConversationId> {
  const state = await tx.doc(WorkersDoc, parentId);
  const worker = named(state.workers, name);
  if (!state.deliveries.some((item) => item.requestId === requestId)) {
    if (worker.closed) throw new Error(`${name} is closed; reopen it with reopen_worker first`);
    await pruneRecords(tx, parentId);
    const input: DeliveryInput = { parentId, name, message, requestId, whenBusy };
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
          closed: worker.closed === true,
          busy:
            live?.run !== undefined ||
            (await pendingDelivery(state, worker.name, (id) => reader.getTask(id, context))),
        };
      }),
  );
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

/**
 * Request IDs include the call ID so several calls inside one codemode script stay distinct.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createWorkerTools(role: () => ModelRole) {
  return defineExtension({
    name: "monchu.workers",
    tasks: [Anchor, Delivery],
    tools: [
      defineTool({
        name: "start_worker",
        description:
          "Start a standing background worker for a domain (a project, repo, machine, or area like the vault) that no open worker owns; check worker_status first, and route asks in an owned domain with message_worker instead. Name it for the domain, not the task. Pass the user's ask in their own words and the outcome they want: the worker reads the shared manual, vault, and skills itself and decides the approach and scope. Returns immediately; results arrive automatically. cwd defaults to this conversation's current directory. Only start work the user authorized.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1 }),
          task: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String()),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const agent = await api.agent(context);
          if (agent.cwd === undefined) throw new Error("Conversation has no execution directory");
          const cwd = await resolveDirectory(args.cwd ?? agent.cwd, agent.cwd);
          const defaults = role();
          const id = await api.commit(
            (tx) =>
              startWorker(
                tx,
                api.conversationId,
                args.name,
                args.task,
                cwd,
                `tool:${api.taskId}:${api.callId}`,
                defaults,
              ),
            context,
          );
          return {
            content: [
              { type: "text", text: `Started ${args.name} (conversation ${id}) in ${cwd}.` },
            ],
          };
        },
      }),
      defineTool({
        name: "message_worker",
        description:
          "Route an ask to an existing background worker, normally the one that owns its domain. Steers its current run, or starts another run if idle. Returns immediately; the result arrives automatically.",
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
          return { content: [{ type: "text", text: `Message committed for ${args.name}.` }] };
        },
      }),
      defineTool({
        name: "worker_status",
        description:
          "List this conversation's persistent background workers, their directories, and whether they have pending work. Closed workers are listed only with include_closed.",
        parameters: Type.Object({ include_closed: Type.Optional(Type.Boolean()) }),
        replay: "safe",
        execute: async (args, api, context) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await listWorkers(api, api.conversationId, context, args.include_closed === true),
              ),
            },
          ],
        }),
      }),
      defineTool({
        name: "close_worker",
        description:
          "Retire a worker whose domain is finished, or that the user asks to retire, and tell the user why. Never close a worker just because it reported: standing workers take the next ask in their domain. A closed worker leaves the active roster and rejects new messages. Only an idle worker with no pending deliveries or busy sub-workers closes; its conversation and history are kept, and reopen_worker resumes it. Idle alone does not mean finished: keep workers that may be reused.",
        parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
        // Closing a closed worker changes nothing, and releasing provider resources again is harmless.
        replay: "safe",
        execute: async (args, api, context) => {
          const workerId = await workerConversationId(api, api.conversationId, args.name, context);
          // Sub-workers start only from the worker's own runs, which the closing commit rules out.
          const busy = await busySubWorkers(api, workerId, context);
          if (busy.length > 0)
            throw new Error(`${args.name} has busy sub-workers: ${busy.join(", ")}`);
          const closed = await api.commit(
            (tx) => closeWorker(tx, api.conversationId, args.name),
            context,
          );
          await releaseProviders(api, workerId, context);
          return {
            content: [
              {
                type: "text",
                text: closed ? `Closed ${args.name}.` : `${args.name} was already closed.`,
              },
            ],
          };
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
          return { content: [{ type: "text", text: `Reopened ${args.name}.` }] };
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
          // A worker conversation is owned by an anchor task of the conversation that started it.
          const parentId = await api.commit(
            async (tx) => (await tx.conversation(api.conversationId))?.owner?.conversationId,
            context,
          );
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
          await api.commit(async (tx) => {
            const state = await tx.doc(WorkerUpdatesDoc, api.conversationId);
            if (!state.queued.includes(requestId)) state.queued.push(requestId);
          }, context);
          await parent.submit(
            {
              type: "input",
              content: noticeText({ name: record.name, status: "update", text: args.text }),
              whenBusy: "followUp",
              requestId,
            },
            context,
          );
          // Keep only the newest queued update; one already placed is part of the parent's transcript and stays.
          await api.commit(async (tx) => {
            const state = await tx.doc(WorkerUpdatesDoc, api.conversationId);
            state.queued = await withdrawQueued(tx, parentId, state.queued, true);
          }, context);
          return { content: [{ type: "text", text: "Update posted." }] };
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
            // Workers are owned, transitively, by the root the user talks to.
            let rootId: ConversationId = api.conversationId;
            let owner = (await tx.conversation(rootId))?.owner?.conversationId;
            if (owner === undefined) return undefined;
            while (owner !== undefined) {
              rootId = owner;
              owner = (await tx.conversation(rootId))?.owner?.conversationId;
            }
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
            content: [
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
          return { content: [{ type: "text", text: `Stopped ${args.name}.` }] };
        },
      }),
    ],
  });
}
