/**
 * Plugins: folders of code that add tools, prompt sections and event handlers, in the shape of Pi's extensions (see
 * `src/plugin.ts` for the API and `docs/plugins.md`). Bundled plugins ship in `src/plugins/`; home plugins live in
 * `<home>/plugins/` (synced) and `<home>/plugins/local/` (this device only). `<home>/plugins.local.json` turns plugins
 * off on this device.
 *
 * Each plugin loads on its own: one that fails to import, run or validate is skipped with a warning, or keeps its last
 * good code, and the rest load. Its event handlers are guarded, so a throw is reported and ignored. A reload imports a
 * fresh copy of a plugin's files only when one of them changed, and resolves its imports of Monchu's own packages to
 * the copies Monchu runs. Plugins are trusted code in Monchu's process, not a sandbox.
 */
import { isJsonValue, type Context, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  GenerationTask,
  ToolTask,
  section,
  type AnyTask,
  type ConversationId,
  type Extension,
  type Harness,
  type PromptSection,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { homedir, hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shortId } from "../api/ids.ts";
import { noticeText, systemNoticeText } from "../api/notices.ts";
import {
  PLUGIN_API_VERSION,
  type AfterAdmission,
  type FrontReplyEvent,
  type InputChangeEvent,
  type InputEvent,
  type Plugin,
  type PluginApi,
  type PluginCommand,
  type PluginContext,
  type PluginEvents,
  type PluginTool,
  type PluginUI,
  type SecretStore,
  type ToolExposure,
  type ToolNamespace,
} from "../plugin.ts";
import { GoalsDoc } from "./agents/goals.ts";
import { closeAsk, labelItem, openAsk } from "./inbox.ts";
import { messageWorker, parentOf, reopenWorker, rootOf, WorkersDoc } from "./agents/workers.ts";
import { replaceFile, type MonchuConfig } from "./config.ts";
import { RELOAD_TOOLS } from "./build.ts";
import { durableHooks, durableTool, rootUi, type Guard } from "./plugin-shapes.ts";
import { fillPlaceholders, redacting } from "./secrets/tool.ts";
import type { Vault } from "./secrets/vault.ts";
import { PLUGIN_PREFIX, type ToolGroup } from "./tools/tool-search.ts";

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SETUP_TIMEOUT_MS = 10_000;
/** How long a plugin's `input` handler may hold a message before it goes to the front without that plugin. */
const INPUT_TIMEOUT_MS = 5_000;
/**
 * This device's plugin file, gitignored: `{ "disabled": ["name", ...], "settings": { "name": ... } }`. A plugin's
 * settings are `plugins.<name>` in the synced `config.json`, with this device's `settings.<name>` over them.
 */
const LOCAL_FILE = "plugins.local.json";

/** The device file's parts; throws for any other shape. */
function parseLocal(value: unknown): {
  disabled: ReadonlySet<string>;
  settings: Record<string, JsonValue>;
} {
  const shape = 'expected { "disabled": ["plugin", ...], "settings": { "plugin": ... } }';
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(shape);
  const list: unknown = Reflect.get(value, "disabled") ?? [];
  const settings: unknown = Reflect.get(value, "settings") ?? {};
  if (
    Object.keys(value).some((key) => key !== "disabled" && key !== "settings") ||
    !Array.isArray(list) ||
    !list.every((name) => typeof name === "string") ||
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings) ||
    !isJsonValue(settings)
  )
    throw new Error(shape);
  return {
    disabled: new Set(list.filter((name): name is string => typeof name === "string")),
    settings: Object.fromEntries(
      Object.entries(settings).flatMap(([name, item]) => (isJsonValue(item) ? [[name, item]] : [])),
    ),
  };
}

/** Save a plugin's settings in this device's `plugins.local.json` (`undefined` removes them), keeping the rest. */
export async function saveDeviceSettings(
  home: string,
  name: string,
  value: JsonValue | undefined,
): Promise<void> {
  const path = join(home, LOCAL_FILE);
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const current = parseLocal(raw);
  const settings = { ...current.settings };
  if (value === undefined) delete settings[name];
  else settings[name] = value;
  await replaceFile(path, {
    ...(current.disabled.size === 0 ? {} : { disabled: [...current.disabled] }),
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  });
}

/**
 * The home's models as a plugin sees them while its providers wait for `settle`: catalog lookups see its own providers
 * too, and calls go to the home's models, which have them once the plugin's build runs.
 */
function overlay(
  models: MutableModels,
  own: () => ReadonlyMap<string, Provider> | undefined,
): PluginApi["models"] {
  const catalog = () => {
    const mine = own();
    if (mine === undefined || mine.size === 0) return models;
    const view = createModels();
    for (const provider of models.getProviders()) view.setProvider(provider);
    for (const provider of mine.values())
      if (models.getProvider(provider.id) === undefined) view.setProvider(provider);
    return view;
  };
  return {
    getProviders: () => catalog().getProviders(),
    getProvider: (id) => catalog().getProvider(id),
    getModel: (provider, id) => catalog().getModel(provider, id),
    getModels: (provider) => catalog().getModels(provider),
    getModelOfType: (type, provider, id) => catalog().getModelOfType(type, provider, id),
    getModelsOfType: (type, provider) => catalog().getModelsOfType(type, provider),
    checkAuth: (...args) => models.checkAuth(...args),
    getAvailable: (...args) => models.getAvailable(...args),
    getAvailableOfType: (...args) => models.getAvailableOfType(...args),
    complete: (...args) => models.complete(...args),
    completeSimple: (...args) => models.completeSimple(...args),
    classify: (...args) => models.classify(...args),
  };
}

/** A plugin's settings: the synced ones, with this device's over them (field by field when both are objects). */
function settingsOf(
  synced: JsonValue | undefined,
  device: { readonly value: JsonValue } | undefined,
): JsonValue | undefined {
  if (device === undefined) return synced;
  const object = (value: JsonValue | undefined) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  const base = object(synced);
  const over = object(device.value);
  // Any device value replaces the synced one, `null` included: that is how one device turns a plugin's setting off.
  return base !== undefined && over !== undefined ? { ...base, ...over } : device.value;
}

type PluginSource = "bundled" | "home" | "local";

/**
 * Bundled plugins in the order their tools reach every conversation: the order they shipped in, each new one last.
 * Durable redeclares every tool when their order changes, so a new bundled plugin, or one moved out of the core in the
 * core's old place, never reorders the tools conversations already have.
 */
const BUNDLED_ORDER = ["classifier", "fnox", "jj", "herdr", "browser", "keys"];

function bundledPlace(plugin: { source: PluginSource; name: string }): number {
  const place = BUNDLED_ORDER.indexOf(plugin.name);
  return plugin.source !== "bundled" || place === -1 ? BUNDLED_ORDER.length : place;
}

/** A plugin's slash command, with the plugin that registered it. */
export type PluginCommandEntry = PluginCommand & { readonly name: string; readonly plugin: string };

/** A provider a plugin added, as `/login` offers it. */
type PluginLogin = {
  readonly id: string;
  readonly label: string;
  readonly auth: "oauth" | "api_key";
  readonly plugin: string;
};

/** An optional login a plugin works with, and what it turns on. */
type PluginWant = { readonly provider: string; readonly purpose: string };

/** The plugins' `input` and `input_change` handlers for a front, guarded like the rest. */
type FrontEvents = {
  /**
   * Every plugin's `input`, in order, before admission: the text after any `transform`, `undefined` once one handled
   * it, and the `admitted` functions to run after admission, each in its own commit.
   */
  input(
    event: Omit<InputEvent, "type">,
    front: ConversationId,
  ): Promise<{ text: string | undefined; admitted: AfterAdmission[] }>;
  /** Whether any plugin follows queue changes, so the caller reads the front's context only then. */
  readonly changes: boolean;
  change(event: Omit<InputChangeEvent, "type">, tx: Tx, front: ConversationId): Promise<void>;
  /** Every plugin's `front_reply`, inside the commit that adds the message to the inbox. */
  reply(event: Omit<FrontReplyEvent, "type">, tx: Tx, front: ConversationId): Promise<void>;
};

export type PluginStatus = {
  readonly name: string;
  readonly source: PluginSource;
  /** `kept`: the new code failed, so the last good code still runs. */
  readonly state: "loaded" | "kept" | "failed" | "disabled";
  readonly error?: string;
};

/** A running plugin function's lifetime: retired when a later build replaces it, or at close. */
type Instance = {
  readonly controller: AbortController;
  readonly shutdown: ((reason: "reload" | "quit") => unknown)[];
};

type Found = {
  readonly name: string;
  readonly source: PluginSource;
  readonly dir: string;
  readonly entry: string;
};

/** One plugin's part of a build. */
type Contribution = {
  readonly found: Found;
  /** Handlers and direct tools; absent when the plugin has none. */
  readonly extension: Extension | undefined;
  readonly sections: readonly PromptSection[];
  readonly groups: ToolGroup[];
  readonly tools: readonly string[];
  readonly commands: readonly PluginCommandEntry[];
  /** Whether it ships a page module for the web client. */
  readonly page: boolean;
  readonly providers: readonly { readonly provider: Provider; readonly login: PluginLogin }[];
  readonly wants: readonly PluginWant[];
  /** The secret store it registered. */
  readonly secrets: SecretStore | undefined;
  readonly input: readonly PluginEvents["input"][];
  readonly inputChange: readonly PluginEvents["input_change"][];
  readonly frontReply: readonly PluginEvents["front_reply"][];
  readonly guard: Guard;
  readonly ui: (id: ConversationId, context: Context) => PluginUI;
  readonly skills: string | undefined;
  readonly instance: Instance;
};

/** What `Plugins.load` read, before it is checked against the core's tool names. */
type PluginLoad = {
  /** Skill folders shipped by the loaded plugins, read like home skills. */
  readonly skills: readonly string[];
  /**
   * Drop plugins whose tool or task names collide with `reserved` or an earlier plugin, and assemble the build's parts:
   * a taken task name would keep the whole build from installing, and Monchu from starting.
   */
  use(reserved: { tools: ReadonlySet<string>; tasks: ReadonlySet<string> }): PluginBuild;
};

export type PluginBuild = {
  /** Bundled plugins' extensions: part of Monchu's own default selection. */
  readonly bundled: Extension[];
  /** Home plugins' extensions, which every conversation selects by appending them to its own selection. */
  readonly attached: Extension[];
  readonly groups: ToolGroup[];
  /** Every plugin's sections, which the `plugins` section renders. */
  readonly sections: readonly PromptSection[];
  /** Slash commands by name; an earlier plugin's wins a clash. */
  readonly commands: readonly PluginCommandEntry[];
  /** Plugins whose page module the web client loads. */
  readonly pages: readonly string[];
  /** Providers the plugins added, which `/login` offers after Monchu's own. */
  readonly logins: readonly PluginLogin[];
  readonly wants: readonly PluginWant[];
  /** The one store a plugin keeps secret values in, which the vault uses while this build runs. */
  readonly secrets: SecretStore | undefined;
  readonly front: FrontEvents;
  readonly status: readonly PluginStatus[];
  readonly warnings: readonly string[];
  readonly instances: ReadonlySet<Instance>;
};

/** One line naming the plugins by state, or nothing without plugins. */
export function formatPluginStatus(status: readonly PluginStatus[]): string {
  const names = (state: PluginStatus["state"]) =>
    status
      .filter((plugin) => plugin.state === state)
      .map((plugin) =>
        plugin.error === undefined ? plugin.name : `${plugin.name} (${plugin.error})`,
      );
  const parts = [
    ["Plugins", names("loaded")],
    ["kept on last good code", names("kept")],
    ["not loaded", names("failed")],
    ["disabled", names("disabled")],
  ] as const;
  const shown = parts.filter(([, list]) => list.length > 0);
  return shown.map(([label, list]) => `${label}: ${list.join(", ")}`).join("; ");
}

/** Task names plugins may not take: Durable's built-in tasks and those of `extensions`. */
export function reservedTasks(extensions: readonly Extension[]): ReadonlySet<string> {
  return new Set(
    [
      GenerationTask,
      ToolTask,
      CompactionTask,
      ...extensions.flatMap((each) => each.tasks ?? []),
    ].map((task) => task.definition.name),
  );
}

/**
 * Every plugin's sections as one section, `plugins`. Each section a conversation already shows is patched in place, but
 * one added before another re-sends every section after it, and the agent's instructions always come last. So plugins
 * share this one: a plugin adding, changing or dropping a section patches only it. It stays away until a plugin has a
 * section, then keeps a placeholder, so a conversation pays the one re-send at most once.
 */
export function createPluginSections(sections: readonly PromptSection[]): Extension {
  return defineExtension({
    name: "monchu.plugin-sections",
    sections: [
      section(
        "plugins",
        async (input, context) => {
          const parts: string[] = [];
          for (const entry of sections) {
            const text = await entry.render(input, context);
            if (text !== undefined)
              parts.push(entry.tag === false ? text : `<${entry.key}>\n${text}\n</${entry.key}>`);
          }
          if (parts.length) return parts.join("\n\n");
          return input.shown.plugins === undefined ? undefined : "No plugin sections.";
        },
        { tag: false },
      ),
    ],
  });
}

const PARAM = "monchu-plugin";
/** Plugin folder URLs (trailing slash): their files take the reload query, and their host imports Monchu's copies. */
const roots = new Set<string>();
/** Each plugin folder's name, by its URL and its path, as an error's stack names its files. */
const folders = new Map<string, string>();
/** The core's `Plugins`, which tell a fault: one while the core is open. */
const tellers = new Set<Plugins>();

/**
 * Whether `error`, thrown or rejected where nothing catches it, came from a plugin's own code (its timers, its
 * callbacks, a promise it dropped): the topmost stack frame in a plugin's folder names it. That plugin's fault is told
 * once per message and Monchu runs on, since one plugin's bug must not stop the core on every device the home syncs
 * to. Anything else is Monchu's own failure, and the caller lets it stop the process as before.
 */
export function containPluginFault(error: unknown): boolean {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  let found: { at: number; name: string } | undefined;
  for (const [folder, name] of folders) {
    const at = stack.indexOf(folder);
    if (at >= 0 && (found === undefined || at < found.at)) found = { at, name };
  }
  if (found === undefined) return false;
  for (const plugins of tellers) plugins.fault(found.name, message(error));
  return true;
}
let hooked = false;
let generation = 0;
const PLUGIN_MODULE = new URL(
  `../plugin.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
  import.meta.url,
).href;
/** Bare imports a plugin gets from Monchu itself, so there is one copy of each, whatever the plugin installed. */
const HOST = /^(?:@earendil-works\/(?:pi-durable|pi-ai|chord)|typebox)(?:\/|$)/;

/**
 * As Chord's loader does for facets: a query on the entry URL re-imports only the entry, so the hook carries it to the
 * plugin's own files (never its `node_modules`). It also points `monchu/plugin` and the host packages at Monchu's own.
 */
function installResolveHook(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const root =
        parent === undefined ? undefined : [...roots].find((dir) => parent.startsWith(dir));
      if (parent === undefined || root === undefined) return nextResolve(specifier, context);
      if (specifier === "monchu/plugin")
        return nextResolve(PLUGIN_MODULE, { ...context, parentURL: import.meta.url });
      if (HOST.test(specifier))
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      const result = nextResolve(specifier, context);
      const version = new URL(parent).searchParams.get(PARAM);
      if (version === null || !result.url.startsWith(root)) return result;
      const url = new URL(result.url);
      if (
        url.searchParams.has(PARAM) ||
        url.href.slice(root.length).split("/").includes("node_modules")
      )
        return result;
      url.searchParams.set(PARAM, version);
      return { ...result, url: url.href };
    },
  });
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A parse error's location is only in the first line of its stack.
  const where = error instanceof SyntaxError ? error.stack?.split("\n", 1)[0] : undefined;
  return where === undefined || where.startsWith("SyntaxError")
    ? error.message
    : `${where}: ${error.message}`;
}

/** Sizes and times of a plugin's files, outside `node_modules` and dot folders: a change means a fresh import. */
async function fingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) await walk(child);
      } else if (entry.isFile()) {
        const info = await stat(child);
        parts.push(`${child.slice(dir.length)}\0${info.size}\0${info.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return parts.sort().join("\n");
}

async function importFresh(found: Found): Promise<Plugin> {
  installResolveHook();
  const folder = pathToFileURL(join(found.dir, "/")).href;
  roots.add(folder);
  folders.set(folder, found.name);
  folders.set(join(found.dir, "/"), found.name);
  const url = pathToFileURL(found.entry);
  url.searchParams.set(PARAM, String(++generation));
  const loaded: unknown = await import(url.href);
  const plugin: unknown =
    typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (typeof plugin !== "function")
    throw new TypeError("its default export must be a function that receives the plugin API");
  return (api) => {
    const result: unknown = Reflect.apply(plugin, undefined, [api]);
    return result instanceof Promise ? result.then(() => {}) : undefined;
  };
}

function device(): PluginApi["device"] {
  let user = process.env.USER ?? process.env.USERNAME ?? "";
  try {
    user = userInfo().username;
  } catch {
    // Some platforms have no passwd entry for the user; the environment's name stands in.
  }
  return { hostname: hostname(), platform: process.platform, arch: process.arch, user };
}

async function withTimeout<T>(
  work: T | Promise<T>,
  ms: number,
  what = "it did not finish",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The plugins this home and this copy of Monchu hold, and the modules they last loaded. Lives as long as the core. */
/**
 * Whether a tool call is part of Monchu's way to fix a broken plugin: a reload, or reading, writing or editing a home
 * plugin's files or the device's deny list by absolute path. A plugin's handler that throws can't block these.
 */
function repairs(home: string, toolName: string, input: Record<string, unknown>): boolean {
  if (RELOAD_TOOLS.includes(toolName)) return true;
  if (!["read", "write", "edit"].includes(toolName) || typeof input.path !== "string") return false;
  const raw = input.path.startsWith("~/") ? join(homedir(), input.path.slice(2)) : input.path;
  if (!isAbsolute(raw)) return false;
  const path = resolve(raw);
  const plugins = join(resolve(home), "plugins");
  return path === join(resolve(home), LOCAL_FILE) || path.startsWith(plugins + sep);
}

export class Plugins {
  private readonly home: string;
  private readonly report: (warning: string) => void;
  private readonly vault: Vault;
  private readonly models: MutableModels;
  private readonly saveSettings: (
    name: string,
    value: JsonValue | undefined,
    where: "home" | "device",
  ) => Promise<void>;
  /** Providers Monchu itself sets, which no plugin may replace. */
  private readonly own: ReadonlySet<string>;
  /** Providers each live instance set, with its plugin's name. */
  private readonly provided = new Map<
    Instance,
    { readonly plugin: string; readonly providers: Map<string, Provider> }
  >();
  /** Provider ids plugins set in the home's models. */
  private readonly set = new Set<string>();
  private readonly bundledDir: string;
  /** The last import of each plugin folder, by entry path, with the fingerprint it was made from. */
  private readonly modules = new Map<string, { fingerprint: string; plugin: Plugin | Error }>();
  /** The last plugin function that ran without failing, by entry path. */
  private readonly good = new Map<string, Plugin>();
  private readonly live = new Set<Instance>();
  /** Bundled folders without code, already told. */
  private readonly leftovers = new Set<string>();
  /** Live instances whose build ran: only these get `session_shutdown`. */
  private readonly ran = new Set<Instance>();
  private readonly onFault: (summary: string, text: string) => void;
  /** Faults since each plugin's code last changed, by plugin: only the first is told. */
  private readonly faults = new Map<string, number>();
  /** The home's store, once open: `ctx.ui` writes to it. */
  private harness: Harness | undefined;

  /** Safe mode: no home plugin runs, since a core with them failed (see `src/server/process.ts`). */
  private readonly safe: boolean;

  constructor(options: {
    home: string;
    report: (warning: string) => void;
    vault: Vault;
    /** The home's models: plugins read them and add providers to them. */
    models: MutableModels;
    /** Writes a plugin's settings to `config.json`. */
    saveSettings: (
      name: string,
      value: JsonValue | undefined,
      where: "home" | "device",
    ) => Promise<void>;
    /** A plugin's fault for the front, beyond the warning every client shows. */
    onFault?: (summary: string, text: string) => void;
    bundledDir?: string;
    safe?: boolean;
  }) {
    this.home = options.home;
    this.report = options.report;
    this.vault = options.vault;
    this.models = options.models;
    this.saveSettings = options.saveSettings;
    this.onFault = options.onFault ?? (() => {});
    this.own = new Set(options.models.getProviders().map((provider) => provider.id));
    this.bundledDir = options.bundledDir ?? fileURLToPath(new URL("../plugins/", import.meta.url));
    this.safe = options.safe ?? false;
    tellers.add(this);
  }

  /**
   * Tell a plugin's uncaught failure (see `containPluginFault`): only its first until its code changes, since a failing
   * timer fails again with every tick, and each notice costs the front a turn.
   */
  fault(name: string, error: string): void {
    const count = (this.faults.get(name) ?? 0) + 1;
    this.faults.set(name, count);
    if (count > 1) return;
    const text = `Plugin ${name} threw where nothing catches it (its own timer, callback or promise), and Monchu kept running: ${error}. Fix it, or turn it off in plugins.local.json. Its later failures aren't told until its code changes.`;
    this.report(text);
    this.onFault(`Plugin ${name} failed`, text);
  }

  /** Give `ctx.ui` the home's store, once it is open. */
  bind(harness: Harness): void {
    this.harness = harness;
  }

  /**
   * Find, import and run every enabled plugin with `config`. Never throws for a plugin's fault. A `dry` load (the home
   * check's) changes nothing a build relies on: what plugins report is in its warnings, not told, and a plugin that runs
   * doesn't become its last good code.
   */
  async load(config: MonchuConfig, options: { dry?: boolean } = {}): Promise<PluginLoad> {
    const dry = options.dry === true;
    const warnings: string[] = [];
    const status: PluginStatus[] = [];
    const found = new Map<string, Found>();
    const bundled = await this.discover(this.bundledDir, "bundled", warnings);
    const home = await this.discover(join(this.home, "plugins"), "home", warnings);
    const own = await this.discover(join(this.home, "plugins", "local"), "local", warnings);
    // A device's own plugin replaces a synced one of the same name, which replaces a bundled one.
    for (const plugin of [...bundled, ...home, ...own]) found.set(plugin.name, plugin);
    const device = await this.local(warnings);
    const disabled = this.safe ? "all" : device.disabled;
    const contributions: Contribution[] = [];
    const instances = new Set<Instance>();
    const ordered = [...found.values()].sort(
      (left, right) =>
        Number(left.source !== "bundled") - Number(right.source !== "bundled") ||
        bundledPlace(left) - bundledPlace(right) ||
        left.name.localeCompare(right.name),
    );
    for (const plugin of ordered) {
      if (disabled === "all" ? plugin.source !== "bundled" : disabled.has(plugin.name)) {
        status.push({
          name: plugin.name,
          source: plugin.source,
          state: "disabled",
          ...(this.safe ? { error: "safe mode" } : {}),
        });
        continue;
      }
      const loaded = await this.loadOne(
        plugin,
        config,
        settingsOf(
          config.plugins[plugin.name],
          Object.hasOwn(device.settings, plugin.name)
            ? { value: device.settings[plugin.name] ?? null }
            : undefined,
        ),
        dry,
        dry ? (warning) => warnings.push(warning) : this.report,
      );
      if ("error" in loaded) {
        const kept = loaded.contribution !== undefined || loaded.keeps === true;
        warnings.push(
          kept
            ? `Plugin ${plugin.name} failed to load and keeps its last good code: ${loaded.error} (${plugin.entry})`
            : `Plugin ${plugin.name} was not loaded: ${loaded.error} (${plugin.entry})`,
        );
        status.push({
          name: plugin.name,
          source: plugin.source,
          state: kept ? "kept" : "failed",
          error: loaded.error,
        });
        if (loaded.contribution === undefined) continue;
        contributions.push(loaded.contribution);
      } else {
        status.push({ name: plugin.name, source: plugin.source, state: "loaded" });
        contributions.push(loaded.contribution);
      }
    }
    for (const contribution of contributions) instances.add(contribution.instance);
    return {
      skills: contributions.flatMap((contribution) => contribution.skills ?? []),
      use: (reserved) => {
        const taken = new Map([...reserved.tools].map((name) => [name, "Monchu"]));
        const tasks = new Map([...reserved.tasks].map((name) => [name, "Monchu"]));
        const used: Contribution[] = [];
        let secrets: Contribution | undefined;
        for (const contribution of contributions) {
          const names = (contribution.extension?.tasks ?? []).map((task) => task.definition.name);
          const tool = contribution.tools.find((name) => taken.has(name));
          const task = names.find((name) => tasks.has(name));
          const clash =
            tool !== undefined
              ? { kind: "tool", name: tool, owner: taken.get(tool) }
              : task !== undefined
                ? { kind: "task", name: task, owner: tasks.get(task) }
                : undefined;
          const keeper = contribution.secrets === undefined ? undefined : secrets?.found.name;
          if (clash !== undefined || keeper !== undefined) {
            const error =
              clash !== undefined
                ? `${clash.kind} ${clash.name} is already defined by ${clash.owner === "Monchu" ? "Monchu" : `plugin ${clash.owner}`}`
                : `plugin ${keeper ?? ""} already keeps the secrets; turn one of them off in plugins.local.json`;
            warnings.push(`Plugin ${contribution.found.name} was not loaded: ${error}`);
            const at = status.findIndex((entry) => entry.name === contribution.found.name);
            status[at] = {
              name: contribution.found.name,
              source: contribution.found.source,
              state: "failed",
              error,
            };
            instances.delete(contribution.instance);
            this.retire(contribution.instance);
            continue;
          }
          for (const name of contribution.tools) taken.set(name, contribution.found.name);
          for (const name of names) tasks.set(name, contribution.found.name);
          if (contribution.secrets !== undefined) secrets = contribution;
          used.push(contribution);
        }
        return {
          bundled: used.flatMap((contribution) =>
            contribution.found.source === "bundled" && contribution.extension !== undefined
              ? [contribution.extension]
              : [],
          ),
          attached: used.flatMap((contribution) =>
            contribution.found.source !== "bundled" && contribution.extension !== undefined
              ? [contribution.extension]
              : [],
          ),
          groups: used.flatMap((contribution) => contribution.groups),
          sections: used.flatMap((contribution) => contribution.sections),
          commands: used
            .flatMap((contribution) => contribution.commands)
            .filter((entry, index, all) => {
              const first = all.findIndex((other) => other.name === entry.name);
              if (first !== index)
                warnings.push(
                  `Plugin ${entry.plugin}'s command /${entry.name} is left out: plugin ${all[first]?.plugin ?? ""} has one`,
                );
              return first === index;
            }),
          pages: used.flatMap((contribution) =>
            contribution.page ? [contribution.found.name] : [],
          ),
          logins: used.flatMap((contribution) =>
            contribution.providers.map((entry) => entry.login),
          ),
          wants: used.flatMap((contribution) => contribution.wants),
          secrets: secrets?.secrets,
          front: frontEvents(used),
          status,
          warnings,
          instances,
        };
      },
    };
  }

  /**
   * Retire every instance a build that is no longer running made: after a publication, or a failed reload. Providers
   * follow the running build: its plugins' are set again, and the rest leave the home's models.
   */
  settle(running: PluginBuild | undefined, reason: "reload" | "quit" = "reload"): void {
    for (const instance of this.live)
      if (!running?.instances.has(instance)) this.retire(instance, reason);
    for (const instance of running?.instances ?? []) this.ran.add(instance);
    const wanted = new Map<string, Provider>();
    for (const [instance, { providers }] of this.provided) {
      if (!this.live.has(instance)) this.provided.delete(instance);
      else for (const [id, provider] of providers) wanted.set(id, provider);
    }
    for (const id of this.set)
      if (!wanted.has(id)) {
        this.set.delete(id);
        this.models.deleteProvider(id);
      }
    for (const [id, provider] of wanted) {
      this.set.add(id);
      this.models.setProvider(provider);
    }
    this.vault.useStore(running?.secrets);
  }

  close(): void {
    tellers.delete(this);
    this.settle(undefined, "quit");
  }

  private retire(instance: Instance, reason: "reload" | "quit" = "reload"): void {
    if (!this.live.delete(instance)) return;
    instance.controller.abort(new Error("Plugin retired"));
    // Only a copy that ran shuts down: the home check's copy, or a failed reload's, never served, and its module state
    // is the running copy's.
    if (!this.ran.delete(instance)) return;
    for (const shutdown of instance.shutdown) {
      void (async () => shutdown(reason))().catch((error: unknown) =>
        this.report(`A plugin's session_shutdown handler failed: ${message(error)}`),
      );
    }
  }

  private async discover(dir: string, source: PluginSource, warnings: string[]): Promise<Found[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      warnings.push(`Plugins in ${dir} were not read: ${message(error)}`);
      return [];
    }
    const found: Found[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      if (source === "home" && entry.name === "local") continue;
      const folder = join(dir, entry.name);
      if (!NAME.test(entry.name)) {
        warnings.push(
          `Plugin folder ${folder} was skipped: a plugin's name is lowercase letters, digits and dashes`,
        );
        continue;
      }
      const index = ["index.ts", "index.js"]
        .map((file) => join(folder, file))
        .find((file) => existsSync(file));
      if (index === undefined) {
        const warning = `Plugin ${entry.name} was skipped: ${folder} has no index.ts or index.js`;
        // A bundled folder without code is the install's leftover, not the home's problem: the home check never
        // blames it on a conversation, and it is told once.
        if (source !== "bundled") warnings.push(warning);
        else if (!this.leftovers.has(folder)) {
          this.leftovers.add(folder);
          this.report(warning);
        }
        continue;
      }
      found.push({ name: entry.name, source, dir: folder, entry: index });
    }
    return found;
  }

  /**
   * This device's plugin file: the names it turned off (`all` home plugins when the file can't be read: it fails
   * closed) and its own plugin settings, which override the synced ones.
   */
  private async local(
    warnings: string[],
  ): Promise<{ disabled: ReadonlySet<string> | "all"; settings: Record<string, JsonValue> }> {
    const path = join(this.home, LOCAL_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { disabled: new Set(), settings: {} };
      warnings.push(`${path} could not be read, so no home plugin loads: ${message(error)}`);
      return { disabled: "all", settings: {} };
    }
    try {
      return parseLocal(JSON.parse(text));
    } catch (error) {
      warnings.push(`${path} is invalid, so no home plugin loads: ${message(error)}`);
      return { disabled: "all", settings: {} };
    }
  }

  /** Import (when its files changed) and run one plugin; on failure, run its last good code instead. */
  private async loadOne(
    found: Found,
    config: MonchuConfig,
    settings: JsonValue | undefined,
    /** A dry load keeps the last good code as it is. */
    dry: boolean,
    /** Where the plugin's reports go: a dry load's are its warnings. */
    sink: (warning: string) => void,
  ): Promise<
    | { contribution: Contribution }
    /** `keeps`: a dry load's failure that a build would answer with the last good code. */
    | { error: string; contribution?: Contribution; keeps?: boolean }
  > {
    let error: string;
    try {
      // A plugin that says which API versions it works with loads only on a Monchu that has one, before any import.
      const apis = await packageApis(found.dir);
      if (apis !== undefined && !apis.includes(PLUGIN_API_VERSION))
        return {
          error: `it works with plugin API ${apis.join(" or ")}; this Monchu has ${PLUGIN_API_VERSION}${Math.max(...apis) > PLUGIN_API_VERSION ? " (monchu update brings a newer one)" : ""}`,
        };
      const print = await fingerprint(found.dir);
      let cached = this.modules.get(found.entry);
      if (cached?.fingerprint !== print) {
        // A module that never finishes loading must not hold up the build, and Monchu's start with it.
        const plugin = await withTimeout(
          importFresh(found),
          SETUP_TIMEOUT_MS,
          "its module did not finish loading",
        ).catch((failure: unknown) =>
          failure instanceof Error ? failure : new Error(String(failure)),
        );
        cached = { fingerprint: print, plugin };
        this.modules.set(found.entry, cached);
        // New code: its first failure is told again.
        this.faults.delete(found.name);
      }
      if (cached.plugin instanceof Error) throw cached.plugin;
      const contribution = await this.run(found, cached.plugin, config, settings, sink);
      if (!dry) this.good.set(found.entry, cached.plugin);
      return { contribution };
    } catch (failure) {
      error = message(failure);
    }
    const good = this.good.get(found.entry);
    // A dry load only says what a build would do: it runs no other code.
    if (dry)
      return { error, keeps: good !== undefined && good !== this.modules.get(found.entry)?.plugin };
    if (good === undefined || good === this.modules.get(found.entry)?.plugin) return { error };
    try {
      return { error, contribution: await this.run(found, good, config, settings, sink) };
    } catch {
      return { error };
    }
  }

  /** Run a plugin's function and turn what it registered into a guarded extension and tool groups. */
  private async run(
    found: Found,
    plugin: Plugin,
    config: MonchuConfig,
    settings: JsonValue | undefined,
    sink: (warning: string) => void,
  ): Promise<Contribution> {
    const instance: Instance = { controller: new AbortController(), shutdown: [] };
    this.live.add(instance);
    const tools: { tool: ToolRegistration; exposure: ToolExposure; namespace?: ToolNamespace }[] =
      [];
    const sections: PromptSection[] = [];
    const tasks: AnyTask[] = [];
    const commands: PluginCommandEntry[] = [];
    let page = false;
    const providers: { provider: Provider; login: PluginLogin }[] = [];
    const wants: PluginWant[] = [];
    let secrets: SecretStore | undefined;
    const handlers: { [E in keyof PluginEvents]: PluginEvents[E][] } = {
      tool_call: [],
      tool_result: [],
      context: [],
      message_end: [],
      turn_end: [],
      agent_before_settle: [],
      session_before_compact: [],
      session_shutdown: [],
      input: [],
      input_change: [],
      front_reply: [],
    };
    let open = true;
    const opened = () => {
      if (!open) throw new Error("Plugins register only while their function runs");
    };
    const reported = new Set<string>();
    const report = (warning: string) => sink(`Plugin ${found.name}: ${warning}`);
    /** A handler's failure, told once per instance and event; the caller decides what a failure means. */
    const guard: Guard = async (event, run) => {
      try {
        return await run();
      } catch (error) {
        if (!reported.has(event)) {
          reported.add(event);
          report(`its ${event} handler failed: ${message(error)}`);
        }
        return "failed";
      }
    };
    const ui = (id: ConversationId, context: Context): PluginUI =>
      rootUi(() => this.harness, report, id, context);
    const redacted = new WeakSet<PluginTool>();
    const vault = this.vault;
    const api: PluginApi = {
      apiVersion: PLUGIN_API_VERSION,
      name: found.name,
      dir: found.dir,
      home: this.home,
      device: device(),
      signal: instance.controller.signal,
      report,
      config: settings,
      saveConfig: (value, options) =>
        this.saveSettings(found.name, value, options?.device === true ? "device" : "home"),
      models: overlay(this.models, () => this.provided.get(instance)?.providers),
      secrets: {
        ...pluginSecrets(vault),
        redacting: (tool) => {
          redacted.add(tool);
          return tool;
        },
      },
      agents: agents(config),
      ui: (id) => ui(id, BACKGROUND_CONTEXT),
      registerTool: (tool) => {
        opened();
        const exposure = tool.exposure ?? "deferred";
        if (!["deferred", "direct", "codemode"].includes(exposure))
          throw new Error(`tool ${tool.name}: unknown exposure ${String(exposure)}`);
        if (!TOOL_NAME.test(tool.name))
          throw new Error(`tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME.source}`);
        if (typeof tool.execute !== "function")
          throw new Error(`tool ${tool.name} has no execute function`);
        if (tools.some((entry) => entry.tool.name === tool.name))
          throw new Error(`two tools are named ${tool.name}`);
        const durable = durableTool(tool, ui);
        tools.push({
          tool: redacted.has(tool) ? redacting(durable, vault) : durable,
          exposure,
          ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        });
      },
      registerSection: (key, render, options) => {
        opened();
        const name = `${found.name}_${key}`;
        if (!SECTION_KEY.test(name))
          throw new Error(`section key ${JSON.stringify(key)} must match ${SECTION_KEY.source}`);
        if (sections.some((entry) => entry.key === name))
          throw new Error(`two sections are keyed ${key}`);
        sections.push({
          key: name,
          tag: options?.tag ?? true,
          render: async (input, context) => {
            const text = await guard(`section ${key}`, () => render(input, context));
            return text === "failed" ? undefined : text?.trim() || undefined;
          },
        });
      },
      on: (event, handler) => {
        opened();
        if (!Object.hasOwn(handlers, event)) throw new Error(`unknown event ${String(event)}`);
        handlers[event].push(handler);
      },
      registerTask: (task) => {
        opened();
        if (tasks.some((entry) => entry.definition.name === task.definition.name))
          throw new Error(`two tasks are named ${task.definition.name}`);
        tasks.push(task);
      },
      registerCommand: (name, command) => {
        opened();
        if (!COMMAND_NAME.test(name))
          throw new Error(`command name ${JSON.stringify(name)} must match ${COMMAND_NAME.source}`);
        if (typeof command.handler !== "function")
          throw new Error(`command /${name} has no handler function`);
        if (commands.some((entry) => entry.name === name))
          throw new Error(`two commands are named /${name}`);
        commands.push({
          name,
          plugin: found.name,
          ...(command.description === undefined
            ? {}
            : { description: String(command.description) }),
          ...(command.usage === undefined ? {} : { usage: String(command.usage) }),
          handler: (args, ctx) => command.handler(args, ctx),
        });
      },
      registerPage: () => {
        opened();
        // Built with the web client, so only a plugin that ships with Monchu has one for now.
        if (found.source !== "bundled")
          throw new Error("only plugins bundled with Monchu have page modules for now");
        page = true;
      },
      registerProvider: (provider) => {
        opened();
        if (this.own.has(provider.id)) throw new Error(`provider ${provider.id} is Monchu's own`);
        for (const [other, entry] of this.provided)
          if (
            this.live.has(other) &&
            entry.plugin !== found.name &&
            entry.providers.has(provider.id)
          )
            throw new Error(`plugin ${entry.plugin} already adds provider ${provider.id}`);
        if (providers.some((entry) => entry.provider.id === provider.id))
          throw new Error(`two providers are named ${provider.id}`);
        providers.push({
          provider,
          login: {
            id: provider.id,
            label: provider.name,
            auth: provider.auth.oauth === undefined ? "api_key" : "oauth",
            plugin: found.name,
          },
        });
        // Only the running build's providers reach the home's models, when `settle` applies them: a reload that fails,
        // or the home check's copy, changes nothing. Until then this plugin's own `models` sees them.
        const entry = this.provided.get(instance) ?? { plugin: found.name, providers: new Map() };
        entry.providers.set(provider.id, provider);
        this.provided.set(instance, entry);
      },
      unregisterProvider: (id) => {
        opened();
        const at = providers.findIndex((entry) => entry.provider.id === id);
        if (at === -1) return;
        providers.splice(at, 1);
        this.provided.get(instance)?.providers.delete(id);
      },
      wantsLogin: (provider, purpose) => {
        opened();
        wants.push({ provider: String(provider), purpose: String(purpose) });
      },
      registerSecretStore: (store) => {
        opened();
        if (secrets !== undefined) throw new Error("it registers two secret stores");
        for (const method of ["write", "remove", "readAll"] as const)
          if (typeof store[method] !== "function")
            throw new Error(`its secret store has no ${method} function`);
        secrets = store;
      },
    };
    try {
      await withTimeout(plugin(api), SETUP_TIMEOUT_MS);
    } catch (error) {
      this.retire(instance);
      throw error;
    } finally {
      open = false;
    }
    for (const handler of handlers.session_shutdown)
      instance.shutdown.push((reason) => handler({ type: "session_shutdown", reason }));
    const extension = defineExtension({
      name: found.source === "bundled" ? `monchu.${found.name}` : `${PLUGIN_PREFIX}${found.name}`,
      tools: tools.filter((entry) => entry.exposure === "direct").map((entry) => entry.tool),
      hooks: durableHooks(handlers, guard, ui, (toolName, input) =>
        repairs(this.home, toolName, input),
      ),
      tasks,
    });
    try {
      // Durable's own checks.
      createRegistry().install(extension);
    } catch (error) {
      this.retire(instance);
      throw error;
    }
    const namespaces = tools.flatMap((entry) => entry.namespace ?? []);
    const namespace = namespaces[0];
    const description =
      namespace?.description ??
      (await packageDescription(found.dir)) ??
      `Tools of the ${found.name} plugin`;
    const groupName = found.source === "bundled" ? found.name : `plugin-${found.name}`;
    const instructions = namespace?.instructions;
    const group = (exposure: ToolExposure): ToolGroup[] => {
      const listed = tools
        .filter((entry) => entry.exposure === exposure)
        .map((entry) => entry.tool);
      if (listed.length === 0) return [];
      return [
        {
          name: groupName,
          summary: description,
          tools: listed,
          ...(exposure === "codemode" ? { codemode: true } : {}),
          ...(namespace?.preload === true && exposure === "deferred" ? { preload: true } : {}),
          ...(instructions === undefined
            ? {}
            : {
                details: async (api: ToolExecutionApi, context: Context) =>
                  typeof instructions === "string"
                    ? instructions
                    : instructions({ durable: { api, context } }),
              }),
        },
      ];
    };
    const skills = join(found.dir, "skills");
    const empty =
      extension.tools?.length === 0 && extension.hooks?.length === 0 && tasks.length === 0;
    return {
      found,
      extension: empty ? undefined : extension,
      sections,
      groups: [...group("deferred"), ...group("codemode")],
      tools: tools.map((entry) => entry.tool.name),
      commands,
      page,
      providers,
      wants,
      secrets,
      input: handlers.input,
      inputChange: handlers.input_change,
      frontReply: handlers.front_reply,
      guard,
      ui,
      skills: existsSync(skills) ? skills : undefined,
      instance,
    };
  }
}

/** The home's secrets as plugins see them: by name, with values only for the plugin's own code. */
function pluginSecrets(vault: Vault): Omit<PluginApi["secrets"], "redacting"> {
  return {
    info: async (name) => {
      const info = await vault.info(name);
      return info === undefined
        ? undefined
        : {
            name: info.name,
            kind: info.kind,
            ...(info.site === undefined ? {} : { site: info.site }),
          };
    },
    value: async (key, use) =>
      (await vault.owner(key)) === undefined ? undefined : (await vault.resolve([key], use))[key],
    fill: (texts, use) => fillPlaceholders(vault, texts, use),
  };
}

/** Monchu's crew as plugins see it, with the worker profiles of the config this load applies. */
const agents = (config: MonchuConfig): PluginApi["agents"] => ({
  shortId,
  rootOf,
  whois: async (tx, id) => {
    if ((await tx.conversation(id)) === undefined) return undefined;
    const parent = await parentOf(tx, id);
    if (parent === undefined) return { role: "front", id };
    const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
      (each) => each.conversationId === id,
    );
    return worker === undefined
      ? undefined
      : { role: "worker", id, name: worker.name, parent, closed: worker.closed === true };
  },
  messageWorker: async (tx, worker, text, requestId) => {
    const current = (await tx.doc(WorkersDoc, worker.parent)).workers.find(
      (each) => each.conversationId === worker.id,
    );
    if (current === undefined) throw new Error(`${worker.name} is no longer a worker`);
    if (current.closed === true) await reopenWorker(tx, worker.parent, current.name);
    await messageWorker(tx, worker.parent, current.name, text, requestId, "followUp");
  },
  updateText: (name, text) => noticeText({ name, status: "update", text }),
  noticeText: systemNoticeText,
  workers: async (tx, front) => {
    const doc = await tx.doc(WorkersDoc, front);
    return {
      started: doc.started,
      workers: doc.workers.map((worker) => ({
        name: worker.name,
        id: worker.conversationId,
        closed: worker.closed === true,
        ...(worker.brief === undefined ? {} : { brief: worker.brief }),
      })),
    };
  },
  deliveries: async (read, front, context) =>
    (await read.snapshot(WorkersDoc, front, context))?.started ?? 0,
  goals: async (tx, front) =>
    (await tx.doc(GoalsDoc, front)).goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      workstream: goal.workstream,
      workers: [...goal.workers],
    })),
  profiles: config.profiles,
  labelReply: (tx, front, entry, label) =>
    labelItem(tx, front, entry, { ...label, by: "classifier" }),
  ask: openAsk,
  closeAsk,
});

/** The plugins' front events, in plugin then registration order. */
function frontEvents(used: readonly Contribution[]): FrontEvents {
  const inputs = used.flatMap((contribution) =>
    contribution.input.map((handler) => ({ handler, contribution })),
  );
  const changes = used.flatMap((contribution) =>
    contribution.inputChange.map((handler) => ({ handler, contribution })),
  );
  const replies = used.flatMap((contribution) =>
    contribution.frontReply.map((handler) => ({ handler, contribution })),
  );
  const ctx = (contribution: Contribution, front: ConversationId): PluginContext => ({
    conversationId: front,
    ui: contribution.ui(front, BACKGROUND_CONTEXT),
    signal: undefined,
  });
  return {
    input: async (event, front) => {
      let text = event.text;
      const admitted: AfterAdmission[] = [];
      for (const { handler, contribution } of inputs) {
        // The message isn't admitted until every handler answers, so one that hangs must not hold up the front.
        // A transform must leave text to send: one that doesn't is reported and ignored, so no message is lost.
        const result = await contribution.guard("input", async () => {
          const answer = await withTimeout(
            handler({ ...event, type: "input", text }, ctx(contribution, front)),
            INPUT_TIMEOUT_MS,
            "it did not answer",
          );
          if (
            answer?.action === "transform" &&
            (typeof answer.text !== "string" || answer.text.trim() === "")
          )
            throw new Error("its transform has no text; the message goes on unchanged");
          return answer;
        });
        if (result === "failed" || result === undefined) continue;
        if (result.action === "handled") return { text: undefined, admitted: [] };
        if (result.action === "transform") text = result.text;
        const after = result.admitted;
        if (after !== undefined)
          admitted.push(async (tx, submission) => {
            // A throw rolls its own commit back; the message stays admitted.
            const done = await contribution.guard("input admitted", () => after(tx, submission));
            if (done === "failed") throw new Error(`plugin ${contribution.found.name} failed`);
          });
      }
      return { text, admitted };
    },
    changes: changes.length > 0,
    change: async (event, tx, front) => {
      for (const { handler, contribution } of changes)
        await contribution.guard("input_change", () =>
          handler({ ...event, type: "input_change" }, tx, ctx(contribution, front)),
        );
    },
    reply: async (event, tx, front) => {
      for (const { handler, contribution } of replies)
        await contribution.guard("front_reply", () =>
          handler({ ...event, type: "front_reply" }, tx, ctx(contribution, front)),
        );
    },
  };
}

/**
 * The plugin API versions `package.json` says the plugin works with, as `"monchu": { "api": 2 }` or `[1, 2]`;
 * `undefined` when it says none. A malformed one throws.
 */
async function packageApis(dir: string): Promise<number[] | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "package.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const section: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "monchu") : undefined;
  const api: unknown =
    typeof section === "object" && section !== null ? Reflect.get(section, "api") : undefined;
  if (api === undefined) return undefined;
  const list: unknown[] = Array.isArray(api) ? api : [api];
  if (list.length === 0 || !list.every((each) => Number.isInteger(each)))
    throw new Error(
      'package.json\'s "monchu": { "api" } must be a version number or a list of them',
    );
  return list.filter((each): each is number => typeof each === "number");
}

async function packageDescription(dir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const description: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "description")
        : undefined;
    return typeof description === "string" && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
}
