/**
 * The core as a child process of the server, through Chord's host manager: one core per home (a kernel lock the child
 * takes before it opens the store), started when a client needs it, closed gracefully (the child runs Durable's
 * `close`), and only then killed if it hangs past the grace period.
 *
 * It is also the core's supervisor, so nothing in the home can keep Monchu down. A core that fails to start (it throws,
 * exits or hangs past the ready timeout) is started again at once in safe mode, without home plugins: those are the
 * only code the home adds. A core that crashes once it ran is started again; a second crash within `REPEAT_MS` starts
 * it in safe mode. Safe mode lasts until a person's `/restart`. Each core told why it was started again says so to the
 * front (`RECOVERY_ENV`); durable work it accepted resumes there.
 */
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ChordError, ipcLink, type Link } from "@earendil-works/chord";
import {
  createHostManager,
  forkDriver,
  type ControlMessage,
  type Driver,
  type Exit,
} from "@earendil-works/chord/node";
import type { ServerStatus } from "../api/contract.ts";
import type { CoreProcess } from "./host.ts";

/** One name per home, for the core's and the server's locks. */
export function lockName(home: string, role: "core" | "server"): string {
  return `monchu-${role}-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}`;
}

/** The variable Chord's `childControl().lock()` reads its lock name from. */
const LOCK_ENV = "CHORD2_LOCK";

/** What a core started again is told: a `Recovery` as JSON (see `readRecovery`). */
const RECOVERY_ENV = "MONCHU_RECOVERY";

/** Why a core was started again, and whether it runs in safe mode (no home plugins). */
export type Recovery = { readonly safe: boolean; readonly reason: string; readonly at: number };

/** The recovery a core was started with, or `undefined` for an ordinary start. Never throws. */
export function readRecovery(
  env: Readonly<Record<string, string | undefined>>,
): Recovery | undefined {
  const raw = env[RECOVERY_ENV];
  if (raw === undefined || raw === "") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "safe" in value &&
      typeof value.safe === "boolean" &&
      "reason" in value &&
      typeof value.reason === "string" &&
      "at" in value &&
      typeof value.at === "number"
    )
      return { safe: value.safe, reason: value.reason, at: value.at };
  } catch {
    // Unreadable: safe mode all the same, since only a supervisor sets it.
  }
  return { safe: true, reason: "the server asked for safe mode", at: Date.now() };
}

/** A second crash this soon after the last one starts the core in safe mode. */
const REPEAT_MS = 10 * 60_000;
/** Crashes in a row, each soon after its start, before the server stops starting the core on its own. */
const MAX_RESTARTS = 5;
/** A core that ran this long without crashing resets the count. */
const STABLE_MS = 60_000;
/** The end of a failed core's standard error kept for its reason. */
const TAIL_LINES = 12;
const TAIL_CHARS = 1500;

/**
 * Windows has no process groups, and a detached child there gets a console window of its own: Chord's fork driver does
 * both. This one forks the child hidden and attached, the same way otherwise; the child closes itself when its parent
 * goes (see `child.ts`), which is what the group kill is for elsewhere.
 */
function windowsDriver(options: {
  entry: string;
  args: readonly string[];
  lock: string;
  env: Readonly<Record<string, string>>;
  onOutput(stream: "stdout" | "stderr", chunk: Uint8Array): void;
}): Driver {
  return {
    spawn() {
      const child = fork(options.entry, [...options.args], {
        env: { ...process.env, ...options.env, [LOCK_ENV]: options.lock },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      // Mirrored, as Chord's fork driver does with a tap.
      for (const stream of ["stdout", "stderr"] as const)
        child[stream]?.on("data", (chunk: Buffer) => {
          options.onOutput(stream, chunk);
          process[stream].write(chunk);
        });
      const listeners = new Set<(message: ControlMessage) => void>();
      child.on("message", (message: unknown) => {
        const control =
          typeof message === "object" && message !== null && "chord2control" in message
            ? message.chord2control
            : undefined;
        if (isControl(control)) for (const listener of listeners) listener(control);
      });
      return {
        pid: child.pid ?? -1,
        link: ipcLink(child),
        exited: new Promise<Exit>((done) =>
          child.once("exit", (code, signal) => done({ code, signal })),
        ),
        send: (message) => {
          // A child that exited before the channel said so fails the write: its exit is what counts.
          if (child.connected) child.send({ chord2control: message }, () => {});
        },
        killTree: () => child.kill(),
        onControl: (listener) => listeners.add(listener),
      };
    },
  };
}

function isControl(value: unknown): value is ControlMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    ["init", "ready", "fatal", "shutdown", "status"].includes(value.type)
  );
}

/** A moment for a dead child's last output to arrive. */
const settled = () => new Promise<void>((done) => setTimeout(done, 100));

/** The last lines of a failed core's standard error, after its reason, or nothing. */
function tailText(lines: readonly string[]): string {
  const text = lines.join("\n").slice(-TAIL_CHARS);
  return text === "" ? "" : `:\n${text}`;
}

function exitText(exit: Exit): string {
  return exit.signal === null ? `exit code ${exit.code ?? "?"}` : `signal ${exit.signal}`;
}

/**
 * The core process: `entry` with `args` runs a core child for `home`, supervised (see the top of this file). `env` is
 * read at every start, so the server can hand the next core what it needs to say (an update's outcome).
 */
export function forkedCore(options: {
  home: string;
  entry: string;
  args: readonly string[];
  env: Record<string, string>;
  onExit(exit: Exit): void;
  /**
   * A core that ran went down on its own. The server starts the next one in `restartIn` ms; `undefined` once it crashed
   * too often in a row, when only a client that needs it starts it.
   */
  onCrash(crash: { reason: string; safe: boolean; restartIn: number | undefined }): void;
}): CoreProcess {
  const lock = lockName(options.home, "core");
  /** The environment of the child spawned next: `options.env` and its recovery, filled at each spawn. */
  const env: Record<string, string> = {};
  /** The running or last child's standard error, line by line, to say why it failed. */
  let tail: string[] = [];
  let partial = "";
  const onOutput = (stream: "stdout" | "stderr", chunk: Uint8Array) => {
    if (stream !== "stderr") return;
    const lines = (partial + Buffer.from(chunk).toString("utf8")).split(/\r?\n/);
    partial = lines.pop() ?? "";
    tail.push(...lines.filter((line) => line.trim() !== ""));
    if (tail.length > TAIL_LINES) tail = tail.slice(-TAIL_LINES);
  };
  const inner =
    process.platform === "win32"
      ? windowsDriver({ entry: options.entry, args: options.args, lock, env, onOutput })
      : forkDriver({ entry: options.entry, args: options.args, lock, env, onOutput });
  /** Safe mode for every core this server starts, until a person's `/restart`. */
  let safe = false;
  /** What the next core is told about why it starts; cleared once one runs outside safe mode. */
  let recovery: Recovery | undefined;
  const driver: Driver = {
    spawn() {
      tail = [];
      partial = "";
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, options.env);
      const told =
        recovery ?? (safe ? { safe, reason: "an earlier core failed", at: Date.now() } : undefined);
      if (told !== undefined) env[RECOVERY_ENV] = JSON.stringify({ ...told, safe });
      return inner.spawn();
    },
  };
  const listeners = new Set<() => void>();
  let pid: number | null = null;
  let since: number | null = null;
  /** Children this server asked to stop: their exit is no crash. */
  const stopped = new Set<number>();
  /** Stops asked so far: a start that fails because one came meanwhile is no failure of the core. */
  let stops = 0;
  let crashes = 0;
  let lastCrash: number | undefined;
  const manager = createHostManager({
    driver,
    // Durable's close ends running work cleanly; a store with much to flush gets time for it.
    grace: 15_000,
    // Past this a core that hasn't said it is ready counts as failed, and the next starts in safe mode.
    readyTimeout: 60_000,
    onExit: (exit) => {
      const exited = pid;
      const ran = since;
      pid = null;
      since = null;
      changed();
      options.onExit(exit);
      // A start that failed is `running`'s to handle.
      if (exited === null || stopped.delete(exited)) return;
      const now = Date.now();
      if (ran !== null && now - ran >= STABLE_MS) crashes = 0;
      crashes++;
      if (lastCrash !== undefined && now - lastCrash < REPEAT_MS) safe = true;
      lastCrash = now;
      const count = crashes;
      const crashed = `it crashed (${exitText(exit)})`;
      recovery = { safe, reason: crashed, at: now };
      // The stack it printed as it died can arrive after its exit.
      void settled().then(() => {
        const reason = `${crashed}${tailText(tail)}`;
        if (recovery?.at === now) recovery = { safe, reason, at: now };
        options.onCrash({
          reason,
          safe,
          restartIn: count > MAX_RESTARTS ? undefined : count === 1 ? 0 : 1000 * 2 ** (count - 2),
        });
      });
    },
  });
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const running = async (): Promise<Link> => {
    const asked = stops;
    let instance;
    try {
      instance = await manager.start();
    } catch (error) {
      // Safe mode failed too, another core holds the home, or a stop ended this start: nothing to recover.
      const locked = error instanceof ChordError && error.reason === "locked";
      if (safe || locked || stops !== asked) throw error;
      // Set before the wait, so no other start runs the home's plugins meanwhile.
      safe = true;
      const failed = `it failed to start (${error instanceof Error ? error.message : String(error)})`;
      recovery = { safe, reason: failed, at: Date.now() };
      await settled();
      recovery = { ...recovery, reason: `${failed}${tailText(tail)}` };
      instance = await manager.start();
    }
    if (pid !== instance.pid) {
      pid = instance.pid;
      since = Date.now();
      // Told once; in safe mode every core hears it, and the front's notice is the same request each time.
      if (!safe) recovery = undefined;
    }
    changed();
    return instance.link;
  };
  const stopping = () => {
    stops++;
    if (pid !== null) stopped.add(pid);
  };
  return {
    start: async () => {
      changed();
      return running();
    },
    replace: async () => {
      // A person's restart tries the home's plugins again.
      safe = false;
      recovery = undefined;
      crashes = 0;
      lastCrash = undefined;
      stopping();
      const stoppedNow = manager.stop();
      changed();
      await stoppedNow;
      await running();
    },
    stop: async () => {
      stopping();
      const stoppedNow = manager.stop();
      changed();
      await stoppedNow;
      changed();
    },
    get status(): ServerStatus["core"] {
      return { state: manager.status, pid, since };
    },
    onStatus: (listener) => void listeners.add(listener),
  };
}
