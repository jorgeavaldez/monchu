import { getCurrentTools, Type, type Message } from "@earendil-works/pi-ai";
import { Type as TypeboxType } from "typebox";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import {
  callTools,
  cleanup,
  fauxRole,
  front,
  lastMessage,
  logText,
  prepareHome,
  route,
  sectionTexts,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

/** A plugin as an agent writes one: TypeScript, a relative import, and Monchu's packages without node_modules. */
const NOTES = `
import { defineTool, Type, type PluginApi } from "monchu/plugin";
import { Type as TypeboxType } from "typebox";
import { version } from "./version.ts";

export default function (monchu: PluginApi) {
  Reflect.set(globalThis, "monchuPluginProbe", { Type, TypeboxType });
  monchu.namespace({ description: "Notes kept by the notes plugin", instructions: "notes guide: read before writing" });
  monchu.registerTool(
    defineTool({
      name: "note_read",
      description: "Read the newest note",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "note " + version }] }),
    }),
  );
  monchu.registerTool(
    defineTool({
      name: "note_count",
      description: "Count the notes",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "3 notes" }] }),
    }),
    { exposure: "direct" },
  );
  monchu.registerSection("status", () => "notes section " + version);
  monchu.on("tool_call", (call) => (call.name === "bash" ? { block: "no bash while taking notes" } : undefined));
}
`;

/** Every handler throws: each failure is reported once and ignored. */
const THROWER = `
export default function (monchu) {
  monchu.on("tool_result", () => { throw new Error("result boom"); });
  monchu.on("context", () => { throw new Error("context boom"); });
  monchu.registerSection("broken", () => { throw new Error("section boom"); });
}
`;

async function plugin(home: string, name: string, files: Record<string, string>, local = false) {
  const dir = join(home, "plugins", ...(local ? ["local"] : []), name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
}

describe("plugins", () => {
  it("loads home plugins on their own, guards their handlers, and reloads them with their last good code", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    await plugin(home, "notes", {
      "index.ts": NOTES,
      "version.ts": `export const version = "v1";`,
    });
    await plugin(home, "broken", {
      "index.ts": "export default function (monchu) {\n  monchu.on(",
    });
    await plugin(home, "thrower", { "index.js": THROWER });
    await plugin(home, "clash", {
      "index.js": `import { defineTool, Type } from "monchu/plugin";
export default (monchu) => monchu.registerTool(defineTool({ name: "bash", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [] }) }));`,
    });
    const requests: Message[][] = [];
    const answer = callTools({
      load: { tool: "tool_search", args: { query: "notes" } },
      read: { tool: "note_read", args: {} },
      count: { tool: "note_count", args: {} },
      shell: { tool: "bash", args: { command: "echo hi" } },
      reload: { tool: "reload_extensions", args: {} },
    });
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return answer(request);
    });
    /** One turn, returning the text of the tool result it produced, if any. */
    const turn = async (backend: Monchu, text: string): Promise<string> => {
      const count = requests.length;
      await (await front(backend)).submit(text, `plugins:${text}:${count}`, "followUp");
      await waitFor(async () => {
        if (requests.length <= count) return false;
        const entries = await (await front(backend)).viewState();
        const last = lastMessage(entries.value.entries.flatMap((entry) => entry.model ?? []));
        entries.dispose();
        return last?.role === "assistant" && textOf(last) === "ok";
      });
      const result = requests
        .slice(count)
        .flat()
        .findLast((message) => message.role === "toolResult");
      return textOf(result);
    };
    const tools = () => getCurrentTools(requests.at(-1) ?? []).map((tool) => tool.name);
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      // The bad plugins are skipped with warnings naming them; Monchu and the good plugin load.
      await waitFor(async () => (await logText(home)).includes("Plugin clash"));
      const log = await logText(home);
      expect(log).toMatch(/Plugin broken was not loaded: .*index\.ts/);
      expect(log).toContain("Plugin clash was not loaded: tool bash is already defined by Monchu");
      const probe: unknown = Reflect.get(globalThis, "monchuPluginProbe");
      // One copy of each host package: the plugin's imports are Monchu's own.
      expect(probe).toEqual({ Type, TypeboxType });
      expect(Reflect.get(Object(probe), "Type")).toBe(Type);

      await turn(backend, "hello");
      const first = requests.at(-1) ?? [];
      expect(tools()).toContain("note_count");
      expect(tools()).not.toContain("note_read");
      // The direct tool comes after every core tool, and the deferred group is listed.
      expect(tools().at(-1)).toBe("note_count");
      expect(sectionTexts(first).join("\n")).toContain("notes section v1");
      expect(sectionTexts(first).join("\n")).toContain(
        "- plugin-notes: Notes kept by the notes plugin (note_read)",
      );
      // A section whose render throws is left out.
      expect(sectionTexts(first, "plugins")).toEqual([
        "<notes_status>\nnotes section v1\n</notes_status>",
      ]);

      expect(await turn(backend, "load")).toContain("notes guide: read before writing");
      expect(await turn(backend, "read")).toBe("note v1");
      expect(await turn(backend, "count")).toBe("3 notes");
      expect(await turn(backend, "shell")).toContain("no bash while taking notes");
      const warnings = await logText(home);
      for (const event of ["tool_result", "context", "section broken"])
        expect(warnings.split(`its ${event} handler failed and is ignored`).length - 1).toBe(1);

      // An edit to any of its files reloads it; the reload tool says what loaded.
      await writeFile(join(home, "plugins", "notes", "version.ts"), `export const version = "v2";`);
      expect(await turn(backend, "reload")).toContain(
        "Plugins: jj, notes, thrower; not loaded: broken (",
      );
      expect(await turn(backend, "read")).toBe("note v2");

      // Broken code keeps its last good code, and the rest of the reload goes ahead.
      await writeFile(join(home, "plugins", "notes", "index.ts"), "export default (");
      await rm(join(home, "plugins", "thrower"), { recursive: true });
      await backend.reload();
      expect(await turn(backend, "read")).toBe("note v2");
      expect(await logText(home)).toContain(
        "Plugin notes failed to load and keeps its last good code",
      );
      // A plugin that keeps its last good code keeps its section.
      expect(sectionTexts(requests.at(-1) ?? [], "plugins").at(-1)).toContain("notes section v2");

      // This device turns it off: its tools leave every conversation at the next reload.
      await writeFile(join(home, "plugins.local.json"), JSON.stringify({ disabled: ["notes"] }));
      expect(await turn(backend, "reload")).toContain("disabled: notes");
      await turn(backend, "after");
      expect(tools()).not.toContain("note_count");
      expect(tools()).not.toContain("note_read");
    } finally {
      await backend.close();
    }
  });

  it("gives plugins tasks, slash commands, secrets by name and Monchu's agents", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    await plugin(home, "pinger", {
      "index.ts": `
import { defineTask, defineTool, Type, type PluginApi } from "monchu/plugin";

export default function (monchu: PluginApi) {
  const Ping = defineTask<{ owner: number }, { phase: "run" }, null>({
    name: "pinger.ping",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const owner = await runtime.conversation(task.input.owner, context);
        await owner?.submit(
          { type: "input", content: monchu.agents.noticeText("pinged", "the task ran"), whenBusy: "followUp", requestId: "ping:1" },
          context,
        );
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
  });
  monchu.registerTask(Ping);
  monchu.registerTool(
    defineTool({
      name: "ping",
      description: "Ping later",
      parameters: Type.Object({}),
      execute: async (_args, api, context) => {
        const who = await api.commit(async (tx) => {
          const who = await monchu.agents.whois(tx, api.conversationId);
          await tx.createTask(Ping, { owner: api.conversationId }, {
            conversationId: api.conversationId,
            ownership: { kind: "conversation" },
            background: true,
          });
          return who;
        }, context);
        return { output: [{ type: "text", text: "role " + who?.role + " " + monchu.agents.shortId(api.conversationId) }] };
      },
    }),
    { exposure: "direct" },
  );
  monchu.registerCommand("hello", {
    usage: "[name]",
    help: "say hello",
    run: async (args) => "hi " + args + ", secret " + String(await monchu.secrets.value("NO_SUCH", { tool: "/hello", conversation: "user" })),
  });
}
`,
    });
    const requests: Message[][] = [];
    const answer = callTools({ ping: { tool: "ping", args: {} } });
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return answer(request);
    });
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      expect(backend.commands()).toEqual([{ name: "hello", usage: "[name]", help: "say hello" }]);
      expect(await backend.command("hello", "you")).toBe("hi you, secret undefined");
      await expect(backend.command("nope", "")).rejects.toThrow("Unknown command");
      await (await front(backend)).submit("ping", "ping:submit", "followUp");
      // The tool knows its caller is a front; its task outlives the turn and tells the front through Durable.
      await waitFor(() =>
        requests.some((request) => textOf(lastMessage(request)).includes("the task ran")),
      );
      const result = requests
        .flat()
        .find((message) => message.role === "toolResult" && textOf(message).startsWith("role"));
      expect(textOf(result)).toMatch(/^role front \S+$/);
    } finally {
      await backend.close();
    }
  });

  it("lets a device's own plugin replace a synced one, and an invalid deny list loads no home plugin", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    const tool = (text: string) => `import { defineTool, Type } from "monchu/plugin";
export default (monchu) => monchu.registerTool(defineTool({ name: "where", description: "Where this runs", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: ${JSON.stringify(text)} }] }) }), { exposure: "direct" });`;
    await plugin(home, "place", { "index.js": tool("synced") });
    await plugin(home, "place", { "index.js": tool("device") }, true);
    const requests: Message[][] = [];
    const answer = callTools({ where: { tool: "where", args: {} } });
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return answer(request);
    });
    let backend = await Monchu.open(home, value.faux.provider);
    try {
      await (await front(backend)).submit("where", "where:1", "followUp");
      await waitFor(() => requests.some((request) => textOf(lastMessage(request)) === "device"));
    } finally {
      await backend.close();
    }
    await writeFile(join(home, "plugins.local.json"), "{ not json");
    backend = await Monchu.open(home, value.faux.provider);
    try {
      await waitFor(async () =>
        (await logText(home)).includes("is invalid, so no home plugin loads"),
      );
      const count = requests.length;
      await (await front(backend)).submit("hello", "hello:2", "followUp");
      await waitFor(() => requests.length > count);
      expect(getCurrentTools(requests.at(-1) ?? []).map((entry) => entry.name)).not.toContain(
        "where",
      );
      // The bundled jj plugin still loads.
      expect(getCurrentTools(requests.at(-1) ?? []).map((entry) => entry.name)).toContain("jj");
    } finally {
      await backend.close();
    }
  });
});
