import type { Host } from "@earendil-works/chord";
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
  Harness,
  type CommitPublication,
  type ConversationId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Client, ModelChoice, ModelPick, RootSummary } from "../api/client.ts";
import type { Principal } from "../api/contract.ts";
import { shortId } from "../api/ids.ts";
import { parseRelease, type Release } from "../api/release.ts";
import { systemNoticeText } from "../api/notices.ts";
import type { LogAttributes, LogQuery, LogRecord } from "../api/logs.ts";
import type { McpServerReport } from "../api/reports.ts";
import { Log } from "../telemetry/log.ts";
import {
  currentRoot,
  findRoot,
  rootRecord,
  RootsDoc,
  summarize,
  SUMMARY_KINDS,
  type RootRecord,
} from "./agents/roots.ts";
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
import { applyFrontRole, Front, prepareFront, selectAll, type FrontHost } from "./front.ts";
import { formatJobs, JobsDoc, type JobEvent, type JobsState } from "./jobs.ts";
import { budgetNotice, HomeBudgetDoc, type BudgetLevel } from "./identity.ts";
import { configuredRoles, defaultProviders, openModels } from "./models/index.ts";
import type { McpSignInPrompt } from "./mcp/auth.ts";
import {
  createReloadControls,
  Extensions,
  RestartRequest,
  type ReloadCoordinator,
} from "./reload.ts";
import { newerEdge, planUpdate, VERSION, type UpdatePlan } from "./update.ts";
import { skillMessage } from "./skills/index.ts";
import { answerRequests, SecretsDoc, type SecretsState } from "./secrets/requests.ts";
import { Vault, type SecretInput, type SecretStore } from "./secrets/vault.ts";

const context = BACKGROUND_CONTEXT;

/** One runtime/store owner, and the in-process implementation of the client contract. No terminal, transport, or rendering dependencies. */
export class Monchu implements Client {
  readonly home: string;
  private readonly owner: DatabaseSync;
  private readonly harness: Harness;
  private readonly models: Models;
  /** Each root's in-process client, by full id. */
  private readonly fronts = new Map<string, Front>();
  /** How many client views each root has attached: a shown root is seen, never `done`. */
  private readonly shown = new Map<ConversationId, number>();
  private readonly rootListeners = new Set<(roots: readonly RootSummary[]) => void>();
  private rootSummaries: readonly RootSummary[] | undefined;
  private rootsTimer: ReturnType<typeof setTimeout> | undefined;
  private rootsRun: Promise<void> | undefined;
  private rootsDirty = false;
  /** What every root's front needs from this core, wherever its code was loaded: the wire's facet builds its own. */
  readonly frontHost: FrontHost;
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
  /** The home's secrets: values in fnox, names here. */
  private readonly vault: Vault;
  /** The structured log: warnings, timings, model replies and client events. */
  readonly log: Log;
  private readonly stopTelemetry: () => void;

  private constructor(
    home: string,
    owner: DatabaseSync,
    harness: Harness,
    models: Models,
    reports: Reports,
    extensions: Extensions,
    envs: ExecutionEnvs,
    log: Log,
    vault: Vault,
  ) {
    this.home = home;
    this.owner = owner;
    this.harness = harness;
    this.models = models;
    this.reports = reports;
    this.extensions = extensions;
    this.envs = envs;
    this.log = log;
    this.vault = vault;
    this.frontHost = {
      home,
      harness,
      models,
      extensions,
      checkPick: (pick) => this.checkPick(pick),
      saveDefault: (role, pick) => this.saveDefault(role, pick),
      classifierNeedsLogin: async () => (await this.loginNeeds()).classifier !== undefined,
      show: (id) => this.show(id),
      findRoot: async (prefix) => findRoot(await this.records(), prefix),
    };
    const telemetry = modelTelemetry(log);
    this.stopTelemetry = harness.subscribeCommits((publication) => {
      telemetry(publication);
      if (this.rootListeners.size > 0 && touchesRoots(publication)) this.refreshRoots();
    });
  }

  /** `secretStore` replaces fnox, for tests and the offline smoke home only. */
  static async open(
    home: string,
    devProvider?: Provider,
    options: { secretStore?: SecretStore } = {},
  ): Promise<Monchu> {
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
      // Each use is audited by name, never value.
      const vault = new Vault(join(home, "secrets"), {
        ...(options.secretStore === undefined ? {} : { store: options.secretStore }),
        audit: (body, attributes) => log.write("info", "core.secrets", body, attributes),
      });
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
        {
          observeBudget: (levels) => observeBudget(levels),
          onError: (error) =>
            log.write("warn", "core.chord", "background failure", {
              reason: error instanceof Error ? error.message : String(error),
            }),
          vault,
        },
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
      // Durable's reserved root is the first root; every root's agent and front role apply from its next request.
      const first = await harness.root(context, { agent: { cwd: home } });
      const roots = await harness.commit(async (tx) => {
        const state = await tx.doc(RootsDoc);
        if (rootRecord(state, first.id) === undefined)
          state.roots.unshift({ id: first.id, label: "", named: false, createdAt: Date.now() });
        for (const root of state.roots) await prepareFront(tx, root.id, loaded);
        return state.roots.map((root) => root.id);
      }, context);
      for (const id of roots) await selectAll(harness, id, loaded);
      phase("root");
      const backend = new Monchu(
        home,
        owner,
        harness,
        models,
        reports,
        extensions,
        envs,
        log,
        vault,
      );
      log.write("info", "core.open", "opened", phases);
      observeBudget = (levels) => backend.observeBudget(levels);
      // A failed storage call closes the Session for good, and every later call rejects: say why, once.
      void harness.closed.then((end) => {
        if (end.reason !== "failed") return;
        const cause = end.error instanceof Error ? end.error.message : String(end.error);
        reports.report(
          `Monchu's store failed and closed (${cause}). Nothing more is saved until Monchu restarts: use /restart`,
        );
      });
      extensions.registry.install(
        createReloadControls(
          () => backend.reload(),
          () => loaded.pluginStatus,
        ),
      );
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

  /** Plugins' slash commands as of the last successful load or reload. */
  commands(): readonly { name: string; usage: string; help: string }[] {
    return this.extensions.commands.map(({ name, usage, help }) => ({
      name,
      usage: usage ?? "",
      help,
    }));
  }

  /** Runs a plugin's slash command and returns what it shows; throws for an unknown one or the plugin's error. */
  async command(name: string, args: string): Promise<string> {
    const command = this.extensions.commands.find((entry) => entry.name === name);
    if (command === undefined) throw new Error("Unknown command. /help lists commands.");
    try {
      return String(await command.run(args));
    } catch (error) {
      throw new Error(
        `/${name} (plugin ${command.plugin}) failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  /** The named skill's instructions with the user's text, as one message; throws for an unknown skill. */
  async skillInput(name: string, text: string): Promise<string> {
    const skill = this.extensions.skills.find((item) => item.name === name);
    if (skill === undefined) throw new Error(`No skill named ${name}`);
    return skillMessage(skill, text);
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

  /** The core's Chord host, which loads the facets `/reload` swaps. */
  get host(): Host<Principal> {
    return this.extensions.host;
  }

  /** Load facets on the core's host, such as the wire's; every later reload swaps them too. */
  loadFacets(modules: readonly string[]): Promise<void> {
    return this.extensions.loadFacets(modules);
  }

  /** Reload through the server this core runs under; see `Extensions.coordinate`. */
  coordinateReloads(coordinator: ReloadCoordinator): () => void {
    return this.extensions.coordinate(coordinator);
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

  /** A root by its full id, in process; calls on an unknown root reject. */
  root(id: string): Front {
    let front = this.fronts.get(id);
    if (front === undefined) {
      front = new Front(this.frontHost, id);
      this.fronts.set(id, front);
    }
    return front;
  }

  private async records(): Promise<readonly RootRecord[]> {
    return (await this.harness.snapshot(RootsDoc, context))?.roots ?? [];
  }

  private async rootIds(): Promise<ConversationId[]> {
    return (await this.records()).map((root) => root.id);
  }

  /** Applies a front role to every root from its next request, keeping each root's own picks. */
  private async applyFrontRoles(role: ModelRole): Promise<void> {
    await this.harness.commit(async (tx) => {
      for (const root of (await tx.doc(RootsDoc)).roots)
        await applyFrontRole(tx, root.id, role, this.extensions.preload);
    }, context);
  }

  /** A client view of a root is attached until the returned function runs; the last one to go marks it seen. */
  private show(id: ConversationId): () => void {
    this.shown.set(id, (this.shown.get(id) ?? 0) + 1);
    this.refreshRoots();
    return () => {
      const count = (this.shown.get(id) ?? 1) - 1;
      if (count > 0) {
        this.shown.set(id, count);
        return;
      }
      this.shown.delete(id);
      if (this.closing !== undefined) return;
      void this.harness
        .commit(async (tx) => {
          const root = rootRecord(await tx.doc(RootsDoc), id);
          if (root !== undefined) root.seenAt = Date.now();
        }, context)
        .catch((error: unknown) =>
          this.reports.report(
            `Could not mark root ${shortId(id)} seen: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    };
  }

  /** Every root with its indicator state, archived ones included, in creation order. */
  private async summaries(): Promise<RootSummary[]> {
    const jobs = await this.harness.snapshot(JobsDoc, context);
    return Promise.all(
      (await this.records()).map((root) =>
        summarize(this.harness, root, jobs, this.shown.has(root.id), context),
      ),
    );
  }

  /**
   * Recompute the roots' summaries soon, at most every quarter second, and tell listeners when they changed. Commits
   * stream in while models reply, so a burst costs one recompute.
   */
  private refreshRoots(): void {
    if (this.rootListeners.size === 0 || this.closing !== undefined) return;
    this.rootsDirty = true;
    if (this.rootsTimer !== undefined || this.rootsRun !== undefined) return;
    this.rootsTimer = setTimeout(() => {
      this.rootsTimer = undefined;
      this.rootsDirty = false;
      this.rootsRun = this.summaries()
        .then((summaries) => {
          if (JSON.stringify(summaries) === JSON.stringify(this.rootSummaries)) return;
          this.rootSummaries = summaries;
          for (const listener of this.rootListeners) listener(summaries);
        })
        .catch((error: unknown) =>
          this.reports.log(
            `Root summaries failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          this.rootsRun = undefined;
          if (this.rootsDirty) this.refreshRoots();
        });
    }, 250);
  }

  /** Every root, archived ones included, now and as they change. Returns a stop function. */
  async watchRoots(listener: (roots: readonly RootSummary[]) => void): Promise<() => void> {
    const summaries = await this.summaries();
    this.rootSummaries ??= summaries;
    this.rootListeners.add(listener);
    listener(summaries);
    return () => {
      this.rootListeners.delete(listener);
      if (this.rootListeners.size === 0) this.rootSummaries = undefined;
    };
  }

  /** The full id of the root a unique prefix names; unknown and ambiguous prefixes throw with the candidates. */
  async findRoot(prefix: string): Promise<string> {
    return shortId(findRoot(await this.records(), prefix).id);
  }

  /** The open root with the newest input from the user. */
  async currentRoot(): Promise<string> {
    const root = currentRoot(await this.records());
    if (root === undefined) throw new Error("This home has no root");
    return shortId(root.id);
  }

  /** Starts a root in the home directory with the front's agent; a retry with the same request ID returns it. */
  async createRoot(requestId: string): Promise<string> {
    if (!requestId.trim()) throw new Error("A request ID is required");
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    const id = await this.harness.commit(async (tx) => {
      const state = await tx.doc(RootsDoc);
      const previous = state.roots.find((root) => root.requestId === requestId);
      if (previous !== undefined) return previous.id;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, { cwd: this.home });
      await prepareFront(tx, created.id, this.extensions);
      state.roots.push({
        id: created.id,
        label: "",
        named: false,
        createdAt: Date.now(),
        requestId,
      });
      return created.id;
    }, context);
    this.log.write("info", "core.roots", "root created", { root: shortId(id) });
    return shortId(id);
  }

  /** Names a root; an empty label names it again from its next message. */
  async renameRoot(id: string, label: string): Promise<void> {
    const text = label.replace(/\s+/g, " ").trim();
    if (text.length > 80) throw new Error("A root label is at most 80 characters");
    await this.harness.commit(async (tx) => {
      const root = findRoot((await tx.doc(RootsDoc)).roots, id);
      root.label = text;
      root.named = text !== "";
    }, context);
  }

  /**
   * Archives a root, hiding it from the list, the indicator and plain `monchu`, or shows it again. Its history, crew,
   * goals and jobs stay, and its id still opens it. Refused while its front or crew is working, so nothing active hides.
   */
  async archiveRoot(id: string, archived: boolean): Promise<void> {
    const records = await this.records();
    const record = findRoot(records, id);
    if (archived) {
      if (records.filter((root) => !root.archived && root.id !== record.id).length === 0)
        throw new Error("The last open root can't be archived; start another first");
      const summary = await summarize(
        this.harness,
        record,
        await this.harness.snapshot(JobsDoc, context),
        false,
        context,
      );
      if (summary.status === "working")
        throw new Error(
          `Root ${shortId(record.id)} is working; let its front, workers and commands finish, or stop them, first`,
        );
    }
    await this.harness.commit(async (tx) => {
      const root = rootRecord(await tx.doc(RootsDoc), record.id);
      if (root === undefined) return;
      if (archived) root.archived = true;
      else delete root.archived;
    }, context);
  }

  /** Every background job and the recent job events, store-wide, with the jobs as the job tool lists them. */
  /** Stored secrets by name and the pending requests, now and after each change; returns a stop function. */
  async watchSecrets(listener: (state: SecretsState) => void): Promise<() => void> {
    // Observation needs a stored document; reading it in a commit creates it on a fresh home.
    await this.harness.commit(async (tx) => {
      await tx.doc(SecretsDoc);
    }, context);
    const doc = await this.harness.documentState(SecretsDoc, context);
    if (doc === undefined) throw new Error("Secrets document is missing");
    let secrets = await this.vault.list();
    let requests: SecretsState["requests"] = [];
    const emit = () => listener({ secrets, requests });
    const stopDoc = doc.subscribe((value) => {
      requests = (value?.requests ?? []).map(({ waiting: _waiting, ...request }) => ({
        ...request,
      }));
      emit();
    });
    const stopVault = this.vault.onChange((next) => {
      secrets = [...next];
      emit();
    });
    return () => {
      stopVault();
      stopDoc();
      doc.dispose();
    };
  }

  /**
   * Stores a secret the user entered and answers every request for its name. Only a person's client calls it; the value
   * never leaves the vault and no error names it.
   */
  async setSecret(input: SecretInput): Promise<void> {
    const info = await this.vault.set(input);
    await answerRequests(this.harness, info.name, info, context);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.vault.delete(name);
  }

  /** Declines every pending request for a name: whoever asked is told. */
  async declineSecret(name: string): Promise<void> {
    if ((await answerRequests(this.harness, name, undefined, context)) === 0)
      throw new Error(`No pending request for ${name}`);
  }

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
    await this.harness.commit(async (tx) => {
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
    if (role === "front") await this.applyFrontRoles(saved);
  }

  /** Concurrent requests share one reload. No registry or settings changes survive a failed preparation. */
  reload(): Promise<readonly string[]> {
    if (this.closing !== undefined) return Promise.reject(new Error("Monchu is closing"));
    const started = performance.now();
    this.reloading ??= this.extensions
      .reload(async (config) => {
        // Durable captures model and stream options during request preparation; later phases resolve current policy.
        await this.applyFrontRoles(config.front);
      })
      .then(async (modules) => {
        // The new build's groups: a server whose preload was just turned on reaches existing conversations now.
        for (const id of await this.rootIds()) await selectAll(this.harness, id, this.extensions);
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
    // The home is shared: its budget state stays on the first root, and the notice goes to the current one.
    const records = await this.records();
    const first = records[0];
    const current = currentRoot(records);
    if (first === undefined || current === undefined) return;
    const front = await this.root(shortId(current.id)).conversation();
    // The notice is recorded with the levels and cleared once admitted, so a crash in between posts it again.
    const { pending, summary } = await this.harness.commit(async (tx) => {
      const state = await tx.doc(HomeBudgetDoc, first.id);
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
    await front.submit(
      { type: "input", content: pending.text, requestId: pending.requestId, whenBusy: "followUp" },
      context,
    );
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(HomeBudgetDoc, first.id);
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
    await this.harness.commit(async (tx) => {
      (await tx.doc(RestartRequest)).request = null;
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
    clearTimeout(this.rootsTimer);
    this.rootListeners.clear();
    try {
      // Clients' views and the build go first; a failed reload must not prevent storage from closing.
      await this.extensions.closeHost();
      await this.reloading?.catch(() => {});
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

/** A prompt this large that reads under half of the conversation's previous prompt from cache is a cache miss. */
const CACHE_MISS_TOKENS = 4096;

/**
 * One log record per model reply, from the committed assistant entry: model, tokens, cache read ratio, time and stop
 * reason, never content. A reply whose prompt lost most of the previous one's cache is logged as a warning, so prompt
 * cache regressions show in the logs.
 */
function modelTelemetry(log: Log): (publication: CommitPublication) => void {
  const previous = new Map<string, number>();
  return (publication) => {
    for (const change of publication.changes) {
      if (change.type !== "entry" || change.value.kind !== "pi.assistant") continue;
      const message = change.value.model?.[0];
      if (message?.role !== "assistant") continue;
      const { input, cacheRead, cacheWrite } = message.usage;
      const prompt = input + cacheRead + cacheWrite;
      const conversation = String(change.value.conversationId);
      const before = previous.get(conversation);
      const cacheMiss =
        prompt > 0 && before !== undefined && before >= CACHE_MISS_TOKENS && cacheRead < before / 2;
      if (prompt > 0) previous.set(conversation, prompt);
      log.write(
        message.stopReason === "error" || cacheMiss ? "warn" : "info",
        "core.model",
        "reply",
        {
          conversation: change.value.conversationId,
          entry: change.value.id,
          model: `${message.provider}/${message.model}`,
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          cacheRatio: prompt > 0 ? Math.round((cacheRead / prompt) * 1000) / 1000 : null,
          ...(cacheMiss ? { cacheMiss: true } : {}),
          ms: message.durationMs ?? null,
          stop: message.stopReason,
        },
      );
    }
  };
}

/** Whether a commit can change a root's summary: its run, crew, jobs, registry, or a reply. */
function touchesRoots(publication: CommitPublication): boolean {
  return publication.changes.some(
    (change) =>
      (change.type === "document" && SUMMARY_KINDS.has(change.record.kind)) ||
      (change.type === "entry" && change.value.kind === "pi.assistant"),
  );
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
