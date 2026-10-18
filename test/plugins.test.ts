import { getCurrentTools, Type, type Message } from "@earendil-works/pi-ai";
import { Type as TypeboxType } from "typebox";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Monchu } from "../src/core/backend.ts";
import { defaultConfig } from "../src/core/config.ts";
import { Plugins } from "../src/core/plugins.ts";
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
  monchu.registerTool(
    defineTool({
      name: "note_read",
      label: "Read note",
      description: "Read the newest note",
      parameters: Type.Object({}),
      namespace: { description: "Notes kept by the notes plugin", instructions: "notes guide: read before writing" },
      execute: async () => ({ content: [{ type: "text", text: "note " + version }] }),
    }),
  );
  monchu.registerTool(
    defineTool({
      name: "note_count",
      description: "Count the notes",
      parameters: Type.Object({}),
      exposure: "direct",
      execute: async () => ({ content: [{ type: "text", text: "3 notes" }] }),
    }),
  );
  monchu.registerSection("status", () => "notes section " + version);
  monchu.on("tool_call", (event) =>
    event.toolName === "bash" ? { block: true, reason: "no bash while taking notes" } : undefined,
  );
}
`;

/**
 * Handlers that throw, each reported once: a guard that throws fails closed (the call is blocked, the result withheld);
 * any other handler counts as returning nothing.
 */
const THROWER = `
export default function (monchu) {
  monchu.on("tool_call", (event) => { if (event.toolName === "read") throw new Error("call boom"); });
  monchu.on("tool_result", (event) => { if (event.toolName === "note_count") throw new Error("result boom"); });
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
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
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
export default (monchu) => monchu.registerTool(defineTool({ name: "bash", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [] }) }));`,
    });
    const requests: Message[][] = [];
    const answer = callTools({
      load: { tool: "tool_search", args: { query: "notes" } },
      read: { tool: "note_read", args: {} },
      count: { tool: "note_count", args: {} },
      shell: { tool: "bash", args: { command: "echo hi" } },
      file: { tool: "read", args: { path: "AGENTS.md" } },
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
      expect(await turn(backend, "count")).toBe(
        "A plugin's tool_result handler failed, so this result is withheld.",
      );
      expect(await turn(backend, "shell")).toContain("no bash while taking notes");
      expect(await turn(backend, "file")).toContain(
        "A plugin's tool_call guard failed, so the call is blocked.",
      );
      const warnings = await logText(home);
      for (const event of ["tool_call", "tool_result", "context", "section broken"])
        expect(warnings.split(`its ${event} handler failed`).length - 1).toBe(1);

      // An edit to any of its files reloads it; the reload tool says what loaded.
      await writeFile(join(home, "plugins", "notes", "version.ts"), `export const version = "v2";`);
      expect(await turn(backend, "reload")).toContain(
        "Plugins: clef, jj, notes, thrower; not loaded: broken (",
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
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
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
      exposure: "direct",
      execute: async (_id, _args, _signal, _update, ctx) => {
        const { api, context } = ctx.durable;
        ctx.ui.notify("ping started");
        const who = await api.commit(async (tx) => {
          const who = await monchu.agents.whois(tx, api.conversationId);
          await tx.createTask(Ping, { owner: api.conversationId }, {
            conversationId: api.conversationId,
            ownership: { kind: "conversation" },
            background: true,
          });
          return who;
        }, context);
        return { content: [{ type: "text", text: "role " + who?.role + " " + monchu.agents.shortId(api.conversationId) }] };
      },
    }),
  );
  monchu.registerCommand("hello", {
    usage: "[name]",
    description: "say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("hi " + args + " (" + ctx.caller + "), secret " + String(await monchu.secrets.value("NO_SUCH", { tool: "/hello", conversation: "user" })));
      ctx.ui.setStatus("hello", "said hello to " + args);
    },
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
      expect(backend.commands()).toContainEqual({
        name: "hello",
        usage: "[name]",
        help: "say hello",
      });
      const root = await front(backend);
      expect(await root.command("hello", "you")).toBe("hi you (person), secret undefined");
      expect(await root.command("hello", "a service", undefined, "service")).toBe(
        "hi a service (service), secret undefined",
      );
      await expect(root.command("nope", "")).rejects.toThrow("Unknown command");
      // A status line shows whenever a client opens the root.
      await waitFor(async () => (await root.statusLines()).includes("said hello to a service"));
      const lines: string[] = [];
      const stop = await root.watchNotices((items) =>
        lines.splice(0, lines.length, ...items.map((item) => item.text)),
      );
      await root.submit("ping", "ping:submit", "followUp");
      // A tool's ctx.ui.notify reaches the root's clients, never the model.
      await waitFor(() => lines.includes("ping started"));
      stop();
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

  it("lets a device's own plugin and settings replace synced ones, and an invalid device file loads no home plugin", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    const tool = (text: string) => `import { defineTool, Type } from "monchu/plugin";
export default (monchu) => monchu.registerTool(defineTool({ name: "where", description: "Where this runs", parameters: Type.Object({}), exposure: "direct", execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(text)} + " " + JSON.stringify(monchu.config) }] }) }));`;
    // Shared settings sync in config.json; this device's override them field by field.
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        front: fauxRole,
        worker: fauxRole,
        plugins: { clef: null, place: { who: "synced", port: 1 } },
      }),
    );
    await writeFile(
      join(home, "plugins.local.json"),
      JSON.stringify({ settings: { place: { who: "device" } } }),
    );
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
      await waitFor(() =>
        requests.some(
          (request) => textOf(lastMessage(request)) === 'device {"who":"device","port":1}',
        ),
      );
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

  it("adds a plugin's provider to the home's models only when its build runs", async () => {
    const value = await setup();
    await plugin(value.directory, "maker", {
      "index.js": `import { createProvider } from "@earendil-works/pi-ai";
export default (monchu) => {
  const provider = createProvider({ id: "made", name: "Made", auth: { apiKey: { name: "Made key", resolve: async () => undefined } }, models: [], classifiers: { none: { classify: async () => { throw new Error("unused"); } } } });
  monchu.registerProvider(provider);
  // The plugin's own view finds it at once.
  Reflect.set(globalThis, "madeSeen", monchu.models.getProvider("made") === provider);
};`,
    });
    const plugins = new Plugins({
      home: value.directory,
      report: (warning) => value.reports.push(warning),
      vault: value.vault,
      models: value.models,
      saveSettings: async () => {},
    });
    const reserved = { tools: new Set<string>(), tasks: new Set<string>() };
    const config = { ...defaultConfig(), plugins: { clef: null } };
    const running = (await plugins.load(config)).use(reserved);
    expect(running.status).toContainEqual({ name: "maker", source: "home", state: "loaded" });
    expect(Reflect.get(globalThis, "madeSeen")).toBe(true);
    expect(value.models.getProvider("made")).toBeUndefined();
    plugins.settle(running);
    const live = value.models.getProvider("made");
    expect(live?.name).toBe("Made");
    // A second copy, as the home check or a failed reload runs, never replaces the live one.
    (await plugins.load(config)).use(reserved);
    expect(value.models.getProvider("made")).toBe(live);
    plugins.settle(running);
    expect(value.models.getProvider("made")).toBe(live);
    plugins.close();
    expect(value.models.getProvider("made")).toBeUndefined();
  });

  it("lets a device null a shared setting, ignores a transform without text, and shuts down only copies that ran", async () => {
    const value = await setup();
    await plugin(value.directory, "keeper", {
      "index.js": `export default (monchu) => {
  const seen = Reflect.get(globalThis, "keeperSeen") ?? [];
  seen.push(monchu.config);
  Reflect.set(globalThis, "keeperSeen", seen);
  monchu.on("input", () => ({ action: "transform" }));
  monchu.on("session_shutdown", () => Reflect.set(globalThis, "keeperDown", (Reflect.get(globalThis, "keeperDown") ?? 0) + 1));
};`,
    });
    await writeFile(
      join(value.directory, "plugins.local.json"),
      JSON.stringify({ settings: { keeper: null } }),
    );
    const plugins = new Plugins({
      home: value.directory,
      report: (warning) => value.reports.push(warning),
      vault: value.vault,
      models: value.models,
      saveSettings: async () => {},
    });
    const reserved = { tools: new Set<string>(), tasks: new Set<string>() };
    const config = { ...defaultConfig(), plugins: { clef: null, keeper: { on: true } } };
    const running = (await plugins.load(config)).use(reserved);
    plugins.settle(running);
    // The device's null wins over the shared setting.
    expect(Reflect.get(globalThis, "keeperSeen")).toEqual([null]);
    const seen = await running.front.input(
      {
        text: "hello",
        source: "interactive",
        streamingBehavior: "followUp",
        messages: async () => [],
      },
      ROOT_CONVERSATION_ID,
    );
    expect(seen.text).toBe("hello");
    expect(value.reports.join("\n")).toContain("its transform has no text");
    // A second copy, as the home check runs, is retired without a shutdown; the running copy gets one at close.
    (await plugins.load(config)).use(reserved);
    plugins.settle(running);
    expect(Reflect.get(globalThis, "keeperDown")).toBeUndefined();
    plugins.close();
    await waitFor(() => Reflect.get(globalThis, "keeperDown") === 1);
  });
});
