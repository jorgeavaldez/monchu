import { Type, type Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FffFinders } from "./fff.ts";
import { McpClients } from "./mcp.ts";
import type { EffortAssessment } from "./classifier.ts";
import {
  loadConfig,
  loadMcpServers,
  saveRole,
  type ModelRole,
  type MonchuConfig,
  type Settings,
} from "./config.ts";
import { resolveRoles } from "./models/index.ts";

/** Reloadable modules. Static imports inside them stay cached. */
type Reloadable = {
  context: typeof import("./context.ts");
  "pi-tools": typeof import("./pi-tools.ts");
  workers: typeof import("./workers.ts");
  codemode: typeof import("./codemode.ts");
  goals: typeof import("./goals.ts");
  memory: typeof import("./memory.ts");
  identity: typeof import("./identity.ts");
  classifier: typeof import("./classifier.ts");
  jj: typeof import("./jj.ts");
  herdr: typeof import("./herdr.ts");
  "tool-search": typeof import("./tool-search.ts");
  "mcp-tools": typeof import("./mcp-tools.ts");
  browser: typeof import("./browser.ts");
};

async function freshImport<Name extends keyof Reloadable>(
  name: Name,
  version: string,
): Promise<Reloadable[Name]> {
  const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
  // oxlint-disable-next-line typescript/no-unsafe-return -- A computed specifier imports as `any`; `Reloadable` names each module's own type.
  return import(new URL(`./${name}.${suffix}?v=${version}`, import.meta.url).href);
}

type Build = {
  /** Imported modules in installation order. */
  modules: (keyof Reloadable)[];
  extensions: Extension[];
  /** Left out of the host default selection and added to the root; workers inherit them, since Durable copies the root's agent into each conversation it owns. */
  root: Extension[];
  /** Deferred tool groups: installed, left out of the host default selection, and loaded by `tool_search`. */
  groups: Extension[];
  settings: Settings;
  config: MonchuConfig;
  assessment: EffortAssessment | undefined;
  warnings: string[];
};

/** Import fresh copies of the reloadable modules and build their extensions. Nothing is installed. */
async function build(
  models: Models,
  config: MonchuConfig,
  home: string,
  reportSkipped: (warning: string) => void,
  finders: FffFinders,
  clients: McpClients,
  workerRole: () => ModelRole,
): Promise<Build> {
  resolveRoles(models, config);
  const version = randomUUID();
  const modules: (keyof Reloadable)[] = [];
  const load = <Name extends keyof Reloadable>(name: Name) => {
    modules.push(name);
    return freshImport(name, version);
  };
  const context = (await load("context")).createContext(home, config.settings);
  const tools = (await load("pi-tools")).createPiTools(context.settings, finders);
  const workers = (await load("workers")).createWorkerTools(workerRole);
  const { Codemode } = await load("codemode");
  const { Goals } = await load("goals");
  const memory = (await load("memory")).createMemory(home);
  const identity = (await load("identity")).createIdentity(home, reportSkipped);
  const { Jj } = await load("jj");
  const mcp = await (await load("mcp-tools")).createMcpTools(await loadMcpServers(home), clients);
  const { Browser } = await load("browser");
  const search = (await load("tool-search")).createToolSearch([...mcp.groups, Browser]);
  const herdr = (await load("herdr")).createHerdr({
    command: { executable: "herdr", args: [] },
    env: process.env,
  });
  const assessment =
    config.classifier === null
      ? undefined
      : (await load("classifier")).createEffortAssessment(models, config.classifier);
  return {
    modules,
    extensions: [
      context.extension,
      tools.extension,
      workers,
      Codemode,
      Goals,
      memory,
      identity,
      Jj,
      herdr,
      mcp.extension,
      search.extension,
      ...search.groups,
      ...(assessment === undefined ? [] : [assessment.extension]),
    ],
    root: [Goals, memory],
    groups: search.groups,
    settings: context.settings,
    config,
    assessment,
    warnings: [...context.warnings, ...tools.warnings, ...mcp.warnings],
  };
}

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
 * The extension registry and settings of its last successful build. Every `Reloadable` module reloads in
 * process; the backend and this loader need /restart. Config is re-read on each reload.
 */
export class Extensions {
  readonly registry: Registry;
  private readonly models: Models;
  private readonly home: string;
  private readonly finders: FffFinders;
  private readonly clients: McpClients;
  private readonly report: (warning: string) => void;
  private readonly reportSkipped: (warning: string) => void;
  private current: Build;
  private reloading: Promise<readonly string[]> | undefined;
  private saving: Promise<ModelRole> | undefined;

  private constructor(
    models: Models,
    home: string,
    report: (warning: string) => void,
    reportSkipped: (warning: string) => void,
    current: Build,
    finders: FffFinders,
    clients: McpClients,
  ) {
    this.registry = createRegistry();
    this.clients = clients;
    this.models = models;
    this.home = home;
    this.finders = finders;
    this.report = report;
    this.reportSkipped = reportSkipped;
    this.current = current;
  }

  /** Build and install every extension. `report` receives configuration warnings now and after each reload. */
  static async load(
    models: Models,
    config: MonchuConfig,
    home: string,
    report: (warning: string) => void,
  ): Promise<Extensions> {
    const skippedFiles = new Set<string>();
    const reportSkipped = (warning: string) => {
      if (skippedFiles.has(warning)) return;
      skippedFiles.add(warning);
      report(warning);
    };
    const finders = new FffFinders(home, report);
    const clients = new McpClients(home, process.env, report);
    // Worker tools run only after construction; until then nothing can call the role getter.
    let extensions: Extensions | undefined;
    const current = await build(
      models,
      config,
      home,
      reportSkipped,
      finders,
      clients,
      () => extensions?.config.worker ?? config.worker,
    );
    extensions = new Extensions(models, home, report, reportSkipped, current, finders, clients);
    installExtensions(extensions.registry, current.extensions);
    for (const warning of current.warnings) report(warning);
    return extensions;
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
    const saving = saveRole(this.home, role, change, check);
    this.saving = saving;
    try {
      const saved = await saving;
      this.current = { ...this.current, config: { ...this.current.config, [role]: saved } };
      return saved;
    } finally {
      this.saving = undefined;
    }
  }

  /** The loaded run settings. */
  get settings(): Settings {
    return this.current.settings;
  }

  get assessment(): EffortAssessment | undefined {
    return this.current.assessment;
  }

  /** Left out of the host default selection and added to the root; workers inherit them, since Durable copies the root's agent into each conversation it owns. */
  get root(): readonly Extension[] {
    return this.current.root;
  }

  /** Every installed extension except the ones only added to the root. */
  defaults(): readonly Extension[] {
    const names = new Set(this.current.extensions.map((extension) => extension.name));
    for (const extension of [...this.current.root, ...this.current.groups])
      names.delete(extension.name);
    names.add("monchu.reload");
    // Disabled classifier definitions remain installed to finish already accepted assessment tasks.
    return this.registry
      .snapshot()
      .installed()
      .filter((extension) => names.has(extension.name));
  }

  /**
   * Concurrent requests share one reload, which resolves to the reloaded modules. A failed build, import, or validation
   * leaves installed definitions and settings unchanged.
   */
  reload(applyConfig?: (config: MonchuConfig) => Promise<void>): Promise<readonly string[]> {
    this.reloading ??= (async () => {
      await this.saving?.catch(() => {});
      await buildForReload();
      const config = await loadConfig(this.home);
      if (
        config.claude.executable !== this.current.config.claude.executable ||
        config.claude.plan !== this.current.config.claude.plan ||
        config.claude.longContextExtraUsage !== this.current.config.claude.longContextExtraUsage
      )
        throw new Error("Claude Code host settings changed; use /restart to apply them");
      const next = await build(
        this.models,
        config,
        this.home,
        this.reportSkipped,
        this.finders,
        this.clients,
        () => this.config.worker,
      );
      validateExtensions(this.registry, next.extensions);
      await applyConfig?.(config);
      for (const extension of next.extensions) this.registry.install(extension);
      this.current = next;
      for (const warning of next.warnings) this.report(warning);
      return next.modules;
    })().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  /** Release host-owned search indexes and MCP servers after Durable stops its calls. */
  async close(): Promise<void> {
    await this.finders.close();
    await this.clients.close();
  }

  /** Resolves once no reload or role save is running, whether or not it succeeded. */
  async settled(): Promise<void> {
    while (this.reloading !== undefined || this.saving !== undefined)
      await Promise.allSettled([this.reloading, this.saving]);
  }
}

/** Compiled mode needs fresh JS; source mode uses Node's native type stripping. */
async function buildForReload(): Promise<void> {
  if (import.meta.url.endsWith(".ts")) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
        "-p",
        "tsconfig.build.json",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
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

/** Stored on the root; requesting a restart never executes one. */
export const RestartRequest = defineDoc<{
  request: { reason: string; requestedAt: number } | null;
}>({
  kind: "monchu.restart-request",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ request: null }),
});

export function createReloadControls(
  rootId: ConversationId,
  reload: () => Promise<readonly string[]>,
) {
  return defineExtension({
    name: "monchu.reload",
    sections: [
      section("restart_request", async (input, context) => {
        const request = (await input.read.snapshot(RestartRequest, rootId, context))?.request;
        return request === undefined || request === null
          ? undefined
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
          content: [{ type: "text", text: `Reloaded: ${(await reload()).join(", ")}` }],
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
            (await tx.doc(RestartRequest, rootId)).request = {
              reason: reason.trim(),
              requestedAt: Date.now(),
            };
          }, context);
          return {
            content: [
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
