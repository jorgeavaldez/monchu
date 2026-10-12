import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { openSession, type Session } from "cc-session-io";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  type ClassifierModel,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierResult,
  fauxAssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  type RegisterFauxProviderOptions,
  fauxProvider,
  fauxToolCall,
  type Message,
  type MutableModels,
  type Models,
  type AssistantMessage,
  type Provider,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  type EntryRecord,
  Harness,
  type JsonObject,
  type Registry,
  type TaskId,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSync, Visitor, type Node } from "oxc-parser";
import { Codemode } from "../src/codemode.ts";
import type { ClaudeConfig, ModelRole } from "../src/config.ts";
import { createClaudeCodeProvider, type ClaudeQuery } from "../src/models/claude-code.ts";
import { openModels } from "../src/models/index.ts";
import { createPiTools } from "../src/pi-tools.ts";
import { createWorkerTools, WorkersDoc } from "../src/workers.ts";

export const context: Context = BACKGROUND_CONTEXT;

export const fauxRole: ModelRole = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

/** Direct environment access, including computed property spelling. */
function isProcessEnvironment(node: Node): boolean {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    (node.computed
      ? node.property.type === "Literal" && node.property.value === "env"
      : node.property.type === "Identifier" && node.property.name === "env")
  );
}

function isEnvironmentTarget(node: Node): boolean {
  return (
    isProcessEnvironment(node) ||
    (node.type === "MemberExpression" && isEnvironmentTarget(node.object))
  );
}

/** Syntax-aware guard: writes, mutation calls and aliases cannot move host setup into library code. */
export function environmentMutations(source: string): number[] {
  const parsed = parseSync("source.ts", source);
  if (parsed.errors.length)
    throw new Error("Cannot parse source for the environment ownership check");
  const mutations: number[] = [];
  new Visitor({
    AssignmentExpression: (node) => {
      if (isEnvironmentTarget(node.left)) mutations.push(node.start);
    },
    UpdateExpression: (node) => {
      if (isEnvironmentTarget(node.argument)) mutations.push(node.start);
    },
    UnaryExpression: (node) => {
      if (node.operator === "delete" && isEnvironmentTarget(node.argument))
        mutations.push(node.start);
    },
    VariableDeclarator: (node) => {
      if (node.init && isProcessEnvironment(node.init)) mutations.push(node.start);
    },
    CallExpression: (node) => {
      if (!node.arguments.some(isProcessEnvironment)) return;
      // These inspect the environment rather than handing its mutable reference to another owner.
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        node.callee.property.type === "Identifier" &&
        ["keys", "entries", "values"].includes(node.callee.property.name)
      )
        return;
      mutations.push(node.start);
    },
  }).visit(parsed.program);
  return mutations;
}

/** Pending classifier answers, resolved by the test. */
export type ScriptedClassifier = {
  readonly requests: ClassifierContext[];
  answer: (request: ClassifierContext) => ClassifierResult | Promise<ClassifierResult>;
};

export const classifierModel: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: "clef-test",
  name: "clef-test",
  api: "test-classifier",
  provider: "clef-test",
  baseUrl: "https://example.test/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
};

/** A classifier provider whose answers the test scripts; everything else is the real pi-ai Models. */
export function scriptedClassifier(models: MutableModels): ScriptedClassifier {
  const scripted: ScriptedClassifier = {
    requests: [],
    answer: () => assessed("single_turn", 0.9, "contained", 0.9),
  };
  models.setProvider(
    createProvider({
      id: "clef-test",
      auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
      models: [classifierModel],
      classifiers: {
        "test-classifier": {
          classify: async (_model, request) => {
            scripted.requests.push(request);
            return scripted.answer(request);
          },
        },
      },
    }),
  );
  return scripted;
}

export function assessed(
  effort: "single_turn" | "sustained",
  effortConfidence: number,
  scope: "contained" | "expanding",
  scopeConfidence: number,
): ClassifierResult {
  const choice = (picked: string, other: string, confidence: number) => ({
    type: "choice" as const,
    choice: picked,
    confidence,
    probabilities: { [picked]: confidence, [other]: 1 - confidence },
  });
  return {
    api: "test-classifier",
    provider: "clef-test",
    model: "clef-test",
    answers: {
      effort: choice(
        effort,
        effort === "sustained" ? "single_turn" : "sustained",
        effortConfidence,
      ),
      scope: choice(scope, scope === "expanding" ? "contained" : "expanding", scopeConfidence),
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Models and registry that survive a close and reopen, like the host process's own objects. */
export type Setup = {
  readonly faux: FauxProviderHandle;
  readonly models: MutableModels;
  readonly registry: Registry;
  readonly reports: unknown[];
  /** A fresh temp directory: this test's home and default execution directory. */
  readonly directory: string;
  /** Pi's agent directory inside `directory`; not created. */
  readonly agentDir: string;
};

const directories = new Set<string>();
// The suite-wide sandbox vitest.config.ts sets; each test narrows it to its own directory.
const sandbox = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  MONCHU_DEV_HOME: process.env.MONCHU_DEV_HOME,
};

export async function cleanup(): Promise<void> {
  for (const [key, value] of Object.entries(sandbox)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
}

/** Prepare the process for an explicit test home, just as the entry point does before opening Monchu. */
export function prepareHome(home: string): void {
  directories.add(home);
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, "agent"),
  });
}

/**
 * The front's tools as Monchu installs them, in a fresh directory that is also this test's home and Pi agent directory
 * parent, so Pi's user resources (`~/.agents`, `~/.pi/agent`) resolve inside it. Call `cleanup` after each test.
 */
export async function setup(options: RegisterFauxProviderOptions = {}): Promise<Setup> {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createPiTools(SettingsManager.inMemory({}), process.platform).extension);
  registry.install(createWorkerTools(fauxRole));
  registry.install(Codemode);
  const directory = await mkdtemp(join(tmpdir(), "monchu-test-"));
  directories.add(directory);
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  const agentDir = join(directory, "agent");
  prepareHome(directory);
  return { faux, models, registry, reports: [], directory, agentDir };
}

export async function open(
  value: Pick<Setup, "directory" | "registry" | "reports"> & { models: Models },
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(value.directory, "monchu.sqlite")),
    {
      models: value.models,
      registry: value.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? value.directory }),
      onReport: (error) => value.reports.push(error),
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: value.directory },
  });
  harness.resume();
  return { harness, root };
}

/** A conversation that must exist. */
export async function conversationOf(harness: Harness, id: ConversationId): Promise<Conversation> {
  const conversation = await harness.conversation(id, context);
  if (conversation === undefined) throw new Error(`No conversation ${id}`);
  return conversation;
}

/** The task of the parent's delivery at `index` (`-1` is the newest), which must exist. */
export async function deliveryTaskId(
  harness: Harness,
  parentId: ConversationId,
  index: number,
): Promise<TaskId> {
  const delivery = (await harness.snapshot(WorkersDoc, parentId, context))?.deliveries.at(index);
  if (delivery === undefined) throw new Error(`No delivery at ${index}`);
  return delivery.taskId;
}

/** Raw entries of a conversation, oldest first. */
export async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 1000, undefined, context);
  return [...page.items].reverse();
}

/** Tool results in a conversation's transcript, oldest first. */
export async function toolResults(conversation: Conversation): Promise<ToolResultMessage[]> {
  return (await allEntries(conversation)).flatMap((entry) =>
    ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" ? [entry.model[0]] : [],
  );
}

export function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The last non-system message of a request: what the faux model is answering. */
export function lastMessage(messages: readonly Message[]): Message | undefined {
  return messages.findLast((message) => message.role !== "system");
}

/** Prompt section texts a request carries, in order; only sections named `name` when given. */
export function sectionTexts(messages: readonly Message[], name?: string): string[] {
  return messages.flatMap((message) =>
    message.role === "system"
      ? Object.entries(message.sections ?? {}).flatMap(([key, text]) =>
          text !== null && (name === undefined || key === name) ? [text] : [],
        )
      : [],
  );
}

/** One response factory reused for every request. */
export function route(faux: FauxProviderHandle, step: FauxResponseStep): void {
  faux.setResponses(Array.from({ length: 100 }, () => step));
}

/** Answer a user message named in `calls` with that tool call, and anything else with "ok". */
export function callTools(calls: Record<string, { tool: string; args: JsonObject }>) {
  return (request: { messages: readonly Message[] }) => {
    const last = lastMessage(request.messages);
    const call = last?.role === "user" ? calls[textOf(last)] : undefined;
    return call === undefined
      ? fauxAssistantMessage("ok")
      : fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" });
  };
}

/** Script the real provider's sole external boundary, retaining disposable replay files at query entry. */
export function scriptedClaude(
  home: string,
  config: ClaudeConfig,
  respond: (input: Parameters<ClaudeQuery>[0]) => AsyncIterable<SDKMessage>,
) {
  const requests: {
    input: Parameters<ClaudeQuery>[0];
    prompt: SDKUserMessage[];
    history: Session["messages"];
    path: string | undefined;
  }[] = [];
  let closed = 0;
  let interrupted = 0;
  const query: ClaudeQuery = (input) => {
    let isClosed = false;
    return {
      [Symbol.asyncIterator]: async function* () {
        const options = input.options;
        if (
          options === undefined ||
          options.cwd === undefined ||
          options.env?.CLAUDE_CONFIG_DIR === undefined
        )
          throw new Error("Claude script needs explicit isolated options");
        if (typeof input.prompt === "string") throw new Error("Claude script needs streamed input");
        const prompt: SDKUserMessage[] = [];
        for await (const message of input.prompt) prompt.push(message);
        const session =
          options.resume === undefined
            ? undefined
            : openSession({
                sessionId: options.resume,
                projectPath: options.cwd,
                claudeDir: options.env.CLAUDE_CONFIG_DIR,
              });
        requests.push({
          input,
          prompt,
          history: session?.messages ?? [],
          path: session?.jsonlPath,
        });
        yield* respond(input);
      },
      interrupt: () => {
        interrupted++;
        return Promise.resolve();
      },
      close: () => {
        if (!isClosed) {
          isClosed = true;
          closed++;
        }
      },
    };
  };
  return {
    provider: createClaudeCodeProvider(home, config, query),
    requests,
    closed: () => closed,
    interrupted: () => interrupted,
  };
}

/** Authenticated test setup through Monchu's real credential and login seam. */
export async function openClaudeModels(
  home: string,
  provider: Provider,
  token: string,
): Promise<Models> {
  const models = await openModels(home, provider);
  await models.login("claude-code", "oauth", { prompt: async () => token, notify: () => {} });
  return models;
}

/** SDK frames, not faux Pi events: exercise streaming, signed thinking and tool argument assembly. */
export function claudeResponse(
  content: AssistantMessage["content"],
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn",
): SDKMessage[] {
  const events: SDKPartialAssistantMessage["event"][] = [
    {
      type: "message_start",
      message: {
        id: "msg_script",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        container: null,
        context_management: null,
        diagnostics: null,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_creation: null,
          fallback_credit: null,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
      },
    },
  ];
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "", citations: null },
        },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    } else if (block.type === "thinking") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking, estimated_tokens: 2 },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.thinkingSignature ?? "signed_script" },
        },
      );
    } else {
      const args = JSON.stringify(block.arguments);
      const split = Math.floor(args.length / 2);
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: `mcp__monchu__${block.name}`,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: args.slice(0, split) },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: args.slice(split) },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      context_management: null,
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, container: null },
      usage: {
        input_tokens: null,
        output_tokens: 7,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        fallback_credit: null,
        iterations: null,
        output_tokens_details: { thinking_tokens: 3 },
        server_tool_use: null,
      },
    },
    { type: "message_stop" },
  );
  return events.map((event) => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "script",
  }));
}

/** Poll `check` in real time until it holds. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
