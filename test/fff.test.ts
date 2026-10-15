import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiTools } from "../src/pi-tools.ts";
import { resolveSettings } from "../src/config.ts";
import { Monchu } from "../src/backend.ts";
import {
  callTools,
  cleanup,
  context,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  toolResults,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

describe("fff tools on real native indexes", () => {
  it("keeps native indexes usable across backend reload and releases them on close", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "marker.ts"), "nativeReloadMarker\n");
    route(
      value.faux,
      callTools({
        find: { tool: "fffind", args: { pattern: "", path: "*.ts" } },
        grep: { tool: "ffgrep", args: { pattern: "nativeReloadMarker" } },
      }),
    );
    const backend = await Monchu.open(value.directory, value.faux.provider);
    const state = await backend.viewState();
    try {
      await backend.changeDirectory(cwd);
      for (const [index, content] of ["find", "grep"].entries()) {
        if (index === 1) await backend.reload();
        await backend.submit(content, `fff-reload-${index}`, "followUp");
        await waitFor(
          () =>
            state.value.entries
              .flatMap((entry) => entry.model ?? [])
              .filter((message) => message.role === "toolResult").length ===
            index + 1,
        );
      }
      const results = state.value.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      expect(textOf(results[0])).toBe("marker.ts");
      expect(textOf(results[1])).toBe("marker.ts\n 1: nativeReloadMarker");
      expect(results.every((result) => !result.isError)).toBe(true);
    } finally {
      state.dispose();
      await backend.close();
    }
    // Removing LMDB directories after close catches leaked native handles on Windows.
    await rm(join(value.directory, "fff"), { recursive: true });
  });
  it("finds full paths and multi-word concepts, scopes recursive directory globs, and excludes files", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    await mkdir(join(cwd, "src", "profile"), { recursive: true });
    await mkdir(join(cwd, "test"));
    for (const filename of ["index.ts", "api.ts", "app.min.js"])
      await writeFile(join(cwd, "src", "profile", filename), "export const needle = 1;\n");
    await writeFile(join(cwd, "test", "profile.test.ts"), "test needle\n");
    route(
      value.faux,
      callTools({
        concept: { tool: "fffind", args: { pattern: "profile index" } },
        scoped: { tool: "fffind", args: { pattern: "", path: "src/**", exclude: "*.min.js" } },
        glob: { tool: "fffind", args: { pattern: "", path: "**/index.ts" } },
        excluded: { tool: "fffind", args: { pattern: "profile", exclude: ["!test/", "*.min.js"] } },
      }),
    );
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      for (const content of ["concept", "scoped", "glob", "excluded"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
      const results = await toolResults(root);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(textOf(results[0])).toBe("src/profile/index.ts");
      expect(textOf(results[1]).split("\n").sort()).toEqual([
        "src/profile/api.ts",
        "src/profile/index.ts",
      ]);
      expect(textOf(results[2])).toBe("src/profile/index.ts");
      expect(textOf(results[3])).not.toMatch(/test\/|app\.min/);
      expect(results[1]?.details).toMatchObject({ totalMatched: 2, pageIndex: 0, hasMore: false });
    } finally {
      await harness.close(context);
    }
    expect(await readdir(join(value.directory, "fff"))).toEqual(
      expect.arrayContaining(["frecency", "history"]),
    );
    expect(value.reports).toEqual([]);
  });

  it("routes external absolute, ../, and ~/ paths and resumes find pages with their original query and index", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    const outside = join(value.directory, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await writeFile(join(cwd, "workspace-only.ts"), "inside\n");
    for (const filename of ["a.ts", "b.ts", "c.ts"])
      await writeFile(join(outside, filename), "external Needle\n");
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      if (last?.role === "toolResult") {
        const cursor = textOf(last).match(/cursor="([^"]+)"/)?.[1];
        if (cursor !== undefined)
          return fauxAssistantMessage(
            [
              fauxToolCall("fffind", {
                pattern: "ignored-on-resume",
                path: "ignored/",
                limit: 20,
                cursor,
              }),
            ],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage("ok");
      }
      return fauxAssistantMessage(
        [
          fauxToolCall("fffind", {
            pattern: "",
            path: join(outside, "*.ts"),
            limit: 1,
          }),
        ],
        { stopReason: "toolUse" },
      );
    });
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      await (await root.submit({ type: "input", content: "pages" }, context)).wait(context);
      const pages = await toolResults(root);
      expect(pages).toHaveLength(3);
      expect(
        pages
          .map((result) => textOf(result).split("\n")[0] ?? "")
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
      for (const [pageIndex, page] of pages.entries())
        expect(page.details).toMatchObject({ pageIndex, hasMore: pageIndex < 2 });
      route(
        value.faux,
        callTools({
          relative: { tool: "ffgrep", args: { pattern: "Needle", path: "../outside/a.ts" } },
          tilde: { tool: "fffind", args: { pattern: "", path: "~/outside/**/b.ts" } },
          inside: { tool: "fffind", args: { pattern: "", path: cwd } },
        }),
      );
      for (const content of ["relative", "tilde", "inside"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
      const results = (await toolResults(root)).slice(3);
      expect(textOf(results[0])).toContain("a.ts\n 1: external Needle");
      expect(textOf(results[1])).toBe("b.ts");
      expect(textOf(results[2])).toBe("workspace-only.ts");
      expect(results.every((result) => !result.isError)).toBe(true);
    } finally {
      await harness.close(context);
    }
    expect(value.reports).toEqual([]);
  });

  it("greps with smart-case, exact case, regex, context, exclusions and long-line truncation", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "test"));
    await writeFile(
      join(cwd, "src", "main.ts"),
      "before\nNeedle\nneedle\nafter\n" + "needle" + "x".repeat(600) + "\n",
    );
    await writeFile(join(cwd, "test", "main.ts"), "needle excluded\n");
    route(
      value.faux,
      callTools({
        smart: { tool: "ffgrep", args: { pattern: "needle", path: "src/", context: 1 } },
        exact: { tool: "ffgrep", args: { pattern: "Needle", path: "src/", caseSensitive: true } },
        lower: {
          tool: "ffgrep",
          args: { pattern: "needle", caseSensitive: true, exclude: "!test/" },
        },
        regex: {
          tool: "ffgrep",
          args: { pattern: "^Needle$", path: "**/main.ts", exclude: ["test/"] },
        },
      }),
    );
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      for (const content of ["smart", "exact", "lower", "regex"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
      const results = await toolResults(root);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(textOf(results[0])).toContain(" 1- before\n 2: Needle");
      expect(textOf(results[0])).toContain(" 3: needle");
      expect(textOf(results[0])).toContain(" 4- after");
      expect(textOf(results[0])).toContain("needle" + "x".repeat(494) + "...");
      expect(textOf(results[1])).toBe("src/main.ts\n 2: Needle");
      expect(textOf(results[2])).not.toContain("test/main.ts");
      expect(textOf(results[2])).not.toContain(" 2: Needle");
      expect(textOf(results[3])).toBe("src/main.ts\n 2: Needle");
      expect(results[3]?.details).toMatchObject({ totalMatched: 1, totalFiles: 2 });
    } finally {
      await harness.close(context);
    }
    expect(value.reports).toEqual([]);
  });

  it("preserves fuzzy fallback, invalid-regex literals, wildcard guidance, and no-match results", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    await mkdir(join(cwd, "empty"), { recursive: true });
    await writeFile(join(cwd, "main.ts"), "const uniqueSearchIdentifier = 1;\nliteral[\n");
    route(
      value.faux,
      callTools({
        fuzzy: { tool: "ffgrep", args: { pattern: "uniqueSearchIdentifer", path: "missing.ts" } },
        constrained: { tool: "ffgrep", args: { pattern: "uniqueSearchIdentifer", path: "empty/" } },
        literal: { tool: "ffgrep", args: { pattern: "literal[" } },
        wildcard: { tool: "ffgrep", args: { pattern: ".*" } },
        missing: { tool: "fffind", args: { pattern: "", path: "*.absent" } },
      }),
    );
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      for (const content of ["fuzzy", "constrained", "literal", "wildcard", "missing"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
      const results = await toolResults(root);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(textOf(results[0])).toContain("[0 exact matches. Maybe you meant this?]");
      expect(textOf(results[0])).toContain("uniqueSearchIdentifier");
      expect(textOf(results[1])).toBe("No matches found");
      expect(textOf(results[2])).toBe("main.ts\n 2: literal[");
      expect(textOf(results[3])).toContain(
        "matches everything — grep needs a concrete substring or identifier",
      );
      expect(textOf(results[4])).toBe("No files found matching pattern");
    } finally {
      await harness.close(context);
    }
    expect(value.reports).toEqual([]);
  });

  it("paginates grep without dropping same-file matches and searches concurrently through codemode", async () => {
    const value = await setup();
    const cwd = join(value.directory, "workspace");
    await mkdir(cwd);
    for (const filename of ["a.ts", "b.ts", "c.ts"])
      await writeFile(join(cwd, filename), "needle first\nneedle second\nneedle third\n");
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      const cursor =
        last?.role === "toolResult" ? textOf(last).match(/cursor="([^"]+)"/)?.[1] : undefined;
      if (last?.role === "toolResult" && cursor === undefined) return fauxAssistantMessage("ok");
      return fauxAssistantMessage(
        [
          fauxToolCall("ffgrep", {
            pattern: "needle",
            limit: 1,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ],
        { stopReason: "toolUse" },
      );
    });
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      await (await root.submit({ type: "input", content: "pages" }, context)).wait(context);
      const pages = await toolResults(root);
      expect(pages).toHaveLength(3);
      for (const page of pages) {
        expect(page.isError).toBe(false);
        expect(textOf(page)).toContain(" 1: needle first\n 2: needle second\n 3: needle third");
      }
      value.registry.install(createPiTools(resolveSettings({}), value.finders).extension);
      route(
        value.faux,
        callTools({
          parallel: {
            tool: "codemode",
            args: {
              code: "text(await Promise.all([tools.fffind({pattern:'',path:'*.ts'}), tools.ffgrep({pattern:'needle',path:'a.ts'})]));",
            },
          },
        }),
      );
      await (await root.submit({ type: "input", content: "parallel" }, context)).wait(context);
      const results = await toolResults(root);
      expect(textOf(results[3])).toContain("a.ts");
      expect(textOf(results[3])).toContain(" 3: needle third");
      expect(results[3]?.isError).toBe(false);
    } finally {
      await harness.close(context);
    }
    expect(value.reports).toEqual([]);
  });
});
