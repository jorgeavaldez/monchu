/**
 * Pi's extension shapes on Durable, for `plugins.ts`: a Pi tool definition as a Durable tool, Pi's events as Durable
 * hooks, and `ctx.ui` as lines and statuses on a root's clients. Guards fail closed, as in Pi: a `tool_call` handler that
 * throws blocks the call, and a `tool_result` handler that throws withholds the result.
 */
import { isJsonValue, type Context } from "@earendil-works/chord";
import {
  CompactionTask,
  defineDoc,
  defineTool,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Harness,
  type HookApi,
  type HookRegistration,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  PluginContext,
  PluginEvents,
  PluginTool,
  PluginToolResult,
  PluginUI,
} from "../plugin.ts";
import { rootOf } from "./agents/workers.ts";

/**
 * What plugins show a root's clients: lines once each, newest last, and status lines by key, shown when a client opens
 * the root. Kept on the root, so a client that opens later sees only the lines that come after, and every status.
 */
export const ClientNoticesDoc = defineDoc<{
  next: number;
  items: { id: number; text: string }[];
  status: Record<string, string>;
}>({
  kind: "monchu.client-notices",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ next: 1, items: [], status: {} }),
});

/** Post a line to a root's clients, inside a commit. */
async function postNotice(tx: Tx, root: ConversationId, text: string): Promise<void> {
  const doc = await tx.doc(ClientNoticesDoc, root);
  doc.items.push({ id: doc.next++, text: text.slice(0, 2000) });
  doc.items.splice(0, Math.max(0, doc.items.length - 20));
}

/** Set or clear a root's status line under `key`, inside a commit. */
export async function setStatus(
  tx: Tx,
  root: ConversationId,
  key: string,
  text: string | undefined,
): Promise<void> {
  const doc = await tx.doc(ClientNoticesDoc, root);
  if (text === undefined) delete doc.status[key];
  else doc.status[key] = text.slice(0, 500);
}

/** A conversation's `ctx.ui`: each call commits on its own, to the conversation's root; a failure is reported. */
export function rootUi(
  harness: () => Harness | undefined,
  report: (warning: string) => void,
  id: ConversationId,
  context: Context,
): PluginUI {
  const write = (what: string, change: (tx: Tx, root: ConversationId) => Promise<void>) => {
    const store = harness();
    if (store === undefined) return report(`ui.${what} before Monchu opened its store`);
    void store
      .commit(async (tx) => change(tx, await rootOf(tx, id)), context)
      .catch((error: unknown) =>
        report(`ui.${what} failed: ${error instanceof Error ? error.message : String(error)}`),
      );
  };
  return {
    notify: (message) => write("notify", (tx, root) => postNotice(tx, root, String(message))),
    setStatus: (key, text) =>
      write("setStatus", (tx, root) =>
        setStatus(tx, root, String(key), text === undefined ? undefined : String(text)),
      ),
  };
}

const content = (result: ToolExecutionResult) => result.output ?? [];

/** A Pi tool definition as a Durable tool; only `name`, `description` and `parameters` reach the model. */
export function durableTool(
  tool: PluginTool,
  ui: (id: ConversationId, context: Context) => PluginUI,
): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.replay === undefined ? {} : { replay: tool.replay }),
    ...(tool.outputLimits === undefined ? {} : { outputLimits: tool.outputLimits }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    ...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
    execute: async (args, api, context) => {
      const result: PluginToolResult = await tool.execute(
        api.callId,
        args,
        context.abortSignal,
        (partial) => {
          if (partial.details !== undefined) void api.details(partial.details, context);
        },
        {
          conversationId: api.conversationId,
          ui: ui(api.conversationId, context),
          signal: context.abortSignal,
          durable: { api, context },
        },
      );
      return {
        ...(result.content === undefined ? {} : { output: result.content }),
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.structuredContent === undefined
          ? {}
          : { structuredOutput: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    },
  });
}

/** Runs a handler; on a throw, reports once and returns `failed` instead. */
export type Guard = <T>(event: string, run: () => T | Promise<T>) => Promise<T | "failed">;

type Handlers = { [E in keyof PluginEvents]: PluginEvents[E][] };

function contextOf(
  api: HookApi,
  context: Context,
  ui: (id: ConversationId, context: Context) => PluginUI,
): PluginContext {
  return {
    conversationId: api.conversationId,
    ui: ui(api.conversationId, context),
    signal: context.abortSignal,
    durable: { api, context },
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

/**
 * Durable hooks over a plugin's Pi-shaped handlers, in registration order. A `tool_call` or `tool_result` handler that
 * throws fails closed, except on a call that `repairs` names: Monchu's way to fix that plugin, which a broken handler
 * must never take away.
 */
export function durableHooks(
  handlers: Handlers,
  guard: Guard,
  ui: (id: ConversationId, context: Context) => PluginUI,
  repairs: (toolName: string, input: Record<string, unknown>) => boolean,
): HookRegistration[] {
  const hooks: HookRegistration[] = [];
  const { tool_call, tool_result, context, message_end, turn_end, agent_before_settle } = handlers;
  if (tool_call.length || tool_result.length)
    hooks.push(
      hook(ToolTask, {
        ...(tool_call.length
          ? {
              beforeTool: async (call, api, ctx: Context) => {
                const event = {
                  type: "tool_call" as const,
                  toolCallId: call.id,
                  toolName: call.name,
                  input: structuredClone(record(call.arguments)),
                  ...(call.parent === undefined ? {} : { parentToolCallId: call.parent.callId }),
                };
                const before = JSON.stringify(event.input);
                for (const handler of tool_call) {
                  const decision = await guard("tool_call", () =>
                    handler(event, contextOf(api, ctx, ui)),
                  );
                  if (decision === "failed") {
                    if (repairs(call.name, record(call.arguments))) continue;
                    return { block: "A plugin's tool_call guard failed, so the call is blocked." };
                  }
                  if (decision?.block === true)
                    return { block: decision.reason ?? "Blocked by a plugin." };
                }
                if (JSON.stringify(event.input) === before) return undefined;
                if (!isJsonValue(event.input) || Array.isArray(event.input))
                  return {
                    block: "A plugin changed the call's input to something that isn't JSON.",
                  };
                return { arguments: event.input };
              },
            }
          : {}),
        ...(tool_result.length
          ? {
              afterTool: async (call, result, api, ctx: Context) => {
                let current = result;
                for (const handler of tool_result) {
                  const event = {
                    type: "tool_result" as const,
                    toolCallId: call.id,
                    toolName: call.name,
                    input: record(call.arguments),
                    ...(call.parent === undefined ? {} : { parentToolCallId: call.parent.callId }),
                    content: content(current),
                    details: current.details,
                    ...(current.structuredOutput === undefined
                      ? {}
                      : { structuredContent: current.structuredOutput }),
                    isError: current.isError === true,
                  };
                  const change = await guard("tool_result", () =>
                    handler(event, contextOf(api, ctx, ui)),
                  );
                  if (change === "failed") {
                    if (repairs(call.name, record(call.arguments))) continue;
                    return {
                      output: [
                        {
                          type: "text",
                          text: "A plugin's tool_result handler failed, so this result is withheld.",
                        },
                      ],
                      isError: true,
                    };
                  }
                  if (change === undefined) continue;
                  // As in Pi: new content without new structured content drops the old, which may no longer match.
                  const { structuredOutput: _dropped, ...kept } = current;
                  current = {
                    ...(change.content === undefined ? current : kept),
                    ...(change.content === undefined ? {} : { output: change.content }),
                    ...(change.details === undefined ? {} : { details: change.details }),
                    ...(change.structuredContent === undefined
                      ? {}
                      : { structuredOutput: change.structuredContent }),
                    ...(change.isError === undefined ? {} : { isError: change.isError }),
                  };
                }
                return current === result ? undefined : current;
              },
            }
          : {}),
      }),
    );
  if (context.length || message_end.length || turn_end.length || agent_before_settle.length)
    hooks.push(
      hook(GenerationTask, {
        ...(context.length
          ? {
              beforeRequest: async (request, api, ctx: Context) => {
                let messages = request.messages;
                for (const handler of context) {
                  const change = await guard("context", () =>
                    handler({ type: "context", messages }, contextOf(api, ctx, ui)),
                  );
                  if (change !== "failed" && change?.messages !== undefined)
                    messages = change.messages;
                }
                return messages === request.messages ? undefined : { messages };
              },
            }
          : {}),
        ...(message_end.length
          ? {
              afterResponse: async (message, api, ctx: Context) => {
                for (const handler of message_end)
                  await guard("message_end", () =>
                    handler({ type: "message_end", message }, contextOf(api, ctx, ui)),
                  );
              },
            }
          : {}),
        ...(turn_end.length
          ? {
              afterTools: async (assistant, results, api, ctx: Context) => {
                for (const handler of turn_end)
                  await guard("turn_end", () =>
                    handler(
                      { type: "turn_end", messageEntryId: assistant, toolResultEntryIds: results },
                      contextOf(api, ctx, ui),
                    ),
                  );
              },
            }
          : {}),
        ...(agent_before_settle.length
          ? {
              onYield: async (message, api, ctx: Context) => {
                for (const handler of agent_before_settle) {
                  const decision = await guard("agent_before_settle", () =>
                    handler({ type: "agent_before_settle", message }, contextOf(api, ctx, ui)),
                  );
                  if (decision !== "failed" && decision?.continue === true)
                    return { continue: decision.message ?? "Continue." };
                }
                return undefined;
              },
            }
          : {}),
      }),
    );
  if (handlers.session_before_compact.length)
    hooks.push(
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx: Context) => {
          for (const handler of handlers.session_before_compact) {
            const decision = await guard("session_before_compact", () =>
              handler(
                {
                  type: "session_before_compact",
                  reason: compaction.reason,
                  messages: compaction.messages,
                  ...(compaction.instructions === undefined
                    ? {}
                    : { customInstructions: compaction.instructions }),
                },
                contextOf(api, ctx, ui),
              ),
            );
            if (decision === "failed" || decision === undefined) continue;
            if (decision.cancel === true) return { decline: true };
            if (decision.compaction !== undefined) return { summary: decision.compaction.summary };
          }
          return undefined;
        },
      }),
    );
  return hooks;
}
