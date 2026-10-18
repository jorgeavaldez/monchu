/**
 * The server process: what every terminal and web page connects to, one per home. It holds no store: it runs the core
 * as its child (`process.ts`) and relays clients to it, so a `/restart` replaces the core while clients keep their
 * sockets. `serve` runs the core from the start and keeps it; a server a client started (`background`) lets the core
 * close once no client has been connected for `IDLE_MS`, then exits, unless it serves the web client: a phone drops a
 * page's socket whenever it puts the page away, and a page can't start a server again.
 */
import { processLock } from "@earendil-works/chord/node";
import { loadWebConfig } from "../core/config.ts";
import {
  install,
  installedVersion,
  installOutcome,
  VERSION,
  type UpdatePlan,
} from "../core/update.ts";
import { Log } from "../telemetry/log.ts";
import { openServerHost } from "./host.ts";
import { forkedCore, lockName } from "./process.ts";
import { serveSocket, socketPath } from "./socket.ts";

/** How long a background server waits for a client after the last one left: long enough to reconnect. */
const IDLE_MS = 30_000;

/** Why the server ended: stopped (signal, `monchu stop`, idle), or an update that needs the new server's code. */
export type ServerEnd = { kind: "stopped" } | { kind: "updated"; outcome: string };

export async function runServer(options: {
  home: string;
  mode: "serve" | "background";
  web: boolean;
  /** The module and arguments that run a core child. */
  core: { entry: string; args: readonly string[] };
  /** What the first core is told, such as the outcome of the update this server came back from. */
  firstCoreEnv: Record<string, string>;
  env: Readonly<Record<string, string | undefined>>;
  /** Resolves with the signal's name when one asks the server to stop. */
  signal: Promise<string>;
  say(line: string): void;
}): Promise<ServerEnd> {
  const { home } = options;
  const unlock = await processLock(lockName(home, "server")).catch(() => {
    throw new Error(`another Monchu server runs for ${home}`);
  });
  const log = new Log(home);
  const ended = Promise.withResolvers<ServerEnd>();
  // Why it ends, in the log: a server that is gone without a reason there was killed.
  let reason: string | undefined;
  const stop = (why: string) => {
    if (reason === undefined)
      log.write("info", "server.process", "stopping", { reason: (reason = why) });
    ended.resolve({ kind: "stopped" });
  };
  const coreEnv = { ...options.firstCoreEnv };
  const core = forkedCore({
    home,
    entry: options.core.entry,
    args: options.core.args,
    env: coreEnv,
    onExit: (exit) =>
      log.write(exit.code === 0 ? "info" : "warn", "server.process", "core exited", {
        code: exit.code ?? -1,
        signal: exit.signal ?? "",
      }),
    // Work the core accepted waits in its store: the next core resumes it, whether or not a client is there.
    onCrash: (crash) => {
      const { restartIn } = crash;
      log.write("error", "server.process", "core crashed", {
        reason: crash.reason,
        safe: crash.safe,
        restartIn: restartIn ?? -1,
      });
      if (restartIn === undefined) {
        options.say("the core keeps crashing: the next client that needs it starts it");
        return;
      }
      const timer = setTimeout(() => {
        restarts.delete(timer);
        // Not while the server stops or installs an update.
        if (reason !== undefined || updating) return;
        void server.startCore().catch((error: unknown) =>
          log.write("error", "server.process", "core restart failed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }, restartIn);
      restarts.add(timer);
    },
  });
  const restarts = new Set<ReturnType<typeof setTimeout>>();
  let site: { url: string; close(): Promise<void> } | undefined;
  let opening: Promise<string> | undefined;
  const openWeb = async (): Promise<string> => {
    const config = await loadWebConfig(home);
    if (config === undefined) throw new Error(`no web.json in ${home}`);
    site = await (
      await import("./web.ts")
    ).serveWeb(server.ingress, { home, log }, config, options.env);
    options.say(
      `web · ${site.url}${config.host === undefined ? "" : ` · public host ${config.host}`}`,
    );
    return site.url;
  };
  const web = {
    get url() {
      return site?.url ?? null;
    },
    // Once: a failed start (a port in use) may be asked again.
    start: () =>
      (opening ??= openWeb().catch((error: unknown) => {
        opening = undefined;
        throw error;
      })),
  };
  let updating = false;
  const update = async (plan: UpdatePlan) => {
    // No client starts the core again while npm replaces its files.
    updating = true;
    await core.stop();
    options.say(`installing ${plan.url} into ${plan.prefix}`);
    const installed = await install(plan, (line) => options.say(`npm · ${line}`));
    ended.resolve({
      kind: "updated",
      outcome: installed.ok
        ? installOutcome(VERSION, installedVersion())
        : `warning · update failed: ${installed.reason}; still on ${VERSION}\n${installed.tail.join("\n")}`,
    });
  };
  const server = openServerHost(
    {
      ...core,
      get status() {
        return core.status;
      },
      start: () =>
        updating ? Promise.reject(new Error("Monchu is installing an update")) : core.start(),
    },
    {
      mode: options.mode,
      log,
      stop: () => stop("monchu stop"),
      update: (plan) =>
        void update(plan).catch((error: unknown) => {
          log.write("error", "server.process", "update failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
          stop("update failed");
        }),
      web,
    },
  );
  // Only the first core hears what the server came back from.
  core.onStatus(() => {
    if (core.status.state === "running")
      for (const key of Object.keys(coreEnv)) delete coreEnv[key];
  });
  const path = socketPath(home);
  const closers: (() => Promise<void>)[] = [];
  try {
    closers.push((await serveSocket(server.ingress, log, path)).close);
    options.say(`serving ${home} on ${path}`);
    if (options.web)
      await web.start().catch((error: unknown) => {
        options.say(`web is off: ${error instanceof Error ? error.message : String(error)}`);
      });
    log.write("info", "server.process", "started", {
      mode: options.mode,
      pid: process.pid,
      version: VERSION,
      web: site?.url ?? "",
    });
    if (options.mode === "serve") {
      await server.startCore();
      options.say(`core ready · pid ${server.status.core.pid ?? "?"}`);
    }
    let idleSince = Date.now();
    const idle = setInterval(() => {
      if (options.mode !== "background") return;
      if (server.status.clients > 0 || site !== undefined) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_MS) stop("idle");
    }, 1000);
    void options.signal.then(stop);
    const end = await ended.promise;
    clearInterval(idle);
    return end;
  } finally {
    for (const timer of restarts) clearTimeout(timer);
    // Clients first, so none starts the core again; then the core closes gracefully.
    await site?.close().catch(() => {});
    for (const close of closers.toReversed()) await close().catch(() => {});
    await core.stop().catch(() => {});
    await server.close();
    await log.flushed();
    await unlock();
  }
}
