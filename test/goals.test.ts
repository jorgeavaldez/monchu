import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  type JsonObject,
  LiveDoc,
  ToolResultEntry,
  ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Goals, GoalsDoc } from "../src/goals.ts";
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

type Calls = Record<string, { tool: string; args: JsonObject }>;

/**
 * The front calls the tool scripted for each message, then answers. Every request's `goals` section values (from the
 * system messages it carries, in order) are recorded.
 */
async function withGoals(calls: Calls) {
  const value = await setup();
  value.registry.install(Goals);
  const sections: string[][] = [];
  route(value.faux, (request) => {
    sections.push(
      request.messages.flatMap((message: Message) =>
        message.role === "system" && typeof message.sections?.goals === "string"
          ? [message.sections.goals]
          : [],
      ),
    );
    const last = lastMessage(request.messages);
    const call = last?.role === "user" ? calls[textOf(last)] : undefined;
    if (call !== undefined)
      return fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText("ok")]);
  });
  return { ...value, sections };
}

async function send(root: Awaited<ReturnType<typeof open>>["root"], message: string) {
  await (await root.submit({ type: "input", content: message }, context)).wait(context);
}

async function toolResults(root: Awaited<ReturnType<typeof open>>["root"]) {
  return (await allEntries(root)).flatMap((entry) =>
    ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult"
      ? [{ text: textOf(entry.model[0]), isError: entry.model[0].isError }]
      : [],
  );
}

const create = {
  id: "phone-quit",
  title: "Fix /quit hanging on the phone",
  owner: "jorge",
  next: "reproduce with a lingering handle",
};

describe("goals", () => {
  it("creates and patches by id, rejects invalid input, and bounds closed goals", async () => {
    const test = await withGoals({
      create: { tool: "update_goal", args: create },
      patch: {
        tool: "update_goal",
        args: {
          id: "phone-quit",
          status: "waiting",
          project: "/home/jorge/proj/monchu",
          workers: ["reader"],
          next: "Jorge rechecks on the phone",
        },
      },
      same: { tool: "update_goal", args: { id: "phone-quit", status: "waiting" } },
      clear: { tool: "update_goal", args: { id: "phone-quit", project: "" } },
      "no title": {
        tool: "update_goal",
        args: { id: "other", owner: "monchu", next: "something" },
      },
      "bad status": { tool: "update_goal", args: { id: "phone-quit", status: "later" } },
      "bad id": { tool: "update_goal", args: { ...create, id: "Phone Quit" } },
      "extra field": { tool: "update_goal", args: { ...create, priority: "high" } },
      "blank next": { tool: "update_goal", args: { id: "phone-quit", next: "   " } },
      close: {
        tool: "codemode",
        args: {
          code: `
            for (let index = 0; index < 25; index++) {
              await tools.update_goal({ id: "closed-" + index, title: "t" + index, owner: "monchu", next: "n" });
              await tools.update_goal({ id: "closed-" + index, status: index % 2 ? "done" : "dropped" });
            }`,
        },
      },
      reopen: { tool: "update_goal", args: { id: "closed-5", status: "active" } },
      list: { tool: "list_goals", args: {} },
    });
    const { harness, root } = await open(test);
    const goals = async () => (await harness.snapshot(GoalsDoc, root.id, context))?.goals ?? [];

    await send(root, "create");
    expect(await goals()).toMatchObject([
      { ...create, status: "active", workers: [], updatedAt: expect.any(Number) },
    ]);
    expect((await goals())[0]).not.toHaveProperty("project");

    await send(root, "patch");
    await send(root, "same");
    await send(root, "clear");
    for (const message of ["no title", "bad status", "bad id", "extra field", "blank next"])
      await send(root, message);
    expect(await goals()).toEqual([
      {
        ...create,
        status: "waiting",
        workers: ["reader"],
        next: "Jorge rechecks on the phone",
        updatedAt: expect.any(Number),
      },
    ]);
    const results = await toolResults(root);
    expect(results.map((result) => [result.text.split("\n", 1)[0], result.isError])).toEqual([
      ["Changed: created", false],
      ["Changed: status, next, project, workers", false],
      ["Unchanged", false],
      ["Changed: project", false],
      ...Array.from({ length: 5 }, () => ["<harness>", true]),
    ]);
    expect(results.slice(4).map((result) => result.text.split("\n")[1])).toEqual([
      "[error] No goal other; creating one needs title, owner, and next",
      ...Array.from({ length: 4 }, () => '[error] Validation failed for tool "update_goal":'),
    ]);
    expect(results.slice(5).map((result) => result.text.split("\n")[2])).toEqual([
      "  - status: must be equal to one of the allowed values",
      '  - id: must match pattern "^[a-z0-9][a-z0-9-]{0,47}$"',
      "  - priority: schema is false",
      '  - next: must match pattern "\\S"',
    ]);

    // Open goals are always kept; only the 20 newest closed ones are.
    await send(root, "close");
    let stored = await goals();
    expect(stored.map((goal) => goal.id)).toEqual([
      "phone-quit",
      ...Array.from({ length: 20 }, (_, index) => `closed-${index + 5}`),
    ]);
    await send(root, "reopen");
    await send(root, "list");
    stored = await goals();
    expect(stored.filter((goal) => goal.status === "active").map((goal) => goal.id)).toEqual([
      "closed-5",
    ]);
    expect(stored).toHaveLength(21);
    const list = (await toolResults(root)).at(-1)!;
    expect(list.text).toContain("- [closed-24] t24 (dropped, owner monchu)");
    expect(list.text).toContain("- [phone-quit] Fix /quit hanging on the phone (waiting");
    await harness.close(context);
  });

  it("sends the section with each change only, and restores it after /new and a reopen", async () => {
    const test = await withGoals({
      create: { tool: "update_goal", args: { ...create, workers: ["reader"] } },
      same: { tool: "update_goal", args: { id: "phone-quit", owner: "jorge" } },
    });
    let { harness, root } = await open(test);
    const section =
      "<goals>\n- [phone-quit] Fix /quit hanging on the phone (active, owner jorge)\n  workers: reader\n  next: reproduce with a lingering handle\n</goals>";

    await send(root, "create");
    await send(root, "hello");
    await send(root, "same");
    // The baseline, then one update after the tool result; nothing more while the goals stay the same.
    expect(test.sections).toEqual([
      ["<goals>\nNo open goals.\n</goals>"],
      ["<goals>\nNo open goals.\n</goals>", section],
      ["<goals>\nNo open goals.\n</goals>", section],
      ["<goals>\nNo open goals.\n</goals>", section],
      ["<goals>\nNo open goals.\n</goals>", section],
    ]);

    await root.reset(undefined, context);
    await send(root, "after reset");
    expect(test.sections.at(-1)).toEqual([section]);

    // Reopened from the stored document: the shown section still matches, so nothing is resent.
    await harness.close(context);
    ({ harness, root } = await open(test));
    await send(root, "after reopen");
    expect(test.sections.at(-1)).toEqual([section]);
    await harness.close(context);
  });

  it("never replays an older update over a newer one in the same round", async () => {
    const value = await setup();
    value.registry.install(Goals);
    let pause = true;
    let paused = false;
    // Interrupt the first call after its commit, before its result settles.
    value.registry.install(
      defineExtension({
        name: "test.interrupt",
        hooks: [
          hook(ToolTask, {
            afterTool: async (call, result, _api, context) => {
              if (!pause || call.arguments.next !== "older") return undefined;
              paused = true;
              return awaitWithContext(new Promise<never>(() => {}), context);
            },
          }),
        ],
      }),
    );
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      const text = last?.role === "user" ? textOf(last) : "";
      if (text === "create")
        return fauxAssistantMessage([fauxToolCall("update_goal", create)], {
          stopReason: "toolUse",
        });
      if (text === "patch")
        return fauxAssistantMessage(
          [
            fauxToolCall("update_goal", { id: create.id, next: "older" }),
            fauxToolCall("update_goal", { id: create.id, next: "newer" }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("ok")]);
    });
    let { harness, root } = await open(value);
    const next = async () => (await harness.snapshot(GoalsDoc, root.id, context))?.goals[0]?.next;
    await send(root, "create");
    await root.submit({ type: "input", content: "patch" }, context);
    await waitFor(() => paused);
    expect(await next()).toBe("older");
    // The second call has not started: the round is sequential.
    const slots = (await harness.snapshot(LiveDoc, root.id, context))?.tools ?? [];
    expect(slots.map((slot) => slot.taskId !== undefined)).toEqual([true, false]);

    await harness.close(context);
    pause = false;
    ({ harness, root } = await open(value));
    await root.waitForIdle(context);
    expect(await next()).toBe("newer");
    await harness.close(context);
  });
});
