import { createProvider } from "@earendil-works/pi-ai";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Monchu } from "../src/backend.ts";
import { openDevMonchu } from "../src/dev-faux.ts";
import { loadConfig } from "../src/config.ts";
import { monchuHome } from "../src/home.ts";
import { runTerminal } from "../src/tui/app.ts";
import { cleanup, fauxRole, prepareHome, setup, waitFor } from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function withTerminal(
  columns: number,
  theme: string,
  test: (screen: VirtualTerminal, backend: Monchu, home: string) => Promise<void>,
): Promise<void> {
  await setup();
  const home = await mkdtemp(join(tmpdir(), "monchu-smoke-"));
  prepareHome(home);
  const screen = new VirtualTerminal(columns, 40);
  let backend: Monchu | undefined;
  let running: Promise<void> | undefined;
  try {
    process.env.MONCHU_DEV_HOME = home;
    await mkdir(join(home, "memories"));
    await mkdir(join(home, "skills"));
    for (const file of [
      "SOUL.md",
      "AGENTS.md",
      "DEVICES.md",
      "memories/USER.md",
      "memories/MEMORY.md",
    ])
      await writeFile(join(home, file), "Smoke home context");
    backend = await openDevMonchu(await monchuHome(true));
    const config = await loadConfig(home);
    await writeFile(join(home, "config.json"), JSON.stringify({ ...config, settings: { theme } }));
    await backend.reload();
    running = runTerminal(backend, screen);
    await Promise.race([waitFor(() => screen.started), running]);
    await visible(screen, "Monchu · /help");
    await test(screen, backend, home);
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
        await cleanup();
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
  try {
    process.env.MONCHU_DEV_HOME = join(homedir(), ".monchu");
    await expect(monchuHome(true)).rejects.toThrow("MONCHU_DEV_HOME must be");
  } finally {
    if (previousHome === undefined) delete process.env.MONCHU_DEV_HOME;
    else process.env.MONCHU_DEV_HOME = previousHome;
  }
});

it("shows reload errors, retains settings on failure, and recovers on the next reload", async () => {
  await withTerminal(60, "dark", async (screen, backend, home) => {
    const path = join(home, "config.json");
    const original = await readFile(path, "utf8");
    const settings = backend.settings;
    await writeFile(
      path,
      JSON.stringify({
        settings: { theme: "light" },
        front: { provider: "missing", modelId: "missing" },
      }),
    );
    send(screen, "/reload");
    await visible(screen, "no configured model");
    expect(backend.settings).toBe(settings);
    expect(backend.settings.theme).toBe("dark");
    await writeFile(path, original);
    send(screen, "/reload");
    await visible(screen, "reloaded · context");
    send(screen, "hello");
    await visible(screen, "DONE");
  });
}, 30_000);

it("clears the editor on Ctrl-C without aborting the front, and exits on a quick second press", async () => {
  await withTerminal(60, "dark", async (screen) => {
    screen.sendInput("draft");
    await visible(screen, "draft");
    screen.sendInput("\x03");
    await waitFor(async () => !(await screen.flushAndGetViewport()).join("\n").includes("draft"));
    // Outside the 500 ms double-press window, Ctrl-C only clears again.
    await new Promise((resolve) => setTimeout(resolve, 600));
    screen.sendInput("\x03");
    const cleared = (await screen.flushAndGetViewport()).join("\n");
    expect(cleared).not.toContain("front stopped");
    expect(screen.stopped).toBe(false);
    screen.sendInput("\x03");
    await waitFor(() => screen.stopped);
  });
});

it("ignores Esc while the front is idle and interrupts it while it runs", async () => {
  await withTerminal(60, "dark", async (screen) => {
    screen.sendInput("\x1b");
    // An idle abort would have posted its notice well within this window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await screen.flushAndGetViewport()).join("\n")).not.toContain("front stopped");
    send(screen, "hello");
    await visible(screen, "Faux reply:");
    screen.sendInput("\x1b");
    const stopped = await visible(screen, "front stopped; workers continue");
    expect(stopped.join("\n")).not.toContain("DONE");
  });
});

it("keeps Cloudflare login prompts out of chat, editor history and raw terminal output", async () => {
  const value = await setup({ provider: "cloudflare-workers-ai" });
  const home = join(value.directory, "home");
  await mkdir(home);
  const role = { ...fauxRole, provider: "cloudflare-workers-ai" };
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: role, worker: role, classifier: null }),
  );
  const provider = createProvider({
    id: value.faux.provider.id,
    models: value.faux.models,
    api: value.faux.provider,
    auth: {
      apiKey: {
        name: "Faux Cloudflare",
        resolve: async () => ({ auth: {} }),
        login: async (interaction) => {
          const key = await interaction.prompt({ type: "secret", message: "Enter test API key" });
          const account = await interaction.prompt({
            type: "text",
            message: "Enter test account ID",
          });
          if (account === "fail") throw new Error(`Provider failure containing ${key}`);
          return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: account } };
        },
      },
    },
  });
  prepareHome(home);
  const backend = await Monchu.open(home, provider);
  const screen = new VirtualTerminal(60, 40);
  const running = runTerminal(backend, screen);
  const state = await backend.viewState();
  try {
    await visible(screen, "Monchu · /help");
    send(screen, "/login");
    await visible(screen, "Choose provider:");
    screen.sendInput("\x1b[B");
    screen.sendInput("\r");
    await visible(screen, "Enter test API key");
    screen.sendInput("private-key-123");
    const masked = await visible(screen, "•••");
    expect(masked.join("\n")).not.toContain("private-key-123");
    screen.sendInput("\r");
    await visible(screen, "Enter test account ID");
    send(screen, "test-account");
    await visible(screen, "logged in · cloudflare-workers-ai");
    expect(state.value.entries).toEqual([]);
    screen.sendInput("\x1b[A");
    const history = await visible(screen, "/login");
    expect(history.join("\n")).not.toContain("private-key-123");
    expect(history.join("\n")).not.toContain("test-account");
    screen.sendInput("\x05"); // move to the history entry end before clearing it
    screen.sendInput("\x15");
    const auth: unknown = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    expect(auth).toMatchObject({ "cloudflare-workers-ai": { key: "private-key-123" } });
    // Raw provider errors must not echo the submitted key, even after another login fails.
    send(screen, "/login");
    await visible(screen, "Choose provider:");
    screen.sendInput("\x1b[B");
    screen.sendInput("\r");
    await visible(screen, "Enter test API key");
    send(screen, "never-echo-key");
    await visible(screen, "Enter test account ID");
    send(screen, "fail");
    const failed = await visible(screen, "login failed");
    expect(failed.join("\n")).not.toContain("never-echo-key");
    expect(screen.output).not.toContain("private-key-123");
    expect(screen.output).not.toContain("never-echo-key");
    expect(state.value.entries).toEqual([]);
  } finally {
    state.dispose();
    process.emit("SIGTERM");
    await running;
    await backend.close();
    await cleanup();
  }
}, 30_000);

it("offers /login on a fresh home without credentials and cancels without calling a provider", async () => {
  const value = await setup();
  const home = join(value.directory, "fresh");
  prepareHome(home);
  const backend = await Monchu.open(home);
  const screen = new VirtualTerminal(40, 32);
  const running = runTerminal(backend, screen);
  try {
    await visible(screen, "Monchu · /help");
    send(screen, "/login");
    await visible(screen, "Choose provider:");
    screen.sendInput("\x1b");
    await visible(screen, "login cancelled");
    const auth: unknown = JSON.parse(await readFile(join(backend.home, "auth.json"), "utf8"));
    expect(auth).toEqual({});
  } finally {
    send(screen, "/quit");
    await running;
    await backend.close();
    await cleanup();
  }
});

it("logs in to Claude Code with a setup-token from /login", async () => {
  const value = await setup();
  const home = join(value.directory, "claude");
  prepareHome(home);
  const backend = await Monchu.open(home);
  const screen = new VirtualTerminal(60, 32);
  const running = runTerminal(backend, screen);
  try {
    await visible(screen, "Monchu · /help");
    send(screen, "/login");
    await visible(screen, "Choose provider:");
    screen.sendInput("\x1b[B");
    screen.sendInput("\x1b[B");
    screen.sendInput("\r");
    await visible(screen, "Paste a Claude Code setup-token");
    send(screen, "sk-ant-oat01-private-token");
    await visible(screen, "logged in · claude-code");
    expect(screen.output).not.toContain("sk-ant-oat01-private-token");
    const auth: unknown = JSON.parse(await readFile(join(backend.home, "auth.json"), "utf8"));
    expect(auth).toMatchObject({ "claude-code": { access: "sk-ant-oat01-private-token" } });
  } finally {
    send(screen, "/quit");
    await running;
    await backend.close();
    await cleanup();
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

  it("labels worker updates/reports, selects and messages a worker, and shows reload success", async () => {
    await withTerminal(columns, theme, async (screen) => {
      send(screen, "/work reader inspect");
      await visible(screen, "worker · reader · update");
      await visible(screen, "Faux worker progress: checking.");
      await visible(screen, "worker · reader · completed");
      await visible(screen, "Faux front: result received.");
      await visible(screen, "Workers · 1 idle · /agents");
      // Overflow the transcript so the row above the bar is the last message's timestamp, not filler.
      screen.resize(columns, 14);
      let docked: string[] = [];
      await waitFor(async () => {
        docked = await screen.flushAndGetViewport();
        return (
          docked.some((line) => line.includes("result received.")) &&
          docked.some((line) => line.includes("Workers · 1 idle"))
        );
      });
      const bar = docked.findIndex((line) => line.includes("Workers · 1 idle"));
      // A blank row separates the bar from the last message's timestamp.
      expect(docked[bar - 1]?.trim()).toBe("");
      expect(docked[bar - 2]).toMatch(/\d{4}, \d+:\d{2}/);
      // The footer keeps the view and model but drops the command hints.
      const footer = docked.findLast((line) => line.includes("root · "));
      expect(footer).toBeDefined();
      expect(footer).not.toContain("/agents");
      expect(footer).not.toContain("/help");
      screen.resize(columns, 40);
      send(screen, "/agents");
      const panel = await visible(screen, "View and talk to");
      // The menu lists each worker with its status, behind the dock's compact counts.
      expect(panel.join("\n")).toContain("reader · idle");
      screen.sendInput("reader"); // filter, then select with the actual keyboard path
      screen.sendInput("\r");
      await visible(screen, "worker: reader");
      send(screen, "more");
      await visible(screen, "received · worker reader");
      await waitFor(async () => {
        const lines = await screen.flushAndGetViewport();
        // The worker answers the new message; its first answer may have scrolled above it.
        const more = lines.findIndex((line) => line.trim() === "more");
        return (
          more !== -1 &&
          lines.slice(more).some((line) => line.includes("Faux worker result: done."))
        );
      });
      send(screen, "/agents root");
      await visible(screen, "root · front");
      send(screen, "/reload");
      await visible(screen, "reloaded · context");
      expect(screen.stopped).toBe(false);
    });
  }, 30_000);
});
