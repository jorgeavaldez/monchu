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
import { join } from "node:path";
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
    found.push(`${message(error)}. /reload refuses it, and the next start fails`);
  }
  const owned = new Set(running.owned);
  const own = running.extensions.filter((extension) => !owned.has(extension.name));
  const loaded = await inputs.plugins.load(config);
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

/** The home's last check, kept as long as the core, across reloads. */
export class HomeCheck {
  private readonly inputs: HomeCheckInputs;
  /** The fingerprint `found` is for; `undefined` until the first check. */
  private checked: string | undefined;
  private found: readonly string[] = [];
  private running: Promise<readonly string[]> | undefined;
  /** What the front was last told. */
  private told: readonly string[] = [];
  /** Each tool call's fingerprint before it ran, by tool task. */
  private readonly before = new Map<string, string>();
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

  /** Remember where the home stood when a tool call started. */
  async beforeTool(taskId: string): Promise<void> {
    this.before.set(taskId, await homeFingerprint(this.inputs.home));
  }

  /** The call's result with the home's problems, when the home changed while it ran. */
  async afterTool(
    taskId: string,
    conversation: ConversationId,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult | undefined> {
    const before = this.before.get(taskId);
    this.before.delete(taskId);
    const had = this.found;
    const { problems, print } = await this.refresh();
    this.forget(problems);
    if (before === undefined || print === before) {
      // Changed outside this call (another device's sync, an editor), or not at all.
      if (key(problems) !== key(had) && this.editors.size === 0) this.tell();
      return undefined;
    }
    // Only what this call broke is its own: a problem the home already had is not, nor one it fixed.
    const old = new Set(had.map(normal));
    const added = problems.filter((problem) => !old.has(normal(problem)));
    const now = new Set(problems.map(normal));
    const fixed = had.filter((problem) => !now.has(normal(problem)));
    if (added.length === 0) {
      if (fixed.length === 0) return undefined;
      if (this.editors.size === 0) this.tell();
      return withDiagnostic(
        result,
        "info",
        problems.length === 0
          ? "Monchu's home check passes now."
          : `This call fixed:\n${list(fixed)}`,
      );
    }
    const editor = this.editors.get(conversation) ?? { caused: new Set<string>(), sentBack: false };
    for (const problem of added) editor.caused.add(normal(problem));
    this.editors.set(conversation, editor);
    const others = problems.length - added.length;
    return withDiagnostic(
      result,
      "error",
      `This call broke what Monchu loads from its home: a reload or the next start runs without it. Fix it now:\n${list(added)}${others ? `\n(${others} other ${others === 1 ? "problem was" : "problems were"} there before this call.)` : ""}`,
    );
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

/** A problem as compared across checks: a plugin's import generation changes with every fresh import. */
function normal(problem: string): string {
  return problem.replace(/[?&]monchu-plugin=\d+/g, "");
}

function key(found: readonly string[]): string {
  return JSON.stringify(found);
}

function withDiagnostic(
  result: ToolExecutionResult,
  severity: "info" | "error",
  text: string,
): ToolExecutionResult {
  return {
    ...result,
    diagnostics: [...(result.diagnostics ?? []), { severity, code: "home_check", message: text }],
  };
}

/** The home check in every conversation: around each tool call, and at each final answer. */
export function createHomeCheck(check: HomeCheck) {
  return defineExtension({
    name: "monchu.home-check",
    hooks: [
      hook(ToolTask, {
        // A nested call is part of the call that made it, which reports.
        beforeTool: async (call, api, _context: Context) => {
          if (call.parent === undefined) await check.beforeTool(String(api.taskId));
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
