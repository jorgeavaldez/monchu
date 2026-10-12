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
          "Add, replace, or remove one entry in user (memories/USER.md) or memory (memories/MEMORY.md). Entries are separated by a line containing only §. Replace/remove require a unique substring match. Exact duplicate adds do nothing. Each file is limited to 4000 characters including separators; compress existing entries before adding when full. Returns current usage. Never store secrets or task progress; goals own progress. This tool does not commit home files.",
        parameters: Type.Union([
          Type.Object(
            { action: Type.Literal("add"), file, entry },
            { additionalProperties: false },
          ),
          Type.Object(
            { action: Type.Literal("replace"), file, match, entry },
            { additionalProperties: false },
          ),
          Type.Object(
            { action: Type.Literal("remove"), file, match },
            { additionalProperties: false },
          ),
        ]),
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
            if (args.action !== "remove" && /^§\r?$/m.test(args.entry))
              throw new Error("An entry cannot contain a separator line (§)");
            let changed = false;
            if (args.action === "add") {
              const value = args.entry.trim();
              if (!entries.includes(value)) {
                entries.push(value);
                changed = true;
              }
            } else {
              const matches = entries.flatMap((text, index) =>
                text.includes(args.match) ? [index] : [],
              );
              const index = matches[0];
              if (matches.length !== 1 || index === undefined)
                throw new Error(
                  `Expected one matching entry; found ${matches.length}. Usage: ${current.length}/${LIMIT} characters`,
                );
              if (args.action === "remove") {
                entries.splice(index, 1);
                changed = true;
              } else if (entries[index] !== args.entry.trim()) {
                entries[index] = args.entry.trim();
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
