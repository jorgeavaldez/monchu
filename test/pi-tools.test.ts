import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveSettings, type Settings } from "../src/core/config.ts";
import { createPiTools } from "../src/core/tools/pi-tools.ts";
import {
  cleanup,
  context,
  lastMessage,
  open,
  route,
  sectionTexts,
  setup,
  textOf,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

function toolNames(settings: Settings, value: Setup): string[] {
  return (createPiTools(settings, value.finders).extension.tools ?? []).map((tool) => tool.name);
}

/** The front makes `calls` in order, one per message, and records each tool result's text. */
function callInOrder(value: Setup, calls: ReturnType<typeof fauxToolCall>[]): string[] {
  const outputs: string[] = [];
  const step: FauxResponseStep = (request) => {
    const last = lastMessage(request.messages);
    if (last?.role === "toolResult") {
      outputs.push(textOf(last));
      return fauxAssistantMessage("ok");
    }
    const call = calls.shift();
    if (call === undefined) throw new Error("Unexpected request");
    return fauxAssistantMessage([call], { stopReason: "toolUse" });
  };
  route(value.faux, step);
  return outputs;
}

describe("Pi built-ins", () => {
  it("uses the resolved selection, including default fff searches", async () => {
    const value = await setup();
    expect(toolNames(resolveSettings({}), value)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "fffind",
      "ffgrep",
    ]);
    expect(toolNames(resolveSettings({ defaultTools: ["-write", "+powershell"] }), value)).toEqual([
      "read",
      "edit",
      "bash",
      "fffind",
      "ffgrep",
      "powershell",
    ]);
    expect(toolNames(resolveSettings({ defaultTools: [] }), value)).toEqual([]);
  });

  it("tells the model to search with the selected fff tools, as pi-fff does", async () => {
    const value = await setup();
    value.registry.install(
      createPiTools(resolveSettings({ defaultTools: ["-fffind"] }), value.finders).extension,
    );
    const prompts: string[] = [];
    route(value.faux, (request) => {
      prompts.push(sectionTexts(request.messages, "search_tools").join("\n"));
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "search" }, context)).wait(context);
    } finally {
      await harness.close(context);
    }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("- ffgrep: Grep contents");
    expect(prompts[0]).toContain("instead of bash grep/find/rg");
    expect(prompts[0]).toContain("ffgrep: after 1-2 greps, read the top match");
    expect(prompts[0]).not.toContain("fffind");
  });

  it.each([
    { defaultTools: ["read", "bash", "ffgrep"], warnings: [] },
    {
      defaultTools: ["fffind"],
      warnings: [
        "Monchu defaultTools selects none of read, write, edit, bash; Monchu has no file or shell built-ins",
      ],
    },
  ])("warns about defaultTools $defaultTools", async ({ defaultTools, warnings }) => {
    const value = await setup();
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({ settings: { defaultTools } }),
    );
    const config = await loadConfig(value.directory);
    const tools = createPiTools(resolveSettings(config.settings), value.finders);
    expect(tools.warnings).toEqual(warnings);
  });

  it.each(["grep", "find", "ls"])("rejects removed built-in %s without an alias", async (name) => {
    const value = await setup();
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({ settings: { defaultTools: [name] } }),
    );
    await expect(loadConfig(value.directory)).rejects.toThrow(
      "settings.defaultTools contains an unknown built-in",
    );
  });

  it.each([undefined, ""])("runs direct and nested bash without a prefix (%s)", async (prefix) => {
    const value = await setup();
    value.registry.install(
      createPiTools(
        resolveSettings(prefix === undefined ? {} : { shellCommandPrefix: prefix }),
        value.finders,
      ).extension,
    );
    // A marker read by relative path shows the command ran in the execution directory on any platform.
    await writeFile(join(value.directory, "cwd-marker.txt"), "at-execution-cwd");
    const command = "printf unprefixed; cat cwd-marker.txt";
    const outputs = callInOrder(value, [
      fauxToolCall("bash", { command }),
      fauxToolCall("codemode", { code: `text(await tools.bash({ command: "${command}" }))` }),
    ]);
    const { harness, root } = await open(value);
    try {
      for (const content of ["direct", "nested"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
    } finally {
      await harness.close(context);
    }
    expect(outputs).toHaveLength(2);
    for (const output of outputs) expect(output).toContain("unprefixedat-execution-cwd");
    expect(value.reports).toEqual([]);
  });

  it("runs a configured prefix directly and through codemode, and fffind at execution cwd", async () => {
    const value = await setup();
    value.registry.install(
      createPiTools(
        resolveSettings({
          defaultTools: ["bash", "fffind"],
          shellCommandPrefix:
            "printf 'prefix\\n' >> prefix-calls.txt; export MONCHU_TEST_PREFIX=prefix",
        }),
        value.finders,
      ).extension,
    );
    const cwd = join(value.directory, "execution");
    await mkdir(cwd);
    await writeFile(join(cwd, "local-marker.txt"), "marker");
    const command = 'printf "%s:" "$MONCHU_TEST_PREFIX"; cat local-marker.txt';
    const outputs = callInOrder(value, [
      fauxToolCall("bash", { command }),
      fauxToolCall("codemode", {
        code: `text(await tools.bash({ command: ${JSON.stringify(command)} }))`,
      }),
      fauxToolCall("fffind", { pattern: "", path: "." }),
    ]);
    const { harness, root } = await open(value);
    try {
      await root.configure({ cwd }, context);
      for (const content of ["direct", "nested", "list"])
        await (await root.submit({ type: "input", content }, context)).wait(context);
    } finally {
      await harness.close(context);
    }
    expect(outputs[0]).toContain("prefix:marker");
    expect(outputs[1]).toContain("prefix:marker");
    expect(outputs[2]).toContain("local-marker.txt");
    expect((await readFile(join(cwd, "prefix-calls.txt"), "utf8")).split(/\r?\n/)).toEqual([
      "prefix",
      "prefix",
      "",
    ]);
    expect(value.reports).toEqual([]);
  });

  // The configured shell is a shebang script, which only a POSIX system can execute as a program.
  it.skipIf(process.platform === "win32")(
    "runs bash directly and through codemode with the configured shellPath",
    async () => {
      const value = await setup();
      const shell = process.env.PREFIX ? join(process.env.PREFIX, "bin", "sh") : "/bin/sh";
      const shellPath = join(value.directory, "configured-shell");
      await writeFile(
        shellPath,
        `#!${shell}\nprintf 'shell\\n' >> shell-calls.txt\nexec ${shell} "$@"\n`,
      );
      await chmod(shellPath, 0o700);
      value.registry.install(
        createPiTools(resolveSettings({ defaultTools: ["bash"], shellPath }), value.finders)
          .extension,
      );
      const outputs = callInOrder(value, [
        fauxToolCall("bash", { command: "printf direct" }),
        fauxToolCall("codemode", { code: 'text(await tools.bash({ command: "printf nested" }))' }),
      ]);
      // Monchu's host passes the configured shell to each execution environment.
      const harness = await Harness.open(
        await openNodeSqliteStorage(join(value.directory, "monchu.sqlite")),
        {
          models: value.models,
          registry: value.registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? value.directory, shellPath }),
          onReport: (error) => value.reports.push(error),
        },
        context,
      );
      try {
        const root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: value.directory },
        });
        harness.resume();
        for (const content of ["direct", "nested"])
          await (await root.submit({ type: "input", content }, context)).wait(context);
      } finally {
        await harness.close(context);
      }
      expect(outputs).toEqual([
        expect.stringContaining("direct"),
        expect.stringContaining("nested"),
      ]);
      expect(await readFile(join(value.directory, "shell-calls.txt"), "utf8")).toBe(
        "shell\nshell\n",
      );
      expect(value.reports).toEqual([]);
    },
  );
});
