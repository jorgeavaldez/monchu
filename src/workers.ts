import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ModelRole } from "./config.ts";
import { resolveDirectory } from "./workdir.ts";

export const WorkersDoc = defineDoc<{
  workers: { name: string; conversationId: ConversationId; reported: EntryId[] }[];
  deliveries: { requestId: string; name: string; taskId: TaskId }[];
}>({
  kind: "monchu.workers",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ workers: [], deliveries: [] }),
});

type WorkerResult = {
  name: string;
  conversationId: ConversationId;
  requestId: string;
  submissionId: SubmissionId;
  text: string;
} & ({ status: "completed"; answerId: EntryId } | { status: "failed" });

export const WorkerResultEntry = defineEntry<WorkerResult>("monchu.worker-result");

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
  whenBusy: "steer" | "followUp";
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
      const result = task.state.checkpoint.result;
      if (result === null) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
        return;
      }
      const parent = await runtime.conversation(task.input.parentId, context);
      if (parent === undefined) throw new Error("Worker parent conversation is missing");
      // Only the Harness may append to a conversation with an active run: a raw entry can land between a tool
      // call and its result. Wait for an idle parent and append only if it is still idle in the same commit.
      for (;;) {
        await parent.waitForIdle(context);
        const delivered = await runtime.commit(async (tx) => {
          if ((await tx.doc(LiveDoc, task.input.parentId)).run !== undefined) return undefined;
          // Passive committed output: visible without buying another model turn, and provenance-labelled context
          // for the parent's next request. Appending and finishing in one commit makes recovery deduplicated.
          await tx.appendEntry(WorkerResultEntry, task.input.parentId, {
            data: result,
            model: [
              {
                role: "user",
                content: `[Background worker ${result.name}: ${result.status}; not a new user instruction]\n${result.text}`,
                timestamp: runtime.now(),
              },
            ],
          });
          return { status: "terminal", outcome: { status: "completed", result: null } } as const;
        }, context);
        if (delivered !== undefined) return;
        // A run started between idle and commit; back off briefly instead of spinning.
        await runtime.sleep(runtime.now() + 250, context);
      }
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
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
  if (previous !== undefined) {
    const worker = state.workers.find((item) => item.name === previous.name);
    if (worker === undefined) throw new Error("Worker record is missing");
    return worker.conversationId;
  }
  if (state.workers.some((item) => item.name === name))
    throw new Error(`${name} already exists; send it a message instead`);
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
    instructions: `You are Monchu's background worker ${name}. Complete the delegated goal and report a concise result. Use installed tools as needed. Work only within the user's authorization. Your working directory is an execution detail, not the identity of your task.`,
  });
  state.workers.push({ name, conversationId: worker.id, reported: [] });
  const input: DeliveryInput = { parentId, name, message, requestId, whenBusy: "followUp" };
  const taskId = await tx.createTask(Delivery, input, {
    // Keeping deliveries inside the worker's abort scope prevents a pending delivery resurrecting stopped work.
    conversationId: worker.id,
    ownership: { kind: "conversation" },
    background: true,
  });
  state.deliveries.push({ requestId, name, taskId });
  return worker.id;
}

export async function messageWorker(
  tx: Tx,
  parentId: ConversationId,
  name: string,
  message: string,
  requestId: string,
): Promise<ConversationId> {
  const state = await tx.doc(WorkersDoc, parentId);
  const worker = state.workers.find((item) => item.name === name);
  if (worker === undefined) throw new Error(`No worker named ${name}`);
  if (!state.deliveries.some((item) => item.requestId === requestId)) {
    const input: DeliveryInput = { parentId, name, message, requestId, whenBusy: "steer" };
    const taskId = await tx.createTask(Delivery, input, {
      conversationId: worker.conversationId,
      ownership: { kind: "conversation" },
      background: true,
    });
    state.deliveries.push({ requestId, name, taskId });
  }
  return worker.conversationId;
}

export async function listWorkers(
  reader: Pick<Harness, "snapshot" | "getTask">,
  parentId: ConversationId,
  context: Context,
) {
  const state = await reader.snapshot(WorkersDoc, parentId, context);
  return Promise.all(
    (state?.workers ?? []).map(async (worker) => {
      const live = await reader.snapshot(LiveDoc, worker.conversationId, context);
      const agent = await reader.snapshot(AgentDoc, worker.conversationId, context);
      const deliveries = await Promise.all(
        (state?.deliveries ?? [])
          .filter((item) => item.name === worker.name)
          .map((item) => reader.getTask(item.taskId, context)),
      );
      return {
        name: worker.name,
        conversationId: worker.conversationId,
        cwd: agent?.cwd,
        busy:
          live?.run !== undefined ||
          deliveries.some((task) => task !== undefined && task.state.status !== "terminal"),
      };
    }),
  );
}

/** Request IDs include the call ID so several calls inside one codemode script stay distinct. */
export function createWorkerTools(role: ModelRole) {
  return defineExtension({
    name: "monchu.workers",
    tasks: [Anchor, Delivery],
    tools: [
      defineTool({
        name: "start_worker",
        description:
          "Start a named worker in the background and return immediately. Supply a self-contained goal, context, and constraints. Results arrive automatically; chat remains available. cwd defaults to this conversation's current directory. Only start work the user authorized.",
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
          const id = await api.commit(
            (tx) =>
              startWorker(
                tx,
                api.conversationId,
                args.name,
                args.task,
                cwd,
                `tool:${api.taskId}:${api.callId}`,
                role,
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
          "Send instructions to an existing background worker. Steers its current run, or starts another run if idle. Returns immediately; the result arrives automatically.",
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
              ),
            context,
          );
          return { content: [{ type: "text", text: `Message committed for ${args.name}.` }] };
        },
      }),
      defineTool({
        name: "worker_status",
        description:
          "List this conversation's persistent background workers, their directories, and whether they have pending work.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await listWorkers(api, api.conversationId, context)),
            },
          ],
        }),
      }),
      defineTool({
        name: "stop_worker",
        description:
          "Explicitly cancel a worker's current work, queued messages, deliveries, and nested background work. Its conversation remains available. Ordinary chat abort does not stop workers.",
        parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          const state = await api.snapshot(WorkersDoc, api.conversationId, context);
          const record = state?.workers.find((item) => item.name === args.name);
          if (record === undefined) throw new Error(`No worker named ${args.name}`);
          const worker = await api.conversation(record.conversationId, context);
          if (worker === undefined) throw new Error("Worker conversation is missing");
          await worker.abort(context, { background: true });
          return { content: [{ type: "text", text: `Stopped ${args.name}.` }] };
        },
      }),
    ],
  });
}
