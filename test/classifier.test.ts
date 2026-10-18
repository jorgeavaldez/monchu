import {
  type ClassifierResult,
  createProvider,
  fauxAssistantMessage,
  type Message,
  type MutableModels,
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
import { systemNoticeSummary } from "../src/api/notices.ts";
import { defaultConfig, type WorkerProfile } from "../src/core/config.ts";
import { ClientNoticesDoc } from "../src/core/plugin-shapes.ts";
import { createPluginSections, Plugins } from "../src/core/plugins.ts";
import { AssessmentsDoc, RoutingDoc } from "../src/plugins/clef/index.ts";
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
  sectionTexts,
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

/** Clef's advice as the request carries it: the newest text of its prompt section. */
function adviceOf(messages: readonly Message[]): string | undefined {
  const text = sectionTexts(messages, "plugins").findLast((section) =>
    section.includes("<clef_advice>"),
  );
  return /<clef_advice>\n([\s\S]*?)\n<\/clef_advice>/.exec(text ?? "")?.[1];
}

/** Whether a user entry's text is Clef's escalation. */
const escalation = (text: string) =>
  systemNoticeSummary(text)?.startsWith("routing advice (Clef): ") === true;

/** The bundled Clef plugin on a scripted classifier, loaded as Monchu loads it, with the front's input path. */
async function withAssessment(
  extensions: readonly Extension[] = [],
  waitMs = 2000,
  profiles: Record<string, WorkerProfile> = {},
  provider = "clef-test",
  before: (models: MutableModels) => void = () => {},
) {
  const value = await setup();
  for (const extension of extensions) value.registry.install(extension);
  const classifier = scriptedClassifier(value.models);
  before(value.models);
  const plugins = new Plugins({
    home: value.directory,
    report: (warning) => value.reports.push(warning),
    vault: value.vault,
    models: value.models,
    saveSettings: async () => {},
  });
  const build = (
    await plugins.load({
      ...defaultConfig(),
      profiles,
      plugins: { clef: { provider, modelId: classifierModel.id, waitMs } },
    })
  ).use({ tools: new Set(), tasks: new Set() });
  plugins.settle(build);
  for (const extension of [...build.bundled, createPluginSections(build.sections)])
    value.registry.install(extension);
  const opened = await open(value);
  plugins.bind(opened.harness);
  const front = build.front;
  /** As `Front.submit`: plugins see the text, then it is admitted, then their commits run. */
  const submit = async (message: string, requestId: string, whenBusy: "steer" | "followUp") => {
    const seen = await front.input(
      {
        text: message,
        source: "interactive",
        streamingBehavior: whenBusy,
        messages: async () => (await opened.root.context(context)).messages,
      },
      opened.root.id,
    );
    const submission = await opened.root.submit(
      { type: "input", content: message, requestId, whenBusy },
      context,
    );
    for (const run of seen.admitted)
      await opened.root.commit((tx) => run(tx, submission.id), context);
    return submission;
  };
  const send = async (message: string) =>
    (await submit(message, `test:${message}`, "followUp")).wait(context);
  const items = async () =>
    (await opened.harness.snapshot(AssessmentsDoc, opened.root.id, context))?.items ?? [];
  /** Wait for the assessment task of the input at `index`, which must exist. */
  const settle = async (index: number) => {
    const item = (await items())[index];
    if (item === undefined) throw new Error(`No assessment at ${index}`);
    await opened.harness.waitForTask(item.taskId, context);
  };
  const notices = async () =>
    (await opened.harness.snapshot(ClientNoticesDoc, opened.root.id, context))?.items.map(
      (item) => item.text,
    ) ?? [];
  return { ...value, ...opened, plugins, front, classifier, submit, send, items, settle, notices };
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
    const first = await test.submit("hold", "hold", "steer");
    await started.promise;
    await test.submit("steer note", "steer", "steer");
    await test.submit("later note", "later", "followUp");
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
      seen.push(adviceOf(request.messages) ?? "none");
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
      const last = adviceOf(request.messages);
      if (last !== undefined) advice.push(last);
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

  it("keeps its advice where it first joined, so each round and the next message extend the same prefix", async () => {
    const test = await withAssessment();
    test.classifier.answer = () => routed("front", 0.9);
    const requests: Message[][] = [];
    route(test.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return requests.length === 1
        ? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText("ok")]);
    });
    await test.send("what's up");
    await test.root.waitForIdle(context);
    // Unsure, so no escalation adds a request.
    test.classifier.answer = () => routed("worker", 0.6);
    await test.send("now fix it");
    await test.root.waitForIdle(context);
    expect(requests).toHaveLength(3);
    expect(adviceOf(requests[0] ?? [])).toContain("you can answer it yourself (90%)");
    // A prompt-cached provider (the Claude Code bridge most of all) sees only appended history.
    const strip = (messages: readonly Message[]) =>
      messages.map((message) => JSON.stringify({ ...message, timestamp: 0 }));
    for (const [earlier, later] of [
      [requests[0], requests[1]],
      [requests[1], requests[2]],
    ] as const)
      expect(strip(later ?? []).slice(0, (earlier ?? []).length)).toEqual(strip(earlier ?? []));
    expect(adviceOf(requests[2] ?? [])).toContain("unsure whether it needs a worker");
    await test.harness.close(context);
  });

  it("nudges once when the front works itself on input that needs a worker", async () => {
    const test = await withAssessment();
    test.classifier.answer = () => routed("worker", 0.9);
    const results: string[] = [];
    route(test.faux, (request) => {
      const last = lastMessage(request.messages);
      if (last?.role === "toolResult") results.push(textOf(last));
      if (escalation(textOf(last))) return fauxAssistantMessage([fauxText("already handled")]);
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
      if (escalation(text))
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
    // A notice from Monchu itself: clients show its summary, and Esc never puts it back in the editor.
    expect(systemNoticeSummary(texts[1] ?? "")).toBe(
      "routing advice (Clef): needs a worker (92%), several lines of work (80%)",
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

    test.classifier.answer = () => routed("worker", 0.95);
    await test.send("big and delegated");
    await waitFor(async () => (await test.items())[0]?.result != null);
    await test.settle(0);

    test.classifier.answer = () => routed("worker", 0.6);
    await test.send("maybe big");
    await test.settle(1);
    await test.root.waitForIdle(context);

    expect((await test.items()).map((item) => item.escalated)).toEqual([false, false]);
    expect((await userTexts(test.root)).filter((text) => escalation(text))).toEqual([]);
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
    expect((await userTexts(test.root)).filter((text) => escalation(text))).toEqual([]);
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
      advice.push(`${text}: ${adviceOf(request.messages) ?? ""}`);
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const hold = await test.submit("hold", "hold", "followUp");
    await waitFor(async () => (await test.items())[0]?.result != null);
    for (const message of ["rewrite everything", "also rewrite everything"])
      await test.submit(message, message, "followUp");
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
      await test.front.change(
        { submission: first.id, text: "fix the typo", messages: [] },
        tx,
        test.root.id,
      );
      tx.settleSubmission(second.id, { status: "unanswered", reason: "aborted" });
      inbox.items.splice(1, 1);
      await test.front.change(
        { submission: second.id, text: undefined, messages: [] },
        tx,
        test.root.id,
      );
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

  it("shows a repeated failure once until Clef answers again, and keeps its error out of the front's advice", async () => {
    const test = await withAssessment();
    const advice: string[] = [];
    route(test.faux, (request) => {
      const last = adviceOf(request.messages);
      if (last !== undefined) advice.push(last);
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const limited = (body: string) => ({
      ...routed("front", 1),
      stopReason: "error" as const,
      errorMessage: `Cloudflare Workers AI error (429): ${body}`,
    });
    for (const [index, answer] of [
      limited("out of credits"),
      limited("still out"),
      routed("worker", 0.9),
      limited("out again"),
    ].entries()) {
      test.classifier.answer = () => answer;
      await test.send(`message ${index}`);
      await test.settle(index);
    }
    // Clients get each line once; a repeated failure isn't sent again until Clef answers.
    await waitFor(async () => (await test.notices()).length === 3);
    expect(await test.notices()).toEqual([
      "clef · unavailable (Cloudflare Workers AI error (429): out of credits) · /clef off pauses it",
      "clef · needs a worker (90%)",
      "clef · unavailable (Cloudflare Workers AI error (429): out again) · /clef off pauses it",
    ]);
    expect(advice[0]).toBe(
      "Routing helper unavailable for this message. Route by your own judgment.",
    );
    await test.harness.close(context);
  });

  it("assesses nothing while the user has it paused, and the front doesn't wait for it", async () => {
    const test = await withAssessment([], 60_000);
    await test.root.commit(async (tx) => {
      (await tx.doc(RoutingDoc, test.root.id)).paused = true;
    }, context);
    route(test.faux, () => fauxAssistantMessage([fauxText("ok")]));
    await test.send("hello");
    expect(await test.items()).toEqual([]);
    expect(test.classifier.requests).toEqual([]);
    await test.root.commit(async (tx) => {
      (await tx.doc(RoutingDoc, test.root.id)).paused = false;
    }, context);
    await test.send("again");
    expect(await test.items()).toHaveLength(1);
    await test.harness.close(context);
  });

  it("stays off without its provider's credentials and sends input to the front unassessed", async () => {
    const requests: unknown[] = [];
    const test = await withAssessment([], 2000, {}, "clef-off", (models) =>
      models.setProvider(
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
      ),
    );
    route(test.faux, () => fauxAssistantMessage([fauxText("hi")]));
    await test.send("hello");
    expect(await userTexts(test.root)).toEqual(["hello"]);
    expect(await test.items()).toEqual([]);
    expect(requests).toEqual([]);
    await test.harness.close(context);
  });

  it("refuses an unknown classifier model with a clear warning, and never falls back", async () => {
    const test = await withAssessment([], 2000, {}, "nowhere");
    route(test.faux, () => fauxAssistantMessage([fauxText("hi")]));
    await test.send("hello");
    expect(await test.items()).toEqual([]);
    expect(test.classifier.requests).toEqual([]);
    expect(test.reports).toContainEqual(
      expect.stringMatching(
        /^Plugin clef: no classifier model nowhere\/clef-test, so Clef is off; classifier models: .*clef-test\/clef-test/,
      ),
    );
    await test.harness.close(context);
  });
});
