import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentMutations } from "./support.ts";

describe("process environment ownership", () => {
  it("allows writes only in src/main.ts", async () => {
    const root = new URL("../src/", import.meta.url);
    const violations: string[] = [];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const filename = join(entry.parentPath, entry.name);
      if (filename === fileURLToPath(new URL("main.ts", root))) continue;
      const source = await readFile(filename, "utf8");
      for (const offset of environmentMutations(source))
        violations.push(`${filename}:${source.slice(0, offset).split("\n").length}`);
    }
    expect(violations, "Process environment setup belongs to src/main.ts").toEqual([]);
  });

  it.each([
    'process.env.MONCHU_DEV_HOME = "other";',
    'process["env"]["MONCHU_DEV_HOME"] = "other";',
    "process.env = {};",
    "delete process.env.MONCHU_DEV_HOME;",
    "process.env.COUNT++;",
    'Object.assign(process.env, { MONCHU_DEV_HOME: "other" });',
    'Object.defineProperty(process.env, "HOME", { value: "other" });',
    'Reflect.set(process.env, "HOME", "other");',
    'const env = process.env; env.HOME = "other";',
  ])("rejects %s", (source) => {
    expect(environmentMutations(source).length).toBeGreaterThan(0);
  });

  it("allows environment reads and independent child-environment copies", () => {
    expect(
      environmentMutations(`
        const home = process.env.HOME;
        const env = { ...process.env };
        delete env.MONCHU_DEV_HOME;
        Object.keys(process.env);
        Object.entries(process.env);
        Object.values(process.env);
        // process.env.HOME = "comment";
        const example = 'process.env.HOME = "string"';
      `),
    ).toEqual([]);
  });
});
