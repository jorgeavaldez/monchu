import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSession,
  openSession,
  type Session,
  type ContentBlock,
  type UserContentBlock,
} from "cc-session-io";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  cleanupSessionResources,
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
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  type EntryRecord,
  Harness,
  type HarnessSettings,
  type JsonObject,
  type Registry,
  type TaskId,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSync, Visitor, type Node } from "oxc-parser";
import { Codemode } from "../src/core/tools/codemode.ts";
import {
  type ClaudeConfig,
  type ModelRole,
  resolveSettings,
  type WorkerProfile,
} from "../src/core/config.ts";
import { createClaudeCodeProvider, type ClaudeQuery } from "../src/core/models/claude-code.ts";
import { openModels } from "../src/core/models/index.ts";
import { FffFinders } from "../src/core/tools/fff.ts";
import { createPiTools } from "../src/core/tools/pi-tools.ts";
import { createWorkerTools, WorkersDoc } from "../src/core/agents/workers.ts";

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
    answer: () => routed("front", 0.9),
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

/** A routing-helper answer: who handles the input, with an optional worker pick and the split. */
export function routed(
  route: "front" | "worker",
  routeProbability: number,
  more: {
    worker?: [string, number];
    split?: ["one" | "several", number];
    profile?: [string, number];
  } = {},
): ClassifierResult {
  const choice = (picked: string, other: string, probability: number) => ({
    type: "choice" as const,
    choice: picked,
    confidence: 2 * probability - 1,
    probabilities: { [picked]: probability, [other]: 1 - probability },
  });
  const [split, splitProbability] = more.split ?? ["one", 0.9];
  return {
    api: "test-classifier",
    provider: "clef-test",
    model: "clef-test",
    answers: {
      route: choice(route, route === "worker" ? "front" : "worker", routeProbability),
      ...(more.worker === undefined
        ? {}
        : { worker: choice(more.worker[0], "new", more.worker[1]) }),
      split: choice(split, split === "one" ? "several" : "one", splitProbability),
      ...(more.profile === undefined
        ? {}
        : { profile: choice(more.profile[0], "other", more.profile[1]) }),
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
  /** Decoy Pi directory inside this test home; not created. */
  readonly agentDir: string;
  readonly finders: FffFinders;
};

const directories = new Set<string>();
const findersToClose = new Set<FffFinders>();
// The suite-wide sandbox vitest.config.ts sets; each test narrows it to its own directory.
const sandbox = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  MONCHU_DEV_HOME: process.env.MONCHU_DEV_HOME,
  MONCHU_TEST_SHELL_ENV: process.env.MONCHU_TEST_SHELL_ENV,
};

export async function cleanup(): Promise<void> {
  cleanupSessionResources();
  for (const finders of findersToClose) await finders.close();
  findersToClose.clear();
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
    MONCHU_TEST_SHELL_ENV: "unchanged-process-value",
  });
}

/**
 * The front's tools as Monchu installs them in a fresh temp home.
 * Default user resources (`~/.agents`, `~/.pi/agent`) resolve inside it. Call `cleanup` after each test.
 */
export async function setup(
  options: RegisterFauxProviderOptions = {},
  profiles: Record<string, WorkerProfile> = {},
): Promise<Setup> {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createWorkerTools(() => fauxRole, profiles));
  registry.install(Codemode);
  const directory = await mkdtemp(join(tmpdir(), "monchu-test-"));
  directories.add(directory);
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  const agentDir = join(directory, ".pi", "agent");
  prepareHome(directory);
  const reports: unknown[] = [];
  const finders = new FffFinders(directory, (warning) => reports.push(warning));
  findersToClose.add(finders);
  registry.install(createPiTools(resolveSettings({}), finders).extension);
  return { faux, models, registry, reports, directory, agentDir, finders };
}

export async function open(
  value: Pick<Setup, "directory" | "registry" | "reports"> & { models: Models },
  settings?: HarnessSettings,
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(value.directory, "monchu.sqlite")),
    {
      models: value.models,
      registry: value.registry,
      ...(settings === undefined ? {} : { settings }),
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

/** A PNG of `width` by `height` noise at `path`, so it doesn't compress away. */
export async function writePng(path: string, width: number, height: number): Promise<void> {
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const pixels = new Uint8Array(width * height * 4).map((_, index) =>
    index % 4 === 3 ? 255 : (index * 7919) % 251,
  );
  const image = new PhotonImage(pixels, width, height);
  try {
    await writeFile(path, image.get_bytes());
  } finally {
    image.free();
  }
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

/** Inject only the Claude SDK boundary; mirror its persisted sessions and open prompt input. */
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
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<SDKMessage> {
        const options = input.options;
        if (
          options === undefined ||
          options.cwd === undefined ||
          options.env?.CLAUDE_CONFIG_DIR === undefined
        )
          throw new Error("Claude script needs explicit isolated options");
        if (typeof input.prompt === "string") throw new Error("Claude script needs streamed input");
        const source = input.prompt[Symbol.asyncIterator]();
        const first = await source.next();
        if (first.done) throw new Error("Claude script needs an initial prompt");
        const prompt = [first.value];
        const session =
          options.resume === undefined
            ? createSession({
                projectPath: options.cwd,
                cwd: options.cwd,
                claudeDir: options.env.CLAUDE_CONFIG_DIR,
                model: options.model ?? "claude-sonnet-4-6",
              })
            : openSession({
                sessionId: options.resume,
                projectPath: options.cwd,
                claudeDir: options.env.CLAUDE_CONFIG_DIR,
              });
        requests.push({ input, prompt, history: [...session.messages], path: session.jsonlPath });
        // Keep consuming so a steer gets its write acknowledgement, just as with the real SDK stdin pump.
        const drain = (async () => {
          for (;;) {
            const item = await source.next();
            if (item.done) break;
            prompt.push(item.value);
          }
        })();
        const content = first.value.message.content;
        if (typeof content === "string") session.addUserMessage(content);
        else
          session.addUserMessage(
            content.flatMap((block): UserContentBlock[] => {
              if (block.type === "text") return [{ type: "text", text: block.text }];
              if (block.type === "image" && block.source.type === "base64")
                return [{ type: "image", source: block.source }];
              throw new Error("Claude script received an unsupported prompt block");
            }),
          );
        session.save();
        yield {
          type: "system",
          subtype: "init",
          uuid: randomUUID(),
          session_id: session.sessionId,
          apiKeySource: "none",
          claude_code_version: "injected",
          cwd: options.cwd,
          tools: [],
          mcp_servers: [],
          model: options.model ?? "claude-sonnet-4-6",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
        };
        for await (const message of respond(input)) {
          if (message.type === "assistant") {
            const blocks: ContentBlock[] = [];
            for (const block of message.message.content) {
              if (block.type === "text") blocks.push({ type: "text", text: block.text });
              else if (block.type === "thinking")
                blocks.push({
                  type: "thinking",
                  thinking: block.thinking,
                  signature: block.signature,
                });
              else if (block.type === "tool_use")
                blocks.push({
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
            }
            session.addAssistantMessage(blocks, {
              model: message.message.model,
              stopReason: message.message.stop_reason ?? "end_turn",
            });
            session.save();
          }
          yield { ...message, session_id: session.sessionId };
        }
        yield {
          type: "result",
          subtype: "success",
          uuid: randomUUID(),
          session_id: session.sessionId,
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: false,
          num_turns: 1,
          result: "",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          modelUsage: {},
          permission_denials: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            inference_geo: "",
            iterations: [],
            speed: "standard",
            fallback_credit: null,
            output_tokens_details: { thinking_tokens: 0 },
          },
        };
        await drain;
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
  const messages: SDKMessage[] = events.map((event) => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "script",
  }));
  const start = events[0];
  if (start?.type !== "message_start") throw new Error("Claude response needs message_start");
  const blocks: typeof start.message.content = content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text, citations: null };
    if (block.type === "thinking")
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.thinkingSignature ?? "signed_script",
      };
    return {
      type: "tool_use",
      id: block.id,
      name: `mcp__monchu__${block.name}`,
      input: block.arguments,
    };
  });
  messages.push({
    type: "assistant",
    uuid: randomUUID(),
    session_id: "script",
    parent_tool_use_id: null,
    message: { ...start.message, content: blocks, stop_reason: stopReason },
  });
  return messages;
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

/**
 * What a home's structured log says, one record body per line, for checks on what was logged. Decoded, not raw: JSON
 * escapes the backslashes of Windows paths.
 */
export async function logText(home: string): Promise<string> {
  const directory = join(home, "logs");
  const files = (await readdir(directory).catch(() => [])).toSorted((a, b) => a.localeCompare(b));
  const lines = (await Promise.all(files.map((name) => readFile(join(directory, name), "utf8"))))
    .join("")
    .split("\n");
  return lines
    .flatMap((line) => {
      if (!line) return [];
      const record: unknown = JSON.parse(line);
      return typeof record === "object" && record !== null && "body" in record
        ? [String(record.body)]
        : [];
    })
    .join("\n");
}
