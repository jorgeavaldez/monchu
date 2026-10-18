/**
 * The contract between Monchu's core and its clients (the terminal now, the web and attached terminals later). Clients
 * reach the core only through `Client`; the core implements it in process. Everything here is browser-safe: core types
 * come in as types only, and the shared helpers live beside this file.
 */
import type {
  Api,
  AuthInteraction,
  AuthType,
  Model,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";
import type { Assessment } from "../core/agents/classifier.ts";
import type { Attachment } from "./attachments.ts";
import type { Goal } from "../core/agents/goals.ts";
import type { listWorkers } from "../core/agents/workers.ts";
import type { ModelRole, Settings } from "../core/config.ts";
import type { JobEvent, JobsState } from "../core/jobs.ts";
import type { McpSignInPrompt } from "../core/mcp/auth.ts";
import type { SecretsState } from "../core/secrets/requests.ts";
import type { SecretInput } from "../core/secrets/vault.ts";
import type { LogAttributes, LogQuery, LogRecord } from "./logs.ts";
import type { WhenBusy } from "./notices.ts";
import type { Release } from "./release.ts";
import type { McpServerReport } from "./reports.ts";

export type { Goal, JobEvent, SecretInput, SecretsState };

/** A value kept current from the core: the shape clients render from, the same as Durable's attached states. */
export interface Watched<T> {
  readonly value: T;
  /** Hears the current value once, soon, then every new one; returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
  dispose(): void;
}

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
 * One root as clients list it: an independent front with its own crew. `status` drives the root indicator: `working`
 * while its front, a worker or a background command runs; `done` when its front finished after the root was last shown
 * in any client; `idle` otherwise.
 */
export type RootSummary = {
  /** The short id of the root's conversation; any unique prefix names it too. */
  id: string;
  /** From its first message, or the user's own (`named`). */
  label: string;
  named: boolean;
  createdAt: number;
  lastInputAt: number | null;
  archived: boolean;
  status: RootStatus;
  /** Whether the root's own front is running a turn. */
  front: "working" | "idle";
  /** Open workers, and how many of them are busy. */
  workers: { open: number; busy: number };
  /** This root's jobs: `bg` commands running now, and scheduled jobs that are active (not paused). */
  jobs: { running: number; scheduled: number };
};

export type RootStatus = "working" | "done" | "idle";

/**
 * One root's front and crew. Methods without a worker name act on the root's front; with one, on that worker of this
 * root. Request IDs are the client's, so a retry never admits twice.
 */
export interface RootClient {
  /** The root's full short id. */
  readonly id: string;
  /** Read-only committed conversation state of the front or a worker. The caller disposes it. */
  viewState(workerName?: string): Promise<Watched<ConversationView>>;
  /** Stores a file the user attaches, for a later `submit` or `messageWorker` to carry. */
  attach(name: string, data: Uint8Array): Promise<Attachment>;
  /**
   * Resolves on durable admission, never on the answer. Attached images the model can take go inline, refused when
   * they would pass the conversation's image budget; every attachment is named by its path.
   */
  submit(
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
    attachments?: readonly Attachment[],
  ): Promise<void>;
  /** A worker gets its attachments by path only. */
  messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
    attachments?: readonly Attachment[],
  ): Promise<void>;
  /** Changes a still-queued input in place; false once it left the queue. */
  editQueued(workerName: string | undefined, id: number, change: QueueChange): Promise<boolean>;
  /** Stops the front only, returning the user's own queued messages, oldest first. */
  abort(): Promise<string[]>;
  stopWorker(name: string): Promise<void>;
  /** `/new`: a fresh model context for this root's front; its crew, goals and picks stay. */
  reset(handoff: string | undefined): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  changeDirectory(path: string, workerName?: string): Promise<string>;
  workers(): Promise<readonly WorkerSummary[]>;
  /** Moves an idle worker, with its jobs, to another root, named by any unique prefix of its id. */
  handOff(workerName: string, toRoot: string): Promise<void>;

  goals(): Promise<readonly (Goal & { changed: boolean })[]>;
  seeGoal(id: string, updatedAt: number): Promise<void>;
  /** Routing assessments of this front's inputs as they settle; returns a stop function. */
  watchAssessments(listener: (items: readonly Assessment[]) => void): Promise<() => void>;
  /** The routing helper's state for this root, pausing or resuming it first when `paused` is given. */
  routing(paused?: boolean): Promise<{ configured: boolean; paused: boolean }>;

  modelChoice(workerName?: string): Promise<ModelChoice>;
  pickModel(pick: ModelPick, saveDefault: boolean, workerName?: string): Promise<void>;
}

/**
 * One client's view of the core: what is home-wide here, and each root through `root(id)`. Login and MCP sign-in are
 * private interactions with the client that started them: their prompts and values never reach the transcript or the
 * log.
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

  /** A root by its full id; calls on an unknown root reject. */
  root(id: string): RootClient;
  /** Every root, archived ones included, as they change; returns a stop function. */
  watchRoots(listener: (roots: readonly RootSummary[]) => void): Promise<() => void>;
  /** The full id of the root a unique prefix names; throws for an unknown or ambiguous prefix, listing candidates. */
  findRoot(prefix: string): Promise<string>;
  /** The open root with the newest input from the user: what a plain `monchu` opens. */
  currentRoot(): Promise<string>;
  /** Starts a root and returns its id; a retry with the same request ID returns the same root. */
  createRoot(requestId: string): Promise<string>;
  /** Names a root; an empty label goes back to naming it from its next message. */
  renameRoot(id: string, label: string): Promise<void>;
  /** Hides a root from the list and plain `monchu`, or shows it again; refused while its front or crew is working. */
  archiveRoot(id: string, archived: boolean): Promise<void>;

  /** Every job, the recent events, and the jobs as the job tool lists them. */
  jobs(): Promise<Readonly<JobsState> & { listing: string }>;
  /** Job events with ids above `after`, in order, then each new batch; returns a stop function. */
  watchJobEvents(
    after: number,
    listener: (events: readonly JobEvent[]) => void,
  ): Promise<() => void>;

  /** Stored secrets by name and the agents' pending requests, as they change; returns a stop function. Never values. */
  watchSecrets(listener: (state: SecretsState) => void): Promise<() => void>;
  /**
   * The user's entry of a secret, which answers every request for its name. Nothing comes back, and no error names the
   * value. A core refuses it, and deleting or declining, from a service login.
   */
  setSecret(input: SecretInput): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** Declines the pending requests for a name: whoever asked is told. */
  declineSecret(name: string): Promise<void>;

  roleChoice(role: "front" | "worker"): Promise<ModelChoice>;
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
  /** The core's release: version, an available edge build, an update in progress, the last update's outcome. */
  readonly release: Release;
  /** Release changes; returns an unsubscribe function. */
  onRelease(listener: (release: Release) => void): () => void;
  /**
   * The user's update approval: the core checks the release exists, then closes, installs it and restarts as for
   * `restart()`, on the old version if npm fails. Only a user's command calls it, never model output, and a core refuses
   * it from a service login.
   */
  update(release: string): Promise<void>;
  /** The newest records of the core's structured log, oldest first. */
  logs(query: LogQuery): Promise<LogRecord[]>;
  /** This client's own telemetry, such as its render timings, into the core's log; never content. */
  record(scope: "tui" | "web", body: string, attributes?: LogAttributes): void;
  /** Successful reloads; returns an unsubscribe function. */
  onReload(listener: () => void): () => void;
  /**
   * Non-fatal runtime failures, and a remote client's own notices about its connection unless `connection` is false
   * (for a client that shows the connection some other way); returns an unsubscribe function.
   */
  onReport(listener: (message: string) => void, options?: { connection?: boolean }): () => void;
}
