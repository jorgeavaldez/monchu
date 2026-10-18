import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  section,
  type ConversationId,
  type DocumentReader,
} from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rootRecord, RootsDoc } from "./agents/roots.ts";

/**
 * Character budgets of the home files every request loads. Nothing is ever truncated: every file loads in full, and a
 * file (or the total) that crosses into near or full is told to the front once per crossing (see `budgetNotice`).
 */
const BUDGETS: Record<string, number> = {
  "SOUL.md": 3000,
  "AGENTS.md": 10000,
  "FRONT.md": 12000,
  "DEVICES.md": 6000,
  "memories/USER.md": 4000,
  "memories/MEMORY.md": 4000,
};
const TOTAL = "all home files";
const TOTAL_BUDGET = 36000;
/** Share of a budget at which a file counts as near it. */
const NEAR = 0.9;

/** A home file, or all of them, at `near` (90%) or `full` (at or over) its character budget. */
export type BudgetLevel = { budget: string; size: number; limit: number; level: "near" | "full" };

/** Budgets near or full; the total only when every budgeted file exists. */
function budgetLevels(sizes: readonly { file: string; size: number }[]): BudgetLevel[] {
  const level = (budget: string, size: number, limit: number): BudgetLevel[] =>
    size < limit * NEAR ? [] : [{ budget, size, limit, level: size >= limit ? "full" : "near" }];
  const levels = sizes.flatMap(({ file, size }) => {
    const limit = BUDGETS[file];
    return limit === undefined ? [] : level(file, size, limit);
  });
  return sizes.length === Object.keys(BUDGETS).length
    ? [
        ...levels,
        ...level(
          TOTAL,
          sizes.reduce((sum, { size }) => sum + size, 0),
          TOTAL_BUDGET,
        ),
      ]
    : levels;
}

/** The level each budget was last told to the front at; a budget back under 90% is removed, so it warns again. */
export const HomeBudgetDoc = defineDoc<{
  levels: Record<string, "near" | "full">;
  sent: number;
  pending?: { requestId: string; text: string };
}>({
  kind: "monchu.home-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ levels: {}, sent: 0 }),
});

const RANK = { near: 1, full: 2 } as const;

/**
 * Record the budgets' current levels; returns the front's notice for those that rose since last told, or `undefined`.
 * The caller commits the recorded levels with the notice, so each crossing is told once.
 */
export function budgetNotice(
  state: { levels: Record<string, "near" | "full"> },
  levels: readonly BudgetLevel[],
): { summary: string; text: string } | undefined {
  const risen = levels.filter(({ budget, level }) => {
    const told = state.levels[budget];
    return told === undefined || RANK[level] > RANK[told];
  });
  state.levels = Object.fromEntries(levels.map(({ budget, level }) => [budget, level]));
  if (risen.length === 0) return undefined;
  const line = ({ budget, size, limit, level }: BudgetLevel) =>
    `${budget}: ${size}/${limit} characters (${Math.floor((size / limit) * 100)}%), ${
      level === "full"
        ? size === limit
          ? "at its budget"
          : `${size - limit} over its budget`
        : `${limit - size} left`
    }`;
  const full = risen.some(({ level }) => level === "full");
  return {
    summary: `${risen.map(({ budget }) => budget).join(", ")} ${full ? "at or over" : "near"} the home size budget`,
    text: [
      "Home files load in full into every request under a character budget each, and in total. These crossed a threshold (near is 90%):",
      ...risen.map(line),
      "Nothing is truncated or dropped: a file over its budget still loads in full and costs context on every request. The memory tool refuses to grow memories/USER.md or memories/MEMORY.md past their budget; no other edit is stopped.",
      "Route a curation now to whoever keeps the home files (FRONT.md says who): trim or compress, and move detail that not every request needs to the vault or a skill. Tell the user in one line. You hear about a budget again only when it rises a level or falls back under 90% and crosses again.",
    ].join("\n"),
  };
}

/** Pi's context-file names, in its precedence order (coding-agent `resource-loader.ts`). */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** A missing candidate is undefined; one that cannot be read is reported and skipped, like Pi, so the rest still load. */
async function readContextFile(
  path: string,
  reportSkipped: (warning: string) => void,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code !== "ENOENT" && code !== "EISDIR")
      reportSkipped(
        `Unreadable context file (skipped): ${path}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
      );
    return undefined;
  }
}

/** The first context file in `cwd` and each ancestor, outermost first, like Pi; `skip` is already loaded. */
async function projectContextFiles(
  cwd: string,
  skip: string,
  reportSkipped: (warning: string) => void,
) {
  const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const files: { path: string; content: string }[] = [];
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    for (const name of CONTEXT_FILES) {
      const path = join(directory, name);
      const content = await readContextFile(path, reportSkipped);
      if (content === undefined) continue;
      if (key(path) !== key(resolve(skip))) files.unshift({ path, content });
      break;
    }
    if (dirname(directory) === directory) return files;
  }
}

/** Every root is a front, not only Durable's reserved one; a worker is never a root. */
async function isFront(
  read: DocumentReader,
  id: ConversationId,
  context: Context,
): Promise<boolean> {
  const roots = await read.snapshot(RootsDoc, context);
  return roots !== undefined && rootRecord(roots, id) !== undefined;
}

/**
 * Home files are reread for every request. Every agent gets the shared manual (`AGENTS.md`); only fronts (every root) get
 * the soul and its front-only manual (`FRONT.md`). Workers also get the context files of their execution directory.
 * Every render measures all budgeted files and passes their levels to `observeBudget`.
 */
export function createIdentity(
  home: string,
  reportSkipped: (warning: string) => void,
  observeBudget: (levels: BudgetLevel[]) => void = () => {},
) {
  return defineExtension({
    name: "monchu.identity",
    sections: [
      section("home", async (input, context) => {
        const files = (await isFront(input.read, input.conversationId, context))
          ? [
              "SOUL.md",
              "AGENTS.md",
              "FRONT.md",
              "DEVICES.md",
              "memories/USER.md",
              "memories/MEMORY.md",
            ]
          : ["AGENTS.md", "DEVICES.md", "memories/USER.md", "memories/MEMORY.md"];
        const contents: string[] = [];
        const sizes: { file: string; size: number }[] = [];
        for (const file of Object.keys(BUDGETS)) {
          const path = join(home, file);
          let text: string;
          try {
            text = await readFile(path, "utf8");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            if (files.includes(file)) reportSkipped(`Missing Monchu home file (skipped): ${path}`);
            continue;
          }
          sizes.push({ file, size: text.length });
          if (files.includes(file))
            contents.push(`<home_file path="${path}">\n${text}\n</home_file>`);
        }
        observeBudget(budgetLevels(sizes));
        return contents.length === 0 ? undefined : contents.join("\n\n");
      }),
      section("project", async (input, context) => {
        if (
          input.env?.cwd === undefined ||
          (await isFront(input.read, input.conversationId, context))
        )
          return undefined;
        // Never undefined for a worker: a section that appears later re-sends every section after it.
        const files = await projectContextFiles(
          input.env.cwd,
          join(home, "AGENTS.md"),
          reportSkipped,
        );
        return files.length === 0
          ? "No project instructions in the execution directory."
          : files
              .map(
                ({ path, content }) =>
                  `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
              )
              .join("\n\n");
      }),
      section("device", (input) =>
        [
          `Hostname: ${hostname()}`,
          `OS: ${type()}`,
          `OS release: ${release()}`,
          `User: ${userInfo().username}`,
          `Home directory: ${homedir()}`,
          `Monchu home: ${home}`,
          `Execution directory: ${input.env?.cwd}`,
        ].join("\n"),
      ),
    ],
  });
}

/** The front answers fast; `FRONT.md` owns its dispatch, goals, memory, and self-improvement rules. */
export const FRONT_INSTRUCTIONS =
  'You are the front conversation, the one the user talks to. Reply right away. If you can fully answer in this reply from what you already have, do. Otherwise say in one short line what you are routing, then route it to the worker whose line of work it continues, or start one. Never wait here for a worker. Weigh the routing helper\'s advice as FRONT.md says.\n\nKeep the goals section current with update_goal, following the goals rules in FRONT.md: goals are the user\'s ongoing projects and workstreams and your own commitments, not individual requests. Tell the user only what changed.\n\nEvery message you send the user is an item in their inbox, read on its own, later, perhaps as a phone notification, among many workstreams. Its first line is a headline that stands alone: what happened or what you need, naming the project or goal. Start it with the kind and goal id of the message, which file it in the inbox of the user: "ask · <goal>: " when it waits on the user, "done · <goal>: " when something was delivered or closed, "update · <goal>: " for progress or a sitrep, or "reply: " for a plain answer; leave the goal out when there is none. Never lean on context the user may not have: no "my last message", "as above" or numbered points, rules or decisions; name the thing, and cite an earlier message as #id. Send status and sitreps, milestones (something delivered or closed), and asks; an ask is one clear question with your options and your recommendation.\n\nFRONT.md says who keeps your home files and memories current; route those changes there.';
