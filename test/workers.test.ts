import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import assert from "node:assert";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeWorker,
  listWorkers,
  messageWorker,
  reopenWorker,
  startWorker,
  workerNotice,
  WorkersDoc,
} from "../src/workers.ts";
import {
  allEntries,
  callTools,
  cleanup,
  context,
  conversationOf,
  deliveryTaskId,
  fauxRole,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  toolResults,
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
          (tx) => messageWorker(tx, root.id, "w", "work", `request:${index}`, "steer"),
          context,
        );
      await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
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
    await root.commit(
      (tx) => messageWorker(tx, root.id, "w", "ignored", "request:203", "steer"),
      context,
    );
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
        (tx) => messageWorker(tx, root.id, "w", "work", `pending:${index}`, "steer"),
        context,
      );
    const before = await harness.snapshot(WorkersDoc, root.id, context);
    expect(before?.deliveries).toHaveLength(205);
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await harness.snapshot(WorkersDoc, root.id, context)).toEqual(before);
    await (await conversationOf(harness, workerId)).abort(context, { background: true });
    for (const delivery of before?.deliveries ?? [])
      await harness.waitForTask(delivery.taskId, context);
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
          (tx) => messageWorker(tx, root.id, "w", "work", `held:${index}`, "steer"),
          context,
        );
      const taskId = await deliveryTaskId(harness, root.id, -1);
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
    for (const delivery of pending?.deliveries ?? [])
      await harness.waitForTask(delivery.taskId, context);
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
    const [report, answer] = entries.slice(-2);
    assert(report !== undefined && answer !== undefined);
    expect(workerNotice(report)).toEqual({
      name: "w",
      status: "completed",
      text: "worker result",
    });
    expect(textOf(answer.model?.[0])).toBe(
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
    assert(worker !== undefined);
    // Close while the worker is still streaming.
    await waitFor(async () => {
      const entries = await allEntries(await conversationOf(harness, worker.conversationId));
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
    const taskId = await deliveryTaskId(harness, root.id, 0);
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

  it("lets a worker read the user's own messages to the front, without notices", async () => {
    const value = await setup();
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "read them")
        return fauxAssistantMessage([fauxToolCall("user_messages", { limit: 2 })], {
          stopReason: "toolUse",
        });
      if (text === "front reads")
        return fauxAssistantMessage([fauxToolCall("user_messages", {})], {
          stopReason: "toolUse",
        });
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(`read: ${text}`)]);
      if (workerText(text)) return fauxAssistantMessage([fauxText("noted")]);
      return fauxAssistantMessage([fauxText(`reply ${text}`)]);
    });
    const { harness, root } = await open(value);
    for (const content of ["first ask", "second ask", "third ask"])
      await (await root.submit({ type: "input", content }, context)).wait(context);
    await (await root.submit({ type: "input", content: "front reads" }, context)).wait(context);
    const rejected = (await allEntries(root)).findLast(
      (entry) => entry.model?.[0]?.role === "toolResult",
    )?.model?.[0];
    expect(textOf(rejected)).toContain("only available to workers");

    await root.commit(
      (tx) => startWorker(tx, root.id, "w", "read them", value.directory, "read:0", fauxRole),
      context,
    );
    await settle(harness, root);
    const report = (await allEntries(root))
      .flatMap((entry) => workerNotice(entry) ?? [])
      .find((notice) => notice.status === "completed");
    // The last two of the user's messages, oldest first, and no worker notice among them.
    expect(report?.text).toMatch(/^read: user · .*\nthird ask\n\nuser · .*\nfront reads$/s);
    expect(report?.text).not.toContain("second ask");
    expect(report?.text).not.toContain("reply");
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
    const worker = await conversationOf(harness, workerId);
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
    expect(items[0]?.endsWith("\ntwo")).toBe(true);

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
    await (await conversationOf(harness, workerId)).abort(context, { background: true });
    expect(await queued(harness, root)).toEqual([]);
    const taskId = await deliveryTaskId(harness, root.id, 0);
    expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("aborted");

    release();
    await settle(harness, root);
    expect(await transcript(root)).toEqual(["user", "answer"]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
});

describe("worker lifecycle", () => {
  it("starts a worker on a profile or an explicit model, refuses unknown and unsupported choices, and never switches it on a message", async () => {
    const think = { provider: "faux", modelId: "faux-think" };
    const value = await setup(
      { models: [{ id: "faux-1" }, { id: "faux-think", reasoning: true }] },
      {
        quick: { ...think, thinkingLevel: "low", use: "small clear work" },
        deep: { ...think, thinkingLevel: "high", use: "hard work" },
      },
    );
    route(
      value.faux,
      callTools({
        "start quick": {
          tool: "start_worker",
          args: { name: "q", task: "work", profile: "quick" },
        },
        "start unknown": {
          tool: "start_worker",
          args: { name: "u", task: "work", profile: "nope" },
        },
        "start unsupported": {
          tool: "start_worker",
          args: { name: "x", task: "work", model: "faux/faux-1", thinking: "high" },
        },
        "start explicit": {
          tool: "start_worker",
          args: { name: "e", task: "work", profile: "deep", thinking: "medium" },
        },
        "message quick": { tool: "message_worker", args: { name: "q", message: "more" } },
      }),
    );
    const { harness, root } = await open(value);
    for (const content of [
      "start quick",
      "start unknown",
      "start unsupported",
      "start explicit",
      "message quick",
    ]) {
      await (await root.submit({ type: "input", content }, context)).wait(context);
      await settle(harness, root);
    }
    const results = (await toolResults(root)).map((result) => textOf(result));
    expect(results[0]).toMatch(/^Started q .* on faux\/faux-think, thinking low\.$/);
    expect(results[1]).toContain("No worker profile nope; profiles: quick, deep");
    expect(results[2]).toContain("faux/faux-1 does not support thinking high");
    expect(results[3]).toMatch(/on faux\/faux-think, thinking medium\.$/);
    expect(results[4]).toBe("Message committed for q.");
    const workers = await listWorkers(harness, root.id, context);
    expect(workers.map(({ name, model, thinking }) => ({ name, model, thinking }))).toEqual([
      { name: "q", model: "faux/faux-think", thinking: "low" },
      { name: "e", model: "faux/faux-think", thinking: "medium" },
    ]);
    // The tools tell the front which profiles there are.
    const tools = (await root.agent(context)).tools;
    expect(tools.find((tool) => tool.name === "start_worker")?.description).toContain(
      "quick (faux/faux-think, thinking low): small clear work",
    );
    expect(tools.find((tool) => tool.name === "message_worker")?.parameters).not.toHaveProperty(
      "properties.profile",
    );
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("closes only an idle worker, hides it, rejects messages until reopened, and keeps it across restart", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    route(value.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold worker") await held;
      return fauxAssistantMessage([fauxText(`answered ${text.split("\n", 1)[0]}`)]);
    });
    let { harness, root } = await open(value);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "w", "hold worker", value.directory, "start:0", fauxRole),
      context,
    );
    await waitFor(
      async () => (await harness.snapshot(LiveDoc, workerId, context))?.run !== undefined,
    );
    await expect(root.commit((tx) => closeWorker(tx, root.id, "w"), context)).rejects.toThrow(
      "w is busy",
    );
    release();
    await settle(harness, root);
    expect(await root.commit((tx) => closeWorker(tx, root.id, "w"), context)).toBe(true);
    expect(await root.commit((tx) => closeWorker(tx, root.id, "w"), context)).toBe(false);

    expect(await listWorkers(harness, root.id, context)).toEqual([]);
    expect(await listWorkers(harness, root.id, context, true)).toMatchObject([
      { name: "w", closed: true, busy: false },
    ]);
    await expect(
      root.commit((tx) => messageWorker(tx, root.id, "w", "more", "more:0", "steer"), context),
    ).rejects.toThrow("w is closed; reopen it with reopen_worker first");
    await expect(
      root.commit(
        (tx) => startWorker(tx, root.id, "w", "new", value.directory, "start:1", fauxRole),
        context,
      ),
    ).rejects.toThrow("w is closed");
    // A retry of a message accepted before the close still resolves to the same worker.
    expect(
      await root.commit(
        (tx) => messageWorker(tx, root.id, "w", "hold worker", "start:0", "steer"),
        context,
      ),
    ).toBe(workerId);
    const history = await transcript(await conversationOf(harness, workerId));
    expect(history).toEqual(["user", "answer"]);

    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await listWorkers(harness, root.id, context)).toEqual([]);
    await root.commit((tx) => reopenWorker(tx, root.id, "w"), context);
    expect(await listWorkers(harness, root.id, context)).toMatchObject([
      { name: "w", closed: false },
    ]);
    await root.commit((tx) => messageWorker(tx, root.id, "w", "more", "more:1", "steer"), context);
    await settle(harness, root);
    // The reopened worker continues the same conversation.
    expect(await transcript(await conversationOf(harness, workerId))).toEqual([
      "user",
      "answer",
      "user",
      "answer",
    ]);
    await harness.close(context);
    ({ harness, root } = await open(value));
    expect(await listWorkers(harness, root.id, context)).toMatchObject([
      { name: "w", closed: false },
    ]);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("refuses close_worker while a sub-worker is busy, then closes and lists through the front's tools", async () => {
    const value = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Record<string, { tool: string; args: Record<string, string | boolean> }> = {
      spawn: { tool: "start_worker", args: { name: "child", task: "hold child" } },
      close: { tool: "close_worker", args: { name: "w" } },
      status: { tool: "worker_status", args: { include_closed: true } },
      reopen: { tool: "reopen_worker", args: { name: "w" } },
    };
    route(value.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold child") await held;
      const call = lastMessage(request.messages)?.role === "user" ? calls[text] : undefined;
      return call === undefined
        ? fauxAssistantMessage([fauxText("ok")])
        : fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" });
    });
    const { harness, root } = await open(value);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "w", "spawn", value.directory, "start:0", fauxRole),
      context,
    );
    const worker = await conversationOf(harness, workerId);
    await waitFor(async () => (await listWorkers(harness, workerId, context))[0]?.busy === true);
    await settle(harness, root);
    await worker.waitForIdle(context);
    let asked = 0;
    const ask = async (content: string) => {
      await (
        await root.submit({ type: "input", content, requestId: `${content}:${++asked}` }, context)
      ).wait(context);
      return (await toolResults(root)).at(-1);
    };
    const refused = await ask("close");
    expect(refused?.isError).toBe(true);
    expect(textOf(refused)).toContain("w has busy sub-workers: child");

    release();
    await waitFor(async () => (await listWorkers(harness, workerId, context))[0]?.busy === false);
    await settle(harness, worker);
    await settle(harness, root);
    const closed = await ask("close");
    expect(closed?.isError).toBe(false);
    expect(textOf(closed)).toBe("Closed w.");
    expect(textOf(await ask("status"))).toContain('"name":"w"');
    expect(textOf((await toolResults(root)).at(-1))).toContain('"closed":true');
    expect(await listWorkers(harness, root.id, context)).toEqual([]);
    expect(textOf(await ask("reopen"))).toBe("Reopened w.");
    expect(await listWorkers(harness, root.id, context)).toMatchObject([{ name: "w" }]);
    await settle(harness, root);
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
});
