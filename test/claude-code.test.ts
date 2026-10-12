import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fauxAssistantMessage, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ClaudeConfig } from "../src/config.ts";
import { createClaudeCodeProvider } from "../src/models/claude-code.ts";
import { openModels, resolveRoles } from "../src/models/index.ts";
import { Extensions } from "../src/reload.ts";
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
      expect(() =>
        resolveRoles(models, { ...current, front: selected, worker: selected }),
      ).not.toThrow();
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

  it("streams text, signed thinking, usage and length, stopping at the first message_stop", async () => {
    const value = await setup();
    let continued = false;
    const script = scriptedClaude(value.directory, config, async function* () {
      yield* claudeResponse(
        [
          { type: "thinking", thinking: "considering", thinkingSignature: "sig-preserved" },
          { type: "text", text: "hello" },
        ],
        "max_tokens",
      );
      continued = true;
      throw new Error("This is a hidden second model round");
    });
    const models = await openClaudeModels(value.directory, script.provider, token);
    const model = models.getModel("claude-code", role.modelId);
    assert(model);
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { reasoning: "high" },
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
    expect(continued).toBe(false);
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
      persistSession: false,
      maxTurns: 1,
      effort: "high",
      env: {
        CLAUDE_CONFIG_DIR: join(value.directory, "claude"),
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CODE_MAX_RETRIES: "0",
      },
    });
  });

  it("uses a new SDK query for every Durable tool round and rebuilds after reopening the SQLite harness", async () => {
    const value = await setup();
    await writeFile(join(value.directory, "known.txt"), "durable-owned file");
    let request = 0;
    let declarations: Awaited<ReturnType<Client["listTools"]>> | undefined;
    let mcpExecuted = false;
    const script = scriptedClaude(value.directory, config, async function* (input) {
      request++;
      if (request === 1) {
        const server = input.options?.mcpServers?.monchu;
        assert(server?.type === "sdk");
        const client = new Client({ name: "script", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        declarations = await client.listTools();
        const call = client.callTool({ name: "read", arguments: { path: "known.txt" } });
        void call.then(
          () => {
            mcpExecuted = true;
          },
          () => {},
        );
        try {
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
        } finally {
          await client.close();
          await call.catch(() => {});
        }
      } else
        yield* claudeResponse([
          { type: "text", text: request === 2 ? "used the durable results" : "after restart" },
        ]);
    });
    let models = await openClaudeModels(value.directory, script.provider, token);
    let { harness, root } = await open({ ...value, models });
    const rootId = root.id;
    try {
      await root.configure({ model: role, thinkingLevel: role.thinkingLevel }, context);
      await (
        await root.submit({ type: "input", content: "read both files" }, context)
      ).wait(context);
      expect(request).toBe(2);
      const results = await toolResults(root);
      expect(results).toHaveLength(2);
      expect(results.find((result) => result.toolCallId === "read_1")?.isError).toBe(false);
      expect(results.find((result) => result.toolCallId === "read_2")?.isError).toBe(true);
      expect(textOf(results.find((result) => result.toolCallId === "read_1"))).toContain(
        "durable-owned file",
      );
      expect(declarations?.tools.find((tool) => tool.name === "read")?.inputSchema).toEqual(
        (await root.agent(context)).tools.find((tool) => tool.name === "read")?.parameters,
      );
      expect(mcpExecuted).toBe(false);
      const replay = script.requests[1];
      assert(replay);
      expect(
        replay.history
          .filter((record) => record.type === "user")
          .flatMap((record) =>
            typeof record.message.content === "string" ? [] : record.message.content,
          ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool_result", tool_use_id: "read_1" }),
          expect.objectContaining({ type: "tool_result", tool_use_id: "read_2", is_error: true }),
        ]),
      );
      expect(
        replay.history
          .filter((record) => record.type === "assistant")
          .flatMap((record) => record.message.content),
      ).toEqual(
        expect.arrayContaining([
          { type: "thinking", thinking: "read files", signature: "signature-survives-restart" },
        ]),
      );
      for (const captured of script.requests)
        if (captured.path !== undefined)
          await expect(readFile(captured.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await harness.close(context);
    }
    // Fresh provider and credential store: there is no parked query or in-memory session to rely on.
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
      expect(restarted.requests[0]?.prompt[0]?.message.content).toBe("continue");
      expect(
        (await allEntries(root)).some((entry) =>
          entry.model?.some((message) => textOf(message) === "after restart"),
        ),
      ).toBe(true);
    } finally {
      await harness.close(context);
    }
    expect(script.closed()).toBe(2);
    expect(restarted.closed()).toBe(1);
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

  it("aborts a blocked query, closes it once, and preserves no disposable session", async () => {
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
      expect(result.errorMessage).toMatch(/crashed|exited|internal API retry/);
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
    const executable = join(
      value.directory,
      process.platform === "win32" ? "claude.EXE" : "claude",
    );
    await writeFile(executable, "not executed by the injected query");
    await chmod(executable, 0o700);
    const module = new URL("../src/models/claude-code.ts", import.meta.url).href;
    const index = new URL("../src/models/index.ts", import.meta.url).href;
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
            PATH: value.directory,
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
      JSON.stringify({ ...before, claude: { ...before.claude, plan: "max" } }),
    );
    await expect(extensions.reload()).rejects.toThrow("use /restart");
    expect(extensions.config).toEqual(before);
  });
});
