/**
 * Patience that counts time spent trying, not time on the wall clock. A locked phone freezes or throttles its page and
 * a laptop sleeps: a wait the system stretched counts only as long as it was asked to be, so a client gives up on a
 * core only once it really tried for its whole patience, and a page woken after an hour tries again rather than
 * finding its patience long spent. Browser-safe.
 */

/** The longest wait counted in one step: a stretched wait counts at most this. */
const STEP_MS = 1000;
/** How much of one try's own work (a dial) counts, however long the system stretched it. */
const TRY_MS = 10_000;

/** Cuts every wait short, so the next try comes now: the page was shown again, or the network came back. */
export class Wake {
  private readonly waits = new Set<() => void>();

  /** Wait `ms`, or less when woken; resolves with how long it counts for: never more than asked. */
  wait(ms: number): Promise<number> {
    const started = Date.now();
    return new Promise((done) => {
      const end = () => {
        clearTimeout(timer);
        this.waits.delete(end);
        done(Math.min(Date.now() - started, ms));
      };
      const timer = setTimeout(end, ms);
      this.waits.add(end);
    });
  }

  wake(): void {
    for (const end of this.waits) end();
  }
}

/**
 * Try `attempt` quickly at first (50 ms between tries, doubling to 1 s) until it returns true, `stop` says so, or
 * `patience` is spent in tries and waits. Resolves true once an attempt succeeded.
 */
export async function retry(
  attempt: () => Promise<boolean>,
  options: { patience: () => number; stop: () => boolean; wake?: Wake },
): Promise<boolean> {
  const wake = options.wake ?? new Wake();
  let used = 0;
  for (let delay = 50; !options.stop() && used < options.patience();) {
    used += await wake.wait(delay);
    if (options.stop()) return false;
    const started = Date.now();
    if (await attempt()) return true;
    used += Math.min(Date.now() - started, TRY_MS);
    delay = Math.min(delay * 2, STEP_MS);
  }
  return false;
}

/** Run `then` once `ms` of awake time has passed; returns a cancel. */
export function afterAwake(ms: number, then: () => void): () => void {
  let left = ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const asked = Math.min(left, STEP_MS);
    const at = Date.now();
    timer = setTimeout(() => {
      left -= Math.min(Date.now() - at, asked);
      if (left <= 0) then();
      else step();
    }, asked);
  };
  step();
  return () => clearTimeout(timer);
}
