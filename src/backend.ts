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
  InboxDoc,
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
import { AssessmentsDoc, escalationSummary, type Assessment } from "./classifier.ts";
import {
  defaultConfig,
  isThinkingLevel,
  loadConfig,
  type MonchuConfig,
  thinkingLevels,
  type ModelRole,
  type Settings,
} from "./config.ts";
import { harnessSettings } from "./context.ts";
import { GoalsDoc, GOALS_COMPACTION_FOCUS, type Goal } from "./goals.ts";
import { FRONT_INSTRUCTIONS } from "./identity.ts";
import { openModels, startupRoles } from "./models/index.ts";
import { createReloadControls, Extensions, RestartRequest } from "./reload.ts";
import {
  DELETED_FROM_QUEUE,
  hasPendingDelivery,
  listWorkers,
  messageWorker,
  noticeText,
  parseWorkerNotice,
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

/**
 * When the user last opened each goal in the TUI, as that goal's `updatedAt`, by goal ID. Goals that existed when it was
 * first read count as seen, so only later changes are news.
 */
const GoalsSeen = defineDoc<{ seeded: boolean; seen: Record<string, number> }>({
  kind: "monchu.goals-seen",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ seeded: false, seen: {} }),
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

/** An edit to a still-queued input: new text, a new busy mode, or deleting it. */
export type QueueChange =
  | { kind: "text"; text: string }
  | { kind: "mode"; mode: WhenBusy }
  | { kind: "delete" };

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
      const reports = new Reports(join(home, "monchu.log"));
      // A broken config.json must not keep Monchu from opening: the defaults apply and the warning says why.
      let written: MonchuConfig;
      try {
        written = await loadConfig(home);
      } catch (error) {
        written = defaultConfig();
        reports.report(
          `${error instanceof Error ? error.message : String(error)}. Using the built-in defaults until it is fixed`,
        );
      }
      const models = await openModels(home, devProvider, written.claude);
      const { config, warnings } = startupRoles(models, written);
      for (const warning of warnings) reports.report(warning);
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
          // Goals and memory are not in the host default. Workers get them too: a new worker copies this agent.
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

  /** The catalog model of a conversation's model reference, while its provider still offers it. */
  model(ref: ModelRef): Model<Api> | undefined {
    return this.models.getModel(ref.provider, ref.modelId);
  }

  /** Private terminal interaction only: never submitted to Durable or exposed as a model tool. */
  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    await this.models.login(providerId, type, interaction, { agentName: "Monchu" });
  }

  /**
   * What still needs a login: the front and worker providers without credentials, and Clef when it is configured but
   * off for lack of them. Empty when nothing does. Never reads or returns credential values.
   */
  async loginNeeds(): Promise<{ chat: string[]; classifier: string | undefined }> {
    const { front, worker, classifier } = this.extensions.config;
    const missing = async (provider: string) =>
      (await this.models.checkAuth(provider).catch(() => undefined)) === undefined;
    const chat: string[] = [];
    for (const provider of new Set([front.provider, worker.provider]))
      if (await missing(provider)) chat.push(provider);
    return {
      chat,
      classifier:
        classifier !== null && (await missing(classifier.provider))
          ? classifier.provider
          : undefined,
    };
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
   * Resolves on durable admission, never on the model answer. Retry with the same request ID. `whenBusy` decides
   * whether a message reaching a busy front steers its run or waits for it to finish.
   */
  async submit(message: string, requestId: string, whenBusy: WhenBusy): Promise<void> {
    if (!message.trim() || !requestId.trim())
      throw new Error("Message and request ID are required");
    const assessment = this.extensions.assessment;
    if (assessment === undefined)
      await this.front.submit({ type: "input", content: message, requestId, whenBusy }, context);
    else await assessment.submit(this.front, message, requestId, whenBusy, context);
  }

  /** Routing assessments of front inputs as they settle, newest last. Returns a stop function. */
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

  /**
   * The root's goals in stored order, including recently closed ones, each with whether it changed since the user last
   * opened it with `seeGoal`.
   */
  async goals(): Promise<readonly (Goal & { changed: boolean })[]> {
    const goals = (await this.harness.snapshot(GoalsDoc, this.front.id, context))?.goals ?? [];
    const seen = await this.front.commit(async (tx) => {
      const doc = await tx.doc(GoalsSeen, this.front.id);
      if (!doc.seeded) {
        doc.seeded = true;
        for (const goal of goals) doc.seen[goal.id] = goal.updatedAt;
      }
      return { ...doc.seen };
    }, context);
    return goals.map((goal) => ({ ...goal, changed: goal.updatedAt > (seen[goal.id] ?? 0) }));
  }

  /** Records that the user opened a goal as of its `updatedAt`. */
  async seeGoal(id: string, updatedAt: number): Promise<void> {
    await this.front.commit(async (tx) => {
      const doc = await tx.doc(GoalsSeen, this.front.id);
      doc.seen[id] = Math.max(doc.seen[id] ?? 0, updatedAt);
    }, context);
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
    whenBusy: WhenBusy,
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

  /**
   * Change a still-queued input of the root, or of the named worker, in place, keeping its place in the queue. A worker
   * notice keeps its label: new text replaces only its body. A deleted input settles unanswered, so a worker report is
   * dropped and a message to a worker reports a failure to its parent. Returns false once the input left the queue.
   */
  async editQueued(
    workerName: string | undefined,
    id: number,
    change: QueueChange,
  ): Promise<boolean> {
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    // Only the front's inputs are assessed. A re-assessment reads the front's context first; the commit can't.
    const assessment = workerName === undefined ? this.extensions.assessment : undefined;
    const recent =
      assessment !== undefined && change.kind === "text"
        ? await assessment.recent(this.front, context)
        : [];
    return conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const index = inbox.items.findIndex((item) => item.id === id);
      const item = inbox.items[index];
      if (item === undefined || item.mode === "write") return false;
      if (change.kind === "mode") item.mode = change.mode;
      else if (change.kind === "delete") {
        tx.settleSubmission(item.id, { status: "unanswered", reason: DELETED_FROM_QUEUE });
        inbox.items.splice(index, 1);
        await assessment?.revise(tx, conversation.id, item.id, undefined);
      } else {
        if (!change.text.trim()) throw new Error("A queued message needs text");
        if (typeof item.content !== "string") throw new Error("Only text messages can be edited");
        const notice = parseWorkerNotice(item.content);
        item.content =
          notice === undefined ? change.text : noticeText({ ...notice, text: change.text });
        await assessment?.revise(tx, conversation.id, item.id, { message: change.text, recent });
      }
      return true;
    }, context);
  }

  async stopWorker(name: string): Promise<void> {
    await stopWorker(this.harness, this.front.id, name, context);
  }

  /**
   * Stop the front only. Returns the user's own queued messages, oldest first, withdrawn so the caller can put them
   * back in the editor. The abort withdraws the rest as before: a worker report is posted again, an update is dropped.
   */
  async abort(): Promise<string[]> {
    const restored = await this.front.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, this.front.id);
      const mine = inbox.items.flatMap((item) =>
        item.mode !== "write" &&
        typeof item.content === "string" &&
        parseWorkerNotice(item.content) === undefined &&
        escalationSummary(item.content) === undefined
          ? [{ id: item.id, text: item.content }]
          : [],
      );
      for (const { id } of mine) {
        tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
        inbox.items.splice(
          inbox.items.findIndex((item) => item.id === id),
          1,
        );
        // The front never gets it, so its assessment neither advises nor escalates.
        await this.extensions.assessment?.revise(tx, this.front.id, id, undefined);
      }
      return mine.map((item) => item.text);
    }, context);
    await this.front.abort(context);
    const provider = await this.harness.snapshot(ProviderDoc, this.front.id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
    return restored;
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
    this.checkPick(pick);
    const conversation = workerName === undefined ? this.front : await this.worker(workerName);
    if (saveDefault) await this.saveDefault(workerName === undefined ? "front" : "worker", pick);
    await conversation.commit(async (tx) => {
      if (workerName === undefined)
        (await tx.doc(FrontPicks, conversation.id))["model" in pick ? "model" : "thinkingLevel"] =
          !saveDefault;
      await configure(tx, conversation.id, pick);
    }, context);
  }

  /** Picks come from the terminal: refuse unknown models and levels before anything is written. */
  private checkPick(pick: ModelPick): void {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    if ("model" in pick) {
      if (this.models.getModel(pick.model.provider, pick.model.modelId) === undefined)
        throw new Error(
          `Monchu has no configured model ${pick.model.provider}/${pick.model.modelId}`,
        );
    } else if (!isThinkingLevel(pick.thinkingLevel))
      throw new Error(`Unknown thinking level ${String(pick.thinkingLevel)}`);
  }

  /** A role default's model and thinking level from `config.json`, and the chat models with credentials. */
  async roleChoice(role: "front" | "worker") {
    const saved = this.extensions.config[role];
    const model = this.models.getModel(saved.provider, saved.modelId);
    return {
      model,
      thinkingLevel: saved.thinkingLevel,
      thinkingLevels: model === undefined ? thinkingLevels : getSupportedThinkingLevels(model),
      defaults: saved,
      models: await this.models.getAvailable(),
    };
  }

  /**
   * Save a model or thinking level as a role's default in `config.json`. New workers use the worker default; the root
   * follows the front default in the fields not picked for it. Existing workers keep theirs.
   */
  async saveDefault(role: "front" | "worker", pick: ModelPick): Promise<void> {
    this.checkPick(pick);
    // The saved default must work on its own model, which may not be the model a conversation is on.
    const saved = await this.extensions.saveRole(
      role,
      "model" in pick ? pick.model : pick,
      (saved) => {
        const model = this.models.getModel(saved.provider, saved.modelId);
        if (model === undefined)
          throw new Error(`Monchu has no configured model ${saved.provider}/${saved.modelId}`);
        const levels = getSupportedThinkingLevels(model);
        if (!levels.includes(saved.thinkingLevel))
          throw new Error(
            `${saved.provider}/${saved.modelId} does not support thinking level ${saved.thinkingLevel} (supported: ${levels.join(", ")}); the ${role} default was not saved`,
          );
      },
    );
    if (role === "front") await applyFrontRole(this.front, saved);
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
    const argv = [...process.execArgv, ...process.argv.slice(1)];
    // Replacing the process keeps one Monchu per terminal however often it restarts; spawning leaves each old process
    // waiting on its child, and Android kills Termux once too many pile up. Windows has no execve.
    if (typeof process.execve === "function")
      process.execve(process.execPath, [process.execPath, ...argv]);
    return new Promise<never>((_resolve, reject) => {
      const child = spawn(process.execPath, argv, {
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
