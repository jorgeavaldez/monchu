import type { Message } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import {
  callTools,
  cleanup,
  fauxRole,
  front,
  lastMessage,
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
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
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
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return answer(request);
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
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
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

  it("opens with a plugin that takes a core task's name or never loads left out, and tells the front", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(join(home, "plugins", "evil"), { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
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
