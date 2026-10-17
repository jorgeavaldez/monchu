/**
 * The core's remote services, as Chord contracts. Every connection gets its own provider, so the conversations it
 * opens and the logins it starts are its own. Methods take JSON and end with Chord's `Context`; optional arguments are
 * `null` on the wire.
 */
import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";
import type { Api, AuthEvent, Model } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Assessment } from "../core/agents/classifier.ts";
import type { Goal } from "../core/agents/goals.ts";
import type { Settings } from "../core/config.ts";
import type { JobsState } from "../core/jobs.ts";
import type { ModelChoice, ModelPick, QueueChange, WorkerSummary } from "./client.ts";
import type { LogAttributes, LogQuery, LogRecord } from "./logs.ts";
import type { WhenBusy } from "./notices.ts";
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

/** One login in progress, as its client sees it. Events only grow. */
export type LoginState = {
  id: number;
  /** The prompt waiting for this client's answer. */
  prompt: { id: number; request: LoginPrompt } | null;
  /** Provider events; an MCP sign-in sends its authorization URL as `auth_url`. */
  events: AuthEvent[];
  done: { ok: true; message: string } | { ok: false; message: string } | null;
};

export interface SessionService {
  hello: ReplicatedState<Hello>;
  assessments: ReplicatedState<{ items: Assessment[] }>;
  jobs: ReplicatedState<JobsState>;
  reports: ReplicatedState<Reports>;

  /** Attach this connection to the root (`""`) or a worker's conversation, as a `conversation` instance. */
  open(name: string, context: Context): Promise<void>;
  close(name: string, context: Context): Promise<void>;

  skillInput(name: string, text: string, context: Context): Promise<string>;
  submit(message: string, requestId: string, whenBusy: WhenBusy, context: Context): Promise<void>;
  messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
    context: Context,
  ): Promise<void>;
  editQueued(
    workerName: string | null,
    id: number,
    change: QueueChange,
    context: Context,
  ): Promise<boolean>;
  abort(context: Context): Promise<string[]>;
  stopWorker(name: string, context: Context): Promise<void>;
  reset(handoff: string | null, context: Context): Promise<void>;
  compact(instructions: string | null, context: Context): Promise<void>;
  changeDirectory(path: string, workerName: string | null, context: Context): Promise<string>;
  workers(context: Context): Promise<WorkerSummary[]>;
  goals(context: Context): Promise<(Goal & { changed: boolean })[]>;
  seeGoal(id: string, updatedAt: number, context: Context): Promise<void>;
  jobsListing(context: Context): Promise<string>;
  modelChoice(workerName: string | null, context: Context): Promise<ModelChoice>;
  roleChoice(role: "front" | "worker", context: Context): Promise<ModelChoice>;
  pickModel(
    pick: ModelPick,
    saveDefault: boolean,
    workerName: string | null,
    context: Context,
  ): Promise<void>;
  saveDefault(role: "front" | "worker", pick: ModelPick, context: Context): Promise<void>;
  loginNeeds(
    context: Context,
  ): Promise<{ chat: string[]; anyOf: boolean; classifier: string | null }>;
  mcpServers(context: Context): Promise<{ servers: McpServerReport[]; errors: string[] }>;
  mcpLogout(name: string, context: Context): Promise<string>;
  mcpReconnect(context: Context): Promise<{ servers: McpServerReport[]; errors: string[] }>;
  reload(context: Context): Promise<string[]>;
  logs(query: LogQuery, context: Context): Promise<LogRecord[]>;
  record(
    scope: "tui" | "web",
    body: string,
    attributes: LogAttributes | null,
    context: Context,
  ): Promise<void>;
  /** Ask the owner to restart; it fails when nothing there can restart it. */
  restart(context: Context): Promise<void>;
  /** Start a provider login for this connection, as a `login` instance; resolves with its id. */
  login(provider: string, auth: "oauth" | "api_key", context: Context): Promise<number>;
  /** Start an MCP sign-in for this connection, as a `login` instance; resolves with its id. */
  mcpLogin(server: string, context: Context): Promise<number>;
}

export interface ConversationService {
  /** Which conversation this is: `""` for the root, else the worker's name. */
  about: ReplicatedState<{ name: string }>;
  view: ReplicatedState<ConversationView>;
}

export interface LoginService {
  state: ReplicatedState<LoginState>;
  answer(prompt: number, value: string | null, context: Context): Promise<void>;
  cancel(context: Context): Promise<void>;
}

export const Session = defineService<SessionService>("monchu.session");
export const Conversations = defineService<ConversationService>("monchu.conversation");
export const Logins = defineService<LoginService>("monchu.login");
