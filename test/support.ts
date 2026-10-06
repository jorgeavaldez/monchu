import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  type ClassifierModel,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierResult,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxProvider,
  type Message,
  type MutableModels,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  type EntryRecord,
  Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codemode } from "../src/codemode.ts";
import type { ModelRole } from "../src/config.ts";
import { createWorkerTools } from "../src/workers.ts";

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
  readonly directory: string;
};

const directories = new Set<string>();

export async function cleanup(): Promise<void> {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
}

/** The front's tools, as Monchu installs them. */
export async function setup(options: { tokensPerSecond?: number } = {}): Promise<Setup> {
  const faux = fauxProvider(
    options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond },
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createWorkerTools(fauxRole));
  registry.install(Codemode);
  const directory = await mkdtemp(join(tmpdir(), "monchu-test-"));
  directories.add(directory);
  return { faux, models, registry, reports: [], directory };
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

/** Raw entries of a conversation, oldest first. */
export async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 1000, undefined, context);
  return [...page.items].reverse();
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

/** One response factory reused for every request. */
export function route(faux: FauxProviderHandle, step: FauxResponseStep): void {
  faux.setResponses(Array.from({ length: 100 }, () => step));
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
