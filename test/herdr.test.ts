import type { JsonObject } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdr, type HerdrHost } from "../src/herdr.ts";
import { callTools, cleanup, context, open, route, setup, toolResults } from "./support.ts";

afterEach(cleanup);

const local = { kind: "local" };
const session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/task/session.jsonl" };
const agent = {
  pane_id: "wM:pB",
  workspace_id: "wM",
  tab_id: "wM:tC",
  terminal_id: "term_test",
  cwd: "/task",
  foreground_cwd: "/task",
  focused: false,
  revision: 3,
  agent: "pi",
  name: "worker",
  agent_status: "idle",
  interactive_ready: true,
  agent_session: session,
};
const { name: _name, interactive_ready: _ready, ...pane } = agent;
const expected = {
  workspace_id: agent.workspace_id,
  terminal_id: agent.terminal_id,
  cwd: agent.cwd,
  agent_session: session,
};
const owned = [{ pane_id: agent.pane_id, terminal_id: agent.terminal_id, agent_session: session }];
const reply = (result: JsonObject) => ({ stdout: JSON.stringify({ id: "1", result }) });

type Step = { stdout: string; stderr?: string; code?: number };

// Records argv and stdin, then answers with the next planned Herdr CLI response; no live Herdr is called.
const FIXTURE = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const count = existsSync(join(root, "count")) ? Number(readFileSync(join(root, "count"), "utf8")) : 0;
writeFileSync(join(root, "count"), String(count + 1));
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
const step = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"))[count];
if (!step) { process.stderr.write("unexpected fixture command"); process.exit(99); }
process.stdout.write(step.stdout);
process.stderr.write(step.stderr ?? "", () => process.exit(step.code ?? 0));
`;

async function herdr(directory: string, plan: Step[], env: HerdrHost["env"]) {
  const fixture = join(directory, "herdr-fixture.mjs");
  await writeFile(fixture, FIXTURE);
  await writeFile(join(directory, "plan.json"), JSON.stringify(plan));
  return createHerdr({ command: { executable: process.execPath, args: [fixture] }, env });
}

async function calls(directory: string): Promise<string[][]> {
  const path = join(directory, "calls.jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line): string[] => {
      const value: unknown = JSON.parse(line);
      if (!Array.isArray(value)) throw new Error("Fixture call is not argv");
      return value.map(String);
    });
}

function details(result: ToolResultMessage | undefined): unknown {
  return result?.details;
}

async function call(plan: Step[], env: HerdrHost["env"], request: JsonObject) {
  const value = await setup();
  value.registry.install(await herdr(value.directory, plan, env));
  route(value.faux, callTools({ go: { tool: "herdr", args: { route: local, request } } }));
  const { harness, root } = await open(value);
  try {
    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
    const [result] = await toolResults(root);
    return {
      isError: result?.isError,
      details: details(result),
      calls: await calls(value.directory),
    };
  } finally {
    await harness.close(context);
  }
}

const inside = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/herdr.sock", HERDR_PANE_ID: "w1:p1" };

describe("herdr", () => {
  it("declares one object schema and is never replayed", async () => {
    const value = await setup();
    const tools = (await herdr(value.directory, [], {})).tools ?? [];
    expect(tools.map((tool) => [tool.name, tool.parameters.type, tool.replay])).toEqual([
      ["herdr", "object", "unsafe"],
    ]);
  });

  it("refuses the local route outside Herdr without running anything", async () => {
    const result = await call([], {}, { operation: "workspace_list" });
    expect(result).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "local_route_unavailable", stage: "routing" } },
      calls: [],
    });
  });

  it("launches, retries a busy pane, verifies the agent and submits the task as argv", async () => {
    const created = { ...pane, agent: null, agent_session: null, agent_status: "unknown" };
    const claudeSession = { ...session, source: "herdr:claude", agent: "claude" };
    const claude = { ...agent, agent: "claude", agent_session: claudeSession };
    const result = await call(
      [
        reply({ type: "workspace_created", root_pane: created }),
        {
          stdout: "",
          stderr: JSON.stringify({ id: "1", error: { code: "agent_pane_busy", message: "busy" } }),
          code: 1,
        },
        reply({ type: "agent_started", agent: claude }),
        reply({ type: "agent_info", agent: claude }),
        reply({ type: "agent_prompted", agent: { ...claude, agent_status: "done" } }),
      ],
      inside,
      {
        operation: "agent_launch",
        location: { kind: "workspace", label: "Task" },
        cwd: "/task",
        name: "worker",
        harness: { kind: "claude", model: "opus", intent: "planning" },
        task: { text: "Plan it; don't 'quote' $HOME" },
      },
    );
    expect(result).toMatchObject({
      isError: false,
      details: {
        ok: true,
        data: {
          operation: "agent_launch",
          expected: { ...expected, agent_session: claudeSession },
          retire: {
            target: { kind: "workspace", workspace_id: "wM" },
            panes: [{ ...owned[0], agent_session: claudeSession }],
          },
          task: "activity_observed_and_settled",
        },
      },
    });
    expect(result.calls.map((argv) => argv.slice(0, 2))).toEqual([
      ["workspace", "create"],
      ["agent", "start"],
      ["agent", "start"],
      ["agent", "get"],
      ["agent", "prompt"],
    ]);
    expect(result.calls[0]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/task",
      "--label",
      "Task",
      "--no-focus",
    ]);
    expect(result.calls[2]).toEqual(
      expect.arrayContaining([
        "--kind",
        "claude",
        "--",
        "--model",
        "opus",
        "--permission-mode",
        "plan",
      ]),
    );
    expect(result.calls[4]?.slice(0, 4)).toEqual([
      "agent",
      "prompt",
      "wM:pB",
      "Plan it; don't 'quote' $HOME",
    ]);
  });

  it("refuses to prompt a pane whose terminal changed, before submitting", async () => {
    const result = await call(
      [reply({ type: "agent_info", agent: { ...agent, terminal_id: "term_other" } })],
      inside,
      { operation: "agent_prompt", pane_id: agent.pane_id, text: "Next step", expected },
    );
    expect(result).toMatchObject({
      isError: true,
      details: {
        error: {
          code: "identity_changed",
          stage: "preflight",
          mutations: { submission: "not_attempted" },
        },
      },
    });
    expect(result.calls).toHaveLength(1);
  });

  it("closes nothing when the scope holds a terminal the task does not own", async () => {
    const result = await call(
      [
        reply({
          type: "pane_list",
          panes: [pane, { ...pane, pane_id: "wM:pD", terminal_id: "term_stranger" }],
        }),
      ],
      inside,
      {
        operation: "task_retire",
        target: { kind: "workspace", workspace_id: "wM" },
        panes: owned,
      },
    );
    expect(result).toMatchObject({
      isError: true,
      details: { error: { code: "ownership_mismatch", mutations: { close: "not_attempted" } } },
    });
    expect(result.calls).toEqual([["pane", "list", "--workspace", "wM"]]);
  });
});
