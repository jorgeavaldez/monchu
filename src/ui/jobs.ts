import type { JobEvent } from "../api/client.ts";

/** One job event as a client line: `job · <name> · <kind>[ → worker] · <text>`. */
export function formatJobEvent(event: JobEvent): string {
  return `job · ${event.job} · ${event.kind}${event.worker === undefined ? "" : ` → ${event.worker}`} · ${event.text}`;
}
