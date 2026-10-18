/**
 * `monchu/plugin`: what a Monchu plugin imports. A plugin is a folder whose `index.ts` (or `index.js`) default-exports
 * a function that receives a `PluginApi`, in the shape of Pi's `ExtensionAPI`: `registerTool` takes Pi's tool
 * definition, `on(event, handler)` gets Pi's events and results, `registerCommand` takes Pi's command, `ctx.ui` has
 * `notify` and `setStatus`, and `registerProvider` takes a pi-ai provider. Monchu maps them onto Durable extensions;
 * what is Monchu's own (Durable tasks, queue changes, the crew, secrets) says so. See `docs/plugins.md`.
 *
 * Plugins import this module, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` and
 * `typebox` from Monchu's own copies, never from a copy of their own.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Models,
  Provider,
  Static,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type {
  AnyTask,
  ContextView,
  ConversationId,
  DocumentReader,
  EntryId,
  HookApi,
  PromptInput,
  SubmissionId,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";

export { Type } from "@earendil-works/pi-ai";
export { defineDoc, defineTask } from "@earendil-works/pi-durable";
export type {
  AnyTask,
  ConversationId,
  HookApi,
  PromptInput,
  SubmissionId,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";

/**
 * The plugin API's version, as `PluginApi.apiVersion`. It grows when the API changes shape, so a plugin can refuse an
 * older Monchu with a clear message instead of failing on a missing member.
 */
export const PLUGIN_API_VERSION = 2;

/**
 * How the model reaches a tool, as Pi's `exposure`. Monchu's default is `deferred`, not Pi's `direct`, so adding or
 * editing a plugin never costs a prompt cache:
 * - `deferred`: kept out of every conversation's tools until `tool_search` loads the plugin's group. Codemode scripts
 *   can call it any time.
 * - `direct`: offered to the model in every conversation. Adding one, or changing its definition, re-caches every
 *   conversation once; use it only for tools most turns need.
 * - `codemode`: only codemode scripts call it, found with `searchTools()`; never declared to the model.
 */
export type ToolExposure = "deferred" | "direct" | "codemode";

/**
 * A tool's group, as Pi's `namespace`: `description` is the one line `tool_search` lists, `instructions` a guide
 * returned once when the group loads. A plugin's tools of one exposure form one group, `plugin-<name>`; the first
 * tool with a namespace names its description. Monchu's own: `preload` loads the group from the start in
 * conversations on the Claude Code bridge, whose prompt cache a later load would cost.
 */
export type ToolNamespace = {
  readonly description: string;
  readonly instructions?: string;
  readonly preload?: boolean;
};

/** What a tool returns, as Pi's `AgentToolResult`. Throwing gives the model an error result. */
export type PluginToolResult = {
  /** For the model. Omitted: the text the tool sent through `ctx.durable.api.output()`. */
  readonly content?: (TextContent | ImageContent)[];
  readonly details?: JsonValue;
  /** For codemode scripts, matching `outputSchema`. */
  readonly structuredContent?: JsonValue;
  readonly isError?: boolean;
  readonly usage?: Usage;
};

/** A tool, as Pi's `ToolDefinition`. `name`, `description` and `parameters` are what the model sees. */
export type PluginTool<P extends TSchema = TSchema> = {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: P;
  readonly exposure?: ToolExposure;
  readonly namespace?: ToolNamespace;
  readonly outputSchema?: TSchema;
  readonly executionMode?: "sequential" | "parallel";
  /** Monchu's own: whether an interrupted call may run again after a restart (Durable's `replay`). Default `unsafe`. */
  readonly replay?: "safe" | "unsafe";
  /** Monchu's own: how much `ctx.durable.api.output()` text the model gets, and which end it keeps (Durable's). */
  readonly outputLimits?: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly retain?: "head" | "tail";
  };
  execute(
    toolCallId: string,
    params: Static<P>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: PluginToolResult) => void) | undefined,
    ctx: PluginToolContext,
  ): Promise<PluginToolResult>;
};

/** Pi's `defineTool`: types a tool's parameters for `execute`. */
export function defineTool<P extends TSchema>(tool: PluginTool<P>): PluginTool<P> {
  return tool;
}

/** What a handler shows the user, as Pi's `ctx.ui`. */
export interface PluginUI {
  /**
   * A line every client showing the conversation's root shows once; never sent to the model. In a command it is the
   * command's answer instead.
   */
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** A status line per `key` on the conversation's root, shown when a client opens it; `undefined` clears it. */
  setStatus(key: string, text: string | undefined): void;
}

/** What every handler gets, as Pi's `ExtensionContext`. */
export type PluginContext = {
  readonly conversationId: ConversationId;
  readonly ui: PluginUI;
  readonly signal: AbortSignal | undefined;
  /**
   * Monchu's own: Durable's hook API and the call's context, for documents and memos. Absent in `input` and
   * `input_change`, which run outside a Durable task.
   */
  readonly durable?: { readonly api: HookApi; readonly context: Context };
};

/** What a tool's `execute` gets: Durable's tool API instead of the hook API. */
export type PluginToolContext = Omit<PluginContext, "durable"> & {
  readonly durable: { readonly api: ToolExecutionApi; readonly context: Context };
};

/** What a command's handler gets, as Pi's `ExtensionCommandContext`. */
export type PluginCommandContext = {
  /** The root the client shows, and the conversation it shows: the root or one of its workers. */
  readonly root: ConversationId;
  readonly conversationId: ConversationId;
  /** Who runs it: a person's login, or a service token. */
  readonly caller: "person" | "service";
  readonly ui: PluginUI;
  /** Monchu's own: a Durable commit on the home's store. */
  commit<T>(work: (tx: Tx) => T | Promise<T>): Promise<T>;
};

/** A slash command in every client, as Pi's `registerCommand` options. */
export type PluginCommand = {
  readonly description?: string;
  /** Monchu's own: shown after the name in help and typeahead, such as `[id]`. */
  readonly usage?: string;
  /** What the command shows is what it sends to `ctx.ui.notify`. */
  handler(args: string, ctx: PluginCommandContext): void | Promise<void>;
};

type Handler<E, R = undefined> = (
  event: E,
  ctx: PluginContext,
) => R | undefined | void | Promise<R | undefined | void>;

export type ToolCallEvent = {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  /** Mutable, as in Pi: changes made in place are the arguments the tool runs with. */
  input: Record<string, unknown>;
  /** Set for a call another tool made, such as a codemode script. */
  readonly parentToolCallId?: string;
};

export type ToolResultEvent = {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly parentToolCallId?: string;
  readonly content: (TextContent | ImageContent)[];
  readonly details: JsonValue | undefined;
  readonly structuredContent?: JsonValue;
  readonly isError: boolean;
};

/** The user's message to a front, before it is admitted. */
export type InputEvent = {
  readonly type: "input";
  /** The text, without its attachments. */
  readonly text: string;
  readonly source: "interactive";
  /** What it does when the front is busy. */
  readonly streamingBehavior: "steer" | "followUp";
  /** Monchu's own: the front's context before this message, read on the first call. */
  messages(): Promise<ContextView["messages"]>;
};

/**
 * Pi's input results: `transform` replaces the text, `handled` drops the message (the plugin answered it). Monchu's
 * own: `admitted` runs in a commit right after admission, with the message's submission, such as to start a task keyed
 * by it. A retry of the same message admits it once but runs this again, so key what it writes by submission.
 */
export type InputEventResult =
  | { readonly action: "continue"; readonly admitted?: AfterAdmission }
  | { readonly action: "transform"; readonly text: string; readonly admitted?: AfterAdmission }
  | { readonly action: "handled" };

export type AfterAdmission = (tx: Tx, submission: SubmissionId) => void | Promise<void>;

/**
 * Monchu's own: a front's queued message changed, inside the commit that changes it. `text` is the edited text,
 * `undefined` when it was withdrawn (deleted from the queue, or taken back by Esc) and the front never gets it.
 */
export type InputChangeEvent = {
  readonly type: "input_change";
  readonly submission: SubmissionId;
  readonly text: string | undefined;
  /** The front's context, read before the commit; empty for a withdrawn message. */
  readonly messages: ContextView["messages"];
};

/** Events by Pi's names. A throwing `tool_call` handler blocks the call and a throwing `tool_result` handler withholds the result: guards fail closed. Others are reported and treated as returning nothing. */
export type PluginEvents = {
  /** Before a tool runs: `block` refuses it with `reason`. Change arguments by mutating `event.input`. */
  tool_call: Handler<ToolCallEvent, { readonly block?: boolean; readonly reason?: string }>;
  /** After a tool ran, before its result is committed: the fields returned replace the result's. */
  tool_result: Handler<
    ToolResultEvent,
    {
      readonly content?: (TextContent | ImageContent)[];
      readonly details?: JsonValue;
      readonly structuredContent?: JsonValue;
      readonly isError?: boolean;
    }
  >;
  /** Before each model request: the returned messages are sent for that request only. */
  context: Handler<
    { readonly type: "context"; readonly messages: readonly Message[] },
    { readonly messages: readonly Message[] }
  >;
  /** Each final provider message; observe only (Durable has no replacement here). */
  message_end: Handler<{ readonly type: "message_end"; readonly message: AssistantMessage }>;
  /** After every tool of a round finished, with the round's entries; observe only. */
  turn_end: Handler<{
    readonly type: "turn_end";
    readonly messageEntryId: EntryId;
    readonly toolResultEntryIds: readonly EntryId[];
  }>;
  /** A final answer: `continue` runs once more, with `message` as the next input (default "Continue."). */
  agent_before_settle: Handler<
    { readonly type: "agent_before_settle"; readonly message: AssistantMessage },
    { readonly continue?: boolean; readonly message?: string }
  >;
  /** Before a compaction summarizes: `cancel` skips it; `compaction.summary` replaces the summarizer. */
  session_before_compact: Handler<
    {
      readonly type: "session_before_compact";
      readonly reason: string;
      readonly customInstructions?: string;
      readonly messages: readonly Message[];
    },
    { readonly cancel?: boolean; readonly compaction?: { readonly summary: string } }
  >;
  /** This plugin instance is retired: a reload replaced or removed it, or Monchu is closing. Release resources here. */
  session_shutdown: (event: {
    readonly type: "session_shutdown";
    readonly reason: "reload" | "quit";
  }) => void | Promise<void>;
  /** The user's message to a front, before it is admitted. */
  input: Handler<InputEvent, InputEventResult>;
  /** Monchu's own: a front's queued message changed (see `InputChangeEvent`). */
  input_change: (event: InputChangeEvent, tx: Tx, ctx: PluginContext) => void | Promise<void>;
};

/** Whose a secret use is, for the audit: the tool (or command) and the conversation's short id. */
export type SecretUse = { readonly tool: string; readonly conversation: string };

/** Monchu's own: the home's secrets, by name. Values reach only the plugin's own code, never the model. */
export interface PluginSecrets {
  /** A stored secret's name, kind and site, never its value; `undefined` when there is none. */
  info(
    name: string,
  ): Promise<
    { readonly name: string; readonly kind: "value" | "login"; readonly site?: string } | undefined
  >;
  /** A stored value by key (a login's are `NAME_USERNAME` and `NAME_PASSWORD`), audited; `undefined` when none. */
  value(key: string, use: SecretUse): Promise<string | undefined>;
  /**
   * Each text with `{{secret:KEY}}` replaced by the value. An unknown key throws; so does a login with a site unless
   * `origin` returns that site.
   */
  fill(
    texts: readonly string[],
    use: SecretUse & { readonly origin?: () => Promise<string | undefined> },
  ): Promise<string[]>;
  /** The tool with its streamed output redacted, as Monchu's own browser and shell tools are. */
  redacting<P extends TSchema>(tool: PluginTool<P>): PluginTool<P>;
}

/** A conversation as Monchu's agents know it. */
export type AgentInfo =
  | { readonly role: "front"; readonly id: ConversationId }
  | {
      readonly role: "worker";
      readonly id: ConversationId;
      readonly name: string;
      /** The conversation that started it: its front, or the worker it reports to. */
      readonly parent: ConversationId;
      readonly closed: boolean;
    };

/** A worker profile from `config.json`, as `start_worker` offers it. */
export type WorkerProfile = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly use: string;
};

/** Monchu's own: its fronts and workers, read and messaged inside a Durable transaction. */
export interface PluginAgents {
  /** The conversation's short id, as Monchu shows it. */
  shortId(id: ConversationId): string;
  /**
   * Who the conversation is: a front, or a worker with its name and parent. `undefined` when the store no longer has it,
   * or it is a worker its parent no longer lists. Read before the transaction's first write.
   */
  whois(tx: Tx, id: ConversationId): Promise<AgentInfo | undefined>;
  /**
   * Messages a worker as its parent would, once per `requestId`, reopening it if it was closed; its answer is reported
   * as usual. A front gets input through Durable instead (`conversation(id).submit`).
   */
  messageWorker(
    tx: Tx,
    worker: Extract<AgentInfo, { role: "worker" }>,
    text: string,
    requestId: string,
  ): Promise<void>;
  /** Text a parent reads as the worker's progress update, as `post_update` sends it. */
  updateText(name: string, text: string): string;
  /** Text an agent reads as a notice from Monchu itself, not from the user; `summary` is one line. */
  noticeText(summary: string, text: string): string;
  /**
   * A front's workers, open and closed, with the start of each one's first brief, and `started`, its lifetime count of
   * worker deliveries (starts and messages): a larger count later means it routed work since.
   */
  workers(
    tx: Tx,
    front: ConversationId,
  ): Promise<{
    readonly started: number;
    readonly workers: readonly {
      readonly name: string;
      readonly id: ConversationId;
      readonly closed: boolean;
      readonly brief?: string;
    }[];
  }>;
  /** `started` of `workers` from committed state, for code outside a transaction, such as a hook. */
  deliveries(read: DocumentReader, front: ConversationId, context: Context): Promise<number>;
  /** A front's goals, open and recently closed, in stored order. */
  goals(
    tx: Tx,
    front: ConversationId,
  ): Promise<
    readonly {
      readonly id: string;
      readonly title: string;
      readonly status: "active" | "waiting" | "done" | "dropped";
      readonly workstream: string;
      readonly workers: readonly string[];
    }[]
  >;
  /** The worker profiles in `config.json`, by name, as of this load. */
  readonly profiles: Readonly<Record<string, WorkerProfile>>;
}

/**
 * The home's models and logins, as Pi's `ctx.modelRegistry` serves an extension: read and call, never log in or out.
 * A provider without credentials has no auth (`checkAuth` is `undefined`); calls to it fail with the provider's error.
 */
export type PluginModels = Pick<
  Models,
  | "getProviders"
  | "getProvider"
  | "getModel"
  | "getModels"
  | "getModelOfType"
  | "getModelsOfType"
  | "checkAuth"
  | "getAvailable"
  | "getAvailableOfType"
  | "complete"
  | "completeSimple"
  | "classify"
>;

/** What a plugin's function receives, as Pi's `ExtensionAPI`. Registration only counts while the function runs. */
export interface PluginApi {
  /** `PLUGIN_API_VERSION` of the Monchu running the plugin; older Monchus have none. */
  readonly apiVersion: number;
  /** The plugin's folder name. */
  readonly name: string;
  /** Absolute path of the plugin's folder. */
  readonly dir: string;
  /** Monchu's home. */
  readonly home: string;
  readonly device: {
    readonly hostname: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly user: string;
  };
  /** Aborts when this instance is retired (see `session_shutdown`). */
  readonly signal: AbortSignal;
  /** A warning the user sees as a system notice and in the log. */
  report(warning: string): void;
  /**
   * This plugin's settings as of this load: `plugins.<name>` in the home's `config.json`, synced to every device, with
   * this device's `settings.<name>` in `plugins.local.json` over it (field by field when both are objects);
   * `undefined` when neither has any. Shared settings go in the first, device-only ones (a local service's address)
   * in the second.
   */
  readonly config: JsonValue | undefined;
  /**
   * Replace this plugin's settings in `config.json`, or with `device` in `plugins.local.json` (`undefined` removes
   * them). The next reload runs the plugin with them; until then the running code applies the change itself. Never
   * call it while the plugin loads.
   */
  saveConfig(value: JsonValue | undefined, options?: { readonly device?: boolean }): Promise<void>;
  readonly models: PluginModels;
  readonly secrets: PluginSecrets;
  readonly agents: PluginAgents;
  /** The UI of a conversation's root, for code that runs outside a handler, such as a Durable task. */
  ui(conversationId: ConversationId): PluginUI;
  registerTool<P extends TSchema>(tool: PluginTool<P>): void;
  /**
   * Monchu's own: a system prompt section, rendered before each request as `<plugin>_<key>` and patched in the stream
   * when its text changes. Render a short stable placeholder rather than nothing: a section that appears later
   * re-sends the others.
   */
  registerSection(
    key: string,
    render: (
      input: PromptInput,
      context: Context,
    ) => string | undefined | Promise<string | undefined>,
    options?: { readonly tag?: boolean },
  ): void;
  on<E extends keyof PluginEvents>(event: E, handler: PluginEvents[E]): void;
  /** `/<name>`: lowercase letters, digits and dashes. A built-in command of the same name wins. */
  registerCommand(name: string, command: PluginCommand): void;
  /**
   * A pi-ai provider in the home's models, offered by `/login` under its `name`, with its credentials stored by its
   * id like any other provider's. A role (`front`, `worker`) on it applies from the first reload after it loads.
   */
  registerProvider(provider: Provider): void;
  /** Takes back a provider this plugin registered. */
  unregisterProvider(id: string): void;
  /**
   * Monchu's own: an optional login this plugin works with. While `provider` has no credentials, startup and a later
   * `/login` say `<purpose> is off` and how to turn it on.
   */
  wantsLogin(provider: string, purpose: string): void;
  /**
   * Monchu's own: a Durable task the plugin's tools create, such as a wait that outlives a turn. Name it after the
   * plugin; its definition must be registered at every load, so pending tasks resume.
   */
  registerTask(task: AnyTask): void;
}

/** A plugin's default export. It may be async; Monchu waits for it (up to 10 seconds) before loading the next one. */
export type Plugin = (monchu: PluginApi) => void | Promise<void>;

/** Types a plugin written in JavaScript; a TypeScript plugin can annotate its function instead. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
