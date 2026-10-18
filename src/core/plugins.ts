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
import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type AnyTask,
  type Extension,
  type HookRegistration,
  type JsonObject,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shortId } from "../api/ids.ts";
import { noticeText, systemNoticeText } from "../api/notices.ts";
import type { Plugin, PluginApi, PluginCommand, PluginEvents, ToolExposure } from "../plugin.ts";
import { messageWorker, parentOf, reopenWorker, WorkersDoc } from "./agents/workers.ts";
import { fillPlaceholders, redacting } from "./secrets/tool.ts";
import type { Vault } from "./secrets/vault.ts";
import { PLUGIN_PREFIX, type ToolGroup } from "./tools/tool-search.ts";

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SETUP_TIMEOUT_MS = 10_000;
/** Deny list: `{ "disabled": ["name", ...] }`, gitignored, so each device decides. */
const DENY_FILE = "plugins.local.json";

type PluginSource = "bundled" | "home" | "local";

/** A plugin's slash command, with the plugin that registered it. */
export type PluginCommandEntry = PluginCommand & { readonly name: string; readonly plugin: string };

export type PluginStatus = {
  readonly name: string;
  readonly source: PluginSource;
  /** `kept`: the new code failed, so the last good code still runs. */
  readonly state: "loaded" | "kept" | "failed" | "disabled";
  readonly error?: string;
};

/** A running plugin function's lifetime: retired when a later build replaces it, or at close. */
type Instance = { readonly controller: AbortController; readonly shutdown: (() => unknown)[] };

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
  roots.add(pathToFileURL(join(found.dir, "/")).href);
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
export class Plugins {
  private readonly home: string;
  private readonly report: (warning: string) => void;
  private readonly vault: Vault;
  private readonly bundledDir: string;
  /** The last import of each plugin folder, by entry path, with the fingerprint it was made from. */
  private readonly modules = new Map<string, { fingerprint: string; plugin: Plugin | Error }>();
  /** The last plugin function that ran without failing, by entry path. */
  private readonly good = new Map<string, Plugin>();
  private readonly live = new Set<Instance>();

  constructor(
    home: string,
    report: (warning: string) => void,
    vault: Vault,
    bundledDir = fileURLToPath(new URL("../plugins/", import.meta.url)),
  ) {
    this.home = home;
    this.report = report;
    this.vault = vault;
    this.bundledDir = bundledDir;
  }

  /** Find, import and run every enabled plugin. Never throws for a plugin's fault. */
  async load(): Promise<PluginLoad> {
    const warnings: string[] = [];
    const status: PluginStatus[] = [];
    const found = new Map<string, Found>();
    const bundled = await this.discover(this.bundledDir, "bundled", warnings);
    const home = await this.discover(join(this.home, "plugins"), "home", warnings);
    const local = await this.discover(join(this.home, "plugins", "local"), "local", warnings);
    // A device's own plugin replaces a synced one of the same name, which replaces a bundled one.
    for (const plugin of [...bundled, ...home, ...local]) found.set(plugin.name, plugin);
    const disabled = await this.disabled(warnings);
    const contributions: Contribution[] = [];
    const instances = new Set<Instance>();
    const ordered = [...found.values()].sort(
      (left, right) =>
        Number(left.source !== "bundled") - Number(right.source !== "bundled") ||
        left.name.localeCompare(right.name),
    );
    for (const plugin of ordered) {
      if (disabled === "all" ? plugin.source !== "bundled" : disabled.has(plugin.name)) {
        status.push({ name: plugin.name, source: plugin.source, state: "disabled" });
        continue;
      }
      const loaded = await this.loadOne(plugin);
      if ("error" in loaded) {
        const kept = loaded.contribution !== undefined;
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
          if (clash !== undefined) {
            const error = `${clash.kind} ${clash.name} is already defined by ${clash.owner === "Monchu" ? "Monchu" : `plugin ${clash.owner}`}`;
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
          status,
          warnings,
          instances,
        };
      },
    };
  }

  /** Retire every instance a build that is no longer running made: after a publication, or a failed reload. */
  settle(running: PluginBuild | undefined): void {
    for (const instance of this.live) if (!running?.instances.has(instance)) this.retire(instance);
  }

  close(): void {
    this.settle(undefined);
  }

  private retire(instance: Instance): void {
    if (!this.live.delete(instance)) return;
    instance.controller.abort(new Error("Plugin retired"));
    for (const shutdown of instance.shutdown) {
      void (async () => shutdown())().catch((error: unknown) =>
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
        warnings.push(`Plugin ${entry.name} was skipped: ${folder} has no index.ts or index.js`);
        continue;
      }
      found.push({ name: entry.name, source, dir: folder, entry: index });
    }
    return found;
  }

  /** The names this device turned off, or `all` home plugins when the deny list can't be read: it fails closed. */
  private async disabled(warnings: string[]): Promise<ReadonlySet<string> | "all"> {
    const path = join(this.home, DENY_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
      warnings.push(`${path} could not be read, so no home plugin loads: ${message(error)}`);
      return "all";
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const list: unknown =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? Reflect.get(parsed, "disabled")
          : undefined;
      if (!Array.isArray(list) || !list.every((name) => typeof name === "string"))
        throw new Error('expected { "disabled": ["plugin", ...] }');
      return new Set(list.filter((name): name is string => typeof name === "string"));
    } catch (error) {
      warnings.push(`${path} is invalid, so no home plugin loads: ${message(error)}`);
      return "all";
    }
  }

  /** Import (when its files changed) and run one plugin; on failure, run its last good code instead. */
  private async loadOne(
    found: Found,
  ): Promise<{ contribution: Contribution } | { error: string; contribution?: Contribution }> {
    let error: string;
    try {
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
      }
      if (cached.plugin instanceof Error) throw cached.plugin;
      const contribution = await this.run(found, cached.plugin);
      this.good.set(found.entry, cached.plugin);
      return { contribution };
    } catch (failure) {
      error = message(failure);
    }
    const good = this.good.get(found.entry);
    if (good === undefined || good === this.modules.get(found.entry)?.plugin) return { error };
    try {
      return { error, contribution: await this.run(found, good) };
    } catch {
      return { error };
    }
  }

  /** Run a plugin's function and turn what it registered into a guarded extension and tool groups. */
  private async run(found: Found, plugin: Plugin): Promise<Contribution> {
    const instance: Instance = { controller: new AbortController(), shutdown: [] };
    this.live.add(instance);
    const tools: { tool: ToolRegistration; exposure: ToolExposure }[] = [];
    const sections: PromptSection[] = [];
    const tasks: AnyTask[] = [];
    const commands: PluginCommandEntry[] = [];
    const handlers: { [E in keyof PluginEvents]: PluginEvents[E][] } = {
      tool_call: [],
      tool_result: [],
      context: [],
      message_end: [],
      turn_end: [],
      agent_before_settle: [],
      session_before_compact: [],
      session_shutdown: [],
    };
    let namespace: Parameters<PluginApi["namespace"]>[0] | undefined;
    let open = true;
    const opened = () => {
      if (!open) throw new Error("Plugins register only while their function runs");
    };
    const reported = new Set<string>();
    const report = (warning: string) => this.report(`Plugin ${found.name}: ${warning}`);
    /** A handler's failure, told once per instance and event, then treated as no result. */
    const guard = async <T>(event: string, run: () => T | Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        if (!reported.has(event)) {
          reported.add(event);
          report(`its ${event} handler failed and is ignored: ${message(error)}`);
        }
        return undefined;
      }
    };
    const api: PluginApi = {
      name: found.name,
      dir: found.dir,
      home: this.home,
      device: device(),
      signal: instance.controller.signal,
      report,
      secrets: pluginSecrets(this.vault),
      agents: AGENTS,
      namespace: (options) => {
        opened();
        namespace = options;
      },
      registerTool: (tool, options) => {
        opened();
        const exposure = options?.exposure ?? "deferred";
        if (!["deferred", "direct", "codemode"].includes(exposure))
          throw new Error(`tool ${tool.name}: unknown exposure ${String(exposure)}`);
        if (!TOOL_NAME.test(tool.name))
          throw new Error(`tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME.source}`);
        if (typeof tool.execute !== "function")
          throw new Error(`tool ${tool.name} has no execute function`);
        if (tools.some((entry) => entry.tool.name === tool.name))
          throw new Error(`two tools are named ${tool.name}`);
        tools.push({ tool, exposure });
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
          render: async (input, context) =>
            (await guard(`section ${key}`, () => render(input, context)))?.trim() || undefined,
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
        if (typeof command.run !== "function")
          throw new Error(`command /${name} has no run function`);
        if (commands.some((entry) => entry.name === name))
          throw new Error(`two commands are named /${name}`);
        commands.push({
          name,
          plugin: found.name,
          help: String(command.help),
          ...(command.usage === undefined ? {} : { usage: String(command.usage) }),
          run: command.run,
        });
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
    for (const handler of handlers.session_shutdown) instance.shutdown.push(handler);
    const extension = defineExtension({
      name: found.source === "bundled" ? `monchu.${found.name}` : `${PLUGIN_PREFIX}${found.name}`,
      tools: tools.filter((entry) => entry.exposure === "direct").map((entry) => entry.tool),
      hooks: guardedHooks(handlers, guard),
      tasks,
    });
    try {
      // Durable's own checks.
      createRegistry().install(extension);
    } catch (error) {
      this.retire(instance);
      throw error;
    }
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
          ...(instructions === undefined ? {} : { details: async () => instructions }),
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
      skills: existsSync(skills) ? skills : undefined,
      instance,
    };
  }
}

/** The home's secrets as plugins see them: by name, with values only for the plugin's own code. */
function pluginSecrets(vault: Vault): PluginApi["secrets"] {
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
    redacting: (tool) => redacting(tool, vault),
  };
}

const AGENTS: PluginApi["agents"] = {
  shortId,
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
};

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

type Guard = <T>(event: string, run: () => T | Promise<T>) => Promise<T | undefined>;

/** Durable hooks over a plugin's handlers, in registration order; a throwing handler counts as no result. */
function guardedHooks(
  handlers: { [E in keyof PluginEvents]: PluginEvents[E][] },
  guard: Guard,
): HookRegistration[] {
  const hooks: HookRegistration[] = [];
  const { tool_call, tool_result, context, message_end, turn_end, agent_before_settle } = handlers;
  if (tool_call.length || tool_result.length)
    hooks.push(
      hook(ToolTask, {
        ...(tool_call.length
          ? {
              beforeTool: async (call, api, ctx: Context) => {
                let args: JsonObject | undefined;
                for (const handler of tool_call) {
                  const current = args === undefined ? call : { ...call, arguments: args };
                  const decision = await guard("tool_call", () => handler(current, api, ctx));
                  if (decision?.block !== undefined) return { block: decision.block };
                  if (decision?.arguments !== undefined) args = decision.arguments;
                }
                return args === undefined ? undefined : { arguments: args };
              },
            }
          : {}),
        ...(tool_result.length
          ? {
              afterTool: async (call, result, api, ctx: Context) => {
                let current = result;
                for (const handler of tool_result)
                  current =
                    (await guard("tool_result", () => handler(call, current, api, ctx))) ?? current;
                return current === result ? undefined : current;
              },
            }
          : {}),
      }),
    );
  if (context.length || message_end.length || turn_end.length || agent_before_settle.length)
    hooks.push(
      hook(GenerationTask, {
        ...(context.length
          ? {
              beforeRequest: async (request, api, ctx: Context) => {
                let messages = request.messages;
                for (const handler of context)
                  messages =
                    (await guard("context", () => handler({ messages }, api, ctx)))?.messages ??
                    messages;
                return messages === request.messages ? undefined : { messages };
              },
            }
          : {}),
        ...(message_end.length
          ? {
              afterResponse: async (message, api, ctx: Context) => {
                for (const handler of message_end)
                  await guard("message_end", () => handler(message, api, ctx));
              },
            }
          : {}),
        ...(turn_end.length
          ? {
              afterTools: async (assistant, results, api, ctx: Context) => {
                for (const handler of turn_end)
                  await guard("turn_end", () => handler(assistant, results, api, ctx));
              },
            }
          : {}),
        ...(agent_before_settle.length
          ? {
              onYield: async (answer, api, ctx: Context) => {
                for (const handler of agent_before_settle) {
                  const decision = await guard("agent_before_settle", () =>
                    handler(answer, api, ctx),
                  );
                  if (decision !== undefined) return decision;
                }
                return undefined;
              },
            }
          : {}),
      }),
    );
  if (handlers.session_before_compact.length)
    hooks.push(
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx: Context) => {
          for (const handler of handlers.session_before_compact) {
            const decision = await guard("session_before_compact", () =>
              handler(compaction, api, ctx),
            );
            if (decision !== undefined) return decision;
          }
          return undefined;
        },
      }),
    );
  return hooks;
}
