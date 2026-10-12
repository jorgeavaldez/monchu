import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createPiTools } from "../src/pi-tools.ts";
import {
  cleanup,
  context,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

function toolNames(settings: SettingsManager, platform: NodeJS.Platform): string[] {
  return (createPiTools(settings, platform).extension.tools ?? []).map((tool) => tool.name);
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
  it("uses Pi's resolved defaults", () => {
    expect(
      toolNames(SettingsManager.inMemory({ defaultTools: ["-write", "+ls"] }), process.platform),
    ).toEqual(["read", "edit", "bash", "ls"]);
    expect(toolNames(SettingsManager.inMemory({ defaultTools: [] }), process.platform)).toEqual([]);
  });

  it.each([
    { defaultTools: ["read", "bash", "grep"], warnings: [] },
    {
      defaultTools: ["ls"],
      warnings: [
        "Monchu defaultTools selects none of read, write, edit, bash; Monchu has no file or shell built-ins",
      ],
    },
  ])("warns about defaultTools $defaultTools", async ({ defaultTools, warnings }) => {
    const { directory } = await setup();
    await writeFile(join(directory, "config.json"), JSON.stringify({ settings: { defaultTools } }));
    const config = await loadConfig(directory);
    const tools = createPiTools(SettingsManager.inMemory(config.settings), "linux");
    expect(tools.warnings).toEqual(warnings);
  });

  it("skips grep and find on Android with one warning", () => {
    const settings = SettingsManager.inMemory({
      defaultTools: ["read", "bash", "grep", "find", "ls"],
    });
    expect(createPiTools(settings, "android").warnings).toEqual([
      "Pi grep/find unavailable on Android; use bash with rg/fd on PATH instead",
    ]);
    expect(toolNames(settings, "android")).toEqual(["read", "bash", "ls"]);
  });

  it.each([undefined, ""])("runs direct and nested bash without a prefix (%s)", async (prefix) => {
    const value = await setup();
    value.registry.install(
      createPiTools(
        SettingsManager.inMemory(prefix === undefined ? {} : { shellCommandPrefix: prefix }),
        process.platform,
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

  it("runs a configured prefix directly and through codemode, and SDK ls at execution cwd", async () => {
    const value = await setup();
    value.registry.install(
      createPiTools(
        SettingsManager.inMemory({
          defaultTools: ["bash", "ls"],
          shellCommandPrefix:
            "printf 'prefix\\n' >> prefix-calls.txt; export MONCHU_TEST_PREFIX=prefix",
        }),
        process.platform,
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
      fauxToolCall("ls", { path: "." }),
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
        createPiTools(
          SettingsManager.inMemory({ defaultTools: ["bash"], shellPath }),
          process.platform,
        ).extension,
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
