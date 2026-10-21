// Session/query behavior, guards and long-context policy adapted from pi-claude-bridge 0.9.2.
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

import type {
  query,
  SDKMessage,
  SDKPartialAssistantMessage,
  EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  createProvider,
  EventStream,
  registerSessionResourceCleanup,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type SimpleStreamOptions,
  type JsonObject,
  type JsonValue,
  type Message,
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
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { deleteSession, getSessionPath, normalizeProjectPath } from "cc-session-io";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ClaudeConfig } from "../config.ts";
import type { ClaudeTools } from "../tools/tool-search.ts";
import {
  claudeHistoryKeys,
  claudeToolResult,
  claudeTranscript,
  claudeTurn,
  rebuildClaudeSession,
  restoreClaudeSession,
} from "./claude-session.ts";

/** Injectable SDK boundary; scripts need only iteration, interrupt and close, not a fake extension host. */
export type ClaudeQuery = (
  input: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

/**
 * The SDK's `query`, loaded on the first request: it is the heaviest module Monchu imports, and startup should not
 * wait for a provider nothing has used yet.
 */
const lazyQuery: ClaudeQuery = (input) => {
  const started = import("@anthropic-ai/claude-agent-sdk").then((sdk) => sdk.query(input));
  return {
    async *[Symbol.asyncIterator]() {
      yield* await started;
    },
    interrupt: async () => (await started).interrupt(),
    close: () => void started.then((running) => running.close()).catch(() => {}),
  };
};

const oneMillion = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
]);
/**
 * Claude Code declares Monchu's tools under its MCP prefix, while scripts, tool results and instructions name them
 * without it.
 */
const TOOL_NAMES_NOTE =
  "Your tools are declared as `mcp__monchu__<name>`: call them by that full name. Everywhere else, including a codemode script's `tools.<name>(...)`, `searchTools()`, `describeTool()`, `tool_search` and these instructions, a tool goes by `<name>` without the prefix: `mcp__monchu__close_workers` is `tools.close_workers`.";

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

type QueryEvent = { message: SDKMessage } | { error: unknown };
type LiveQuery = {
  events: EventStream<QueryEvent, undefined>;
  finished: Promise<void>;
  stop: () => void;
  pendingCalls: Map<
    string,
    { resolve: (result: CallToolResult) => void; reject: (error: Error) => void }
  >;
  pendingResults: Map<string, CallToolResult>;
  toolIds: Set<string>;
  history: string[];
  /** The tool declarations its MCP server lists; a parked query cannot take new ones. */
  tools: string;
  parked: boolean;
  /** How far its session file has been read for Claude Code's own cache reports. */
  scanned: number;
  preserveSharedSession: boolean;
  pushPrompt: (prompt: ReturnType<typeof claudeTurn>["prompt"]) => Promise<void>;
};
/** The last clean turn end of a session Claude Code wrote: its history (hashed keys) and the file length then. */
type Checkpoint = { sessionId: string; hashes: string[]; bytes: number };
type SessionState = {
  sessionId: string;
  cursor: number;
  history: string[];
  /** Why the next request can't resume the session as it stands, if it can't. */
  rebuild: string | undefined;
  forceRotate: boolean;
  checkpoint?: Checkpoint;
};

const hashKey = (key: string) => createHash("sha256").update(key).digest("base64url");

function isCheckpoint(value: unknown): value is Checkpoint {
  return (
    isJsonObject(value) &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f-]+$/i.test(value.sessionId) &&
    typeof value.bytes === "number" &&
    Array.isArray(value.hashes) &&
    value.hashes.every((hash) => typeof hash === "string")
  );
}

/** Claude Code's built-in tool that loads deferred tools; the only built-in the bridge offers. */
const CLAUDE_TOOL_SEARCH = "ToolSearch";

/** Durable owns history and tool execution; Claude owns one persisted query for the whole turn. */
export function createClaudeCodeProvider(
  home: string,
  config: ClaudeConfig,
  queryImpl: ClaudeQuery = lazyQuery,
  /** The current build's deferred and hidden tools; read on each request, so a reload applies to the next one. */
  claudeTools: () => ClaudeTools | undefined = () => undefined,
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
        // The image limits `read` shrinks images to, as Anthropic's API takes them.
        ...(model.inputLimits === undefined ? {} : { inputLimits: model.inputLimits }),
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
  const sessions = new Map<string, SessionState>();
  const liveQueries = new Map<string, LiveQuery>();
  const sessionCleanups = new Map<string, () => void>();
  // Checkpoints outlive the process, so a restart resumes Claude Code's own session instead of a rebuilt mirror.
  const checkpoints = join(home, "claude", "checkpoints");
  const checkpointPath = (key: string) =>
    /^[A-Za-z0-9_-]+$/.test(key) ? join(checkpoints, `${key}.json`) : undefined;
  const loadCheckpoint = async (key: string): Promise<Checkpoint | undefined> => {
    const path = checkpointPath(key);
    if (path === undefined) return undefined;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    return isCheckpoint(value) ? value : undefined;
  };
  /**
   * Record a clean point: the session file cut at its last complete line, and the history it holds. At a parked tool
   * boundary the cut goes before the records of response `before`, once they hold the request's tool results `holds`;
   * results Claude Code hasn't written yet keep the earlier point. A silent end cuts after its response's last record,
   * excluding Claude Code's forced visible-output nudge and any reply to it.
   */
  const saveCheckpoint = async (
    key: string,
    state: SessionState,
    sessionId: string,
    keys: string[],
    cwd: string,
    claudeDir: string,
    cut?: { before: string | undefined; holds: string[] } | { after: string },
  ) => {
    // Only the tail is read: a session holding tool results and images runs to megabytes.
    const file = await open(getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir));
    let bytes: number;
    try {
      const { size } = await file.stat();
      const tail = Buffer.alloc(Math.min(size, 1 << 20));
      await file.read(tail, 0, tail.length, size - tail.length);
      if (cut !== undefined && "after" in cut) {
        const at = tail.lastIndexOf(`"id":"${cut.after}"`);
        const end = at < 0 ? -1 : tail.indexOf(0x0a, at);
        if (end < 0) return;
        bytes = size - tail.length + end + 1;
      } else {
        const at = cut?.before === undefined ? -1 : tail.indexOf(`"id":"${cut.before}"`);
        const held = at < 0 ? tail : tail.subarray(0, at);
        const end = held.lastIndexOf(0x0a);
        if (
          cut !== undefined &&
          (end < 0 || cut.holds.some((id) => !held.includes(`"tool_use_id":"${id}"`)))
        )
          return;
        bytes = end < 0 ? 0 : size - tail.length + end + 1;
      }
    } finally {
      await file.close();
    }
    const checkpoint = { sessionId, hashes: keys.map(hashKey), bytes };
    state.checkpoint = checkpoint;
    const path = checkpointPath(key);
    if (path === undefined) return;
    await mkdir(checkpoints, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(checkpoint), { mode: 0o600 });
  };
  // Whether Claude Code last reported the account drawing on overage (extra usage), for the replies' diagnostics.
  let overage = false;
  /**
   * Claude Code's own record that the server didn't recognize a request's prefix: a `thinking_drop` attachment, written
   * just before that request. Reads only the whole lines the query appended since its last scan.
   */
  const scanDrops = async (live: LiveQuery, sessionId: string, cwd: string, claudeDir: string) => {
    const found = { blocks: 0, reason: "" };
    const file = await open(getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir)).catch(
      () => undefined,
    );
    if (file === undefined) return found;
    try {
      const { size } = await file.stat();
      const from = Math.max(live.scanned > size ? 0 : live.scanned, size - (8 << 20));
      const chunk = Buffer.alloc(size - from);
      await file.read(chunk, 0, chunk.length, from);
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) return found;
      live.scanned = from + end + 1;
      for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes('"thinking_drop"')) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const dropped =
          isJsonObject(record) &&
          isJsonObject(record.attachment) &&
          record.attachment.type === "thinking_drop" &&
          isJsonObject(record.attachment.newlyDropped)
            ? record.attachment.newlyDropped
            : undefined;
        if (dropped === undefined) continue;
        if (typeof dropped.blockCount === "number") found.blocks += dropped.blockCount;
        if (typeof dropped.reason === "string") found.reason = dropped.reason;
      }
    } finally {
      await file.close();
    }
    return found;
  };
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
    // A retried response (see `rejected` below) spans several Claude messages. The first one's cache read says
    // whether the prompt cache held; a later one re-reads what the earlier just wrote, so only its new input counts.
    let earlier: AssistantMessage["usage"] | undefined;
    let current: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning?: number;
    } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const nextMessageUsage = () => {
      earlier = { ...output.usage };
      current = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    };
    const updateUsage = (usage: ClaudeUsage) => {
      current.input = usage.input_tokens ?? current.input;
      current.output = usage.output_tokens ?? current.output;
      current.cacheRead = usage.cache_read_input_tokens ?? current.cacheRead;
      current.cacheWrite = usage.cache_creation_input_tokens ?? current.cacheWrite;
      if (usage.output_tokens_details !== undefined && usage.output_tokens_details !== null)
        current.reasoning = usage.output_tokens_details.thinking_tokens;
      output.usage.input = (earlier?.input ?? 0) + current.input;
      output.usage.output = (earlier?.output ?? 0) + current.output;
      output.usage.cacheRead = earlier?.cacheRead ?? current.cacheRead;
      output.usage.cacheWrite = (earlier?.cacheWrite ?? 0) + current.cacheWrite;
      if (current.reasoning !== undefined)
        output.usage.reasoning = (earlier?.reasoning ?? 0) + current.reasoning;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    };
    let executable = config.executable ?? "claude (PATH)";
    void (async () => {
      // Durable's compaction uses the same conversation id but must not touch a parked chat query.
      const isolated = options?.cacheRetention === "none" || options?.sessionId === undefined;
      const key =
        !isolated && options?.sessionId !== undefined ? options.sessionId : crypto.randomUUID();
      const claudeDir = join(home, "claude");
      const cwd = join(claudeDir, "work");
      let live: LiveQuery | undefined;
      let preserveSharedSession = false;
      let complete = false;
      const onAbort = () => {
        const state = sessions.get(key);
        if (state !== undefined && !preserveSharedSession) {
          state.rebuild = "abort";
          state.forceRotate = true;
        }
        live?.stop();
      };
      try {
        options?.signal?.throwIfAborted();
        if (!options?.apiKey?.startsWith("sk-ant-oat01-"))
          throw new Error(
            "Claude Code requires a stored setup-token; use /login and choose Claude Code",
          );
        const transcript = claudeTranscript(context.messages);
        const { systemPrompt } = transcript;
        // The current prompt covers every section a reminder may carry.
        const sent = `${systemPrompt}\n${getCurrentSystemPrompt(context.messages)}`;
        if (
          /(^|\n)You are an expert coding assistant operating inside pi/.test(sent) ||
          (sent.includes("docs/custom-provider.md") && sent.includes("docs/packages.md"))
        )
          throw new Error(
            "Refusing Claude Code prompt: Pi harness text or its documentation-path pair may trigger Extra Usage. Fix the source prompt before retrying.",
          );
        const policy = claudeTools();
        const tools = (
          options.toolChoice === "none" ? [] : getCurrentTools(context.messages)
        ).filter((tool) => policy?.hidden.has(tool.name) !== true);
        // Claude Code's own tool search, offered only when it has deferred tools to load.
        const searching = tools.some((tool) => policy?.deferred.has(tool.name) === true);
        const declarations = tools.map((tool) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(tool.name))
            throw new Error(`Claude Code cannot declare tool ${tool.name}`);
          if (!("type" in tool.parameters) || tool.parameters.type !== "object")
            throw new Error(`Claude Code tool ${tool.name} needs an object parameters schema`);
          return ToolSchema.parse({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            // Claude Code's tool search loads a deferred tool without changing the declared list, so the prompt cache
            // holds; every other tool is declared up front.
            ...(policy?.deferred.has(tool.name) === true
              ? {}
              : { _meta: { "anthropic/alwaysLoad": true } }),
          });
        });
        executable = await resolveExecutable(config.executable, home);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
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
        // Pinned, never Claude Code's automatic choice: that is 1h within a subscription's limits and 5m once the account
        // draws on overage, and every new process starts at 1h until a response reports the limits. A 1h request reads
        // nothing 5m ones wrote, so on overage each new process re-wrote the whole conversation. Long retention keeps
        // 1h on overage too, by the user's choice.
        const ttl = options.cacheRetention === "long" ? "1h" : "5m";
        if (options.reasoning !== undefined) output.thinkingLevel = options.reasoning;
        const turn = claudeTurn(transcript.history);
        const keys = claudeHistoryKeys(turn.history);
        if (!isolated && !sessions.has(key)) {
          // After a restart: cut the session back to its checkpoint before resuming, since a turn may have stopped midway.
          const checkpoint = await loadCheckpoint(key);
          if (checkpoint !== undefined)
            sessions.set(key, {
              sessionId: checkpoint.sessionId,
              cursor: checkpoint.hashes.length,
              history: [],
              rebuild: "restart",
              forceRotate: false,
              checkpoint,
            });
        }
        if (!isolated && !sessionCleanups.has(key)) {
          const unregister = registerSessionResourceCleanup((sessionId) => {
            if (sessionId !== undefined && sessionId !== key) return;
            const state = sessions.get(key);
            if (state !== undefined) {
              state.rebuild = "cleanup";
              state.forceRotate ||= liveQueries.has(key);
            }
            liveQueries.get(key)?.stop();
            unregister();
            sessionCleanups.delete(key);
          });
          sessionCleanups.set(key, unregister);
        }
        const existing = liveQueries.get(key);
        if (existing !== undefined && !existing.parked)
          throw new Error("Claude Code already has a request running for this conversation");
        const results: Extract<Message, { role: "toolResult" }>[] = [];
        for (let i = turn.history.length - 1; i >= 0; i--) {
          const message = turn.history[i];
          if (message?.role === "assistant") break;
          if (message?.role === "toolResult") results.unshift(message);
        }
        // Durable has no Pi UI rewrite hook. Compare the parked query's actual prefix instead.
        const rewritten =
          existing !== undefined && existing.history.some((value, index) => keys[index] !== value);
        // Tools loaded mid-run (tool_search) reach Claude Code only through a new query.
        const toolsChanged =
          existing !== undefined && existing.tools !== JSON.stringify(declarations);
        if (existing !== undefined && (rewritten || toolsChanged || !results.length)) {
          const state = sessions.get(key);
          if (state !== undefined) {
            state.rebuild = rewritten ? "rewritten" : toolsChanged ? "tools" : "unanswered";
            state.forceRotate = true;
          }
          existing.stop();
        } else if (existing !== undefined) {
          live = existing;
          preserveSharedSession = live.preserveSharedSession;
          live.parked = false;
          options.signal?.addEventListener("abort", onAbort, { once: true });
          if (
            results.length !== live.toolIds.size ||
            results.some((result) => !live?.toolIds.has(result.toolCallId))
          )
            throw new Error("Claude Code tool results do not match the parked turn");
          // Like the bridge, write a steer before releasing any MCP result on the same stdin FIFO.
          if (turn.hasUserPrompt) await live.pushPrompt(turn.prompt);
          for (const result of results) {
            const converted = claudeToolResult(result);
            const pending = live.pendingCalls.get(result.toolCallId);
            if (pending !== undefined) {
              live.pendingCalls.delete(result.toolCallId);
              pending.resolve(converted);
            } else live.pendingResults.set(result.toolCallId, converted);
          }
          live.toolIds.clear();
        }
        let resume: string | undefined;
        // How this request reaches Claude Code's session, for the reply's prompt-cache diagnostic.
        let cachePath = live === undefined ? "new" : "continue";
        let cacheReason: string | undefined;
        if (live === undefined) {
          const state = sessions.get(key);
          const priorKeys = claudeHistoryKeys(turn.prior);
          if (
            state !== undefined &&
            priorKeys.length >= state.cursor &&
            state.history
              .slice(0, priorKeys.length)
              .some((value, index) => priorKeys[index] !== value)
          )
            state.rebuild ??= "history";
          // Without a live query, a tool-result continuation must import the actual results before resuming.
          if (state !== undefined && turn.history.at(-1)?.role === "toolResult")
            state.rebuild ??= "tool results";
          if (
            state !== undefined &&
            state.rebuild === undefined &&
            turn.prior.length >= state.cursor
          ) {
            const missed = turn.prior.slice(state.cursor);
            if (missed.length === 0 || (missed.length === 1 && missed[0]?.role === "assistant")) {
              resume = state.sessionId;
              state.cursor = turn.prior.length;
              cachePath = "resume";
            }
          }
          if (resume === undefined) {
            if (
              state !== undefined &&
              state.rebuild === undefined &&
              turn.prior.length < state.cursor
            ) {
              // The bridge's shorter-context clean start must not overwrite the shared mirror.
              preserveSharedSession = true;
              cachePath = "ephemeral";
            } else if (turn.prior.length) {
              cacheReason = state?.rebuild ?? "no session";
              // Prefer Claude Code's own session up to its last clean turn: its records keep the cached request bytes.
              const checkpoint = state?.checkpoint;
              const restored =
                checkpoint !== undefined &&
                checkpoint.hashes.length <= priorKeys.length &&
                checkpoint.hashes.every((hash, index) => hash === hashKey(priorKeys[index] ?? ""))
                  ? restoreClaudeSession(
                      turn.prior.slice(checkpoint.hashes.length),
                      cwd,
                      claudeDir,
                      checkpoint.sessionId,
                      checkpoint.bytes,
                    )
                  : undefined;
              let session = restored;
              if (session === undefined) {
                const previousId = state?.forceRotate ? undefined : state?.sessionId;
                if (previousId !== undefined) deleteSession(previousId, cwd, claudeDir);
                session = rebuildClaudeSession(turn.prior, cwd, claudeDir, model.id, previousId);
              }
              cachePath = restored === undefined ? "rebuild" : "restore";
              session.save();
              await chmod(session.jsonlPath, 0o600);
              resume = session.sessionId;
              if (!isolated) {
                const next = {
                  sessionId: resume,
                  cursor: turn.prior.length,
                  history: priorKeys,
                  rebuild: undefined,
                  forceRotate: false,
                };
                sessions.set(key, next);
                await saveCheckpoint(key, next, resume, priorKeys, cwd, claudeDir);
              }
            }
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
            // A failed stream would otherwise be re-sent without streaming: no stream events, only heartbeat pings.
            CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens ?? model.maxTokens),
          });
          if (options.timeoutMs !== undefined) env.API_TIMEOUT_MS = String(options.timeoutMs);
          let mcp: McpServer | undefined;
          const pendingCalls: LiveQuery["pendingCalls"] = new Map();
          const pendingResults: LiveQuery["pendingResults"] = new Map();
          const abort = new AbortController();
          const promptEnd = Promise.withResolvers<void>();
          let promptWake = Promise.withResolvers<void>();
          const prompts = [{ prompt: turn.prompt, ack: Promise.withResolvers<void>() }];
          // Only steers await an acknowledgement. The SDK pulls again after writing the previous item.
          void prompts[0]?.ack.promise.catch(() => {});
          if (tools.length) {
            mcp = new McpServer(
              { name: "monchu", version: "1.0.0" },
              { capabilities: { tools: {} } },
            );
            mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: declarations }));
            mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
              if (!tools.some((tool) => tool.name === request.params.name))
                throw new Error(`Unknown Claude Code tool ${request.params.name}`);
              const id = request.params._meta?.["claudecode/toolUseId"];
              if (typeof id !== "string")
                throw new Error('Claude Code tools/call is missing _meta["claudecode/toolUseId"]');
              if (abort.signal.aborted) throw new Error("Claude Code query stopped");
              const result = pendingResults.get(id);
              if (result !== undefined) {
                pendingResults.delete(id);
                return result;
              }
              if (pendingCalls.has(id))
                throw new Error("Claude Code repeated a pending tool-use ID");
              return new Promise<CallToolResult>((resolve, reject) => {
                pendingCalls.set(id, { resolve, reject });
              });
            });
          }
          if (isolated) cachePath = "isolated";
          // Claude Code's own reports about this query's requests are what it appends from here on.
          const scanned =
            resume === undefined
              ? 0
              : await stat(getSessionPath(resume, normalizeProjectPath(cwd), claudeDir)).then(
                  (info) => info.size,
                  () => 0,
                );
          options.signal?.throwIfAborted();
          let inputEnded = false;
          let inFlight: PromiseWithResolvers<void> | undefined;
          let child: ChildProcessWithoutNullStreams | undefined;
          const sdkQuery = queryImpl({
            prompt: (async function* () {
              while (!inputEnded) {
                const item = prompts.shift();
                if (item !== undefined) {
                  inFlight = item.ack;
                  yield item.prompt;
                  item.ack.resolve();
                  inFlight = undefined;
                } else {
                  await Promise.race([promptWake.promise, promptEnd.promise]);
                  promptWake = Promise.withResolvers<void>();
                }
              }
            })(),
            options: {
              pathToClaudeCodeExecutable: executable,
              cwd,
              env,
              abortController: abort,
              model: model.contextWindow > 200000 ? `${model.id}[1m]` : model.id,
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: tools.length ? `${systemPrompt}\n\n${TOOL_NAMES_NOTE}` : systemPrompt,
              },
              tools: searching ? [CLAUDE_TOOL_SEARCH] : [],
              skills: [],
              plugins: [],
              settingSources: [],
              strictMcpConfig: true,
              // As in Pi's Claude bridge. Omitted, Claude Code starts in `auto`, whose classifier would gate Monchu's tools.
              permissionMode: "bypassPermissions",
              settings: {
                disableAllHooks: true,
                claudeMdExcludes: ["**"],
                includeGitInstructions: false,
                autoMemoryEnabled: false,
                fastMode: false,
                promptCacheTtl: ttl,
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
              ...(resume === undefined ? {} : { resume }),
              persistSession: !isolated,
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
          const events = new EventStream<QueryEvent, undefined>(
            (event) => "error" in event || event.message.type === "result",
            () => undefined,
          );
          let stopped = false;
          const finished = Promise.withResolvers<void>();
          const unregister = isolated
            ? registerSessionResourceCleanup((sessionId) => {
                if (sessionId === undefined) current.stop();
              })
            : undefined;
          const endInput = () => {
            inputEnded = true;
            promptEnd.resolve();
          };
          const current: LiveQuery = {
            events,
            pendingCalls,
            pendingResults,
            toolIds: new Set(),
            history: keys,
            tools: JSON.stringify(declarations),
            parked: false,
            scanned,
            preserveSharedSession,
            finished: finished.promise,
            pushPrompt: async (prompt) => {
              if (inputEnded) throw new Error("Claude Code prompt stream ended before the steer");
              const ack = Promise.withResolvers<void>();
              prompts.push({ prompt, ack });
              promptWake.resolve();
              await ack.promise;
            },
            stop: () => {
              if (stopped) return;
              stopped = true;
              unregister?.();
              endInput();
              abort.abort();
              inFlight?.reject(new Error("Claude Code query stopped"));
              for (const item of prompts) item.ack.reject(new Error("Claude Code query stopped"));
              for (const pending of pendingCalls.values())
                pending.reject(new Error("Claude Code query stopped"));
              pendingCalls.clear();
              pendingResults.clear();
              events.push({ error: new Error("Claude Code query stopped") });
              events.end();
              void sdkQuery.interrupt().catch(() => {});
              sdkQuery.close();
              child?.kill("SIGKILL");
              void mcp?.close();
              if (liveQueries.get(key) === current) liveQueries.delete(key);
            },
          };
          void (async () => {
            try {
              for await (const message of sdkQuery) {
                if (stopped) break;
                if (
                  message.type === "system" &&
                  message.subtype === "init" &&
                  !preserveSharedSession &&
                  !isolated
                ) {
                  const checkpoint = sessions.get(key)?.checkpoint;
                  sessions.set(key, {
                    sessionId: message.session_id,
                    cursor: turn.history.length,
                    history: keys,
                    rebuild: undefined,
                    forceRotate: false,
                    ...(checkpoint === undefined ? {} : { checkpoint }),
                  });
                }
                if (message.type === "system" && message.subtype === "api_retry")
                  throw new Error("Claude Code attempted an internal API retry; request stopped");
                if (message.type === "system" && message.subtype === "compact_boundary")
                  throw new Error("Claude Code attempted internal compaction; request stopped");
                if (message.type === "system" && message.subtype === "model_refusal_fallback")
                  throw new Error("Claude Code attempted a fallback model; request stopped");
                if (message.type === "assistant" && message.error !== undefined) {
                  // The text names the cause ("API Error: Connection to the API was lost"), which Durable's retry reads.
                  const text = message.message.content
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join(" ");
                  throw new Error(
                    `Claude Code rejected the request: ${message.error}${text ? `: ${text}` : ""}`,
                  );
                }
                if (message.type === "result") endInput();
                events.push({ message });
              }
            } catch (error) {
              if (stopped) return;
              events.push({ error });
              const state = sessions.get(key);
              if (state !== undefined && !preserveSharedSession) {
                state.rebuild = "error";
                state.forceRotate = true;
              }
              current.stop();
            } finally {
              endInput();
              events.end();
              finished.resolve();
            }
          })();
          live = current;
          liveQueries.set(key, current);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }
        live.history = keys;
        const state = sessions.get(key);
        if (state !== undefined && !preserveSharedSession) {
          state.cursor = turn.history.length;
          state.history = keys;
        }
        const blocks = new Map<number, { contentIndex: number; json: string }>();
        // A call to a name Claude Code doesn't declare (a bare `codemode`) gets Claude Code's own "No such tool"
        // error, and the model answers again in a new message; this response continues there. Durable's copy holds
        // neither the call nor that message's thinking: rebuilt, thinking after text is a shape Claude never sends.
        const skipped = new Set<number>();
        let rejected: string | undefined;
        // Claude Code runs its own tool search and the model answers in a new message, like a rejected call; Durable's
        // copy holds neither, and a resumed session calls the loaded tool without it.
        let searched = false;
        let searches = 0;
        let retries = 0;
        let retrying = false;
        let started = false;
        let sawResult = false;
        let silent = false;
        for await (const item of live.events) {
          options.signal?.throwIfAborted();
          if ("error" in item) throw item.error;
          const message = item.message;
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(message.errors.join("; "));
            if (message.is_error)
              throw new Error(message.result || "Claude Code reported an error");
            if (!complete || output.stopReason === "toolUse")
              throw new Error("Claude Code ended without a complete streamed message");
            await live.finished;
            sawResult = true;
            if (preserveSharedSession || isolated)
              deleteSession(message.session_id, cwd, claudeDir);
            else {
              const state = sessions.get(key);
              if (state !== undefined)
                await saveCheckpoint(
                  key,
                  state,
                  message.session_id,
                  [...keys, ...claudeHistoryKeys([output])],
                  cwd,
                  claudeDir,
                );
            }
            break;
          }
          if (message.type === "rate_limit_event")
            overage = message.rate_limit_info.isUsingOverage === true;
          if (message.type !== "stream_event") continue;
          if (message.parent_tool_use_id !== null)
            throw new Error("Claude Code started an unexpected subagent");
          const event: SDKPartialAssistantMessage["event"] = message.event;
          if (event.type === "message_start") {
            if (started && !retrying) {
              if (
                complete &&
                (output.rawStopReason === "end_turn" || output.rawStopReason === "stop_sequence") &&
                !output.content.some(
                  (block) =>
                    block.type === "toolCall" || (block.type === "text" && block.text.trim()),
                )
              ) {
                // Claude Code nudges a thinking-only/blank end into a second response. Silence is a valid reply:
                // stop that query, then keep only the first response in its checkpoint for the next turn.
                live.stop();
                await live.finished;
                if (preserveSharedSession || isolated)
                  deleteSession(message.session_id, cwd, claudeDir);
                else {
                  const state = sessions.get(key);
                  if (state !== undefined) {
                    if (output.responseId !== undefined)
                      await saveCheckpoint(
                        key,
                        state,
                        message.session_id,
                        [...keys, ...claudeHistoryKeys([output])],
                        cwd,
                        claudeDir,
                        { after: output.responseId },
                      );
                    state.rebuild = "silent";
                  }
                }
                silent = true;
                break;
              }
              throw new Error("Claude Code restarted the response internally");
            }
            if (retrying) nextMessageUsage();
            output.responseId = event.message.id;
            output.responseModel = event.message.model;
            updateUsage(event.message.usage);
            if (!started) stream.push({ type: "start", partial: output });
            started = true;
            retrying = false;
            skipped.clear();
            rejected = undefined;
            searched = false;
          } else if (!started) throw new Error("Claude Code streamed content before message_start");
          else if (event.type === "content_block_start") {
            const block = event.content_block;
            const contentIndex = output.content.length;
            if (block.type === "thinking" && (retries > 0 || searches > 0)) {
              skipped.add(event.index);
              continue;
            }
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
            } else if (
              block.type === "tool_use" &&
              searching &&
              block.name === CLAUDE_TOOL_SEARCH
            ) {
              skipped.add(event.index);
              searched = true;
              continue;
            } else if (block.type === "tool_use") {
              const tool = tools.find((tool) => `mcp__monchu__${tool.name}` === block.name);
              if (tool === undefined) {
                skipped.add(event.index);
                rejected = block.name;
                continue;
              }
              live.toolIds.add(block.id);
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
            if (skipped.has(event.index)) continue;
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
            // Worded as a premature stream end, which Durable's retry policy retries.
            if (blocks.size)
              throw new Error("Claude Code stream ended without completing its content blocks");
            if (
              (rejected !== undefined || searched) &&
              !output.content.some((block) => block.type === "toolCall")
            ) {
              if (rejected !== undefined && ++retries > 2)
                throw new Error(`Claude Code requested an undeclared tool ${rejected}`);
              if (searched && ++searches > 5)
                throw new Error("Claude Code searched for tools without calling one");
              retrying = true;
              continue;
            }
            if (
              output.content.some((block) => block.type === "toolCall") !==
              (output.stopReason === "toolUse")
            )
              throw new Error("Claude Code returned inconsistent tool-use stop reason");
            complete = true;
            if (output.stopReason === "toolUse") {
              live.parked = true;
              live.history = [...keys, ...claudeHistoryKeys([output])];
              // A restart before the turn ends restores Claude Code's own records up to this request: a turn rendered
              // again from Durable's copy lacks what Claude Code sent with it, and the request misses the cache.
              const state = sessions.get(key);
              if (state !== undefined && results.length && !preserveSharedSession && !isolated)
                await saveCheckpoint(key, state, state.sessionId, keys, cwd, claudeDir, {
                  before: output.responseId,
                  holds: results.map((result) => result.toolCallId),
                });
              break;
            }
          }
        }
        if (!complete || (!live.parked && !sawResult && !silent))
          throw new Error("Claude Code exited before completing its response");
        const updated = sessions.get(key);
        if (updated !== undefined && !preserveSharedSession) {
          updated.cursor = turn.history.length;
          updated.history = [...keys, ...claudeHistoryKeys([output])];
        }
        const dropped =
          updated === undefined || preserveSharedSession || isolated
            ? undefined
            : await scanDrops(live, updated.sessionId, cwd, claudeDir);
        output.diagnostics = [
          ...(output.diagnostics ?? []),
          {
            type: "prompt_cache",
            timestamp: Date.now(),
            details: {
              path: cachePath,
              ttl,
              ...(cacheReason === undefined ? {} : { reason: cacheReason }),
              ...(overage ? { overage: true } : {}),
              ...(dropped === undefined || dropped.blocks === 0
                ? {}
                : { thinkingDropped: dropped.blocks, dropReason: dropped.reason }),
            },
          },
        ];
      } catch (error) {
        if (live !== undefined) {
          const state = sessions.get(key);
          if (state !== undefined && !preserveSharedSession) {
            state.rebuild = "error";
            state.forceRotate = true;
          }
          live.stop();
        }
        throw error;
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
        // Durable aborts its generation signal when that invocation ends normally, too.
        // A tool boundary detaches it; the next request installs its own signal.
        if (live !== undefined && (!live.parked || isolated)) live.stop();
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
              message:
                "Run `claude setup-token` in another terminal (Anthropic's own sign-in), then paste the token it prints here",
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
