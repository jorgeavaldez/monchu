/**
 * What a remote client may ask of the core, as Chord contracts: home-wide methods and state on `Session`, each root's on
 * `Root`, and a front's or worker's view on `Conversation`. Every object lives on the host named `core`. The core checks
 * every argument against these schemas; results and state come from the trusted core and are typed, not checked.
 * Adding a method, an optional argument or a field keeps the version; anything else bumps it.
 */
import type { Api, AuthEvent, Model } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import type { Goal } from "../core/agents/goals.ts";
import type { InboxItem, InboxKind } from "../core/inbox.ts";
import type { Settings } from "../core/config.ts";
import type { JobsState } from "../core/jobs.ts";
import type { SecretsState } from "../core/secrets/requests.ts";
import type { DraftsState } from "../core/drafts.ts";
import type { PinnedMessage, PinsState } from "../core/pins.ts";
import {
  ATTACHMENTS_PER_MESSAGE,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID,
  type Attachment,
} from "./attachments.ts";
import type {
  ClientNotice,
  LoginEntry,
  LoginNeeds,
  ModelChoice,
  RootSummary,
  WorkerSummary,
} from "./client.ts";
import type { LogRecord } from "./logs.ts";
import type { Release } from "./release.ts";
import type { McpServerReport } from "./reports.ts";

/**
 * Who asks: the core's or the server's own code, or one client connection. Stamped by the server where the connection
 * comes in, never by what a client sends. `person` is false for a service login, which may never replace Monchu's code.
 */
export type Principal =
  | { kind: "core" }
  | { kind: "server" }
  | { kind: "client"; connection: string; person: boolean };

/** One object per connection: what one client opens and starts stays its own. */
export const principalKey = (principal: Principal): string =>
  principal.kind === "client" ? `client:${principal.connection}` : principal.kind;

/**
 * The server process every client connects to, and the core process it runs. `serve` keeps the core running;
 * `background` was started by a client and exits once no client has been connected for a while, unless it serves the
 * web client, whose pages drop their sockets whenever a phone puts them away.
 */
export type ServerStatus = {
  mode: "serve" | "background";
  pid: number;
  core: {
    state: "stopped" | "starting" | "running" | "stopping";
    pid: number | null;
    since: number | null;
  };
  /** Clients connected now: terminals and web pages. */
  clients: number;
  /** The web client's URL while the server serves it. */
  web: string | null;
};

/** What a client needs before it can render: replaced after each reload. */
export type Hello = {
  home: string;
  settings: Settings;
  skills: { name: string; description: string }[];
  /** Plugins' slash commands. */
  commands: { name: string; usage: string; help: string }[];
  /** Providers plugins added, which `/login` offers after Monchu's own. */
  logins: LoginEntry[];
  /** Page modules of plugins that are on, which the web client loads. */
  pages: { plugin: string; url: string }[];
  /** The chat model catalog, for context windows and reasoning support. */
  models: Model<Api>[];
  notes: string[];
};

/** Recent non-fatal failures, newest last; ids only grow, so a client shows those after the last it saw. */
export type Reports = { recent: { id: number; message: string }[] };

/** A login prompt as it crosses the wire: its abort signal stays behind. */
export type LoginPrompt =
  | { type: "text" | "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string };

/** One login in progress, as the client that started it sees it. Events only grow. */
export type LoginState = {
  /** Unguessable: a client's next connection takes the login back with it after a drop. */
  id: string;
  /** The prompt waiting for this client's answer. */
  prompt: { id: number; request: LoginPrompt } | null;
  /** Provider events; an MCP sign-in sends its authorization URL as `auth_url`. */
  events: AuthEvent[];
  done: { ok: true; message: string } | { ok: false; message: string } | null;
};

type McpReport = { servers: McpServerReport[]; errors: string[] };

/** A value from the trusted core: typed for the client, not checked. */
const trusted = <T>() => Type.Unsafe<T>(Type.Unknown());

const text = Type.String();
const id = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 0 });
const attachments = Type.Optional(
  Type.Array(Type.Object({ id, name: text, size: count }), { maxItems: ATTACHMENTS_PER_MESSAGE }),
);
const whenBusy = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
const role = Type.Union([Type.Literal("front"), Type.Literal("worker")]);
const pick = Type.Union([
  Type.Object({ model: Type.Object({ provider: text, modelId: text }) }),
  Type.Object({
    thinkingLevel: Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
]);
const queueChange = Type.Union([
  Type.Object({ kind: Type.Literal("text"), text }),
  Type.Object({ kind: Type.Literal("mode"), mode: whenBusy }),
  Type.Object({ kind: Type.Literal("delete") }),
]);
const logQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 1000 }),
  severity: Type.Optional(Type.Enum(["debug", "info", "warn", "error"])),
  scope: Type.Optional(text),
});
const logAttributes = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
);
/** A worker of the root, or its front when left out. */
const worker = Type.Optional(text);

const sessionState = {
  hello: trusted<Hello>(),
  releaseState: trusted<Release>(),
  /** Reports since this connection opened. */
  reports: trusted<Reports>(),
  roots: trusted<RootSummary[]>(),
  jobsState: trusted<JobsState>(),
  /** This connection's own logins by id: no other connection sees them, until this one drops and another resumes them. */
  logins: trusted<Record<string, LoginState>>(),
  /** Stored secrets by name and the pending requests: never values. */
  secrets: trusted<SecretsState>(),
  /** The prompt drafts set aside on this device. */
  drafts: trusted<DraftsState>(),
  /** The messages pinned on this device. */
  pins: trusted<PinsState>(),
};

/** A secret as a person enters it. Values are plain strings, so a refusal never quotes one; the core checks the rest. */
const secretFields = { name: text, site: Type.Optional(text), description: Type.Optional(text) };
const secretInput = Type.Union([
  Type.Object({ ...secretFields, kind: Type.Literal("value"), value: text }),
  Type.Object({ ...secretFields, kind: Type.Literal("login"), username: text, password: text }),
]);

/** Only a person's login enters, replaces or deletes a secret: a service login has none of these. */
const secretMethods = {
  /** The value goes in and nothing comes back. */
  setSecret: method(Type.Object({ input: secretInput })),
  deleteSecret: method(Type.Object({ name: text })),
  declineSecret: method(Type.Object({ name: text })),
};

const inboxKind = Type.Union([
  Type.Literal("ask"),
  Type.Literal("milestone"),
  Type.Literal("update"),
  Type.Literal("reply"),
]);

const sessionMethods = {
  saveDraft: method(Type.Object({ text })),
  takeDraft: method(Type.Object({ id: count }), trusted<string>()),
  unpinMessage: method(Type.Object({ code: text })),
  pushKey: method(undefined, trusted<string>()),
  pushSubscribe: method(
    Type.Object({
      subscription: Type.Object({
        endpoint: Type.String({ pattern: "^https://", maxLength: 2000 }),
        p256dh: Type.String({ pattern: "^[A-Za-z0-9_-]{80,100}$" }),
        auth: Type.String({ pattern: "^[A-Za-z0-9_-]{16,32}$" }),
        origin: Type.String({ pattern: "^https?://", maxLength: 500 }),
        kinds: Type.Array(inboxKind, { maxItems: 4, uniqueItems: true }),
      }),
    }),
  ),
  pushKinds: method(Type.Object({ endpoint: text }), trusted<InboxKind[] | null>()),
  skillInput: method(Type.Object({ name: text, text }), trusted<string>()),
  findRoot: method(Type.Object({ prefix: text }), trusted<string>()),
  currentRoot: method(undefined, trusted<string>()),
  createRoot: method(Type.Object({ requestId: text }), trusted<string>()),
  renameRoot: method(Type.Object({ root: id, label: text })),
  archiveRoot: method(Type.Object({ root: id, archived: Type.Boolean() })),
  jobs: method(undefined, trusted<JobsState & { listing: string }>()),
  roleChoice: method(Type.Object({ role }), trusted<ModelChoice>()),
  saveDefault: method(Type.Object({ role, pick })),
  loginNeeds: method(undefined, trusted<LoginNeeds>()),
  mcpServers: method(undefined, trusted<McpReport>()),
  mcpLogout: method(Type.Object({ name: text }), trusted<string>()),
  mcpSetEnabled: method(Type.Object({ name: text, enabled: Type.Boolean() }), trusted<string>()),
  mcpReconnect: method(undefined, trusted<McpReport>()),
  reload: method(undefined, trusted<string[]>()),
  logs: method(Type.Object({ query: logQuery }), trusted<LogRecord[]>()),
  record: method(
    Type.Object({
      scope: Type.Union([Type.Literal("tui"), Type.Literal("web")]),
      body: text,
      attributes: Type.Optional(logAttributes),
    }),
  ),
  restart: method(),
  /** Starts a provider login for this connection; resolves with its id in `logins`. */
  login: method(
    Type.Object({
      provider: text,
      auth: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]),
    }),
    trusted<string>(),
  ),
  /**
   * Starts an MCP sign-in for this connection, as for `login`. `redirect` is a callback URL the client receives itself
   * (the web client's own page) and answers the paste prompt with, in place of the core's loopback.
   */
  mcpLogin: method(Type.Object({ server: text, redirect: Type.Optional(text) }), trusted<string>()),
  /**
   * Takes a login an earlier connection of this client started into this one's `logins`: a dropped connection's
   * logins wait a while for it, since a phone drops the page's socket whenever it goes away to fetch what is asked.
   */
  loginResume: method(Type.Object({ login: id })),
  /** Answers a login's prompt; `null` declines it. */
  loginAnswer: method(
    Type.Object({ login: id, prompt: count, value: Type.Union([text, Type.Null()]) }),
  ),
  loginCancel: method(Type.Object({ login: id })),
};

/**
 * The home: what every client shows from its first screen, and what is not one root's. A person's login gets `owner`;
 * a service login gets `service`, which can't `update` or touch secrets.
 */
export const Session = remote("monchu.session", {
  version: 3,
  input: Type.Object({}),
  host: hostNamed("core"),
  variants: {
    owner: {
      state: sessionState,
      methods: {
        ...sessionMethods,
        ...secretMethods,
        update: method(Type.Object({ release: text })),
      },
    },
    service: { state: sessionState, methods: sessionMethods },
  },
});

/** One root's front and crew; methods with a `worker` act on that worker of the root. */
export const Root = remote("monchu.root", {
  version: 2,
  input: Type.Object({ root: id }),
  host: hostNamed("core"),
  variants: {
    owner: {
      state: { notices: trusted<ClientNotice[]>(), inbox: trusted<InboxItem[]>() },
      methods: {
        submit: method(Type.Object({ message: text, requestId: text, whenBusy, attachments })),
        reply: method(Type.Object({ id, message: text, requestId: text, whenBusy, attachments })),
        messageWorker: method(
          Type.Object({ worker: text, message: text, requestId: text, whenBusy, attachments }),
        ),
        /** One chunk of a file the user attaches; the last (`done`) resolves with the stored attachment. */
        upload: method(
          Type.Object({
            upload: Type.String({ pattern: UPLOAD_ID.source }),
            name: text,
            offset: count,
            data: Type.String({ maxLength: Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 }),
            done: Type.Boolean(),
          }),
          trusted<Attachment | null>(),
        ),
        editQueued: method(
          Type.Object({ worker, id: count, change: queueChange }),
          trusted<boolean>(),
        ),
        abort: method(undefined, trusted<string[]>()),
        stopWorker: method(Type.Object({ worker: text })),
        reset: method(Type.Object({ handoff: Type.Optional(text) })),
        compact: method(Type.Object({ instructions: Type.Optional(text) })),
        changeDirectory: method(Type.Object({ path: text, worker }), trusted<string>()),
        workers: method(undefined, trusted<WorkerSummary[]>()),
        handOff: method(Type.Object({ worker: text, toRoot: text })),
        goals: method(undefined, trusted<(Goal & { changed: boolean })[]>()),
        seeGoal: method(Type.Object({ id: text, updatedAt: Type.Number() })),
        statusLines: method(undefined, trusted<string[]>()),
        pinMessage: method(
          Type.Object({ id: text, worker }),
          trusted<{ pin: PinnedMessage; existed: boolean }>(),
        ),
        command: method(Type.Object({ name: text, text, worker }), trusted<string>()),
        modelChoice: method(Type.Object({ worker }), trusted<ModelChoice>()),
        pickModel: method(Type.Object({ pick, saveDefault: Type.Boolean(), worker })),
      },
    },
  },
});

/**
 * The server: its state for every client, `stop` for a person, and for the core the restart it asks for. Lives in the
 * server process, which outlasts the core it runs.
 */
export const Server = remote("monchu.server", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("server"),
  variants: {
    owner: {
      state: { state: trusted<ServerStatus>() },
      methods: {
        stop: method(),
        /** Serve the web client too, as `--web` asks of a running server; answers its URL. */
        web: method(Type.Object({}), trusted<string>()),
      },
    },
    viewer: { state: { state: trusted<ServerStatus>() } },
    core: {
      state: { state: trusted<ServerStatus>() },
      methods: {
        /** Close the core and start a new one; the server and its clients' sockets stay. */
        replace: method(),
        /** Close the core, install a release, and run it. */
        update: method(
          Type.Object({ plan: Type.Object({ release: text, url: text, prefix: text }) }),
        ),
      },
    },
  },
});

/** The committed view of a root's front, or of one of its workers. */
export const Conversation = remote("monchu.conversation", {
  version: 1,
  input: Type.Object({ root: id, worker }),
  host: hostNamed("core"),
  variants: { owner: { state: { view: trusted<ConversationView>() } } },
});
