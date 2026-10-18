/**
 * `monchu/plugin`: what a Monchu plugin imports. A plugin is a folder whose `index.ts` (or `index.js`) default-exports
 * a function that receives a `PluginApi` and registers tools, prompt sections and event handlers, in the shape of Pi's
 * extension API. Monchu maps them onto Durable extensions. See `docs/plugins.md`.
 *
 * Plugins import this module, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` and
 * `typebox` from Monchu's own copies, never from a copy of their own.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type {
  AnyTask,
  CompactionHooks,
  ConversationId,
  EntryId,
  HookApi,
  HookResult,
  JsonObject,
  PromptInput,
  ToolExecutionResult,
  ToolHookCall,
  ToolRegistration,
  Tx,
  UserInput,
} from "@earendil-works/pi-durable";

export { Type } from "@earendil-works/pi-ai";
export { defineDoc, defineTask, defineTool } from "@earendil-works/pi-durable";
export type {
  AnyTask,
  ConversationId,
  HookApi,
  PromptInput,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolHookCall,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";

/**
 * How the model reaches a tool, as Pi's `exposure`:
 * - `deferred` (the default): kept out of every conversation's tools until `tool_search` loads the plugin's group, so
 *   adding or editing a plugin never costs a prompt cache. Codemode scripts can call it any time.
 * - `direct`: offered to the model in every conversation. Adding one, or changing its definition, re-caches every
 *   conversation once; use it only for tools most turns need.
 * - `codemode`: only codemode scripts call it, found with `searchTools()`; never declared to the model.
 */
export type ToolExposure = "deferred" | "direct" | "codemode";

/** Event handlers, by Pi's event names, with Durable's arguments. A handler that throws is reported and ignored. */
export type PluginEvents = {
  /** Before a tool runs (Durable `beforeTool`): `block` refuses the call with that reason, `arguments` replace them. */
  tool_call: (
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ) => HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
  /** After a tool ran, before its result is committed (`afterTool`): the returned result replaces it. */
  tool_result: (
    call: ToolHookCall,
    result: ToolExecutionResult,
    api: HookApi,
    context: Context,
  ) => HookResult<ToolExecutionResult>;
  /** Before each model request (`beforeRequest`): the returned messages are sent for that request only. */
  context: (
    request: { readonly messages: readonly Message[] },
    api: HookApi,
    context: Context,
  ) => HookResult<{ readonly messages: readonly Message[] }>;
  /** Each final provider message (`afterResponse`); observe only. */
  message_end: (message: AssistantMessage, api: HookApi, context: Context) => void | Promise<void>;
  /** After every tool of a round finished (`afterTools`), with the round's result entries in call order. */
  turn_end: (
    assistant: EntryId,
    results: readonly EntryId[],
    api: HookApi,
    context: Context,
  ) => void | Promise<void>;
  /** A final answer (`onYield`): returning `continue` appends that input and continues the run once. */
  agent_before_settle: (
    answer: AssistantMessage,
    api: HookApi,
    context: Context,
  ) => HookResult<{ readonly continue: UserInput }>;
  /** Before a compaction summarizes (`beforeCompact`): `decline` skips it, `summary` replaces the summarizer. */
  session_before_compact: CompactionHooks["beforeCompact"];
  /** This plugin instance is retired: a reload replaced or removed it, or Monchu is closing. Release resources here. */
  session_shutdown: () => void | Promise<void>;
};

/** A slash command in every client: `/<name> <args>` runs `run` in the core and shows what it returns. */
export type PluginCommand = {
  /** Shown after the name in help and typeahead, such as `[id]`. */
  readonly usage?: string;
  /** One short line, shown beside the command on a phone. */
  readonly help: string;
  readonly run: (args: string) => string | Promise<string>;
};

/** Whose a secret use is, for the audit: the tool (or command) and the conversation's short id. */
export type SecretUse = { readonly tool: string; readonly conversation: string };

/** The home's secrets, by name. Values reach only the plugin's own code, never the model. */
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
  redacting<P extends TSchema>(tool: ToolRegistration<P>): ToolRegistration<P>;
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

/** Monchu's fronts and workers, read and messaged inside a Durable transaction. */
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
}

/** What a plugin's function receives. Registration only counts while the function runs. */
export interface PluginApi {
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
  readonly secrets: PluginSecrets;
  readonly agents: PluginAgents;
  /**
   * Describe the plugin's deferred tools, as Pi's tool `namespace`: `description` is the one line `tool_search` lists,
   * `instructions` a guide returned once when the group loads. `preload` loads the group from the start in
   * conversations on the Claude Code bridge, whose prompt cache a later load would cost.
   */
  namespace(options: {
    readonly description: string;
    readonly instructions?: string;
    readonly preload?: boolean;
  }): void;
  registerTool(tool: ToolRegistration, options?: { readonly exposure?: ToolExposure }): void;
  /**
   * A system prompt section, rendered before each request as `<plugin>_<key>` and patched in the stream when its text
   * changes. Render a short stable placeholder rather than nothing: a section that appears later re-sends the others.
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
  /**
   * A Durable task the plugin's tools create, such as a wait that outlives a turn. Name it after the plugin; its
   * definition must be registered at every load, so pending tasks resume.
   */
  registerTask(task: AnyTask): void;
  /** `/<name>`: lowercase letters, digits and dashes. A built-in command of the same name wins. */
  registerCommand(name: string, command: PluginCommand): void;
}

/** A plugin's default export. It may be async; Monchu waits for it (up to 10 seconds) before loading the next one. */
export type Plugin = (monchu: PluginApi) => void | Promise<void>;

/** Types a plugin written in JavaScript; a TypeScript plugin can annotate its function instead. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
