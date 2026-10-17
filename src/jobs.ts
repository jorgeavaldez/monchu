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
import type { ModelRole } from "./config.ts";
import { messageWorker, reopenWorker, startWorker, WorkersDoc } from "./workers.ts";

/** A job's worker: an existing worker under `parentId`, or none, and the job starts its own under the root. */
type JobOwner = { parentId: ConversationId; worker: string };

export type Job = {
  name: string;
  kind: "schedule" | "watch";
  /** Five-field cron expression in the device's local time; schedule jobs only. */
  schedule?: string;
  /** Minutes between polls; watch jobs only. */
  every?: number;
  /** Shell command: a watch's poll, or output a schedule job hands its worker. Must be safe to rerun. */
  command?: string;
  /** What the worker does when the job fires. */
  prompt: string;
  cwd: string;
  rootId: ConversationId;
  owner: JobOwner | null;
  /** The worker or `front` that created it. */
  createdBy: string;
  createdAt: number;
  status: "active" | "paused";
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
};

/** One entry of the job event stream clients follow. Ids only grow, so a client resumes after the last one it saw. */
export type JobEvent = {
  id: number;
  at: number;
  job: string;
  kind: "created" | "fired" | "changed" | "failed" | "paused" | "resumed" | "deleted";
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
    job.prompt,
    ...(body ? [body] : []),
    `Your answer reaches the front only if its first line starts with "NEEDS USER"; start it that way only when the user must decide or act. Manage the job with job_control (pause, resume, run_now, delete) when it is done.`,
  ].join("\n\n");
}

/**
 * Durable scheduled jobs and watchers. Each job is one background runner task on the root conversation, so stopping a
 * worker never stops its jobs, and every job lives in one store-wide list. A runner is replay-safe: its command must be
 * safe to rerun, and what a run changes (the job's cursor, its event, and the worker it wakes) commits atomically with
 * the runner's next checkpoint, so a restart never wakes anyone twice for one slot or change.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createJobs(workerRole: () => ModelRole, preload: readonly string[] = []) {
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

  function startRunner(tx: Tx, job: Pick<Job, "name" | "rootId">): Promise<TaskId> {
    return tx.createTask(
      Runner,
      { name: job.name },
      { conversationId: job.rootId, ownership: { kind: "conversation" }, background: true },
    );
  }

  const text = (maxLength: number, description: string) =>
    Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

  return defineExtension({
    name: "monchu.jobs",
    tasks: [Runner],
    tools: [
      defineTool({
        name: "job_create",
        description:
          "Create a durable background job that runs while Monchu is open and survives restarts. kind schedule: a cron expression in the device's local time (five fields, or @hourly/@daily/@weekly/@monthly); at each slot your prompt goes to the job's worker, with the command's output when a command is given. A slot missed while Monchu was closed runs once on startup. kind watch: polls a shell command every N minutes and wakes the worker only when its output changes or the command fails (first poll takes a baseline); unchanged polls wake no model. Commands must be read-only and safe to rerun, for example `gh pr view 12 --json state,reviews,statusCheckRollup`. A job created by a worker wakes that worker; one created by the front starts its own worker, job-<name>. The worker's answer reaches the front only when it starts with NEEDS USER. Every job is listed globally (job_list, /jobs).",
        parameters: Type.Object(
          {
            name: Type.String({
              pattern: "^[a-z][a-z0-9-]{0,39}$",
              description: "Unique job name, for example pr-123-ci",
            }),
            kind: StringEnum(["schedule", "watch"] as const),
            schedule: Type.Optional(text(100, "Cron expression, for schedule jobs")),
            every: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 1440,
                description: "Minutes between polls, for watch jobs (default 5)",
              }),
            ),
            command: Type.Optional(text(4000, "Shell command; required for watch jobs")),
            prompt: text(4000, "What the worker should do when the job fires"),
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
          } else if (args.command === undefined) throw new Error("A watch job needs command");
          const cwd = args.cwd ?? (await api.agent(context)).cwd;
          if (cwd === undefined) throw new Error("No directory: pass cwd");
          const job = await api.commit(async (tx) => {
            const state = await tx.doc(JobsDoc);
            if (state.jobs.some((item) => item.name === args.name))
              throw new Error(`A job named ${args.name} exists; pick another name or delete it`);
            const { rootId, owner } = await caller(tx, api.conversationId);
            const base = { name: args.name, rootId };
            const job: Job = {
              ...base,
              kind: args.kind,
              ...(args.kind === "schedule" && schedule !== undefined
                ? { schedule }
                : { every: args.every ?? 5 }),
              ...(args.command === undefined ? {} : { command: args.command }),
              prompt: args.prompt,
              cwd,
              owner,
              createdBy: owner?.worker ?? "front",
              createdAt: Date.now(),
              status: "active",
              taskId: await startRunner(tx, base),
              runs: 0,
            };
            state.jobs.push(job);
            addEvent(state, {
              at: job.createdAt,
              job: job.name,
              kind: "created",
              text: describeJob(job),
            });
            return job;
          }, context);
          return { content: [{ type: "text", text: `Created: ${formatJob(job)}` }] };
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
          "Pause, resume, run now, or delete a background job by name. Any worker or the front may manage any job.",
        parameters: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            action: StringEnum(["pause", "resume", "run_now", "delete"] as const),
          },
          { additionalProperties: false },
        ),
        replay: "safe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const result = await api.commit(async (tx) => {
            const state = await tx.doc(JobsDoc);
            const index = state.jobs.findIndex((item) => item.name === args.name);
            const job = state.jobs[index];
            if (job === undefined) throw new Error(`No job named ${args.name}`);
            const at = Date.now();
            switch (args.action) {
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
                addEvent(state, { at, job: job.name, kind: "deleted", text: "deleted" });
                return `Deleted ${job.name}`;
            }
          }, context);
          return { content: [{ type: "text", text: result }] };
        },
      }),
    ],
  });
}

function describeJob(job: Job): string {
  return job.kind === "schedule"
    ? `schedule ${job.schedule ?? ""}`
    : `watch every ${job.every ?? 5}m: ${job.command ?? ""}`;
}

const time = (at: number | undefined) => (at === undefined ? "never" : slotKey(at));

/** One job on one line, as `job_list` and `/jobs` show it. */
function formatJob(job: Job): string {
  return `${job.name} (${job.status}) ${describeJob(job).slice(0, 120)} · worker ${job.owner?.worker ?? `job-${job.name}`} · by ${job.createdBy} · runs ${job.runs}, last ${time(job.lastRunAt)}, next ${job.status === "active" ? time(job.nextAt) : "-"}`;
}

export function formatJobs(jobs: readonly Job[]): string {
  return jobs.length === 0 ? "No jobs." : jobs.map((job) => `- ${formatJob(job)}`).join("\n");
}

/** One job event as a client line: `job · <name> · <kind>[ → worker] · <text>`. */
export function formatJobEvent(event: JobEvent): string {
  return `job · ${event.job} · ${event.kind}${event.worker === undefined ? "" : ` → ${event.worker}`} · ${event.text}`;
}
