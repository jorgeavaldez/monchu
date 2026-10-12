import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { help, parseInput } from "../src/tui/commands.ts";
import { presentation } from "../src/tui/state.ts";
import { MonchuTui } from "../src/tui/view.ts";
import { cleanup, context, open, route, setup, waitFor } from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(cleanup);

describe("terminal input boundary", () => {
  it("keeps multiline messages and paths intact", () => {
    expect(parseInput("  hello\nworld ")).toEqual({ command: "message", text: "hello\nworld" });
    expect(parseInput("/work reader first line\nsecond line")).toEqual({
      command: "/work",
      name: "reader",
      text: "first line\nsecond line",
    });
    expect(parseInput("/cd-worker reader C:\\a directory")).toEqual({
      command: "/cd-worker",
      name: "reader",
      text: "C:\\a directory",
    });
    expect(parseInput(" \n ")).toBeUndefined();
  });

  it("preserves all existing commands and adds worker focus", () => {
    for (const command of [
      "/quit",
      "/help",
      "/abort",
      "/workers",
      "/goals",
      "/reload",
      "/restart",
      "/login",
    ])
      expect(parseInput(command)).toEqual({ command });
    for (const command of ["/new", "/compact", "/agents"])
      expect(parseInput(command)).toEqual({ command, text: "" });
    for (const command of ["/cd", "/stop", "/agents", "/new", "/compact"])
      expect(parseInput(`${command} target`)).toEqual({ command, text: "target" });
    expect(parseInput("/tell w more")).toEqual({ command: "/tell", name: "w", text: "more" });
    for (const invalid of [
      "/work name",
      "/tell",
      "/cd-worker w",
      "/cd",
      "/stop",
      "/quit now",
      "/login key",
      "/reload now",
      "/restart yes",
      "/missing",
    ])
      expect(() => parseInput(invalid)).toThrow();
    expect(help).toContain("/reload");
    expect(help).toContain("/restart");
    expect(help).toContain("User-only");
  });

  it("restores the terminal and stops input before /restart re-executes, reopens storage, and propagates the child code", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    const agentDir = join(home, "agent");
    await mkdir(home);
    await writeFile(join(home, "config.json"), JSON.stringify({ classifier: null }));
    const eventsPath = join(home, "restart-events.txt");
    const script = join(value.directory, "restart.mjs");
    // Only the terminal transport is a fixture. Both processes use real Monchu and Durable storage.
    await writeFile(
      script,
      `
      import { Monchu } from ${JSON.stringify(new URL("../src/backend.ts", import.meta.url).href)};
      import { runTerminal } from ${JSON.stringify(new URL("../src/tui/app.ts", import.meta.url).href)};
      import { appendFileSync, existsSync, readFileSync } from "node:fs";
      const home = ${JSON.stringify(home)};
      const events = ${JSON.stringify(eventsPath)};
      if (existsSync(events)) {
        const restored = readFileSync(events, "utf8");
        if (!restored.includes("restored\\n") || !restored.includes("stopped\\n")) throw new Error("Restart ran before terminal cleanup");
        const backend = await Monchu.open(home);
        const state = await backend.viewState();
        if (state.value.entries.length !== 0) throw new Error("Queued input was admitted after restart approval");
        state.dispose();
        await backend.close();
        appendFileSync(events, "reopened\\n");
        process.exit(23);
      }
      appendFileSync(events, "started\\n");
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
      const backend = await Monchu.open(home);
      try { await runTerminal(backend, screen); throw new Error("Restart returned"); }
      finally { await backend.close(); }
    `,
    );
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
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
    expect(events.at(-1)).toBe("reopened");
    expect(events.indexOf("stopped")).toBeLessThan(events.indexOf("reopened"));
    expect(events.indexOf("restored")).toBeLessThan(events.indexOf("reopened"));
  }, 30_000);
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
      expect(presentation(state.value).queue).toContain("[followUp] queued");
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
