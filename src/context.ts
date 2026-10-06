import {
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";

type Loaded = { instructions: string | undefined; skills: string | undefined };

/**
 * Pi's AGENTS.md context files and skills as prompt sections, for every conversation. Like Pi, each directory loads
 * once per process: unchanged sections are not resent, which keeps provider prompt caches warm.
 */
export function createPiContext(
  agentDir: string,
  skillPaths: readonly string[],
  fallbackCwd: string,
) {
  const loaded = new Map<string, Loaded>();
  const load = (cwd: string): Loaded => {
    let found = loaded.get(cwd);
    if (found === undefined) {
      const files = loadProjectContextFiles({ cwd, agentDir });
      const skills = loadSkills({
        cwd,
        agentDir,
        skillPaths: [...skillPaths],
        includeDefaults: true,
      }).skills;
      found = {
        instructions: files.length
          ? [
              "Project-specific instructions and guidelines:",
              ...files.map(
                ({ path, content }) =>
                  `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
              ),
            ].join("\n\n")
          : undefined,
        skills: skills.length ? formatSkillsForPrompt(skills, "read") : undefined,
      };
      loaded.set(cwd, found);
    }
    return found;
  };
  const cwdOf = (input: { env?: { cwd: string } | undefined; agent: { cwd?: string } }) =>
    input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
  return defineExtension({
    name: "monchu.pi-context",
    sections: [
      section("project_context", (input) => load(cwdOf(input)).instructions, { tag: false }),
      section("skills", (input) => load(cwdOf(input)).skills, { tag: false }),
    ],
  });
}
