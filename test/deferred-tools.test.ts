import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  Type,
  type Message,
} from "@earendil-works/pi-ai";
import { defineTool, type Extension } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.ts";
import { loadMcpServers } from "../src/config.ts";
import { createMcpTools } from "../src/mcp-tools.ts";
import { McpClients } from "../src/mcp.ts";
import { createToolSearch, preloadGroups, type ToolGroup } from "../src/tool-search.ts";
import { startWorker, workerConversationId } from "../src/workers.ts";
import {
  cleanup,
  context,
  deliveryTaskId,
  fauxRole,
  lastMessage,
  open,
  route,
  sectionTexts,
  setup,
  textOf,
  toolResults,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

/** A stdio MCP server built on the SDK's own server, appending a line to `marker` each time it starts. */
async function fixtureServer(directory: string): Promise<{ script: string; marker: string }> {
  const script = join(directory, "fixture-server.mjs");
  const marker = join(directory, "starts.txt");
  const url = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));
  await writeFile(
    script,
    `import { Server } from ${url("@modelcontextprotocol/sdk/server/index.js")};
import { StdioServerTransport } from ${url("@modelcontextprotocol/sdk/server/stdio.js")};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${url("@modelcontextprotocol/sdk/types.js")};
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "start\\n");
const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: "fixture guide: crawl politely" },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
    { name: "crawl_site", description: "Crawl a whole site from a seed URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [{ type: "text", text: request.params.name + ":" + JSON.stringify(request.params.arguments) }],
}));
await server.connect(new StdioServerTransport());
`,
  );
  return { script, marker };
}

/**
 * An HTTP MCP server behind OAuth (the SDK's demo authorization server: dynamic registration, PKCE, auto-approve),
 * run as a child process. Resolves its MCP URL.
 */
async function oauthServer(directory: string): Promise<{ url: string; stop: () => void }> {
  const script = join(directory, "oauth-server.mjs");
  const url = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));
  const sdk = (path: string) => url(`@modelcontextprotocol/sdk/${path}`);
  await writeFile(
    script,
    `import express from ${url("express")};
import { z } from ${url("zod")};
import { McpServer } from ${sdk("server/mcp.js")};
import { StreamableHTTPServerTransport } from ${sdk("server/streamableHttp.js")};
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from ${sdk("server/auth/router.js")};
import { requireBearerAuth } from ${sdk("server/auth/middleware/bearerAuth.js")};
import { DemoInMemoryAuthProvider } from ${sdk("examples/server/demoInMemoryOAuthProvider.js")};
const app = express();
const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
const base = new URL("http://127.0.0.1:" + listener.address().port);
const mcpUrl = new URL("/mcp", base);
const provider = new DemoInMemoryAuthProvider();
app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: ["mcp:tools"] }));
const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
app.post("/mcp", auth, express.json(), async (req, res) => {
  const server = new McpServer({ name: "notes", version: "1" });
  server.registerTool("find_page", { description: "Find a page by title", inputSchema: { title: z.string() } }, async ({ title }) => ({ content: [{ type: "text", text: "page: " + title }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
console.log(mcpUrl.href);
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  const first: unknown[] = await once(child.stdout, "data");
  return { url: String(first[0]).trim(), stop: () => child.kill() };
}

async function starts(marker: string): Promise<number> {
  return (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

/** Install tool search over `groups` with the groups left out of the default selection, as Monchu does. */
function install(value: Setup, groups: readonly ToolGroup[], more: readonly Extension[] = []) {
  const search = createToolSearch(groups);
  for (const extension of [...more, search.extension, ...search.groups])
    value.registry.install(extension);
  const hidden = new Set(search.groups.map((group) => group.name));
  return {
    get extensions() {
      return value.registry
        .snapshot()
        .installed()
        .filter((extension) => !hidden.has(extension.name));
    },
  };
}

/** Tool names each request declared, in request order. */
function declared(requests: string[][]) {
  return (messages: readonly Message[]) =>
    requests.push(getCurrentTools(messages).map((tool) => tool.name));
}

describe("deferred tools", () => {
  it("lists MCP tools once, keeps direct ones in every request, and loads a deferred group with its guide", async () => {
    const value = await setup();
    const { script, marker } = await fixtureServer(value.directory);
    await writeFile(
      join(value.directory, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fix: {
            command: process.execPath,
            args: [script, marker],
            description: "fixture web tools",
            toolExposure: { echo: "direct" },
          },
        },
      }),
    );
    const servers = await loadMcpServers(value.directory);
    const warnings: string[] = [];
    const clients = new McpClients(value.directory, process.env, (warning) =>
      warnings.push(warning),
    );
    try {
      const mcp = await createMcpTools(servers, clients);
      expect(mcp.warnings).toEqual([]);
      expect(mcp.extension.tools?.map((tool) => tool.name)).toEqual(["fix_echo"]);
      expect(mcp.groups.map((group) => [group.name, group.tools.map((tool) => tool.name)])).toEqual(
        [["mcp-fix", ["fix_crawl_site"]]],
      );
      expect(await starts(marker)).toBe(1);

      const requests: string[][] = [];
      const record = declared(requests);
      route(value.faux, (request) => {
        record(request.messages);
        const last = lastMessage(request.messages);
        const text = last?.role === "user" ? textOf(last) : "";
        if (text === "echo")
          return fauxAssistantMessage([fauxToolCall("fix_echo", { text: "hi" })], {
            stopReason: "toolUse",
          });
        if (text === "load")
          return fauxAssistantMessage([fauxToolCall("tool_search", { query: "crawl a site" })], {
            stopReason: "toolUse",
          });
        if (text === "crawl")
          return fauxAssistantMessage(
            [fauxToolCall("fix_crawl_site", { url: "https://example.com" })],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage("ok");
      });
      const settings = install(value, mcp.groups, [mcp.extension]);
      const { harness, root } = await open(value, settings);
      try {
        await (await root.submit({ type: "input", content: "echo" }, context)).wait(context);
        expect(requests[0]).toContain("fix_echo");
        expect(requests[0]).toContain("tool_search");
        expect(requests[0]).not.toContain("fix_crawl_site");

        await (await root.submit({ type: "input", content: "load" }, context)).wait(context);
        await (await root.submit({ type: "input", content: "crawl" }, context)).wait(context);
        expect(requests.at(-1)).toContain("fix_crawl_site");

        const results = await toolResults(root);
        expect(results.map((result) => [result.toolName, result.isError])).toEqual([
          ["fix_echo", false],
          ["tool_search", false],
          ["fix_crawl_site", false],
        ]);
        expect(textOf(results[0])).toBe('echo:{"text":"hi"}');
        expect(textOf(results[1])).toContain("Loaded mcp-fix");
        expect(textOf(results[1])).toContain("fixture guide: crawl politely");
        expect(textOf(results[2])).toBe('crawl_site:{"url":"https://example.com"}');
        // One server process served the listing and every call.
        expect(await starts(marker)).toBe(1);
      } finally {
        await harness.close(context);
      }
    } finally {
      await clients.close();
    }

    // A new process builds the same tools from the cached listing without starting the server.
    const again = new McpClients(value.directory, process.env, () => {});
    try {
      const mcp = await createMcpTools(servers, again);
      expect(mcp.groups[0]?.tools.map((tool) => tool.name)).toEqual(["fix_crawl_site"]);
      expect(await starts(marker)).toBe(1);
    } finally {
      await again.close();
    }
    expect(warnings).toEqual([]);
  });

  it("shows the deferred section on every request, and a worker starts from the base tools", async () => {
    const value = await setup();
    const requests: string[][] = [];
    const sections: string[][] = [];
    const record = declared(requests);
    const settings = install(value, [
      {
        name: "notes",
        summary: "save and find notes",
        tools: [
          defineTool({
            name: "save_note",
            description: "Save a note for later",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "saved" }] }),
          }),
        ],
        details: async () => "notes guide",
      },
    ]);
    route(value.faux, (request) => {
      record(request.messages);
      sections.push(sectionTexts(request.messages, "deferred_tools"));
      const last = lastMessage(request.messages);
      if (last?.role === "user" && textOf(last) === "load")
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "notes" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open(value, settings);
    try {
      await (await root.submit({ type: "input", content: "load" }, context)).wait(context);
      expect(requests.at(-1)).toContain("save_note");
      // One section in the first system message: loading a group never rewrites the prompt.
      for (const texts of sections) {
        expect(texts).toHaveLength(1);
        expect(texts[0]).toContain("- notes: save and find notes (save_note)");
      }
      const [loaded] = await toolResults(root);
      expect(textOf(loaded)).toContain("<notes_guide>\nnotes guide\n</notes_guide>");

      await root.commit(
        (tx) => startWorker(tx, root.id, "w", "work", value.directory, "w:0", fauxRole),
        context,
      );
      harness.resume();
      await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
      const worker = await harness.conversation(
        await workerConversationId(harness, root.id, "w", context),
        context,
      );
      const workerTools = (await worker?.agent(context))?.tools.map((tool) => tool.name);
      expect(workerTools).toContain("tool_search");
      expect(workerTools).not.toContain("save_note");
      expect((await root.agent(context)).tools.map((tool) => tool.name)).toContain("save_note");
    } finally {
      await harness.close(context);
    }
  });

  it("lets codemode find and call a deferred tool without loading it", async () => {
    const value = await setup();
    const settings = install(value, [
      {
        name: "weather",
        summary: "forecasts",
        tools: [
          defineTool({
            name: "weather_forecast",
            description: "Forecast the weather for a city",
            parameters: Type.Object({ city: Type.String() }),
            execute: async ({ city }) => ({
              content: [{ type: "text", text: `sunny in ${city}` }],
            }),
          }),
        ],
      },
    ]);
    const requests: string[][] = [];
    const record = declared(requests);
    route(value.faux, (request) => {
      record(request.messages);
      const last = lastMessage(request.messages);
      if (last?.role === "user" && textOf(last) === "script")
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `const [found] = await searchTools("weather forecast city");
text(found.name);
text(found.description.includes("city: string") ? "typed" : found.description);
text(await tools[found.name]({ city: "Tampa" }));`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open(value, settings);
    try {
      await (await root.submit({ type: "input", content: "script" }, context)).wait(context);
      const [result] = await toolResults(root);
      expect(result?.isError).toBe(false);
      expect(textOf(result)).toBe("weather_forecast\ntyped\nsunny in Tampa");
      for (const names of requests) expect(names).not.toContain("weather_forecast");
    } finally {
      await harness.close(context);
    }
  });

  it("signs in to an OAuth HTTP server, keeps its token per device, and defers its tools", async () => {
    const value = await setup();
    const server = await oauthServer(value.directory);
    try {
      await writeFile(
        join(value.directory, "mcp.json"),
        JSON.stringify({ mcpServers: { notes: { url: server.url, description: "team notes" } } }),
      );
      const servers = await loadMcpServers(value.directory);
      const clients = new McpClients(value.directory, process.env, () => {});
      try {
        const before = await createMcpTools(servers, clients);
        expect(before.warnings).toEqual([
          "MCP server notes needs sign-in: run /login and pick notes",
        ]);
        expect(before.groups).toEqual([]);
        const notes = servers.notes;
        if (notes === undefined) throw new Error("notes missing");
        // The demo server approves at once and redirects to the loopback callback, as a browser would.
        const opened: string[] = [];
        await clients.login(
          "notes",
          notes,
          (url) => {
            opened.push(url);
            void fetch(url);
          },
          AbortSignal.timeout(20_000),
        );
        expect(opened).toHaveLength(1);
        // Windows has no POSIX modes to check.
        if (process.platform !== "win32")
          expect((await stat(join(value.directory, "mcp-auth.json"))).mode & 0o777).toBe(0o600);
      } finally {
        await clients.close();
      }
      // A new process uses the stored token without signing in again.
      const again = new McpClients(value.directory, process.env, () => {});
      try {
        const after = await createMcpTools(servers, again);
        expect(after.warnings).toEqual([]);
        const group = after.groups[0];
        expect(group?.name).toBe("mcp-notes");
        expect(group?.tools.map((tool) => tool.name)).toEqual(["notes_find_page"]);
        const notes = servers.notes;
        if (notes === undefined) throw new Error("notes missing");
        const result = await again.call(
          "notes",
          notes,
          "find_page",
          { title: "Roadmap" },
          undefined,
        );
        expect(result).toEqual({
          content: [{ type: "text", text: "page: Roadmap" }],
          isError: false,
        });
      } finally {
        await again.close();
      }
    } finally {
      server.stop();
    }
  });

  it("turns a server whose command is missing on this device into one warning", async () => {
    const value = await setup();
    await writeFile(
      join(value.directory, "mcp.json"),
      JSON.stringify({ mcpServers: { gone: { command: "monchu-no-such-command" } } }),
    );
    const clients = new McpClients(value.directory, process.env, () => {});
    try {
      const mcp = await createMcpTools(await loadMcpServers(value.directory), clients);
      expect(mcp.warnings).toEqual([
        "monchu-no-such-command is not installed or not on PATH here, so gone's tools are off on this device",
      ]);
      expect(mcp.extension.tools).toEqual([]);
      expect(mcp.groups).toEqual([]);
    } finally {
      await clients.close();
    }
  });

  it("preloads groups marked preload only for conversations on the Claude Code bridge", async () => {
    const value = await setup();
    const tool = (name: string) =>
      defineTool({
        name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: name }] }),
      });
    const search = createToolSearch([
      { name: "small", summary: "small", tools: [tool("small_tool")], preload: true },
      { name: "big", summary: "big", tools: [tool("big_tool")] },
    ]);
    expect(search.preload).toEqual(["monchu.group.small"]);
    const settings = install(value, [
      { name: "small", summary: "small", tools: [tool("small_tool")], preload: true },
      { name: "big", summary: "big", tools: [tool("big_tool")] },
    ]);
    const { harness, root } = await open(value, settings);
    try {
      const claude = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "claude-code", modelId: "claude-opus-5-5" } },
        },
        context,
      );
      for (const conversation of [root, claude])
        await conversation.commit(
          (tx) => preloadGroups(tx, conversation.id, search.preload),
          context,
        );
      const names = async (conversation: typeof root) =>
        (await conversation.agent(context)).tools.map((each) => each.name);
      expect(await names(claude)).toContain("small_tool");
      expect(await names(claude)).not.toContain("big_tool");
      // Codex and other providers load in place without a cache miss, so they keep searching.
      expect(await names(root)).not.toContain("small_tool");
    } finally {
      await harness.close(context);
    }
  });

  // A fake agent-browser is a shell script; Windows would need a .cmd shim.
  it.skipIf(process.platform === "win32")(
    "runs agent_browser in its root's session for the root and its workers, with the CLI guide on load",
    async () => {
      const value = await setup();
      const bin = join(value.directory, "bin");
      await mkdir(bin);
      const fake = join(bin, "agent-browser");
      await writeFile(
        fake,
        `#!/bin/sh\nif [ "$1" = skills ]; then echo "BROWSER GUIDE"; else echo "ran: $*"; fi\n`,
      );
      await chmod(fake, 0o755);
      const path = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
      try {
        const settings = install(value, [Browser]);
        route(value.faux, (request) => {
          const last = lastMessage(request.messages);
          if (last?.role === "user" && textOf(last).includes("BROWSE"))
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "browser" })], {
              stopReason: "toolUse",
            });
          if (last?.role === "toolResult" && last.toolName === "tool_search")
            return fauxAssistantMessage(
              [fauxToolCall("agent_browser", { args: ["open", "https://example.com"] })],
              { stopReason: "toolUse" },
            );
          return fauxAssistantMessage("done");
        });
        const { harness, root } = await open(value, settings);
        try {
          await (await root.submit({ type: "input", content: "BROWSE" }, context)).wait(context);
          await root.commit(
            (tx) => startWorker(tx, root.id, "w", "BROWSE too", value.directory, "w:0", fauxRole),
            context,
          );
          harness.resume();
          await harness.waitForTask(await deliveryTaskId(harness, root.id, -1), context);
          const worker = await harness.conversation(
            await workerConversationId(harness, root.id, "w", context),
            context,
          );
          if (worker === undefined) throw new Error("worker missing");
          for (const conversation of [root, worker]) {
            const results = await toolResults(conversation);
            const search = results.find((result) => result.toolName === "tool_search");
            expect(textOf(search)).toContain("BROWSER GUIDE");
            const browse = results.find((result) => result.toolName === "agent_browser");
            expect(browse?.isError).toBe(false);
            expect(textOf(browse).trim()).toBe(
              `ran: --session monchu-${root.id} open https://example.com`,
            );
          }
        } finally {
          await harness.close(context);
        }
      } finally {
        process.env.PATH = path;
      }
    },
  );
});
