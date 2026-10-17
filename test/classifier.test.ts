import {
  type ClassifierResult,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  type Extension,
  InboxDoc,
  UserEntry,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { ESCALATION_PREFIX, escalationSummary } from "../src/api/notices.ts";
import { AssessmentsDoc, createEffortAssessment } from "../src/core/agents/classifier.ts";
import type { WorkerProfile } from "../src/core/config.ts";
import { GoalsDoc } from "../src/core/agents/goals.ts";
import { startWorker, WorkersDoc } from "../src/core/agents/workers.ts";
import {
  allEntries,
  cleanup,
  classifierModel,
  context,
  deliveryTaskId,
  fauxRole,
  lastMessage,
  open,
  route,
  routed,
  scriptedClassifier,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

/** A task that finishes at once: a completed delivery without a worker turn. */
const Done = defineTask<null, { phase: "done" }, null>({
  name: "test.done",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

async function withAssessment(
  extensions: readonly Extension[] = [],
  waitMs = 2000,
  profiles: Record<string, WorkerProfile> = {},
) {
  const value = await setup();
  for (const extension of extensions) value.registry.install(extension);
  const classifier = scriptedClassifier(value.models);
  const assessment = createEffortAssessment(
    value.models,
    { provider: classifierModel.provider, modelId: classifierModel.id },
    { waitMs, profiles },
  );
  value.registry.install(assessment.extension);
  const opened = await open(value);
  const send = async (message: string) =>
    (await assessment.submit(opened.root, message, `test:${message}`, "followUp", context)).wait(
      context,
    );
  const items = async () =>
    (await opened.harness.snapshot(AssessmentsDoc, opened.root.id, context))?.items ?? [];
  /** Wait for the assessment task of the input at `index`, which must exist. */
  const settle = async (index: number) => {
    const item = (await items())[index];
    if (item === undefined) throw new Error(`No assessment at ${index}`);
    await opened.harness.waitForTask(item.taskId, context);
  };
  return { ...value, ...opened, assessment, classifier, send, items, settle };
}

async function userTexts(root: Parameters<typeof allEntries>[0]): Promise<string[]> {
  return (await allEntries(root)).flatMap((entry) =>
    UserEntry.is(entry) ? [textOf(entry.model?.[0])] : [],
  );
}

describe("routing helper", () => {
  it("lets the front reply after a bounded wait when the classifier is slow", async () => {
    const test = await withAssessment([], 50);
    const pending = Promise.withResolvers<ClassifierResult>();
    test.classifier.answer = () => pending.promise;
    route(test.faux, () => fauxAssistantMessage([fauxText("looking into it")]));

    await test.send("refactor the worker module");
    const [item] = await test.items();
    expect(item?.result).toBeNull();

    pending.resolve(routed("front", 0.9));
    await test.settle(0);
    expect((await test.items())[0]?.result).toMatchObject({
      status: "routed",
      route: { choice: "front", probability: 0.9 },
    });
    expect(await userTexts(test.root)).toEqual(["refactor the worker module"]);
    await test.harness.close(context);
  });

  it("queues assessed input by its busy mode: steer the running reply or follow it", async () => {
    const test = await withAssessment();
    test.classifier.answer = async () => routed("front", 0.9);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    route(test.faux, async (request) => {
      if (textOf(lastMessage(request.messages)) === "hold") {
        started.resolve();
        await release.promise;
      }
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const first = await test.assessment.submit(test.root, "hold", "hold", "steer", context);
    await started.promise;
    await test.assessment.submit(test.root, "steer note", "steer", "steer", context);
    await test.assessment.submit(test.root, "later note", "later", "followUp", context);
    const inbox = await test.harness.snapshot(InboxDoc, test.root.id, context);
    expect(inbox?.items.map((item) => item.mode)).toEqual(["steer", "followUp"]);
    release.resolve();
    await first.wait(context);
    await test.harness.close(context);
  });

  it("waits for the classifier before the front's first request, and only once", async () => {
    const test = await withAssessment();
    test.classifier.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return routed("worker", 0.9, { worker: ["w", 0.85] });
    };
    const seen: string[] = [];
    route(test.faux, (request) => {
      const advice = request.messages.findLast(
        (message) => message.role === "system" && typeof message.content === "string",
      );
      seen.push(typeof advice?.content === "string" ? advice.content : "none");
      return fauxAssistantMessage([fauxText("routing it")]);
    });
    await test.send("check the disk");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("it needs a worker (90%)");
    expect(seen[0]).toContain("it continues w's line of context (85%)");
    await test.harness.close(context);
  });

  it("suggests a profile only for a new worker, and asks only when the profiles differ", async () => {
    const quick = { ...fauxRole, use: "small clear work" };
    const deep = { ...fauxRole, thinkingLevel: "high" as const, use: "hard work" };
    const test = await withAssessment([], 2000, { quick, deep });
    const advice: string[] = [];
    route(test.faux, (request) => {
      const last = request.messages.findLast(
        (message) => message.role === "system" && typeof message.content === "string",
      );
      if (typeof last?.content === "string") advice.push(last.content);
      return fauxAssistantMessage([fauxText("ok")]);
    });
    test.classifier.answer = () =>
      routed("worker", 0.9, { worker: ["new", 0.9], profile: ["deep", 0.85] });
    await test.send("dig into why the sync broke");
    const question = test.classifier.requests.at(-1)?.questions.profile;
    expect(question?.type === "choice" ? question.criteria : undefined).toEqual({
      quick: "small clear work",
      deep: "hard work",
    });
    expect(advice.at(-1)).toContain(
      "a new worker for it fits profile deep (faux/faux-1, thinking high; 85%)",
    );
    await test.root.commit(
      (tx) => startWorker(tx, test.root.id, "w", "sync work", test.directory, "w:0", fauxRole),
      context,
    );
    test.classifier.answer = () =>
      routed("worker", 0.9, { worker: ["w", 0.9], profile: ["deep", 0.85] });
    await test.send("look again at the sync");
    // An existing worker keeps its model, so the profile is not offered.
    expect(advice.at(-1)).toContain("it continues w's line of context");
    expect(advice.at(-1)).not.toContain("profile");
    await test.harness.close(context);

    const same = await withAssessment([], 2000, { quick, other: { ...quick, use: "other" } });
    route(same.faux, () => fauxAssistantMessage([fauxText("ok")]));
    await same.send("anything");
    expect(same.classifier.requests.at(-1)?.questions).not.toHaveProperty("profile");
    await same.harness.close(context);
  });

  it("gives the classifier the front's workers and open goals", async () => {
    const test = await withAssessment();
    route(test.faux, () => fauxAssistantMessage([fauxText("ok")]));
    await test.root.commit(async (tx) => {
      await startWorker(
        tx,
        test.root.id,
        "vault",
        "you own the vault",
        test.directory,
        "v:0",
        fauxRole,
      );
      const goals = await tx.doc(GoalsDoc, test.root.id);
      goals.goals.push({
        id: "notes",
        title: "Keep the vault tidy",
        kind: "endeavor",
        status: "active",
        workstream: "archiving done tasks",
        workers: ["vault"],
        next: "archive",
        updatedAt: 0,
      });
    }, context);
    await test.send("archive the old tasks");
    await test.settle(0);
    const request = test.classifier.requests.at(-1);
    const worker = request?.questions.worker;
    expect(worker?.type === "choice" ? Object.keys(worker.criteria) : []).toEqual(["vault", "new"]);
    expect(JSON.stringify(worker)).toContain(
      "Goal: Keep the vault tidy; now: archiving done tasks",
    );
    expect(JSON.stringify(worker)).toContain("First brief: you own the vault");
    expect(request?.state).toMatchObject({ workers: ["vault"] });
    await test.harness.close(context);
  });

  it("nudges once when the front works itself on input that needs a worker", async () => {
    const test = await withAssessment();
    test.classifier.answer = () => routed("worker", 0.9);
    const results: string[] = [];
    route(test.faux, (request) => {
      const last = lastMessage(request.messages);
      if (last?.role === "toolResult") results.push(textOf(last));
      if (textOf(last).startsWith(ESCALATION_PREFIX))
        return fauxAssistantMessage([fauxText("already handled")]);
      return results.length < 2
        ? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText("did it myself")]);
    });
    await test.send("fix the config");
    await test.root.waitForIdle(context);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("[Routing helper: Routing helper (Clef)");
    expect(results[0]).toContain("Nothing is routed for it yet.");
    expect(results[1]).not.toContain("Routing helper");
    await test.harness.close(context);
  });

  it("escalates once after the reply when a sure assessment finds nothing delegated", async () => {
    const test = await withAssessment();
    const pending = Promise.withResolvers<ClassifierResult>();
    test.classifier.answer = () => pending.promise;
    route(test.faux, (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text.startsWith(ESCALATION_PREFIX))
        return lastMessage(request.messages)?.role === "toolResult"
          ? fauxAssistantMessage([fauxText("delegated")])
          : fauxAssistantMessage([fauxText("on it")]);
      return fauxAssistantMessage([fauxText("looking into it")]);
    });

    await test.send("migrate every server to a new config system");
    pending.resolve(routed("worker", 0.92, { split: ["several", 0.8] }));
    await test.settle(0);
    await test.root.waitForIdle(context);

    const texts = await userTexts(test.root);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(
      /^\[Routing advice: needs a worker \(92%\), several lines of work \(80%\)/,
    );
    // Clients show only the assessment, without the label's prose.
    expect(escalationSummary(texts[1] ?? "")).toBe(
      "needs a worker (92%), several lines of work (80%)",
    );
    expect(escalationSummary("[Routing advice is a user's own words")).toBeUndefined();
    expect((await test.items())[0]?.escalated).toBe(true);
    await test.harness.close(context);
  });

  it("does not escalate when the front already delegated or the assessment is unsure", async () => {
    const test = await withAssessment();
    route(test.faux, (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("started")]);
      if (text === "big and delegated")
        return fauxAssistantMessage([fauxToolCall("start_worker", { name: "w", task: "big" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText(`reply ${text}`)]);
    });

    test.classifier.answer = () => routed("worker", 0.95);
    await test.send("big and delegated");
    await waitFor(async () => (await test.items())[0]?.result != null);
    await test.settle(0);

    test.classifier.answer = () => routed("worker", 0.6);
    await test.send("maybe big");
    await test.settle(1);
    await test.root.waitForIdle(context);

    expect((await test.items()).map((item) => item.escalated)).toEqual([false, false]);
    expect(
      (await userTexts(test.root)).filter((text) => text.startsWith(ESCALATION_PREFIX)),
    ).toEqual([]);
    await test.harness.close(context);
  });

  it("does not escalate after delegation prunes an already-full retry window", async () => {
    const test = await withAssessment([defineExtension({ name: "test.done", tasks: [Done] })]);
    route(test.faux, (request) =>
      textOf(lastMessage(request.messages)) === "delegate after pruning"
        ? fauxAssistantMessage(
            [fauxToolCall("message_worker", { name: "w", message: "more work" })],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage([fauxText("done")]),
    );
    await test.root.commit(
      (tx) => startWorker(tx, test.root.id, "w", "work", test.directory, "history:0", fauxRole),
      context,
    );
    // Fill the completed retry window without running a worker turn for each delivery.
    const seeded = await test.root.commit(async (tx) => {
      const state = await tx.doc(WorkersDoc, test.root.id);
      for (let index = 1; index < 200; index++) {
        const taskId = await tx.createTask(Done, null, {
          conversationId: test.root.id,
          ownership: { kind: "conversation" },
          background: true,
        });
        state.deliveries.push({ requestId: `history:${index}`, name: "w", taskId });
        state.started++;
      }
      return state.deliveries.map((delivery) => delivery.taskId);
    }, context);
    for (const taskId of seeded) await test.harness.waitForTask(taskId, context);
    await test.root.waitForIdle(context);
    const pending = Promise.withResolvers<ClassifierResult>();
    test.classifier.answer = () => pending.promise;
    await test.send("delegate after pruning");
    await test.harness.waitForTask(await deliveryTaskId(test.harness, test.root.id, -1), context);
    expect(
      (await test.harness.snapshot(WorkersDoc, test.root.id, context))?.deliveries,
    ).toHaveLength(200);
    expect((await test.harness.snapshot(WorkersDoc, test.root.id, context))?.started).toBe(201);
    pending.resolve(routed("worker", 0.95));
    await test.settle(0);
    expect((await test.items())[0]?.escalated).toBe(false);
    expect(
      (await userTexts(test.root)).filter((text) => text.startsWith(ESCALATION_PREFIX)),
    ).toEqual([]);
    expect(test.reports).toEqual([]);
    await test.harness.close(context);
  });

  it("assesses an edited queued message afresh and drops a withdrawn one's assessment", async () => {
    const test = await withAssessment();
    // Only the original text would escalate.
    test.classifier.answer = (request) =>
      JSON.stringify(request.state).includes("rewrite everything")
        ? routed("worker", 0.95)
        : routed("front", 0.9);
    const release = Promise.withResolvers<void>();
    const advice: string[] = [];
    route(test.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold") await release.promise;
      for (const message of request.messages)
        if (message.role === "system" && typeof message.content === "string")
          advice.push(`${text}: ${message.content}`);
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const hold = await test.assessment.submit(test.root, "hold", "hold", "followUp", context);
    await waitFor(async () => (await test.items())[0]?.result != null);
    for (const message of ["rewrite everything", "also rewrite everything"])
      await test.assessment.submit(test.root, message, message, "followUp", context);
    // Both sure assessments are in and waiting for the front to finish before they escalate.
    await waitFor(async () => (await test.items()).every((item) => item.result !== null));
    const [, edited, withdrawn] = await test.items();
    if (edited === undefined || withdrawn === undefined) throw new Error("Assessments are missing");

    await test.root.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, test.root.id);
      const [first, second] = inbox.items;
      if (first?.mode !== "followUp" || second === undefined)
        throw new Error("Queue is missing items");
      first.content = "fix the typo";
      await test.assessment.revise(tx, test.root.id, first.id, {
        message: "fix the typo",
        recent: [],
      });
      tx.settleSubmission(second.id, { status: "unanswered", reason: "aborted" });
      inbox.items.splice(1, 1);
      await test.assessment.revise(tx, test.root.id, second.id, undefined);
    }, context);
    const [, revised] = await test.items();
    expect(revised).toMatchObject({ submissionId: edited.submissionId, result: null });
    expect(revised?.taskId).not.toBe(edited.taskId);
    expect(await test.items()).toHaveLength(2);

    await test.settle(1);
    release.resolve();
    await hold.wait(context);
    await test.root.waitForIdle(context);
    // The replaced tasks end without escalating, and the edited message gets its own advice.
    await test.harness.waitForTask(edited.taskId, context);
    await test.harness.waitForTask(withdrawn.taskId, context);
    await test.root.waitForIdle(context);
    expect(await userTexts(test.root)).toEqual(["hold", "fix the typo"]);
    expect((await test.items())[1]?.result).toMatchObject({ route: { choice: "front" } });
    const typo = advice.filter((line) => line.startsWith("fix the typo:"));
    expect(typo).toContainEqual(expect.stringContaining("you can answer it yourself (90%)"));
    expect(typo.join("\n")).not.toContain("needs a worker");
    await test.harness.close(context);
  });

  it("records a classifier failure without blocking or escalating", async () => {
    const test = await withAssessment();
    test.classifier.answer = () => ({
      ...routed("front", 1),
      stopReason: "error",
      errorMessage: "401 from provider",
    });
    route(test.faux, () => fauxAssistantMessage([fauxText("answer")]));
    await test.send("hello");
    await test.settle(0);
    expect((await test.items())[0]?.result).toEqual({
      status: "failed",
      message: "401 from provider",
    });
    await test.harness.close(context);
  });

  it("stays off without its provider's credentials and sends input to the front unassessed", async () => {
    const value = await setup();
    const requests: unknown[] = [];
    value.models.setProvider(
      createProvider({
        id: "clef-off",
        auth: { apiKey: { name: "Off", resolve: async () => undefined } },
        models: [{ ...classifierModel, provider: "clef-off" }],
        classifiers: {
          "test-classifier": {
            classify: async (_model, request) => {
              requests.push(request);
              return routed("front", 0.9);
            },
          },
        },
      }),
    );
    const assessment = createEffortAssessment(value.models, {
      provider: "clef-off",
      modelId: classifierModel.id,
    });
    value.registry.install(assessment.extension);
    const opened = await open(value);
    route(value.faux, () => fauxAssistantMessage([fauxText("hi")]));
    expect(await assessment.available()).toBe(false);
    await (
      await assessment.submit(opened.root, "hello", "test:off", "followUp", context)
    ).wait(context);
    expect(await userTexts(opened.root)).toEqual(["hello"]);
    expect(
      (await opened.harness.snapshot(AssessmentsDoc, opened.root.id, context))?.items ?? [],
    ).toEqual([]);
    expect(requests).toEqual([]);
    await opened.harness.close(context);
  });
});
