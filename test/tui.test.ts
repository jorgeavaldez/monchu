import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Footer } from "../src/tui/components/footer.ts";
import { ToolExecutionComponent } from "../src/tui/components/tool-execution.ts";
import { UserMessageComponent } from "../src/tui/components/user-message.ts";
import { WorkerMessageComponent } from "../src/tui/components/worker-message.ts";
import { initTheme, theme } from "../src/tui/theme/theme.ts";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { helpText, parseInput } from "../src/ui/commands.ts";
import { presentation } from "../src/ui/state.ts";
import { MonchuTui } from "../src/tui/view.ts";
import { startWorker } from "../src/core/agents/workers.ts";
import {
  allEntries,
  cleanup,
  context,
  conversationOf,
  deliveryTaskId,
  fauxRole,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(cleanup);

describe("terminal input boundary", () => {
  it("keeps multiline messages and paths intact", () => {
    expect(parseInput("  hello\nworld ")).toEqual({ command: "message", text: "hello\nworld" });
    expect(parseInput("/skill:review first line\nsecond line")).toEqual({
      command: "skill",
      name: "review",
      text: "first line\nsecond line",
    });
    expect(parseInput("/cd C:\\a directory")).toEqual({ command: "/cd", text: "C:\\a directory" });
    expect(parseInput(" \n ")).toBeUndefined();
  });

  it("preserves all existing commands and adds worker focus", () => {
    for (const command of ["/quit", "/help", "/goals", "/reload", "/restart", "/login"])
      expect(parseInput(command)).toEqual({ command });
    for (const command of ["/new", "/compact", "/agents", "/stop"])
      expect(parseInput(command)).toEqual({ command, text: "" });
    for (const command of ["/cd", "/stop", "/agents", "/new", "/compact"])
      expect(parseInput(`${command} target`)).toEqual({ command, text: "target" });
    // /clef is the Clef plugin's command now; /detach became /attach clear.
    expect(parseInput("/clef off")).toEqual({ command: "plugin", name: "clef", text: "off" });
    expect(parseInput("/attach clear")).toEqual({ command: "/attach", text: "clear" });
    expect(parseInput("/detach")).toEqual({ command: "plugin", name: "detach", text: "" });
    // /update defaults to edge and takes only a release, which never reaches npm as anything else.
    expect(parseInput("/update")).toEqual({ command: "/update", text: "edge" });
    expect(parseInput("/update v1.2.0")).toEqual({ command: "/update", text: "1.2.0" });
    expect(() => parseInput("/update latest; rm -rf ~")).toThrow("Usage: /update [edge|version]");
    // Any other /name is a plugin's command, which the core runs or refuses.
    expect(parseInput("/tell w more")).toEqual({ command: "plugin", name: "tell", text: "w more" });
    expect(parseInput("/cd-worker")).toEqual({ command: "plugin", name: "cd-worker", text: "" });
    for (const invalid of [
      "/Work name",
      "/tmp/file",
      "/skill:",
      "/cd",
      "/quit now",
      "/login key",
      "/reload now",
      "/restart yes",
    ])
      expect(() => parseInput(invalid)).toThrow();
    const help = helpText("terminal", [
      { name: "weather", usage: "[city]", help: "a plugin's" },
      { name: "goals", usage: "", help: "shadowed" },
    ]);
    expect(help).toContain("/quit");
    // The web closes with its tab: no /quit there.
    expect(helpText("web", [])).not.toContain("/quit");
    expect(help).toContain("/reload");
    expect(help).toContain("/restart");
    expect(help).toContain("/skill:<name>");
    expect(help).toMatch(/\/weather \[city\] +a plugin's/);
    expect(help).not.toContain("shadowed");
  });

  it("restores the terminal and stops input before /restart closes the core and the entry re-executes in place, reopens storage, and propagates the code", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: { clef: null } }));
    const eventsPath = join(home, "restart-events.txt");
    const script = join(value.directory, "restart.mjs");
    // Only the terminal transport is a fixture. Both processes use real Monchu and Durable storage.
    await writeFile(
      script,
      `
      import { Monchu } from ${JSON.stringify(new URL("../src/core/backend.ts", import.meta.url).href)};
      import { runTerminal } from ${JSON.stringify(new URL("../src/tui/app.ts", import.meta.url).href)};
      import { reexecute } from ${JSON.stringify(new URL("../src/reexec.ts", import.meta.url).href)};
      import { appendFileSync, existsSync, readFileSync } from "node:fs";
      const home = ${JSON.stringify(home)};
      const events = ${JSON.stringify(eventsPath)};
      if (existsSync(events)) {
        const restored = readFileSync(events, "utf8");
        if (!restored.includes("restored\\n") || !restored.includes("stopped\\n")) throw new Error("Restart ran before terminal cleanup");
        const backend = await Monchu.open(home);
        const state = await backend.root(await backend.currentRoot()).viewState();
        if (state.value.entries.length !== 0) throw new Error("Queued input was admitted after restart approval");
        state.dispose();
        await backend.close();
        appendFileSync(events, "reopened " + process.pid + "\\n");
        process.exit(23);
      }
      appendFileSync(events, "started " + process.pid + "\\n");
      const screen = {
        columns: 100, rows: 40, kittyProtocolActive: false,
        start(input) { queueMicrotask(() => { input("/restart"); input("\\r"); input("/missing"); input("\\r"); }); },
        stop() { appendFileSync(events, "stopped\\n"); },
        async drainInput() {},
        write(data) {
          if (data.includes("\\x1b[?1049l")) appendFileSync(events, "restored\\n");
          if (data.includes("Unknown command")) throw new Error("Queued input executed during restart");
        },
        moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
      };
      // As the entry point does: the terminal resolves after the core closed for the restart, then the process re-executes.
      const backend = await Monchu.open(home);
      let outcome;
      try { outcome = await runTerminal(backend, await backend.currentRoot(), screen); }
      finally { await backend.close(); }
      if (outcome !== "restart") throw new Error("Restart returned " + outcome);
      await reexecute();
    `,
    );
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 25_000,
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result, result.output).toMatchObject({ code: 23 });
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
    expect(events).toHaveLength(4);
    const [started, pid] = events[0]?.split(" ") ?? [];
    expect(started).toBe("started");
    // Outside Windows the restarted Monchu is the same process (execve), so restarts never chain processes.
    expect(events.at(-1)).toEqual(
      process.platform !== "win32" && typeof process.execve === "function"
        ? `reopened ${pid}`
        : expect.stringMatching(/^reopened /),
    );
    expect(events.indexOf("stopped")).toBeLessThan(events.length - 1);
    expect(events.indexOf("restored")).toBeLessThan(events.length - 1);
  }, 30_000);
});

it("collapses a tool without its own renderer to a header and a one-row summary, and expands it whole", () => {
  initTheme("dark");
  const screen = new VirtualTerminal(40, 10);
  const ui = new MonchuTui(screen, "/", {
    submit: () => {},
    editQueued: () => {},
    abort: () => {},
    exit: () => {},
  });
  let changes = 0;
  const card = new ToolExecutionComponent(
    "update_goal",
    { id: "monchu", workstream: "a long workstream that cannot fit a phone row", next: "ship it" },
    ui.ui,
    "/",
    () => changes++,
  );
  card.setArgsComplete();
  card.updateResult({
    content: [
      { type: "text", text: "Changed: workstream, next\n- [monchu] Monchu\n  next: ship it" },
    ],
    isError: false,
  });
  const collapsed = card.render(40).map(stripTerminalSequences);
  // A spacer, then two rows that never wrap, padded like a worker reply card: no output beyond the summary.
  expect(collapsed).toHaveLength(5);
  expect(collapsed[1]?.trim()).toBe("");
  expect(collapsed[2]).toMatch(/^ ▸ update_goal id="monchu" .*…\s*$/);
  expect(collapsed[3]).toMatch(/^ {3}Changed: workstream, next · 3 lines\s*$/);
  expect(collapsed[4]?.trim()).toBe("");
  for (const line of collapsed) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  card.setExpanded(true);
  const expanded = card.render(40).map(stripTerminalSequences).join("\n");
  expect(expanded).toMatch(/▾ update_goal/);
  expect(expanded).toContain("next: ship it");
  expect(expanded).toContain("- [monchu] Monchu");
  expect(changes).toBeGreaterThan(0);
  // JSON output summarizes by its first meaningful line, never a bare brace.
  const jj = new ToolExecutionComponent("jj", { cwd: "/x" }, ui.ui, "/", () => {});
  jj.updateResult({ content: [{ type: "text", text: '{\n "ok": true\n}' }], isError: false });
  expect(stripTerminalSequences(jj.render(40)[3] ?? "")).toMatch(/^ {3}"ok": true · 3 lines/);
});

it("shows a sign-in URL unpadded on rows of its own, whole when the rows are joined, with how to open or copy it", async () => {
  initTheme("dark");
  const screen = new VirtualTerminal(40, 20);
  const ui = new MonchuTui(screen, "/", {
    submit: () => {},
    editQueued: () => {},
    abort: () => {},
    exit: () => {},
  });
  const url = `https://example.com/device?code=${"x".repeat(70)}&state=abc`;
  try {
    ui.start();
    ui.beginLogin(() => {});
    ui.loginMessage("Code: ABCD-1234", url);
    let rows: string[] = [];
    await waitFor(async () => {
      rows = await screen.flushAndGetViewport();
      return rows.some((row) => row.includes("Alt+O"));
    });
    const first = rows.findIndex((row) => row.startsWith("https://"));
    const hint = rows.findIndex((row) => row.includes("Alt+O"));
    // No padding column: the rows join back into exactly the URL.
    expect(rows.slice(first, hint).join("")).toBe(url);
    expect(rows[hint]).toMatch(/tap or Alt\+O to open · Ctrl\+X to copy/);
    expect(rows[hint + 1]).toContain("Code: ABCD-1234");
    ui.endLogin();
  } finally {
    ui.stop();
  }
});

it("fits Pi's footer to any width, keeping the shown conversation, mode and context before totals", () => {
  initTheme("dark");
  const footer = new Footer();
  const usage = {
    input: 12000,
    output: 3400,
    cacheRead: 1200000,
    cacheWrite: 40000,
    context: 92000,
  };
  footer.state = {
    ...footer.state,
    cwd: join("/somewhere", "very", "deep", "directory", "for", "a", "worker"),
    worker: "monchu-core",
    shown: { usage, window: 100000 },
    root: { usage: { ...usage, context: 30000 }, window: 400000 },
    model: "claude-opus-5-5",
    thinking: "medium",
  };
  for (let width = 4; width <= 140; width++) {
    const lines = footer.render(width).map(stripTerminalSequences);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (width < 60) continue;
    expect(lines[0]).toMatch(/• monchu-core\s+follow-up \(Alt\+S\)$/);
    // The worker's context, red past 90%, then the root's; totals only where both fit with the model.
    expect(lines[1]).toContain("monchu-core 92.0%/100k · root 7.5%/400k");
  }
  expect(footer.render(140)[1]).toContain(theme.fg("error", "92.0%/100k"));
  expect(stripTerminalSequences(footer.render(140)[1] ?? "")).toMatch(
    /^ ↑12k ↓3.4k R1.2M W40k monchu-core .* \(auto\)\s+claude-opus-5-5 • medium$/,
  );
  footer.state = {
    ...footer.state,
    worker: undefined,
    shown: { usage: { ...usage, context: undefined }, window: 100000 },
  };
  // On the root only its own context shows, unknown until a reply measures it.
  expect(stripTerminalSequences(footer.render(80)[1] ?? "")).toMatch(/W40k \?\/100k \(auto\)/);
});

describe("committed Durable presentation", () => {
  it("shows committed streaming, thinking activity, and the inbox, then settles without duplication", async () => {
    const value = await setup({ tokensPerSecond: 150 });
    route(value.faux, () =>
      fauxAssistantMessage([
        fauxThinking("PRIVATE REASONING ".repeat(12)),
        fauxText("visible answer ".repeat(12)),
      ]),
    );
    const { harness, root } = await open(value);
    const state = await root.viewState(context);
    initTheme("dark");
    const screen = new VirtualTerminal(40, 20);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    let thought = false;
    let streamed = false;
    const stop = state.subscribe((view) => {
      const shown = presentation(view);
      thought ||= shown.status === "Thinking…";
      streamed ||= Boolean(shown.partial?.includes("visible"));
      ui.apply(view);
    });
    try {
      ui.start();
      const first = await root.submit(
        { type: "input", content: "first", requestId: "first" },
        context,
      );
      await waitFor(
        async () =>
          (await harness.snapshot(LiveDoc, root.id, context))?.generation?.message !== undefined,
      );
      await root.submit({ type: "input", content: "queued", requestId: "queued" }, context);
      await waitFor(async () =>
        Boolean((await harness.snapshot(InboxDoc, root.id, context))?.items.length),
      );
      expect(presentation(state.value).queue).toContainEqual(
        expect.objectContaining({ mode: "followUp", text: "queued" }),
      );
      await first.wait(context);
      await root.waitForIdle(context);
      expect(thought).toBe(true);
      expect(streamed).toBe(true);
      expect(presentation(state.value)).toMatchObject({ busy: false, status: "", queue: [] });
      screen.resize(40, 60);
      ui.ui.scrollToTop();
      ui.ui.renderNow(true);
      const lines = await screen.flushAndGetViewport();
      expect(
        lines
          .join("")
          .replace(/\s/g, "")
          .match(/visibleanswer/g),
      ).toHaveLength(24);
      expect(lines.join("\n")).not.toContain("PRIVATE REASONING");
      expect(lines.join("\n")).toContain("visible answer");
      expect(lines.every((line) => visibleWidth(line) <= screen.columns)).toBe(true);
      expect(value.reports).toEqual([]);
    } finally {
      stop();
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it.each(["dark", "light"])(
    "renders real tool calls/results on a narrow %s viewport and rebuilds after reset",
    async (theme) => {
      const value = await setup();
      value.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "missing-file.txt" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("finished"),
      ]);
      const { harness, root } = await open(value);
      initTheme(theme);
      const screen = new VirtualTerminal(32, 20);
      const ui = new MonchuTui(screen, value.directory, {
        submit: () => {},
        editQueued: () => {},
        abort: () => {},
        exit: () => {},
      });
      const state = await root.viewState(context);
      const stop = state.subscribe((view) => ui.apply(view));
      try {
        ui.start();
        await (
          await root.submit({ type: "input", content: "read", requestId: "read" }, context)
        ).wait(context);
        ui.ui.scrollToTop();
        ui.ui.renderNow(true);
        const lines = await screen.flushAndGetViewport();
        expect(lines.join("\n")).toContain("missing-file.txt");
        expect(lines.every((line) => visibleWidth(line) <= screen.columns)).toBe(true);
        await root.reset(undefined, context);
        ui.ui.renderNow(true);
        expect((await screen.flushAndGetViewport()).join("\n")).not.toContain("missing-file.txt");
        expect(value.reports).toEqual([]);
      } finally {
        stop();
        state.dispose();
        ui.stop();
        await harness.close(context);
      }
    },
  );

  it("writes nothing for an unchanged view or worker line, hides the hardware cursor, and rebuilds without clearing", async () => {
    const value = await setup();
    route(value.faux, () => fauxAssistantMessage("settled answer"));
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(40, 20);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    try {
      ui.start();
      await (
        await root.submit({ type: "input", content: "hi", requestId: "hi" }, context)
      ).wait(context);
      await root.waitForIdle(context);
      ui.apply(state.value);
      ui.setWorkers([{ name: "w", status: "working" }]);
      await waitFor(async () => {
        const lines = (await screen.flushAndGetViewport()).join("\n");
        return (
          lines.includes("settled answer") && lines.includes("Workers · ● 1 working · /agents")
        );
      });
      const written = screen.output.length;
      // Each worker revision re-shows the root view and the worker line unchanged.
      ui.apply(state.value);
      ui.setWorkers([{ name: "w", status: "working" }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.output.length).toBe(written);
      ui.apply(state.value, undefined, true);
      await waitFor(() => screen.output.length > written);
      expect(screen.output.slice(written)).not.toContain("\x1b[2J");
      expect((await screen.flushAndGetViewport()).join("\n")).toContain("settled answer");
      expect(screen.output).not.toContain("\x1b[?25h");
    } finally {
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it("keeps a long settled transcript reachable and redraws settled tool cards on click and Ctrl-O", async () => {
    const value = await setup();
    await writeFile(join(value.directory, "notes.txt"), "first note line\nsecond note line");
    route(value.faux, (context) =>
      lastMessage(context.messages)?.role === "toolResult"
        ? fauxAssistantMessage("noted")
        : fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], {
            stopReason: "toolUse",
          }),
    );
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(40, 20);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    const stop = state.subscribe((view) => ui.apply(view));
    const viewport = async () => {
      ui.ui.renderNow();
      return (await screen.flushAndGetViewport()).join("\n");
    };
    try {
      ui.start();
      for (const turn of [1, 2, 3, 4, 5, 6]) {
        const content = `question ${turn}`;
        await (
          await root.submit({ type: "input", content, requestId: content }, context)
        ).wait(context);
      }
      await root.waitForIdle(context);
      expect(await viewport()).not.toContain("first note line");
      ui.ui.scrollToTop();
      const top = (await viewport()).split("\n");
      expect(top.join("\n")).toContain("question 1");
      // Click the first card's call line: the settled card must expand on screen.
      const row = top.findIndex((line) => line.includes("notes.txt"));
      expect(row).toBeGreaterThan(-1);
      screen.sendInput(`\x1b[<0;5;${row + 1}M`);
      screen.sendInput(`\x1b[<0;5;${row + 1}m`);
      await waitFor(async () => (await viewport()).includes("first note line"));
      ui.ui.scrollToBottom();
      expect(await viewport()).not.toContain("first note line");
      screen.sendInput("\x0f"); // Ctrl-O expands every card, including settled ones
      await waitFor(async () => (await viewport()).includes("second note line"));
      expect(value.reports).toEqual([]);
    } finally {
      stop();
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it("collapses worker reports with a per-message toggle, keeps front replies whole, and dates them", async () => {
    const value = await setup();
    const paragraphs = (label: string) =>
      Array.from({ length: 8 }, (_, index) => `${label} line ${index + 1}`).join("\n\n");
    route(value.faux, (context) =>
      fauxAssistantMessage(
        paragraphs(textOf(lastMessage(context.messages)) === "inspect" ? "report" : "front reply"),
      ),
    );
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(60, 40);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    const stop = state.subscribe((view) => ui.apply(view));
    const viewport = async () => {
      ui.ui.renderNow();
      return (await screen.flushAndGetViewport()).join("\n");
    };
    try {
      ui.start();
      await root.commit(
        (tx) => startWorker(tx, root.id, "w", "inspect", value.directory, "start:w", fauxRole),
        context,
      );
      await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
      await root.waitForIdle(context);
      const collapsed = await viewport();
      expect(collapsed).toMatch(/│ ▸ w · .*\d:\d{2}.* · [k-z]{4}\s*\n/);
      expect(collapsed).toContain("report line 1");
      expect(collapsed).not.toContain("report line 3");
      expect(collapsed).toMatch(/more lines · click or Ctrl-O to expand/);
      // The front's reply stays whole, then shows when it was sent and its short id.
      const lines = collapsed.split("\n");
      const last = lines.findIndex((line) => line.includes("front reply line 8"));
      expect(lines.findIndex((line) => line.includes("front reply line 1"))).toBeGreaterThan(-1);
      expect(lines[last + 1]).toMatch(/^ .*\d:\d{2}.* · [k-z]{4}\s*$/);
      // A click on the report toggles only that message, from the keyboard-free pointer path.
      const row = lines.findIndex((line) => /^│ ▸ w · .*\d:\d{2}.* · [k-z]{4}\s*$/.test(line));
      screen.sendInput(`\x1b[<0;5;${row + 1}M`);
      screen.sendInput(`\x1b[<0;5;${row + 1}m`);
      await waitFor(async () => (await viewport()).includes("report line 8"));
      expect(await viewport()).toMatch(/│ ▾ w · .*\d:\d{2}.* · [k-z]{4}\s*\n/);
      // A second press within 500 ms would be a double click.
      await new Promise((resolve) => setTimeout(resolve, 600));
      screen.sendInput(`\x1b[<0;5;${row + 1}M`);
      screen.sendInput(`\x1b[<0;5;${row + 1}m`);
      await waitFor(async () => !(await viewport()).includes("report line 8"));
      screen.sendInput("\x0f"); // Ctrl-O expands every worker message too
      await waitFor(async () => (await viewport()).includes("report line 8"));
      expect(value.reports).toEqual([]);
    } finally {
      stop();
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it.each(["dark", "light"])(
    "shows each event kind by style: my queued input yellow, worker replies purple, updates gray (%s)",
    async (name) => {
      const value = await setup();
      const held = Promise.withResolvers<void>();
      route(value.faux, async (request) => {
        const last = lastMessage(request.messages);
        const text = textOf(last);
        if (text === "hold front") {
          await held.promise;
          return fauxAssistantMessage([fauxText("front reply")]);
        }
        if (text === "inspect")
          return fauxAssistantMessage(
            [fauxToolCall("post_update", { text: "checking files\nhalfway there" })],
            { stopReason: "toolUse" },
          );
        if (last?.role === "toolResult")
          return fauxAssistantMessage([fauxText("report line one\nreport line two")]);
        return fauxAssistantMessage([fauxText("noted")]);
      });
      const { harness, root } = await open(value);
      initTheme(name);
      // The color a cell shows for styled text, read from a terminal of its own.
      const color = async (styled: string) => {
        const probe = new VirtualTerminal(4, 1);
        probe.write(styled);
        return probe.foreground(0, 0);
      };
      const yellow = await color(theme.fg("warning", "│"));
      const purple = await color(theme.fg("borderAccent", "│"));
      const gray = await color(theme.fg("borderMuted", "│"));
      const muted = await color(theme.fg("muted", "x"));
      expect(new Set([yellow, purple, gray, muted]).size).toBe(4);
      const screen = new VirtualTerminal(60, 80);
      const ui = new MonchuTui(screen, value.directory, {
        submit: () => {},
        editQueued: () => {},
        abort: () => {},
        exit: () => {},
      });
      const state = await root.viewState(context);
      const stop = state.subscribe((view) => ui.apply(view));
      const viewport = async () => {
        ui.ui.renderNow();
        return screen.flushAndGetViewport();
      };
      // The rule's color where a row starts with it, after any padding.
      const rule = async (lines: string[], match: (line: string) => boolean) => {
        const row = lines.findIndex(match);
        expect(row, lines.join("\n")).toBeGreaterThan(-1);
        const line = lines[row] ?? "";
        expect(line.trimStart().startsWith("│"), line).toBe(true);
        return screen.foreground(row, line.indexOf("│"));
      };
      try {
        ui.start();
        await root.submit({ type: "input", content: "hold front", requestId: "hold" }, context);
        await root.submit(
          {
            type: "input",
            content: "queued first\nqueued second",
            whenBusy: "followUp",
            requestId: "follow",
          },
          context,
        );
        await root.submit(
          { type: "input", content: "steer now", whenBusy: "steer", requestId: "steer" },
          context,
        );
        await root.commit(
          (tx) =>
            startWorker(tx, root.id, "reader", "inspect", value.directory, "start:r", fauxRole),
          context,
        );
        // The worker's update and report queue behind the held front with the user's own input.
        await waitFor(
          async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 4,
        );
        ui.notice("reader · received", "message");
        const dock = await viewport();
        const queued = dock.join("\n");
        // Queued rows keep the sender's style: mine yellow, in the user's text color; a worker's as in the transcript.
        const userText = await color(theme.fg("userMessageText", "x"));
        for (const [text, ruled, body] of [
          ["│ you · follow-up · queued first …", yellow, userText],
          ["│ you · steer · steer now", yellow, userText],
          ["│ reader update · follow-up · checking files …", gray, muted],
          ["│ reader reply · follow-up · report line one …", purple, muted],
          ["│ message · reader · received", yellow, muted],
        ] as const) {
          expect(queued).toContain(text);
          const match = (line: string) => line.includes(text);
          expect(await rule(dock, match)).toBe(ruled);
          const row = dock.findIndex(match);
          expect(await screen.foreground(row, (dock[row] ?? "").lastIndexOf("·") + 2)).toBe(body);
        }
        // The worker wrapper's labels and guidance never reach the screen.
        expect(queued).not.toMatch(/not a new user instruction|\[followUp\]|\[steer\]|\[Worker /);
        expect(queued).not.toContain("Tell the user");

        held.resolve();
        await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
        await waitFor(
          async () => (await harness.snapshot(InboxDoc, root.id, context))?.items.length === 0,
        );
        await root.waitForIdle(context);
        ui.ui.scrollToTop();
        const lines = await viewport();
        const chat = lines.join("\n");
        expect(chat).not.toMatch(/not a new user instruction|Tell the user|worker · |\[Worker /);
        // A report: the worker's name behind a purple rule, every body line on its own ruled row.
        const report = lines.findIndex((line) => line.startsWith("│ report line one"));
        expect(lines[report - 1]).toMatch(/^│ reader · .*\d:\d{2}.* · [k-z]{4}\s*$/);
        expect(lines[report + 1]).toMatch(/^│ report line two\s*$/);
        for (const row of [report - 1, report, report + 1])
          expect(await screen.foreground(row, 0)).toBe(purple);
        // An update: a gray rule and muted text, its lines kept.
        const update = lines.findIndex((line) => line.startsWith("│ checking files"));
        expect(lines[update - 1]).toMatch(/^│ reader · .*\d:\d{2}.* · [k-z]{4}\s*$/);
        expect(lines[update + 1]).toMatch(/^│ halfway there\s*$/);
        for (const row of [update - 1, update, update + 1])
          expect(await screen.foreground(row, 0)).toBe(gray);
        expect(await screen.foreground(update, 2)).toBe(muted);
        // The user's own messages, multiline ones too, and the front's reply keep their plain look.
        for (const text of ["hold front", "queued first", "queued second", "steer now"]) {
          const row = lines.findIndex((line) => line.trim() === text);
          expect(row, text).toBeGreaterThan(-1);
          expect(lines[row]).not.toContain("│");
          expect(await screen.foreground(row, 1)).toBe(userText);
        }
        expect(lines.findIndex((line) => line.trim() === "queued second")).toBe(
          lines.findIndex((line) => line.trim() === "queued first") + 1,
        );
        const reply = lines.findIndex((line) => line.trim() === "front reply");
        expect(reply).toBeGreaterThan(-1);
        expect(lines[reply]).not.toContain("│");
        expect(value.reports).toEqual([]);
      } finally {
        stop();
        state.dispose();
        ui.stop();
        await harness.close(context);
      }
    },
  );

  it("toggles steer and follow-up with Alt+S, shows the mode, and restores queued text ahead of a draft", async () => {
    const value = await setup();
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(60, 20);
    const sent: [string, string][] = [];
    const ui = new MonchuTui(screen, value.directory, {
      submit: (text, whenBusy) => sent.push([text, whenBusy]),
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    const viewport = async () => {
      ui.ui.renderNow();
      return screen.flushAndGetViewport();
    };
    // The editor's bottom border: the last full rule above the footer.
    const border = async () => {
      const lines = await viewport();
      const row = lines.findLastIndex((line) => line.startsWith("───"));
      return screen.foreground(row, 0);
    };
    const probe = new VirtualTerminal(4, 1);
    probe.write(theme.fg("warning", "─"));
    const yellow = await probe.foreground(0, 0);
    try {
      ui.apply(state.value);
      ui.start();
      expect((await viewport()).join("\n")).toMatch(/• root\s+follow-up \(Alt\+S\)/);
      expect(await border()).not.toBe(yellow);
      screen.sendInput("a");
      screen.sendInput("\r");
      screen.sendInput("\x1bs");
      await waitFor(async () => (await viewport()).join("\n").includes("steer (Alt+S)"));
      expect(await border()).toBe(yellow);
      screen.sendInput("b");
      screen.sendInput("\r");
      screen.sendInput("\x1bs");
      screen.sendInput("c");
      screen.sendInput("\r");
      await waitFor(() => sent.length === 3);
      expect(sent).toEqual([
        ["a", "followUp"],
        ["b", "steer"],
        ["c", "followUp"],
      ]);
      expect(await border()).not.toBe(yellow);

      screen.sendInput("draft");
      await waitFor(async () => (await viewport()).join("\n").includes("draft"));
      ui.restoreQueued(["one", "two\nlines"]);
      const lines = (await viewport()).map((line) => line.replace(/│/g, "").trim());
      const at = (text: string) => lines.indexOf(text);
      expect(at("one")).toBeGreaterThan(-1);
      expect([at("one"), at("two"), at("lines"), at("draft")]).toEqual([
        at("one"),
        at("one") + 2,
        at("one") + 3,
        at("one") + 5,
      ]);
    } finally {
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it("edits, toggles and deletes queued messages from the Alt+Q panel, keeping the draft aside while editing", async () => {
    const value = await setup();
    const release = Promise.withResolvers<void>();
    route(value.faux, async (request) => {
      if (textOf(lastMessage(request.messages)) === "hold front") await release.promise;
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(80, 30);
    const edits: unknown[] = [];
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: (id, change) => edits.push({ id, ...change }),
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    const stop = state.subscribe((view) => ui.apply(view));
    const viewport = async () => {
      ui.ui.renderNow();
      return (await screen.flushAndGetViewport()).join("\n");
    };
    const shows = async (text: string) => {
      try {
        await waitFor(async () => (await viewport()).includes(text), 2000);
      } catch (error) {
        throw new Error(`Missing ${JSON.stringify(text)}:\n${await viewport()}`, { cause: error });
      }
    };
    try {
      ui.start();
      await root.submit({ type: "input", content: "hold front", requestId: "hold" }, context);
      await waitFor(() => presentation(state.value).busy);
      for (const content of ["first", "second"])
        await root.submit({ type: "input", content, requestId: content }, context);
      await waitFor(() => presentation(state.value).queue.length === 2);
      const [first, second] = presentation(state.value).queue;
      if (first === undefined || second === undefined) throw new Error("Queue is missing items");
      await shows("↳ Alt+Q to edit, steer or delete");

      screen.sendInput("draft");
      screen.sendInput("\x1bq");
      await shows("Enter edit · Alt+S mode · Del delete");
      const panel = await viewport();
      expect(panel).toContain("›│ you · follow-up · first");
      // The panel lists the queue in the dock's place instead of twice.
      expect(panel.match(/you · follow-up · second/g)).toHaveLength(1);
      expect(panel).not.toContain("Alt+Q to edit");

      screen.sendInput("\x1b[B");
      screen.sendInput("\x1bs");
      screen.sendInput("\x1b[3~");
      await waitFor(() => edits.length === 2);
      expect(edits).toEqual([
        { id: second.id, kind: "mode", mode: "steer" },
        { id: second.id, kind: "delete" },
      ]);

      // Enter opens the message in the editor; Esc cancels and the draft comes back.
      screen.sendInput("\x1b[A");
      screen.sendInput("\r");
      await shows("editing · Enter saves · Esc cancels");
      screen.sendInput("\x1b");
      await shows("Enter edit · Alt+S");
      expect(edits).toHaveLength(2);
      screen.sendInput("\r");
      await shows("editing · Enter saves");
      screen.sendInput(" again");
      screen.sendInput("\r");
      await waitFor(() => edits.length === 3);
      expect(edits[2]).toEqual({ id: first.id, kind: "text", text: "first again" });
      await shows("Enter edit · Alt+S");
      screen.sendInput("\x1b");
      await waitFor(async () => !(await viewport()).includes("Enter edit · Alt+S"));
      const closed = await viewport();
      expect(closed).toContain("draft");
      expect(closed).not.toContain("editing · Enter saves");
    } finally {
      release.resolve();
      stop();
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });

  it("keeps placed worker updates and reports in worker style without their wrapper after every refresh", async () => {
    const value = await setup();
    route(value.faux, (request) => {
      const last = lastMessage(request.messages);
      if (textOf(last) === "inspect")
        return fauxAssistantMessage(
          [fauxToolCall("post_update", { text: "checking files\nhalfway there" })],
          { stopReason: "toolUse" },
        );
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("report body")]);
      return fauxAssistantMessage([fauxText("front reply")]);
    });
    initTheme("dark");
    const probe = async (styled: string) => {
      const cell = new VirtualTerminal(4, 1);
      cell.write(styled);
      return cell.foreground(0, 0);
    };
    const purple = await probe(theme.fg("borderAccent", "│"));
    const gray = await probe(theme.fg("borderMuted", "│"));
    const muted = await probe(theme.fg("muted", "x"));
    // The committed view once, as the app's subscription delivers it.
    const snapshot = async (conversation: typeof root) => {
      const state = await conversation.viewState(context);
      const view = state.value;
      state.dispose();
      return view;
    };
    let { harness, root } = await open(value);
    const workerId = await root.commit(
      (tx) => startWorker(tx, root.id, "reader", "inspect", value.directory, "start:r", fauxRole),
      context,
    );
    await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
    await root.waitForIdle(context);
    // The transcript keeps the model's input whole: the label and guidance are hidden only on screen.
    const stored = (await allEntries(root)).flatMap((entry) =>
      entry.kind === "pi.user" ? [textOf(entry.model?.[0])] : [],
    );
    expect(stored.filter((text) => text.includes("not a new user instruction"))).toHaveLength(2);
    expect(stored.some((text) => text.includes("Tell the user"))).toBe(true);

    // Each refresh path must draw the placed update gray and the report purple, with no wrapper text.
    const expectStyled = async (screen: VirtualTerminal, ui: MonchuTui, refresh: string) => {
      ui.ui.scrollToTop();
      ui.ui.renderNow();
      const lines = await screen.flushAndGetViewport();
      const shown = lines.join("\n");
      expect(shown, refresh).not.toMatch(
        /not a new user instruction|Tell the user|\[Worker |\[Background worker /,
      );
      const update = lines.findIndex((line) => line.startsWith("│ checking files"));
      expect(update, `${refresh}\n${shown}`).toBeGreaterThan(0);
      expect(lines[update - 1], refresh).toMatch(/^│ reader · .*\d:\d{2}.* · [k-z]{4}\s*$/);
      expect(lines[update + 1], refresh).toMatch(/^│ halfway there\s*$/);
      for (const row of [update - 1, update, update + 1])
        expect(await screen.foreground(row, 0), refresh).toBe(gray);
      expect(await screen.foreground(update, 2), refresh).toBe(muted);
      const report = lines.findIndex((line) => line.startsWith("│ report body"));
      expect(lines[report - 1], refresh).toMatch(/^│ reader · .*\d:\d{2}.* · [k-z]{4}\s*$/);
      expect(await screen.foreground(report, 0), refresh).toBe(purple);
    };

    let screen = new VirtualTerminal(60, 40);
    let ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    try {
      ui.start();
      ui.apply(await snapshot(root));
      await expectStyled(screen, ui, "first render");
      // A forced rebuild, as /reload and a resize-driven rebuild do.
      ui.apply(await snapshot(root), undefined, true);
      await expectStyled(screen, ui, "forced rebuild");
      // Viewing the worker and coming back rebuilds the root transcript from its entries.
      const worker = await conversationOf(harness, workerId);
      ui.apply(await snapshot(worker), "reader");
      ui.ui.renderNow();
      // The worker's own transcript, not the root's: the front's reply is absent.
      expect((await screen.flushAndGetViewport()).join("\n")).not.toContain("front reply");
      ui.apply(await snapshot(root));
      await expectStyled(screen, ui, "back from the worker view");
    } finally {
      ui.stop();
      await harness.close(context);
    }
    // A restart: the reopened store and a new terminal draw the same styles from the stored entries alone.
    ({ harness, root } = await open(value));
    screen = new VirtualTerminal(60, 40);
    ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    try {
      ui.start();
      ui.apply(await snapshot(root));
      await expectStyled(screen, ui, "reopened");
      expect(value.reports).toEqual([]);
    } finally {
      ui.stop();
      await harness.close(context);
    }
  });

  it.each(["dark", "light"])(
    "draws worker replies as gray cards behind a purple rule and updates as a muted rule (%s)",
    (name) => {
      initTheme(name);
      const background = theme.bg("workerMessageBg", "").slice(0, -"\x1b[49m".length);
      for (const other of ["userMessageBg", "toolPendingBg", "toolSuccessBg"] as const)
        expect(theme.bg(other, "")).not.toContain(background);
      const purple = theme.fg("borderAccent", "│");
      const gray = theme.fg("borderMuted", "│");
      const text = Array.from({ length: 6 }, (_, index) => `report line ${index + 1}`).join("\n\n");
      const padding = (lines: string[]) => {
        const blank = lines.map(
          (line) => stripTerminalSequences(line).replace("│", "").trim() === "",
        );
        return [blank.indexOf(false), blank.length - 1 - blank.lastIndexOf(false)];
      };
      for (const status of ["completed", "failed"] as const) {
        const message = new WorkerMessageComponent(
          { name: "w", status, text },
          () => "srpx",
          () => {},
        );
        for (const expanded of [false, true]) {
          message.setExpanded(expanded);
          const lines = message.render(40);
          expect(lines.length).toBeGreaterThan(4);
          for (const line of lines) {
            expect(line).toContain(background);
            expect(line).toContain(purple);
            expect(line).not.toContain(gray);
            expect(visibleWidth(line)).toBe(40);
          }
          // Exactly one padded row above and below, matching the user input box, short or long.
          expect(padding(lines)).toEqual([1, 1]);
          // Only the name, a failure in the error color, and the muted short id: no status prose.
          const header = stripTerminalSequences(lines[1] ?? "").trim();
          expect(header).toBe(
            `│ ${expanded ? "▾" : "▸"} w${status === "failed" ? " · failed" : ""} · srpx`,
          );
          if (status === "failed") expect(lines[1]).toContain(theme.fg("error", " · failed"));
          expect(lines[1]).toContain(`${theme.fg("dim", " · ")}srpx`);
        }
      }
      const update = new WorkerMessageComponent(
        { name: "w", status: "update", text: "checking\nhalfway" },
        () => "oukx",
        () => {},
      ).render(40);
      // An update has no card: a muted rule and muted text on every row, and no padding rows.
      expect(update.map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
        "│ w · oukx",
        "│ checking",
        "│ halfway",
      ]);
      for (const line of update) {
        expect(line).toContain(gray);
        expect(line).not.toContain(purple);
        expect(line).not.toContain(background);
        expect(visibleWidth(line)).toBe(40);
      }
      expect(update[1]).toContain(theme.fg("muted", "checking"));
      expect(padding(new UserMessageComponent("hi").render(40))).toEqual([1, 1]);
    },
  );

  it("shows running bash output as it grows and settles the card when it finishes", async () => {
    const value = await setup();
    route(value.faux, (context) =>
      lastMessage(context.messages)?.role === "toolResult"
        ? fauxAssistantMessage("bash finished")
        : fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "echo $((1234 + 1)); sleep 1; echo $((5677 + 1)); sleep 1.5",
              }),
            ],
            { stopReason: "toolUse" },
          ),
    );
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(40, 20);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const state = await root.viewState(context);
    const stop = state.subscribe((view) => ui.apply(view));
    const running = () => presentation(state.value).output.some((tool) => tool.name === "bash");
    try {
      ui.start();
      const submission = await root.submit(
        { type: "input", content: "run", requestId: "run" },
        context,
      );
      // The command echoes sums, so only its output, never the call line, shows them.
      for (const line of ["1235", "5678"]) {
        await waitFor(async () => (await screen.flushAndGetViewport()).join("\n").includes(line));
        expect(running()).toBe(true);
      }
      await submission.wait(context);
      await root.waitForIdle(context);
      await waitFor(async () => {
        const lines = (await screen.flushAndGetViewport()).join("\n");
        return lines.includes("bash finished") && lines.includes("5678");
      });
      expect(value.reports).toEqual([]);
    } finally {
      stop();
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  }, 20_000);

  it("maps a committed retry without treating it as an answer", async () => {
    const value = await setup();
    const { harness, root } = await open(value);
    const state = await root.viewState(context);
    try {
      await root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, root.id);
        live.generation = { attempt: 2, retry: { at: Date.now(), error: "provider unavailable" } };
      }, context);
      expect(presentation(state.value)).toMatchObject({
        status: "Retrying (attempt 3): provider unavailable",
        partial: undefined,
      });
      await root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, root.id);
        delete live.generation;
      }, context);
      expect(presentation(state.value).status).toBe("");
    } finally {
      state.dispose();
      await harness.close(context);
    }
  });
});
