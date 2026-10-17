import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fauxAssistantMessage, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { CompactionEntry } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import { loadConfig, type ClaudeConfig } from "../src/core/config.ts";
import { createClaudeCodeProvider } from "../src/core/models/claude-code.ts";
import { configuredRoles, openModels } from "../src/core/models/index.ts";
import { Extensions } from "../src/core/reload.ts";
import {
  allEntries,
  claudeResponse,
  cleanup,
  context,
  open,
  openClaudeModels,
  scriptedClaude,
  setup,
  textOf,
  toolResults,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const config: ClaudeConfig = {
  executable: process.execPath,
  plan: "pro",
  longContextExtraUsage: false,
};
const token = "sk-ant-oat01-scripted-monchu-token";
const role = {
  provider: "claude-code",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "high" as const,
};

describe("Claude Code subscription provider", () => {
  it("offers Opus, Sonnet and Haiku to both chat roles, with the bridge's explicit long-context gates", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    const current = await loadConfig(value.directory);
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const selected = { ...role, modelId: id };
      const chosen = { front: true, worker: true };
      expect(
        (await configuredRoles(models, { ...current, front: selected, worker: selected, chosen }))
          .warnings,
      ).toEqual([]);
      expect(models.getModel("claude-code", id)?.contextWindow).toBe(200000);
    }
    for (const [plan, extra, opus, sonnet] of [
      ["pro", false, 200000, 200000],
      ["max", false, 1000000, 200000],
      ["pro", true, 1000000, 1000000],
    ] as const) {
      const provider = createClaudeCodeProvider(value.directory, {
        ...config,
        plan,
        longContextExtraUsage: extra,
      });
      expect(
        provider.getModels().find((model) => model.id === "claude-opus-4-6")?.contextWindow,
      ).toBe(opus);
      expect(
        provider.getModels().find((model) => model.id === "claude-sonnet-4-6")?.contextWindow,
      ).toBe(sonnet);
      expect(
        provider.getModels().find((model) => model.id === "claude-opus-5-5")?.contextWindow,
      ).toBe(1000000);
    }
  });

  it("stores only setup-tokens locally, rejects API-key login and reopens without ambient credentials", async () => {
    const value = await setup();
    const models = await openModels(value.directory);
    const prompts: string[] = [];
    await models.login("claude-code", "oauth", {
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        return token;
      },
      notify: () => {},
    });
    expect(prompts).toEqual(["secret"]);
    const reopened = await openModels(value.directory);
    expect(await reopened.getAuth("claude-code")).toMatchObject({ auth: { apiKey: token } });
    expect(JSON.stringify(reopened.getModels())).not.toContain(token);
    await expect(
      models.login("claude-code", "oauth", {
        prompt: async () => "sk-ant-api03-not-a-subscription",
        notify: () => {},
      }),
    ).rejects.toThrow("setup-token");
    await expect(
      models.login("claude-code", "api_key", {
        prompt: async () => "not-used",
        notify: () => {},
      }),
    ).rejects.toThrow();
    expect(await readFile(join(value.directory, "auth.json"), "utf8")).toContain(token);
    await reopened.logout("claude-code");
    expect(await reopened.getAuth("claude-code")).toBeUndefined();
  });

  it("streams text, signed thinking, usage and length, persisting through the terminal SDK result", async () => {
    const value = await setup();
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse(
        [
          { type: "thinking", thinking: "considering", thinkingSignature: "sig-preserved" },
          { type: "text", text: "hello" },
        ],
        "max_tokens",
      );
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { reasoning: "high", sessionId: "streamed-text" },
    );
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result).toMatchObject({
      stopReason: "length",
      providerThinkingLevel: "high",
      content: [
        { type: "thinking", thinking: "considering", thinkingSignature: "sig-preserved" },
        { type: "text", text: "hello" },
      ],
      usage: { input: 10, output: 7, cacheRead: 20, cacheWrite: 30, reasoning: 3, totalTokens: 67 },
    });
    expect(script.closed()).toBe(1);
    expect(script.interrupted()).toBe(1);
    expect(script.requests[0]?.input.options).toMatchObject({
      model: "claude-sonnet-4-6",
      pathToClaudeCodeExecutable: process.execPath,
      tools: [],
      skills: [],
      plugins: [],
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      persistSession: true,
      effort: "high",
      env: {
        CLAUDE_CONFIG_DIR: join(value.directory, "claude"),
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CODE_MAX_RETRIES: "0",
      },
    });
  });

  it("parks one query across Durable tool rounds, pairs out-of-order MCP calls, and rebuilds after restart", async () => {
    const value = await setup();
    await writeFile(join(value.directory, "known.txt"), "durable-owned file");
    let declarations: Awaited<ReturnType<Client["listTools"]>> | undefined;
    const delivered: Awaited<ReturnType<Client["callTool"]>>[] = [];
    const script = scriptedClaude(value.directory, config, async function* (input) {
      const server = input.options?.mcpServers?.monchu;
      assert(server?.type === "sdk");
      const client = new Client({ name: "script", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        declarations = await client.listTools();
        await expect(client.callTool({ name: "read", arguments: {} })).rejects.toThrow(
          "claudecode/toolUseId",
        );
        // The handler for read_2 arrives first. read_1 is called only after Durable has sent both results.
        const second = client.callTool({
          name: "read",
          arguments: {},
          _meta: { "claudecode/toolUseId": "read_2" },
        });
        yield* claudeResponse(
          [
            {
              type: "thinking",
              thinking: "read files",
              thinkingSignature: "signature-survives-restart",
            },
            fauxToolCall("read", { path: "known.txt" }, { id: "read_1" }),
            fauxToolCall("read", { path: "missing.txt" }, { id: "read_2" }),
          ],
          "tool_use",
        );
        delivered.push(await second);
        delivered.push(
          await client.callTool({
            name: "read",
            arguments: {},
            _meta: { "claudecode/toolUseId": "read_1" },
          }),
        );
        yield* claudeResponse([{ type: "text", text: "used the durable results" }]);
      } finally {
        await client.close();
      }
    });
    let models = await openClaudeModels(value.directory, script.provider, token);
    let { harness, root } = await open({ ...value, models });
    const rootId = root.id;
    try {
      await root.configure({ model: role, thinkingLevel: role.thinkingLevel }, context);
      await (
        await root.submit({ type: "input", content: "read both files" }, context)
      ).wait(context);
      expect(script.requests).toHaveLength(1);
      const results = await toolResults(root);
      expect(results).toHaveLength(2);
      expect(delivered).toEqual([
        {
          content: results.find((result) => result.toolCallId === "read_2")?.content,
          isError: true,
        },
        {
          content: results.find((result) => result.toolCallId === "read_1")?.content,
          isError: false,
        },
      ]);
      expect(textOf(results.find((result) => result.toolCallId === "read_1"))).toContain(
        "durable-owned file",
      );
      expect(declarations?.tools.find((tool) => tool.name === "read")?.inputSchema).toEqual(
        (await root.agent(context)).tools.find((tool) => tool.name === "read")?.parameters,
      );
      expect(script.requests[0]?.prompt).toHaveLength(1);
      expect(script.closed()).toBe(1);
      expect(script.requests[0]?.path).toBeDefined();
      await expect(readFile(script.requests[0]?.path ?? "")).resolves.toBeDefined();
    } finally {
      await harness.close(context);
    }
    const restarted = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "after restart" }]);
    });
    models = await openModels(value.directory, restarted.provider);
    ({ harness, root } = await open({ ...value, models }));
    try {
      expect(root.id).toBe(rootId);
      await root.configure({ model: role }, context);
      await (await root.submit({ type: "input", content: "continue" }, context)).wait(context);
      expect(restarted.requests[0]?.history.map((record) => record.type)).toEqual([
        "user",
        "assistant",
        "user",
        "user",
        "assistant",
      ]);
      expect(restarted.requests[0]?.prompt[0]?.message.content).toEqual([
        { type: "text", text: "continue" },
      ]);
      expect(restarted.requests[0]?.history[1]?.message.content).toContainEqual({
        type: "thinking",
        thinking: "read files",
        signature: "signature-survives-restart",
      });
      expect(
        (await allEntries(root)).some((entry) =>
          entry.model?.some((message) => textOf(message) === "after restart"),
        ),
      ).toBe(true);
    } finally {
      await harness.close(context);
    }
    expect(restarted.closed()).toBe(1);
  });

  it("reuses the persisted UUID, rebuilds missed or rewritten history, and preserves it for shorter contexts", async () => {
    const value = await setup();
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "answer" }]);
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const options = { sessionId: "stable-conversation", reasoning: "high" as const };
    const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
    messages.push(await models.completeSimple(model, { messages }, options));
    messages.push({ role: "user", content: "two", timestamp: 2 });
    messages.push(await models.completeSimple(model, { messages }, options));
    const firstPath = script.requests[0]?.path;
    assert(firstPath);
    expect(script.requests[1]?.path).toBe(firstPath);
    expect(script.requests[1]?.input.options?.resume).toBe(basename(firstPath, ".jsonl"));
    expect(script.requests[1]?.history).toHaveLength(2);
    // A short synthetic context gets a clean ephemeral query, not the shared file.
    await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "short", timestamp: 3 }] },
      options,
    );
    const shortPath = script.requests[2]?.path;
    assert(shortPath);
    expect(shortPath).not.toBe(firstPath);
    expect(script.requests[2]?.input.options?.resume).toBeUndefined();
    await expect(readFile(shortPath)).rejects.toMatchObject({ code: "ENOENT" });
    messages.push({ role: "user", content: "three", timestamp: 4 });
    messages.push(await models.completeSimple(model, { messages }, options));
    expect(script.requests[3]?.path).toBe(firstPath);
    expect(script.requests[3]?.history).toHaveLength(4);
    // Missed messages came from another provider, so rewrite the mirror in place.
    messages.push(
      { role: "user", content: "external", timestamp: 5 },
      fauxAssistantMessage("external answer"),
      { role: "user", content: "four", timestamp: 6 },
    );
    messages.push(await models.completeSimple(model, { messages }, options));
    expect(script.requests[4]?.path).toBe(firstPath);
    expect(script.requests[4]?.history).toHaveLength(8);
    messages[0] = { role: "user", content: "rewritten", timestamp: 1 };
    messages.push({ role: "user", content: "five", timestamp: 7 });
    messages.push(await models.completeSimple(model, { messages }, options));
    expect(script.requests[5]?.path).toBe(firstPath);
    expect(script.requests[5]?.history[0]?.message.content).toBe("rewritten");
    // No missed messages is also REUSE (a non-user continuation over exactly the consumed prefix).
    const consumed = [...messages];
    await models.completeSimple(model, { messages: consumed }, options);
    expect(script.requests[6]?.path).toBe(firstPath);
    await models.completeSimple(model, { messages: consumed }, options);
    expect(script.requests[7]?.path).toBe(firstPath);
  });

  it("rotates after an abort and rebuilds an orphaned tool result with the bridge continuation prompt", async () => {
    const value = await setup();
    const entered = Promise.withResolvers<void>();
    let attempt = 0;
    const script = scriptedClaude(value.directory, config, async function* (input) {
      attempt++;
      if (attempt !== 2) {
        yield* claudeResponse([{ type: "text", text: "answer" }]);
        return;
      }
      entered.resolve();
      const signal = input.options?.abortController?.signal;
      assert(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const options = { sessionId: "aborted-conversation" };
    const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
    messages.push(await models.completeSimple(model, { messages }, options));
    messages.push({ role: "user", content: "abort", timestamp: 2 });
    const abort = new AbortController();
    const pending = models.completeSimple(
      model,
      { messages },
      { ...options, signal: abort.signal },
    );
    await entered.promise;
    abort.abort();
    expect((await pending).stopReason).toBe("aborted");
    messages.push(
      fauxAssistantMessage([fauxToolCall("read", {}, { id: "orphan" })], { stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "read",
        content: [{ type: "text", text: "actual recovered result" }],
        isError: false,
        timestamp: 3,
      },
    );
    expect((await models.completeSimple(model, { messages }, options)).stopReason).toBe("stop");
    expect(script.requests[2]?.path).not.toBe(script.requests[0]?.path);
    expect(script.requests[2]?.history.at(-1)?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "orphan",
        content: [{ type: "text", text: "actual recovered result" }],
      },
    ]);
    expect(script.requests[2]?.prompt[0]?.message.content).toBe(
      "[Your context was compacted. What precedes this is a summary plus the most recent messages, ending with the tool result you were waiting for. Continue the task from there.]",
    );
  });

  it("discards and rotates a query whose history was rewritten while parked", async () => {
    const value = await setup();
    let attempt = 0;
    let released = false;
    const script = scriptedClaude(value.directory, config, async function* (input) {
      attempt++;
      if (attempt > 1) {
        yield* claudeResponse([{ type: "text", text: "rebuilt" }]);
        return;
      }
      const server = input.options?.mcpServers?.monchu;
      assert(server?.type === "sdk");
      const client = new Client({ name: "rewrite", version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(right);
      await client.connect(left);
      try {
        const pending = client.callTool({
          name: "read",
          arguments: {},
          _meta: { "claudecode/toolUseId": "rewrite_tool" },
        });
        void pending.catch(() => {});
        yield* claudeResponse([fauxToolCall("read", {}, { id: "rewrite_tool" })], "tool_use");
        try {
          await pending;
          released = true;
        } catch {}
      } finally {
        await client.close();
      }
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const tools = [{ name: "read", description: "read", parameters: Type.Object({}) }];
    const options = { sessionId: "rewritten-conversation" };
    const first = await models.completeSimple(
      model,
      { tools, messages: [{ role: "user", content: "original", timestamp: 1 }] },
      options,
    );
    expect(first.stopReason).toBe("toolUse");
    expect(script.closed()).toBe(0);
    const summary = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "summarize", timestamp: 2 }] },
      { ...options, cacheRetention: "none" },
    );
    expect(textOf(summary)).toBe("rebuilt");
    expect(script.closed()).toBe(1);
    expect(script.requests[1]?.input.options?.persistSession).toBe(false);
    const result = await models.completeSimple(
      model,
      {
        tools,
        messages: [
          { role: "user", content: "compacted", timestamp: 2 },
          first,
          {
            role: "toolResult",
            toolCallId: "rewrite_tool",
            toolName: "read",
            content: [{ type: "text", text: "real result" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      options,
    );
    expect(textOf(result)).toBe("rebuilt");
    expect(released).toBe(false);
    expect(script.requests).toHaveLength(3);
    expect(script.requests[2]?.path).not.toBe(script.requests[0]?.path);
    expect(script.requests[2]?.history[0]?.message.content).toBe("compacted");
    expect(script.closed()).toBe(3);
  });

  it("starts a new query with the parked turn's result when tools are added mid-run", async () => {
    const value = await setup();
    let attempt = 0;
    const listed: string[][] = [];
    const script = scriptedClaude(value.directory, config, async function* (input) {
      attempt++;
      const server = input.options?.mcpServers?.monchu;
      assert(server?.type === "sdk");
      const client = new Client({ name: "added", version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(right);
      await client.connect(left);
      try {
        listed.push((await client.listTools()).tools.map((tool) => tool.name));
        if (attempt > 1) {
          yield* claudeResponse([{ type: "text", text: "used the new tool" }]);
          return;
        }
        const pending = client.callTool({
          name: "tool_search",
          arguments: {},
          _meta: { "claudecode/toolUseId": "search_tool" },
        });
        void pending.catch(() => {});
        yield* claudeResponse([fauxToolCall("tool_search", {}, { id: "search_tool" })], "tool_use");
        await pending.catch(() => {});
      } finally {
        await client.close();
      }
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const search = { name: "tool_search", description: "load", parameters: Type.Object({}) };
    const added = { name: "save_note", description: "save", parameters: Type.Object({}) };
    const options = { sessionId: "loading-conversation" };
    const prompt: Message = { role: "user", content: "load notes", timestamp: 1 };
    const first = await models.completeSimple(
      model,
      { tools: [search], messages: [prompt] },
      options,
    );
    expect(first.stopReason).toBe("toolUse");
    const result = await models.completeSimple(
      model,
      {
        tools: [search, added],
        messages: [
          prompt,
          first,
          {
            role: "toolResult",
            toolCallId: "search_tool",
            toolName: "tool_search",
            content: [{ type: "text", text: "Loaded notes" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      options,
    );
    expect(textOf(result)).toBe("used the new tool");
    expect(listed).toEqual([["tool_search"], ["tool_search", "save_note"]]);
    expect(JSON.stringify(script.requests[1]?.history)).toContain("Loaded notes");
  });

  it("rebuilds an idle conversation after Durable compaction and starts clean after reset", async () => {
    const value = await setup();
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({
        front: role,
        worker: role,
        classifier: null,
        claude: config,
        settings: { compaction: { keepRecentTokens: 1 } },
      }),
    );
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "answer" + script.requests.length }]);
    });
    await openClaudeModels(value.directory, script.provider, token);
    const backend = await Monchu.open(value.directory, script.provider);
    const view = await backend.viewState();
    try {
      for (const n of [1, 2]) {
        await backend.submit("turn" + n, "turn" + n, "followUp");
        await waitFor(() =>
          view.value.entries.some((entry) =>
            entry.model?.some(
              (message) => message.role === "assistant" && textOf(message) === "answer" + n,
            ),
          ),
        );
      }
      const original = script.requests[0]?.path;
      assert(original);
      expect(script.requests[1]?.path).toBe(original);
      await backend.compact(undefined);
      await waitFor(() => view.value.entries.some((entry) => CompactionEntry.is(entry)));
      expect(script.requests[2]?.input.options?.persistSession).toBe(false);
      await backend.submit("after compaction", "after-compaction", "followUp");
      await waitFor(() =>
        view.value.entries.some((entry) =>
          entry.model?.some(
            (message) => message.role === "assistant" && textOf(message) === "answer4",
          ),
        ),
      );
      expect(script.requests[3]?.path).toBe(original);
      expect(JSON.stringify(script.requests[3]?.history)).toContain("answer3");
      await backend.reset(undefined);
      await backend.submit("after reset", "after-reset", "followUp");
      await waitFor(() =>
        view.value.entries.some((entry) =>
          entry.model?.some(
            (message) => message.role === "assistant" && textOf(message) === "answer5",
          ),
        ),
      );
      expect(script.requests[4]?.input.options?.resume).toBeUndefined();
      expect(script.requests[4]?.path).not.toBe(original);
      expect(script.requests[4]?.history).toEqual([]);
    } finally {
      view.dispose();
      await backend.close();
    }
  });

  it("gives Claude Code workers the shared manual and their project files, and front-only files only to the front, through the system prompt", async () => {
    const value = await setup();
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({ front: role, worker: role, classifier: null, claude: config }),
    );
    await writeFile(join(value.directory, "AGENTS.md"), "SHARED MANUAL");
    await writeFile(join(value.directory, "FRONT.md"), "FRONT ONLY");
    const project = join(value.directory, "project");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "PROJECT RULES");
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "done" }]);
    });
    await openClaudeModels(value.directory, script.provider, token);
    const backend = await Monchu.open(value.directory, script.provider);
    const prompts = () =>
      script.requests.map(({ input }) => {
        const prompt = input.options?.systemPrompt;
        assert(typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset");
        return prompt.append ?? "";
      });
    try {
      await backend.submit("front", "front-request", "followUp");
      await waitFor(() => script.requests.length === 1);
      await backend.changeDirectory(project);
      await backend.startWorker("reader", "inspect", "worker-request");
      await waitFor(() => script.requests.length === 2);
      const [front, worker] = prompts();
      expect(front).toContain("SHARED MANUAL");
      expect(front).toContain("FRONT ONLY");
      expect(worker).toContain("SHARED MANUAL");
      expect(worker).not.toContain("FRONT ONLY");
      expect(front).not.toContain("PROJECT RULES");
      // Declared tools are prefixed; scripts and instructions name them without it.
      for (const prompt of [front, worker])
        expect(prompt).toContain("`mcp__monchu__close_worker` is `tools.close_worker`");
      expect(worker).toContain(
        `<project_instructions path="${join(project, "AGENTS.md")}">
PROJECT RULES
</project_instructions>`,
      );
    } finally {
      await backend.close();
    }
  });

  it.each(["front", "worker"])(
    "closes a parked %s query when its real Durable tool is cancelled",
    async (target) => {
      const value = await setup();
      await writeFile(
        join(value.directory, "config.json"),
        JSON.stringify({
          front: role,
          worker: role,
          classifier: null,
          claude: config,
        }),
      );
      const marker = join(value.directory, "tool-started");
      const command = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('tool-started', 'ready'); setTimeout(() => {}, 1500)"`;
      const script = scriptedClaude(value.directory, config, async function* (input) {
        const server = input.options?.mcpServers?.monchu;
        assert(server?.type === "sdk");
        const client = new Client({ name: "cancellation", version: "1" });
        const [left, right] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(right);
        await client.connect(left);
        try {
          const pending = client.callTool({
            name: "bash",
            arguments: {},
            _meta: { "claudecode/toolUseId": "blocked_tool" },
          });
          void pending.catch(() => {});
          yield* claudeResponse(
            [fauxToolCall("bash", { command }, { id: "blocked_tool" })],
            "tool_use",
          );
          await pending.catch(() => {});
        } finally {
          await client.close();
        }
      });
      await openClaudeModels(value.directory, script.provider, token);
      const backend = await Monchu.open(value.directory, script.provider);
      try {
        if (target === "front") await backend.submit("block", "block-front", "followUp");
        else await backend.startWorker("blocked", "block", "block-worker");
        await waitFor(async () => {
          try {
            return (await readFile(marker, "utf8")) === "ready";
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
        });
        expect(script.closed()).toBe(0);
        if (target === "front") await backend.abort();
        else await backend.stopWorker("blocked");
        expect(script.closed()).toBe(1);
        expect(script.interrupted()).toBe(1);
      } finally {
        await backend.close();
      }
    },
  );

  it("keeps concurrent Durable conversations and their parked results isolated", async () => {
    const value = await setup();
    await writeFile(join(value.directory, "front.txt"), "front result");
    await writeFile(join(value.directory, "worker.txt"), "worker result");
    const both = Promise.withResolvers<void>();
    let entered = 0;
    const delivered = new Map<string, Awaited<ReturnType<Client["callTool"]>>>();
    const script = scriptedClaude(value.directory, config, async function* (input) {
      const request = script.requests.find((request) => request.input === input);
      const content = request?.prompt[0]?.message.content;
      assert(Array.isArray(content));
      const label = content.find((block) => block.type === "text");
      assert(label?.type === "text");
      const name = label.text;
      const server = input.options?.mcpServers?.monchu;
      assert(server?.type === "sdk");
      const client = new Client({ name, version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(right);
      await client.connect(left);
      entered++;
      if (entered === 2) both.resolve();
      await both.promise;
      try {
        // Repeated native id across separate conversations must not cross-deliver.
        const result = client.callTool({
          name: "read",
          arguments: {},
          _meta: { "claudecode/toolUseId": "same_id" },
        });
        yield* claudeResponse(
          [fauxToolCall("read", { path: name + ".txt" }, { id: "same_id" })],
          "tool_use",
        );
        delivered.set(name, await result);
        yield* claudeResponse([{ type: "text", text: name + " done" }]);
      } finally {
        await client.close();
      }
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const { harness, root } = await open({ ...value, models });
    try {
      await root.configure({ model: role }, context);
      const worker = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: role, cwd: value.directory } },
        context,
      );
      await Promise.all([
        (async () => {
          await (await root.submit({ type: "input", content: "front" }, context)).wait(context);
        })(),
        (async () => {
          await (await worker.submit({ type: "input", content: "worker" }, context)).wait(context);
        })(),
      ]);
      expect(script.requests).toHaveLength(2);
      expect(script.requests[0]?.path).not.toBe(script.requests[1]?.path);
      expect(JSON.stringify(delivered.get("front"))).toContain("front result");
      expect(JSON.stringify(delivered.get("front"))).not.toContain("worker result");
      expect(JSON.stringify(delivered.get("worker"))).toContain("worker result");
      for (const [conversation, name] of [
        [root, "front"],
        [worker, "worker"],
      ] as const) {
        await (await conversation.submit({ type: "input", content: name }, context)).wait(context);
      }
      // The first two requests race, so pair each conversation's requests by their prompt, not their order.
      const paths = (name: string) =>
        script.requests
          .filter((request) => {
            const content = request.prompt[0]?.message.content;
            return (
              Array.isArray(content) &&
              content.some((block) => block.type === "text" && block.text === name)
            );
          })
          .map((request) => request.path);
      for (const name of ["front", "worker"]) {
        const [first, second] = paths(name);
        expect(first).toBeDefined();
        expect(second).toBe(first);
      }
    } finally {
      await harness.close(context);
    }
    expect(script.closed()).toBe(4);
  });

  it.each([
    "You are an expert coding assistant operating inside pi and its harness",
    "other instructions\nYou are an expert coding assistant operating inside pi",
    "docs/custom-provider.md together with docs/packages.md",
  ])("refuses dangerous system prompts before query entry (%#)", async (systemPrompt) => {
    const value = await setup();
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "must not run" }]);
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const result = await models.completeSimple(
      model,
      { systemPrompt, messages: [{ role: "user", content: "test", timestamp: 1 }] },
      { apiKey: token },
    );
    expect(result).toMatchObject({ stopReason: "error" });
    expect(result.errorMessage).toContain("Refusing Claude Code prompt");
    expect(script.requests).toHaveLength(0);
  });

  it("keeps user images and tool-result images, normalizes IDs once, and applies current transcript prompt/tool deltas", async () => {
    const value = await setup();
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse([{ type: "text", text: "ok" }]);
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const image = { type: "image" as const, mimeType: "image/png", data: "image-data" };
    const messages: Message[] = [
      {
        role: "system",
        content: "base docs/custom-provider.md",
        sections: { current: "old" },
        toolsAdded: [{ name: "snapshot", description: "image", parameters: Type.Object({}) }],
        timestamp: 1,
      },
      { role: "user", content: [{ type: "text", text: "image input" }, image], timestamp: 2 },
      {
        ...fauxAssistantMessage([fauxToolCall("snapshot", {}, { id: "id:with:colons" })], {
          stopReason: "toolUse",
        }),
        provider: "claude-code",
      },
      {
        role: "toolResult",
        toolCallId: "id:with:colons",
        toolName: "snapshot",
        content: [{ type: "text", text: "result" }, image],
        isError: false,
        timestamp: 4,
      },
      {
        role: "system",
        content: "later",
        sections: { current: "fresh" },
        toolsRemoved: [{ name: "snapshot" }],
        timestamp: 5,
      },
      { role: "user", content: [image], timestamp: 6 },
    ];
    const result = await models.completeSimple(model, { messages }, { apiKey: token });
    expect(result.stopReason).toBe("stop");
    const captured = script.requests[0];
    assert(captured);
    expect(captured.input.options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "base docs/custom-provider.md\n\nlater\n\nfresh",
    });
    expect(captured.input.options?.mcpServers).toBeUndefined();
    expect(captured.history[0]?.message.content).toEqual([
      { type: "text", text: "image input" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } },
    ]);
    expect(captured.history[1]?.message.content).toEqual([
      { type: "tool_use", id: "id_with_colons", name: "mcp__monchu__snapshot", input: {} },
    ]);
    expect(captured.history[2]?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "id_with_colons",
        content: [
          { type: "text", text: "result" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "image-data" },
          },
        ],
      },
    ]);
    expect(captured.prompt[0]?.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } },
    ]);
  });

  it("aborts a blocked query and closes it once", async () => {
    const value = await setup();
    const entered = Promise.withResolvers<void>();
    const script = scriptedClaude(value.directory, config, async function* (input) {
      const first = claudeResponse([{ type: "text", text: "unused" }])[0];
      assert(first);
      yield first;
      entered.resolve();
      const signal = input.options?.abortController?.signal;
      assert(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const abort = new AbortController();
    const result = models.completeSimple(
      model,
      { messages: [{ role: "user", content: "abort", timestamp: 1 }] },
      { apiKey: token, signal: abort.signal },
    );
    await entered.promise;
    abort.abort();
    expect((await result).stopReason).toBe("aborted");
    expect(script.closed()).toBe(1);
    expect(script.interrupted()).toBe(1);
  });

  it.each(["crash", "incomplete", "retry"])(
    "reports %s explicitly without an empty final answer",
    async (failure) => {
      const value = await setup();
      const script = scriptedClaude(
        value.directory,
        config,
        async function* (): AsyncGenerator<SDKMessage> {
          if (failure === "crash") throw new Error(`script crashed ${token}`);
          if (failure === "retry")
            yield {
              type: "system",
              subtype: "api_retry",
              attempt: 1,
              max_retries: 2,
              retry_delay_ms: 1000,
              error_status: 429,
              error: "rate_limit",
              uuid: "00000000-0000-0000-0000-000000000000",
              session_id: "retry",
            };
        },
      );
      const models = await openClaudeModels(value.directory, script.provider, token);
      const model = models.getModel("claude-code", role.modelId);
      assert(model);
      const result = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "test", timestamp: 1 }] },
        { apiKey: token },
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toContain(token);
      expect(result.errorMessage).toContain(process.execPath);
      expect(result.errorMessage).toMatch(/crashed|exited|ended without|internal API retry/);
      expect(script.closed()).toBe(1);
    },
  );

  it("names missing and failed executable paths without starting a model request", async () => {
    const value = await setup();
    const missing = join(value.directory, "missing-claude");
    const script = scriptedClaude(
      value.directory,
      { ...config, executable: missing },
      async function* () {
        yield* claudeResponse([{ type: "text", text: "must not run" }]);
      },
    );
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const result = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      { apiKey: token },
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(missing);
    expect(script.requests).toHaveLength(0);
    // A non-Claude program exercises the real SDK spawn/start failure without a network-capable Claude process.
    const provider = createClaudeCodeProvider(value.directory, config);
    const real = await openClaudeModels(value.directory, provider, token);
    const realModel = real.getModel("claude-code", role.modelId);
    assert(realModel);
    const failed = await real.completeSimple(
      realModel,
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      { apiKey: token },
    );
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toContain(process.execPath);
  });

  it("resolves a PATH wrapper and removes inherited credentials and billing switches in a separate process", async () => {
    const value = await setup();
    // Outside the home, whose claude/ directory holds Claude Code's config and workdir.
    const bin = join(value.directory, "bin");
    await mkdir(bin);
    const executable = join(bin, process.platform === "win32" ? "claude.EXE" : "claude");
    await writeFile(executable, "not executed by the injected query");
    await chmod(executable, 0o700);
    const module = new URL("../src/core/models/claude-code.ts", import.meta.url).href;
    const index = new URL("../src/core/models/index.ts", import.meta.url).href;
    const script = `
      import { createClaudeCodeProvider } from ${JSON.stringify(module)};
      import { openModels } from ${JSON.stringify(index)};
      const provider = createClaudeCodeProvider(process.argv[1], { executable: undefined, plan: "pro", longContextExtraUsage: false }, (input) => {
        process.stdout.write(JSON.stringify(input.options));
        return { async *[Symbol.asyncIterator]() {}, async interrupt() {}, close() {} };
      });
      const models = await openModels(process.argv[1], provider);
      await models.login("claude-code", "oauth", { prompt: async () => ${JSON.stringify(token)}, notify: () => {} });
      const model = models.getModel("claude-code", "claude-sonnet-4-6");
      await models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: ${JSON.stringify(token)} });
    `;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script, value.directory],
        {
          env: {
            ...process.env,
            PATH: bin,
            ANTHROPIC_API_KEY: "not-inherited",
            ANTHROPIC_AUTH_TOKEN: "not-inherited",
            ANTHROPIC_BASE_URL: "https://not-used.invalid",
            CLAUDE_CODE_USE_BEDROCK: "1",
            CLAUDE_CONFIG_DIR: "not-inherited",
            CLAUDE_CODE_OAUTH_TOKEN: "not-inherited",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    const options: unknown = JSON.parse(output);
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: executable,
      env: { CLAUDE_CONFIG_DIR: join(value.directory, "claude"), CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    expect(output).not.toContain("not-inherited");
    expect(output).not.toContain("ANTHROPIC_");
    expect(output).not.toContain("CLAUDE_CODE_USE_BEDROCK");
    expect((await readdir(value.directory)).filter((name) => name.startsWith("auth.json"))).toEqual(
      ["auth.json"],
    );
  });

  it("rejects Claude host setting changes on reload without applying a partial new snapshot", async () => {
    const value = await setup();
    const before = await loadConfig(value.directory);
    const extensions = await Extensions.load(value.models, before, value.directory, () => {});
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({ ...before, claude: { ...before.claude, plan: "max" }, chosen: undefined }),
    );
    await expect(extensions.reload()).rejects.toThrow("use /restart");
    expect(extensions.config).toEqual(before);
  });
});
