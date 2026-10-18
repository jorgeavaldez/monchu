import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import { containPluginFault } from "../src/core/plugins.ts";
import {
  callTools,
  cleanup,
  fauxRole,
  front,
  lastMessage,
  logText,
  prepareHome,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const BROKEN_SKILL = "---\nname: notes\ndescription: notes: what to keep\n---\nKeep notes.\n";
const GOOD_SKILL = '---\nname: notes\ndescription: "notes: what to keep"\n---\nKeep notes.\n';
/** A plugin written against an API this Monchu lacks. */
const BROKEN_PLUGIN = `export default (monchu) => monchu.on("session_start", () => {});\n`;

describe("home check", () => {
  it("shows a broken home to the agent that broke it, sends it back once, and tells the front of the rest", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(join(home, "skills", "notes"), { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    await writeFile(join(home, "skills", "notes", "SKILL.md"), BROKEN_SKILL);
    const skill = join(home, "skills", "notes", "SKILL.md");
    const plugin = join(home, "plugins", "farm", "index.ts");
    const requests: Message[][] = [];
    const answer = callTools({
      fix: { tool: "write", args: { path: skill, content: GOOD_SKILL } },
      break: { tool: "write", args: { path: plugin, content: BROKEN_PLUGIN } },
      look: { tool: "bash", args: { command: "echo hi" } },
      other: {
        tool: "write",
        args: {
          path: join(home, "skills", "other", "SKILL.md"),
          content: "---\nname: other\ndescription: Other notes\n---\nOther.\n",
        },
      },
      reload: { tool: "reload_extensions", args: {} },
    });
    const race = join(home, "skills", "race", "SKILL.md");
    const pair = join(home, "skills", "pair", "SKILL.md");
    /** Two calls of one reply, which run side by side. */
    const both: Record<string, ReturnType<typeof fauxToolCall>[]> = {
      // A shell that breaks the home and one that doesn't, finishing first.
      race: [
        fauxToolCall("bash", {
          command: `mkdir -p "${join(home, "skills", "race")}" && printf '%s' '${BROKEN_SKILL.replaceAll("\n", "\\n")}' > "${race}" && sleep 1`,
        }),
        fauxToolCall("bash", { command: "sleep 0.3" }),
      ],
      // A write that breaks the home beside a shell that doesn't.
      pair: [
        fauxToolCall("write", { path: pair, content: BROKEN_SKILL }),
        fauxToolCall("bash", { command: "sleep 0.5" }),
      ],
    };
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      const last = lastMessage(request.messages);
      const calls = last?.role === "user" ? both[textOf(last)] : undefined;
      return calls === undefined
        ? answer(request)
        : fauxAssistantMessage(calls, { stopReason: "toolUse" });
    });
    const inputs = async (backend: Monchu): Promise<string[]> => {
      const view = await (await front(backend)).viewState();
      const texts = view.value.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "user")
        .map(textOf);
      view.dispose();
      return texts;
    };
    const settled = async (backend: Monchu) => {
      await waitFor(async () => {
        const view = await (await front(backend)).viewState();
        const last = lastMessage(view.value.entries.flatMap((entry) => entry.model ?? []));
        const live = view.value.docs["pi.live"];
        view.dispose();
        return live?.run == null && last?.role === "assistant" && textOf(last) === "ok";
      });
    };
    /** One user message; the text of the last tool result it produced. */
    const turn = async (backend: Monchu, text: string): Promise<string> => {
      const count = requests.length;
      await (await front(backend)).submit(text, `home-check:${text}:${count}`, "followUp");
      await waitFor(() => requests.length > count);
      await settled(backend);
      return textOf(
        requests
          .slice(count)
          .flat()
          .findLast((message) => message.role === "toolResult"),
      );
    };
    /** One user message; the text of every tool result its reply produced, in call order. */
    const results = async (backend: Monchu, text: string): Promise<string[]> => {
      await turn(backend, text);
      const view = await (await front(backend)).viewState();
      const messages = view.value.entries.flatMap((entry) => entry.model ?? []);
      view.dispose();
      const at = messages.findLastIndex(
        (message) => message.role === "user" && textOf(message) === text,
      );
      const after = messages.slice(at + 1);
      const end = after.findIndex((message) => message.role === "user");
      return (end === -1 ? after : after.slice(0, end))
        .filter((message) => message.role === "toolResult")
        .map(textOf);
    };
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      // What this start could not load reaches the front as a system notice.
      await waitFor(async () => (await inputs(backend)).some((text) => text.includes("Nested")));
      await settled(backend);
      expect((await inputs(backend)).find((text) => text.includes("Nested"))).toContain(
        "Monchu's home has a problem",
      );

      // The front's own fix: its result says the check passes, and no notice follows.
      expect(await turn(backend, "fix")).toContain("[info] Monchu's home check passes now.");

      // A break the front makes is in that call's result, and its final answer sends it back once.
      const broken = await turn(backend, "break");
      expect(broken).toContain("[error] This call broke what Monchu loads from its home");
      expect(broken).toContain("Plugin farm was not loaded: unknown event session_start");
      await settled(backend);
      const sentBack = (await inputs(backend)).filter((text) =>
        text.includes("Your changes left what Monchu loads from its home broken"),
      );
      expect(sentBack).toHaveLength(1);
      expect(sentBack[0]).toContain("Plugin farm was not loaded");

      // A good change while that problem lasts is not blamed for it, and nobody is sent back again.
      const other = await turn(backend, "other");
      expect(other).not.toContain("[error]");
      expect(
        (await inputs(backend)).filter((text) => text.includes("Your changes left")),
      ).toHaveLength(1);

      // A fix from outside any tool call (another device's sync, an editor) reaches the front.
      await writeFile(plugin, "export default () => {};\n");
      expect(await turn(backend, "look")).not.toContain("home");
      await waitFor(async () =>
        (await inputs(backend)).some((text) => text.includes("home check passes again")),
      );
      await settled(backend);

      // A reload says what it warned about, in its own result.
      await writeFile(skill, BROKEN_SKILL);
      const reloaded = await turn(backend, "reload");
      expect(reloaded).toContain("1 warning; fix them now:");
      expect(reloaded).toContain("Nested");
      await writeFile(skill, GOOD_SKILL);
      await turn(backend, "look");
      await settled(backend);
      const sent = () =>
        inputs(backend).then(
          (texts) => texts.filter((text) => text.includes("Your changes left")).length,
        );
      const before = await sent();

      // Side by side, the call that finishes first is not blamed for the other's break: both are only warned, nobody
      // is sent back, and the front is told.
      const raced = await results(backend, "race");
      expect(raced).toHaveLength(2);
      for (const result of raced) {
        expect(result).not.toContain("[error]");
        expect(result).toContain("[warn] What Monchu loads from its home broke while this call");
      }
      await settled(backend);
      expect(await sent()).toBe(before);
      expect((await inputs(backend)).at(-1)).toContain(race);

      // A write is blamed for the break it names even beside another call, which isn't warned of it.
      const paired = await results(backend, "pair");
      expect(paired[0]).toContain("[error] This call broke what Monchu loads from its home");
      expect(paired[0]).toContain(pair);
      expect(paired[0]).not.toContain(race);
      expect(paired[1]).not.toContain("home");
      await settled(backend);
      const back = (await inputs(backend)).filter((text) => text.includes("Your changes left"));
      expect(back).toHaveLength(before + 1);
      expect(back.at(-1)).toContain(pair);
      expect(back.at(-1)).not.toContain(race);
    } finally {
      await backend.close();
    }
  });

  it("sends a worker that broke the home back once, then tells the front who left it", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    const skill = join(home, "skills", "notes", "SKILL.md");
    route(
      value.faux,
      callTools({
        delegate: { tool: "start_worker", args: { name: "skills", task: "write it" } },
        "write it": { tool: "write", args: { path: skill, content: BROKEN_SKILL } },
      }),
    );
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      await (await front(backend)).submit("delegate", "home-check:delegate", "followUp");
      await waitFor(async () => {
        const view = await (await front(backend)).viewState();
        const texts = view.value.entries.flatMap((entry) => entry.model ?? []).map(textOf);
        view.dispose();
        return texts.some((text) => text.includes("Worker skills left them"));
      });
      const view = await (await front(backend)).viewState();
      const notice = view.value.entries
        .flatMap((entry) => entry.model ?? [])
        .map(textOf)
        .find((text) => text.includes("Worker skills left them"));
      view.dispose();
      expect(notice).toContain("Nested");
    } finally {
      await backend.close();
    }
  });

  it("checks plugins without telling or keeping what they did, and tells a plugin's fault once until its code changes", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    const entry = join(home, "plugins", "warny", "index.js");
    await mkdir(join(home, "plugins", "warny"), { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    /** A plugin that warns of its settings as it loads, and leaves a way to make errors in its own code. */
    const version = (name: string) =>
      writeFile(
        entry,
        `export default (monchu) => {\n  monchu.report("bad setting ${name}");\n  globalThis.monchuBoom = (text) => new Error(text);\n};\n`,
      );
    await version("v1");
    route(value.faux, callTools({ look: { tool: "bash", args: { command: "echo hi" } } }));
    const texts = async (backend: Monchu) => {
      const view = await (await front(backend)).viewState();
      const all = view.value.entries.flatMap((each) => each.model ?? []).map(textOf);
      view.dispose();
      return all;
    };
    const count = (text: string, part: string) => text.split(part).length - 1;
    /** Log records that are exactly `body`, as a plugin's own report is. */
    const records = async (body: string) =>
      (await logText(home)).split("\n").filter((line) => line === body).length;
    const boom = (text: string) => {
      const make: unknown = Reflect.get(globalThis, "monchuBoom");
      if (typeof make !== "function") throw new Error("the plugin left no monchuBoom");
      const error: unknown = Reflect.apply(make, undefined, [text]);
      expect(containPluginFault(error)).toBe(true);
    };
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      // The build tells what the plugin reported; the check finds it as a problem, without telling it again.
      await waitFor(async () =>
        (await texts(backend)).some((text) => text.includes("Plugin warny: bad setting v1")),
      );
      expect(await records("Plugin warny: bad setting v1")).toBe(1);

      // New code the check ran is neither told nor kept as the last good code.
      await version("v2");
      await (await front(backend)).submit("look", "home-check:look", "followUp");
      await waitFor(async () =>
        (await texts(backend)).some((text) => text.includes("Plugin warny: bad setting v2")),
      );
      expect(await records("Plugin warny: bad setting v2")).toBe(0);
      await writeFile(entry, "export default (");
      await backend.reload();
      // The log is written in the background.
      await waitFor(async () =>
        (await logText(home)).includes("Plugin warny failed to load and keeps its last good code"),
      );
      expect(await records("Plugin warny: bad setting v1")).toBe(2);
      expect(await records("Plugin warny: bad setting v2")).toBe(0);

      // A failing timer's every tick: told once, until the plugin's code changes.
      for (const tick of [1, 2, 3, 4, 5]) boom(`poll failed: request ${tick}`);
      const told = async () =>
        count((await texts(backend)).join("\n"), "Plugin warny threw where nothing catches it");
      await waitFor(async () => (await told()) === 1);
      await version("v3");
      await backend.reload();
      for (const tick of [6, 7]) boom(`poll failed: request ${tick}`);
      await waitFor(async () => (await told()) === 2);
      await waitFor(
        async () => count(await logText(home), "Plugin warny threw where nothing catches it") === 2,
      );
    } finally {
      await backend.close();
    }
  });

  it("opens with a plugin that takes a core task's name or never loads left out, and tells the front", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(join(home, "plugins", "evil"), { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    await writeFile(
      join(home, "plugins", "evil", "index.ts"),
      `import { defineTask } from "monchu/plugin";
export default (monchu) => monchu.registerTask(defineTask({ name: "monchu.job", version: 1, initial: () => ({ phase: "run" }), phases: { run: async () => {} } }));
`,
    );
    await mkdir(join(home, "plugins", "stuck"), { recursive: true });
    await writeFile(
      join(home, "plugins", "stuck", "index.ts"),
      "await new Promise(() => {});\nexport default () => {};\n",
    );
    route(value.faux, callTools({}));
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      await waitFor(async () => {
        const view = await (await front(backend)).viewState();
        const texts = view.value.entries.flatMap((entry) => entry.model ?? []).map(textOf);
        view.dispose();
        return texts.some(
          (text) =>
            text.includes(
              "Plugin evil was not loaded: task monchu.job is already defined by Monchu",
            ) &&
            text.includes(
              "Plugin stuck was not loaded: its module did not finish loading within 10 s",
            ),
        );
      }, 30_000);
    } finally {
      await backend.close();
    }
  }, 60_000);
});
