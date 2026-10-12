import {
  type ClassifierResult,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTask, type Extension, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { AssessmentsDoc, createEffortAssessment, ESCALATION_PREFIX } from "../src/classifier.ts";
import { startWorker, WorkersDoc } from "../src/workers.ts";
import {
  allEntries,
  assessed,
  cleanup,
  classifierModel,
  context,
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
    (await assessment.submit(opened.root, message, `test:${message}`, context)).wait(context);
  const items = async () =>
    (await opened.harness.snapshot(AssessmentsDoc, opened.root.id, context))?.items ?? [];
  return { ...value, ...opened, classifier, send, items };
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
    await test.harness.waitForTask(item!.taskId, context);
    expect((await test.items())[0]?.result).toMatchObject({
      status: "assessed",
      effort: "single_turn",
    });
    expect(await userTexts(test.root)).toEqual(["refactor the worker module"]);
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
    const [item] = await test.items();
    await test.harness.waitForTask(item!.taskId, context);
    await test.root.waitForIdle(context);

    const texts = await userTexts(test.root);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(
      /^\[Effort assessment: effort sustained \(92%\), scope expanding \(80%\)/,
    );
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
    await test.harness.waitForTask((await test.items())[0]!.taskId, context);

    test.classifier.answer = () => assessed("sustained", 0.55, "expanding", 0.6);
    await test.send("maybe big");
    await test.harness.waitForTask((await test.items())[1]!.taskId, context);
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
    const workers = await test.harness.snapshot(WorkersDoc, test.root.id, context);
    await test.harness.waitForTask(workers!.deliveries.at(-1)!.taskId, context);
    expect(
      (await test.harness.snapshot(WorkersDoc, test.root.id, context))?.deliveries,
    ).toHaveLength(200);
    expect((await test.harness.snapshot(WorkersDoc, test.root.id, context))?.started).toBe(201);
    pending.resolve(assessed("sustained", 0.95, "expanding", 0.95));
    await test.harness.waitForTask((await test.items())[0]!.taskId, context);
    expect((await test.items())[0]?.escalated).toBe(false);
    expect(
      (await userTexts(test.root)).filter((text) => text.startsWith(ESCALATION_PREFIX)),
    ).toEqual([]);
    expect(test.reports).toEqual([]);
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
    await test.harness.waitForTask((await test.items())[0]!.taskId, context);
    expect((await test.items())[0]?.result).toEqual({
      status: "failed",
      message: "401 from provider",
    });
    await test.harness.close(context);
  });
});
