import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ModelRole } from "./config.ts";

/**
 * What a job is. `agent`: on a cron schedule, wake a worker with the job's prompt. `command`: on a cron schedule, run a
 * command with no model call, and wake the worker only when its output changes or it fails anew. `bg`: run a command
 * once in the background now, and wake the worker when it ends.
 */
type JobType = "agent" | "command" | "bg";

/** The worker a job wakes: by name under `parentId`; the job starts it, on `role`, if it does not exist then. */
export type JobWorker = { parentId: ConversationId; name: string };

/** Who hears a job by its `notify`: a root's front, or a worker by name under `parentId`. */
export type JobTarget =
  | { kind: "front"; rootId: ConversationId }
  | ({ kind: "worker" } & JobWorker);

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
  /** `bg`: killed because a worker it wakes was stopped, so its end wakes no one. */
  stopped?: true;
  ended?: BgEnd;
};

/** How a `bg` job ended. `interrupted`: Monchu quit or restarted while it ran, which kills it. */
export type BgEnd = {
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

/** What a client may do to a job: pause or resume a schedule, or run it now. */
export type JobControl = "pause" | "resume" | "run_now";

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

export function addEvent(
  state: JobsState,
  job: Pick<Job, "name" | "rootId">,
  event: Omit<JobEvent, "id" | "job" | "rootId">,
): void {
  state.events.push({ id: state.nextEvent++, job: job.name, rootId: job.rootId, ...event });
  if (state.events.length > EVENTS_KEPT) state.events.splice(0, state.events.length - EVENTS_KEPT);
}

/** Who hears `job` when it fires or ends: the targets its `notify` names, or else its own worker. */
export function targetsOf(job: Job): readonly JobTarget[] {
  return job.notify ?? [{ kind: "worker", ...job.worker }];
}

/** Whether `target` is `worker`. */
export function isWorker(target: JobTarget, worker: JobWorker): boolean {
  return (
    target.kind === "worker" && target.parentId === worker.parentId && target.name === worker.name
  );
}
