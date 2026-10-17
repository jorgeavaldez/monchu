/**
 * The page's own telemetry, into the core's log through `Client.record`: ready time, reconnects, errors by kind and
 * place (never their messages, which may quote content), long tasks, how long a core update takes to paint, and how
 * long a keystroke takes to reach the screen.
 */
import { options } from "preact";
import type { Client } from "../api/client.ts";

const FLUSH_MS = 60_000;

/**
 * Virtual nodes created since the page loaded: the work every render does, so a keystroke or a streamed token that
 * re-renders more than it should shows here. The web check reads it as `monchuPerf.vnodes`.
 */
let vnodes = 0;
const previous = options.vnode?.bind(options);
options.vnode = (vnode) => {
  vnodes += 1;
  previous?.(vnode);
};
Object.defineProperty(globalThis, "monchuPerf", {
  value: {
    get vnodes() {
      return vnodes;
    },
  },
});

/** p50, p95 and max of `values`, rounded to ms. */
function spread(values: number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (share: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0);
  return { p50Ms: at(0.5), p95Ms: at(0.95), maxMs: Math.round(sorted.at(-1) ?? 0) };
}

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
  // Each keystroke, from its event to the task after the next frame: what typing feels like on this device. The
  // slowest one's split, from the browser's event timing, says whether the time went to waiting, to the page's own
  // handlers, or to rendering.
  const keys: number[] = [];
  let slowest: { delayMs: number; handlersMs: number; renderMs: number; ms: number } | undefined;
  addEventListener(
    "keydown",
    (event) => {
      const at = event.timeStamp;
      requestAnimationFrame(() => {
        const after = new MessageChannel();
        after.port1.onmessage = () => keys.push(performance.now() - at);
        after.port2.postMessage(undefined);
      });
    },
    { capture: true, passive: true },
  );
  // From 16 ms rather than the default 104; TypeScript's DOM types don't list `durationThreshold` yet.
  const events = { type: "event", durationThreshold: 16 };
  if (PerformanceObserver.supportedEntryTypes.includes("event"))
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry instanceof PerformanceEventTiming) || entry.name !== "keydown") continue;
        if (entry.duration <= (slowest?.ms ?? 0)) continue;
        slowest = {
          ms: Math.round(entry.duration),
          delayMs: Math.round(entry.processingStart - entry.startTime),
          handlersMs: Math.round(entry.processingEnd - entry.processingStart),
          renderMs: Math.round(entry.startTime + entry.duration - entry.processingEnd),
        };
      }
    }).observe(events);
  const paints: number[] = [];
  const flush = () => {
    if (longTasks > 0)
      client.record("web", "long tasks", { count: longTasks, maxMs: Math.round(longest) });
    longTasks = 0;
    longest = 0;
    if (keys.length > 0) {
      const typed = keys.splice(0);
      client.record("web", "typing", {
        keys: typed.length,
        ...spread(typed),
        ...(slowest === undefined
          ? {}
          : {
              slowestMs: slowest.ms,
              delayMs: slowest.delayMs,
              handlersMs: slowest.handlersMs,
              renderMs: slowest.renderMs,
            }),
      });
      slowest = undefined;
    }
    if (paints.length === 0) return;
    const painted = paints.splice(0);
    const { p50Ms, maxMs } = spread(painted);
    client.record("web", "paint", { count: painted.length, p50Ms, maxMs });
  };
  setInterval(flush, FLUSH_MS);
  // A phone puts the page away without warning; what it measured goes before it does.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  return {
    /** A core update received at `received` was rendered; this measures until the frame after it. */
    painted(received) {
      requestAnimationFrame(() => paints.push(performance.now() - received));
    },
  };
}
