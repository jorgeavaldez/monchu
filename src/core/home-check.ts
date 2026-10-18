/**
 * The home check: whatever Monchu loads from its home (config.json, mcp.json, skills, plugins and their deny list),
 * checked as a build would meet it, so a broken home is seen when it breaks rather than at the next start. It runs the
 * real loaders without installing anything, whenever a fingerprint of those files changed: after each tool call, and
 * once at open. A tool call that changed the home gets the problems in its own result; the agent that made it is sent
 * back once at its final answer while they last; the front hears of problems no agent owns, and when they are gone.
 */
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { systemNoticeText } from "../api/notices.ts";
import { RELOAD_TOOLS, type Build } from "./build.ts";
import { loadConfig } from "./config.ts";
import { createContext } from "./context.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { configuredRoles } from "./models/index.ts";
import { reservedTasks, type Plugins } from "./plugins.ts";
import type { Vault } from "./secrets/vault.ts";
import { createPiTools } from "./tools/pi-tools.ts";
import type { FffFinders } from "./tools/fff.ts";

/** Home files Monchu loads; `skills/` and `plugins/` are walked. */
const FILES = ["config.json", "mcp.json", "plugins.local.json"];
const DIRS = ["skills", "plugins"];

export type HomeCheckInputs = {
  home: string;
  models: Models;
  plugins: Plugins;
  finders: FffFinders;
  vault: Vault;
  /** The running build: its config is the fallback, its tool names are taken, and its plugins keep running. */
  running: () => Build;
  /** Runs the check apart from reloads, since both run the plugins. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** Tell the front the home's problems (none: they are gone). `from` is the agent that left them, if one did. */
  tell: (problems: readonly string[], from?: ConversationId) => void;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sizes and times of the files Monchu loads from the home, outside `node_modules` and dot folders. */
async function homeFingerprint(home: string): Promise<string> {
  const parts: string[] = [];
  const add = async (path: string) => {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) parts.push(`${path}\0${info.size}\0${info.mtimeMs}`);
  };
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else await add(path);
    }
  };
  for (const file of FILES) await add(join(home, file));
  for (const dir of DIRS) await walk(join(home, dir));
  return parts.sort().join("\n");
}

/** What a build would warn about in the home now: the real loaders, with nothing installed and no plugin left running. */
async function problems(inputs: HomeCheckInputs): Promise<string[]> {
  const found: string[] = [];
  const running = inputs.running();
  let config = running.config;
  try {
    const roles = await configuredRoles(
      inputs.models,
      await loadConfig(inputs.home),
      running.config,
    );
    config = roles.config;
    found.push(...roles.warnings);
  } catch (error) {
    found.push(`${message(error)}. /reload refuses it, and the next start runs on the defaults`);
  }
  try {
    found.push(...(await loadMcpConfig(inputs.home)).errors);
  } catch (error) {
    found.push(
      `${message(error)}. /reload refuses it, and the next start runs without MCP servers`,
    );
  }
  const owned = new Set(running.owned);
  const own = running.extensions.filter((extension) => !owned.has(extension.name));
  const loaded = await inputs.plugins.load(config, { dry: true });
  try {
    const plugins = loaded.use({
      tools: new Set([
        ...own.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
        ...RELOAD_TOOLS,
      ]),
      tasks: reservedTasks(own),
    });
    const context = createContext(inputs.home, config.settings, loaded.skills);
    const tools = createPiTools(context.settings, inputs.finders, inputs.vault);
    found.push(...context.warnings, ...tools.warnings, ...plugins.warnings);
  } finally {
    // The plugin functions this check ran stop; the running build's keep going.
    inputs.plugins.settle(running.plugins);
  }
  return found;
}

function summary(found: readonly string[]): string {
  return found.length === 1
    ? "Monchu's home has a problem"
    : `Monchu's home has ${found.length} problems`;
}

function list(found: readonly string[]): string {
  return found.map((problem) => `- ${problem}`).join("\n");
}

/** The front's notice of the home's problems, or that they are gone. */
export function homeNotice(found: readonly string[], from?: string): string {
  if (found.length === 0)
    return systemNoticeText(
      "Monchu's home check passes again",
      "Nothing Monchu loads from its home is broken now.",
    );
  const who = from === undefined ? "" : ` ${from} left them.`;
  return systemNoticeText(
    summary(found),
    `What Monchu loads from its home is broken: a reload or the next start runs without it.${who} Get them fixed now:\n${list(found)}`,
  );
}

/** A running tool call as the home check follows it. */
type Call = {
  /** The home as it stood when the call started. */
  print: string;
  problems: readonly string[];
  /** The home file it names: a write or edit's `path`. */
  path?: string;
  /** Another call ran beside it, so a change it saw may be that one's. */
  overlapped: boolean;
};

/** The home's last check, kept as long as the core, across reloads. */
export class HomeCheck {
  private readonly inputs: HomeCheckInputs;
  /** The fingerprint `found` is for; `undefined` until the first check. */
  private checked: string | undefined;
  private found: readonly string[] = [];
  private running: Promise<readonly string[]> | undefined;
  /** What the front was last told. */
  private told: readonly string[] = [];
  /** Each running tool call, by tool task. */
  private readonly calls = new Map<string, Call>();
  /** Agents whose tool calls broke the home: the problems they added, and whether they were sent back. */
  private readonly editors = new Map<
    ConversationId,
    { readonly caused: Set<string>; sentBack: boolean }
  >();

  constructor(inputs: HomeCheckInputs) {
    this.inputs = inputs;
  }

  get problems(): readonly string[] {
    return this.found;
  }

  /** Check the home again if what Monchu loads from it changed since the last check. */
  async refresh(): Promise<{ problems: readonly string[]; print: string }> {
    for (;;) {
      const print = await homeFingerprint(this.inputs.home);
      if (print === this.checked) return { problems: this.found, print };
      if (this.running === undefined) {
        const running = this.inputs.exclusive(() => problems(this.inputs));
        this.running = running;
        try {
          this.found = await running;
        } catch (error) {
          this.found = [`The home check failed: ${message(error)}`];
        } finally {
          this.running = undefined;
        }
        this.checked = print;
        return { problems: this.found, print };
      }
      // Another check is running: wait for it, then look again.
      await this.running.catch(() => {});
    }
  }

  /** Check now, and tell the front if no agent owns what changed: at open, or after a change outside any tool call. */
  async check(): Promise<readonly string[]> {
    const { problems } = await this.refresh();
    this.tell();
    return problems;
  }

  /** Tell the front when the problems differ from what it was last told. */
  private tell(from?: ConversationId): void {
    if (key(this.found) === key(this.told)) return;
    this.told = this.found;
    this.inputs.tell(this.found, from);
  }

  /** Remember where the home stood when a tool call started, and which home file it names. */
  async beforeTool(taskId: string, path: unknown): Promise<void> {
    const call: Call = { print: "", problems: [], overlapped: this.calls.size > 0 };
    for (const other of this.calls.values()) other.overlapped = true;
    // Registered before the check, so a call starting meanwhile sees this one.
    this.calls.set(taskId, call);
    const had = this.found;
    const { print, problems } = await this.refresh();
    call.print = print;
    call.problems = problems;
    // Changed outside any tool call (another device's sync, an editor): unless a running call may have done it.
    this.forget(problems);
    if (key(problems) !== key(had) && this.calls.size === 1 && this.editors.size === 0) this.tell();
    const named = typeof path === "string" && isAbsolute(path) ? resolve(path) : undefined;
    if (named?.startsWith(join(this.inputs.home, sep)) === true) call.path = named;
  }

  /**
   * The call's result with what changed in the home while it ran. A problem is the call's own when no other call ran
   * beside it, or when it names the home file the call wrote: those send the agent back at its final answer. Any other
   * new problem may be another call's, so the call is only warned, and the front is told.
   */
  async afterTool(
    taskId: string,
    conversation: ConversationId,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult | undefined> {
    const call = this.calls.get(taskId);
    this.calls.delete(taskId);
    const had = this.found;
    const { problems, print } = await this.refresh();
    this.forget(problems);
    if (call === undefined || print === call.print) {
      // Changed outside any tool call (another device's sync, an editor), or not at all.
      if (key(problems) !== key(had) && this.editors.size === 0) this.tell();
      return undefined;
    }
    const old = new Set(call.problems.map(normal));
    const added = problems.filter((problem) => !old.has(normal(problem)));
    const now = new Set(problems.map(normal));
    const fixed = call.problems.filter((problem) => !now.has(normal(problem)));
    const own = call.overlapped
      ? added.filter(
          (problem) => call.path !== undefined && names(problem, call.path, this.inputs.home),
        )
      : added;
    // A problem another call already owns is that call's, not a possible one of this.
    const owned = new Set([...this.editors.values()].flatMap((editor) => [...editor.caused]));
    const others = added.filter((problem) => !own.includes(problem) && !owned.has(normal(problem)));
    if (own.length > 0) {
      const editor = this.editors.get(conversation) ?? {
        caused: new Set<string>(),
        sentBack: false,
      };
      for (const problem of own) editor.caused.add(normal(problem));
      this.editors.set(conversation, editor);
    }
    if (others.length > 0 || (own.length === 0 && fixed.length > 0 && this.editors.size === 0))
      this.tell();
    const notes: { severity: "info" | "warn" | "error"; text: string }[] = [];
    if (own.length > 0)
      notes.push({
        severity: "error",
        text: `This call broke what Monchu loads from its home: a reload or the next start runs without it. Fix it now:\n${list(own)}`,
      });
    if (others.length > 0)
      notes.push({
        severity: "warn",
        text: `What Monchu loads from its home broke while this call and others ran, so it may not be this call's doing. If it is, fix it now:\n${list(others)}`,
      });
    if (own.length === 0 && others.length === 0 && fixed.length > 0)
      notes.push({
        severity: "info",
        text:
          problems.length === 0
            ? "Monchu's home check passes now."
            : `Fixed while this call ran:\n${list(fixed)}`,
      });
    if (notes.length === 0) return undefined;
    return {
      ...result,
      diagnostics: [
        ...(result.diagnostics ?? []),
        ...notes.map(({ severity, text }) => ({ severity, code: "home_check", message: text })),
      ],
    };
  }

  /** Drop the problems that are gone from what each agent caused, and agents with nothing left. */
  private forget(problems: readonly string[]): void {
    const now = new Set(problems.map(normal));
    for (const [conversation, editor] of this.editors) {
      for (const problem of editor.caused) if (!now.has(problem)) editor.caused.delete(problem);
      if (editor.caused.size === 0) this.editors.delete(conversation);
    }
  }

  /** At an agent's final answer: send it back once while what it broke stays broken, then tell the front. */
  async onYield(conversation: ConversationId): Promise<string | undefined> {
    if (!this.editors.has(conversation)) return undefined;
    const { problems } = await this.refresh();
    this.forget(problems);
    const editor = this.editors.get(conversation);
    if (editor === undefined) {
      if (this.editors.size === 0) this.tell();
      return undefined;
    }
    const left = problems.filter((problem) => editor.caused.has(normal(problem)));
    if (!editor.sentBack) {
      editor.sentBack = true;
      return systemNoticeText(
        summary(left),
        `Your changes left what Monchu loads from its home broken. Fix it before you finish, or say why you can't:\n${list(left)}`,
      );
    }
    this.editors.delete(conversation);
    this.tell(conversation);
    return undefined;
  }
}

/** Whether `problem` names the home file `path`, or the skill or plugin folder it is in. */
function names(problem: string, path: string, home: string): boolean {
  const parts = relative(home, path).split(sep);
  const folder =
    parts[0] === "skills" || (parts[0] === "plugins" && parts[1] !== "local")
      ? parts.slice(0, 2)
      : parts[0] === "plugins"
        ? parts.slice(0, 3)
        : parts;
  return problem.includes(join(home, ...folder)) || problem.includes(parts.join(sep));
}

/** A problem as compared across checks: a plugin's import generation changes with every fresh import. */
function normal(problem: string): string {
  return problem.replace(/[?&]monchu-plugin=\d+/g, "");
}

function key(found: readonly string[]): string {
  return JSON.stringify(found);
}

/** The home check in every conversation: around each tool call, and at each final answer. */
export function createHomeCheck(check: HomeCheck) {
  return defineExtension({
    name: "monchu.home-check",
    hooks: [
      hook(ToolTask, {
        // A nested call is part of the call that made it, which reports.
        beforeTool: async (call, api, _context: Context) => {
          if (call.parent === undefined)
            await check.beforeTool(String(api.taskId), call.arguments.path);
          return undefined;
        },
        afterTool: async (call, result, api, _context: Context) =>
          call.parent === undefined
            ? check.afterTool(String(api.taskId), api.conversationId, result)
            : undefined,
      }),
      hook(GenerationTask, {
        onYield: async (_answer, api, _context: Context) => {
          const text = await check.onYield(api.conversationId);
          return text === undefined ? undefined : { continue: text };
        },
      }),
    ],
  });
}
