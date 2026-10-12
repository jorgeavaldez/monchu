import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

const NAME = "codemode";

/** `store()`/`load()` values, per conversation. A fork continues with the parent's values. */
const CodemodeStore = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "monchu.codemode-store",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ values: {} }),
});

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: ToolExecutionResult, output: string): string {
  if (result.content === undefined) return output;
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

/**
 * Runs model-written JavaScript in Pi's QuickJS sandbox. Scripts call this conversation's other tools as
 * `await tools.<name>(args)`. Nested calls run inside this one Durable tool call: they share its task, cancellation and
 * committed result, and are not separate tool tasks. A failed script does not undo earlier calls, so this tool is not
 * replayed after a crash.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export const Codemode = defineExtension({
  name: "monchu.codemode",
  tools: [
    defineTool({
      name: NAME,
      description:
        "Run JavaScript (an async function body) that calls your other tools as `await tools.<name>(args)` with the same arguments they take directly; each call resolves to the tool's text result and throws on tool errors. `ALL_TOOLS` lists callable tools. Print with text(value) or console.log, or `return` a value. `store(key, value)`/`load(key)` keep JSON values across calls in this conversation. No fetch, timers, require, or filesystem except through tools. Use it to run several tool calls in parallel, loop, or filter large results before they reach you; earlier calls are not undone when a script fails.",
      parameters: Type.Object({ code: Type.String({ minLength: 1 }) }),
      replay: "unsafe",
      execute: async ({ code }, api, context) => {
        const agent = await api.agent(context);
        const controller = new AbortController();
        const forward = () => controller.abort(context.abortSignal?.reason);
        context.abortSignal?.addEventListener("abort", forward, { once: true });
        let calls = 0;
        const tools: CodemodeTool[] = agent.tools
          .filter((tool) => tool.name !== NAME)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            execute: async (args, { signal }) => {
              if (!isJsonObject(args)) throw new Error(`${tool.name} expects an object argument`);
              const callId = `${api.callId}/${++calls}`;
              // pi-ai types the validated arguments as `any`; the tool's own execute narrows them.
              const validated: unknown = validateToolArguments(tool, {
                type: "toolCall",
                id: callId,
                name: tool.name,
                arguments: args,
              });
              let output = "";
              // Nested calls see a distinct call ID and keep their running output and details local.
              const overrides: Partial<ToolExecutionApi> = {
                callId,
                output: (chunk) => {
                  output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                },
                details: async () => {},
              };
              const nested = new Proxy(api, {
                get(target, property, receiver): unknown {
                  if (Object.hasOwn(overrides, property))
                    return Reflect.get(overrides, property, receiver);
                  const value: unknown = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
              const result = await tool.execute(
                validated,
                nested,
                withAbortSignal(AbortSignal.any([signal, controller.signal]), context),
              );
              const text = resultText(result, output);
              if (result.isError) throw new Error(text);
              return text;
            },
          }));
        const saved = await api.snapshot(CodemodeStore, api.conversationId, context);
        const sandbox = new CodemodeSandbox({ tools, timeoutMs: 10 * 60_000 });
        try {
          const result = await sandbox.execute(code, {
            signal: controller.signal,
            store: saved?.values ?? {},
          });
          if (
            result.ok &&
            (result.storeWrites.delete.length || Object.keys(result.storeWrites.set).length)
          ) {
            const { set, delete: removed } = result.storeWrites;
            await api.commit(async (tx) => {
              const store = await tx.doc(CodemodeStore, api.conversationId);
              for (const key of removed) delete store.values[key];
              for (const [key, value] of Object.entries(set)) {
                if (!isJsonValue(value)) throw new Error(`store(${key}) is not JSON`);
                store.values[key] = value;
              }
            }, context);
          }
          const content = [...result.output];
          if (result.ok && result.value !== undefined)
            content.push({ type: "text", text: JSON.stringify(result.value) });
          if (!result.ok)
            content.push({
              type: "text",
              text: `Script ${result.error.kind} error: ${result.error.stack ?? result.error.message}`,
            });
          if (content.length === 0) content.push({ type: "text", text: "(no output)" });
          return {
            content,
            isError: !result.ok,
            details: {
              calls: result.calls.map(({ name, status, durationMs }) => ({
                name,
                status,
                durationMs,
              })),
            },
          };
        } finally {
          context.abortSignal?.removeEventListener("abort", forward);
          await sandbox.close();
        }
      },
    }),
  ],
});
