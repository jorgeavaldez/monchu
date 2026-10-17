/**
 * The page's own telemetry, into the core's log through `Client.record`: ready time, reconnects, errors by kind and
 * place (never their messages, which may quote content), long tasks, and how long a core update takes to paint.
 */
import type { Client } from "../api/client.ts";

const FLUSH_MS = 60_000;

export function telemetry(client: Client): { painted(received: number): void } {
  addEventListener("error", (event) => {
    client.record("web", "error", {
      kind: event.error instanceof Error ? event.error.name : "error",
      at: `${event.filename.split("/").at(-1) ?? ""}:${event.lineno}:${event.colno}`,
    });
  });
  addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    client.record("web", "error", { kind: reason instanceof Error ? reason.name : "rejection" });
  });
  let longTasks = 0;
  let longest = 0;
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longest = Math.max(longest, entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  const paints: number[] = [];
  setInterval(() => {
    if (longTasks > 0)
      client.record("web", "long tasks", { count: longTasks, maxMs: Math.round(longest) });
    longTasks = 0;
    longest = 0;
    if (paints.length === 0) return;
    const sorted = paints.splice(0).toSorted((a, b) => a - b);
    client.record("web", "paint", {
      count: sorted.length,
      p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
      maxMs: Math.round(sorted.at(-1) ?? 0),
    });
  }, FLUSH_MS);
  return {
    /** A core update received at `received` was rendered; this measures until the frame after it. */
    painted(received) {
      requestAnimationFrame(() => paints.push(performance.now() - received));
    },
  };
}
