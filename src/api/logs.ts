/** Log records as clients read them: the OpenTelemetry log data model's fields Monchu uses, as JSON. */

export type Severity = "debug" | "info" | "warn" | "error";

/** Where a record comes from: the core, its server, or a client, then the component. */
export type LogScope = `${"core" | "server" | "tui" | "web"}${"" | `.${string}`}`;

/** Ids, sizes and timings only: never prompts, outputs or secrets. */
export type LogAttributes = Record<string, string | number | boolean | null>;

export type LogRecord = {
  /** RFC 3339 with milliseconds. */
  time: string;
  severity: Severity;
  scope: string;
  body: string;
  attributes?: LogAttributes;
};

/** Which records `/logs` shows: the newest `limit`, at or above `severity`, under a `scope` prefix. */
export type LogQuery = { limit: number; severity?: Severity; scope?: string };
