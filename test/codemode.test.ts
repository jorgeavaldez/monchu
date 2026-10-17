import { defineExtension, wrapTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it } from "vitest";
import { Codemode } from "../src/core/tools/codemode.ts";
import { WorkersDoc } from "../src/core/agents/workers.ts";
import { callTools, cleanup, context, open, route, setup, textOf, toolResults } from "./support.ts";

afterEach(cleanup);

describe("codemode", () => {
  it("clears the outer output window when capturing nested output locally", async () => {
    const value = await setup();
    const codemode = Codemode.tools?.[0];
    if (codemode === undefined) throw new Error("Codemode tool is missing");
    let nestedWindow: ToolExecutionApi["outputWindow"] | "not-called" = "not-called";
    value.registry.install(
      defineExtension({
        name: "test.output-window",
        wraps: [
          // A non-default outer tail window must not reach a nested tool's output sink.
          wrapTool(codemode, (tool) => ({
            ...tool,
            outputLimits: { retain: "tail", maxBytes: 128 },
          })),
        ],
      }),
    );
    value.registry.install(
      defineExtension({
        name: "test.nested-window",
        wraps: [
          wrapTool(createBashTool(), (tool) => ({
            ...tool,
            execute: async (args, api, context) => {
              nestedWindow = api.outputWindow;
              return tool.execute(args, api, context);
            },
          })),
        ],
      }),
    );
    route(
      value.faux,
      callTools({
        script: {
          tool: "codemode",
          args: {
            code: `const output = await tools.bash({ command: "echo nested-output" }); text(output.trim().toUpperCase());`,
          },
        },
      }),
    );
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "script" }, context)).wait(context);
      expect(nestedWindow).toBeUndefined();
      const results = await toolResults(root);
      expect(results).toHaveLength(1);
      expect(textOf(results[0])).toBe("NESTED-OUTPUT");
      expect(results[0]?.isError).toBe(false);
    } finally {
      await harness.close(context);
    }
  });

  it("calls other tools from a script, keeps store values, and leaves those tools callable", async () => {
    const value = await setup();
    route(
      value.faux,
      callTools({
        script: {
          tool: "codemode",
          args: {
            code: `
              const echo = await tools.bash({ command: "echo from-bash" });
              await Promise.all([
                tools.start_worker({ name: "a", task: "task a" }),
                tools.start_worker({ name: "b", task: "task b" }),
              ]);
              store("runs", (load("runs") ?? 0) + 1);
              text(echo.trim());
              return load("runs");`,
          },
        },
        again: {
          tool: "codemode",
          args: { code: `store("runs", load("runs") + 1); return load("runs");` },
        },
        direct: { tool: "bash", args: { command: "echo direct" } },
      }),
    );
    const { harness, root } = await open(value);

    for (const message of ["script", "again", "direct"])
      await (await root.submit({ type: "input", content: message }, context)).wait(context);

    const results = await toolResults(root);
    expect(
      results.map((result) => [result.toolName, textOf(result).trim(), result.isError]),
    ).toEqual([
      ["codemode", "from-bash\n1", false],
      ["codemode", "2", false],
      ["bash", "direct", false],
    ]);
    // Two start_worker calls inside one codemode call stay two workers with distinct request IDs.
    const workers = await harness.snapshot(WorkersDoc, root.id, context);
    expect(workers?.workers.map((worker) => worker.name).sort()).toEqual(["a", "b"]);
    expect(new Set(workers?.deliveries.map((delivery) => delivery.requestId)).size).toBe(2);
    for (const delivery of workers?.deliveries ?? [])
      await harness.waitForTask(delivery.taskId, context);
    await harness.close(context);
  });

  it("reports script and nested tool failures as an error result", async () => {
    const value = await setup();
    route(
      value.faux,
      callTools({
        throws: { tool: "codemode", args: { code: `throw new Error("boom")` } },
        nested: { tool: "codemode", args: { code: `await tools.read({ path: "missing.txt" })` } },
      }),
    );
    const { harness, root } = await open(value);
    for (const message of ["throws", "nested"])
      await (await root.submit({ type: "input", content: message }, context)).wait(context);

    const [thrown, nested] = await toolResults(root);
    expect(thrown?.isError).toBe(true);
    expect(textOf(thrown)).toContain("boom");
    expect(nested?.isError).toBe(true);
    expect(textOf(nested)).toContain("missing.txt");
    await harness.close(context);
  });
});
