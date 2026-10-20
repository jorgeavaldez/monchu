import type { Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  cleanupSessionResources,
  getSupportedThinkingLevels,
  type Api,
  type AuthInteraction,
  type AuthType,
  type Message,
  type Model,
  type Provider,
  type Models,
} from "@earendil-works/pi-ai";
import {
  configure,
  Harness,
  type CommitPublication,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Client,
  LoginEntry,
  LoginNeeds,
  ModelChoice,
  ModelPick,
  RootSummary,
} from "../api/client.ts";
import type { Principal } from "../api/contract.ts";
import { shortId } from "../api/ids.ts";
import { parseRelease, type Release } from "../api/release.ts";
import { systemNoticeText } from "../api/notices.ts";
import type { LogAttributes, LogQuery, LogRecord } from "../api/logs.ts";
import type { McpServerReport } from "../api/reports.ts";
import { Log } from "../telemetry/log.ts";
import { findRoot, rootRecord, RootsDoc, type RootRecord } from "./agents/root-records.ts";
import { currentRoot, summarize, SUMMARY_KINDS } from "./agents/roots.ts";
import {
  isThinkingLevel,
  loadStartupConfig,
  thinkingLevels,
  type ModelRole,
  type Settings,
} from "./config.ts";
import { GoalsDoc } from "./agents/goals.ts";
import { parentOf, WorkersDoc } from "./agents/workers.ts";
import { harnessSettings } from "./context.ts";
import { homeNotice } from "./home-check.ts";
import { applyFrontRole, Front, prepareFront, selectAll, type FrontHost } from "./front.ts";
import { formatJobs, JobsDoc, type JobEvent, type JobsState } from "./jobs.ts";
import { InboxItemsDoc, noteReplies, replyText, type InboxKind } from "./inbox.ts";
import { Pusher, type PushSubscription } from "./push.ts";
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
import { DraftsDoc, saveDraft, takeDraft, type DraftsState } from "./drafts.ts";
import type { SecretStore } from "../plugin.ts";
import { redact, Vault, type SecretInput } from "./secrets/vault.ts";

const context = BACKGROUND_CONTEXT;

/** One runtime/store owner, and the in-process implementation of the client contract. No terminal, transport, or rendering dependencies. */
/** The web build's page modules by plugin (`dist/web/pages.json`), in the package and a checkout alike. */
function builtPages(): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL("../../dist/web/pages.json", import.meta.url), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && /^page-[a-z0-9-]+\.[0-9A-Z]{8}\.js$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

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
  /** Home check notices go out one at a time, in order. */
  private homeWork: Promise<void> = Promise.resolve();
  private homeNotices = 0;
  private readonly envs: ExecutionEnvs;
  /** The home's secrets: names here, values in the store a plugin keeps. */
  private readonly vault: Vault;
  /** The structured log: warnings, timings, model replies and client events. */
  readonly log: Log;
  private readonly stopTelemetry: () => void;
  private readonly telemetry: ReturnType<typeof modelTelemetry>;
  /** This device's browsers that asked for pushes, and what sends them. */
  private readonly pusher: Pusher;
  /** Inbox work per conversation, one run at a time. */
  private readonly inboxRuns = new Map<ConversationId, Promise<void>>();

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
      show: (id) => this.show(id),
      findRoot: async (prefix) => findRoot(await this.records(), prefix),
    };
    this.pusher = new Pusher(home, (body, attributes) =>
      log.write("info", "core.push", body, attributes),
    );
    this.telemetry = modelTelemetry(log, harness);
    const telemetry = this.telemetry;
    this.stopTelemetry = harness.subscribeCommits((publication) => {
      telemetry.observe(publication);
      if (this.rootListeners.size > 0 && touchesRoots(publication)) this.refreshRoots();
      for (const change of publication.changes)
        // A reply with text joins its root's inbox, as does input carrying a plugin's ask.
        if (
          change.type === "entry" &&
          (replyText(change.value) !== "" || change.value.kind === "pi.user")
        )
          this.inboxLater(change.value.conversationId, () =>
            this.noteReplies(change.value.conversationId),
          );
        else if (
          change.type === "document" &&
          change.record.kind === InboxItemsDoc.definition.kind &&
          change.conversationId !== undefined
        ) {
          const id = change.conversationId;
          this.inboxLater(id, () => this.pushInbox(id));
        }
    });
  }

  /**
   * `secretStore` replaces plugins' secret stores, for tests and the offline smoke home only. `safe` opens without home plugins, as the
   * server's supervisor asks once a core with them failed.
   */
  static async open(
    home: string,
    devProvider?: Provider,
    options: { secretStore?: SecretStore; safe?: boolean } = {},
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
      // A broken config.json must not keep Monchu from opening: what is invalid keeps its default, and says why.
      const written = await loadStartupConfig(home);
      phase("config");
      const models = await openModels(
        home,
        devProvider,
        written.claude,
        (warning) => reports.report(warning),
        () => extensions?.claude,
      );
      const { config, warnings } = await configuredRoles(models, written);
      for (const warning of warnings) reports.report(warning);
      // Renders start once the harness resumes, after the backend below takes over.
      let observeBudget = (_levels: BudgetLevel[]) => {};
      let tellHome = (_problems: readonly string[], _from?: ConversationId) => {};
      // Before the backend exists, a notice waits for it.
      const early: [string, string][] = [];
      let tellFront: (summary: string, text: string) => void = (summary, text) => {
        early.push([summary, text]);
      };
      const loaded = await Extensions.load(
        models,
        config,
        home,
        (warning) => reports.report(warning),
        {
          observeBudget: (levels) => observeBudget(levels),
          tellHome: (problems, from) => tellHome(problems, from),
          tellFront: (summary, text) => tellFront(summary, text),
          onError: (error) =>
            log.write("warn", "core.chord", "background failure", {
              reason: error instanceof Error ? error.message : String(error),
            }),
          vault,
          safe: options.safe ?? false,
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
      extensions.bind(harness);
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
      tellHome = (problems, from) => backend.tellHome(problems, from);
      tellFront = (summary, text) => backend.tellFront(summary, text);
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
          () => loaded.warnings,
        ),
      );
      // Every definition is installed; pending work resumes whether or not a client is attached.
      harness.resume();
      // The first home check: what this start could not load reaches the front, not only the log.
      void loaded.homeCheck.check();
      for (const [summary, text] of early) backend.tellFront(summary, text);
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
    return this.extensions.commands.map(({ name, usage, description }) => ({
      name,
      usage: usage ?? "",
      help: description ?? "",
    }));
  }

  /** The page modules of plugins that are on, as the web build named them; none while the client isn't built. */
  pages(): readonly { plugin: string; url: string }[] {
    const built = builtPages();
    return this.extensions.plugin.pages.flatMap((plugin) => {
      const file = built[plugin];
      return file === undefined ? [] : [{ plugin, url: `/${file}` }];
    });
  }

  /** Providers plugins added, which `/login` offers after Monchu's own. */
  logins(): readonly LoginEntry[] {
    return this.extensions.plugin.logins.map(({ id, label, auth }) => ({ id, label, auth }));
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
   * of them is enough, since unchosen roles follow it), and the optional logins plugins want and lack. Empty when
   * nothing does. Never reads or returns credential values.
   */
  async loginNeeds(): Promise<LoginNeeds> {
    const { front, worker, chosen } = this.extensions.config;
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
      optional: (
        await Promise.all(
          this.extensions.plugin.wants.map(async (want) =>
            (await missing(want.provider)) ? [want] : [],
          ),
        )
      ).flat(),
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

  /** Turn an MCP server on or off on this device only, then reload so its tools come or go. */
  async mcpSetEnabled(name: string, enabled: boolean): Promise<string> {
    if (this.closing !== undefined) throw new Error("Monchu is closing");
    const message = await this.extensions.mcpSetEnabled(name, enabled);
    await this.reload();
    return message;
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

  /** Runs inbox work for a conversation after the ones before it; a failure is reported. */
  private inboxLater(id: ConversationId, work: () => Promise<void>): void {
    const run = (this.inboxRuns.get(id) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        if (this.closing === undefined)
          this.reports.report(`Inbox: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.inboxRuns.get(id) === run) this.inboxRuns.delete(id);
      });
    this.inboxRuns.set(id, run);
  }

  /** A root front's new replies join its inbox, and plugins hear of each in the same commit. */
  private async noteReplies(id: ConversationId): Promise<void> {
    if (this.closing !== undefined || !(await this.rootIds()).includes(id)) return;
    await this.harness.commit(async (tx) => {
      for (const item of await noteReplies(tx, id)) {
        const entry = item.kind === undefined ? await tx.entry(item.entry) : undefined;
        if (entry !== undefined)
          await this.extensions.plugin.front.reply(
            { entry: item.entry, text: replyText(entry), headline: item.headline },
            tx,
            id,
          );
      }
    }, context);
  }

  /**
   * Pushes a root's newly labeled asks and milestones to the browsers that want them, at most once each: marked pushed
   * before they go. One labeled long ago, such as on a front's relabel days later, is not news.
   */
  private async pushInbox(id: ConversationId): Promise<void> {
    if (this.closing !== undefined) return;
    const now = Date.now();
    const due = async (item: { kind?: InboxKind; pushed?: boolean; labeledAt?: number }) =>
      (item.kind === "ask" || item.kind === "milestone") &&
      item.pushed !== true &&
      (item.labeledAt ?? 0) > now - 15 * 60_000 &&
      (await this.pusher.wants(item.kind));
    const snapshot = await this.harness.snapshot(InboxItemsDoc, id, context);
    const items = snapshot?.items ?? [];
    // A plugin's open ask goes out before its notice reaches the transcript: the front may be busy for a while.
    const asks = (snapshot?.pending ?? []).filter(
      (ask) => ask.state === "open" && ask.pushed !== true && ask.at > now - 15 * 60_000,
    );
    const pending: EntryId[] = [];
    for (const item of items.slice(-20)) if (await due(item)) pending.push(item.entry);
    const keys = (await this.pusher.wants("ask")) ? asks.map((ask) => ask.key) : [];
    if (pending.length === 0 && keys.length === 0) return;
    const sent = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(InboxItemsDoc, id);
      const marked = doc.items.filter(
        (item) => pending.includes(item.entry) && item.pushed !== true && item.state !== "closed",
      );
      const early = (doc.pending ?? []).filter(
        (ask) => keys.includes(ask.key) && ask.pushed !== true && ask.state === "open",
      );
      for (const each of [...marked, ...early]) each.pushed = true;
      return [
        ...marked.map((item) => ({
          kind: item.kind,
          goal: item.goal,
          headline: item.headline,
          url: item.url ?? `/?root=${shortId(id)}#m-${shortId(item.entry)}`,
          tag: item.key ?? shortId(item.entry),
        })),
        ...early.map((ask) => ({
          kind: "ask" as const,
          goal: ask.goal,
          headline: ask.headline,
          url: ask.url ?? `/?root=${shortId(id)}`,
          tag: ask.key,
        })),
      ];
    }, context);
    const goals = (await this.harness.snapshot(GoalsDoc, id, context))?.goals ?? [];
    for (const item of sent) {
      if (item.kind === undefined) continue;
      const goal = goals.find((each) => each.id === item.goal);
      await this.pusher.send(
        {
          title: `${item.kind === "ask" ? "needs you" : "done"}${goal === undefined ? "" : ` · ${goal.title}`}`,
          body: item.headline,
          url: item.url,
          tag: item.tag,
        },
        item.kind,
      );
    }
  }

  /** This device's web push key, for a browser to subscribe with. */
  pushKey(): Promise<string> {
    return this.pusher.publicKey();
  }

  /** A browser asks for pushes of `kinds` (none stops them). */
  pushSubscribe(subscription: PushSubscription): Promise<void> {
    return this.pusher.subscribe(subscription);
  }

  /** The kinds a browser gets pushed, or `null` when it has no subscription here. */
  async pushKinds(endpoint: string): Promise<InboxKind[] | null> {
    return (await this.pusher.kinds(endpoint)) ?? null;
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
    const pending = (value: typeof doc.value) =>
      (value?.requests ?? []).map(({ waiting: _waiting, ...request }) => ({ ...request }));
    // A subscription hears only changes: the requests pending now come first.
    let requests: SecretsState["requests"] = pending(doc.value);
    const emit = () => listener({ secrets, requests });
    emit();
    const stopDoc = doc.subscribe((value) => {
      requests = pending(value);
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

  /** The prompt drafts, now and after each change; returns a stop function. */
  async watchDrafts(listener: (state: DraftsState) => void): Promise<() => void> {
    // Observation needs a stored document; reading it in a commit creates it on a fresh home.
    await this.harness.commit(async (tx) => {
      await tx.doc(DraftsDoc);
    }, context);
    const doc = await this.harness.documentState(DraftsDoc, context);
    if (doc === undefined) throw new Error("Drafts document is missing");
    // A subscription hears only changes: the drafts as they are come first.
    const emit = (value: DraftsState | null) => listener(value ?? { drafts: [], next: 1 });
    emit(doc.value);
    const stop = doc.subscribe(emit);
    return () => {
      stop();
      doc.dispose();
    };
  }

  saveDraft(text: string): Promise<void> {
    return saveDraft(this.harness, text, context);
  }

  takeDraft(id: number): Promise<string> {
    return takeDraft(this.harness, id, context);
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
  async logs(query: LogQuery): Promise<LogRecord[]> {
    // A reply's record may wait on its conversation's previous prompt from the store.
    await this.telemetry.settled();
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

  /**
   * The home check's problems, or that they are gone, as a follow-up system notice to the current root's front, and in
   * the log. A front that left them was already sent back to fix them.
   */
  private tellHome(problems: readonly string[], from?: ConversationId): void {
    if (this.closing !== undefined) return;
    this.homeWork = this.homeWork
      .then(() => this.noticeHome(problems, from))
      .catch((error: unknown) =>
        this.reports.report(
          `Home check notice failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  private async noticeHome(problems: readonly string[], from?: ConversationId): Promise<void> {
    void this.reports.log(
      problems.length === 0
        ? "Home check passes"
        : `Home check: ${problems.length} problems: ${problems.join("; ")}`,
    );
    const records = await this.records();
    const current = currentRoot(records);
    if (current === undefined) return;
    if (from !== undefined && records.some((record) => record.id === from)) return;
    const name =
      from === undefined
        ? undefined
        : await this.harness.commit(async (tx) => {
            const parent = await parentOf(tx, from);
            if (parent === undefined) return undefined;
            const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
              (each) => each.conversationId === from,
            );
            return worker === undefined ? undefined : `Worker ${worker.name}`;
          }, context);
    await this.submitFront(
      homeNotice(problems, name ?? (from === undefined ? undefined : `Agent ${shortId(from)}`)),
    );
  }

  /** A system notice to the current root's front, after any home check notice before it. */
  private tellFront(summary: string, text: string, requestId?: string): void {
    if (this.closing !== undefined) return;
    this.homeWork = this.homeWork
      .then(() => this.submitFront(systemNoticeText(summary, text), requestId))
      .catch((error: unknown) =>
        this.reports.report(
          `Notice failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  private async submitFront(content: string, requestId?: string): Promise<void> {
    const current = currentRoot(await this.records());
    if (current === undefined) return;
    const front = await this.root(shortId(current.id)).conversation();
    await front.submit(
      {
        type: "input",
        content,
        requestId: requestId ?? `home-check:${Date.now()}:${++this.homeNotices}`,
        whenBusy: "followUp",
      },
      context,
    );
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

  /**
   * The server started this core again after the last one failed (`src/server/process.ts`): every client shows why,
   * and the current front hears it as a system notice, so it can have the cause fixed. `at` names the failure, so each
   * core started for the same one sends the same request.
   */
  recovered(recovery: { safe: boolean; reason: string; at: number }): void {
    void (async () => {
      // A crash's output holds whatever its code printed: stored secrets never reach the front or a client.
      const reason = redact(recovery.reason, await this.vault.known().catch(() => []));
      const summary = recovery.safe
        ? "Monchu restarted in safe mode, without home plugins"
        : "Monchu's core crashed and restarted";
      const text = recovery.safe
        ? `The last core failed: ${reason}\nThis one runs without home plugins (plugins/ and plugins/local/), so no plugin code runs. Work it had accepted resumes. Fix the cause, then a person's /restart loads the plugins again; if they still fail, Monchu comes back in safe mode.`
        : `The last core failed: ${reason}\nWork it had accepted resumes. Another crash within 10 minutes restarts it in safe mode, without home plugins.`;
      this.reports.report(`${summary}: ${reason.split("\n")[0] ?? ""}`);
      this.tellFront(summary, text, `core-recovery:${recovery.at}`);
    })();
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
      // A home check notice in flight still reaches the store before it closes, as do reply records reading it.
      await this.homeWork;
      await this.telemetry.settled();
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

type ReplyMessage = Extract<Message, { role: "assistant" }>;

const promptOf = ({ usage }: ReplyMessage) => usage.input + usage.cacheRead + usage.cacheWrite;

/**
 * The prompt of a conversation's last reply before `entry` that sent one, from the store: after a restart the process
 * has seen none of its replies, and the first request after one is the likeliest to miss.
 */
async function storedPrompt(
  harness: Harness,
  id: ConversationId,
  entry: EntryId,
): Promise<number | undefined> {
  const conversation = await harness.conversation(id, context);
  let cursor: Parameters<NonNullable<typeof conversation>["entries"]>[2];
  for (let page = 0; conversation !== undefined && page < 10; page++) {
    const found = await conversation.entries(
      { maxEntryId: entry, order: "descending" },
      50,
      cursor,
      context,
    );
    for (const item of found.items) {
      const message = item.model?.[0];
      if (item.id === entry || item.kind !== "pi.assistant" || message?.role !== "assistant")
        continue;
      if (promptOf(message) > 0) return promptOf(message);
    }
    if (found.next === undefined) break;
    cursor = found.next;
  }
  return undefined;
}

/** What a provider reported about how it prepared the prompt cache (the Claude Code bridge's session path). */
function cacheDiagnostic(message: ReplyMessage): LogAttributes {
  const details = message.diagnostics?.find(
    (diagnostic) => diagnostic.type === "prompt_cache",
  )?.details;
  const attributes: LogAttributes = {};
  for (const [name, value] of Object.entries(details ?? {}))
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      attributes[`cache${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`] = value;
  return attributes;
}

/**
 * One log record per model reply, from the committed assistant entry: model, tokens, cache read ratio, time and stop
 * reason, never content. A reply whose prompt lost most of the previous one's cache is logged as a warning, so prompt
 * cache regressions show in the logs, as is one whose provider reports the server rejected its prefix.
 */
function modelTelemetry(
  log: Log,
  harness: Harness,
): { observe: (publication: CommitPublication) => void; settled: () => Promise<void> } {
  // A conversation's previous prompt, or its lookup in the store while this process has seen none of its replies.
  const previous = new Map<ConversationId, number | Promise<number | undefined>>();
  const lookups = new Set<Promise<unknown>>();
  const write = (entry: EntryRecord, message: ReplyMessage, before: number | undefined) => {
    const { cacheRead } = message.usage;
    const prompt = promptOf(message);
    const cacheMiss =
      prompt > 0 && before !== undefined && before >= CACHE_MISS_TOKENS && cacheRead < before / 2;
    const diagnostic = cacheDiagnostic(message);
    log.write(
      message.stopReason === "error" || cacheMiss || Number(diagnostic.cacheThinkingDropped) > 0
        ? "warn"
        : "info",
      "core.model",
      "reply",
      {
        conversation: entry.conversationId,
        entry: entry.id,
        model: `${message.provider}/${message.model}`,
        input: message.usage.input,
        output: message.usage.output,
        cacheRead,
        cacheWrite: message.usage.cacheWrite,
        cacheRatio: prompt > 0 ? Math.round((cacheRead / prompt) * 1000) / 1000 : null,
        ...(cacheMiss ? { cacheMiss: true } : {}),
        ...diagnostic,
        ms: message.durationMs ?? null,
        stop: message.stopReason,
      },
    );
    return prompt > 0 ? prompt : before;
  };
  return {
    observe: (publication) => {
      for (const change of publication.changes) {
        if (change.type !== "entry" || change.value.kind !== "pi.assistant") continue;
        const entry = change.value;
        const message = entry.model?.[0];
        if (message?.role !== "assistant") continue;
        const id = entry.conversationId;
        const known = previous.get(id);
        if (typeof known === "number") {
          previous.set(id, write(entry, message, known) ?? known);
          continue;
        }
        const next = (known ?? storedPrompt(harness, id, entry.id))
          .catch(() => undefined)
          .then((before) => write(entry, message, before));
        previous.set(id, next);
        lookups.add(next);
        void next.then((prompt) => {
          lookups.delete(next);
          if (previous.get(id) === next) {
            if (prompt === undefined) previous.delete(id);
            else previous.set(id, prompt);
          }
        });
      }
    },
    settled: async () => {
      while (lookups.size) await Promise.all(lookups);
    },
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
