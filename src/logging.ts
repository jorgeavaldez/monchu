import type {
  CommitChange,
  Seq,
  SettledSubmissionRecord,
  Submission,
} from "@earendil-works/pi-durable";
import type { Stage } from "./types.ts";

export function logError(stage: Stage, error: unknown): void {
  const seen = new Set<Error>();
  let cause = error;
  do {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "error",
        stage,
        ...(cause instanceof Error
          ? { name: cause.name, message: cause.message, stack: cause.stack }
          : { message: String(cause) }),
      }),
    );
    if (!(cause instanceof Error) || seen.has(cause)) break;
    seen.add(cause);
    cause = cause.cause;
    stage += ".cause";
  } while (cause !== undefined);
}

export function logStage(stage: Stage, data?: unknown): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: stage, data }));
}

export function logCommitChange(seq: Seq, change: CommitChange): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: change.type,
      seq,
      ...change,
    }),
  );
}

export function logSubmission(
  stage: Stage,
  submission: Submission | SettledSubmissionRecord,
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: stage,
      submissionId: submission.id,
      ...submission,
    }),
  );
}
