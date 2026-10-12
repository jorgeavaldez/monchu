import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { InboxDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { messageWorker, startWorker, workerNotice, WorkersDoc } from "../src/workers.ts";
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

/** Kinds of the front's model-visible entries in order, with worker reports and updates by name. */
async function transcript(root: Parameters<typeof allEntries>[0]): Promise<string[]> {
  return (await allEntries(root)).flatMap((entry) => {
    const notice = workerNotice(entry);
    if (notice !== undefined)
      return [`${notice.status === "update" ? "update" : "worker"}:${notice.name}`];
    const message = entry.model?.[0];
    if (message === undefined || message.role === "system") return [];
    if (message.role === "assistant")
      return [message.content.some((part) => part.type === "toolCall") ? "call" : "answer"];
    return [message.role];
  });
}

/** Texts of the front's queued inputs, oldest first. */
async function queued(harness: Harness, root: Conversation): Promise<string[]> {
  const inbox = await harness.snapshot(InboxDoc, root.id, context);
  return (inbox?.items ?? []).map((item) =>
    item.mode !== "write" && typeof item.content === "string" ? item.content : "",
  );
}

/** Whether a faux request answers a worker report or update. */
function workerText(text: string): boolean {
  return text.startsWith("[Background worker ") || text.startsWith("[Worker ");
}

/** Wait until every delivery has reported and the front has answered. */
async function settle(harness: Harness, root: Conversation): Promise<void> {
  const state = await harness.snapshot(WorkersDoc, root.id, context);
  for (const delivery of state?.deliveries ?? [])
    await harness.waitForTask(delivery.taskId, context);
  await root.waitForIdle(context);
}

/** Worker reports (not updates) the front received. */
async function reports(root: Parameters<typeof allEntries>[0]) {
  return (await allEntries(root)).filter((entry) => {
    const status = workerNotice(entry)?.status;
    return status === "completed" || status === "failed";
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
  it("bounds completed records and deduplicates recent retries across restart", async () => {
    const value = await setup();
    value.faux.setResponses(
      // Each report gives the front a turn: one front answer per worker answer.
      Array.from({ length: 420 }, () => fauxAssistantMessage([fauxText("done")])),
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
    await root.waitForIdle(context);
    const before = await harness.snapshot(WorkersDoc, root.id, context);
    expect(before?.started).toBe(205);
    expect(before?.deliveries).toHaveLength(200);
    expect(before?.workers[0]?.reported).toHaveLength(200);
    expect(before?.deliveries.map((delivery) => delivery.requestId)).toEqual(
      Array.from({ length: 200 }, (_, index) => `request:${index + 5}`),
    );
    expect(await reports(root)).toHaveLength(205);
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
    expect(await reports(root)).toHaveLength(0);
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
      Array.from({ length: 420 }, () => async (request) => {
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
    expect(await reports(root)).toHaveLength(0);
    release();
    await front.wait(context);
    for (const delivery of pending!.deliveries) await harness.waitForTask(delivery.taskId, context);
    await root.waitForIdle(context);
    const completed = await harness.snapshot(WorkersDoc, root.id, context);
    expect(completed?.deliveries).toHaveLength(200);
    expect(completed?.workers[0]?.reported).toHaveLength(200);
    expect(await reports(root)).toHaveLength(205);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  }, 60_000);

  it("gives the idle front a turn after a worker report, and its answer follows", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    route(value.faux, async (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "delegate")
        return fauxAssistantMessage([fauxToolCall("start_worker", { name: "w", task: "slow" })], {
          stopReason: "toolUse",
        });
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("started")]);
      if (text === "slow") {
        await held;
        return fauxAssistantMessage([fauxText("worker result")]);
      }
      return fauxAssistantMessage([fauxText(`front saw ${text.split("\n", 1)[0]}`)]);
    });
    const { harness, root } = await open(value);
    await (await root.submit({ type: "input", content: "delegate" }, context)).wait(context);
    expect(await transcript(root)).toEqual(["user", "call", "toolResult", "answer"]);

    release();
    await settle(harness, root);
    expect(await transcript(root)).toEqual([
      "user",
      "call",
      "toolResult",
      "answer",
      "worker:w",
      "answer",
    ]);
    const entries = await allEntries(root);
    expect(workerNotice(entries.at(-2)!)).toEqual({
      name: "w",
      status: "completed",
      text: "worker result",
    });
    expect(textOf(entries.at(-1)!.model?.[0])).toBe(
      "front saw [Background worker w: completed; not a new user instruction]",
    );
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("queues a report while the front is busy, then gives it one turn after the front's answer", async () => {
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
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText(`done ${text}`)]);
    });
    const { harness, root } = await open(value);

    const front = await root.submit({ type: "input", content: "delegate" }, context);
    // The report waits in the busy front's queue instead of landing inside its run.
    await waitFor(
      async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 1,
    );
    expect((await front.status(context)).status).toBe("placed");
    expect(await transcript(root)).not.toContain("worker:w");
    await settle(harness, root);

    expect(await transcript(root)).toEqual([
      "user",
      "call",
      "toolResult",
      "answer",
      "worker:w",
      "answer",
    ]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("reports once when the store closes while the report is queued", async () => {
    const value = await setup();
    let holding = true;
    route(value.faux, async (request, options) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold front" && holding) {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Front hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
        return fauxAssistantMessage([fauxText("cancelled front hold")]);
      }
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText(`done ${text}`)]);
    });
    let { harness, root } = await open(value);
    await root.submit({ type: "input", content: "hold front" }, context);
    await root.commit(
      (tx) => startWorker(tx, root.id, "w", "quick", value.directory, "queued:0", fauxRole),
      context,
    );
    await waitFor(
      async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 1,
    );
    await harness.close(context);

    holding = false;
    ({ harness, root } = await open(value));
    await settle(harness, root);
    expect(await transcript(root)).toEqual(["user", "answer", "worker:w", "answer"]);
    await harness.close(context);
    ({ harness, root } = await open(value));
    await settle(harness, root);
    expect(await reports(root)).toHaveLength(1);
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
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
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
    await settle(harness, root);
    expect(await reports(root)).toHaveLength(1);
    expect(await transcript(root)).toEqual([
      "user",
      "call",
      "toolResult",
      "answer",
      "worker:w",
      "answer",
    ]);
    await harness.close(context);
  });

  it("re-posts a report that /abort withdrew from the front's queue", async () => {
    const value = await setup();
    let holding = true;
    route(value.faux, async (request, options) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold front" && holding) {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Front hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
        return fauxAssistantMessage([fauxText("cancelled front hold")]);
      }
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText(`done ${text}`)]);
    });
    const { harness, root } = await open(value);
    await root.submit({ type: "input", content: "hold front" }, context);
    await root.commit(
      (tx) => startWorker(tx, root.id, "w", "quick", value.directory, "abort:0", fauxRole),
      context,
    );
    await waitFor(
      async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 1,
    );
    holding = false;
    await root.abort(context);
    await settle(harness, root);

    // The aborted run leaves no answer; the withdrawn report is posted again and answered once.
    expect(await transcript(root)).toEqual(["user", "worker:w", "answer"]);
    const taskId = (await harness.snapshot(WorkersDoc, root.id, context))!.deliveries[0]!.taskId;
    const [withdrawn, reposted] = await root.commit(
      (tx) =>
        Promise.all([
          tx.submissionByRequest(root.id, `worker-report:${taskId}`),
          tx.submissionByRequest(root.id, `worker-report:${taskId}:1`),
        ]),
      context,
    );
    expect(withdrawn).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(reposted).toMatchObject({ status: "done" });
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("delivers a worker's post_update to the front, and rejects it from the front", async () => {
    const value = await setup();
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "progress")
        return fauxAssistantMessage([fauxToolCall("post_update", { text: "halfway" })], {
          stopReason: "toolUse",
        });
      if (text === "front update")
        return fauxAssistantMessage([fauxToolCall("post_update", { text: "nope" })], {
          stopReason: "toolUse",
        });
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(`after ${text}`)]);
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText(`done ${text}`)]);
    });
    const { harness, root } = await open(value);

    await (await root.submit({ type: "input", content: "front update" }, context)).wait(context);
    const rejected = (await allEntries(root)).find(
      (entry) => entry.model?.[0]?.role === "toolResult",
    )?.model?.[0];
    expect(rejected?.role === "toolResult" && rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("only available to background workers");

    await root.commit(
      (tx) => startWorker(tx, root.id, "w", "progress", value.directory, "update:0", fauxRole),
      context,
    );
    await settle(harness, root);
    const notices = (await allEntries(root)).flatMap((entry) => workerNotice(entry) ?? []);
    expect(notices).toEqual([
      { name: "w", status: "update", text: "halfway" },
      { name: "w", status: "completed", text: "after Update posted." },
    ]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("keeps one queued update per worker: a newer update withdraws the queued one", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    route(value.faux, async (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "hold front") {
        await held;
        return fauxAssistantMessage([fauxText("front done")]);
      }
      const results = request.messages.filter((message) => message.role === "toolResult").length;
      if (text === "two updates" || (last?.role === "toolResult" && results === 1))
        return fauxAssistantMessage(
          [fauxToolCall("post_update", { text: results === 0 ? "one" : "two" })],
          { stopReason: "toolUse" },
        );
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText("worker done")]);
    });
    const { harness, root } = await open(value);
    await root.submit({ type: "input", content: "hold front" }, context);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "w", "two updates", value.directory, "updates:0", fauxRole),
      context,
    );
    const worker = (await harness.conversation(workerId, context))!;
    await waitFor(async () => {
      const entries = await allEntries(worker);
      return entries.some((entry) => textOf(entry.model?.[0]) === "worker done");
    });
    // The report queues too once the worker answers; updates are limited, reports are not.
    await waitFor(
      async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 2,
    );
    const items = await queued(harness, root);
    expect(items.map((text) => text.split("\n", 1)[0])).toEqual([
      "[Worker w update; not a new user instruction]",
      "[Background worker w: completed; not a new user instruction]",
    ]);
    expect(items[0]!.endsWith("\ntwo")).toBe(true);

    release();
    await settle(harness, root);
    const notices = (await allEntries(root)).flatMap((entry) => workerNotice(entry) ?? []);
    expect(notices).toEqual([
      { name: "w", status: "update", text: "two" },
      { name: "w", status: "completed", text: "worker done" },
    ]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("leaves one queued update when a worker posts two in parallel", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    route(value.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold front") {
        await held;
        return fauxAssistantMessage([fauxText("front done")]);
      }
      if (text === "parallel updates")
        return fauxAssistantMessage(
          [
            fauxToolCall("post_update", { text: "one" }),
            fauxToolCall("post_update", { text: "two" }),
          ],
          { stopReason: "toolUse" },
        );
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText("worker done")]);
    });
    const { harness, root } = await open(value);
    await root.submit({ type: "input", content: "hold front" }, context);
    await root.commit(
      (tx) =>
        startWorker(tx, root.id, "w", "parallel updates", value.directory, "parallel:0", fauxRole),
      context,
    );
    await waitFor(async () => (await queued(harness, root)).length === 2);
    expect((await queued(harness, root)).map((text) => text.split("\n", 1)[0])).toEqual([
      "[Worker w update; not a new user instruction]",
      "[Background worker w: completed; not a new user instruction]",
    ]);

    release();
    await settle(harness, root);
    expect((await allEntries(root)).flatMap((entry) => workerNotice(entry)?.status ?? [])).toEqual([
      "update",
      "completed",
    ]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("withdraws a stopped worker's queued report and update", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    route(value.faux, async (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "hold front") {
        await held;
        return fauxAssistantMessage([fauxText("front done")]);
      }
      if (text === "update then finish")
        return fauxAssistantMessage([fauxToolCall("post_update", { text: "halfway" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("worker done")]);
    });
    const { harness, root } = await open(value);
    await root.submit({ type: "input", content: "hold front" }, context);
    const workerId = await root.commit(
      (tx) =>
        startWorker(tx, root.id, "w", "update then finish", value.directory, "stop:0", fauxRole),
      context,
    );
    await waitFor(async () => (await queued(harness, root)).length === 2);
    await (await harness.conversation(workerId, context))!.abort(context, { background: true });
    expect(await queued(harness, root)).toEqual([]);
    const taskId = (await harness.snapshot(WorkersDoc, root.id, context))!.deliveries[0]!.taskId;
    expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("aborted");

    release();
    await settle(harness, root);
    expect(await transcript(root)).toEqual(["user", "answer"]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
});
