import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  LiveDoc,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { autoCompactCommand, ContextCap } from "../src/core/context-cap.ts";
import { createContext } from "../src/core/context.ts";
import { cleanup, context, lastMessage, open, route, setup, textOf, waitFor } from "./support.ts";

afterEach(cleanup);

describe("context cap", () => {
  it.each([
    [40, [], true],
    [undefined, [], false],
    [40, ["off"], false],
    [40, ["off", "on here"], true],
  ])(
    "with a cap of %s%% after /autocompact %j, an answer past it compacts at once: %s",
    async (percent, toggles, compacts) => {
      // A 200000-token window: its 40% is far below where Durable compacts on its own (about 150000).
      const value = await setup({ models: [{ id: "faux-1", contextWindow: 200_000 }] });
      route(value.faux, (request) => {
        const text = textOf(lastMessage(request.messages));
        return fauxAssistantMessage([
          fauxText(text.startsWith("ask") ? `answered ${text.slice(0, 5)}` : "the summary"),
        ]);
      });
      const { harness, root } = await open(value, { compaction: { keepRecentTokens: 10 } });
      const reports: unknown[] = [];
      const cap = new ContextCap(
        harness,
        value.models,
        () => percent,
        () => true,
        (error) => reports.push(error),
        context,
      );
      const stop = harness.subscribeCommits((publication) => cap.observe(publication));
      const command = autoCompactCommand(
        () => true,
        () => "40% of 1M windows",
      );
      const said: string[] = [];
      for (const toggle of toggles)
        await command.handler(toggle, {
          root: root.id,
          conversationId: root.id,
          caller: "person",
          ui: { notify: (line: string) => said.push(line), setStatus: () => {} },
          commit: (work) => harness.commit(work, context),
        });
      expect(said).toEqual(
        toggles.map((toggle) =>
          toggle === "off"
            ? "automatic compaction off everywhere · 40% of 1M windows"
            : "automatic compaction on here · 40% of 1M windows",
        ),
      );

      const first = await (
        await root.submit({ type: "input", content: "ask 1" }, context)
      ).wait(context);
      await root.waitForIdle(context);
      expect((await root.context(context)).head).toBeUndefined();
      const answer =
        first.status === "done" && first.type === "input"
          ? await harness.commit((tx) => tx.entry(AssistantEntry, first.answer), context)
          : undefined;
      const message = answer?.model?.[0];
      const used =
        message?.role === "assistant"
          ? message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
          : 0;
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThan(80_000);

      // Past 80000 tokens, at four characters a token.
      const filler = "y".repeat((80_000 - used + 2_000) * 4);
      await (
        await root.submit({ type: "input", content: `ask 2 ${filler}` }, context)
      ).wait(context);
      if (compacts) await waitFor(async () => (await root.context(context)).head !== undefined);
      else await root.waitForIdle(context);
      const { head, messages } = await root.context(context);
      expect(head?.kind).toBe(compacts ? "pi.compaction" : undefined);
      expect(messages.some((item) => textOf(item).includes("the summary"))).toBe(compacts);
      expect(messages.some((item) => textOf(item) === "ask 1")).toBe(!compacts);
      stop();
      expect(reports).toEqual([]);
      expect(value.reports).toEqual([]);
      await harness.close(context);
    },
  );

  it("never compacts into a running turn: it summarizes only while idle, and a run keeps one context", async () => {
    // The faux model reports each prompt token twice, as input and as a cache write: 220000 characters take this one
    // past 40% of the window (80000) and stay short of where Durable compacts on its own (about 150000).
    const value = await setup({ models: [{ id: "faux-1", contextWindow: 200_000 }] });
    // Monchu's compaction hook, which declines the cap's compaction once a run has started.
    value.registry.install(createContext(value.directory, {}).extension);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summarized!: () => void;
    const summary = new Promise<void>((resolve) => {
      summarized = resolve;
    });
    let harness!: Harness;
    let root!: Conversation;
    const rounds: string[][] = [];
    // Whether the conversation was running when each summary was asked for.
    const summaries: boolean[] = [];
    route(value.faux, async (request) => {
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "ask 3" || last?.role === "toolResult")
        rounds.push(request.messages.map((message) => textOf(message).slice(0, 5)));
      if (text.startsWith("ask 2")) await held;
      if (text === "ask 3") {
        // Time for a compaction started at the last answer to finish before this run's next round.
        await Promise.race([summary, new Promise((resolve) => setTimeout(resolve, 1000))]);
        return fauxAssistantMessage([fauxToolCall("worker_status", {})], { stopReason: "toolUse" });
      }
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("answered ask 3")]);
      if (text.startsWith("ask"))
        return fauxAssistantMessage([fauxText(`answered ${text.slice(0, 5)}`)]);
      summaries.push((await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined);
      summarized();
      return fauxAssistantMessage([fauxText("the summary")]);
    });
    ({ harness, root } = await open(value, { compaction: { keepRecentTokens: 10 } }));
    const cap = new ContextCap(
      harness,
      value.models,
      () => 40,
      () => true,
      (error) => value.reports.push(error),
      context,
    );
    const stop = harness.subscribeCommits((publication) => cap.observe(publication));
    await (await root.submit({ type: "input", content: "ask 1" }, context)).wait(context);
    const big = await root.submit(
      { type: "input", content: `ask 2 ${"y".repeat(55_000 * 4)}` },
      context,
    );
    await waitFor(
      async () => (await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined,
    );
    const queued = await root.submit(
      { type: "input", content: "ask 3", whenBusy: "followUp" },
      context,
    );
    release();
    expect((await big.wait(context)).status).toBe("done");
    expect((await queued.wait(context)).status).toBe("done");
    // Both rounds of the queued ask ran on one context: no summary was placed between them.
    expect(rounds).toHaveLength(2);
    expect(rounds.map((round) => round.includes("ask 1"))).toEqual(
      rounds.map(() => rounds[0]?.includes("ask 1")),
    );
    // Summarized only while idle, and compacted by the end.
    await waitFor(async () => (await root.context(context)).head !== undefined);
    expect((await root.context(context)).head?.kind).toBe("pi.compaction");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((running) => !running)).toBe(true);
    stop();
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
});
