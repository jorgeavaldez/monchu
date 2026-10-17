import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  CodemodeSandbox,
  renderToolSample,
  toCodemodeIdentifier,
  type CodemodeJsonSchema,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { isScriptExtension, rankDocuments, toolDocument } from "./tool-search.ts";

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

/** A nested call's text: its output, or the local output when it returns none, then its error diagnostics. */
function resultText(
  result: ToolExecutionResult,
  output: string,
  diagnostics: readonly ToolDiagnostic[],
): string {
  const text =
    result.output === undefined
      ? output
      : result.output
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n");
  const errors = [...diagnostics, ...(result.diagnostics ?? [])]
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
  return [text, ...errors].filter((part) => part !== "").join("\n");
}

/** What a script sees of a tool: tools resolve to their text output. */
function sample(tool: ToolRegistration): string {
  const inputSchema: CodemodeJsonSchema = { ...tool.parameters };
  return renderToolSample({
    name: tool.name,
    description: tool.description,
    inputSchema,
    outputSchema: { type: "string" },
  });
}

/** A global's spread arguments. */
function spreadArgs(args: unknown): unknown[] {
  const list: unknown[] = Array.isArray(args) ? args : [];
  return list;
}

/** `searchTools()` and `describeTool()` over every tool a script can call, deferred ones included. */
function discovery(tools: readonly ToolRegistration[]): CodemodeTool[] {
  const samples = new Map(tools.map((tool) => [tool.name, sample(tool)]));
  const entry = (name: string) => ({
    name: toCodemodeIdentifier(name),
    description: samples.get(name) ?? "",
  });
  return [
    {
      name: "searchTools",
      spread: true,
      signature:
        "(query: string, options?: { limit?: number }): Promise<{ name: string; description: string }[]>",
      execute: (args) => {
        const [query, options] = spreadArgs(args);
        if (typeof query !== "string") throw new Error("searchTools() expects a query string");
        const limit: unknown =
          typeof options === "object" && options !== null && "limit" in options ? options.limit : 8;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
          throw new Error("searchTools() limit must be a positive integer");
        return rankDocuments(
          query,
          tools.map((tool) => toolDocument(tool.name, tool)),
          limit,
        ).map(entry);
      },
    },
    {
      name: "describeTool",
      spread: true,
      signature: "(name: string): Promise<string | undefined>",
      execute: (args) => {
        const [name] = spreadArgs(args);
        if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
        const tool = tools.find(
          (candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
        );
        return tool === undefined ? undefined : samples.get(tool.name);
      },
    },
  ];
}

/**
 * Runs model-written JavaScript in Pi's QuickJS sandbox. Scripts call this conversation's other tools as
 * `await tools.<name>(args)`. Nested calls run inside this one Durable tool call: they share its task, cancellation and
 * committed result, and are not separate tool tasks. Scripts also reach the tools of deferred groups the conversation has
 * not loaded, without declaring them to the model. A failed script does not undo earlier calls, so this tool is not
 * replayed after a crash.
 */
export const Codemode = defineExtension({
  name: "monchu.codemode",
  tools: [
    defineTool({
      name: NAME,
      description:
        "Run JavaScript (an async function body) that calls your other tools as `await tools.<name>(args)` with the same arguments they take directly; each call resolves to the tool's text result and throws on tool errors. Scripts can also call deferred tools you have not loaded: `searchTools(query, { limit? })` ranks every callable tool and returns `{ name, description }` with its TypeScript signature, `describeTool(name)` returns one signature, and `ALL_TOOLS` lists them all. Print with text(value) or console.log, or `return` a value. `store(key, value)`/`load(key)` keep JSON values across calls in this conversation. No fetch, timers, require, or filesystem except through tools. Use it to run several tool calls in parallel, loop, or filter large results before they reach you; earlier calls are not undone when a script fails.",
      parameters: Type.Object({ code: Type.String({ minLength: 1 }) }),
      replay: "unsafe",
      execute: async ({ code }, api, context) => {
        const agent = await api.agent(context);
        const controller = new AbortController();
        const forward = () => controller.abort(context.abortSignal?.reason);
        context.abortSignal?.addEventListener("abort", forward, { once: true });
        let calls = 0;
        const offered = new Set(agent.tools.map((tool) => tool.name));
        const selected = new Set(agent.extensions.map((extension) => extension.name));
        const deferred = api.registry
          .installed()
          .filter((extension) => isScriptExtension(extension.name) && !selected.has(extension.name))
          .flatMap((extension) => extension.tools ?? [])
          .filter((tool) => !offered.has(tool.name));
        const callable = [...agent.tools.filter((tool) => tool.name !== NAME), ...deferred];
        const tools: CodemodeTool[] = callable.map((tool) => ({
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
            const diagnostics: ToolDiagnostic[] = [];
            // Nested calls see a distinct call ID and keep their running output, diagnostics and details local.
            const overrides: Partial<ToolExecutionApi> = {
              callId,
              // The local sink needs all text, not the outer call's retained tail.
              outputWindow: undefined,
              output: (chunk) => {
                output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              },
              retainedOutput: () => ({ text: output, truncated: false }),
              diagnostic: (diagnostic) => {
                diagnostics.push(diagnostic);
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
            const text = resultText(result, output, diagnostics);
            if (result.isError) throw new Error(text);
            return text;
          },
        }));
        const saved = await api.snapshot(CodemodeStore, api.conversationId, context);
        const sandbox = new CodemodeSandbox({
          tools,
          globals: discovery(callable),
          timeoutMs: 10 * 60_000,
        });
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
            output: content,
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
