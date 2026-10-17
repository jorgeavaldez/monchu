/**
 * What a remote client may ask of the core: each method's argument schema and result, and each topic's key schema and
 * value. The core checks every argument and key against these before use; results and values come from the trusted
 * core and are typed only. Per-root methods take the root's full id first. Optional arguments are `null` on the wire.
 * Clients import this file as types only, so the schemas stay out of the web bundle.
 */
import type { Api, AuthEvent, Model } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import type { Assessment } from "../core/agents/classifier.ts";
import type { Goal } from "../core/agents/goals.ts";
import type { Settings } from "../core/config.ts";
import type { JobsState } from "../core/jobs.ts";
import type { ModelChoice, RootSummary, WorkerSummary } from "./client.ts";
import type { LogRecord } from "./logs.ts";
import type { Release } from "./release.ts";
import type { McpServerReport } from "./reports.ts";

/** What a client needs before it can render: replaced after each reload. */
export type Hello = {
  home: string;
  settings: Settings;
  skills: { name: string; description: string }[];
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
  id: number;
  /** The prompt waiting for this client's answer. */
  prompt: { id: number; request: LoginPrompt } | null;
  /** Provider events; an MCP sign-in sends its authorization URL as `auth_url`. */
  events: AuthEvent[];
  done: { ok: true; message: string } | { ok: false; message: string } | null;
};

const text = Type.String();
const optionalText = Type.Union([Type.String(), Type.Null()]);
const root = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 0 });
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

export const methods = {
  skillInput: Type.Tuple([text, text]),
  findRoot: Type.Tuple([text]),
  currentRoot: Type.Tuple([]),
  createRoot: Type.Tuple([text]),
  renameRoot: Type.Tuple([root, text]),
  archiveRoot: Type.Tuple([root, Type.Boolean()]),

  submit: Type.Tuple([root, text, text, whenBusy]),
  messageWorker: Type.Tuple([root, text, text, text, whenBusy]),
  editQueued: Type.Tuple([root, optionalText, count, queueChange]),
  abort: Type.Tuple([root]),
  stopWorker: Type.Tuple([root, text]),
  reset: Type.Tuple([root, optionalText]),
  compact: Type.Tuple([root, optionalText]),
  changeDirectory: Type.Tuple([root, text, optionalText]),
  workers: Type.Tuple([root]),
  handOff: Type.Tuple([root, text, text]),
  goals: Type.Tuple([root]),
  seeGoal: Type.Tuple([root, text, Type.Number()]),
  routing: Type.Tuple([root, Type.Union([Type.Boolean(), Type.Null()])]),
  modelChoice: Type.Tuple([root, optionalText]),
  pickModel: Type.Tuple([root, pick, Type.Boolean(), optionalText]),

  jobs: Type.Tuple([]),
  roleChoice: Type.Tuple([role]),
  saveDefault: Type.Tuple([role, pick]),
  loginNeeds: Type.Tuple([]),
  mcpServers: Type.Tuple([]),
  mcpLogout: Type.Tuple([text]),
  mcpReconnect: Type.Tuple([]),
  reload: Type.Tuple([]),
  logs: Type.Tuple([logQuery]),
  record: Type.Tuple([
    Type.Union([Type.Literal("tui"), Type.Literal("web")]),
    text,
    Type.Union([logAttributes, Type.Null()]),
  ]),
  restart: Type.Tuple([]),
  update: Type.Tuple([text]),
  /** Starts a provider login for this connection; resolves with its id, whose `login` topic it then watches. */
  login: Type.Tuple([text, Type.Union([Type.Literal("oauth"), Type.Literal("api_key")])]),
  /** Starts an MCP sign-in for this connection, as for `login`. */
  mcpLogin: Type.Tuple([text]),
  /** Answers a login's prompt; `null` declines it. */
  loginAnswer: Type.Tuple([count, count, optionalText]),
  loginCancel: Type.Tuple([count]),
};

export const topics = {
  hello: Type.Null(),
  release: Type.Null(),
  reports: Type.Null(),
  roots: Type.Null(),
  jobs: Type.Null(),
  /** A root's routing assessments. */
  assessments: Type.Tuple([root]),
  /** A root's front (`null`) or one of its workers. */
  conversation: Type.Tuple([root, optionalText]),
  /** One of this connection's own logins: no other connection can watch it. */
  login: Type.Tuple([count]),
};

type McpReport = { servers: McpServerReport[]; errors: string[] };

export type Results = {
  skillInput: string;
  findRoot: string;
  currentRoot: string;
  createRoot: string;
  renameRoot: void;
  archiveRoot: void;
  submit: void;
  messageWorker: void;
  editQueued: boolean;
  abort: string[];
  stopWorker: void;
  reset: void;
  compact: void;
  changeDirectory: string;
  workers: WorkerSummary[];
  handOff: void;
  goals: (Goal & { changed: boolean })[];
  seeGoal: void;
  routing: { configured: boolean; paused: boolean };
  modelChoice: ModelChoice;
  pickModel: void;
  jobs: JobsState & { listing: string };
  roleChoice: ModelChoice;
  saveDefault: void;
  loginNeeds: { chat: string[]; anyOf: boolean; classifier: string | null };
  mcpServers: McpReport;
  mcpLogout: string;
  mcpReconnect: McpReport;
  reload: string[];
  logs: LogRecord[];
  record: void;
  restart: void;
  update: void;
  login: number;
  mcpLogin: number;
  loginAnswer: void;
  loginCancel: void;
};

export type Values = {
  hello: Hello;
  release: Release;
  reports: Reports;
  roots: RootSummary[];
  jobs: JobsState;
  assessments: Assessment[];
  conversation: ConversationView;
  login: LoginState;
};

export type Method = keyof typeof methods;
export type Args<M extends Method> = Static<(typeof methods)[M]>;
export type Topic = keyof typeof topics;
export type Key<T extends Topic> = Static<(typeof topics)[T]>;
