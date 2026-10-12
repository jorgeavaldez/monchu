import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { formatSkillsForPrompt, loadSkills } from "../src/skills/index.ts";
import { cleanup, setup } from "./support.ts";

afterEach(cleanup);

it("discovers roots and nested skills in place, honors ignores, and keeps the first collision", async () => {
  const { directory } = await setup();
  const home = join(directory, "home-skills");
  const bundled = join(directory, "bundled-skills");
  for (const path of [home, bundled, join(home, "nested", "deep"), join(home, "ignored")])
    await mkdir(path, { recursive: true });
  await writeFile(join(home, ".ignore"), "ignored/\n");
  await writeFile(
    join(home, "direct.md"),
    "\uFEFF---\r\nname: direct\r\ndescription: 'a < b & c'\r\n---\r\nBODY",
  );
  await writeFile(
    join(home, "nested", "SKILL.md"),
    "---\nname: nested\ndescription: parent\n---\n",
  );
  await writeFile(
    join(home, "nested", "deep", "SKILL.md"),
    "---\nname: forbidden\ndescription: deep\n---\n",
  );
  await writeFile(
    join(home, "ignored", "SKILL.md"),
    "---\nname: ignored\ndescription: ignored\n---\n",
  );
  await writeFile(join(bundled, "SKILL.md"), "---\nname: direct\ndescription: bundled\n---\n");
  const { skills, diagnostics } = loadSkills([home, bundled]);
  expect(skills.map(({ name }) => name)).toEqual(["direct", "nested"]);
  expect(diagnostics).toEqual([
    {
      type: "collision",
      message: 'name "direct" collision',
      path: join(bundled, "SKILL.md"),
      collision: {
        name: "direct",
        winnerPath: join(home, "direct.md"),
        loserPath: join(bundled, "SKILL.md"),
      },
    },
  ]);
  const prompt = formatSkillsForPrompt(skills);
  expect(prompt).toContain("a &lt; b &amp; c");
  expect(prompt).toContain(join(home, "direct.md"));
  expect(prompt).not.toContain("BODY");
});

it("reports malformed metadata and missing paths, and excludes disabled skills from prompts", async () => {
  const { directory } = await setup();
  for (const name of ["malformed", "missing-description", "disabled", "Bad--name"])
    await mkdir(join(directory, name));
  await writeFile(join(directory, "malformed", "SKILL.md"), "---\n[\n---\n");
  await writeFile(
    join(directory, "missing-description", "SKILL.md"),
    "---\nname: missing-description\n---\n",
  );
  await writeFile(
    join(directory, "disabled", "SKILL.md"),
    "---\nname: disabled\ndescription: manual only\ndisable-model-invocation: true\n---\n",
  );
  await writeFile(
    join(directory, "Bad--name", "SKILL.md"),
    "---\ndescription: warns but loads\n---\n",
  );
  const { skills, diagnostics } = loadSkills([directory, join(directory, "absent")]);
  expect(skills.map(({ name }) => name)).toEqual(["Bad--name", "disabled"]);
  expect(diagnostics.some(({ message }) => message === "description is required")).toBe(true);
  expect(diagnostics.some(({ message }) => message.includes("invalid characters"))).toBe(true);
  expect(diagnostics.some(({ path }) => path === join(directory, "malformed", "SKILL.md"))).toBe(
    true,
  );
  expect(diagnostics.some(({ message }) => message === "skill path does not exist")).toBe(true);
  expect(formatSkillsForPrompt(skills)).not.toContain("manual only");
});
