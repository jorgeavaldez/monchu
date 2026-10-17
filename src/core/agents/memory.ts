import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const LIMIT = 4000;
const file = StringEnum(["user", "memory"] as const, {
  description: "user: facts about the user; memory: Monchu's own notes",
});
const entry = Type.String({ minLength: 1, pattern: "\\S", description: "One complete entry" });
const match = Type.String({ minLength: 1, pattern: "\\S", description: "Unique entry substring" });

function result(changed: boolean, file: string, text: string, delivery: string | undefined) {
  return {
    output: [
      {
        type: "text" as const,
        text: `${changed ? "Changed" : "Unchanged"}. ${file} usage: ${text.length}/${LIMIT} characters${delivery === undefined ? "" : `. ${delivery}`}`,
      },
    ],
  };
}

/**
 * Commit only the memory file in a jj home and push main, so a memory edit never sits uncommitted. A home that isn't a
 * jj repository is left alone; a failed push leaves the commit local and says so, for the caller to push by hand.
 */
async function deliver(
  home: string,
  args: { action: string; file: "user" | "memory" },
  context: { abortSignal?: AbortSignal | undefined },
): Promise<string | undefined> {
  if (
    !(await access(join(home, ".jj")).then(
      () => true,
      () => false,
    ))
  )
    return undefined;
  const relative = `memories/${args.file === "user" ? "USER.md" : "MEMORY.md"}`;
  const jj = (...argv: string[]) =>
    run("jj", ["--no-pager", "--color=never", ...argv], {
      cwd: home,
      timeout: 60_000,
      ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
    });
  try {
    // A replay may find the file already committed.
    if ((await jj("diff", "--name-only", relative)).stdout.trim() !== "")
      await jj("commit", relative, "-m", `memory: ${args.action} in ${relative}`);
    const id = (
      await jj(
        "log",
        "--no-graph",
        "-r",
        `latest(::@- & files("${relative}"))`,
        "-T",
        "commit_id.short(8)",
      )
    ).stdout.trim();
    try {
      // jj only warns, and exits 0, when main or its remote is missing: check the remote really has the commit.
      await jj("bookmark", "move", "main", "--to", id);
      await jj("git", "push", "--bookmark", "main");
      const pushed = (
        await jj("log", "--no-graph", "-r", "main@origin", "-T", "commit_id.short(8)")
      ).stdout.trim();
      if (pushed !== id) throw new Error(`main@origin is at ${pushed || "nothing"}`);
      return `Committed and pushed as ${id}`;
    } catch (error) {
      return `Committed locally as ${id}; pushing main failed (${failure(error)}). Fetch, rebase, and push main from ${home}`;
    }
  } catch (error) {
    return `Not committed (${failure(error)}). Commit ${relative} in ${home}`;
  }
}

function failure(error: unknown): string {
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr.trim().split("\n").at(-1)
      : undefined;
  return stderr || (error instanceof Error ? error.message : String(error));
}

/** Memory edits for every role, always under the host's home, never the conversation's cwd.
 */
export function createMemory(home: string) {
  // Codemode can call tools concurrently even when their direct execution mode is sequential.
  let pending = Promise.resolve();
  return defineExtension({
    name: "monchu.memory",
    tools: [
      defineTool({
        name: "memory",
        description:
          "Add, replace, or remove one entry in user (memories/USER.md) or memory (memories/MEMORY.md). Entries are separated by a line containing only §. add needs entry; replace needs match and entry; remove needs match, a unique substring of one entry. Exact duplicate adds do nothing. Each file is limited to 4000 characters including separators; compress existing entries before adding when full. Returns current usage. Never store secrets or task progress; goals own progress. In a jj home, a change is committed (only that file) and pushed to main; the result says if the push needs doing by hand.",
        // One object schema: Claude Code's MCP layer rejects a top-level union.
        parameters: Type.Object(
          {
            action: StringEnum(["add", "replace", "remove"] as const),
            file,
            match: Type.Optional(match),
            entry: Type.Optional(entry),
          },
          { additionalProperties: false },
        ),
        replay: "safe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const previous = pending;
          let release = () => {};
          pending = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            context.abortSignal?.throwIfAborted();
            const directory = join(home, "memories");
            const path = join(directory, args.file === "user" ? "USER.md" : "MEMORY.md");
            const current = await readFile(path, "utf8").catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
              throw error;
            });
            // A replayed call finds its own earlier write: report it instead of failing to match again.
            // Keyed by call: codemode runs several nested calls inside one task, which share its memos.
            const memo = `memory-write:${api.callId}`;
            const planned = await api.memo<{ before: string; after: string }>(memo, context);
            if (planned !== undefined && current === planned.after)
              return result(true, args.file, current, await deliver(home, args, context));
            const entries = current
              .split(/^§\r?$/m)
              .map((text) => text.trim())
              .filter(Boolean);
            const { action, match: needle } = args;
            const value = args.entry?.trim();
            if (action !== "remove" && value === undefined)
              throw new Error(`${action} requires entry`);
            if (action !== "add" && needle === undefined)
              throw new Error(`${action} requires match`);
            if (value !== undefined && /^§\r?$/m.test(value))
              throw new Error("An entry cannot contain a separator line (§)");
            let changed = false;
            if (action === "add") {
              if (value === undefined) throw new Error("add requires entry");
              if (!entries.includes(value)) {
                entries.push(value);
                changed = true;
              }
            } else {
              if (needle === undefined) throw new Error(`${action} requires match`);
              const matches = entries.flatMap((text, index) =>
                text.includes(needle) ? [index] : [],
              );
              const index = matches[0];
              if (matches.length !== 1 || index === undefined)
                throw new Error(
                  `Expected one matching entry; found ${matches.length}. Usage: ${current.length}/${LIMIT} characters`,
                );
              if (action === "remove") {
                entries.splice(index, 1);
                changed = true;
              } else if (value !== undefined && entries[index] !== value) {
                entries[index] = value;
                changed = true;
              }
            }
            const next = changed
              ? entries.length === 0
                ? ""
                : `${entries.join("\n§\n")}\n`
              : current;
            if (changed && next.length > LIMIT)
              throw new Error(
                `Memory limit exceeded: proposed ${next.length}/${LIMIT} characters. Current usage: ${current.length}/${LIMIT} characters; compress first.`,
              );
            if (changed) {
              await api.memo(memo, { before: current, after: next }, context);
              await mkdir(directory, { recursive: true });
              const temporary = join(directory, `.${randomUUID()}.tmp`);
              try {
                await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
                context.abortSignal?.throwIfAborted();
                await rename(temporary, path);
              } finally {
                await rm(temporary, { force: true });
              }
            }
            return result(
              changed,
              args.file,
              next,
              changed ? await deliver(home, args, context) : undefined,
            );
          } finally {
            release();
          }
        },
      }),
    ],
  });
}
