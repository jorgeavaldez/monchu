/**
 * The server process: what every terminal and web page connects to, one per home. It holds no store: it runs the core
 * as its child (`process.ts`) and relays clients to it, so a `/restart` replaces the core while clients keep their
 * sockets. `serve` runs the core from the start and keeps it; a server a client started (`background`) lets the core
 * close once no client has been connected for `IDLE_MS`, then exits.
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
  /** Resolves when a signal asks the server to stop. */
  signal: Promise<void>;
  say(line: string): void;
}): Promise<ServerEnd> {
  const { home } = options;
  const unlock = await processLock(lockName(home, "server")).catch(() => {
    throw new Error(`another Monchu server runs for ${home}`);
  });
  const log = new Log(home);
  const ended = Promise.withResolvers<ServerEnd>();
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
  });
  let updating = false;
  const update = async (plan: UpdatePlan) => {
    // No client starts the core again while npm replaces its files.
    updating = true;
    await core.stop();
    options.say(`installing ${plan.url} into ${plan.prefix}`);
    const { code, tail } = await install(plan, (line) => options.say(`npm · ${line}`));
    ended.resolve({
      kind: "updated",
      outcome:
        code === 0
          ? installOutcome(VERSION, installedVersion())
          : `warning · update failed: npm exited ${code}; still on ${VERSION}\n${tail.join("\n")}`,
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
      stop: () => ended.resolve({ kind: "stopped" }),
      update: (plan) =>
        void update(plan).catch((error: unknown) => {
          log.write("error", "server.process", "update failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
          ended.resolve({ kind: "stopped" });
        }),
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
    if (options.web) {
      try {
        const config = await loadWebConfig(home);
        if (config === undefined) throw new Error(`no web.json in ${home}`);
        const site = await (
          await import("./web.ts")
        ).serveWeb(server.ingress, { home, log }, config, options.env);
        closers.push(site.close);
        options.say(
          `web · ${site.url}${config.host === undefined ? "" : ` · public host ${config.host}`}`,
        );
      } catch (error) {
        options.say(`web is off: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.mode === "serve") {
      await server.startCore();
      options.say(`core ready · pid ${server.status.core.pid ?? "?"}`);
    }
    let idleSince = Date.now();
    const idle = setInterval(() => {
      if (options.mode !== "background") return;
      if (server.status.clients > 0) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_MS) ended.resolve({ kind: "stopped" });
    }, 1000);
    void options.signal.then(() => ended.resolve({ kind: "stopped" }));
    const end = await ended.promise;
    clearInterval(idle);
    return end;
  } finally {
    // Clients first, so none starts the core again; then the core closes gracefully.
    for (const close of closers.toReversed()) await close().catch(() => {});
    await core.stop().catch(() => {});
    await server.close();
    await log.flushed();
    await unlock();
  }
}
