import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  cleanupSessionResources,
  getSupportedThinkingLevels,
  type Api,
  type AuthInteraction,
  type AuthType,
  type Model,
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
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Client, ModelChoice, ModelPick, QueueChange } from "../api/client.ts";
import { parseRelease, type Release } from "../api/release.ts";
import {
  escalationSummary,
  noticeText,
  parseWorkerNotice,
  systemNoticeSummary,
  systemNoticeText,
  type WhenBusy,
} from "../api/notices.ts";
import type { LogAttributes, LogQuery, LogRecord } from "../api/logs.ts";
import type { McpServerReport } from "../api/reports.ts";
import { Log } from "../telemetry/log.ts";
import { AssessmentsDoc, RoutingDoc, type Assessment } from "./agents/classifier.ts";
import {
  defaultConfig,
  isThinkingLevel,
  loadConfig,
  type MonchuConfig,
  thinkingLevels,
  type ModelRole,
  type Settings,
  type WebConfig,
} from "./config.ts";
import { harnessSettings } from "./context.ts";
import { GoalsDoc, GOALS_COMPACTION_FOCUS, type Goal } from "./agents/goals.ts";
import { formatJobs, JobsDoc, type JobEvent, type JobsState } from "./jobs.ts";
import { budgetNotice, FRONT_INSTRUCTIONS, HomeBudgetDoc, type BudgetLevel } from "./identity.ts";
import { configuredRoles, defaultProviders, openModels } from "./models/index.ts";
import type { McpSignInPrompt } from "./mcp/auth.ts";
import { createReloadControls, Extensions, RestartRequest } from "./reload.ts";
import { newerEdge, planUpdate, VERSION, type UpdatePlan } from "./update.ts";
import {
  DELETED_FROM_QUEUE,
  hasPendingDelivery,
  listWorkers,
  messageWorker,
  startWorker,
  stopWorker,
  workerConversationId,
  WorkersDoc,
} from "./agents/workers.ts";
import { preloadGroups } from "./tools/tool-search.ts";
import { resolveDirectory } from "./workdir.ts";
import { skillMessage } from "./skills/index.ts";

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
async function applyFrontRole(
  front: Conversation,
  role: ModelRole,
  preload: readonly string[],
): Promise<void> {
  await front.commit(async (tx) => {
    const picks = await tx.doc(FrontPicks, front.id);
    await configure(tx, front.id, {
      ...(picks.model ? {} : { model: { provider: role.provider, modelId: role.modelId } }),
      ...(picks.thinkingLevel ? {} : { thinkingLevel: role.thinkingLevel }),
    });
    await preloadGroups(tx, front.id, preload);
  }, context);
}

/**
 * Load the preloaded tool groups into the root and every worker under it that runs on the Claude Code bridge, so a
 * group added to the configuration reaches existing conversations once, at a reload or start, instead of mid-run.
 */
async function preloadAll(
  harness: Harness,
  front: Conversation,
  preload: readonly string[],
): Promise<void> {
  if (preload.length === 0) return;
  const ids: ConversationId[] = [];
  for (const pending = [front.id]; pending.length;) {
    const id = pending.pop();
    if (id === undefined) break;
    ids.push(id);
    for (const worker of (await harness.snapshot(WorkersDoc, id, context))?.workers ?? [])
      pending.push(worker.conversationId);
  }
  await front.commit(async (tx) => {
    for (const id of ids) await preloadGroups(tx, id, preload);
  }, context);
}

/** One runtime/store owner, and the in-process implementation of the client contract. No terminal, transport, or rendering dependencies. */
export class Monchu implements Client {
  readonly home: string;
  private readonly owner: DatabaseSync;
  private readonly harness: Harness;
  private readonly front: Conversation;
  private readonly models: Models;
  private readonly reloadListeners = new Set<() => void>();
  private readonly restartListeners = new Set<() => void>();
  private readonly releaseListeners = new Set<(release: Release) => void>();
  private releaseState: Release = {
    version: VERSION,
    available: null,
    updating: null,
    outcome: null,
  };
  private planned: UpdatePlan | undefined;
  private edgeCheck: ReturnType<typeof setInterval> | undefined;
  private readonly startup: string[] = [];
  /** This process is the core: restarting re-executes it, so its own terminal must let go first. */
  readonly restartsProcess = true;
  private reloading: Promise<readonly string[]> | undefined;
  private readonly reports: Reports;
  private readonly extensions: Extensions;
  private closing: Promise<void> | undefined;
  /** The budget levels last observed, so an unchanged render costs no commit; budget notices go out one at a time. */
  private budgetSeen = "";
  private budgetWork: Promise<void> = Promise.resolve();
  private readonly envs: ExecutionEnvs;
  /** The structured log: warnings, timings, model replies and client events. */
  readonly log: Log;
  private readonly stopTelemetry: () => void;

  private constructor(
    home: string,
    owner: DatabaseSync,
    harness: Harness,
    front: Conversation,
    models: Models,
    reports: Reports,
    extensions: Extensions,
    envs: ExecutionEnvs,
    log: Log,
  ) {
    this.home = home;
    this.owner = owner;
    this.harness = harness;
    this.front = front;
    this.models = models;
    this.reports = reports;
    this.extensions = extensions;
    this.envs = envs;
    this.log = log;
    this.stopTelemetry = harness.subscribeCommits((publication) =>
      modelTelemetry(log, publication),
    );
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
      const log = new Log(home);
      const reports = new Reports(log);
      // Each phase's time goes to the log with the open: the startup budget, measured on every device.
      const phases: LogAttributes = {};
      let phaseStart = performance.now();
      const phase = (name: string) => {
        const now = performance.now();
        phases[name] = Math.round(now - phaseStart);
        phaseStart = now;
      };
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
      phase("config");
      const models = await openModels(home, devProvider, written.claude);
      const { config, warnings } = await configuredRoles(models, written);
      for (const warning of warnings) reports.report(warning);
      // Renders start once the harness resumes, after the backend below takes over.
      let observeBudget = (_levels: BudgetLevel[]) => {};
      const loaded = await Extensions.load(
        models,
        config,
        home,
        (warning) => reports.report(warning),
        (levels) => observeBudget(levels),
      );
      extensions = loaded;
      phase("extensions");
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
      phase("store");
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
      await applyFrontRole(front, config.front, extensions.preload);
      await preloadAll(harness, front, extensions.preload);
      phase("root");
      const backend = new Monchu(
        home,
        owner,
        harness,
        front,
        models,
        reports,
        extensions,
        envs,
        log,
      );
      log.write("info", "core.open", "opened", phases);
      observeBudget = (levels) => backend.observeBudget(levels);
      extensions.registry.install(createReloadControls(front.id, () => backend.reload()));
      // Every definition is installed; pending work resumes whether or not a client is attached.
      harness.resume();
      backend.watchEdge();
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

  /** Home and bundled skills as of the last successful load or reload. */
  skills(): readonly { name: string; description: string }[] {
    return this.extensions.skills.map(({ name, description }) => ({ name, description }));
  }

  /** The named skill's instructions with the user's text, as one message; throws for an unknown skill. */
  async skillInput(name: string, text: string): Promise<string> {
    const skill = this.extensions.skills.find((item) => item.name === name);
    if (skill === undefined) throw new Error(`No skill named ${name}`);
    return skillMessage(skill, text);
  }

  /** The web server's settings from `config.json`, as of the last successful load or reload. */
  get web(): WebConfig | undefined {
    return this.extensions.config.web;
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
    // Roles config.json leaves out follow the logged-in provider; a reload applies them from the next request.
    const { chosen } = this.extensions.config;
    if (chosen.front && chosen.worker) return;
    await this.reload().catch((error: unknown) =>
      this.reports.report(
        `Logged in, but the reload that applies its models failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /**
   * What still needs a login: the front and worker providers without credentials (`anyOf` when logging in to any one
   * of them is enough, since unchosen roles follow it), and Clef when it is configured but off for lack of them. Empty when nothing does. Never reads or returns credential values.
   */
  async loginNeeds(): Promise<{ chat: string[]; anyOf: boolean; classifier: string | undefined }> {
    const { front, worker, classifier, chosen } = this.extensions.config;
    const missing = async (provider: string) =>
      (await this.models.checkAuth(provider).catch(() => undefined)) === undefined;
    const chat: string[] = [];
    for (const provider of new Set([front.provider, worker.provider]))
      if (await missing(provider)) chat.push(provider);
    // Without chosen roles any default provider will do, and its login picks the models.
    const anyOf = chat.length > 0 && !chosen.front && !chosen.worker;
    return {
      chat: anyOf ? defaultProviders() : chat,
      anyOf,
      classifier:
        classifier !== null && (await missing(classifier.provider))
          ? classifier.provider
          : undefined,
    };
  }

  /** Every configured MCP server's state and tools, connecting now. Private terminal interaction for `/mcp`. */
  mcpServers() {
    return this.extensions.mcpServers();
  }

  /**
   * Sign in to an MCP server through the browser, then reload so its tools are offered. Private terminal interaction:
   * `prompt` shows the authorization URL and may take a pasted redirect URL.
   */
  async mcpLogin(name: string, prompt: McpSignInPrompt, signal: AbortSignal): Promise<string> {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    const message = await this.extensions.mcpLogin(name, prompt, signal);
    await this.reload();
    return message;
  }

  /** Forget an MCP server's sign-in; its tools stay until the next reload or restart. */
  mcpLogout(name: string): Promise<string> {
    return this.extensions.mcpLogout(name);
  }

  /** List every MCP server again, bypassing the cached listings, then reload so changed tools are offered. */
  async mcpReconnect(): Promise<{ servers: McpServerReport[]; errors: string[] }> {
    const report = await this.extensions.mcpServers();
    await this.reload();
    return report;
  }

  /** Successful reload notifications; callers re-read the single settings owner. */
  onReload(listener: () => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  /** Non-fatal runtime failures, also logged. Returns an unsubscribe function. */
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

  /**
   * The routing helper's state, pausing or resuming it first when `paused` is given. A pause is stored on the front, so
   * it outlasts restarts; `configured` is false when config.json turns Clef off or its provider has no login.
   */
  async routing(paused?: boolean): Promise<{ configured: boolean; paused: boolean }> {
    const stored = await this.front.commit(async (tx) => {
      const state = await tx.doc(RoutingDoc, this.front.id);
      if (paused !== undefined) state.paused = paused;
      return state.paused;
    }, context);
    const needs = await this.loginNeeds();
    return {
      configured: this.extensions.assessment !== undefined && needs.classifier === undefined,
      paused: stored,
    };
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

  /** Every background job and the recent job events, store-wide, with the jobs as the job tool lists them. */
  async jobs(): Promise<Readonly<JobsState> & { listing: string }> {
    const state = (await this.harness.snapshot(JobsDoc, context)) ?? {
      jobs: [],
      events: [],
      nextEvent: 1,
    };
    return { ...state, listing: formatJobs(state.jobs) };
  }

  /**
   * The job event stream, for any client: `listener` gets each batch of events with an id above `after`, in id order,
   * starting with those already stored. Pass the last id a client saw to resume without repeats; ids only grow.
   * Returns a stop function.
   */
  async watchJobEvents(
    after: number,
    listener: (events: readonly JobEvent[]) => void,
  ): Promise<() => void> {
    // Observation needs a stored document; reading it in a commit creates it on a fresh home.
    await this.front.commit(async (tx) => {
      await tx.doc(JobsDoc);
    }, context);
    const state = await this.harness.documentState(JobsDoc, context);
    if (state === undefined) throw new Error("Jobs document is missing");
    let seen = after;
    const unsubscribe = state.subscribe((value) => {
      const fresh = (value?.events ?? []).filter((event) => event.id > seen);
      const last = fresh.at(-1);
      if (last === undefined) return;
      seen = last.id;
      listener(fresh);
    });
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
          this.extensions.preload,
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
        escalationSummary(item.content) === undefined &&
        systemNoticeSummary(item.content) === undefined
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
  async modelChoice(workerName?: string): Promise<ModelChoice> {
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
      await preloadGroups(tx, conversation.id, this.extensions.preload);
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
  async roleChoice(role: "front" | "worker"): Promise<ModelChoice> {
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
    if (role === "front") await applyFrontRole(this.front, saved, this.extensions.preload);
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
    const started = performance.now();
    this.reloading ??= this.extensions
      .reload(async (config) => {
        // Durable captures model and stream options during request preparation; later phases resolve current policy.
        await applyFrontRole(this.front, config.front, this.extensions.preload);
      })
      .then(async (modules) => {
        // The new build's groups: a server whose preload was just turned on reaches existing conversations now.
        await preloadAll(this.harness, this.front, this.extensions.preload);
        for (const listener of this.reloadListeners) {
          try {
            listener();
          } catch {
            this.reports.report("Reload listener failed");
          }
        }
        this.log.write("info", "core.reload", "reloaded", {
          ms: Math.round(performance.now() - started),
          modules: modules.length,
        });
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

  /** The newest log records, oldest first. */
  logs(query: LogQuery): Promise<LogRecord[]> {
    return this.log.tail(query);
  }

  /** A client's own telemetry, such as its render timings, into the core's log. */
  record(scope: "tui" | "web", body: string, attributes?: LogAttributes): void {
    this.log.write("info", scope, body, attributes);
  }

  /**
   * Home budget levels from a request's render (any conversation's). A budget that rose to near or full since the front
   * was last told reaches it as a follow-up system notice and a warning, once; falling back under 90% re-arms it.
   */
  private observeBudget(levels: BudgetLevel[]): void {
    const seen = JSON.stringify(levels.map(({ budget, level }) => [budget, level]));
    if (seen === this.budgetSeen || this.closing !== undefined) return;
    this.budgetSeen = seen;
    this.budgetWork = this.budgetWork
      .then(() => this.noticeBudget(levels))
      .catch((error: unknown) => {
        this.budgetSeen = "";
        this.reports.report(
          `Home budget notice failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async noticeBudget(levels: BudgetLevel[]): Promise<void> {
    // The notice is recorded with the levels and cleared once admitted, so a crash in between posts it again.
    const { pending, summary } = await this.front.commit(async (tx) => {
      const state = await tx.doc(HomeBudgetDoc, this.front.id);
      const notice = budgetNotice(state, levels);
      if (notice !== undefined) {
        state.sent++;
        state.pending = {
          requestId: `home-budget:${state.sent}`,
          text: systemNoticeText(notice.summary, notice.text),
        };
      }
      // A copy: the document's own values are unusable once the commit settles.
      return { pending: state.pending && { ...state.pending }, summary: notice?.summary };
    }, context);
    if (summary !== undefined) this.reports.report(`Home budget: ${summary}`);
    if (pending === undefined) return;
    await this.front.submit(
      { type: "input", content: pending.text, requestId: pending.requestId, whenBusy: "followUp" },
      context,
    );
    await this.front.commit(async (tx) => {
      const state = await tx.doc(HomeBudgetDoc, this.front.id);
      if (state.pending?.requestId === pending.requestId) delete state.pending;
    }, context);
  }

  /** A non-fatal failure from outside the core, such as its socket server: logged and shown like the core's own. */
  report(message: string): void {
    this.reports.report(message);
  }

  /** This core's startup notes, such as a freshly seeded home: every client shows them under its header. */
  get notes(): readonly string[] {
    return this.startup;
  }

  addNotes(...notes: string[]): void {
    this.startup.push(...notes);
  }

  /** The chat model catalog, for remote clients that show context windows and reasoning support. */
  catalog(): readonly Model<Api>[] {
    return this.models.getModels();
  }

  /**
   * A remote client's user approved a restart. Whoever can restart this process (its own terminal, or the headless
   * server's entry point) is told; throws when nothing listens.
   */
  requestRestart(): void {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    if (this.restartListeners.size === 0) throw new Error("Nothing here can restart this Monchu");
    // Next turn: the client that asked hears its answer before the restart closes its connection.
    setImmediate(() => {
      for (const listener of this.restartListeners) listener();
    });
  }

  /** Restart requests from remote clients; returns an unsubscribe function. */
  onRestartRequest(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  /**
   * User-only: clears the restart request and closes the runtime; the entry point then re-executes the process. Never
   * exposed as a model tool.
   */
  async restart(): Promise<void> {
    await this.front.commit(async (tx) => {
      (await tx.doc(RestartRequest, this.front.id)).request = null;
    }, context);
    await this.close();
  }

  get release(): Release {
    return this.releaseState;
  }

  onRelease(listener: (release: Release) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  private setRelease(change: Partial<Release>): void {
    this.releaseState = { ...this.releaseState, ...change };
    for (const listener of this.releaseListeners) listener(this.releaseState);
  }

  /** The entry point's word on the update this process came back from. */
  updated(outcome: string): void {
    this.setRelease({ outcome });
  }

  /** A newer edge build, at open and then daily; a failed check is logged, never reported, since it only feeds a hint. */
  private watchEdge(): void {
    const check = () =>
      void newerEdge().then(
        (available) => this.setRelease({ available: available ?? null }),
        (error: unknown) =>
          this.log.write("warn", "core.update", "edge check failed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
      );
    check();
    this.edgeCheck = setInterval(check, 86_400_000);
    this.edgeCheck.unref();
  }

  /**
   * A user approved an update: check it can run, then ask whoever restarts this process to close it; the entry point
   * installs `plannedUpdate` before re-executing. Never exposed as a model tool.
   */
  async update(text: string): Promise<void> {
    const release = parseRelease(text);
    if (release === undefined) throw new Error(`Not a release: ${text}. Use edge or a version`);
    if (this.closing !== undefined || this.planned !== undefined)
      throw new Error("Monchu is already closing");
    if (this.restartListeners.size === 0) throw new Error("Nothing here can restart this Monchu");
    if (process.platform === "win32")
      throw new Error(
        "Windows keeps a running Monchu's files locked: /quit, then run monchu update",
      );
    const plan = await planUpdate(release);
    this.planned = plan;
    this.setRelease({ updating: release });
    this.log.write("info", "core.update", "updating", { release, prefix: plan.prefix });
    this.requestRestart();
  }

  /** The install the entry point runs after closing for `/update`. */
  get plannedUpdate(): UpdatePlan | undefined {
    return this.planned;
  }

  close(): Promise<void> {
    this.closing ??= this.closeRuntime();
    return this.closing;
  }

  private async closeRuntime(): Promise<void> {
    const started = performance.now();
    this.stopTelemetry();
    clearInterval(this.edgeCheck);
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
      this.log.write("info", "core.close", "closed", {
        ms: Math.round(performance.now() - started),
      });
      await this.log.flushed();
    }
  }
}

/** One log record per model reply, from the committed assistant entry: model, tokens, time and stop reason, never content. */
function modelTelemetry(log: Log, publication: CommitPublication): void {
  for (const change of publication.changes) {
    if (change.type !== "entry" || change.value.kind !== "pi.assistant") continue;
    const message = change.value.model?.[0];
    if (message?.role !== "assistant") continue;
    log.write(message.stopReason === "error" ? "warn" : "info", "core.model", "reply", {
      conversation: change.value.conversationId,
      entry: change.value.id,
      model: `${message.provider}/${message.model}`,
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ms: message.durationMs ?? null,
      stop: message.stopReason,
    });
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
  private readonly file: Log;
  private readonly listeners = new Set<(message: string) => void>();
  private pending: string[] = [];

  constructor(file: Log) {
    this.file = file;
  }

  /** Append to the log only, for failures the caller already shows. Never rejects. */
  log(message: string): Promise<void> {
    this.file.write("warn", "core", message);
    return this.file.flushed();
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
