import { createConnection } from "node:net";

/** What Herdr shows for an agent pane; Herdr itself turns working then idle into `done` until the pane is seen. */
type HerdrAgentState = "working" | "blocked" | "idle";

/** Monchu's lifecycle in its Herdr pane, as Herdr's own Pi integration reports Pi's. */
export type HerdrAgent = {
  report(state: HerdrAgentState, message?: string): void;
  /** Hands the pane back to Herdr's own detection; resolves even when Herdr is gone. */
  release(): Promise<void>;
};

const SOURCE = "monchu";
const AGENT = "monchu";

/** One request on Herdr's socket API; false when Herdr didn't answer in time. */
function send(
  endpoint: string,
  method: string,
  params: object,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    const finish = (delivered: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(delivered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("data", () => finish(true));
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`, method, params })}\n`,
      ),
    );
  });
}

/**
 * The pane reporter when Monchu runs inside Herdr (`HERDR_ENV=1` with its socket and pane), otherwise undefined.
 * Reports are best effort: the newest state wins, one request at a time, and a lost one never blocks the TUI.
 */
export function herdrAgent(env: NodeJS.ProcessEnv): HerdrAgent | undefined {
  const socket = env.HERDR_SOCKET_PATH;
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socket || !pane) return undefined;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socket}` : socket;
  let seq = Date.now() * 1000;
  let last: string | undefined;
  let queued: { state: HerdrAgentState; message: string | undefined; seq: number } | undefined;
  let sending: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (queued !== undefined) {
      const next = queued;
      queued = undefined;
      const params = { pane_id: pane, source: SOURCE, agent: AGENT, ...next };
      if (!(await send(endpoint, "pane.report_agent", params, 500)))
        await send(endpoint, "pane.report_agent", params, 1500);
    }
  }

  function kick(): void {
    sending ??= drain().finally(() => {
      sending = undefined;
      // A report that arrived after the loop's last check.
      if (queued !== undefined) kick();
    });
  }

  return {
    report(state, message) {
      const key = `${state}:${message ?? ""}`;
      if (key === last) return;
      last = key;
      seq += 1;
      queued = { state, message, seq };
      kick();
    },
    async release() {
      queued = undefined;
      await sending;
      seq += 1;
      await send(
        endpoint,
        "pane.release_agent",
        { pane_id: pane, source: SOURCE, agent: AGENT, seq },
        500,
      );
    },
  };
}
