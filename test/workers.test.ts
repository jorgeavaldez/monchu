import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerResultEntry, WorkersDoc } from "../src/workers.ts";
import {
  allEntries,
  cleanup,
  context,
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

describe("background workers", () => {
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
