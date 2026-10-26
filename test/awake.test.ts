import { describe, expect, it } from "vitest";
import { afterAwake, retry, Wake } from "../src/api/awake.ts";
import { waitFor } from "./support.ts";

/** The process stops running for `ms`, as a frozen page or a sleeping laptop does: timers come due but none fires. */
function freeze(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

describe("patience over a sleep", () => {
  it("keeps trying after a sleep longer than its patience", async () => {
    let tries = 0;
    const answered = await retry(
      async () => {
        tries++;
        // Asleep during the wait before the next try, far past the patience; the first try after it fails too, as
        // one does while a phone's network comes back.
        if (tries === 1) setTimeout(() => freeze(1000), 0);
        return tries === 3;
      },
      { patience: () => 300, stop: () => false },
    );
    expect(answered).toBe(true);
    expect(tries).toBe(3);
  });

  it("gives up once its patience is spent trying", async () => {
    let tries = 0;
    const started = Date.now();
    const answered = await retry(
      async () => {
        tries++;
        return false;
      },
      { patience: () => 300, stop: () => false },
    );
    expect(answered).toBe(false);
    expect(tries).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("tries at once when woken", async () => {
    const wake = new Wake();
    let tries = 0;
    const answering = retry(
      async () => {
        tries++;
        return tries === 6;
      },
      { patience: () => 60_000, stop: () => false, wake },
    );
    // Five tries in, the next waits a second: woken, it comes now.
    await waitFor(() => tries === 5);
    const woken = Date.now();
    wake.wake();
    expect(await answering).toBe(true);
    expect(Date.now() - woken).toBeLessThan(500);
  });

  it("counts a deadline in awake time", async () => {
    let fired = false;
    afterAwake(1500, () => {
      fired = true;
    });
    let checked: boolean | undefined;
    setTimeout(() => {
      freeze(2000);
      // Due after the frozen step, so it runs after it: two seconds asleep counted as one.
      setTimeout(() => (checked = fired), 0);
    }, 0);
    await waitFor(() => checked !== undefined);
    expect(checked).toBe(false);
    await waitFor(() => fired, 3000);
  });
});
