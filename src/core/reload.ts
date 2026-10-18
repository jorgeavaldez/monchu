import { createHost, type FacetLoader, type Host } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { Type, type Models } from "@earendil-works/pi-ai";
import type { Skill } from "./skills/index.ts";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { principalKey, type Principal } from "../api/contract.ts";
import { BUILD, BuildHost, Builds, type Build, type BuildInputs } from "./build.ts";
import { FffFinders } from "./tools/fff.ts";
import { Vault } from "./secrets/vault.ts";
import type { McpSignInPrompt } from "./mcp/auth.ts";
import type { McpServerReport } from "../api/reports.ts";
import { mcpLogin, mcpLogout, mcpReports } from "./mcp/manage.ts";
import { McpClients } from "./mcp/index.ts";
import {
  formatPluginStatus,
  Plugins,
  type PluginCommandEntry,
  type PluginStatus,
} from "./plugins.ts";
import type { EffortAssessment } from "./agents/classifier.ts";
import type { BudgetLevel } from "./identity.ts";
import {
  loadConfig,
  saveRole,
  type ModelRole,
  type MonchuConfig,
  type Settings,
} from "./config.ts";
import { configuredRoles } from "./models/index.ts";

/** Validate the entire replacement against the installed registry, then publish it in one synchronous step. */
function validateExtensions(registry: Registry, extensions: readonly Extension[]): void {
  const names = new Set(extensions.map((extension) => extension.name));
  if (names.size !== extensions.length) throw new Error("Duplicate extension names");
  const validation = createRegistry();
  // Validate the same publication order: old task names must not collide with an earlier replacement.
  for (const extension of registry.snapshot().installed()) validation.install(extension);
  for (const extension of extensions) validation.install(extension);
}

export function installExtensions(registry: Registry, extensions: readonly Extension[]): void {
  validateExtensions(registry, extensions);
  // install is synchronous; no scheduler phase can run between these publications.
  for (const extension of extensions) registry.install(extension);
}

/**
 * Chord's loader, saying where a module failed to parse: Node keeps that only in the first line of the stack, which a
 * reload's error drops.
 */
const loader: FacetLoader = async (modules) => {
  try {
    return await nodeLoader(modules);
  } catch (error) {
    const where = error instanceof SyntaxError ? error.stack?.split("\n", 1)[0] : undefined;
    if (!(error instanceof SyntaxError) || where === undefined || where.startsWith("SyntaxError"))
      throw error;
    throw new SyntaxError(`${where}: ${error.message}`, { cause: error });
  }
};

/** Runs a reload of `modules` (facet module URLs) across the core and the server it runs under. */
export type ReloadCoordinator = (modules: readonly string[], signal: AbortSignal) => Promise<void>;

/**
 * The core's Chord host and the extension registry of its last build. The extensions are a facet (`extensions.ts`), and
 * `/reload` is one Chord reload of every facet the host loaded: fresh copies of their modules and of what they import
 * from their own directories. The backend, this module and what it imports need /restart. Config is re-read on each
 * reload.
 */
export class Extensions {
  readonly registry: Registry;
  /** The core's host: it serves the facets `/reload` swaps (this module's extensions, and any added by `loadFacets`). */
  readonly host: Host<Principal>;
  private readonly models: Models;
  private readonly home: string;
  private readonly finders: FffFinders;
  private readonly clients: McpClients;
  private readonly plugins: Plugins;
  private readonly report: (warning: string) => void;
  private readonly facets: string[];
  private current: Build;
  /** The config a running reload read, which its build applies. */
  private pending: MonchuConfig | undefined;
  /** A running reload waiting for its commit to publish the build. */
  private published: PromiseWithResolvers<void> | undefined;
  private coordinator: ReloadCoordinator | undefined;
  private readonly stopping = new AbortController();
  private hostClosed: Promise<void> | undefined;
  private reloading: Promise<readonly string[]> | undefined;
  private saving: Promise<ModelRole> | undefined;

  private constructor(
    models: Models,
    home: string,
    report: (warning: string) => void,
    current: Build,
    finders: FffFinders,
    clients: McpClients,
    plugins: Plugins,
    registry: Registry,
    host: Host<Principal>,
    facets: string[],
  ) {
    this.plugins = plugins;
    this.registry = registry;
    this.host = host;
    this.facets = facets;
    this.clients = clients;
    this.models = models;
    this.home = home;
    this.finders = finders;
    this.report = report;
    this.current = current;
  }

  /**
   * Open the core's host and build and install every extension. `report` receives configuration warnings now and after
   * each reload; `onError` the host's background failures.
   */
  static async load(
    models: Models,
    config: MonchuConfig,
    home: string,
    report: (warning: string) => void,
    options: {
      observeBudget?: (levels: BudgetLevel[]) => void;
      onError?: (error: unknown) => void;
      /** The home's secrets; by default fnox under `<home>/secrets`. */
      vault?: Vault;
    } = {},
  ): Promise<Extensions> {
    const skippedFiles = new Set<string>();
    const reportSkipped = (warning: string) => {
      if (skippedFiles.has(warning)) return;
      skippedFiles.add(warning);
      report(warning);
    };
    const finders = new FffFinders(home, report);
    // A server with `auth.provider` sends that /login provider's token, read at every connect.
    const clients = new McpClients(
      home,
      process.env,
      report,
      async (provider) => (await models.getAuth(provider))?.auth.apiKey,
    );
    const vault = options.vault ?? new Vault(join(home, "secrets"));
    const plugins = new Plugins(home, report, vault);
    const registry = createRegistry();
    const host = createHost<Principal>({
      name: "core",
      self: { kind: "core" },
      principalKey,
      loader,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    // Builds only run once their inputs are served; until construction they apply the startup config.
    let extensions: Extensions | undefined;
    const first = Promise.withResolvers<Build>();
    host.registry(Builds).subscribe((table) => {
      const build = table.get(BUILD)?.value;
      if (build === undefined) return;
      if (extensions === undefined) first.resolve(build);
      else extensions.publish(build);
    });
    const inputs: BuildInputs = {
      models,
      home,
      config: () => extensions?.pending ?? extensions?.config ?? config,
      workerRole: () => extensions?.config.worker ?? config.worker,
      reportSkipped,
      observeBudget: (levels) => options.observeBudget?.(levels),
      finders,
      clients,
      vault,
      plugins,
      validate: (list) => validateExtensions(registry, list),
    };
    host.serve(
      BuildHost,
      (_input, _principal, self) => ({
        inputs: self.expose(self.resource("inputs", { version: 1, open: () => inputs })),
      }),
      { lifetime: "host" },
    );
    // By URL, so Chord's loader can import a fresh copy at each reload: TypeScript from source, JavaScript once built.
    const facets = [
      new URL(`./extensions.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
        .href,
    ];
    let build: Build;
    try {
      await host.load(facets);
      build = await first.promise;
      installExtensions(registry, build.extensions);
    } catch (error) {
      await host.close();
      plugins.close();
      await finders.close();
      await clients.close();
      throw error;
    }
    extensions = new Extensions(
      models,
      home,
      report,
      build,
      finders,
      clients,
      plugins,
      registry,
      host,
      facets,
    );
    for (const warning of build.warnings) report(warning);
    return extensions;
  }

  /** Load more facets on the core's host, such as the wire's; every later reload swaps them too. */
  async loadFacets(modules: readonly string[]): Promise<void> {
    await this.host.load(modules);
    this.facets.push(...modules);
  }

  /**
   * Run reloads through `coordinator` from now on, as a core under a server must: a child host that reloads alone runs
   * ahead of its parent. Returns a function that goes back to reloading this host alone.
   */
  coordinate(coordinator: ReloadCoordinator): () => void {
    this.coordinator = coordinator;
    return () => {
      if (this.coordinator === coordinator) this.coordinator = undefined;
    };
  }

  /** A committed reload's build: install it; the build validated it while the reload prepared. */
  private publish(build: Build): void {
    try {
      // A plugin that is gone or turned off leaves now; Monchu's own extensions stay installed until a restart.
      const owned = new Set(build.owned);
      for (const name of this.current.owned) {
        const extension = owned.has(name) ? undefined : this.registry.snapshot().extension(name);
        if (extension !== undefined) this.registry.uninstall(extension);
      }
      for (const extension of build.extensions) this.registry.install(extension);
    } catch (error) {
      this.published?.reject(error);
      throw error;
    }
    this.current = build;
    this.plugins.settle(build.plugins);
    this.published?.resolve();
  }

  get config(): MonchuConfig {
    return this.current.config;
  }

  /**
   * Save a role default to `config.json` (see `saveRole`); new workers use it without a reload. Saves and reloads never
   * overlap, so a reload that read the old file cannot replace the saved role.
   */
  async saveRole(
    role: "front" | "worker",
    change: Partial<ModelRole>,
    check: (saved: ModelRole) => void,
  ): Promise<ModelRole> {
    while (this.reloading !== undefined || this.saving !== undefined)
      await Promise.allSettled([this.reloading, this.saving]);
    const saving = saveRole(this.home, role, change, check, this.current.config[role]);
    this.saving = saving;
    try {
      const saved = await saving;
      const config = this.current.config;
      this.current = {
        ...this.current,
        config: { ...config, [role]: saved, chosen: { ...config.chosen, [role]: true } },
      };
      return saved;
    } finally {
      this.saving = undefined;
    }
  }

  /** The loaded run settings. */
  get settings(): Settings {
    return this.current.settings;
  }

  /** The skills of the last successful build. */
  get skills(): readonly Skill[] {
    return this.current.skills;
  }

  /** Group extension names that conversations on the Claude Code bridge load from the start. */
  get preload(): readonly string[] {
    return this.current.preload;
  }

  get assessment(): EffortAssessment | undefined {
    return this.current.assessment;
  }

  /** Left out of the host default selection and added to the root; workers inherit them, since Durable copies the root's agent into each conversation it owns. */
  get root(): readonly Extension[] {
    return this.current.root;
  }

  /** Home plugins' extensions, which every conversation selects by appending them. */
  get attached(): readonly Extension[] {
    return this.current.plugins.attached;
  }

  /** Plugins' slash commands as of the last build. */
  get commands(): readonly PluginCommandEntry[] {
    return this.current.plugins.commands;
  }

  /** What the last build loaded of each plugin. */
  get pluginStatus(): readonly PluginStatus[] {
    return this.current.plugins.status;
  }

  /** Deferred tool groups, loaded per conversation by `tool_search` or preloading. */
  get groups(): readonly Extension[] {
    return this.current.groups;
  }

  /** Every installed extension except the ones added to each conversation: the root's, groups and home plugins. */
  defaults(): readonly Extension[] {
    const names = new Set(this.current.extensions.map((extension) => extension.name));
    for (const extension of [...this.current.root, ...this.current.groups, ...this.attached])
      names.delete(extension.name);
    names.add("monchu.reload");
    // Disabled classifier definitions remain installed to finish already accepted assessment tasks.
    return this.registry
      .snapshot()
      .installed()
      .filter((extension) => names.has(extension.name));
  }

  /**
   * Concurrent requests share one reload, which resolves to the facets it swapped. A failed build, import, validation or
   * prepare leaves the running code, installed definitions and settings unchanged.
   */
  reload(applyConfig?: (config: MonchuConfig) => Promise<void>): Promise<readonly string[]> {
    this.reloading ??= (async () => {
      await this.saving?.catch(() => {});
      if (this.stopping.signal.aborted) throw new Error("Monchu is closing");
      await buildForReload();
      // A bad role keeps the one running, with a warning, as startup falls back to the defaults.
      const roles = await configuredRoles(this.models, await loadConfig(this.home), this.config);
      const config = roles.config;
      if (
        config.claude.executable !== this.current.config.claude.executable ||
        config.claude.plan !== this.current.config.claude.plan ||
        config.claude.longContextExtraUsage !== this.current.config.claude.longContextExtraUsage
      )
        throw new Error("Claude Code host settings changed; use /restart to apply them");
      const published = Promise.withResolvers<void>();
      this.pending = config;
      this.published = published;
      try {
        const signal = this.stopping.signal;
        await (this.coordinator === undefined
          ? this.host.reload(this.facets)
          : this.coordinator(this.facets, signal));
        // The commit publishes the build: at once here, and as soon as the server's commit arrives under one.
        await until(published.promise, signal);
      } finally {
        this.pending = undefined;
        this.published = undefined;
        // Plugin instances a failed reload started never run.
        this.plugins.settle(this.current.plugins);
      }
      await applyConfig?.(config);
      for (const warning of [...roles.warnings, ...this.current.warnings]) this.report(warning);
      return this.facets.map((url) => basename(fileURLToPath(url)).replace(/\.[^.]+$/, ""));
    })().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  /** Every configured MCP server's state and tools, connecting now; for `/mcp`. */
  mcpServers(): Promise<{ servers: McpServerReport[]; errors: string[] }> {
    return mcpReports(this.home, this.clients);
  }

  /** Sign in to an OAuth MCP server and cache its tools; a reload then installs them. */
  mcpLogin(name: string, prompt: McpSignInPrompt, signal: AbortSignal): Promise<string> {
    return mcpLogin(this.home, this.clients, name, prompt, signal);
  }

  mcpLogout(name: string): Promise<string> {
    return mcpLogout(this.home, this.clients, name);
  }

  /**
   * Stop reloading and close the core's host, before the store closes: what clients opened and the build object go
   * first. A reload waiting on a server that is gone gives up.
   */
  closeHost(): Promise<void> {
    this.hostClosed ??= (async () => {
      this.stopping.abort(new Error("Monchu is closing"));
      await this.settled();
      await this.host.close();
    })();
    return this.hostClosed;
  }

  /** Close the host, then release search indexes and MCP servers after Durable stops its calls. */
  async close(): Promise<void> {
    await this.closeHost();
    this.plugins.close();
    await this.finders.close();
    await this.clients.close();
  }

  /** Resolves once no reload or role save is running, whether or not it succeeded. */
  async settled(): Promise<void> {
    while (this.reloading !== undefined || this.saving !== undefined)
      await Promise.allSettled([this.reloading, this.saving]);
  }
}

/** `promise`, or a rejection once `signal` aborts. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Whether any source is newer than the build; every build rewrites `dist/main.js`. */
async function buildIsStale(): Promise<boolean> {
  const built = await stat(new URL("../main.js", import.meta.url)).catch(() => undefined);
  if (built === undefined) return true;
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  for (const entry of await readdir(src, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && (await stat(join(entry.parentPath, entry.name))).mtimeMs > built.mtimeMs)
      return true;
  return false;
}

/**
 * A checkout's compiled mode (including one `npm link`ed as the global command) needs fresh JS, so reload builds it
 * when a source is newer; a build made beforehand, such as one the phone runs by hand, is reused. Source mode uses
 * Node's native type stripping, and an installed package ships no sources, so reload re-reads its fixed build.
 */
async function buildForReload(): Promise<void> {
  if (import.meta.url.endsWith(".ts")) return;
  if (!existsSync(fileURLToPath(new URL("../../tsconfig.build.json", import.meta.url)))) return;
  if (!(await buildIsStale())) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)),
        "-p",
        "tsconfig.build.json",
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    });
    child.stderr.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Reload build failed (${code}):\n${output}`)),
    );
  });
}

/** One per home, so every root's front sees it; requesting a restart never executes one. */
export const RestartRequest = defineDoc<{
  request: { reason: string; requestedAt: number } | null;
}>({
  kind: "monchu.restart",
  version: 1,
  scope: "session",
  initial: () => ({ request: null }),
});

export function createReloadControls(
  reload: () => Promise<readonly string[]>,
  plugins: () => readonly PluginStatus[] = () => [],
) {
  return defineExtension({
    name: "monchu.reload",
    sections: [
      // Never undefined: a section that appears later re-sends every section after it, see AGENTS.md (prompt cache).
      section("restart_request", async (input, context) => {
        const request = (await input.read.snapshot(RestartRequest, context))?.request;
        return request === undefined || request === null
          ? "No restart requested."
          : `Restart requested: ${request.reason}. Only the user can approve it with /restart.`;
      }),
    ],
    tools: [
      defineTool({
        name: "reload_extensions",
        description:
          "Reload Monchu config, extensions and home/bundled skills in process. Model roles and run settings apply to subsequent requests; running calls finish on old code. Home files are read on every request. Host code changes require request_restart and the user's /restart.",
        parameters: Type.Object({}),
        replay: "unsafe",
        execute: async () => ({
          output: [
            {
              type: "text",
              text: [`Reloaded: ${(await reload()).join(", ")}`, formatPluginStatus(plugins())]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        }),
      }),
      defineTool({
        name: "request_restart",
        description:
          "Record a reason to ask the user for /restart. This never restarts Monchu or approves its own request.",
        parameters: Type.Object(
          { reason: Type.String({ pattern: "\\S", maxLength: 2000 }) },
          { additionalProperties: false },
        ),
        replay: "safe",
        execute: async ({ reason }, api, context) => {
          await api.commit(async (tx) => {
            (await tx.doc(RestartRequest)).request = {
              reason: reason.trim(),
              requestedAt: Date.now(),
            };
          }, context);
          return {
            output: [
              {
                type: "text",
                text: "Restart requested. The user must use /restart; nothing was restarted.",
              },
            ],
          };
        },
      }),
    ],
  });
}
