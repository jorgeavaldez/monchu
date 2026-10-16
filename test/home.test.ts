import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { monchuHome, seedHome } from "../src/home.ts";
import { cleanup, setup } from "./support.ts";

afterEach(cleanup);

describe("home", () => {
  it("defaults to ~/.monchu and follows MONCHU_HOME, expanding a leading ~", async () => {
    const previous = process.env.MONCHU_HOME;
    try {
      delete process.env.MONCHU_HOME;
      expect(await monchuHome(false)).toBe(join(homedir(), ".monchu"));
      process.env.MONCHU_HOME = "~/elsewhere/home";
      expect(await monchuHome(false)).toBe(join(homedir(), "elsewhere", "home"));
      const value = await setup();
      process.env.MONCHU_HOME = value.directory;
      expect(await monchuHome(false)).toBe(value.directory);
    } finally {
      if (previous === undefined) delete process.env.MONCHU_HOME;
      else process.env.MONCHU_HOME = previous;
    }
  });

  it("seeds a new home with the starter files and never overwrites existing ones", async () => {
    const value = await setup();
    const home = join(value.directory, "fresh");
    const notes = await seedHome(home);
    expect(notes[0]).toContain(`seeded ${home}`);
    expect(notes.join("\n")).toMatch(/new jj repository|jj not found/);
    for (const file of ["AGENTS.md", "FRONT.md", "SOUL.md", "DEVICES.md", ".gitignore"])
      expect(await readdir(home)).toContain(file);
    expect((await readdir(join(home, "memories"))).sort()).toEqual(["MEMORY.md", "USER.md"]);
    expect(await readFile(join(home, ".gitignore"), "utf8")).toMatch(/^auth\.json$/m);
    expect(await seedHome(home)).toEqual([]);

    // An existing home keeps its files and only gains the missing ones; it is not made a repository.
    const existing = join(value.directory, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "SOUL.md"), "mine\n");
    const added = await seedHome(existing);
    expect(added[0]).not.toContain("SOUL.md");
    expect(added.join("\n")).not.toMatch(/jj/);
    expect(await readFile(join(existing, "SOUL.md"), "utf8")).toBe("mine\n");
  });
});
