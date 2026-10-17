import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  type JsonObject,
  LiveDoc,
  ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Goals, GoalsDoc, formatOpenGoals } from "../src/core/agents/goals.ts";
import {
  callTools,
  cleanup,
  context,
  lastMessage,
  open,
  route,
  sectionTexts,
  setup,
  textOf,
  toolResults,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

async function withGoals(calls: Record<string, { tool: string; args: JsonObject }>) {
  const value = await setup();
  value.registry.install(Goals);
  const sections: string[][] = [];
  const respond = callTools(calls);
  route(value.faux, (request) => {
    sections.push(sectionTexts(request.messages, "goals"));
    return respond(request);
  });
  return { ...value, sections };
}

async function send(root: Awaited<ReturnType<typeof open>>["root"], message: string) {
  await (await root.submit({ type: "input", content: message }, context)).wait(context);
}

const create = {
  id: "monchu",
  title: "Keep Monchu moving",
  kind: "endeavor",
  project: "/projects/monchu",
  vault: "projects/monchu",
  workstream: "Memory and ongoing goals",
  next: "Implement the bounded memory tool",
};

describe("goals", () => {
  it("keeps stored line breaks indented under their field and the title on one line", () => {
    const goal = {
      ...create,
      title: "Keep\r\nMonchu moving",
      kind: "endeavor" as const,
      status: "active" as const,
      workers: [],
      next: "first\r\nsecond\nthird\rfourth",
      updatedAt: 0,
    };
    expect(formatOpenGoals([goal])).toBe(
      "- [monchu] Keep Monchu moving (active, endeavor)\n  project: /projects/monchu\n  vault: projects/monchu\n  workstream: Memory and ongoing goals\n  next: first\n    second\n    third\n    fourth",
    );
  });

  it("creates an ongoing endeavor, patches workstream and next, links workers, and closes it", async () => {
    const test = await withGoals({
      create: { tool: "update_goal", args: create },
      patch: {
        tool: "update_goal",
        args: {
          id: create.id,
          status: "waiting",
          workstream: "Phone checks",
          next: "User rechecks on the phone",
          workers: ["reader"],
        },
      },
      same: { tool: "update_goal", args: { id: create.id, status: "waiting" } },
      clear: { tool: "update_goal", args: { id: create.id, project: "", vault: "" } },
      "no title": {
        tool: "update_goal",
        args: { id: "other", kind: "commitment", workstream: "Follow up", next: "Check back" },
      },
      "no workstream": {
        tool: "update_goal",
        args: { id: "other", title: "Follow up", kind: "commitment", next: "Check back" },
      },
      "bad status": { tool: "update_goal", args: { id: create.id, status: "later" } },
      "bad kind": { tool: "update_goal", args: { id: create.id, kind: "request" } },
      "bad id": { tool: "update_goal", args: { ...create, id: "Not Valid" } },
      "extra field": { tool: "update_goal", args: { ...create, priority: "high" } },
      "blank next": { tool: "update_goal", args: { id: create.id, next: "   " } },
      "blank workstream": { tool: "update_goal", args: { id: create.id, workstream: "   " } },
      close: { tool: "update_goal", args: { id: create.id, status: "done" } },
      list: { tool: "list_goals", args: {} },
    });
    const { harness, root } = await open(test);
    try {
      const goals = async () => (await harness.snapshot(GoalsDoc, root.id, context))?.goals ?? [];
      await send(root, "create");
      const [created] = await goals();
      expect(typeof created?.updatedAt).toBe("number");
      expect(created).toEqual({
        ...create,
        status: "active",
        workers: [],
        updatedAt: created?.updatedAt,
      });
      expect(formatOpenGoals(await goals())).toContain("vault: projects/monchu");
      for (const message of [
        "patch",
        "same",
        "clear",
        "no title",
        "no workstream",
        "bad status",
        "bad kind",
        "bad id",
        "extra field",
        "blank next",
        "blank workstream",
      ])
        await send(root, message);
      const [patched] = await goals();
      expect(patched).toEqual({
        id: create.id,
        title: create.title,
        kind: "endeavor",
        status: "waiting",
        workstream: "Phone checks",
        next: "User rechecks on the phone",
        workers: ["reader"],
        updatedAt: patched?.updatedAt,
      });
      const results = await toolResults(root);
      expect(
        results.slice(0, 4).map((result) => [textOf(result).split("\n", 1)[0], result.isError]),
      ).toEqual([
        ["Changed: created", false],
        ["Changed: status, workstream, next, workers", false],
        ["Unchanged", false],
        ["Changed: project, vault", false],
      ]);
      expect(results.slice(4).every((result) => result.isError)).toBe(true);
      expect(textOf(results[4])).toContain("creating one needs title, kind, workstream, and next");
      expect(textOf(results[5])).toContain("creating one needs title, kind, workstream, and next");
      await send(root, "close");
      expect((await goals())[0]?.status).toBe("done");
      expect(formatOpenGoals(await goals())).toBe("No open goals.");
      await send(root, "list");
      const listed = textOf((await toolResults(root)).at(-1));
      expect(listed).toContain("- [monchu] Keep Monchu moving (done, endeavor)");
      expect(listed).toContain(
        "workstream: Phone checks\n  workers: reader\n  next: User rechecks on the phone",
      );
    } finally {
      await harness.close(context);
    }
  });

  it("keeps open endeavors and only the 20 newest closed commitments", async () => {
    const test = await withGoals({
      create: { tool: "update_goal", args: create },
      close: {
        tool: "codemode",
        args: {
          code: `
        for (let index = 0; index < 25; index++) {
          await tools.update_goal({ id: "closed-" + index, title: "t" + index, kind: "commitment", workstream: "Follow up", next: "n" });
          await tools.update_goal({ id: "closed-" + index, status: index % 2 ? "done" : "dropped" });
        }`,
        },
      },
      reopen: { tool: "update_goal", args: { id: "closed-5", status: "active" } },
      list: { tool: "list_goals", args: {} },
    });
    const { harness, root } = await open(test);
    try {
      for (const message of ["create", "close", "reopen", "list"]) await send(root, message);
      const goals = (await harness.snapshot(GoalsDoc, root.id, context))?.goals ?? [];
      expect(goals.map((goal) => goal.id)).toEqual([
        create.id,
        ...Array.from({ length: 20 }, (_, index) => `closed-${index + 5}`),
      ]);
      expect(goals.filter((goal) => goal.status === "active").map((goal) => goal.id)).toEqual([
        create.id,
        "closed-5",
      ]);
      expect(textOf((await toolResults(root)).at(-1))).toContain(
        "- [closed-24] t24 (dropped, commitment)",
      );
    } finally {
      await harness.close(context);
    }
  });

  it("sends the section only when changed and restores it after /new and a reopen", async () => {
    const test = await withGoals({
      create: { tool: "update_goal", args: { ...create, workers: ["reader"] } },
      same: { tool: "update_goal", args: { id: create.id, kind: "endeavor" } },
    });
    let { harness, root } = await open(test);
    try {
      await send(root, "create");
      const goals = (await harness.snapshot(GoalsDoc, root.id, context))?.goals ?? [];
      const section =
        "<goals>\n- [monchu] Keep Monchu moving (active, endeavor)\n  project: /projects/monchu\n  vault: projects/monchu\n  workstream: Memory and ongoing goals\n  workers: reader\n  next: Implement the bounded memory tool\n</goals>";
      // This is also the formatter used by /goals.
      expect(section).toBe(`<goals>\n${formatOpenGoals(goals)}\n</goals>`);
      await send(root, "hello");
      await send(root, "same");
      expect(test.sections).toEqual([
        ["<goals>\nNo open goals.\n</goals>"],
        ...Array.from({ length: 4 }, () => ["<goals>\nNo open goals.\n</goals>", section]),
      ]);
      await root.reset(undefined, context);
      await send(root, "after reset");
      expect(test.sections.at(-1)).toEqual([section]);
      await harness.close(context);
      ({ harness, root } = await open(test));
      await send(root, "after reopen");
      expect(test.sections.at(-1)).toEqual([section]);
    } finally {
      await harness.close(context);
    }
  });

  it("never replays an older update over a newer one in the same round", async () => {
    const value = await setup();
    value.registry.install(Goals);
    let pause = true;
    let paused = false;
    value.registry.install(
      defineExtension({
        name: "test.interrupt",
        hooks: [
          hook(ToolTask, {
            afterTool: async (call, _result, _api, context) => {
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
    try {
      const next = async () => (await harness.snapshot(GoalsDoc, root.id, context))?.goals[0]?.next;
      await send(root, "create");
      await root.submit({ type: "input", content: "patch" }, context);
      await waitFor(() => paused);
      expect(await next()).toBe("older");
      const slots = (await harness.snapshot(LiveDoc, root.id, context))?.tools ?? [];
      expect(slots.map((slot) => slot.taskId !== undefined)).toEqual([true, false]);
      await harness.close(context);
      pause = false;
      ({ harness, root } = await open(value));
      await root.waitForIdle(context);
      expect(await next()).toBe("newer");
    } finally {
      await harness.close(context);
    }
  });
});
