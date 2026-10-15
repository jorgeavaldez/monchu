import {
  type ClassifierResult,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  type Extension,
  InboxDoc,
  UserEntry,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssessmentsDoc,
  createEffortAssessment,
  ESCALATION_PREFIX,
  escalationSummary,
} from "../src/classifier.ts";
import { startWorker, WorkersDoc } from "../src/workers.ts";
import {
  allEntries,
  assessed,
  cleanup,
  classifierModel,
  context,
  deliveryTaskId,
  fauxRole,
  lastMessage,
  open,
  route,
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

async function withAssessment(extensions: readonly Extension[] = []) {
  const value = await setup();
  for (const extension of extensions) value.registry.install(extension);
  const classifier = scriptedClassifier(value.models);
  const assessment = createEffortAssessment(
    value.models,
    { provider: classifierModel.provider, modelId: classifierModel.id },
    undefined,
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

const hasAdvice = (messages: readonly Message[]) =>
  messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith("Effort assessment"),
  );

describe("effort assessment", () => {
  it("lets the front reply before the classifier answers", async () => {
    const test = await withAssessment();
    const pending = Promise.withResolvers<ClassifierResult>();
    test.classifier.answer = () => pending.promise;
    route(test.faux, () => fauxAssistantMessage([fauxText("looking into it")]));

    await test.send("refactor the worker module");
    const [item] = await test.items();
    expect(item?.result).toBeNull();

    pending.resolve(assessed("single_turn", 0.9, "contained", 0.9));
    await test.settle(0);
    expect((await test.items())[0]?.result).toMatchObject({
      status: "assessed",
      effort: "single_turn",
    });
    expect(await userTexts(test.root)).toEqual(["refactor the worker module"]);
    await test.harness.close(context);
  });

  it("queues assessed input by its busy mode: steer the running reply or follow it", async () => {
    const test = await withAssessment();
    test.classifier.answer = async () => assessed("single_turn", 0.9, "contained", 0.9);
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

  it("adds advice to the front's later requests once it settles", async () => {
    const test = await withAssessment();
    const pending = Promise.withResolvers<ClassifierResult>();
    test.classifier.answer = () => pending.promise;
    const seen: boolean[] = [];
    route(test.faux, (request) => {
      seen.push(hasAdvice(request.messages));
      // The classifier answers only once the first request is already out.
      pending.resolve(assessed("single_turn", 0.9, "contained", 0.9));
      return lastMessage(request.messages)?.role === "toolResult"
        ? fauxAssistantMessage([fauxText("done")])
        : fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3" })], {
            stopReason: "toolUse",
          });
    });
    await test.send("check the disk");
    // The first request went out without waiting; the one after the tool round carries the advice.
    expect(seen).toEqual([false, true]);
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

    await test.send("migrate the whole homelab to nix");
    pending.resolve(assessed("sustained", 0.92, "expanding", 0.8));
    await test.settle(0);
    await test.root.waitForIdle(context);

    const texts = await userTexts(test.root);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(
      /^\[Effort assessment: effort sustained \(92%\), scope expanding \(80%\)/,
    );
    // Clients show only the assessment, without the label's prose.
    expect(escalationSummary(texts[1] ?? "")).toBe("effort sustained (92%), scope expanding (80%)");
    expect(escalationSummary("[Effort assessment is a user's own words")).toBeUndefined();
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

    test.classifier.answer = () => assessed("sustained", 0.95, "expanding", 0.95);
    await test.send("big and delegated");
    await waitFor(async () => (await test.items())[0]?.result != null);
    await test.settle(0);

    test.classifier.answer = () => assessed("sustained", 0.55, "expanding", 0.6);
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
    pending.resolve(assessed("sustained", 0.95, "expanding", 0.95));
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
        ? assessed("sustained", 0.95, "expanding", 0.9)
        : assessed("single_turn", 0.9, "contained", 0.9);
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
    expect((await test.items())[1]?.result).toMatchObject({ effort: "single_turn" });
    const typo = advice.filter((line) => line.startsWith("fix the typo:"));
    expect(typo).toContainEqual(expect.stringContaining("effort single_turn (90%)"));
    expect(typo.join("\n")).not.toContain("sustained");
    await test.harness.close(context);
  });

  it("records a classifier failure without blocking or escalating", async () => {
    const test = await withAssessment();
    test.classifier.answer = () => ({
      ...assessed("single_turn", 1, "contained", 1),
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
});
