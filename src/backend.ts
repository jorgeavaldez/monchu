import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  cleanupSessionResources,
  getSupportedThinkingLevels,
  type Api,
  type AuthInteraction,
  type AuthType,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type Models,
} from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  Harness,
  LiveDoc,
  ProviderDoc,
  type Conversation,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssessmentsDoc, type Assessment } from "./classifier.ts";
import {
  isThinkingLevel,
  loadConfig,
  thinkingLevels,
  type ModelRole,
  type Settings,
} from "./config.ts";
import { harnessSettings } from "./context.ts";
import { GoalsDoc, GOALS_COMPACTION_FOCUS, type Goal } from "./goals.ts";
import { FRONT_INSTRUCTIONS } from "./identity.ts";
import { openModels } from "./models/index.ts";
import { createReloadControls, Extensions, RestartRequest } from "./reload.ts";
import {
  hasPendingDelivery,
  listWorkers,
  messageWorker,
  startWorker,
  stopWorker,
  workerConversationId,
  type WhenBusy,
} from "./workers.ts";
import { resolveDirectory } from "./workdir.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Which of the root's model fields were picked for this conversation only. Startup and reload apply `config.front`
 * to the other fields; saving a field as the default clears its pick.
 */
const FrontPicks = defineDoc<{ model: boolean; thinkingLevel: boolean }>({
  kind: "monchu.front-picks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ model: false, thinkingLevel: false }),
});

/** Apply the configured front role from the next request, keeping the fields picked for the root only. */
async function applyFrontRole(front: Conversation, role: ModelRole): Promise<void> {
  await front.commit(async (tx) => {
    const picks = await tx.doc(FrontPicks, front.id);
    await configure(tx, front.id, {
      ...(picks.model ? {} : { model: { provider: role.provider, modelId: role.modelId } }),
      ...(picks.thinkingLevel ? {} : { thinkingLevel: role.thinkingLevel }),
    });
  }, context);
}

/** A model or thinking-level pick from the terminal, for the root or a worker. */
export type ModelPick = { model: ModelRef } | { thinkingLevel: ModelThinkingLevel };

/** One runtime/store owner. No terminal, transport, or rendering dependencies. */
export class Monchu {
  readonly home: string;
  private readonly owner: DatabaseSync;
  private readonly harness: Harness;
  private readonly front: Conversation;
  private readonly models: Models;
  private readonly reloadListeners = new Set<() => void>();
  private reloading: Promise<readonly string[]> | undefined;
  private readonly reports: Reports;
  private readonly extensions: Extensions;
  private closing: Promise<void> | undefined;
  private readonly envs: ExecutionEnvs;

  private constructor(
    home: string,
    owner: DatabaseSync,
    harness: Harness,
    front: Conversation,
    models: Models,
    reports: Reports,
    extensions: Extensions,
    envs: ExecutionEnvs,
  ) {
    this.home = home;
    this.owner = owner;
    this.harness = harness;
    this.front = front;
    this.models = models;
    this.reports = reports;
    this.extensions = extensions;
    this.envs = envs;
  }

  static async open(home: string, devProvider?: Provider): Promise<Monchu> {
    home = resolve(home);
    await mkdir(home, { recursive: true, mode: 0o700 });
    // A separate SQLite transaction holds a crash-released process lock without blocking Durable's writes.
    const owner = new DatabaseSync(join(home, "owner.sqlite"));
    let harness: Harness | undefined;
    let extensions: Extensions | undefined;
    const envs = new ExecutionEnvs();
    try {
      try {
        owner.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        throw new Error(
          `Cannot acquire Monchu ownership at ${home}; another runtime may be using it`,
          { cause: error },
        );
      }
      const config = await loadConfig(home);
      const models = await openModels(home, devProvider, config.claude);
      const reports = new Reports(join(home, "monchu.log"));
      const loaded = await Extensions.load(models, config, home, (warning) =>
        reports.report(warning),
      );
      extensions = loaded;
      harness = await Harness.open(
        await openNodeSqliteStorage(join(home, "monchu.sqlite")),
        {
          models,
          registry: extensions.registry,
          settings: harnessSettings(extensions),
          env: ({ cwd }) => envs.get(cwd ?? home, loaded.settings.shellPath),
          onReport: (error) =>
            reports.report(error instanceof Error ? error.message : String(error)),
        },
        context,
      );
      const front = await harness.root(context, { agent: { cwd: home } });
      await front.configure(
        {
          // Workers follow the host default, which leaves the root-only extensions out.
          extensions: { add: extensions.root },
          instructions: FRONT_INSTRUCTIONS,
        },
        context,
      );
      // The configured front role applies from the next request; a running request keeps its model.
      await applyFrontRole(front, config.front);
      const backend = new Monchu(home, owner, harness, front, models, reports, extensions, envs);
      extensions.registry.install(createReloadControls(front.id, () => backend.reload()));
      // Every definition is installed; pending work resumes whether or not a client is attached.
      harness.resume();
      return backend;
    } catch (error) {
      try {
        await harness?.close(context);
        await extensions?.close();
        await envs.cleanup();
      } finally {
        owner.close();
      }
      throw error;
    }
  }

  /** The run settings of the last successful load or reload. */
  get settings(): Settings {
    return this.extensions.settings;
  }

  /** Private terminal interaction only: never submitted to Durable or exposed as a model tool. */
  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    await this.models.login(providerId, type, interaction, { agentName: "Monchu" });
  }

  /** Successful reload notifications; callers re-read the single settings owner. */
  onReload(listener: () => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  /** Non-fatal runtime failures, also appended to `monchu.log`. Returns an unsubscribe function. */
  onReport(listener: (message: string) => void): () => void {
    return this.reports.subscribe(listener);
  }

  /** Read-only committed conversation state. The caller owns and disposes its attachment. */
  async viewState(workerName?: string) {
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    return conversation.viewState(context);
  }

  /**
   * Resolves on durable admission, never on the model answer. Retry with the same request ID. While the front is busy,
   * the message steers its current run, or with `followUp` waits for the run to finish.
   */
  async submit(message: string, requestId: string, whenBusy: WhenBusy = "steer"): Promise<void> {
    if (!message.trim() || !requestId.trim())
      throw new Error("Message and request ID are required");
    const assessment = this.extensions.assessment;
    if (assessment === undefined)
      await this.front.submit({ type: "input", content: message, requestId, whenBusy }, context);
    else await assessment.submit(this.front, message, requestId, whenBusy, context);
  }

  /** Effort assessments of front inputs as they settle, newest last. Returns a stop function. */
  async watchAssessments(listener: (items: readonly Assessment[]) => void): Promise<() => void> {
    // Observation needs a stored document; reading it in a commit creates it on a fresh home.
    await this.front.commit(async (tx) => {
      await tx.doc(AssessmentsDoc, this.front.id);
    }, context);
    const state = await this.harness.documentState(AssessmentsDoc, this.front.id, context);
    if (state === undefined) throw new Error("Assessments document is missing");
    const unsubscribe = state.subscribe((value) => listener(value?.items ?? []));
    return () => {
      unsubscribe();
      state.dispose();
    };
  }

  /** Start a fresh model context, optionally carrying a handoff note. Storage keeps every entry. */
  async reset(handoff: string | undefined): Promise<void> {
    await this.front.reset(handoff?.trim() || undefined, context);
    const provider = await this.harness.snapshot(ProviderDoc, this.front.id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
  }

  /** Summarize older context now, keeping goal ids and open commitments; the conversation keeps working meanwhile. */
  async compact(instructions: string | undefined): Promise<void> {
    const focus = instructions?.trim();
    await this.front.compact(
      focus ? `${GOALS_COMPACTION_FOCUS} ${focus}` : GOALS_COMPACTION_FOCUS,
      context,
    );
  }

  /** The root's goals in stored order, including recently closed ones. */
  async goals(): Promise<readonly Goal[]> {
    return (await this.harness.snapshot(GoalsDoc, this.front.id, context))?.goals ?? [];
  }

  async startWorker(name: string, message: string, requestId: string): Promise<void> {
    if (!name.trim() || !message.trim() || !requestId.trim())
      throw new Error("Worker name, message, and request ID are required");
    const agent = await this.front.agent(context);
    const cwd = agent.cwd ?? this.home;
    await this.front.commit(
      (tx) =>
        startWorker(
          tx,
          this.front.id,
          name,
          message,
          cwd,
          requestId,
          this.extensions.config.worker,
        ),
      context,
    );
    this.harness.resume();
  }

  /** Steers a busy worker's run, or with `followUp` waits for it to finish. */
  async messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: WhenBusy = "steer",
  ): Promise<void> {
    if (!message.trim() || !requestId.trim())
      throw new Error("Message and request ID are required");
    await this.front.commit(
      (tx) => messageWorker(tx, this.front.id, name, message, requestId, whenBusy),
      context,
    );
    this.harness.resume();
  }

  async workers() {
    return listWorkers(this.harness, this.front.id, context);
  }

  private async worker(name: string): Promise<Conversation> {
    const conversation = await this.harness.conversation(
      await workerConversationId(this.harness, this.front.id, name, context),
      context,
    );
    if (conversation === undefined) throw new Error("Worker conversation is missing");
    return conversation;
  }

  async stopWorker(name: string): Promise<void> {
    await stopWorker(this.harness, this.front.id, name, context);
  }

  async abort(): Promise<void> {
    await this.front.abort(context);
    const provider = await this.harness.snapshot(ProviderDoc, this.front.id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
  }

  /** The model and thinking level of the root or a worker, its role's default, and the chat models with credentials. */
  async modelChoice(workerName?: string): Promise<{
    model: Model<Api> | undefined;
    thinkingLevel: ModelThinkingLevel;
    thinkingLevels: readonly ModelThinkingLevel[];
    defaults: ModelRole;
    models: readonly Model<Api>[];
  }> {
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    const agent = await conversation.agent(context);
    const model =
      agent.model === undefined
        ? undefined
        : this.models.getModel(agent.model.provider, agent.model.modelId);
    return {
      model,
      thinkingLevel: agent.thinkingLevel,
      thinkingLevels: model === undefined ? thinkingLevels : getSupportedThinkingLevels(model),
      defaults:
        workerName === undefined ? this.extensions.config.front : this.extensions.config.worker,
      models: await this.models.getAvailable(),
    };
  }

  /**
   * Change the root's or a worker's model or thinking level from its next request. `saveDefault` also writes it to
   * that role's default in `config.json`: `front` for the root, `worker` for workers. Existing workers keep theirs.
   */
  async pickModel(pick: ModelPick, saveDefault: boolean, workerName?: string): Promise<void> {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    if ("model" in pick) {
      if (this.models.getModel(pick.model.provider, pick.model.modelId) === undefined)
        throw new Error(
          `Monchu has no configured model ${pick.model.provider}/${pick.model.modelId}`,
        );
    } else if (!isThinkingLevel(pick.thinkingLevel))
      throw new Error(`Unknown thinking level ${String(pick.thinkingLevel)}`);
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    if (saveDefault) {
      const role = workerName === undefined ? "front" : "worker";
      // The saved default must work on its own model, which may not be the model this conversation is on.
      await this.extensions.saveRole(role, "model" in pick ? pick.model : pick, (saved) => {
        const model = this.models.getModel(saved.provider, saved.modelId);
        if (model === undefined)
          throw new Error(`Monchu has no configured model ${saved.provider}/${saved.modelId}`);
        const levels = getSupportedThinkingLevels(model);
        if (!levels.includes(saved.thinkingLevel))
          throw new Error(
            `${saved.provider}/${saved.modelId} does not support thinking level ${saved.thinkingLevel} (supported: ${levels.join(", ")}); the ${role} default was not saved`,
          );
      });
    }
    await conversation.commit(async (tx) => {
      if (workerName === undefined)
        (await tx.doc(FrontPicks, conversation.id))["model" in pick ? "model" : "thinkingLevel"] =
          !saveDefault;
      await configure(tx, conversation.id, pick);
    }, context);
  }

  async changeDirectory(path: string, workerName?: string): Promise<string> {
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    const agent = await conversation.agent(context);
    const cwd = await resolveDirectory(path, agent.cwd ?? this.home);
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run !== undefined)
        throw new Error(
          "Directory changes require an idle conversation; stop or finish the current run first",
        );
      if (workerName !== undefined && (await hasPendingDelivery(tx, this.front.id, workerName)))
        throw new Error("Directory changes require an idle worker with no pending deliveries");
      await configure(tx, conversation.id, { cwd });
    }, context);
    return cwd;
  }

  /** Concurrent requests share one reload. No registry or settings changes survive a failed preparation. */
  reload(): Promise<readonly string[]> {
    if (this.closing !== undefined) return Promise.reject(new Error("Monchu is closing"));
    this.reloading ??= this.extensions
      .reload(async (config) => {
        // Durable captures model and stream options during request preparation; later phases resolve current policy.
        await applyFrontRole(this.front, config.front);
      })
      .then((modules) => {
        for (const listener of this.reloadListeners) {
          try {
            listener();
          } catch {
            this.reports.report("Reload listener failed");
          }
        }
        return modules;
      })
      .catch(async (error: unknown) => {
        // The caller shows the failure; the log keeps it after the terminal is gone.
        await this.reports.log(
          `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      })
      .finally(() => {
        this.reloading = undefined;
      });
    return this.reloading;
  }

  /** User-only backend operation. Never exposed as a model tool. */
  async restart(): Promise<never> {
    await this.front.commit(async (tx) => {
      (await tx.doc(RestartRequest, this.front.id)).request = null;
    }, context);
    await this.close();
    process.stdin.pause();
    return new Promise<never>((_resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal !== null) process.kill(process.pid, signal);
        process.exit(code ?? 1);
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= this.closeRuntime();
    return this.closing;
  }

  private async closeRuntime(): Promise<void> {
    try {
      // A failed reload must not prevent storage from closing.
      await this.reloading?.catch(() => {});
      await this.extensions.settled();
      // Close pauses accepted work for recovery; it does not cancel workers.
      await this.harness.close(context);
      await this.extensions.close();
      // Then release what keeps the process alive: tool child processes, and provider connections pi-ai keeps
      // cached for reuse (Codex websockets idle for minutes). Durable owns neither.
      await this.envs.cleanup();
      cleanupSessionResources();
    } finally {
      this.owner.close();
    }
  }
}

/**
 * Environments are shared by directory and shell path, and cleaned up on close.
 * Reload can select a new shell without changing the environment of an already running call.
 */
class ExecutionEnvs {
  private readonly envs = new Map<string, NodeExecutionEnv>();

  get(cwd: string, shellPath: string | undefined): NodeExecutionEnv {
    const key = `${cwd}\0${shellPath ?? ""}`;
    let env = this.envs.get(key);
    if (env === undefined) {
      env = new NodeExecutionEnv({
        cwd,
        ...(shellPath === undefined ? {} : { shellPath }),
      });
      this.envs.set(key, env);
    }
    return env;
  }

  async cleanup(): Promise<void> {
    const envs = [...this.envs.values()];
    this.envs.clear();
    for (const env of envs) await env.cleanup(context);
  }
}

/** Durable's `onReport` sink: kept until a client subscribes, and always logged. Never throws. */
class Reports {
  private readonly path: string;
  private readonly listeners = new Set<(message: string) => void>();
  private pending: string[] = [];

  constructor(path: string) {
    this.path = path;
  }

  /** Append to the log only, for failures the caller already shows. Never rejects. */
  log(message: string): Promise<void> {
    return appendFile(this.path, `${new Date().toISOString()} ${message}\n`).catch(() => {});
  }

  report(message: string): void {
    void this.log(message);
    if (this.listeners.size === 0) {
      this.pending = [...this.pending, message].slice(-20);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        void this.log(
          `Report listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  subscribe(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    for (const message of this.pending) listener(message);
    this.pending = [];
    return () => this.listeners.delete(listener);
  }
}
