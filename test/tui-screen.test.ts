import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Monchu } from "../src/backend.ts";
import { openDevMonchu } from "../src/dev-faux.ts";
import { runTerminal } from "../src/tui/app.ts";
import { waitFor } from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function withTerminal(
  columns: number,
  theme: string,
  test: (screen: VirtualTerminal, agentDir: string) => Promise<void>,
): Promise<void> {
  const previousHome = process.env.MONCHU_DEV_HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(tmpdir(), "monchu-smoke-"));
  const agentDir = join(home, "agent");
  const screen = new VirtualTerminal(columns, 40);
  let backend: Monchu | undefined;
  let running: Promise<void> | undefined;
  try {
    process.env.MONCHU_DEV_HOME = home;
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme }));
    backend = await openDevMonchu();
    running = runTerminal(backend, screen);
    await Promise.race([waitFor(() => screen.started), running]);
    await visible(screen, "Monchu · /help");
    await test(screen, agentDir);
  } finally {
    try {
      if (running !== undefined) {
        send(screen, "/quit");
        await running;
      }
    } finally {
      try {
        await backend?.close();
      } finally {
        if (previousHome === undefined) delete process.env.MONCHU_DEV_HOME;
        else process.env.MONCHU_DEV_HOME = previousHome;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(home, { recursive: true, force: true });
      }
    }
  }
  expect(screen.stopped).toBe(true);
}

function send(screen: VirtualTerminal, text: string): void {
  screen.sendInput(text);
  screen.sendInput("\r");
}

async function visible(screen: VirtualTerminal, text: string): Promise<string[]> {
  let lines: string[] = [];
  try {
    await waitFor(async () => {
      lines = await screen.flushAndGetViewport();
      return lines.join("\n").includes(text);
    });
  } catch (error) {
    throw new Error(`Missing visible text ${JSON.stringify(text)}:\n${lines.join("\n")}`, {
      cause: error,
    });
  }
  return lines;
}

it("rejects the real Monchu home before configuring resources or opening storage in dev mode", async () => {
  const previousHome = process.env.MONCHU_DEV_HOME;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.MONCHU_DEV_HOME = join(homedir(), ".monchu");
    await expect(openDevMonchu()).rejects.toThrow("MONCHU_DEV_HOME must be");
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  } finally {
    if (previousHome === undefined) delete process.env.MONCHU_DEV_HOME;
    else process.env.MONCHU_DEV_HOME = previousHome;
  }
});

// Transport emulation only: entry commands, Monchu, Durable, models, and tools are real.
describe.each([
  { columns: 40, theme: "dark" },
  { columns: 40, theme: "light" },
  { columns: 60, theme: "dark" },
  { columns: 60, theme: "light" },
])("visible TUI at $columns columns ($theme)", ({ columns, theme }) => {
  it("keeps streaming above an available editor, renders a tool, and resizes without stale content", async () => {
    await withTerminal(columns, theme, async (screen) => {
      send(screen, "hello");
      const partial = await visible(screen, "Faux reply:");
      expect(partial.join("\n")).not.toContain("DONE");
      expect(partial.join("\n")).toContain("Working");
      // The old readline prompt was emitted before the answer had finished.
      expect(partial.join("\n")).not.toContain("you>");
      screen.sendInput("draft");
      const editing = await visible(screen, "draft");
      expect(editing.findIndex((line) => line.includes("draft"))).toBeGreaterThan(
        editing.findIndex((line) => line.includes("Faux reply:")),
      );
      let answer = "";
      await waitFor(async () => {
        answer = (await screen.flushAndGetViewport()).join("\n");
        expect(answer).not.toContain("you>");
        return answer.includes("DONE") && !answer.includes("Working");
      });
      expect(answer.match(/Faux reply:/g)).toHaveLength(1);
      screen.sendInput("\x15"); // clear the unsubmitted draft
      send(screen, "read");
      await visible(screen, "missing-file.txt");
      const tools = await visible(screen, "Faux tool finished.");
      expect(tools.join("\n")).toContain("ENOENT");
      screen.resize(columns === 40 ? 60 : 40, 28);
      await waitFor(async () => {
        const lines = await screen.flushAndGetViewport();
        const borders = lines.filter((line) => line.trim().startsWith("─"));
        return borders.length === 2 && borders.every((line) => line.length === screen.columns);
      });
      const resized = await visible(screen, "Faux tool finished.");
      expect(resized).toHaveLength(28);
      expect(resized.join("\n")).toContain("missing-file.txt");
      expect(
        resized.filter((line) => line.trim().startsWith("─")).map((line) => line.length),
      ).toEqual([screen.columns, screen.columns]);
      screen.resize(columns, 40);
      await visible(screen, "Faux reply:");
    });
  }, 30_000);

  it("labels worker updates/reports, selects and messages a worker, and shows reload success/errors", async () => {
    await withTerminal(columns, theme, async (screen, agentDir) => {
      send(screen, "/work reader inspect");
      await visible(screen, "worker · reader · update");
      await visible(screen, "Faux worker progress: checking.");
      await visible(screen, "worker · reader · completed");
      await visible(screen, "Faux front: result received.");
      await visible(screen, "reader: idle");
      send(screen, "/agents");
      const panel = await visible(screen, "View and talk to");
      expect(panel.join("\n")).toContain("reader");
      screen.sendInput("reader"); // filter, then select with the actual keyboard path
      screen.sendInput("\r");
      await visible(screen, "worker: reader");
      send(screen, "more");
      await visible(screen, "received · worker reader");
      await waitFor(async () => {
        const lines = await screen.flushAndGetViewport();
        return (
          lines.some((line) => line.trim() === "more") &&
          lines.join("\n").match(/Faux worker result: done\./g)?.length === 2
        );
      });
      send(screen, "/agents root");
      await visible(screen, "root · front");
      send(screen, "/reload");
      await visible(screen, "reloaded · context");
      await writeFile(join(agentDir, "settings.json"), "{");
      send(screen, "/reload");
      await visible(screen, "error · Pi settings failed");
      expect(screen.stopped).toBe(false);
    });
  }, 30_000);
});
