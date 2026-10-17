import type { JobEvent, RootSummary } from "../api/client.ts";
import { shortId } from "../api/ids.ts";

/** One job event as a client line: `job · <name> · <kind>[ → worker] · <text>`. */
export function formatJobEvent(event: JobEvent): string {
  return `job · ${event.job} · ${event.kind}${event.worker === undefined ? "" : ` → ${event.worker}`} · ${event.text}`;
}

/** The root a job event belongs to, by full id: its job's root, or the first root for events from before roots. */
export function jobEventRoot(
  event: JobEvent,
  roots: readonly Pick<RootSummary, "id">[],
): string | undefined {
  return event.rootId === undefined ? roots[0]?.id : shortId(event.rootId);
}
