/**
 * The core as a child process of the server, through Chord's host manager: one core per home (a kernel lock the child
 * takes before it opens the store), started when a client needs it, closed gracefully (the child runs Durable's
 * `close`), and only then killed if it hangs past the grace period.
 */
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ipcLink, type Link } from "@earendil-works/chord";
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
}): Driver {
  return {
    spawn() {
      const child = fork(options.entry, [...options.args], {
        env: { ...process.env, ...options.env, [LOCK_ENV]: options.lock },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        windowsHide: true,
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

/**
 * The core process: `entry` with `args` runs a core child for `home`. `env` is read at every start, so the server can
 * hand the next core what it needs to say (an update's outcome).
 */
export function forkedCore(options: {
  home: string;
  entry: string;
  args: readonly string[];
  env: Record<string, string>;
  onExit(exit: Exit): void;
}): CoreProcess {
  const lock = lockName(options.home, "core");
  const driver =
    process.platform === "win32"
      ? windowsDriver({ entry: options.entry, args: options.args, lock, env: options.env })
      : forkDriver({ entry: options.entry, args: options.args, lock, env: options.env });
  const listeners = new Set<() => void>();
  let pid: number | null = null;
  let since: number | null = null;
  const manager = createHostManager({
    driver,
    // Durable's close ends running work cleanly; a store with much to flush gets time for it.
    grace: 15_000,
    readyTimeout: 60_000,
    onExit: (exit) => {
      pid = null;
      since = null;
      changed();
      options.onExit(exit);
    },
  });
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const running = async (): Promise<Link> => {
    const instance = await manager.start();
    if (pid !== instance.pid) {
      pid = instance.pid;
      since = Date.now();
    }
    changed();
    return instance.link;
  };
  return {
    start: async () => {
      changed();
      return running();
    },
    replace: async () => {
      const replaced = manager.replace();
      changed();
      await replaced;
      changed();
    },
    stop: async () => {
      const stopped = manager.stop();
      changed();
      await stopped;
      changed();
    },
    get status(): ServerStatus["core"] {
      return { state: manager.status, pid, since };
    },
    onStatus: (listener) => void listeners.add(listener),
  };
}
