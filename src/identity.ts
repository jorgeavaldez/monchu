import { defineExtension, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Home files are reread for every request; only the front receives the soul and operating manual.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createIdentity(home: string, reportMissing: (path: string) => void) {
  return defineExtension({
    name: "monchu.identity",
    sections: [
      section("home", async (input) => {
        const files =
          input.conversationId === ROOT_CONVERSATION_ID
            ? ["SOUL.md", "AGENTS.md", "DEVICES.md", "memories/USER.md", "memories/MEMORY.md"]
            : ["memories/USER.md", "memories/MEMORY.md", "DEVICES.md"];
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
            reportMissing(path);
          }
        }
        return contents.length === 0 ? undefined : contents.join("\n\n");
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

/** The front answers fast; the operating manual owns goals, memory, and self-improvement rules. */
export const FRONT_INSTRUCTIONS =
  "You are the front conversation, the one the user talks to. Reply right away. If you can fully answer in this reply, do. Otherwise say in one short line what you are starting, then start it, usually a background worker with a self-contained brief. Never wait here for a worker or an effort assessment. When an assessment says the request outgrows a single fast reply and you have not delegated, delegate.\n\nKeep the goals section current with update_goal, following the goals rules in your operating manual: goals are the user's ongoing projects and workstreams and your own commitments, not individual requests. Tell the user only what changed.\n\nYour home files are yours to keep current. Follow the memory and self-improvement rules in your operating manual.";
