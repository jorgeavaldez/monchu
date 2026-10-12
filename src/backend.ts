import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, type SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  configure,
  createRegistry,
  Harness,
  LiveDoc,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type HarnessSettings,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { appendFile, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssessmentsDoc, type Assessment } from "./classifier.ts";
import { loadConfig, type MonchuConfig } from "./config.ts";
import { Goals, GoalsDoc, GOALS_COMPACTION_FOCUS, type Goal } from "./goals.ts";
import {
  buildForReload,
  extensionManifest,
  reloadControls,
  reloadExtensions,
  RestartRequest,
} from "./reload.ts";
import { listWorkers, messageWorker, startWorker, WorkersDoc } from "./workers.ts";
import { resolveDirectory } from "./workdir.ts";

const context = BACKGROUND_CONTEXT;

/** One runtime/store owner. No terminal, transport, or rendering dependencies. */
export class Monchu {
  readonly home: string;
  private readonly owner: DatabaseSync;
  private readonly harness: Harness;
  private readonly front: Conversation;
  readonly config: MonchuConfig;
  private readonly reports: Reports;
  private readonly reloadRuntime: ReloadRuntime;
  private reloading: Promise<{ reloaded: string[] }> | undefined;
  private closing: Promise<void> | undefined;
  private readonly envs: ExecutionEnvs;

  private constructor(
    home: string,
    owner: DatabaseSync,
    harness: Harness,
    front: Conversation,
    config: MonchuConfig,
    reports: Reports,
    reloadRuntime: ReloadRuntime,
    envs: ExecutionEnvs,
  ) {
    this.home = home;
    this.owner = owner;
    this.harness = harness;
    this.front = front;
    this.config = config;
    this.reports = reports;
    this.reloadRuntime = reloadRuntime;
    this.envs = envs;
  }

  static async open(home = join(homedir(), ".monchu")): Promise<Monchu> {
    home = resolve(home);
    await mkdir(home, { recursive: true, mode: 0o700 });
    // A separate SQLite transaction holds a crash-released process lock without blocking Durable's writes.
    const owner = new DatabaseSync(join(home, "owner.sqlite"));
    let harness: Harness | undefined;
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
      const agentDir = getAgentDir();
      const models = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const diagnostic = models.getError();
      if (diagnostic !== undefined) throw new Error(diagnostic);
      for (const role of [config.front, config.worker]) {
        if (models.getModel(role.provider, role.modelId) === undefined)
          throw new Error(`Pi has no configured model ${role.provider}/${role.modelId}`);
      }

      const reports = new Reports(join(home, "monchu.log"));

      const skillDir = join(agentDir, "skills", "monchu");
      await mkdir(skillDir, { recursive: true });
      try {
        await copyFile(
          new URL("../skills/monchu/SKILL.md", import.meta.url),
          join(skillDir, "SKILL.md"),
          constants.COPYFILE_EXCL,
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const registry = createRegistry();
      const loader = extensionManifest(models, config, agentDir);
      await reloadExtensions(registry, loader.manifest);
      const reloadRuntime = { models, registry, agentDir, ...loader.configuration };
      reportConfiguration(reloadRuntime, reports);
      harness = await Harness.open(
        await openNodeSqliteStorage(join(home, "monchu.sqlite")),
        {
          models,
          registry,
          settings: harnessSettings(() => reloadRuntime.pi.settings, registry),
          env: ({ cwd }) => envs.get(cwd ?? home, reloadRuntime.pi.settings.getShellPath()),
          onReport: (error) => reports.report(error),
        },
        context,
      );
      const front = await harness.root(context, { agent: { cwd: home } });
      // The configured front role applies from the next request; a running request keeps its model.
      await front.configure(
        {
          model: { provider: config.front.provider, modelId: config.front.modelId },
          thinkingLevel: config.front.thinkingLevel,
          // Workers follow the host default, which leaves goals out.
          extensions: { add: [Goals] },
          instructions: FRONT_INSTRUCTIONS,
        },
        context,
      );
      const backend = new Monchu(home, owner, harness, front, config, reports, reloadRuntime, envs);
      registry.install(reloadControls(front.id, () => backend.reload()));
      // Every definition is installed; pending work resumes whether or not a client is attached.
      harness.resume();
      return backend;
    } catch (error) {
      try {
        await harness?.close(context);
        await envs.cleanup();
      } finally {
        owner.close();
      }
      throw error;
    }
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

  /** Snapshot plus committed updates. Pending work already resumed at open. */
  async watch(listener: (events: readonly AgentEvent[]) => void | Promise<void>) {
    const stream = await watchEvents(this.harness, this.front.id, context);
    await listener([stream.snapshot]);
    stream.start(async (events) => {
      await listener(events);
    });
    return stream;
  }

  /** Resolves on durable admission, never on the model answer. Retry with the same request ID. */
  async submit(message: string, requestId: string) {
    if (!message.trim() || !requestId.trim())
      throw new Error("Message and request ID are required");
    const submission =
      this.reloadRuntime.assessment === undefined
        ? await this.front.submit({ type: "input", content: message, requestId }, context)
        : await this.reloadRuntime.assessment.submit(this.front, message, requestId, context);
    return { submissionId: submission.id };
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

  async startWorker(name: string, message: string, requestId: string) {
    if (!name.trim() || !message.trim() || !requestId.trim())
      throw new Error("Worker name, message, and request ID are required");
    const agent = await this.front.agent(context);
    const cwd = agent.cwd ?? this.home;
    const conversationId = await this.front.commit(
      (tx) => startWorker(tx, this.front.id, name, message, cwd, requestId, this.config.worker),
      context,
    );
    this.harness.resume();
    return { conversationId, cwd };
  }

  async messageWorker(name: string, message: string, requestId: string) {
    if (!message.trim() || !requestId.trim())
      throw new Error("Message and request ID are required");
    const conversationId = await this.front.commit(
      (tx) => messageWorker(tx, this.front.id, name, message, requestId),
      context,
    );
    this.harness.resume();
    return { conversationId };
  }

  async workers() {
    return listWorkers(this.harness, this.front.id, context);
  }

  private async worker(name: string): Promise<Conversation> {
    const state = await this.harness.snapshot(WorkersDoc, this.front.id, context);
    const record = state?.workers.find((item) => item.name === name);
    if (record === undefined) throw new Error(`No worker named ${name}`);
    const conversation = await this.harness.conversation(record.conversationId, context);
    if (conversation === undefined) throw new Error("Worker conversation is missing");
    return conversation;
  }

  async stopWorker(name: string): Promise<void> {
    await (await this.worker(name)).abort(context, { background: true });
  }

  async abort(): Promise<void> {
    await this.front.abort(context);
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
      if (workerName !== undefined) {
        const state = await tx.doc(WorkersDoc, this.front.id);
        for (const delivery of state.deliveries.filter((item) => item.name === workerName)) {
          const task = await tx.task(delivery.taskId);
          if (task !== undefined && task.state.status !== "terminal") {
            throw new Error("Directory changes require an idle worker with no pending deliveries");
          }
        }
      }
      await configure(tx, conversation.id, { cwd });
    }, context);
    return cwd;
  }

  /** Concurrent requests share one reload. No registry or settings changes survive a failed preparation. */
  reload(): Promise<{ reloaded: string[] }> {
    if (this.closing !== undefined) return Promise.reject(new Error("Monchu is closing"));
    if (this.reloading !== undefined) return this.reloading;
    this.reloading = (async () => {
      await buildForReload();
      const loader = extensionManifest(
        this.reloadRuntime.models,
        this.config,
        this.reloadRuntime.agentDir,
      );
      const result = await reloadExtensions(this.reloadRuntime.registry, loader.manifest);
      Object.assign(this.reloadRuntime, loader.configuration);
      reportConfiguration(this.reloadRuntime, this.reports);
      return result;
    })().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  /** Jorge-only backend operation. Never exposed as a model tool. */
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
      if (this.reloading !== undefined) await Promise.allSettled([this.reloading]);
      // Close pauses accepted work for recovery; it does not cancel workers.
      await this.harness.close(context);
      // Then release what keeps the process alive: tool child processes, and provider connections pi-ai keeps
      // cached for reuse (Codex websockets idle for minutes). Durable owns neither.
      await this.envs.cleanup();
      cleanupSessionResources();
    } finally {
      this.owner.close();
    }
  }
}

type ReloadRuntime = ReturnType<typeof extensionManifest>["configuration"] & {
  models: Parameters<typeof extensionManifest>[0];
  registry: Registry;
  agentDir: string;
};

function reportConfiguration(runtime: ReloadRuntime, reports: Reports): void {
  for (const diagnostic of runtime.pi.diagnostics) {
    const locations = [
      diagnostic.path,
      ...(diagnostic.collision
        ? [`winner: ${diagnostic.collision.winnerPath}`, `loser: ${diagnostic.collision.loserPath}`]
        : []),
    ]
      .filter((location) => location !== undefined)
      .join("; ");
    reports.report(new Error(`${diagnostic.message}${locations ? ` (${locations})` : ""}`));
  }
  for (const warning of runtime.warnings) reports.report(new Error(warning));
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
      env = new NodeExecutionEnv({ cwd, ...(shellPath === undefined ? {} : { shellPath }) });
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

/**
 * The front answers fast; effort assessments arrive beside it, never in front of it. It keeps the goals section current
 * so goals and commitments outlive compaction and `/new`.
 */
const FRONT_INSTRUCTIONS =
  "You are the front: reply immediately. If you can fully answer in this reply, do. Otherwise acknowledge in one short line (for example 'looking into it') and start the work, usually a background worker with a self-contained goal, context, and constraints. Never stall waiting for an assessment or a worker. When an effort assessment says the work outgrows a single fast reply and you have not delegated, delegate.\n\nKeep the goals section current with update_goal; it is your memory of Jorge's goals and your commitments across compaction, /new, and restarts. A new request creates a goal (owner jorge) or updates the goal it continues; a quick answer you finish in the same reply needs none. A promise you make creates a goal with owner monchu. Starting a worker links its name to the goal. A worker report or update sets the goal's next step, or its status when it finishes or blocks the goal. Use waiting when blocked on Jorge or someone else, done when finished, dropped when abandoned. Tell Jorge only what changed, never the whole list. When a goal is done, you may offer a vault note update; do not write one unasked.";

/** Durable's run policy resolves the latest successfully loaded Pi user settings. */
function harnessSettings(settings: () => SettingsManager, registry: Registry): HarnessSettings {
  return {
    // Every installed extension except the root-only goals.
    get extensions() {
      return registry
        .snapshot()
        .installed()
        .filter((extension) => extension.name !== Goals.name);
    },
    get stream() {
      const provider = settings().getProviderRetrySettings();
      const idle = settings().getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settings().getCompactionSettings();
    },
    get retry() {
      return settings().getRetrySettings();
    },
    get steeringMode() {
      return settings().getSteeringMode();
    },
    get followUpMode() {
      return settings().getFollowUpMode();
    },
  };
}

/** Durable's `onReport` sink: kept until a client subscribes, and always logged. Never throws. */
class Reports {
  private readonly path: string;
  private readonly listeners = new Set<(message: string) => void>();
  private pending: string[] = [];

  constructor(path: string) {
    this.path = path;
  }

  report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    appendFile(this.path, `${new Date().toISOString()} ${message}\n`).catch(() => {});
    if (this.listeners.size === 0) {
      this.pending = [...this.pending, message].slice(-20);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        appendFile(
          this.path,
          `${new Date().toISOString()} Report listener failed: ${reason}\n`,
        ).catch(() => {});
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
