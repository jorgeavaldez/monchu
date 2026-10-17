import type { LogQuery, LogRecord, Severity } from "../api/logs.ts";

const SEVERITIES: readonly Severity[] = ["debug", "info", "warn", "error"];

/** `/logs [severity|scope]`: a severity word filters by severity, anything else by scope prefix. */
export function logQuery(text: string): LogQuery {
  const filter = text.trim();
  const severity = SEVERITIES.find((each) => each === filter);
  if (severity !== undefined) return { limit: 30, severity };
  return filter ? { limit: 30, scope: filter } : { limit: 30 };
}

/** One record as a line: `HH:MM:SS.mmm severity scope · body · key=value …`. */
export function formatRecord(record: LogRecord): string {
  const attributes = Object.entries(record.attributes ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `${record.time.slice(11, 23)} ${record.severity} ${record.scope} · ${record.body}${attributes ? ` · ${attributes}` : ""}`;
}
