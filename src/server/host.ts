/**
 * Monchu's Chord hosts. The core's host serves the backend to the facets as `Core` and loads them. The server's host
 * is what clients connect to: it relays their references to the core through a route that starts the core when one
 * is needed, and serves `Server`. Connections come in through `socket.ts` and `web.ts`, which stamp each one's
 * principal and hand its socket to an `Ingress`.
 */
import {
  ChordError,
  createHost,
  hostNamed,
  method,
  remote,
  webSocketLink,
  type Host,
  type Link,
  type WebSocketLike,
} from "@earendil-works/chord";
import { Type } from "typebox";
import { principalKey, Server, type Principal, type ServerStatus } from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import type { UpdatePlan } from "../core/update.ts";
import type { Log } from "../telemetry/log.ts";
import { Core } from "./core.ts";

export type CoreHost = Host<Principal>;

/**
 * Reloads of the core's code, which only the core asks for: the server runs them, so the core and the server move to
 * the new code version together (a child that reloads alone runs ahead of its parent). Not part of `Server`, so a core
 * newer than its server still restarts.
 */
export const Reloads = remote("monchu.reloads", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("server"),
  variants: {
    core: {
      methods: {
        /** Reload these facet modules on the core. */
        reload: method(Type.Object({ modules: Type.Array(Type.String({ minLength: 1 })) })),
      },
    },
  },
});

/**
 * The server and its core are processes on one machine, and the IPC channel says when either goes. A phone that froze
 * both for longer than Chord's 45 second ping timeout would otherwise close their link when they wake, leaving a
 * running core no client can reach.
 */
const LOCAL_PING_TIMEOUT = Number.POSITIVE_INFINITY;

const failures = (log: Log) => (error: unknown) =>
  log.write("warn", "server.chord", "background failure", {
    reason: error instanceof Error ? error.message : String(error),
  });

/**
 * Serve a running backend on its core host: the wire's facet, and `Core` for it. The backend closes the host when it
 * closes. `upstream` is the link to the server when the core runs as its child.
 */
export async function openCoreHost(backend: Monchu, upstream?: Link): Promise<CoreHost> {
  const host = backend.host;
  if (upstream !== undefined)
    host.connect(upstream, { principal: { kind: "server" }, pingTimeout: LOCAL_PING_TIMEOUT });
  host.serve(
    Core,
    (_input, _principal, self) => ({
      monchu: self.expose(self.resource("monchu", { version: 1, open: () => backend })),
    }),
    { lifetime: "host" },
  );
  // By URL, so Chord's loader can import a fresh copy at each reload: TypeScript from source, JavaScript once built.
  await backend.loadFacets([
    new URL(`./session.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href,
  ]);
  return host;
}

/** Calls one client may have running at once: far above what a person does, low enough to bound a runaway page. */
const MAX_CALLS = 64;

/** Where authenticated client sockets go: the host that serves them, which counts them. */
export type Ingress = {
  /** Serve one socket, every request on it acting as `principal`; resolves when it closes. */
  accept(socket: WebSocketLike, principal: Principal): Promise<string>;
  /** Close a client connection and dispose what it opened, as when its login is revoked. */
  revoke(connection: string): Promise<void>;
};

/**
 * Accept one client socket on `host`. Large payloads go out deflated, and the client may not send packed frames (a
 * small message could inflate to anything).
 */
function acceptOn(host: Host<Principal>, socket: WebSocketLike, principal: Principal) {
  const link = webSocketLink(socket, { compress: true, acceptPacked: false });
  const closed = new Promise<string>((done) => link.onClose(done));
  host.accept(link, { principal, kind: "client", maxCalls: MAX_CALLS });
  return closed;
}

/** Clients straight onto a host: the core's own, in tests and when nothing sits between them. */
export function ingress(host: Host<Principal>): Ingress {
  return {
    accept: (socket, principal) => acceptOn(host, socket, principal),
    revoke: (connection) => host.invalidatePrincipal({ kind: "client", connection }),
  };
}

/** The core process as the server runs it: started on demand, replaced for `/restart`, stopped when idle. */
export type CoreProcess = {
  /** The link to a running core, started first when none runs; one core at a time. */
  start(): Promise<Link>;
  /** Close the core gracefully, then start a new one. */
  replace(): Promise<void>;
  stop(): Promise<void>;
  readonly status: ServerStatus["core"];
  /** Hears each change of `status`. */
  onStatus(listener: () => void): void;
};

export type ServerHost = {
  readonly host: Host<Principal>;
  /** Start the core now, as `serve` does, rather than when a client first needs it. */
  startCore(): Promise<void>;
  readonly ingress: Ingress;
  readonly status: ServerStatus;
  /** Hears each change of `status`. */
  onStatus(listener: (status: ServerStatus) => void): () => void;
  close(): Promise<void>;
};

/**
 * The server's host over a core process. `stop` is what a person's `monchu stop` asks for: the caller stops the core
 * and exits. `web` serves the web client, once, when a person asks for it.
 */
export function openServerHost(
  core: CoreProcess,
  options: {
    mode: ServerStatus["mode"];
    log: Log;
    stop(): void;
    update(plan: UpdatePlan): void;
    web: { readonly url: string | null; start(): Promise<string> };
  },
): ServerHost {
  const host = createHost<Principal>({
    name: "server",
    self: { kind: "server" },
    principalKey,
    onError: failures(options.log),
  });
  // Each new core is admitted as soon as it runs, before a client needs it: an unanswered link times out.
  const admitted = new WeakSet<Link>();
  let replacing: Promise<void> | undefined;
  const reach = async () => {
    let link = await core.start();
    if (link.closed) {
      // A closed link never opens again, and the core behind it runs on: only a new core answers clients.
      replacing ??= (async () => {
        options.log.write("warn", "server.process", "core link lost", {
          pid: core.status.pid ?? -1,
        });
        await core.replace();
      })().finally(() => (replacing = undefined));
      await replacing;
      link = await core.start();
    }
    if (!admitted.has(link)) {
      admitted.add(link);
      host.accept(link, {
        principal: { kind: "core" },
        kind: "host",
        name: "core",
        pingTimeout: LOCAL_PING_TIMEOUT,
      });
    }
    return link;
  };
  // Only what connected through a socket, and the server itself, reach the core: never a forwarded principal.
  host.route("core", {
    authorize: (principal) => principal.kind !== "core",
    resolve: reach,
    principal: () => ({ kind: "core" }),
  });
  let clients = 0;
  const listeners = new Set<(status: ServerStatus) => void>();
  const status = (): ServerStatus => ({
    mode: options.mode,
    pid: process.pid,
    core: core.status,
    clients,
    web: options.web.url,
  });
  const changed = () => {
    const now = status();
    for (const listener of listeners) listener(now);
  };
  core.onStatus(changed);
  host.serve(Server, (_input, principal, self) => {
    const source = self.resource("status", {
      version: 1,
      open: () => {
        let stop = () => {};
        return {
          subscribe(listener: (value: ServerStatus) => void) {
            listeners.add(listener);
            listener(status());
            stop = () => listeners.delete(listener);
            return stop;
          },
          stop: () => stop(),
        };
      },
      close: (value) => value.stop(),
    });
    const state = self.state("status", Type.Unsafe<ServerStatus>(Type.Unknown()), status());
    self.on("status", source, (value, ctx) => state.replace(ctx, value, { diff: true }));
    if (principal.kind === "core")
      return {
        variant: "core",
        state,
        // Answered first: the core that asks is the one that goes.
        replace: () =>
          void setTimeout(() => void core.replace().then(reach).catch(failures(options.log)), 0),
        update: ({ plan }) => void setTimeout(() => options.update(plan), 0),
      };
    if (principal.kind === "client" && !principal.person) return { variant: "viewer", state };
    return {
      variant: "owner",
      state,
      stop: () => void setTimeout(() => options.stop(), 0),
      web: async () => {
        const url = await options.web.start();
        changed();
        return url;
      },
    };
  });
  host.serve(Reloads, (_input, principal) => {
    if (principal.kind !== "core")
      throw new ChordError("forbidden", "Only the core reloads its code");
    return {
      variant: "core",
      reload: async ({ modules }) => {
        await host.reload([], { remote: { core: modules } });
      },
    };
  });
  return {
    host,
    startCore: async () => {
      await reach();
    },
    ingress: {
      accept: async (socket, principal) => {
        clients++;
        changed();
        try {
          return await acceptOn(host, socket, principal);
        } finally {
          clients--;
          changed();
        }
      },
      revoke: (connection) => host.invalidatePrincipal({ kind: "client", connection }),
    },
    get status() {
      return status();
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => host.close(),
  };
}
