export type Stage =
  | "models.create"
  | "models.diagnostics"
  | "harness.open"
  | "harness.close"
  | "harness.closed"
  | "conversation.root"
  | "submission.submit"
  | "submission.wait"
  | "submission.settled"
  | "answer.read"
  | "answer"
  | "unknown";
