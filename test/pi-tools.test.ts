import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiTools } from "../src/pi-tools.ts";
import { cleanup, context, lastMessage, open, route, setup, textOf } from "./support.ts";

afterEach(cleanup);

describe("Pi built-ins", () => {
  it("uses Pi's resolved defaults while retaining worker and codemode tools", async () => {
    const value = await setup();
    const settings = SettingsManager.inMemory({ defaultTools: ["-write", "+ls"] });
    value.registry.install(createPiTools(settings));
    const names = value.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name);
    expect(names).toContain("read");
    expect(names).toContain("bash");
    expect(names).toContain("edit");
    expect(names).toContain("ls");
    expect(names).not.toContain("write");
    expect(names).not.toContain("grep");
    expect(names).toContain("codemode");
    expect(names).toContain("start_worker");
    value.registry.install(createPiTools(SettingsManager.inMemory({ defaultTools: [] })));
    expect(
      value.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    ).toEqual(names.filter((name) => !["read", "bash", "edit", "ls"].includes(name)));
  });

  it.each([undefined, ""])("runs direct and nested bash without a prefix (%s)", async (prefix) => {
    const value = await setup();
    value.registry.install(
      createPiTools(
        SettingsManager.inMemory(prefix === undefined ? {} : { shellCommandPrefix: prefix }),
      ),
    );
    const calls = [
      fauxToolCall("bash", { command: "printf unprefixed; pwd" }),
      fauxToolCall("codemode", {
        code: 'text(await tools.bash({ command: "printf unprefixed; pwd" }))',
      }),
    ];
    const outputs: string[] = [];
    route(value.faux, (request) => {
      if (lastMessage(request.messages)?.role === "toolResult") {
        outputs.push(textOf(lastMessage(request.messages)));
        return fauxAssistantMessage([fauxText("ok")]);
      }
      const call = calls.shift();
      if (call === undefined) throw new Error("Unexpected request");
      return fauxAssistantMessage([call], { stopReason: "toolUse" });
    });
    const { harness, root } = await open(value);
    for (const content of ["direct", "nested"]) {
      await (await root.submit({ type: "input", content }, context)).wait(context);
    }
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output).toContain("unprefixed");
      expect(output).toContain(value.directory);
    }
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });

  it("runs a configured shell/prefix directly and through codemode, and SDK ls at execution cwd", async () => {
    const value = await setup();
    const shell = process.env.PREFIX ? join(process.env.PREFIX, "bin", "sh") : "/bin/sh";
    const shellPath = join(value.directory, "configured-shell");
    await writeFile(
      shellPath,
      `#!${shell}\nprintf 'shell\\n' >> shell-calls.txt\nexec ${shell} "$@"\n`,
    );
    await chmod(shellPath, 0o700);
    const settings = SettingsManager.inMemory({
      defaultTools: ["bash", "ls"],
      shellPath,
      shellCommandPrefix:
        "printf 'prefix\\n' >> prefix-calls.txt; export MONCHU_TEST_PREFIX=prefix",
    });
    value.registry.install(createPiTools(settings));
    const cwd = join(value.directory, "execution");
    await mkdir(cwd);
    await writeFile(join(cwd, "local-marker.txt"), "marker");
    const outputs: string[] = [];
    const commands = [
      fauxToolCall("bash", { command: 'printf "%s\\n" "$MONCHU_TEST_PREFIX"; pwd' }),
      fauxToolCall("codemode", {
        code: 'text(await tools.bash({command: \'printf "%s\\\\n" "$MONCHU_TEST_PREFIX"; pwd\'}))',
      }),
      fauxToolCall("ls", { path: "." }),
    ];
    route(value.faux, (request) => {
      if (lastMessage(request.messages)?.role === "toolResult") {
        outputs.push(textOf(lastMessage(request.messages)));
        return fauxAssistantMessage([fauxText("ok")]);
      }
      const call = commands.shift();
      if (call === undefined) throw new Error("Unexpected request");
      return fauxAssistantMessage([call], { stopReason: "toolUse" });
    });
    const configuredShellPath = settings.getShellPath();
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(value.directory, "monchu.sqlite")),
      {
        models: value.models,
        registry: value.registry,
        env: ({ cwd }) =>
          new NodeExecutionEnv({
            cwd: cwd ?? value.directory,
            ...(configuredShellPath === undefined ? {} : { shellPath: configuredShellPath }),
          }),
        onReport: (error) => value.reports.push(error),
      },
      context,
    );
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: value.directory },
    });
    await root.configure({ cwd }, context);
    harness.resume();
    for (const content of ["direct", "nested", "list"]) {
      await (await root.submit({ type: "input", content }, context)).wait(context);
    }
    expect(outputs[0]).toContain("prefix");
    expect(outputs[1]).toContain("prefix");
    expect(outputs[0]).toContain(cwd);
    expect(outputs[1]).toContain(cwd);
    expect(outputs[2]).toContain("local-marker.txt");
    expect(await readFile(join(cwd, "prefix-calls.txt"), "utf8")).toBe("prefix\nprefix\n");
    expect(await readFile(join(cwd, "shell-calls.txt"), "utf8")).toBe("shell\nshell\n");
    expect(value.reports).toEqual([]);
    await harness.close(context);
  });
});
