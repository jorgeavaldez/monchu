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
import type {
  CompactionHooks,
  EntryId,
  HookApi,
  HookResult,
  JsonObject,
  PromptInput,
  ToolExecutionResult,
  ToolHookCall,
  ToolRegistration,
  UserInput,
} from "@earendil-works/pi-durable";

export { Type } from "@earendil-works/pi-ai";
export { defineDoc, defineTool } from "@earendil-works/pi-durable";
export type {
  HookApi,
  PromptInput,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolHookCall,
  ToolRegistration,
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
}

/** A plugin's default export. It may be async; Monchu waits for it (up to 10 seconds) before loading the next one. */
export type Plugin = (monchu: PluginApi) => void | Promise<void>;

/** Types a plugin written in JavaScript; a TypeScript plugin can annotate its function instead. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
