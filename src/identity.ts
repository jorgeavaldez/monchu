import { defineExtension, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Character budgets of the home files every request loads. Nothing is ever truncated: a file near or over its budget
 * is named to the front, which routes a curation, and reported once as a warning.
 */
const BUDGETS: Record<string, number> = {
  "SOUL.md": 3000,
  "AGENTS.md": 10000,
  "FRONT.md": 12000,
  "DEVICES.md": 6000,
  "memories/USER.md": 4000,
  "memories/MEMORY.md": 4000,
};
const TOTAL_BUDGET = 36000;
/** Share of a budget at which a file counts as near it. */
const NEAR = 0.9;

/** Files near or over their budget, and the total when it is, as one line each. */
function overBudget(sizes: readonly { file: string; size: number }[]): string[] {
  const lines = sizes.flatMap(({ file, size }) => {
    const budget = BUDGETS[file];
    if (budget === undefined || size < budget * NEAR) return [];
    return [`${file}: ${size}/${budget} characters${size > budget ? ", over budget" : ""}`];
  });
  const total = sizes.reduce((sum, { size }) => sum + size, 0);
  if (sizes.length === Object.keys(BUDGETS).length && total >= TOTAL_BUDGET * NEAR)
    lines.push(`all home files: ${total}/${TOTAL_BUDGET} characters`);
  return lines;
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

/**
 * Home files are reread for every request. Every agent gets the shared manual (`AGENTS.md`); only the front gets
 * the soul and its front-only manual (`FRONT.md`). Workers also get the context files of their execution directory.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createIdentity(home: string, reportSkipped: (warning: string) => void) {
  return defineExtension({
    name: "monchu.identity",
    sections: [
      section("home", async (input) => {
        const files =
          input.conversationId === ROOT_CONVERSATION_ID
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
        for (const file of files) {
          const path = join(home, file);
          try {
            const text = await readFile(path, "utf8");
            sizes.push({ file, size: text.length });
            contents.push(`<home_file path="${path}">\n${text}\n</home_file>`);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            reportSkipped(`Missing Monchu home file (skipped): ${path}`);
          }
        }
        if (input.conversationId === ROOT_CONVERSATION_ID) {
          const near = overBudget(sizes);
          for (const line of near)
            reportSkipped(
              `Home file near its size budget: ${line.replace(/: \d+\//, ": budget ")}`,
            );
          if (near.length)
            contents.push(
              `<home_budget>\nThese home files are near or over their size budget; route a curation to the worker that owns the home files:\n${near.join("\n")}\n</home_budget>`,
            );
        }
        return contents.length === 0 ? undefined : contents.join("\n\n");
      }),
      section("project", async (input) => {
        if (input.conversationId === ROOT_CONVERSATION_ID || input.env?.cwd === undefined)
          return undefined;
        const files = await projectContextFiles(
          input.env.cwd,
          join(home, "AGENTS.md"),
          reportSkipped,
        );
        return files.length === 0
          ? undefined
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
  "You are the front conversation, the one the user talks to. Reply right away. If you can fully answer in this reply from what you already have, do. Otherwise say in one short line what you are routing, then route it to the worker whose line of work it continues, or start one. Never wait here for a worker. Weigh the routing helper's advice as FRONT.md says.\n\nKeep the goals section current with update_goal, following the goals rules in FRONT.md: goals are the user's ongoing projects and workstreams and your own commitments, not individual requests. Tell the user only what changed.\n\nFRONT.md says who keeps your home files and memories current; route those changes there.";
