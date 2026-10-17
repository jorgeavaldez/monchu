import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Conversation, Harness, JsonObject } from "@earendil-works/pi-durable";
import assert from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobs, JobsDoc, nextSlot, parseCron, type JobEvent } from "../src/core/jobs.ts";
import { workerNotice } from "../src/api/notices.ts";
import { WorkersDoc } from "../src/core/agents/workers.ts";
import {
  allEntries,
  callTools,
  toolResults,
  cleanup,
  context,
  conversationOf,
  fauxRole,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const local = (text: string) => new Date(text).getTime();

describe("cron", () => {
  it("finds the next local slot for steps, ranges, lists and weekdays", () => {
    const at = local("2026-10-16T09:58:30");
    expect(nextSlot(parseCron("*/15 * * * *"), at)).toBe(local("2026-10-16T10:00:00"));
    expect(nextSlot(parseCron("58 9 * * 1-5"), at)).toBe(local("2026-10-19T09:58:00"));
    expect(nextSlot(parseCron("0 8,20 * * *"), at)).toBe(local("2026-10-16T20:00:00"));
    expect(nextSlot(parseCron("@monthly"), at)).toBe(local("2026-11-01T00:00:00"));
    // Day of month or day of week, as cron reads both.
    expect(nextSlot(parseCron("0 0 20 * 0"), at)).toBe(local("2026-10-18T00:00:00"));
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* * *")).toThrow(/five fields/);
    expect(() => nextSlot(parseCron("0 0 30 2 *"), at)).toThrow(/no upcoming slot/);
  });

  it("skips a slot that a DST gap removes", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(
        new Date(nextSlot(parseCron("30 2 * * *"), local("2026-03-08T00:00:00"))).getDate(),
      ).toBe(9);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

/** Never during a test: only the baseline and run_now run a command job. */
const NEVER = "0 0 1 1 *";

const FRONT_CALLS: Record<string, { tool: string; args: JsonObject }> = {
  watch: {
    tool: "job",
    args: {
      action: "create",
      name: "pr",
      type: "command",
      schedule: NEVER,
      command: "cat state.txt",
      prompt: "check the PR",
    },
  },
  daily: {
    tool: "job",
    args: {
      action: "create",
      name: "brief",
      type: "agent",
      schedule: "0 9 * * *",
      prompt: "write the brief",
      model: "faux/faux-1",
      thinking: "off",
    },
  },
  "poll pr": { tool: "job", args: { action: "run_now", name: "pr" } },
  "pause pr": { tool: "job", args: { action: "pause", name: "pr" } },
  "resume pr": { tool: "job", args: { action: "resume", name: "pr" } },
  "delete pr": { tool: "job", args: { action: "delete", name: "pr" } },
  "start w": { tool: "start_worker", args: { name: "w", task: "make watch" } },
  "make watch": {
    tool: "job",
    args: {
      action: "create",
      name: "mine",
      type: "command",
      schedule: NEVER,
      command: "cat state.txt",
      prompt: "mine changed",
    },
  },
  "poll mine": { tool: "job", args: { action: "run_now", name: "mine" } },
  "agent for w": {
    tool: "job",
    args: {
      action: "create",
      name: "nudge",
      type: "agent",
      schedule: "@daily",
      prompt: "nudge",
      worker: "w",
      thinking: "off",
    },
  },
  "run brief": { tool: "job", args: { action: "run_now", name: "brief" } },
  list: { tool: "job", args: { action: "list" } },
  build: {
    tool: "job",
    args: {
      action: "create",
      name: "build",
      type: "bg",
      command: "echo compiling; sleep 1; echo built; exit 3",
      prompt: "see how the build went",
    },
  },
  long: {
    tool: "job",
    args: {
      action: "create",
      name: "long",
      type: "bg",
      command: "echo line1; echo line2; sleep 30 & echo $! > child.pid; wait",
    },
  },
  "tail long": { tool: "job", args: { action: "output", name: "long", lines: 1 } },
  "kill long": { tool: "job", args: { action: "kill", name: "long" } },
  "delete long": { tool: "job", args: { action: "delete", name: "long" } },
};

async function withJobs() {
  const value = await setup();
  value.registry.install(createJobs(() => fauxRole, value.directory));
  await writeFile(join(value.directory, "state.txt"), "pending\n");
  /** What a job's worker answers; the front's requests follow `FRONT_CALLS`. */
  let answer = "ok";
  const jobMessages: string[] = [];
  const front = callTools(FRONT_CALLS);
  route(value.faux, (request) => {
    const text = textOf(lastMessage(request.messages));
    if (text.startsWith("[Job ")) {
      jobMessages.push(text);
      return fauxAssistantMessage(answer);
    }
    return front(request);
  });
  return {
    ...value,
    jobMessages,
    answer: (text: string) => {
      answer = text;
    },
  };
}

async function send(root: Conversation, message: string) {
  await (await root.submit({ type: "input", content: message }, context)).wait(context);
}

async function events(harness: Harness): Promise<readonly JobEvent[]> {
  return (await harness.snapshot(JobsDoc, context))?.events ?? [];
}

async function waitForEvent(harness: Harness, count: number) {
  await waitFor(async () => (await events(harness)).length >= count);
  return events(harness);
}

/** Worker reports the front received. */
async function reports(root: Conversation) {
  return (await allEntries(root)).flatMap((entry) => {
    const notice = workerNotice(entry);
    return notice === undefined ? [] : [notice];
  });
}

describe("jobs", () => {
  it("watches a command, wakes a fresh worker only on change, and tells the front only what needs the user", async () => {
    const value = await withJobs();
    const { harness, root } = await open(value);
    await send(root, "watch");
    // The first poll takes a baseline and wakes no one.
    expect(await waitForEvent(harness, 2)).toMatchObject([
      { job: "pr", kind: "created" },
      { job: "pr", kind: "fired", text: "baseline taken" },
    ]);
    expect((await harness.snapshot(WorkersDoc, root.id, context))?.workers ?? []).toEqual([]);

    // An unchanged poll wakes no model.
    await send(root, "poll pr");
    await waitFor(async () => (await harness.snapshot(JobsDoc, context))?.jobs[0]?.runs === 2);
    expect(await events(harness)).toHaveLength(2);
    expect(value.jobMessages).toEqual([]);

    // A change wakes the job's own worker; its plain answer stays out of the front.
    await writeFile(join(value.directory, "state.txt"), "approved\n");
    await send(root, "poll pr");
    const changed = await waitForEvent(harness, 3);
    expect(changed[2]).toMatchObject({ kind: "changed", worker: "job-pr" });
    await waitFor(() => value.jobMessages.length === 1);
    expect(value.jobMessages[0]).toContain("check the PR");
    expect(value.jobMessages[0]).toContain("approved");
    const worker = await conversationOf(
      harness,
      (await harness.snapshot(WorkersDoc, root.id, context))?.workers[0]?.conversationId ?? root.id,
    );
    await worker.waitForIdle(context);
    await root.waitForIdle(context);
    expect(await reports(root)).toEqual([]);

    // An answer that needs the user reaches the front.
    value.answer("NEEDS USER: review requested");
    await writeFile(join(value.directory, "state.txt"), "changes requested\n");
    await send(root, "poll pr");
    await waitFor(async () => (await reports(root)).length === 1);
    expect((await reports(root))[0]).toMatchObject({ name: "job-pr", status: "completed" });
    await harness.close(context);
  });

  it("keeps a job across restart, and pauses, resumes and deletes it", async () => {
    const value = await withJobs();
    let { harness, root } = await open(value);
    await send(root, "watch");
    await waitForEvent(harness, 2);
    await harness.close(context);

    ({ harness, root } = await open(value));
    await writeFile(join(value.directory, "state.txt"), "merged\n");
    await send(root, "poll pr");
    expect((await waitForEvent(harness, 3))[2]).toMatchObject({ kind: "changed" });

    await send(root, "pause pr");
    const paused = (await harness.snapshot(JobsDoc, context))?.jobs[0];
    assert(paused !== undefined);
    expect(paused.status).toBe("paused");
    await harness.waitForTask(paused.taskId, context);
    await send(root, "resume pr");
    const resumed = (await harness.snapshot(JobsDoc, context))?.jobs[0];
    assert(resumed !== undefined);
    expect(resumed.status).toBe("active");
    expect(resumed.taskId).not.toBe(paused.taskId);
    await send(root, "delete pr");
    await harness.waitForTask(resumed.taskId, context);
    expect((await harness.snapshot(JobsDoc, context))?.jobs).toEqual([]);
    expect((await events(harness)).map((event) => event.kind)).toEqual([
      "created",
      "fired",
      "changed",
      "paused",
      "resumed",
      "deleted",
    ]);
    await harness.close(context);
  });

  it("schedules a cron job that waits for its slot and runs on demand", async () => {
    const value = await withJobs();
    const { harness, root } = await open(value);
    await send(root, "daily");
    const job = (await harness.snapshot(JobsDoc, context))?.jobs[0];
    await waitFor(
      async () => (await harness.snapshot(JobsDoc, context))?.jobs[0]?.nextAt !== undefined,
    );
    expect(
      new Date((await harness.snapshot(JobsDoc, context))?.jobs[0]?.nextAt ?? 0).getHours(),
    ).toBe(9);
    expect(job).toMatchObject({
      worker: { parentId: root.id, name: "job-brief" },
      role: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
    });
    await send(root, "run brief");
    expect((await waitForEvent(harness, 2))[1]).toMatchObject({
      kind: "fired",
      text: "ran now",
      worker: "job-brief",
    });
    await waitFor(() => value.jobMessages.some((text) => text.includes("write the brief")));
    await harness.close(context);
  });

  it("lets a worker create a job it owns, and wakes that worker", async () => {
    const value = await withJobs();
    const { harness, root } = await open(value);
    await send(root, "start w");
    await waitForEvent(harness, 2);
    expect((await harness.snapshot(JobsDoc, context))?.jobs[0]).toMatchObject({
      name: "mine",
      createdBy: "w",
      worker: { parentId: root.id, name: "w" },
    });
    await writeFile(join(value.directory, "state.txt"), "done\n");
    await send(root, "poll mine");
    expect((await waitForEvent(harness, 3))[2]).toMatchObject({ kind: "changed", worker: "w" });
    await waitFor(() => value.jobMessages.some((text) => text.includes("mine changed")));
    const workers = (await harness.snapshot(WorkersDoc, root.id, context))?.workers ?? [];
    expect(workers.map((worker) => worker.name)).toEqual(["w"]);
    // An existing worker keeps its model for life, so a job naming it can't pick one.
    await send(root, "agent for w");
    expect(textOf((await toolResults(root)).at(-1))).toContain("keeps for life");
    await send(root, "list");
    expect(textOf((await toolResults(root)).at(-1))).toMatch(/^- mine \(active\) command /);
    await harness.close(context);
  });
});

/** Whether a process with this pid still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid the `long` process wrote, once it has. */
async function childPid(directory: string): Promise<number> {
  const file = join(directory, "child.pid");
  await waitFor(async () => existsSync(file) && (await readFile(file, "utf8")).trim() !== "");
  return Number((await readFile(file, "utf8")).trim());
}

describe("process jobs", () => {
  it("starts a command in the background and pings its worker once, with code and output, when it exits", async () => {
    const value = await withJobs();
    const { harness, root } = await open(value);
    await send(root, "build");
    // The tool returned while the command still runs.
    const started = (await harness.snapshot(JobsDoc, context))?.jobs[0];
    expect(started).toMatchObject({ type: "bg", status: "active" });
    expect(started?.ended).toBeUndefined();
    expect((await events(harness))[0]).toMatchObject({ kind: "started" });
    const ended = await waitForEvent(harness, 2);
    expect(ended[1]).toMatchObject({ kind: "exited", worker: "job-build" });
    expect(ended[1]?.text).toMatch(/^exited 3 after/);
    await waitFor(() => value.jobMessages.length === 1);
    expect(value.jobMessages[0]).toContain("bg exited 3");
    expect(value.jobMessages[0]).toContain("see how the build went");
    expect(value.jobMessages[0]).toMatch(/compiling\nbuilt/);
    const job = (await harness.snapshot(JobsDoc, context))?.jobs[0];
    expect(job).toMatchObject({ status: "done", ended: { reason: "exited", code: 3 } });
    expect(await readFile(job?.log ?? "", "utf8")).toBe("compiling\nbuilt\n");
    await harness.close(context);
  });

  it("shows a running process's output, kills it on request, and deletes it with its log", async () => {
    const value = await withJobs();
    const { harness, root } = await open(value);
    await send(root, "long");
    const pid = await childPid(value.directory);
    await send(root, "tail long");
    expect(textOf((await toolResults(root)).at(-1))).toMatch(/running .*\nline2$/);
    await send(root, "kill long");
    expect((await waitForEvent(harness, 2))[1]).toMatchObject({
      kind: "killed",
      worker: "job-long",
    });
    // Git Bash reports its own pids, which Node cannot signal on Windows.
    if (process.platform !== "win32") await waitFor(() => !alive(pid));
    await waitFor(() => value.jobMessages.some((text) => text.includes("bg killed")));
    const log = (await harness.snapshot(JobsDoc, context))?.jobs[0]?.log ?? "";
    await send(root, "delete long");
    expect((await harness.snapshot(JobsDoc, context))?.jobs).toEqual([]);
    expect(existsSync(log)).toBe(false);
    await harness.close(context);
  });

  it("kills a running process when Monchu closes, and reports it interrupted once after reopening", async () => {
    const value = await withJobs();
    let { harness, root } = await open(value);
    await send(root, "long");
    const pid = await childPid(value.directory);
    await harness.close(context);
    // Git Bash reports its own pids, which Node cannot signal on Windows.
    if (process.platform !== "win32") await waitFor(() => !alive(pid));

    ({ harness, root } = await open(value));
    expect((await waitForEvent(harness, 2))[1]).toMatchObject({
      kind: "interrupted",
      worker: "job-long",
    });
    await waitFor(() => value.jobMessages.length === 1);
    expect(value.jobMessages[0]).toContain("bg interrupted");
    expect(value.jobMessages[0]).toContain("line2");
    await root.waitForIdle(context);
    await harness.close(context);

    // Another restart neither starts it again nor pings twice.
    ({ harness, root } = await open(value));
    await harness.waitForIdle(context);
    expect((await events(harness)).map((event) => event.kind)).toEqual(["started", "interrupted"]);
    expect((await harness.snapshot(JobsDoc, context))?.jobs[0]?.status).toBe("done");
    await harness.close(context);
  });
});
