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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codemode } from "../src/codemode.ts";
import type { ModelRole } from "../src/config.ts";
import { createPiTools } from "../src/pi-tools.ts";
import { createWorkerTools, WorkersDoc } from "../src/workers.ts";

export const context: Context = BACKGROUND_CONTEXT;

export const fauxRole: ModelRole = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

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
};

export async function cleanup(): Promise<void> {
  for (const [key, value] of Object.entries(sandbox)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
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
  Object.assign(process.env, {
    HOME: directory,
    USERPROFILE: directory,
    PI_CODING_AGENT_DIR: agentDir,
  });
  return { faux, models, registry, reports: [], directory, agentDir };
}

export async function open(
  value: Setup,
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
