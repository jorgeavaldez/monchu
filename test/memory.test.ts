import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemory } from "../src/memory.ts";
import { callTools, cleanup, context, open, route, setup, textOf, toolResults } from "./support.ts";

afterEach(cleanup);

describe("memory", () => {
  it("adds, deduplicates, replaces and removes entries in the explicit home", async () => {
    const value = await setup();
    value.registry.install(createMemory(value.directory));
    route(
      value.faux,
      callTools({
        add: { tool: "memory", args: { action: "add", file: "user", entry: "Likes tea" } },
        other: { tool: "memory", args: { action: "add", file: "user", entry: "Works remotely" } },
        replace: {
          tool: "memory",
          args: { action: "replace", file: "user", match: "tea", entry: "Likes coffee" },
        },
        remove: { tool: "memory", args: { action: "remove", file: "user", match: "remotely" } },
        note: {
          tool: "memory",
          args: { action: "add", file: "memory", entry: "Ask when uncertain" },
        },
      }),
    );
    const { harness, root } = await open(value);
    try {
      const elsewhere = join(value.directory, "elsewhere");
      await mkdir(elsewhere);
      await root.configure({ cwd: elsewhere }, context);
      const path = join(value.directory, "memories", "USER.md");
      for (const message of ["add", "add", "other"])
        await (await root.submit({ type: "input", content: message }, context)).wait(context);
      expect(await readFile(path, "utf8")).toBe("Likes tea\n§\nWorks remotely\n");
      for (const message of ["replace", "remove", "note"])
        await (await root.submit({ type: "input", content: message }, context)).wait(context);
      expect(await readFile(path, "utf8")).toBe("Likes coffee\n");
      expect(await readFile(join(value.directory, "memories", "MEMORY.md"), "utf8")).toBe(
        "Ask when uncertain\n",
      );
      expect(await readdir(join(value.directory, "memories"))).toEqual(["MEMORY.md", "USER.md"]);
      expect(await readdir(elsewhere)).toEqual([]);
      expect((await toolResults(root)).map(textOf)).toEqual([
        "Changed. user usage: 10/4000 characters",
        "Unchanged. user usage: 10/4000 characters",
        "Changed. user usage: 27/4000 characters",
        "Changed. user usage: 30/4000 characters",
        "Changed. user usage: 13/4000 characters",
        "Changed. memory usage: 19/4000 characters",
      ]);
    } finally {
      await harness.close(context);
    }
  });

  it("rejects ambiguous/missing matches, separator entries, and overflow without changing the file", async () => {
    const value = await setup();
    value.registry.install(createMemory(value.directory));
    const directory = join(value.directory, "memories");
    await mkdir(directory);
    const path = join(directory, "MEMORY.md");
    const initial = "same first\r\n§\r\nsame second\r\n";
    await writeFile(path, initial);
    route(
      value.faux,
      callTools({
        ambiguous: {
          tool: "memory",
          args: { action: "replace", file: "memory", match: "same", entry: "new" },
        },
        remove: { tool: "memory", args: { action: "remove", file: "memory", match: "same" } },
        missing: { tool: "memory", args: { action: "remove", file: "memory", match: "absent" } },
        separator: {
          tool: "memory",
          args: { action: "add", file: "memory", entry: "first\n§\nsecond" },
        },
        limit: { tool: "memory", args: { action: "add", file: "memory", entry: "x".repeat(4000) } },
        replaceLimit: {
          tool: "memory",
          args: { action: "replace", file: "memory", match: "first", entry: "x".repeat(4000) },
        },
      }),
    );
    const { harness, root } = await open(value);
    try {
      for (const message of [
        "ambiguous",
        "remove",
        "missing",
        "separator",
        "limit",
        "replaceLimit",
      ]) {
        await (await root.submit({ type: "input", content: message }, context)).wait(context);
        expect(await readFile(path, "utf8")).toBe(initial);
      }
      const results = await toolResults(root);
      expect(results.every((result) => result.isError)).toBe(true);
      expect(textOf(results[0])).toContain("found 2");
      expect(textOf(results[1])).toContain("found 2");
      expect(textOf(results[2])).toContain("found 0");
      expect(textOf(results[3])).toContain("separator line");
      for (const result of results.slice(4))
        expect(textOf(result)).toContain(`Current usage: ${initial.length}/4000 characters`);
    } finally {
      await harness.close(context);
    }
  });

  it("serializes nested adds and accepts exactly the file limit", async () => {
    const value = await setup();
    value.registry.install(createMemory(value.directory));
    route(
      value.faux,
      callTools({
        parallel: {
          tool: "codemode",
          args: {
            code: `await Promise.all([tools.memory({ action: "add", file: "user", entry: "first" }), tools.memory({ action: "add", file: "user", entry: "second" })]);`,
          },
        },
        full: { tool: "memory", args: { action: "add", file: "memory", entry: "x".repeat(3999) } },
        duplicate: {
          tool: "memory",
          args: { action: "add", file: "memory", entry: "x".repeat(3999) },
        },
        empty: { tool: "memory", args: { action: "remove", file: "memory", match: "xxx" } },
      }),
    );
    const { harness, root } = await open(value);
    try {
      for (const message of ["parallel", "full", "duplicate", "empty"])
        await (await root.submit({ type: "input", content: message }, context)).wait(context);
      const user = await readFile(join(value.directory, "memories", "USER.md"), "utf8");
      expect(user.trim().split("\n§\n").sort()).toEqual(["first", "second"]);
      expect(await readFile(join(value.directory, "memories", "MEMORY.md"), "utf8")).toBe("");
      expect((await toolResults(root)).map(textOf).slice(1)).toEqual([
        "Changed. memory usage: 4000/4000 characters",
        "Unchanged. memory usage: 4000/4000 characters",
        "Changed. memory usage: 0/4000 characters",
      ]);
    } finally {
      await harness.close(context);
    }
  });
});
