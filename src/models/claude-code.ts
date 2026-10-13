// Guard and long-context policy adapted from pi-claude-bridge 0.9.2.
// MIT License
// Copyright (c) 2026 Eli Dickinson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
  query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type SimpleStreamOptions,
  type JsonObject,
  type JsonValue,
  type ModelThinkingLevel,
  type Provider,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { deleteSession, type Session } from "cc-session-io";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ClaudeConfig } from "../config.ts";
import { rebuildClaudeSession } from "./claude-session.ts";

/** Injectable SDK boundary; scripts need only iteration, interrupt and close, not a fake extension host. */
export type ClaudeQuery = (
  input: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

const oneMillion = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
]);
const efforts: Partial<Record<ModelThinkingLevel, EffortLevel>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function toolArguments(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("Claude Code returned non-object tool arguments");
  return value;
}

/** Resolve to a real path on every platform, including Termux wrappers; never use SDK platform lookup. */
async function resolveExecutable(configured: string | undefined, home: string): Promise<string> {
  const name = configured ?? "claude";
  const paths =
    isAbsolute(name) || /[\\/]/.test(name)
      ? [resolve(home, name)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) => {
            const path = join(directory.replace(/^"|"$/g, ""), name);
            return process.platform === "win32" && !/\.[a-z0-9]+$/i.test(name)
              ? [
                  path,
                  ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
                    .split(";")
                    .filter(Boolean)
                    .map((extension) => path + extension),
                ]
              : [path];
          });
  for (const path of paths) {
    try {
      await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR")
        )
      )
        throw error;
    }
  }
  throw new Error(
    `Claude Code executable ${JSON.stringify(name)} not found or not executable; tried: ${paths.join(", ") || "PATH is empty"}. Set claude.executable in config.json.`,
  );
}

type ClaudeUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens: number } | null;
};

/** Subscription-token provider. One disposable process per Durable model request, never a parked agent loop. */
export function createClaudeCodeProvider(
  home: string,
  config: ClaudeConfig,
  queryImpl: ClaudeQuery = query,
): Provider {
  const models = anthropicProvider()
    .getModels()
    .filter((model) => /^claude-(opus|sonnet|haiku)-/.test(model.id))
    .map((model) => {
      const longContext =
        oneMillion.has(model.id) ||
        (model.id === "claude-opus-4-6" &&
          (config.plan === "max" || config.longContextExtraUsage)) ||
        (model.id === "claude-sonnet-4-6" && config.longContextExtraUsage);
      return {
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        maxTokens: model.maxTokens,
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.thinkingLevelMap }),
        provider: "claude-code",
        api: "claude-code",
        baseUrl: "",
        contextWindow: longContext ? 1000000 : 200000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });
  const streamClaude: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      provider: "claude-code",
      api: "claude-code",
      model: model.id,
      content: [],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const updateUsage = (usage: ClaudeUsage) => {
      output.usage.input = usage.input_tokens ?? output.usage.input;
      output.usage.output = usage.output_tokens ?? output.usage.output;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
      if (usage.output_tokens_details !== undefined && usage.output_tokens_details !== null)
        output.usage.reasoning = usage.output_tokens_details.thinking_tokens;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    };
    let executable = config.executable ?? "claude (PATH)";
    void (async () => {
      let sdkQuery: ReturnType<ClaudeQuery> | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let session: Session | undefined;
      let mcp: McpServer | undefined;
      const abort = new AbortController();
      const claudeDir = join(home, "claude");
      const cwd = join(claudeDir, "work");
      let complete = false;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        abort.abort();
        if (sdkQuery !== undefined) {
          void sdkQuery.interrupt().catch(() => {});
          sdkQuery.close();
        }
        // SDK close allows a grace period. Kill our child now so no next model/tool round can start.
        child?.kill("SIGKILL");
      };
      options?.signal?.addEventListener("abort", stop, { once: true });
      try {
        options?.signal?.throwIfAborted();
        if (!options?.apiKey?.startsWith("sk-ant-oat01-"))
          throw new Error(
            "Claude Code requires a stored setup-token; use /login and choose Claude Code",
          );
        const systemPrompt = getCurrentSystemPrompt(context.messages);
        if (
          /(^|\n)You are an expert coding assistant operating inside pi/.test(systemPrompt) ||
          (systemPrompt.includes("docs/custom-provider.md") &&
            systemPrompt.includes("docs/packages.md"))
        )
          throw new Error(
            "Refusing Claude Code prompt: Pi harness text or its documentation-path pair may trigger Extra Usage. Fix the source prompt before retrying.",
          );
        const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
        const declarations = tools.map((tool) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(tool.name))
            throw new Error(`Claude Code cannot declare tool ${tool.name}`);
          if (!("type" in tool.parameters) || tool.parameters.type !== "object")
            throw new Error(`Claude Code tool ${tool.name} needs an object parameters schema`);
          return ToolSchema.parse({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            _meta: { "anthropic/alwaysLoad": true },
          });
        });
        executable = await resolveExecutable(config.executable, home);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const rebuilt = rebuildClaudeSession(context.messages, cwd, claudeDir, model.id);
        session = rebuilt.session;
        if (session.messages.length) {
          session.save();
          await chmod(session.jsonlPath, 0o600);
        }
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_)/i.test(key)),
        );
        Object.assign(env, {
          CLAUDE_CONFIG_DIR: claudeDir,
          CLAUDE_CODE_OAUTH_TOKEN: options.apiKey,
          ENABLE_CLAUDEAI_MCP_SERVERS: "0",
          DISABLE_AUTO_COMPACT: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_FAST_MODE: "1",
          CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: "0",
          CLAUDE_CODE_MAX_RETRIES: "0",
          CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens ?? model.maxTokens),
        });
        if (options.timeoutMs !== undefined) env.API_TIMEOUT_MS = String(options.timeoutMs);
        if (tools.length) {
          mcp = new McpServer(
            { name: "monchu", version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: declarations }));
          // Schema-only MCP bridge: handlers never execute Monchu tools or return synthetic results.
          // They wait for the first message_stop to close the query; Durable owns real execution.
          mcp.server.setRequestHandler(CallToolRequestSchema, async () => {
            await new Promise<void>((resolve) => {
              if (abort.signal.aborted) resolve();
              else abort.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error(
              "Tool execution belongs to Durable; this Claude Code request is closed",
            );
          });
        }
        options.signal?.throwIfAborted();
        const mapped =
          options.reasoning === undefined ? undefined : model.thinkingLevelMap?.[options.reasoning];
        const effort =
          options.reasoning === undefined || !model.reasoning
            ? undefined
            : mapped === undefined
              ? efforts[options.reasoning]
              : mapped === "low" ||
                  mapped === "medium" ||
                  mapped === "high" ||
                  mapped === "xhigh" ||
                  mapped === "max"
                ? mapped
                : undefined;
        if (effort !== undefined) output.providerThinkingLevel = effort;
        if (options.reasoning !== undefined) output.thinkingLevel = options.reasoning;
        sdkQuery = queryImpl({
          prompt: (async function* () {
            yield rebuilt.prompt;
          })(),
          options: {
            pathToClaudeCodeExecutable: executable,
            cwd,
            env,
            abortController: abort,
            model: model.contextWindow > 200000 ? `${model.id}[1m]` : model.id,
            systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
            tools: [],
            skills: [],
            plugins: [],
            settingSources: [],
            strictMcpConfig: true,
            settings: {
              disableAllHooks: true,
              claudeMdExcludes: ["**"],
              includeGitInstructions: false,
              autoMemoryEnabled: false,
              fastMode: false,
            },
            includePartialMessages: true,
            // Claude Code selects the model's supported thinking mode (Haiku is not adaptive).
            ...(options.reasoning === undefined || !model.reasoning
              ? { thinking: { type: "disabled" as const } }
              : { extraArgs: { "thinking-display": "summarized" } }),
            ...(effort === undefined ? {} : { effort }),
            ...(mcp === undefined
              ? {}
              : { mcpServers: { monchu: { type: "sdk", name: "monchu", instance: mcp } } }),
            ...(session.messages.length ? { resume: session.sessionId } : {}),
            persistSession: false,
            maxTurns: 1,
            spawnClaudeCodeProcess: (input) => {
              child = spawn(input.command, input.args, {
                cwd: input.cwd,
                env: input.env,
                signal: input.signal,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              });
              // The custom-spawn seam bypasses the SDK's stderr reader. Drain without logging prompts or tokens.
              child.stderr.resume();
              return child;
            },
          },
        });
        const blocks = new Map<number, { contentIndex: number; json: string }>();
        let started = false;
        for await (const message of sdkQuery) {
          options.signal?.throwIfAborted();
          if (message.type === "system" && message.subtype === "api_retry")
            throw new Error("Claude Code attempted an internal API retry; request stopped");
          if (message.type === "system" && message.subtype === "compact_boundary")
            throw new Error("Claude Code attempted internal compaction; request stopped");
          if (message.type === "system" && message.subtype === "model_refusal_fallback")
            throw new Error("Claude Code attempted a fallback model; request stopped");
          if (message.type === "assistant" && message.error !== undefined)
            throw new Error(`Claude Code rejected the request: ${message.error}`);
          if (message.type === "result")
            throw new Error(
              message.subtype === "success"
                ? "Claude Code ended without a complete streamed message"
                : message.errors.join("; "),
            );
          if (message.type !== "stream_event") continue;
          if (message.parent_tool_use_id !== null)
            throw new Error("Claude Code started an unexpected subagent");
          const event: SDKPartialAssistantMessage["event"] = message.event;
          if (event.type === "message_start") {
            if (started) throw new Error("Claude Code restarted the response internally");
            started = true;
            output.responseId = event.message.id;
            output.responseModel = event.message.model;
            updateUsage(event.message.usage);
            stream.push({ type: "start", partial: output });
          } else if (!started) throw new Error("Claude Code streamed content before message_start");
          else if (event.type === "content_block_start") {
            const block = event.content_block;
            const contentIndex = output.content.length;
            if (block.type === "text") {
              output.content.push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex, partial: output });
              if (block.text) {
                output.content[contentIndex] = { type: "text", text: block.text };
                stream.push({
                  type: "text_delta",
                  contentIndex,
                  delta: block.text,
                  partial: output,
                });
              }
            } else if (block.type === "thinking") {
              output.content.push({
                type: "thinking",
                thinking: block.thinking,
                thinkingSignature: block.signature,
              });
              stream.push({ type: "thinking_start", contentIndex, partial: output });
            } else if (block.type === "tool_use") {
              const tool = tools.find((tool) => `mcp__monchu__${tool.name}` === block.name);
              if (tool === undefined)
                throw new Error(`Claude Code requested an undeclared tool ${block.name}`);
              output.content.push({
                type: "toolCall",
                id: block.id,
                name: tool.name,
                arguments: toolArguments(block.input),
              });
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
            } else throw new Error(`Claude Code returned unsupported content ${block.type}`);
            blocks.set(event.index, { contentIndex, json: "" });
          } else if (event.type === "content_block_delta" || event.type === "content_block_stop") {
            const state = blocks.get(event.index);
            const block = state === undefined ? undefined : output.content[state.contentIndex];
            if (state === undefined || block === undefined)
              throw new Error("Claude Code streamed an unknown content block");
            const contentIndex = state.contentIndex;
            if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta.type === "text_delta" && block.type === "text") {
                block.text += delta.text;
                stream.push({
                  type: "text_delta",
                  contentIndex,
                  delta: delta.text,
                  partial: output,
                });
              } else if (delta.type === "thinking_delta" && block.type === "thinking") {
                block.thinking += delta.thinking;
                stream.push({
                  type: "thinking_delta",
                  contentIndex,
                  delta: delta.thinking,
                  partial: output,
                });
              } else if (delta.type === "signature_delta" && block.type === "thinking")
                block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
              else if (delta.type === "input_json_delta" && block.type === "toolCall") {
                state.json += delta.partial_json;
                stream.push({
                  type: "toolcall_delta",
                  contentIndex,
                  delta: delta.partial_json,
                  partial: output,
                });
              } else throw new Error(`Claude Code returned mismatched delta ${delta.type}`);
            } else {
              if (block.type === "text")
                stream.push({
                  type: "text_end",
                  contentIndex,
                  content: block.text,
                  partial: output,
                });
              else if (block.type === "thinking")
                stream.push({
                  type: "thinking_end",
                  contentIndex,
                  content: block.thinking,
                  partial: output,
                });
              else {
                if (state.json) {
                  const input: unknown = JSON.parse(state.json);
                  block.arguments = toolArguments(input);
                }
                stream.push({
                  type: "toolcall_end",
                  contentIndex,
                  toolCall: block,
                  partial: output,
                });
              }
              blocks.delete(event.index);
            }
          } else if (event.type === "message_delta") {
            updateUsage(event.usage);
            if (event.delta.stop_reason !== null) output.rawStopReason = event.delta.stop_reason;
            output.stopReason =
              event.delta.stop_reason === "tool_use"
                ? "toolUse"
                : event.delta.stop_reason === "max_tokens"
                  ? "length"
                  : "stop";
          } else if (event.type === "message_stop") {
            if (blocks.size) throw new Error("Claude Code stopped with incomplete content blocks");
            if (
              output.content.some((block) => block.type === "toolCall") !==
              (output.stopReason === "toolUse")
            )
              throw new Error("Claude Code returned inconsistent tool-use stop reason");
            complete = true;
            stop();
            break;
          }
        }
        if (!complete) throw new Error("Claude Code exited before completing its response");
      } finally {
        options?.signal?.removeEventListener("abort", stop);
        stop();
        await mcp?.close();
        if (session !== undefined) deleteSession(session.sessionId, cwd, claudeDir);
      }
      stream.push({
        type: "done",
        reason:
          output.stopReason === "toolUse"
            ? "toolUse"
            : output.stopReason === "length"
              ? "length"
              : "stop",
        message: output,
      });
      stream.end();
    })().catch((error: unknown) => {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      const detail = error instanceof Error ? error.message : String(error);
      output.errorMessage = `Claude Code (${executable}): ${options?.apiKey ? detail.split(options.apiKey).join("[redacted]") : detail}`;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    });
    return stream;
  };
  return createProvider({
    id: "claude-code",
    name: "Claude Code subscription",
    models,
    auth: {
      oauth: {
        name: "Claude Code setup-token",
        isSubscription: true,
        login: async (interaction) => {
          const token = (
            await interaction.prompt({
              type: "secret",
              message: "Paste a Claude Code setup-token (not an API key)",
            })
          ).trim();
          interaction.signal.throwIfAborted();
          if (!token.startsWith("sk-ant-oat01-"))
            throw new Error("Expected a Claude Code setup-token, not an API key");
          return { type: "oauth", access: token, refresh: "", expires: Number.MAX_SAFE_INTEGER };
        },
        refresh: () => {
          throw new Error(
            "Claude Code setup-tokens cannot be refreshed; use /login and choose Claude Code",
          );
        },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: { stream: streamClaude, streamSimple: streamClaude },
  });
}
