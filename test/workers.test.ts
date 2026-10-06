import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { configure, defineDoc, defineTask } from "@earendil-works/pi-durable";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { messageWorker, startWorker, WorkerResultEntry, WorkersDoc } from "../src/workers.ts";
import {
  allEntries,
  cleanup,
  context,
  fauxRole,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

/** Kinds of the front's model-visible entries in order, with worker results by name. */
async function transcript(root: Parameters<typeof allEntries>[0]): Promise<string[]> {
  return (await allEntries(root)).flatMap((entry) => {
    if (WorkerResultEntry.is(entry)) return [`worker:${entry.data.name}`];
    const message = entry.model?.[0];
    if (message === undefined || message.role === "system") return [];
    if (message.role === "assistant")
      return [message.content.some((part) => part.type === "toolCall") ? "call" : "answer"];
    return [message.role];
  });
}

/** Inspect actual retained SQLite payloads, not total database-file size. */
function workerRevisions(directory: string) {
  const database = new DatabaseSync(join(directory, "monchu.sqlite"), { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT r.kind, r.version, length(CAST(r.content AS BLOB)) AS bytes,
          CASE WHEN r.kind = 'delta' THEN (
            SELECT count(*) FROM json_each(r.content) AS op
            WHERE json_extract(op.value, '$[0]') = 's'
              AND json_type(op.value, '$[2]') = 'array'
          ) ELSE 0 END AS arrayReplacements
        FROM document_revisions AS r JOIN documents AS d ON d.id = r.document_id
        WHERE d.kind = ? ORDER BY r.seq`,
      )
      .all(JSON.stringify("monchu.workers"));
  } finally {
    database.close();
  }
}

describe("background workers", () => {
  it("reclaims an oversized v2 revision tail on the next change and bounds subsequent replay", async () => {
    const value = await setup();
    const previous = defineDoc({
      ...WorkersDoc.definition,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      checkpointWhen: () => false,
    });
    let { harness, root } = await open(value);
    await root.commit(async (tx) => {
      const answer = await tx.appendEntry(root.id, { kind: "test.answer", data: null });
      const state = await tx.doc(previous, root.id);
      state.workers.push({
        name: "stored",
        conversationId: root.id,
        reported: Array.from({ length: 200 }, () => answer.id),
      });
    }, context);
    for (let index = 0; index < 40; index++)
      await root.commit(async (tx) => {
        const answer = await tx.appendEntry(root.id, { kind: "test.answer", data: index });
        const state = await tx.doc(previous, root.id);
        state.workers[0]!.reported = [...state.workers[0]!.reported.slice(1), answer.id];
        state.started++;
      }, context);
    const before = await harness.snapshot(previous, root.id, context);
    await harness.close(context);
    const oversized = workerRevisions(value.directory);
    expect(oversized).toHaveLength(41);
    expect(oversized.slice(1).every((revision) => revision.arrayReplacements === 1)).toBe(true);

    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(before);
    // A read-only committing access is not an ordinary changed commit and cannot checkpoint.
    await root.commit(async (tx) => {
      await tx.doc(WorkersDoc, root.id);
    }, context);
    expect(workerRevisions(value.directory)).toEqual(oversized);
    await root.commit(async (tx) => {
      (await tx.doc(WorkersDoc, root.id)).started++;
    }, context);
    const reclaimed = workerRevisions(value.directory);
    expect(reclaimed).toEqual([expect.objectContaining({ kind: "base", version: 2 })]);
    const retainedBytes = oversized.reduce((total, row) => {
      if (typeof row.bytes !== "number") throw new Error("Expected SQLite payload length");
      return total + row.bytes;
    }, 0);
    expect(reclaimed[0]!.bytes).toBeLessThan(retainedBytes);
    for (let index = 0; index < 96; index++) {
      await root.commit(async (tx) => {
        (await tx.doc(WorkersDoc, root.id)).started++;
      }, context);
      expect(workerRevisions(value.directory).length).toBeLessThanOrEqual(32);
    }
    const after = await harness.snapshot(WorkersDoc, root.id, context);
    expect(after).toEqual({ ...before, started: before!.started + 97 });
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(after);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("bounds completed records and deduplicates recent retries across restart", async () => {
    const value = await setup();
    value.faux.setResponses(
      Array.from({ length: 220 }, () => fauxAssistantMessage([fauxText("done")])),
    );
    let { harness, root } = await open(value);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "w", "work", value.directory, "request:0", fauxRole),
      context,
    );
    for (let index = 0; index < 205; index++) {
      if (index > 0)
        await root.commit(
          (tx) => messageWorker(tx, root.id, "w", "work", `request:${index}`),
          context,
        );
      const state = await harness.snapshot(WorkersDoc, root.id, context);
      await harness.waitForTask(state!.deliveries.at(-1)!.taskId, context);
    }
    const before = await harness.snapshot(WorkersDoc, root.id, context);
    expect(before?.started).toBe(205);
    expect(before?.deliveries).toHaveLength(200);
    expect(before?.workers[0]?.reported).toHaveLength(200);
    expect(before?.deliveries.map((delivery) => delivery.requestId)).toEqual(
      Array.from({ length: 200 }, (_, index) => `request:${index + 5}`),
    );
    expect((await allEntries(root)).filter((entry) => WorkerResultEntry.is(entry))).toHaveLength(
      205,
    );
    await harness.close(context);
    const revisions = workerRevisions(value.directory);
    expect(revisions.length).toBeLessThanOrEqual(32);
    expect(revisions[0]?.kind).toBe("base");
    expect(revisions.every((revision) => revision.arrayReplacements === 0)).toBe(true);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(before);
    expect(
      await root.commit(
        (tx) =>
          startWorker(tx, root.id, "other", "ignored", value.directory, "request:204", fauxRole),
        context,
      ),
    ).toBe(workerId);
    await root.commit((tx) => messageWorker(tx, root.id, "w", "ignored", "request:203"), context);
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(before);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  }, 60_000);

  it("preserves more than 200 active deliveries through recovery and explicit cancellation", async () => {
    const value = await setup();
    value.faux.setResponses(
      Array.from({ length: 420 }, () => async (_request, options) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Worker hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
        return fauxAssistantMessage([fauxText("cancelled worker hold")]);
      }),
    );
    let { harness, root } = await open(value);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "w", "work", value.directory, "pending:0", fauxRole),
      context,
    );
    for (let index = 1; index < 205; index++)
      await root.commit(
        (tx) => messageWorker(tx, root.id, "w", "work", `pending:${index}`),
        context,
      );
    const before = await harness.snapshot(WorkersDoc, root.id, context);
    expect(before?.deliveries).toHaveLength(205);
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(before);
    await (await harness.conversation(workerId, context))!.abort(context, { background: true });
    for (const delivery of before!.deliveries) await harness.waitForTask(delivery.taskId, context);
    const after = await harness.snapshot(WorkersDoc, root.id, context);
    expect(after?.started).toBe(205);
    expect(after?.deliveries).toHaveLength(200);
    expect((await allEntries(root)).filter((entry) => WorkerResultEntry.is(entry))).toHaveLength(0);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  }, 60_000);

  it("keeps reportable answers beyond the recent window while the parent is busy", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.faux.setResponses(
      Array.from({ length: 220 }, () => async (request) => {
        if (textOf(lastMessage(request.messages)) === "hold front") await held;
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    const { harness, root } = await open(value);
    const front = await root.submit({ type: "input", content: "hold front" }, context);
    await root.commit(
      (tx) => startWorker(tx, root.id, "w", "work", value.directory, "held:0", fauxRole),
      context,
    );
    for (let index = 0; index < 205; index++) {
      if (index > 0)
        await root.commit(
          (tx) => messageWorker(tx, root.id, "w", "work", `held:${index}`),
          context,
        );
      const state = await harness.snapshot(WorkersDoc, root.id, context);
      const taskId = state!.deliveries.at(-1)!.taskId;
      await waitFor(async () => {
        const task = await harness.getTask(taskId, context);
        return (
          task?.state.status === "running" &&
          task.state.checkpoint !== null &&
          typeof task.state.checkpoint === "object" &&
          !Array.isArray(task.state.checkpoint) &&
          task.state.checkpoint.phase === "report"
        );
      });
    }
    const pending = await harness.snapshot(WorkersDoc, root.id, context);
    expect(pending?.deliveries).toHaveLength(205);
    expect(pending?.workers[0]?.reported).toHaveLength(205);
    expect((await allEntries(root)).filter((entry) => WorkerResultEntry.is(entry))).toHaveLength(0);
    release();
    await front.wait(context);
    for (const delivery of pending!.deliveries) await harness.waitForTask(delivery.taskId, context);
    const completed = await harness.snapshot(WorkersDoc, root.id, context);
    expect(completed?.deliveries).toHaveLength(200);
    expect(completed?.workers[0]?.reported).toHaveLength(200);
    expect((await allEntries(root)).filter((entry) => WorkerResultEntry.is(entry))).toHaveLength(
      205,
    );
    expect(value.reports).toEqual([]);
    await harness.close(context);
  }, 60_000);

  it("migrates v1 and preserves shared active answers outside the recent window through pruning and reopen", async () => {
    const value = await setup();
    route(value.faux, async (_request, options) => {
      const signal = options?.signal;
      if (signal === undefined) throw new Error("Worker hold requires cancellation");
      if (!signal.aborted) await once(signal, "abort");
      return fauxAssistantMessage([fauxText("cancelled worker hold")]);
    });
    const legacy = defineDoc<Omit<ReturnType<typeof WorkersDoc.definition.initial>, "started">>({
      kind: "monchu.workers",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ workers: [], deliveries: [] }),
    });
    const pending = defineTask<null, { phase: "hold" }, null>({
      name: "test.pending",
      version: 1,
      initial: () => ({ phase: "hold" }),
      phases: {
        hold: async (_task, runtime) => {
          if (!runtime.signal.aborted) await once(runtime.signal, "abort");
          runtime.signal.throwIfAborted();
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    });
    value.registry.install({ name: "test.pending", tasks: [pending] });
    let { harness, root } = await open(value);
    await root.commit(async (tx) => {
      const worker = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, worker.id, {
        model: { provider: fauxRole.provider, modelId: fauxRole.modelId },
        cwd: value.directory,
      });
      const entry = await tx.appendEntry(worker.id, { kind: "test.answer", data: null });
      const state = await tx.doc(legacy, root.id);
      const reported = [entry.id];
      for (let index = 0; index < 201; index++) {
        const answer = await tx.appendEntry(worker.id, { kind: "test.answer", data: index });
        reported.push(answer.id);
      }
      state.workers.push({ name: "legacy", conversationId: worker.id, reported });
      for (let index = 0; index < 2; index++) {
        const taskId = await tx.createTask(pending, null, {
          conversationId: worker.id,
          ownership: { kind: "conversation" },
          background: true,
        });
        await tx.createSubmission({
          type: "input",
          status: "done",
          conversationId: worker.id,
          requestId: `worker-message:${taskId}`,
          entry: entry.id,
          answer: entry.id,
        });
        state.deliveries.push({ name: "legacy", requestId: `legacy:${index}`, taskId });
      }
    }, context);
    const before = await harness.snapshot(legacy, root.id, context);
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual({ ...before, started: 2 });
    await root.commit(async (tx) => {
      await tx.doc(WorkersDoc, root.id);
    }, context);
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual({ ...before, started: 2 });
    await expect(harness.snapshot(legacy, root.id, context)).rejects.toThrow("has newer version");
    await harness.close(context);
    expect(workerRevisions(value.directory)).toEqual([
      expect.objectContaining({ kind: "base", version: 2 }),
    ]);
    ({ harness, root } = await open(value));
    await root.commit(
      (tx) => messageWorker(tx, root.id, "legacy", "held", "after-migration"),
      context,
    );
    const pruned = await harness.snapshot(WorkersDoc, root.id, context);
    expect(pruned?.started).toBe(3);
    expect(pruned?.deliveries.slice(0, 2)).toEqual(before!.deliveries);
    expect(pruned?.workers[0]?.reported).toEqual([
      before!.workers[0]!.reported[0],
      ...before!.workers[0]!.reported.slice(-200),
    ]);
    await harness.close(context);
    expect(workerRevisions(value.directory).every((row) => row.arrayReplacements === 0)).toBe(true);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(pruned);
    await root.commit(
      (tx) => messageWorker(tx, root.id, "legacy", "ignored", "after-migration"),
      context,
    );
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(pruned);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
  it("place a result after the busy front's answer, never inside its run", async () => {
    // Slow streaming keeps the front's answer running while the worker finishes.
    const value = await setup({ tokensPerSecond: 40 });
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (last?.role === "toolResult")
        return fauxAssistantMessage([fauxText(`front ${"word ".repeat(80)}`)]);
      if (text === "delegate")
        return fauxAssistantMessage([fauxToolCall("start_worker", { name: "w", task: "quick" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText(`done ${text}`)]);
    });
    const { harness, root } = await open(value);

    await (await root.submit({ type: "input", content: "delegate" }, context)).wait(context);
    const state = await harness.snapshot(WorkersDoc, root.id, context);
    for (const delivery of state?.deliveries ?? [])
      await harness.waitForTask(delivery.taskId, context);

    expect(await transcript(root)).toEqual(["user", "call", "toolResult", "answer", "worker:w"]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("deliver one result after the store is closed and reopened mid-work", async () => {
    const value = await setup({ tokensPerSecond: 40 });
    route(value.faux, (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "delegate")
        return fauxAssistantMessage([fauxToolCall("start_worker", { name: "w", task: "long" })], {
          stopReason: "toolUse",
        });
      if (lastMessage(request.messages)?.role === "toolResult")
        return fauxAssistantMessage([fauxText("started")]);
      return fauxAssistantMessage([fauxText(`worker ${"step ".repeat(60)}`)]);
    });
    let { harness, root } = await open(value);
    await (await root.submit({ type: "input", content: "delegate" }, context)).wait(context);
    const [worker] = (await harness.snapshot(WorkersDoc, root.id, context))?.workers ?? [];
    expect(worker).toBeDefined();
    // Close while the worker is still streaming.
    await waitFor(async () => {
      const entries = await allEntries(
        (await harness.conversation(worker!.conversationId, context))!,
      );
      return entries.some((entry) => entry.model?.[0]?.role === "user");
    });
    await harness.close(context);

    ({ harness, root } = await open(value));
    const state = await harness.snapshot(WorkersDoc, root.id, context);
    for (const delivery of state?.deliveries ?? [])
      await harness.waitForTask(delivery.taskId, context);
    const results = (await allEntries(root)).filter((entry) => WorkerResultEntry.is(entry));
    expect(results).toHaveLength(1);
    await harness.close(context);
  });
});
