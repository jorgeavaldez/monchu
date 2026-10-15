import { defineExtension, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

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
        for (const file of files) {
          const path = join(home, file);
          try {
            contents.push(
              `<home_file path="${path}">\n${await readFile(path, "utf8")}\n</home_file>`,
            );
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            reportSkipped(`Missing Monchu home file (skipped): ${path}`);
          }
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
  "You are the front conversation, the one the user talks to. Reply right away. If you can fully answer in this reply, do. Otherwise say in one short line what you are starting, then start it, usually a background worker with a self-contained brief. Never wait here for a worker or an effort assessment. When an assessment says the request outgrows a single fast reply and you have not delegated, delegate.\n\nKeep the goals section current with update_goal, following the goals rules in FRONT.md: goals are the user's ongoing projects and workstreams and your own commitments, not individual requests. Tell the user only what changed.\n\nYour home files are yours to keep current. Follow the memory and self-improvement rules in FRONT.md.";
