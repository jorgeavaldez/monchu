import { createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Monchu } from "../src/backend.ts";
import { openDevMonchu } from "../src/dev-faux.ts";
import { loadConfig } from "../src/config.ts";
import { monchuHome } from "../src/home.ts";
import { runTerminal } from "../src/tui/app.ts";
import {
  cleanup,
  fauxRole,
  lastMessage,
  prepareHome,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";
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
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ ...config, settings: { theme }, chosen: undefined }),
    );
    await backend.reload();
    running = runTerminal(backend, screen);
    await Promise.race([waitFor(() => screen.started), running]);
    await visible(screen, "Monchu · /help");
    await test(screen, backend, home);
  } finally {
    try {
      if (running !== undefined) {
        // Ctrl-C closes a panel a failed test left open, or clears the editor, so /quit reaches the editor.
        screen.sendInput("\x03");
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
        bogus: 1,
      }),
    );
    send(screen, "/reload");
    await visible(screen, "unknown fields: bogus");
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

it("drops a closed worker from the roster at once and returns its selected view to the root", async () => {
  await withTerminal(60, "dark", async (screen, backend) => {
    send(screen, "/work reader inspect");
    await visible(screen, "Faux front: result received.");
    await visible(screen, "Workers · ○ 1 idle · /agents");
    send(screen, "/agents reader");
    await visible(screen, "• reader");
    // The dock counts a worker idle once its run ends; closing also waits for its report's delivery to finish.
    await waitFor(async () => (await backend.workers())[0]?.busy === false);
    // Plain input goes to the shown worker, so the front's close goes through the backend seam the editor uses.
    await backend.submit("close reader", "close-reader", "followUp");
    const back = await visible(screen, "worker reader closed · back to root");
    expect(back.join("\n")).toContain("• root");
    await waitFor(
      async () => !(await screen.flushAndGetViewport()).join("\n").includes("Workers ·"),
    );
    expect(await backend.workers()).toEqual([]);
    send(screen, "/agents reader");
    await visible(screen, "No worker named reader");
    // The editor stays usable and talks to the root.
    send(screen, "hello");
    await visible(screen, "Faux reply: hello");
    expect(screen.stopped).toBe(false);
  });
}, 30_000);

it("drills down from /model to a conversation or role default, and saves a role default with Ctrl+S", async () => {
  await withTerminal(60, "dark", async (screen, backend, home) => {
    const path = join(home, "config.json");
    // The worker default is set without any worker, and the root keeps its model.
    send(screen, "/model");
    const menu = (await visible(screen, "Pick the model of")).join("\n");
    expect(menu).toMatch(/root[\s\S]*front default[\s\S]*worker default/);
    screen.sendInput("worker default");
    screen.sendInput("\r");
    await visible(screen, "Only showing models from configured providers");
    screen.sendInput("front");
    await visible(screen, "→   front [faux]");
    screen.sendInput("\r");
    await visible(screen, "worker default model · faux/front · saved");
    expect((await loadConfig(home)).worker.modelId).toBe("front");
    expect((await backend.modelChoice()).model?.id).toBe("front");
    send(screen, "/thinking");
    await visible(screen, "Pick the thinking level of");
    screen.sendInput("worker default");
    screen.sendInput("\r");
    await visible(screen, "Thinking Level");
    screen.sendInput("\r");
    await visible(screen, "worker default thinking · ");
    await backend.saveDefault("worker", { model: { provider: "faux", modelId: "worker" } });

    const written = await readFile(path, "utf8");
    send(screen, "/model");
    await visible(screen, "Pick the model of");
    screen.sendInput("\r");
    const picker = await visible(screen, "Only showing models from configured providers");
    // As in Pi: the current model first, marked, then the default; the key hints below.
    const rows = picker.filter((line) => line.includes("[faux]"));
    expect(rows[0]).toMatch(/→ ✓ front \[faux\] · default/);
    expect(rows[1]).toMatch(/^\s+worker \[faux\]/);
    expect(picker.join("\n")).toContain("Enter to select · Ctrl+S to set as default");
    screen.sendInput("\x1b[B");
    screen.sendInput("\r");
    const picked = await visible(screen, "root model · faux/worker · this conversation only");
    expect(picked.slice(-2).join("\n")).toMatch(/• root[\s\S]*worker\s*$/);
    expect(await readFile(path, "utf8")).toBe(written);
    // The picked model now leads, ahead of the default; the dev front model answers as the root again.
    send(screen, "/model");
    await visible(screen, "Pick the model of");
    screen.sendInput("\r");
    const repicked = (await visible(screen, "→ ✓ worker [faux]")).filter((line) =>
      line.includes("[faux]"),
    );
    expect(repicked[1]).toMatch(/^\s+front \[faux\] · default/);
    screen.sendInput("\x1b[B");
    screen.sendInput("\r");
    await visible(screen, "root model · faux/front");
    // A worker's pick goes to that worker; Ctrl+S also saves the worker default.
    send(screen, "/work reader inspect");
    await visible(screen, "Faux front: result received.");
    send(screen, "/agents reader");
    expect((await visible(screen, "• reader")).at(-1)).toMatch(/worker\s*$/);
    // The shown worker leads the menu.
    send(screen, "/model");
    await visible(screen, "Pick the model of");
    screen.sendInput("\r");
    await visible(screen, "→ ✓ worker [faux] · default");
    screen.sendInput("front");
    await visible(screen, "→   front [faux]");
    screen.sendInput("\x13");
    const saved = await visible(screen, "reader model · faux/front · saved as worker");
    expect(saved.slice(-2).join("\n")).toMatch(/• reader[\s\S]*front\s*$/);
    expect((await loadConfig(home)).worker.modelId).toBe("front");
    expect((await loadConfig(home)).front.modelId).toBe("front");
    expect((await backend.modelChoice()).model?.id).toBe("front");
    send(screen, "/thinking");
    await visible(screen, "Pick the thinking level of");
    screen.sendInput("\r");
    await visible(screen, "Thinking Level");
    screen.sendInput("\x1b");
    await waitFor(
      async () => !(await screen.flushAndGetViewport()).join("\n").includes("Thinking Level"),
    );
  });
}, 30_000);

describe.each(["root", "worker"])("queued input to the %s shown", (target) => {
  it("steers a running reply in Alt+S steer mode and queues a follow-up otherwise", async () => {
    const value = await setup();
    const release = Promise.withResolvers<void>();
    // The user messages of each request in the held conversation, whose first message is `hold`.
    const requests: string[][] = [];
    route(value.faux, async (request) => {
      const users = request.messages.flatMap((message) =>
        message.role === "user" ? [textOf(message)] : [],
      );
      if (users[0] === "hold") requests.push(users);
      if (textOf(lastMessage(request.messages)) === "hold") {
        await release.promise;
        return fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage(`answered ${users.at(-1)}`);
    });
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    const backend = await Monchu.open(home, value.faux.provider);
    const screen = new VirtualTerminal(60, 40);
    const running = runTerminal(backend, screen);
    try {
      await visible(screen, "Monchu · /help");
      if (target === "root") send(screen, "hold");
      else {
        await backend.startWorker("w", "hold", "start:w");
        send(screen, "/agents w");
        await visible(screen, "• w ");
      }
      await waitFor(() => requests.length === 1);
      screen.sendInput("\x1bs");
      await visible(screen, "steer (Alt+S)");
      send(screen, "steer note");
      await visible(screen, "│ you · steer · steer note");
      screen.sendInput("\x1bs");
      await visible(screen, "follow-up (Alt+S)");
      send(screen, "later note");
      const queued = await visible(screen, "│ you · follow-up · later note");
      // The editor is cleared on send; only the dock shows the queued text.
      expect(queued.filter((line) => line.includes("later note"))).toHaveLength(1);
      release.resolve();
      await visible(screen, "answered later note");
      // The steer joins the running reply after its tool result; the follow-up waits until that reply is done.
      expect(requests).toEqual([
        ["hold"],
        ["hold", "steer note"],
        ["hold", "steer note", "later note"],
      ]);
      // While idle, a message sends at once in either mode.
      screen.sendInput("\x1bs");
      send(screen, "idle note");
      await visible(screen, "answered idle note");
      expect(requests.at(-1)?.at(-1)).toBe("idle note");
    } finally {
      release.resolve();
      send(screen, "/quit");
      await running;
      await backend.close();
      await cleanup();
    }
  }, 30_000);
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

it("keeps notices beside their entries through compaction and says the context was compacted", async () => {
  const value = await setup();
  route(value.faux, () => fauxAssistantMessage("noted"));
  await writeFile(
    join(value.directory, "config.json"),
    JSON.stringify({
      front: fauxRole,
      worker: fauxRole,
      classifier: null,
      settings: { compaction: { keepRecentTokens: 1 } },
    }),
  );
  const backend = await Monchu.open(value.directory, value.faux.provider);
  const screen = new VirtualTerminal(60, 40);
  const running = runTerminal(backend, screen);
  try {
    await visible(screen, "Monchu · /help");
    for (const [index, text] of ["first", "second"].entries()) {
      send(screen, text);
      await waitFor(async () => {
        const chat = (await screen.flushAndGetViewport()).join("\n");
        return chat.match(/noted/g)?.length === index + 1;
      });
    }
    send(screen, "/compact");
    const lines = await visible(screen, "system · context compacted · manual");
    const chat = lines.map((line) => line.trim()).filter(Boolean);
    // Only the kept reply remains; the notices about summarized entries are not replayed beneath it.
    expect(chat[0]).toBe("[Earlier context summarized]");
    expect(chat[1]).toBe("noted");
    expect(chat.slice(3, 5)).toEqual([
      "system · compaction started",
      "system · context compacted · manual",
    ]);
    expect(chat.join("\n")).not.toMatch(/Monchu · \/help|received · root/);
  } finally {
    send(screen, "/quit");
    await running;
    await backend.close();
    await cleanup();
  }
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
}, 30_000);

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
    screen.sendInput("\r");
    await visible(screen, "claude setup-token");
    send(screen, "sk-ant-oat01-private-token");
    await visible(screen, "logged in · claude-code");
    // No role is chosen in config.json, so the front follows the provider just logged in to.
    await visible(screen, "claude-sonnet-5-5");
    expect(screen.output).not.toContain("sk-ant-oat01-private-token");
    const auth: unknown = JSON.parse(await readFile(join(backend.home, "auth.json"), "utf8"));
    expect(auth).toMatchObject({ "claude-code": { access: "sk-ant-oat01-private-token" } });
  } finally {
    send(screen, "/quit");
    await running;
    await backend.close();
    await cleanup();
  }
}, 30_000);

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

  it("lists /goals concisely above the footer, drills into a goal, scrolls on resize, and closes back to the editor", async () => {
    await withTerminal(columns, theme, async (screen) => {
      send(screen, "goal");
      await visible(screen, "Faux tool finished.");
      send(screen, "/goals");
      const panel = await visible(screen, "Goals · 1 open");
      const title = panel.findIndex((line) => line.includes("Goals · 1 open"));
      // Pinned in the editor's place: below the transcript, directly above the footer; never a chat notice.
      expect(title).toBeGreaterThan(
        panel.findIndex((line) => line.includes("Faux tool finished.")),
      );
      const answered = panel.findIndex((line) => line.includes("Faux tool finished."));
      expect(panel.slice(answered + 1, title).join("\n")).not.toMatch(/smoke|system ·/i);
      // One row per goal; the next step shows only in the goal's detail view.
      // A goal that existed when /goals was first opened is not news.
      expect(panel[title + 1]).toMatch(/^› ● Smoke goal\s+\d+s\s*$/);
      expect(panel.slice(title).join("\n")).not.toContain("first step");
      expect(panel[title + 3]?.trim()).toMatch(/^─+$/);
      expect(panel[title + 4]).toContain("• root");
      // Typing goes to the panel, not the editor; Enter drills into the goal.
      screen.sendInput("z");
      screen.sendInput("\r");
      const detail = await visible(screen, "Esc back");
      expect(detail.join("")).not.toContain("\r");
      expect(detail.join("\n")).toMatch(/active · endeavor · \d+s ago/);
      // Each stored line break, CRLF or LF, becomes its own row under its heading; a wrapped field keeps its indent.
      const next = detail.findIndex((line) => line.trim() === "Next");
      for (const [index, step] of ["first", "second", "third", "fourth", "fifth"].entries())
        expect(detail[next + 1 + index]).toMatch(new RegExp(`^ {3}${step} step\\s*$`));
      const now = detail.findIndex((line) => line.trim() === "Now");
      expect(detail[now + 1]).toMatch(/^ {3}Checking/);
      expect(detail[now + 2]).toMatch(/^ {3}\S/);
      // Just the goal: now, then next; no workers, project or vault.
      expect(detail.findIndex((line) => line.trim() === "Now")).toBeLessThan(next);
      expect(detail.slice(next).join("\n")).not.toMatch(
        /Workers|reader|Vault|projects\/smoke|Project/,
      );
      // A short terminal caps the panel and scrolls it.
      screen.resize(columns, 14);
      const short = await visible(screen, "1-4 of");
      expect(short).toHaveLength(14);
      expect(short.at(-2)).toContain("• root");
      screen.sendInput("\x1b[B");
      await visible(screen, "2-5 of");
      screen.resize(columns, 40);
      // Esc goes back to the list, then closes it.
      screen.sendInput("\x1b");
      await visible(screen, "Goals · 1 open");
      screen.sendInput("\x1b");
      await waitFor(
        async () => !(await screen.flushAndGetViewport()).join("\n").includes("Goals · 1 open"),
      );
      const closed = await screen.flushAndGetViewport();
      const done = closed.findIndex((line) => line.includes("Faux tool finished."));
      expect(closed.slice(done + 1).join("\n")).not.toMatch(/smoke|system ·|Goals/i);
      screen.sendInput("draft");
      const editing = await visible(screen, "draft");
      expect(editing.join("\n")).not.toContain("zdraft");
      screen.sendInput("\x03");
      // q closes it too, from the list or a goal.
      send(screen, "/goals");
      await visible(screen, "Goals · 1 open");
      screen.sendInput("\r");
      await visible(screen, "Esc back");
      screen.sendInput("q");
      await waitFor(
        async () => !(await screen.flushAndGetViewport()).join("\n").includes("Esc back"),
      );
      // A goal changed since it was last opened gets a dot until opened; a waiting goal says so in yellow.
      send(screen, "goal waiting");
      await waitFor(async () => {
        const lines = await screen.flushAndGetViewport();
        return lines.filter((line) => line.includes("Faux tool finished.")).length === 2;
      });
      send(screen, "/goals");
      const changed = await visible(screen, "1 waiting");
      expect(changed.findLast((line) => line.includes("Smoke goal"))).toMatch(
        /^› ◐ Smoke goal\s+• wait \d+s\s*$/,
      );
      screen.sendInput("\r");
      await visible(screen, "Esc back");
      screen.sendInput("\x1b");
      const opened = await visible(screen, "1 waiting");
      expect(opened.findLast((line) => line.includes("Smoke goal"))).toMatch(
        /^› ◐ Smoke goal\s+wait \d+s\s*$/,
      );
      screen.sendInput("q");
      // Opened stays opened: the next /goals has no dot.
      send(screen, "/goals");
      const again = await visible(screen, "1 waiting");
      expect(again.findLast((line) => line.includes("Smoke goal"))).not.toContain("•");
      screen.sendInput("q");
    });
  }, 30_000);

  it("rules worker updates/reports by kind, selects and messages a worker, and shows reload success", async () => {
    await withTerminal(columns, theme, async (screen) => {
      send(screen, "/work reader inspect");
      await visible(screen, "│ start · reader · creation committed");
      // The worker's name is the only label: the rule's style tells an update from a report.
      const update = await visible(screen, "│ Faux worker progress: checking.");
      expect(update[update.findIndex((line) => line.includes("worker progress")) - 1]).toMatch(
        /^│ reader\s*$/,
      );
      await visible(screen, "Faux front: result received.");
      const shown = (await screen.flushAndGetViewport()).join("\n");
      expect(shown).not.toMatch(/worker · reader|not a new user instruction/);
      await visible(screen, "Workers · ○ 1 idle · /agents");
      // Overflow the transcript so the row above the bar is the last message's timestamp, not filler.
      screen.resize(columns, 14);
      let docked: string[] = [];
      await waitFor(async () => {
        docked = await screen.flushAndGetViewport();
        return (
          docked.some((line) => line.includes("result received.")) &&
          docked.some((line) => line.includes("Workers · ○ 1 idle")) &&
          // The whole dock, down to the footer, has settled at the new height.
          docked.some((line) => line.includes("• root"))
        );
      });
      const bar = docked.findIndex((line) => line.includes("Workers · ○ 1 idle"));
      // A blank row separates the bar from the last message's timestamp.
      expect(docked[bar - 1]?.trim()).toBe("");
      expect(docked[bar - 2]).toMatch(/\d{4}, \d+:\d{2}/);
      // The footer keeps the view and model but drops the command hints.
      const footer = docked.findLast((line) => line.includes("• root"));
      expect(footer).toBeDefined();
      expect(footer).not.toContain("/agents");
      expect(footer).not.toContain("/help");
      screen.resize(columns, 40);
      send(screen, "/agents");
      const panel = await visible(screen, "Enter view");
      // The panel lists the root and each worker with status and context, behind the dock's compact counts.
      // An idle agent shows how long ago it last did something, beside its status.
      expect(panel.join("\n")).toMatch(/root\s+○ idle \d+s\s+\d+\.\d%/);
      expect(panel.join("\n")).toMatch(/reader\s+○ idle \d+s\s+\d+\.\d%/);
      screen.sendInput("\x1b[B"); // down to the worker, then select with the actual keyboard path
      screen.sendInput("\r");
      // The worker's context leads the footer, and the root's stays beside it.
      const meters = (await visible(screen, "• reader")).at(-1);
      expect(meters).toMatch(/reader \d+\.\d%\/128k · root \d+\.\d%\/128k/);
      send(screen, "more");
      await visible(screen, "│ message · reader · received");
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
      await visible(screen, "• root");
      send(screen, "/reload");
      await visible(screen, "reloaded · context");
      expect(screen.stopped).toBe(false);
    });
  }, 30_000);
});
