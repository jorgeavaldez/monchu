import { withCancel } from "@earendil-works/chord/context";
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
import type { ModelRole } from "./config.ts";
import { messageWorker, reopenWorker, startWorker, WorkersDoc } from "./agents/workers.ts";

/** A job's worker: an existing worker under `parentId`, or none, and the job starts its own under the root. */
type JobOwner = { parentId: ConversationId; worker: string };

export type Job = {
  name: string;
  kind: "schedule" | "watch" | "process";
  /** Five-field cron expression in the device's local time; schedule jobs only. */
  schedule?: string;
  /** Minutes between polls; watch jobs only. */
  every?: number;
  /**
   * Shell command: a watch's poll, or output a schedule job hands its worker, both safe to rerun; or the process a
   * process job runs once.
   */
  command?: string;
  /** What the worker does when the job fires; empty for a process job started without one. */
  prompt: string;
  cwd: string;
  rootId: ConversationId;
  owner: JobOwner | null;
  /** The worker or `front` that created it. */
  createdBy: string;
  createdAt: number;
  /** `done` only for a process job that ended. */
  status: "active" | "paused" | "done";
  /** The runner task; a runner whose ID this is not stops itself. */
  taskId: TaskId;
  /** Set by `run_now`; the runner clears it when it runs. */
  runNow?: true;
  nextAt?: number;
  lastRunAt?: number;
  runs: number;
  /** Hash of a watch's last output, and of the last failure reported, so only changes wake anyone. */
  cursor?: string;
  failure?: string;
  /** Process jobs: the output log, the limit in minutes, a pending kill, and how it ended. */
  log?: string;
  timeout?: number;
  kill?: true;
  ended?: ProcessEnd;
};

/** How a process job ended. `interrupted`: Monchu quit or restarted while it ran, which kills it. */
type ProcessEnd = {
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

function addEvent(state: JobsState, event: Omit<JobEvent, "id">): void {
  state.events.push({ id: state.nextEvent++, ...event });
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

type RunOutcome = { ok: true; output: string } | { ok: false; error: string };

type RunnerState =
  | { phase: "plan" }
  | { phase: "wait"; nextAt: number }
  | { phase: "run"; at: number; key: string; manual: boolean }
  | { phase: "act"; at: number; key: string; manual: boolean; outcome: RunOutcome | null };

/** The job this runner serves, or `undefined` once it was deleted, paused or handed to another runner. */
function served(state: Readonly<JobsState>, name: string, taskId: TaskId): Job | undefined {
  const job = state.jobs.find((item) => item.name === name);
  return job?.status === "active" && job.taskId === taskId ? job : undefined;
}

function due(job: Job, now: number): number {
  if (job.kind === "watch") return now + (job.every ?? 5) * 60_000;
  return nextSlot(parseCron(job.schedule ?? ""), now);
}

function message(job: Job, header: string, body: string): string {
  return [
    `[Job ${job.name} · ${header}] This comes from a background job, not from the user.`,
    ...(job.prompt ? [job.prompt] : []),
    ...(body ? [body] : []),
    `Your answer reaches the front only if its first line starts with "NEEDS USER"; start it that way only when the user must decide or act. Manage the job with job_control when it is done.`,
  ].join("\n\n");
}

/** Finished process jobs, and their logs, are kept this long. */
const ENDED_KEPT_MS = 7 * 24 * 60 * 60_000;

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

function endText(job: Job, end: ProcessEnd): string {
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
 * Durable scheduled jobs and watchers. Each job is one background runner task on the root conversation, so stopping a
 * worker never stops its jobs, and every job lives in one store-wide list. A runner is replay-safe: its command must be
 * safe to rerun, and what a run changes (the job's cursor, its event, and the worker it wakes) commits atomically with
 * the runner's next checkpoint, so a restart never wakes anyone twice for one slot or change.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createJobs(
  workerRole: () => ModelRole,
  home: string,
  preload: readonly string[] = [],
) {
  /** Wake the job's worker inside the commit that records the run. Returns the worker's name. */
  async function wake(tx: Tx, job: Job, text: string, requestId: string): Promise<string> {
    if (job.owner !== null) {
      const workers = await tx.doc(WorkersDoc, job.owner.parentId);
      const worker = workers.workers.find((item) => item.name === job.owner?.worker);
      if (worker === undefined) throw new Error(`owner worker ${job.owner.worker} is gone`);
      if (worker.closed) await reopenWorker(tx, job.owner.parentId, worker.name);
      await messageWorker(tx, job.owner.parentId, worker.name, text, requestId, "followUp", true);
      return worker.name;
    }
    const name = `job-${job.name}`;
    const workers = await tx.doc(WorkersDoc, job.rootId);
    const worker = workers.workers.find((item) => item.name === name);
    if (worker === undefined)
      await startWorker(
        tx,
        job.rootId,
        name,
        text,
        job.cwd,
        requestId,
        workerRole(),
        preload,
        true,
      );
    else {
      if (worker.closed) await reopenWorker(tx, job.rootId, name);
      await messageWorker(tx, job.rootId, name, text, requestId, "followUp", true);
    }
    return name;
  }

  const Runner = defineTask<{ name: string }, RunnerState, null>({
    name: "monchu.job",
    version: 1,
    initial: () => ({ phase: "plan" }),
    phases: {
      plan: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const state = await tx.doc(JobsDoc);
          const job = served(state, task.input.name, task.id);
          if (job === undefined)
            return { status: "terminal", outcome: { status: "completed", result: null } };
          const now = runtime.now();
          // A watch takes its baseline at once; a schedule waits for its first slot.
          const nextAt = job.kind === "watch" && job.cursor === undefined ? now : due(job, now);
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
            await Promise.race([runtime.sleep(nextAt, sleep.context), woken]);
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
          const key = job.kind === "schedule" ? slotKey(nextAt) : `poll:${job.runs}`;
          return { status: "running", checkpoint: { phase: "run", at: now, key, manual: false } };
        }, context);
      },
      run: async (task, runtime, context) => {
        const { at, key, manual } = task.state.checkpoint;
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? { jobs: [], events: [], nextEvent: 1 },
          task.input.name,
          task.id,
        );
        let outcome: RunOutcome | null = null;
        if (job?.command !== undefined) {
          const env = await runtime.env(context);
          if (env === undefined) outcome = { ok: false, error: "no execution environment" };
          else {
            let output = "";
            const result = await env.exec(
              job.command,
              {
                cwd: job.cwd,
                timeout: COMMAND_TIMEOUT_S,
                onOutput: (text) => {
                  output = (output + text).slice(-OUTPUT_KEPT);
                },
              },
              context,
            );
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
          const event = async (kind: JobEvent["kind"], text: string, wakeText?: string) => {
            let worker: string | undefined;
            if (wakeText !== undefined)
              try {
                worker = await wake(tx, job, wakeText, requestId);
              } catch (error) {
                // A job whose worker is gone pauses rather than failing every slot.
                job.status = "paused";
                addEvent(state, {
                  at,
                  job: job.name,
                  kind: "failed",
                  text: `paused: ${error instanceof Error ? error.message : String(error)}`,
                });
                return;
              }
            addEvent(state, {
              at,
              job: job.name,
              kind,
              text: text.slice(0, 300),
              ...(worker === undefined ? {} : { worker }),
            });
          };
          if (outcome !== null && !outcome.ok) {
            const failure = hash(outcome.error);
            // A watch reports a failure once until it changes or the command recovers; a schedule reports every run.
            if (job.kind === "schedule" || manual || job.failure !== failure) {
              job.failure = failure;
              await event(
                "failed",
                `command failed: ${outcome.error.split("\n", 1)[0] ?? ""}`,
                message(
                  job,
                  "command failed",
                  `The job's command \`${job.command ?? ""}\` failed:\n${outcome.error}`,
                ),
              );
            }
          } else if (job.kind === "schedule") {
            delete job.failure;
            await event(
              "fired",
              manual ? "ran now" : `slot ${key}`,
              message(
                job,
                manual ? "run now" : `slot ${key}`,
                outcome === null ? "" : `Command output:\n${outcome.output}`,
              ),
            );
          } else {
            const output = outcome?.output ?? "";
            const cursor = hash(output);
            const first = job.cursor === undefined;
            const changed = !first && job.cursor !== cursor;
            delete job.failure;
            job.cursor = cursor;
            // Run now polls at once; like any poll it wakes the worker only on a change.
            if (changed)
              await event(
                "changed",
                "output changed",
                message(job, "change", `Command output now:\n${output}`),
              );
            else if (first) await event("fired", "watching: baseline taken");
          }
          if (job.status !== "active")
            return { status: "terminal", outcome: { status: "completed", result: null } };
          const nextAt = due(job, runtime.now());
          job.nextAt = nextAt;
          return { status: "running", checkpoint: { phase: "wait", nextAt } };
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /**
   * Runs a process job's command once, as Durable runs a tool: inside this task's invocation, so Monchu quitting or
   * restarting kills it. The `launched` memo marks the start; a phase that finds it set is a replay after such a stop,
   * so it reports the process interrupted instead of starting it again. The end, its event and the ping commit at once,
   * under one request ID, so a replay never pings twice.
   */
  const ProcessRunner = defineTask<
    { name: string },
    { phase: "run" } | { phase: "end"; end: ProcessEnd },
    null
  >({
    name: "monchu.job-process",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const finish = (end: ProcessEnd) =>
          runtime.commit(() => ({ status: "running", checkpoint: { phase: "end", end } }), context);
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? { jobs: [], events: [], nextEvent: 1 },
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
          runtime.sleep(job.createdAt + job.timeout * 60_000, run.context).then(
            () => halt("timed out"),
            () => undefined,
          );
        try {
          const result =
            stop === undefined
              ? await env.exec(
                  job.command,
                  { cwd: job.cwd, onOutput: (text) => log.write(text) },
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
          await new Promise<void>((resolve) => log.end(resolve));
        }
      },
      end: async (task, runtime, context) => {
        const { end } = task.state.checkpoint;
        const job = served(
          (await runtime.snapshot(JobsDoc, context)) ?? { jobs: [], events: [], nextEvent: 1 },
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
          const text = message(
            current,
            `process ${summary}`,
            [
              `Command: ${current.command ?? ""}`,
              output ? `Output tail:\n${output.trimEnd()}` : "No output.",
              `Full log: ${current.log ?? ""}`,
            ].join("\n"),
          );
          let worker: string | undefined;
          let failure: string | undefined;
          try {
            worker = await wake(tx, current, text, `job:${current.name}:${current.createdAt}:end`);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
          addEvent(state, {
            at: end.at,
            job: current.name,
            kind:
              end.reason === "exited"
                ? end.code === null
                  ? "failed"
                  : "exited"
                : end.reason === "interrupted"
                  ? "interrupted"
                  : "killed",
            text: (failure === undefined ? summary : `${summary}; no ping: ${failure}`).slice(
              0,
              300,
            ),
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
  async function caller(tx: Tx, id: ConversationId) {
    const record = await tx.conversation(id);
    if (record?.owner === undefined) return { rootId: id, owner: null };
    const parentId = record.owner.conversationId;
    const worker = (await tx.doc(WorkersDoc, parentId)).workers.find(
      (item) => item.conversationId === id,
    );
    if (worker === undefined) throw new Error("Only the front and workers can create jobs");
    let rootId = parentId;
    for (let up = await tx.conversation(rootId); up?.owner !== undefined;) {
      rootId = up.owner.conversationId;
      up = await tx.conversation(rootId);
    }
    return { rootId, owner: { parentId, worker: worker.name } };
  }

  function startRunner(tx: Tx, job: Pick<Job, "name" | "rootId" | "kind">): Promise<TaskId> {
    const options = {
      conversationId: job.rootId,
      ownership: { kind: "conversation" },
      background: true,
    } as const;
    return job.kind === "process"
      ? tx.createTask(ProcessRunner, { name: job.name }, options)
      : tx.createTask(Runner, { name: job.name }, options);
  }

  const text = (maxLength: number, description: string) =>
    Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

  return defineExtension({
    name: "monchu.jobs",
    tasks: [Runner, ProcessRunner],
    tools: [
      defineTool({
        name: "job_create",
        description:
          "Create a durable background job. kind process: start a command in the background now (a build, a test run, `gh pr checks 12 --watch`) and keep working; when it ends, its worker gets one message with the exit code, the output tail and the full log path. A process runs only while Monchu is open: quitting or restarting Monchu kills it, and its worker hears it was interrupted. Schedules and watches run while Monchu is open and survive restarts. kind schedule: a cron expression in the device's local time (five fields, or @hourly/@daily/@weekly/@monthly); at each slot your prompt goes to the job's worker, with the command's output when a command is given. A slot missed while Monchu was closed runs once on startup. kind watch: polls a shell command every N minutes and wakes the worker only when its output changes or the command fails (first poll takes a baseline); unchanged polls wake no model. Commands must be read-only and safe to rerun, for example `gh pr view 12 --json state,reviews,statusCheckRollup`. A job created by a worker wakes that worker; one created by the front starts its own worker, job-<name>. The worker's answer reaches the front only when it starts with NEEDS USER. Every job is listed globally (job_list, /jobs).",
        parameters: Type.Object(
          {
            name: Type.String({
              pattern: "^[a-z][a-z0-9-]{0,39}$",
              description: "Unique job name, for example pr-123-ci",
            }),
            kind: StringEnum(["schedule", "watch", "process"] as const),
            schedule: Type.Optional(text(100, "Cron expression, for schedule jobs")),
            every: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 1440,
                description: "Minutes between polls, for watch jobs (default 5)",
              }),
            ),
            command: Type.Optional(
              text(4000, "Shell command; required for watch and process jobs"),
            ),
            prompt: Type.Optional(
              text(
                4000,
                "What the worker should do when the job fires or the process ends; required for schedule and watch jobs",
              ),
            ),
            timeout: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 10_080,
                description: "Minutes before a process job is killed (default none)",
              }),
            ),
            cwd: Type.Optional(
              Type.String({
                minLength: 1,
                description: "Directory for the command and a started worker; default your own",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const { schedule } = args;
          if (args.kind === "schedule") {
            if (schedule === undefined) throw new Error("A schedule job needs schedule");
            nextSlot(parseCron(schedule), Date.now());
          } else if (args.command === undefined)
            throw new Error(`A ${args.kind} job needs command`);
          if (args.kind !== "process" && args.prompt === undefined)
            throw new Error(`A ${args.kind} job needs prompt`);
          const cwd = args.cwd ?? (await api.agent(context)).cwd;
          if (cwd === undefined) throw new Error("No directory: pass cwd");
          const createdAt = Date.now();
          const { job, pruned } = await api.commit(async (tx) => {
            const state = await tx.doc(JobsDoc);
            // Finished process jobs leave the list a week after they end.
            const pruned: string[] = [];
            for (let index = state.jobs.length - 1; index >= 0; index--) {
              const item = state.jobs[index];
              if (item?.ended === undefined || item.ended.at > createdAt - ENDED_KEPT_MS) continue;
              if (item.log !== undefined) pruned.push(item.log);
              state.jobs.splice(index, 1);
            }
            if (state.jobs.some((item) => item.name === args.name))
              throw new Error(`A job named ${args.name} exists; pick another name or delete it`);
            const { rootId, owner } = await caller(tx, api.conversationId);
            const base = { name: args.name, rootId, kind: args.kind };
            const job: Job = {
              ...base,
              ...(args.kind === "schedule" && schedule !== undefined ? { schedule } : {}),
              ...(args.kind === "watch" ? { every: args.every ?? 5 } : {}),
              ...(args.kind === "process"
                ? {
                    log: join(home, "jobs", `${args.name}-${createdAt}`, "output.log"),
                    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
                  }
                : {}),
              ...(args.command === undefined ? {} : { command: args.command }),
              prompt: args.prompt ?? "",
              cwd,
              owner,
              createdBy: owner?.worker ?? "front",
              createdAt,
              status: "active",
              taskId: await startRunner(tx, base),
              runs: 0,
            };
            state.jobs.push(job);
            addEvent(state, {
              at: job.createdAt,
              job: job.name,
              kind: job.kind === "process" ? "started" : "created",
              text: describeJob(job),
            });
            return { job, pruned };
          }, context);
          for (const log of pruned) await removeLog(log);
          return {
            content: [
              {
                type: "text",
                text:
                  job.kind === "process"
                    ? `Started ${formatJob(job)}\nKeep working: you get one message when it ends. job_control output shows its log so far; kill stops it.`
                    : `Created: ${formatJob(job)}`,
              },
            ],
          };
        },
      }),
      defineTool({
        name: "job_list",
        description:
          "List every background job in this Monchu, whoever created it: kind, schedule, owner worker, status, last and next run.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const state = await api.snapshot(JobsDoc, context);
          return { content: [{ type: "text", text: formatJobs(state?.jobs ?? []) }] };
        },
      }),
      defineTool({
        name: "job_control",
        description:
          "Manage a background job by name. Schedules and watches: pause, resume, run_now. Process jobs: output (the last lines of its log), kill. Any job: delete (a running process is killed first, and its log removed). Any worker or the front may manage any job.",
        parameters: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            action: StringEnum(["pause", "resume", "run_now", "kill", "output", "delete"] as const),
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
          if (args.action === "output") {
            const job = (await api.snapshot(JobsDoc, context))?.jobs.find(
              (item) => item.name === args.name,
            );
            if (job === undefined) throw new Error(`No job named ${args.name}`);
            if (job.log === undefined) throw new Error(`${job.name} is not a process job`);
            const lines = (await tail(job.log, OUTPUT_KEPT * 4))
              .trimEnd()
              .split("\n")
              .slice(-(args.lines ?? 50));
            return {
              content: [
                {
                  type: "text",
                  text: `${formatJob(job)}\n${lines.join("\n") || "(no output yet)"}`,
                },
              ],
            };
          }
          let removed: string | undefined;
          const result = await api.commit(async (tx) => {
            const state = await tx.doc(JobsDoc);
            const index = state.jobs.findIndex((item) => item.name === args.name);
            const job = state.jobs[index];
            if (job === undefined) throw new Error(`No job named ${args.name}`);
            const at = Date.now();
            if (
              job.kind === "process" &&
              (args.action === "pause" || args.action === "resume" || args.action === "run_now")
            )
              throw new Error(`${args.action} is not for process jobs; use kill or delete`);
            switch (args.action) {
              case "output":
                throw new Error("output reads the log outside a commit");
              case "kill":
                if (job.kind !== "process") throw new Error(`${job.name} is not a process job`);
                if (job.status !== "active") return `${job.name} already ended`;
                job.kill = true;
                return `Killing ${job.name}; its worker gets the usual message when it ends`;
              case "pause":
                if (job.status === "paused") return `${job.name} is already paused`;
                job.status = "paused";
                delete job.nextAt;
                addEvent(state, { at, job: job.name, kind: "paused", text: "paused" });
                return `Paused ${job.name}`;
              case "resume":
                if (job.status === "active") return `${job.name} is already active`;
                job.status = "active";
                job.taskId = await startRunner(tx, job);
                addEvent(state, { at, job: job.name, kind: "resumed", text: "resumed" });
                return `Resumed ${job.name}`;
              case "run_now":
                if (job.status !== "active")
                  throw new Error(`${job.name} is paused; resume it first`);
                job.runNow = true;
                return `${job.name} runs now`;
              case "delete":
                state.jobs.splice(index, 1);
                removed = job.log;
                addEvent(state, { at, job: job.name, kind: "deleted", text: "deleted" });
                return `Deleted ${job.name}`;
            }
          }, context);
          if (removed !== undefined) await removeLog(removed);
          return { content: [{ type: "text", text: result }] };
        },
      }),
    ],
  });
}

/** Remove a process job's log directory. A process a delete is still killing may hold it a moment longer. */
async function removeLog(log: string): Promise<void> {
  await rm(join(log, ".."), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

function describeJob(job: Job): string {
  switch (job.kind) {
    case "schedule":
      return `schedule ${job.schedule ?? ""}`;
    case "watch":
      return `watch every ${job.every ?? 5}m: ${job.command ?? ""}`;
    case "process":
      return `process: ${job.command ?? ""}`;
  }
}

const time = (at: number | undefined) => (at === undefined ? "never" : slotKey(at));

/** One job on one line, as `job_list` and `/jobs` show it. */
function formatJob(job: Job): string {
  if (job.kind === "process")
    return `${job.name} (${job.ended === undefined ? `running ${duration(Date.now() - job.createdAt)}` : endText(job, job.ended).split(":", 1)[0]}) ${describeJob(job).slice(0, 120)} · worker ${job.owner?.worker ?? `job-${job.name}`} · by ${job.createdBy} · log ${job.log ?? ""}`;
  return `${job.name} (${job.status}) ${describeJob(job).slice(0, 120)} · worker ${job.owner?.worker ?? `job-${job.name}`} · by ${job.createdBy} · runs ${job.runs}, last ${time(job.lastRunAt)}, next ${job.status === "active" ? time(job.nextAt) : "-"}`;
}

export function formatJobs(jobs: readonly Job[]): string {
  return jobs.length === 0 ? "No jobs." : jobs.map((job) => `- ${formatJob(job)}`).join("\n");
}

/** One job event as a client line: `job · <name> · <kind>[ → worker] · <text>`. */
export function formatJobEvent(event: JobEvent): string {
  return `job · ${event.job} · ${event.kind}${event.worker === undefined ? "" : ` → ${event.worker}`} · ${event.text}`;
}
