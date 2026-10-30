import { withCancel, type Context } from "@earendil-works/chord/context";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { shortId } from "../api/ids.ts";
import { jobNoticeText } from "../api/notices.ts";
import { findRoot, RootsDoc } from "./agents/root-records.ts";
import { thinkingLevels, type ModelRole, type WorkerProfile } from "./config.ts";
import {
  chooseRole,
  messageWorker,
  parentOf,
  prepareDeliveries,
  reopenWorker,
  rootOf,
  startWorker,
  WorkersDoc,
} from "./agents/workers.ts";
import { commandSecrets } from "./secrets/tool.ts";
import type { Vault } from "./secrets/vault.ts";

/**
 * What a job is. `agent`: on a cron schedule, wake a worker with the job's prompt. `command`: on a cron schedule, run a
 * command with no model call, and wake the worker only when its output changes or it fails anew. `bg`: run a command
 * once in the background now, and wake the worker when it ends.
 */
type JobType = "agent" | "command" | "bg";

/** The worker a job wakes: by name under `parentId`; the job starts it, on `role`, if it does not exist then. */
type JobWorker = { parentId: ConversationId; name: string };

/** Who hears a job by its `notify`: a root's front, or a worker by name under `parentId`. */
type JobTarget = { kind: "front"; rootId: ConversationId } | ({ kind: "worker" } & JobWorker);

export type Job = {
  name: string;
  type: JobType;
  /** Five-field cron expression in the device's local time; `agent` and `command` jobs. */
  schedule?: string;
  /** `command`: run at each slot, safe to rerun. `bg`: run once. */
  command?: string;
  /** What the worker should do when the job wakes it; may be empty for `command` and `bg`. */
  prompt: string;
  cwd: string;
  rootId: ConversationId;
  worker: JobWorker;
  /** Opt-in: who hears the job, instead of its worker, whenever it would wake it. */
  notify?: JobTarget[];
  /** The model a worker the job starts runs on; an existing worker keeps its own model for life. */
  role?: ModelRole;
  /** The worker or `front` that created it. */
  createdBy: string;
  createdAt: number;
  /** The tool call that created it, so a replayed create returns it instead of failing. */
  callId?: string;
  /** `done` only for a `bg` job that ended. */
  status: "active" | "paused" | "done";
  /** The runner task; a runner whose ID this is not stops itself. */
  taskId: TaskId;
  /** Set by `run_now`; the runner clears it when it runs. */
  runNow?: true;
  nextAt?: number;
  lastRunAt?: number;
  runs: number;
  /** `command`: hash of the last output, and of the last failure reported, so only changes wake anyone. */
  cursor?: string;
  failure?: string;
  /** `bg`: the output log, the limit in minutes, a pending kill, and how it ended. */
  log?: string;
  timeout?: number;
  kill?: true;
  ended?: BgEnd;
};

/** How a `bg` job ended. `interrupted`: Monchu quit or restarted while it ran, which kills it. */
type BgEnd = {
  reason: "exited" | "killed" | "timed out" | "interrupted";
  /** The exit code; `null` when it did not exit by itself or never started. */
  code: number | null;
  at: number;
  /** Why it could not run, when it never started. */
  error?: string;
};

/** One entry of the job event stream clients follow. Ids only grow, so a client resumes after the last one it saw. */
export type JobEvent = {
  id: number;
  at: number;
  job: string;
  kind:
    | "created"
    | "fired"
    | "changed"
    | "failed"
    | "paused"
    | "resumed"
    | "deleted"
    | "started"
    | "exited"
    | "killed"
    | "interrupted";
  text: string;
  /** The worker the event woke, if any. */
  worker?: string;
  /** The job's root, so a client shows the event in that root. Absent on events from before roots: the first root's. */
  rootId?: ConversationId;
};

export type JobsState = { jobs: Job[]; events: JobEvent[]; nextEvent: number };

const EVENTS_KEPT = 200;

/** Every job and the recent event stream, one per store, so the front, workers and clients all see the same list. */
export const JobsDoc = defineDoc<JobsState>({
  kind: "monchu.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: [], events: [], nextEvent: 1 }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/**
 * After a worker was handed from `fromId` to `toId`, its jobs follow it: they wake it under its new parent, and every
 * job of the old root that now belongs to another root (its sub-workers' too) moves its events there. Runners stay on
 * the conversation that started them and find their job by name.
 */
export async function moveJobs(
  tx: Tx,
  fromId: ConversationId,
  name: string,
  toId: ConversationId,
): Promise<void> {
  const state = await tx.doc(JobsDoc);
  const fromRoot = await rootOf(tx, fromId);
  for (const job of state.jobs) {
    if (job.worker.parentId === fromId && job.worker.name === name) job.worker.parentId = toId;
    for (const target of job.notify ?? [])
      if (target.kind === "worker" && target.parentId === fromId && target.name === name)
        target.parentId = toId;
    if (job.rootId === fromRoot) job.rootId = await rootOf(tx, job.worker.parentId);
  }
}

function addEvent(
  state: JobsState,
  job: Pick<Job, "name" | "rootId">,
  event: Omit<JobEvent, "id" | "job" | "rootId">,
): void {
  state.events.push({ id: state.nextEvent++, job: job.name, rootId: job.rootId, ...event });
  if (state.events.length > EVENTS_KEPT) state.events.splice(0, state.events.length - EVENTS_KEPT);
}

// Cron: minute hour day-of-month month day-of-week, in local time.

type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

function cronField(text: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (match === null) throw new Error(`Invalid cron ${label}: ${part}`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;
    if (match[1] !== "*") {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }
    if (step < 1 || from < min || to > max || from > to)
      throw new Error(`Invalid cron ${label}: ${part} (allowed ${min}-${max})`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Parse a five-field cron expression or one of @hourly, @daily, @weekly, @monthly. */
export function parseCron(expression: string): Cron {
  const fields = (MACROS[expression.trim()] ?? expression).trim().split(/\s+/);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  if (fields.length !== 5) throw new Error(`Cron needs five fields: ${expression}`);
  const weekdays = cronField(weekday, 0, 7, "day of week");
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minute: cronField(minute, 0, 59, "minute"),
    hour: cronField(hour, 0, 23, "hour"),
    day: cronField(day, 1, 31, "day of month"),
    month: cronField(month, 1, 12, "month"),
    weekday: weekdays,
    anyDay: day === "*",
    anyWeekday: weekday === "*",
  };
}

/** The first slot strictly after `after`, in local time; DST gaps are skipped. */
export function nextSlot(cron: Cron, after: number): number {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  // Five years of days bounds expressions that never match, like February 30.
  for (let steps = 0; steps < 100_000; steps++) {
    const dayMatches =
      cron.anyDay && cron.anyWeekday
        ? true
        : cron.anyDay
          ? cron.weekday.has(date.getDay())
          : cron.anyWeekday
            ? cron.day.has(date.getDate())
            : cron.day.has(date.getDate()) || cron.weekday.has(date.getDay());
    if (!cron.month.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
    } else if (!dayMatches) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
    } else if (!cron.minute.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
    } else return date.getTime();
  }
  throw new Error("Cron expression has no upcoming slot");
}

/** A local-minute key, so a slot repeated by a DST fall-back still runs once. */
function slotKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Output a job keeps from one command run. */
const OUTPUT_KEPT = 8000;
const COMMAND_TIMEOUT_S = 300;

/** Finished `bg` jobs, and their logs, are kept this long. */
const ENDED_KEPT_MS = 24 * 60 * 60_000;

/**
 * Timers run on a monotonic clock, which stops while the device sleeps (a phone suspends for hours), so one timer armed
 * hours ahead fires that much late. Long waits sleep in steps of this, rechecking the wall clock after each.
 */
const CLOCK_STEP_MS = 60_000;

/** Sleep until the wall clock reaches `until`, at most one step late after the device wakes. */
async function sleepUntil(
  runtime: { now(): number; sleep(until: number, context: Context): Promise<void> },
  until: number,
  context: Context,
): Promise<void> {
  while (runtime.now() < until)
    await runtime.sleep(Math.min(until, runtime.now() + CLOCK_STEP_MS), context);
}

type RunOutcome = { ok: true; output: string } | { ok: false; error: string };

type RunnerState =
  | { phase: "plan" }
  | { phase: "wait"; nextAt: number }
  | { phase: "run"; at: number; key: string; manual: boolean }
  | { phase: "act"; at: number; key: string; manual: boolean; outcome: RunOutcome | null };

const EMPTY: JobsState = { jobs: [], events: [], nextEvent: 1 };

/** The job this runner serves, or `undefined` once it was deleted, paused, ended or handed to another runner. */
function served(state: Readonly<JobsState>, name: string, taskId: TaskId): Job | undefined {
  const job = state.jobs.find((item) => item.name === name);
  return job?.status === "active" && job.taskId === taskId ? job : undefined;
}

/**
 * What wakes someone: why (`slot …`, `change`, an exit) and what to tell them after the job's prompt. A result (`steer`)
 * joins a busy worker's run after its current tool round, since the work in flight may depend on it; a scheduled ask
 * waits for the run to answer.
 */
type Wake = { header: string; body: string; steer: boolean };

function message(job: Job, why: Wake, front: boolean): string {
  return jobNoticeText(
    {
      name: job.name,
      header: why.header,
      text: [job.prompt, why.body].filter(Boolean).join("\n\n"),
    },
    front,
  );
}

/**
 * A notify target as `list` shows it and the event names it, seen from the job's root: a worker in another root as
 * `<root id>/<worker>`, any other by its name. `roots` are the ids of every root.
 */
function targetLabel(job: Job, target: JobTarget, roots: ReadonlySet<ConversationId>): string {
  if (target.kind === "front")
    return target.rootId === job.rootId ? "front" : `root:${shortId(target.rootId)}`;
  return target.parentId !== job.rootId && roots.has(target.parentId)
    ? `${shortId(target.parentId)}/${target.name}`
    : target.name;
}

/** Every root's id, for `targetLabel`. */
export const rootIds = (roots: readonly { id: ConversationId }[]): ReadonlySet<ConversationId> =>
  new Set(roots.map((root) => root.id));

const sameWorker = (a: JobWorker, b: JobWorker) => a.parentId === b.parentId && a.name === b.name;

/** Who creates a job: its root, the caller's own conversation and, for a worker, its record (parent and name). */
type Caller = { rootId: ConversationId; id: ConversationId; self: JobWorker | undefined };

/**
 * A worker by plain name, as the caller sees it, nearest first: the caller itself, its own sub-workers, then the
 * workers under its parent, its grandparent and so on up to the root, so a worker at any depth finds its parent, its
 * siblings and the root's workers with no ids.
 */
async function findWorker(tx: Tx, caller: Caller, name: string): Promise<JobWorker | undefined> {
  if (caller.self?.name === name) return caller.self;
  for (
    let parentId: ConversationId | undefined = caller.id;
    parentId !== undefined;
    parentId = parentId === caller.rootId ? undefined : await parentOf(tx, parentId)
  )
    if ((await tx.doc(WorkersDoc, parentId)).workers.some((item) => item.name === name))
      return { parentId, name };
  return undefined;
}

/**
 * The targets `notify` names: `front` for the job's root, `root:<id>` for another root's front, a worker's name (found
 * as `findWorker` finds it), or `<root id>/<worker>` for a worker in another root. Workers must exist, except the
 * job's own, which it starts.
 */
async function resolveTargets(
  tx: Tx,
  caller: Caller,
  worker: JobWorker,
  names: readonly string[],
): Promise<JobTarget[]> {
  const { rootId } = caller;
  const roots = (await tx.doc(RootsDoc)).roots;
  const root = (prefix: string) => {
    const found = findRoot(roots, prefix);
    if (found.archived) throw new Error(`Root ${shortId(found.id)} is archived`);
    return found.id;
  };
  const targets: JobTarget[] = [];
  for (const text of names) {
    let target: JobTarget;
    const slash = text.indexOf("/");
    if (text === "front") target = { kind: "front", rootId };
    else if (text.startsWith("root:")) target = { kind: "front", rootId: root(text.slice(5)) };
    else if (slash === -1 && text === worker.name)
      target = { kind: "worker", parentId: worker.parentId, name: worker.name };
    else {
      const other = slash === -1 ? undefined : root(text.slice(0, slash));
      const found =
        other === undefined
          ? await findWorker(tx, caller, text)
          : await findWorker(
              tx,
              { rootId: other, id: other, self: undefined },
              text.slice(slash + 1),
            );
      if (found === undefined)
        throw new Error(
          `notify: no worker ${text}; name front, root:<id>, a worker's name, or <root id>/<worker>`,
        );
      target = { kind: "worker", ...found };
    }
    const same = (other: JobTarget) =>
      other.kind === "front"
        ? target.kind === "front" && target.rootId === other.rootId
        : target.kind === "worker" && sameWorker(target, other);
    if (!targets.some(same)) targets.push(target);
  }
  return targets;
}

/** The last `chars` characters of a file, reading only its tail; empty when it is missing. */
async function tail(path: string, chars: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    // UTF-8 takes at most four bytes a character.
    const length = Math.min(size, chars * 4);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8").slice(-chars);
  } finally {
    await handle.close();
  }
}

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
};

function endText(job: Job, end: BgEnd): string {
  const after = `after ${duration(end.at - job.createdAt)}`;
  switch (end.reason) {
    case "exited":
      return end.code === null
        ? `could not start: ${end.error ?? "unknown error"}`
        : `exited ${end.code} ${after}`;
    case "killed":
      return `killed ${after}`;
    case "timed out":
      return `timed out ${after}`;
    case "interrupted":
      return `interrupted ${after}: Monchu quit or restarted while it ran, which stops it; rerun it if it still matters`;
  }
}

/**
 * The secrets a job's command names, for its environment, and the redactor its output goes through before anything
 * keeps it; an error says why they could not be read.
 */
async function secretsFor(vault: Vault, job: Job, command: string) {
  try {
    return await commandSecrets(vault, command, {
      tool: `job ${job.name}`,
      conversation: shortId(job.rootId),
    });
  } catch (error) {
    return {
      error: `secrets could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Remove a `bg` job's log directory. A process a delete is still killing may hold it a moment longer. */
async function removeLog(log: string): Promise<void> {
  await rm(join(log, ".."), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

/**
 * Hands a job's notice to a root's front as input, which starts its turn or waits for its current answer. Created in the
 * commit that records the run; the request ID keeps a replay from sending it twice.
 */
const NotifyFront = defineTask<
  { front: ConversationId; text: string; requestId: string },
  { phase: "send" },
  null
>({
  name: "monchu.job-notify",
  version: 1,
  initial: () => ({ phase: "send" }),
  phases: {
    send: async (task, runtime, context) => {
      const front = await runtime.conversation(task.input.front, context);
      if (front === undefined) throw new Error("Root conversation is missing");
      await front.submit(
        {
          type: "input",
          content: task.input.text,
          whenBusy: "followUp",
          requestId: task.input.requestId,
        },
        context,
      );
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const ACTIONS = [
  "create",
  "list",
  "pause",
  "resume",
  "run_now",
  "output",
  "kill",
  "delete",
] as const;

/**
 * Durable background jobs: one `job` tool for every role, and one store-wide list. Each job is a background runner task
 * on the root conversation, so stopping a worker never stops its jobs. Runners are replay-safe. A scheduled run commits
 * what it changes (the command's cursor, its event, the worker it wakes) atomically with the runner's next checkpoint,
 * so a restart never wakes anyone twice for one slot or change. A `bg` command runs as Durable runs a tool, inside its
 * runner's invocation, so quitting Monchu kills it; its replay reports it interrupted, once. A command gets the stored
 * secrets it names as `$NAME`, like a shell tool's, and its output is redacted before it is kept or sent.
 */
export function createJobs(
  workerRole: () => ModelRole,
  home: string,
  vault: Vault,
  profiles: Record<string, WorkerProfile> = {},
  preload: readonly string[] = [],
) {
  /**
   * Tell whoever the job notifies, by default its worker, inside the commit that records the run. A worker is messaged
   * (reopened if closed); the job's own is started on the job's model if it does not exist, and any other that is gone
   * is skipped. A front gets the notice as input, by a task created in the same commit, with no model call before it.
   * Returns who heard, for the event; `undefined` when nobody did.
   */
  async function wake(tx: Tx, job: Job, why: Wake, requestId: string): Promise<string | undefined> {
    const heard: string[] = [];
    const roots = rootIds((await tx.doc(RootsDoc)).roots);
    const targets: readonly JobTarget[] = job.notify ?? [{ kind: "worker", ...job.worker }];
    await prepareDeliveries(
      tx,
      targets.flatMap((target) => (target.kind === "worker" ? [target.parentId] : [])),
    );
    for (const target of targets) {
      const label = targetLabel(job, target, roots);
      if (target.kind === "front") {
        await tx.createTask(
          NotifyFront,
          {
            front: target.rootId,
            text: message(job, why, true),
            requestId: `${requestId}:front:${target.rootId}`,
          },
          { conversationId: target.rootId, ownership: { kind: "conversation" }, background: true },
        );
        heard.push(label);
        continue;
      }
      const { parentId, name } = target;
      const own = sameWorker(target, job.worker);
      // The job's own worker keeps the request ID it always had.
      const id = own ? requestId : `${requestId}:worker:${parentId}:${name}`;
      const text = message(job, why, false);
      const worker = (await tx.doc(WorkersDoc, parentId)).workers.find(
        (item) => item.name === name,
      );
      if (worker === undefined && !own) continue;
      if (worker === undefined)
        await startWorker(
          tx,
          parentId,
          name,
          text,
          job.cwd,
          id,
          job.role ?? workerRole(),
          preload,
          true,
        );
      else {
        if (worker.closed) await reopenWorker(tx, parentId, name);
        await messageWorker(tx, parentId, name, text, id, why.steer ? "steer" : "followUp", true);
      }
      heard.push(label);
    }
    return heard.length === 0 ? undefined : heard.join(", ");
  }

  const Runner = defineTask<{ name: string }, RunnerState, null>({
    name: "monchu.job",
    version: 2,
    initial: () => ({ phase: "plan" }),
    phases: {
      plan: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const state = await tx.doc(JobsDoc);
          const job = served(state, task.input.name, task.id);
          if (job === undefined)
            return { status: "terminal", outcome: { status: "completed", result: null } };
          const now = runtime.now();
          // A command takes its baseline at once; an agent job waits for its first slot.
          const nextAt =
            job.type === "command" && job.cursor === undefined
              ? now
              : nextSlot(parseCron(job.schedule ?? ""), now);
          job.nextAt = nextAt;
          return { status: "running", checkpoint: { phase: "wait", nextAt } };
        }, context),
      wait: async (task, runtime, context) => {
        const { nextAt } = task.state.checkpoint;
        const watch = await runtime.watchDoc(JobsDoc, context);
        const sleep = withCancel(context);
        // Wake at the slot, or as soon as the job is paused, deleted, handed over, or asked to run now.
        const changed = (value: Readonly<JobsState> | null) => {
          const job = value === null ? undefined : served(value, task.input.name, task.id);
          return job === undefined || job.runNow === true;
        };
        try {
          if (watch === undefined || !changed(watch.value)) {
            const woken = new Promise<void>((resolve) => {
              watch?.start(async (value) => {
                if (changed(value)) resolve();
              });
            });
            await Promise.race([sleepUntil(runtime, nextAt, sleep.context), woken]);
          }
        } finally {
          sleep.cancel();
          await watch?.stop();
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(JobsDoc);
          const job = served(state, task.input.name, task.id);
          if (job === undefined)
            return { status: "terminal", outcome: { status: "completed", result: null } };
          const now = runtime.now();
          if (job.runNow === true) {
            delete job.runNow;
            return {
              status: "running",
              checkpoint: { phase: "run", at: now, key: `manual:${now}`, manual: true },
            };
          }
          if (now < nextAt) return { status: "running", checkpoint: { phase: "wait", nextAt } };
          // A slot missed while Monchu was closed runs once now; the next one counts from now.
          return {
            status: "running",
            checkpoint: { phase: "run", at: now, key: slotKey(nextAt), manual: false },
          };
        }, context);
      },
      run: async (task, runtime, context) => {
        const { at, key, manual } = task.state.checkpoint;
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? EMPTY,
          task.input.name,
          task.id,
        );
        let outcome: RunOutcome | null = null;
        if (job?.type === "command" && job.command !== undefined) {
          const secrets = await secretsFor(vault, job, job.command);
          const env = await runtime.env(context);
          if ("error" in secrets) outcome = { ok: false, error: secrets.error };
          else if (env === undefined) outcome = { ok: false, error: "no execution environment" };
          else {
            let output = "";
            const result = await env.exec(
              job.command,
              {
                cwd: job.cwd,
                env: secrets.env,
                timeout: COMMAND_TIMEOUT_S,
                onOutput: (text) => {
                  output = (output + secrets.redactor.push(text)).slice(-OUTPUT_KEPT);
                },
              },
              context,
            );
            output = (output + secrets.redactor.end()).slice(-OUTPUT_KEPT);
            if (!result.ok) outcome = { ok: false, error: `${result.error.message}\n${output}` };
            else if (result.value.exitCode !== 0)
              outcome = { ok: false, error: `exit ${result.value.exitCode}\n${output}` };
            else outcome = { ok: true, output: output.trimEnd() };
          }
        }
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "act", at, key, manual, outcome } }),
          context,
        );
      },
      act: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const { at, key, manual, outcome } = task.state.checkpoint;
          const state = await tx.doc(JobsDoc);
          const job = served(state, task.input.name, task.id);
          if (job === undefined)
            return { status: "terminal", outcome: { status: "completed", result: null } };
          job.runs++;
          job.lastRunAt = at;
          const requestId = `job:${job.name}:${job.createdAt}:${key}`;
          const event = async (kind: JobEvent["kind"], text: string, why?: Wake) => {
            const worker = why === undefined ? undefined : await wake(tx, job, why, requestId);
            addEvent(state, job, {
              at,
              kind,
              text: text.slice(0, 300),
              ...(worker === undefined ? {} : { worker }),
            });
          };
          if (job.type === "agent")
            await event("fired", manual ? "ran now" : `slot ${key}`, {
              header: manual ? "run now" : `slot ${key}`,
              body: "",
              steer: false,
            });
          else if (outcome !== null && !outcome.ok) {
            const failure = hash(outcome.error);
            // A failure wakes the worker once, until it changes or the command recovers.
            if (job.failure !== failure) {
              job.failure = failure;
              await event("failed", `command failed: ${outcome.error.split("\n", 1)[0] ?? ""}`, {
                header: "command failed",
                steer: true,
                body: `The job's command \`${job.command ?? ""}\` failed:\n${outcome.error}`,
              });
            }
          } else {
            const output = outcome?.output ?? "";
            const cursor = hash(output);
            const first = job.cursor === undefined;
            const changed = !first && job.cursor !== cursor;
            delete job.failure;
            job.cursor = cursor;
            // Run now runs at once; like any run it wakes the worker only on a change.
            if (changed)
              await event("changed", "output changed", {
                header: "change",
                steer: true,
                body: `Command output now:\n${output}`,
              });
            else if (first) await event("fired", "baseline taken");
          }
          const nextAt = nextSlot(parseCron(job.schedule ?? ""), runtime.now());
          job.nextAt = nextAt;
          return { status: "running", checkpoint: { phase: "wait", nextAt } };
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /**
   * Runs a `bg` job's command once, as Durable runs a tool: inside this task's invocation, so Monchu quitting or
   * restarting kills it. The `launched` memo marks the start; a phase that finds it set is a replay after such a stop,
   * so it reports the process interrupted instead of starting it again. The end, its event and the ping commit at once,
   * under one request ID, so a replay never pings twice.
   */
  const BgRunner = defineTask<
    { name: string },
    { phase: "run" } | { phase: "end"; end: BgEnd },
    null
  >({
    name: "monchu.job-bg",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const finish = (end: BgEnd) =>
          runtime.commit(() => ({ status: "running", checkpoint: { phase: "end", end } }), context);
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? EMPTY,
          task.input.name,
          task.id,
        );
        if (job?.command === undefined || job.log === undefined)
          return runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        if ((await runtime.memo<boolean>("launched", context)) === true)
          return finish({ reason: "interrupted", code: null, at: runtime.now() });
        await runtime.memo("launched", true, context);
        const env = await runtime.env(context);
        if (env === undefined)
          return finish({
            reason: "exited",
            code: null,
            at: runtime.now(),
            error: "no execution environment",
          });
        const secrets = await secretsFor(vault, job, job.command);
        if ("error" in secrets)
          return finish({ reason: "exited", code: null, at: runtime.now(), error: secrets.error });
        await mkdir(join(job.log, ".."), { recursive: true });
        const log = createWriteStream(job.log, { flags: "w" });
        const run = withCancel(context);
        let stop: "killed" | "timed out" | "deleted" | undefined;
        const halt = (why: NonNullable<typeof stop>) => {
          stop ??= why;
          run.cancel();
        };
        const check = (value: Readonly<JobsState> | null) => {
          const current = value === null ? undefined : served(value, task.input.name, task.id);
          if (current === undefined) halt("deleted");
          else if (current.kill === true) halt("killed");
        };
        const watch = await runtime.watchDoc(JobsDoc, context);
        check(watch?.value ?? null);
        watch?.start(async (value) => check(value));
        if (job.timeout !== undefined)
          sleepUntil(runtime, job.createdAt + job.timeout * 60_000, run.context).then(
            () => halt("timed out"),
            () => undefined,
          );
        try {
          const result =
            stop === undefined
              ? await env.exec(
                  job.command,
                  {
                    cwd: job.cwd,
                    env: secrets.env,
                    onOutput: (text) => log.write(secrets.redactor.push(text)),
                  },
                  run.context,
                )
              : undefined;
          // Monchu is closing: the command was killed with it, and the replay reports it interrupted.
          runtime.signal.throwIfAborted();
          const at = runtime.now();
          if (stop === "deleted")
            return await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              context,
            );
          if (stop !== undefined) return await finish({ reason: stop, code: null, at });
          if (result === undefined || !result.ok)
            return await finish({
              reason: "exited",
              code: null,
              at,
              error: result?.ok === false ? result.error.message : "not started",
            });
          await finish({ reason: "exited", code: result.value.exitCode, at });
        } finally {
          run.cancel();
          await watch?.stop();
          log.write(secrets.redactor.end());
          await new Promise<void>((resolve) => log.end(resolve));
        }
      },
      end: async (task, runtime, context) => {
        const { end } = task.state.checkpoint;
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? EMPTY,
          task.input.name,
          task.id,
        );
        const output = job?.log === undefined ? "" : await tail(job.log, OUTPUT_KEPT);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(JobsDoc);
          const current = served(state, task.input.name, task.id);
          if (current === undefined)
            return { status: "terminal", outcome: { status: "completed", result: null } };
          current.status = "done";
          current.ended = end;
          delete current.kill;
          const summary = endText(current, end);
          const why = {
            header: `bg ${summary}`,
            steer: true,
            body: [
              `Command: ${current.command ?? ""}`,
              output ? `Output tail:\n${output.trimEnd()}` : "No output.",
              `Full log: ${current.log ?? ""}`,
            ].join("\n"),
          };
          const worker = await wake(
            tx,
            current,
            why,
            `job:${current.name}:${current.createdAt}:end`,
          );
          addEvent(state, current, {
            at: end.at,
            kind:
              end.reason === "exited"
                ? end.code === null
                  ? "failed"
                  : "exited"
                : end.reason === "interrupted"
                  ? "interrupted"
                  : "killed",
            text: summary.slice(0, 300),
            ...(worker === undefined ? {} : { worker }),
          });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** The calling conversation's root and, for a worker, its parent and name. */
  async function caller(tx: Tx, id: ConversationId): Promise<Caller> {
    const parentId = await parentOf(tx, id);
    if (parentId === undefined) return { rootId: id, id, self: undefined };
    const worker = (await tx.doc(WorkersDoc, parentId)).workers.find(
      (item) => item.conversationId === id,
    );
    if (worker === undefined) throw new Error("Only the front and workers can create jobs");
    return { rootId: await rootOf(tx, parentId), id, self: { parentId, name: worker.name } };
  }

  function startRunner(tx: Tx, job: Pick<Job, "name" | "rootId" | "type">): Promise<TaskId> {
    const options = {
      conversationId: job.rootId,
      ownership: { kind: "conversation" },
      background: true,
    } as const;
    return job.type === "bg"
      ? tx.createTask(BgRunner, { name: job.name }, options)
      : tx.createTask(Runner, { name: job.name }, options);
  }

  const text = (maxLength: number, description: string) =>
    Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

  return defineExtension({
    name: "monchu.jobs",
    tasks: [Runner, BgRunner, NotifyFront],
    tools: [
      defineTool({
        name: "job",
        description:
          "Background jobs; every job is listed for everyone (list, /jobs). create takes a type. agent: on a cron schedule, wake a worker with your prompt. command: on a cron schedule, run a read-only shell command with no model call; it wakes the worker only when the output changes or the command fails anew (the first run, at once, takes a baseline). bg: run a command once in the background now (a build, tests, `gh pr checks 12 --watch`) and keep working; when it ends the worker gets one message with the exit code, output tail and log path. Cron is five fields in the device's local time, or @hourly/@daily/@weekly/@monthly; a slot missed while Monchu was closed runs once at startup. Jobs run only while Monchu is open: quitting or restarting kills a running bg command, and its worker hears it was interrupted. The worker: `worker` names it; default you if you are a worker, else a new job-<name>. A worker the job has to start runs on profile, or model and thinking, if given; an existing worker keeps its own model for life, so naming one with a model is an error. The worker's answer reaches the front only when it starts with NEEDS USER. notify (opt-in) sends what would wake the worker to these instead, with no model call in between: front (your root's front), root:<id> (another root's front), a worker's name, or <root id>/<worker>; list the worker's own name to wake it too. When a front or another root waits on what a job finishes, notify it rather than relaying the result yourself. Other actions take name: pause, resume and run_now for agent and command jobs; output (last lines of the log) and kill for bg jobs; delete for any (kills a running bg command and removes its log).",
        parameters: Type.Object(
          {
            action: StringEnum(ACTIONS),
            name: Type.Optional(
              Type.String({
                pattern: "^[a-z][a-z0-9-]{0,39}$",
                description: "Job name, unique, for example pr-123-ci",
              }),
            ),
            type: Type.Optional(StringEnum(["agent", "command", "bg"] as const)),
            schedule: Type.Optional(text(100, "Cron expression, for agent and command jobs")),
            command: Type.Optional(text(4000, "Shell command, for command and bg jobs")),
            prompt: Type.Optional(
              text(4000, "What the worker should do when woken; required for agent jobs"),
            ),
            worker: Type.Optional(
              Type.String({ minLength: 1, maxLength: 100, description: "Worker to wake" }),
            ),
            notify: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 140 }), {
                minItems: 1,
                maxItems: 10,
                description: "Who hears it instead of the worker: front, root:<id>, worker names",
              }),
            ),
            profile: Type.Optional(Type.String({ minLength: 1 })),
            model: Type.Optional(
              Type.String({ minLength: 1, description: "provider/modelId, for a started worker" }),
            ),
            thinking: Type.Optional(StringEnum(thinkingLevels)),
            timeout: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 10_080,
                description: "Minutes before a bg command is killed (default none)",
              }),
            ),
            cwd: Type.Optional(
              Type.String({
                minLength: 1,
                description: "Directory for commands and a started worker; default your own",
              }),
            ),
            lines: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 500,
                description: "Log lines for output (default 50)",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        replay: "safe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
          const roots = rootIds((await api.snapshot(RootsDoc, context))?.roots ?? []);
          if (args.action === "list") {
            const state = await api.snapshot(JobsDoc, context);
            return reply(formatJobs(state?.jobs ?? [], roots));
          }
          const name = args.name;
          if (name === undefined) throw new Error(`${args.action} needs name`);
          if (args.action === "output") {
            const job = (await api.snapshot(JobsDoc, context))?.jobs.find(
              (item) => item.name === name,
            );
            if (job === undefined) throw new Error(`No job named ${name}`);
            if (job.log === undefined) throw new Error(`${name} is not a bg job`);
            const lines = (await tail(job.log, OUTPUT_KEPT * 4))
              .trimEnd()
              .split("\n")
              .slice(-(args.lines ?? 50));
            return reply(`${formatJob(job, roots)}\n${lines.join("\n") || "(no output yet)"}`);
          }
          if (args.action === "create") {
            const { type, schedule, command } = args;
            if (type === undefined) throw new Error("create needs type: agent, command or bg");
            if (type !== "bg") {
              if (schedule === undefined) throw new Error(`A ${type} job needs schedule`);
              nextSlot(parseCron(schedule), Date.now());
            }
            if (type !== "agent" && command === undefined)
              throw new Error(`A ${type} job needs command`);
            if (type === "agent" && args.prompt === undefined)
              throw new Error("An agent job needs prompt");
            const choice = {
              ...(args.profile === undefined ? {} : { profile: args.profile }),
              ...(args.model === undefined ? {} : { model: args.model }),
              ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
            };
            const role =
              Object.keys(choice).length === 0
                ? undefined
                : chooseRole(api.models, profiles, workerRole(), choice);
            const cwd = args.cwd ?? (await api.agent(context)).cwd;
            if (cwd === undefined) throw new Error("No directory: pass cwd");
            const createdAt = Date.now();
            const { job, pruned, replayed } = await api.commit(async (tx) => {
              const state = await tx.doc(JobsDoc);
              const existing = state.jobs.find((item) => item.name === name);
              if (existing !== undefined && existing.callId === api.callId)
                return { job: existing, pruned: [], replayed: true };
              // Finished bg jobs leave the list a day after they end.
              const pruned: string[] = [];
              for (let index = state.jobs.length - 1; index >= 0; index--) {
                const item = state.jobs[index];
                if (item?.ended === undefined || item.ended.at > createdAt - ENDED_KEPT_MS)
                  continue;
                if (item.log !== undefined) pruned.push(item.log);
                state.jobs.splice(index, 1);
              }
              if (state.jobs.some((item) => item.name === name))
                throw new Error(`A job named ${name} exists; pick another name or delete it`);
              const from = await caller(tx, api.conversationId);
              const { rootId, self } = from;
              const worker = await target(tx, from, args.worker ?? self?.name ?? `job-${name}`);
              const notify =
                args.notify === undefined
                  ? undefined
                  : await resolveTargets(tx, from, worker, args.notify);
              if (role !== undefined && worker.exists)
                throw new Error(
                  `${worker.name} already runs on its own model, which it keeps for life (prompt cache); leave out profile, model and thinking, or name a new worker`,
                );
              const base = { name, rootId, type };
              const job: Job = {
                ...base,
                ...(type !== "bg" && schedule !== undefined ? { schedule } : {}),
                ...(type !== "agent" && command !== undefined ? { command } : {}),
                ...(type === "bg"
                  ? {
                      log: join(home, "jobs", `${name}-${createdAt}`, "output.log"),
                      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
                    }
                  : {}),
                prompt: args.prompt ?? "",
                cwd,
                worker: { parentId: worker.parentId, name: worker.name },
                ...(notify === undefined ? {} : { notify }),
                ...(role === undefined ? {} : { role }),
                createdBy: self?.name ?? "front",
                createdAt,
                callId: api.callId,
                status: "active",
                taskId: await startRunner(tx, base),
                runs: 0,
              };
              state.jobs.push(job);
              addEvent(state, job, {
                at: createdAt,
                kind: type === "bg" ? "started" : "created",
                text: describeJob(job),
              });
              return { job, pruned, replayed: false };
            }, context);
            for (const log of pruned) await removeLog(log);
            if (replayed) return reply(`Created: ${formatJob(job, roots)}`);
            return reply(
              job.type === "bg"
                ? `Started ${formatJob(job, roots)}\nKeep working: ${job.worker.name} gets one message when it ends. action output shows its log so far; kill stops it.`
                : `Created: ${formatJob(job, roots)}`,
            );
          }
          let removed: string | undefined;
          const result = await api.commit(async (tx) => {
            const state = await tx.doc(JobsDoc);
            const index = state.jobs.findIndex((item) => item.name === name);
            const job = state.jobs[index];
            if (job === undefined) throw new Error(`No job named ${name}`);
            const at = Date.now();
            if (job.type === "bg" && args.action !== "kill" && args.action !== "delete")
              throw new Error(`${args.action} is not for bg jobs; use output, kill or delete`);
            switch (args.action) {
              case "kill":
                if (job.type !== "bg")
                  throw new Error(`${name} is not a bg job; use pause or delete`);
                if (job.status !== "active") return `${name} already ended`;
                job.kill = true;
                return `Killing ${name}; ${job.worker.name} gets the usual message when it ends`;
              case "pause":
                if (job.status === "paused") return `${name} is already paused`;
                job.status = "paused";
                delete job.nextAt;
                addEvent(state, job, { at, kind: "paused", text: "paused" });
                return `Paused ${name}`;
              case "resume":
                if (job.status === "active") return `${name} is already active`;
                job.status = "active";
                job.taskId = await startRunner(tx, job);
                addEvent(state, job, { at, kind: "resumed", text: "resumed" });
                return `Resumed ${name}`;
              case "run_now":
                if (job.status !== "active") throw new Error(`${name} is paused; resume it first`);
                job.runNow = true;
                return `${name} runs now`;
              case "delete":
                state.jobs.splice(index, 1);
                removed = job.log;
                addEvent(state, job, { at, kind: "deleted", text: "deleted" });
                return `Deleted ${name}`;
              case "create":
              case "list":
              case "output":
                throw new Error(`${args.action} is handled before this commit`);
            }
          }, context);
          if (removed !== undefined) await removeLog(removed);
          return reply(result);
        },
      }),
    ],
  });
}

/**
 * The worker a new job wakes, by name: one the caller sees (`findWorker`), or else a new one the job starts under the
 * root.
 */
async function target(
  tx: Tx,
  caller: Caller,
  name: string,
): Promise<JobWorker & { exists: boolean }> {
  const found = await findWorker(tx, caller, name);
  return found === undefined
    ? { parentId: caller.rootId, name, exists: false }
    : { ...found, exists: true };
}

function describeJob(job: Job): string {
  switch (job.type) {
    case "agent":
      return `agent ${job.schedule ?? ""}`;
    case "command":
      return `command ${job.schedule ?? ""}: ${job.command ?? ""}`;
    case "bg":
      return `bg: ${job.command ?? ""}`;
  }
}

const time = (at: number | undefined) => (at === undefined ? "never" : slotKey(at));

/** One job on one line, as `list` and `/jobs` show it; `roots` as `targetLabel` takes them. */
function formatJob(job: Job, roots: ReadonlySet<ConversationId>): string {
  const heard =
    job.notify === undefined
      ? `worker ${job.worker.name}`
      : `notify ${job.notify.map((target) => targetLabel(job, target, roots)).join(", ")}`;
  const who = `${heard} · by ${job.createdBy}`;
  if (job.type === "bg") {
    const state =
      job.ended === undefined
        ? `running ${duration(Date.now() - job.createdAt)}`
        : (endText(job, job.ended).split(":", 1)[0] ?? "");
    return `${job.name} (${state}) ${describeJob(job).slice(0, 120)} · ${who} · log ${job.log ?? ""}`;
  }
  return `${job.name} (${job.status}) ${describeJob(job).slice(0, 120)} · ${who} · runs ${job.runs}, last ${time(job.lastRunAt)}, next ${job.status === "active" ? time(job.nextAt) : "-"}`;
}

export function formatJobs(jobs: readonly Job[], roots: ReadonlySet<ConversationId>): string {
  return jobs.length === 0
    ? "No jobs."
    : jobs.map((job) => `- ${formatJob(job, roots)}`).join("\n");
}
