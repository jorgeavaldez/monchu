import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  type AgentChange,
  type CommitChange,
  type Conversation,
  type Seq,
} from "@earendil-works/pi-durable";
import { join } from "node:path";
import { logCommitChange, logError, logStage, logSubmission } from "./logging.ts";
import type { Context } from "@earendil-works/chord";
import type { Stage } from "./types.ts";

class Monchu {
  static context: Context = BACKGROUND_CONTEXT;
  static rootAgentOptions: AgentChange = {
    model: { provider: "openai-codex", modelId: "gpt-6.1-sol" },
  };

  static async create(): Promise<Monchu> {
    const models = await Monchu.createModels();

    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      Monchu.context,
    );

    Monchu.onCommits(harness, Monchu.defaultChangeFilter, logCommitChange);

    const rootConversation = await harness.root(Monchu.context, { agent: Monchu.rootAgentOptions });

    return new Monchu(harness, rootConversation);
  }

  static async createModels(): Promise<ModelRuntime> {
    const agentDir = getAgentDir();
    const authPath = join(agentDir, "auth.json");
    const modelsPath = join(agentDir, "models.json");
    logStage("models.create", { authPath, modelsPath });
    const models = await ModelRuntime.create({ authPath, modelsPath });
    const modelError = models.getError();
    if (modelError !== undefined) logError("models.diagnostics", modelError);

    return models;
  }

  static defaultChangeFilter = (change: CommitChange) =>
    change.type === "submission" ||
    (change.type === "task" && change.value.state.status === "terminal") ||
    (change.type === "entry" && AssistantEntry.is(change.value));

  private _stage: Stage = "models.create";
  private _harness: Harness;
  private rootConversation: Conversation;

  public get stage() {
    return this._stage;
  }

  private set stage(stage: Stage) {
    this._stage = stage;
    logStage(stage);
  }

  public get harness() {
    return this._harness;
  }

  private set harness(harness: Harness) {
    this._harness = harness;
    logStage("harness.open");
  }

  constructor(harness: Harness, rootConversation: Conversation) {
    this._harness = harness;
    this.rootConversation = rootConversation;
  }

  static onCommits(
    harness: Harness,
    filter: (change: CommitChange) => boolean,
    onCommit: (seq: Seq, change: CommitChange) => void,
  ): void {
    harness.subscribeCommits(({ seq, changes }) => {
      for (const change of changes) {
        if (filter(change)) {
          onCommit(seq, change);
        }
      }
    });
  }

  public async message(msg: string): Promise<void> {
    this.stage = "submission.submit";
    const submission = await this.rootConversation.submit(
      { type: "input", content: msg },
      Monchu.context,
    );

    this.stage = "submission.wait";
    logSubmission(this.stage, submission);

    const settled = await submission.wait(Monchu.context);
    logSubmission("submission.settled", settled);

    if (settled.status === "unanswered") {
      process.exitCode = 1;
    } else if (settled.type === "input") {
      this.stage = "answer.read";
      const answer = await this.rootConversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        Monchu.context,
      );
      if (!answer?.model?.length) {
        throw new Error(
          `Settled submission ${settled.id} has no assistant answer at entry ${settled.answer}`,
        );
      }
      this.stage = "answer";
      logStage(this.stage, answer);
    }
  }

  public async close(): Promise<void> {
    try {
      await this.harness.close(Monchu.context);
      logStage("harness.closed");
    } catch (error) {
      logError("harness.close", error);
      process.exitCode = 1;
    }
  }
}

let m: Monchu | undefined;

try {
  m = await Monchu.create();
  await m.message("what is the capitol of florida?");
} catch (error) {
  logError(m?.stage ?? "unknown", error);
  process.exitCode = 1;
} finally {
  await m?.close();
}
