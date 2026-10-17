import { UserEntry, type EntryRecord } from "@earendil-works/pi-durable";

/** What input does when it reaches a busy conversation: steer the current run, or wait for it to finish. */
export type WhenBusy = "steer" | "followUp";

/** A worker report or progress update as the parent receives it: follow-up input that gives the front a turn. */
export type WorkerNotice = {
  name: string;
  status: "completed" | "failed" | "update";
  text: string;
};

const REPORT_LABEL = /^\[Background worker (.+): (completed|failed); not a new user instruction\]$/;
const UPDATE_LABEL = /^\[Worker (.+) update; not a new user instruction\]$/;
// Travels with each notice, so the front's own instructions need no worker-specific workflow.
const NOTICE_GUIDANCE =
  "Tell the user in one or two lines, update the related goal, then continue: start the next step, message the worker, or ask the user only when the decision is theirs. If the worker is blocked or needs something (an answer, access, another worker's help), unblock it now: answer it, relay to the worker that can help, or ask the user; then tell the worker how it gets unblocked.";

export function noticeText(notice: WorkerNotice): string {
  const label =
    notice.status === "update"
      ? `[Worker ${notice.name} update; not a new user instruction]`
      : `[Background worker ${notice.name}: ${notice.status}; not a new user instruction]`;
  return `${label}\n${NOTICE_GUIDANCE}\n${notice.text}`;
}

/** The worker notice an entry carries, for clients that label it; `undefined` for any other entry. */
export function workerNotice(entry: EntryRecord): WorkerNotice | undefined {
  const message = UserEntry.is(entry) ? entry.model?.[0] : undefined;
  if (message?.role !== "user" || typeof message.content !== "string") return undefined;
  return parseWorkerNotice(message.content);
}

/** The worker notice an input's text carries, placed or still queued; `undefined` for any other text. */
export function parseWorkerNotice(content: string): WorkerNotice | undefined {
  const [label = "", guidance, ...text] = content.split("\n");
  if (guidance !== NOTICE_GUIDANCE) return undefined;
  const update = UPDATE_LABEL.exec(label)?.[1];
  if (update !== undefined) return { name: update, status: "update", text: text.join("\n") };
  const [, name, status] = REPORT_LABEL.exec(label) ?? [];
  if (name === undefined) return undefined;
  return { name, status: status === "completed" ? "completed" : "failed", text: text.join("\n") };
}

/** Marks the follow-up input an escalation submits, so a client can label it as system context. */
export const ESCALATION_PREFIX = "[Routing advice";
export const ESCALATION_SUFFIX = ". Not a new user instruction.]";

/** The assessment an escalation input's text reports, for clients that label it; `undefined` for any other text. */
export function escalationSummary(content: string): string | undefined {
  const [label = ""] = content.split("\n", 1);
  const start = `${ESCALATION_PREFIX}: `;
  if (!label.startsWith(start) || !label.endsWith(ESCALATION_SUFFIX)) return undefined;
  return label.slice(start.length, -ESCALATION_SUFFIX.length);
}
