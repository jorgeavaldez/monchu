import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIMIT = 4000;
const file = StringEnum(["user", "memory"] as const, {
  description: "user: facts about the user; memory: Monchu's own notes",
});
const entry = Type.String({ minLength: 1, pattern: "\\S", description: "One complete entry" });
const match = Type.String({ minLength: 1, pattern: "\\S", description: "Unique entry substring" });

/** Root-only memory edits, always under the host's home, never the conversation's cwd.
 * @public Loaded by the reload manifest (src/reload.ts).
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
          "Add, replace, or remove one entry in user (memories/USER.md) or memory (memories/MEMORY.md). Entries are separated by a line containing only §. add needs entry; replace needs match and entry; remove needs match, a unique substring of one entry. Exact duplicate adds do nothing. Each file is limited to 4000 characters including separators; compress existing entries before adding when full. Returns current usage. Never store secrets or task progress; goals own progress. This tool does not commit home files.",
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
        execute: async (args, _api, context) => {
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
            return {
              content: [
                {
                  type: "text",
                  text: `${changed ? "Changed" : "Unchanged"}. ${args.file} usage: ${next.length}/${LIMIT} characters`,
                },
              ],
            };
          } finally {
            release();
          }
        },
      }),
    ],
  });
}
