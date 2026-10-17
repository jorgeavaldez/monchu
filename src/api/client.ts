/**
 * The contract between Monchu's core and its clients (the terminal now, the web and attached terminals later). Clients
 * reach the core only through `Client`; the core implements it in process. Everything here is browser-safe: core types
 * come in as types only, and the shared helpers live beside this file.
 */
import type { AttachedReplicatedState } from "@earendil-works/chord";
import type {
  Api,
  AuthInteraction,
  AuthType,
  Model,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";
import type { Assessment } from "../core/agents/classifier.ts";
import type { Goal } from "../core/agents/goals.ts";
import type { listWorkers } from "../core/agents/workers.ts";
import type { ModelRole, Settings } from "../core/config.ts";
import type { JobEvent, JobsState } from "../core/jobs.ts";
import type { McpSignInPrompt } from "../core/mcp/auth.ts";
import type { LogAttributes, LogQuery, LogRecord } from "./logs.ts";
import type { WhenBusy } from "./notices.ts";
import type { McpServerReport } from "./reports.ts";

export type { Goal, JobEvent };

/** A model or thinking-level pick, for the root or a worker. */
export type ModelPick = { model: ModelRef } | { thinkingLevel: ModelThinkingLevel };

/** An edit to a still-queued input: new text, a new busy mode, or deleting it. */
export type QueueChange =
  | { kind: "text"; text: string }
  | { kind: "mode"; mode: WhenBusy }
  | { kind: "delete" };

/** One worker as clients list it. */
export type WorkerSummary = Awaited<ReturnType<typeof listWorkers>>[number];

/** What a model or thinking-level picker offers: the current pick, its role's default, and the models with credentials. */
export type ModelChoice = {
  model: Model<Api> | undefined;
  thinkingLevel: ModelThinkingLevel;
  thinkingLevels: readonly ModelThinkingLevel[];
  defaults: ModelRole;
  models: readonly Model<Api>[];
};

/** Every configured MCP server's state and tools, and config errors. */
type McpReport = { servers: McpServerReport[]; errors: string[] };

/**
 * One client's view of the core. Methods without a worker name act on the root; with one, on that worker. Request IDs
 * are the client's, so a retry never admits twice. Login and MCP sign-in are private interactions with the client that
 * started them: their prompts and values never reach the transcript or the log.
 */
export interface Client {
  readonly home: string;
  /** The run settings of the last successful load or reload. */
  readonly settings: Settings;
  /** The core's startup notes, such as a freshly seeded home, which every client shows under its header. */
  readonly notes: readonly string[];
  skills(): readonly { name: string; description: string }[];
  /** The named skill's instructions with the user's text, as one message; throws for an unknown skill. */
  skillInput(name: string, text: string): Promise<string>;
  /** The catalog model of a model reference, while its provider still offers it. */
  model(ref: ModelRef): Model<Api> | undefined;

  /** Read-only committed conversation state of the root or a worker. The caller disposes it. */
  viewState(workerName?: string): Promise<AttachedReplicatedState<ConversationView>>;
  /** Resolves on durable admission, never on the answer. */
  submit(message: string, requestId: string, whenBusy: WhenBusy): Promise<void>;
  messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
  ): Promise<void>;
  /** Changes a still-queued input in place; false once it left the queue. */
  editQueued(workerName: string | undefined, id: number, change: QueueChange): Promise<boolean>;
  /** Stops the front only, returning the user's own queued messages, oldest first. */
  abort(): Promise<string[]>;
  stopWorker(name: string): Promise<void>;
  reset(handoff: string | undefined): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  changeDirectory(path: string, workerName?: string): Promise<string>;
  workers(): Promise<readonly WorkerSummary[]>;

  goals(): Promise<readonly (Goal & { changed: boolean })[]>;
  seeGoal(id: string, updatedAt: number): Promise<void>;
  /** Every job, the recent events, and the jobs as the job tool lists them. */
  jobs(): Promise<Readonly<JobsState> & { listing: string }>;
  /** Job events with ids above `after`, in order, then each new batch; returns a stop function. */
  watchJobEvents(
    after: number,
    listener: (events: readonly JobEvent[]) => void,
  ): Promise<() => void>;
  /** Routing assessments of front inputs as they settle; returns a stop function. */
  watchAssessments(listener: (items: readonly Assessment[]) => void): Promise<() => void>;

  modelChoice(workerName?: string): Promise<ModelChoice>;
  roleChoice(role: "front" | "worker"): Promise<ModelChoice>;
  pickModel(pick: ModelPick, saveDefault: boolean, workerName?: string): Promise<void>;
  saveDefault(role: "front" | "worker", pick: ModelPick): Promise<void>;

  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void>;
  /** What still needs a login. Never reads or returns credential values. */
  loginNeeds(): Promise<{ chat: string[]; anyOf: boolean; classifier: string | undefined }>;
  mcpServers(): Promise<McpReport>;
  mcpLogin(name: string, prompt: McpSignInPrompt, signal: AbortSignal): Promise<string>;
  mcpLogout(name: string): Promise<string>;
  mcpReconnect(): Promise<McpReport>;

  /** Applies config, skill and extension edits in process; resolves with the reloaded modules. */
  reload(): Promise<readonly string[]>;
  /**
   * The user's restart approval. In process it clears the restart request and closes the core so its process can be
   * re-executed; remotely it asks the core to restart. Only a user's command calls it, never model output.
   */
  restart(): Promise<void>;
  /**
   * Whether `restart()` ends this process: true for the core in process, whose terminal must let go first; false for a
   * remote client, which reconnects when the core is back.
   */
  readonly restartsProcess: boolean;
  /** Another client asked the core to restart (only the core in process hears this); returns an unsubscribe function. */
  onRestartRequest(listener: () => void): () => void;
  /** The newest records of the core's structured log, oldest first. */
  logs(query: LogQuery): Promise<LogRecord[]>;
  /** This client's own telemetry, such as its render timings, into the core's log; never content. */
  record(scope: "tui" | "web", body: string, attributes?: LogAttributes): void;
  /** Successful reloads; returns an unsubscribe function. */
  onReload(listener: () => void): () => void;
  /** Non-fatal runtime failures; returns an unsubscribe function. */
  onReport(listener: (message: string) => void): () => void;
}
