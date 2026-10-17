// Adapted from pi-claude-bridge 0.9.2 (convert.ts).
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

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  getSystemMessageText,
  renderSystemMessageUpdate,
  type ImageContent,
  type Message,
  type TextContent,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  createSession,
  getSessionPath,
  normalizeProjectPath,
  openSession,
  type ContentBlock,
  type Session,
} from "cc-session-io";
import { readFileSync, writeFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function imageBlock(image: ImageContent): {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
} {
  const mediaType = image.mimeType;
  if (
    mediaType !== "image/png" &&
    mediaType !== "image/jpeg" &&
    mediaType !== "image/gif" &&
    mediaType !== "image/webp"
  )
    throw new Error(`Claude Code does not support image type ${mediaType}`);
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: mediaType, data: image.data },
  };
}

function userContent(content: UserMessage["content"]) {
  return typeof content === "string"
    ? content
    : content.map((block) =>
        block.type === "image" ? imageBlock(block) : { type: "text" as const, text: block.text },
      );
}

type ModelMessage = Exclude<Message, { role: "system" }>;

/**
 * Claude Code records a session's system prompt on its first request and replays that record on every resume, so a
 * prompt change never reaches the model through `append`, and a rebuilt session that renders a new one re-caches
 * everything. The transcript's first system message (Durable's baseline, rewritten only at compaction) is the system
 * prompt; each later one is folded into the stream as a reminder after the input that precedes the next reply, where
 * pi-ai's Anthropic transport places mid-conversation system messages.
 */
export function claudeTranscript(messages: Message[]): {
  systemPrompt: string;
  history: ModelMessage[];
} {
  const first = messages.find((message) => message.role === "system");
  const history: ModelMessage[] = [];
  let held: TextContent[] = [];
  const attach = (message: ModelMessage, blocks: TextContent[], before: boolean): ModelMessage => {
    if (message.role === "assistant")
      throw new Error("Claude Code cannot attach a reminder to a reply");
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    return { ...message, content: before ? [...blocks, ...content] : [...content, ...blocks] };
  };
  for (const message of messages) {
    if (message.role === "system") {
      const text = message === first ? "" : renderSystemMessageUpdate(message);
      if (!text) continue;
      const block = {
        type: "text" as const,
        text: `<system-reminder>\n${text}\n</system-reminder>`,
      };
      const last = history.at(-1);
      if (last === undefined || last.role === "assistant") held.push(block);
      else history[history.length - 1] = attach(last, [block], false);
    } else if (held.length && message.role !== "assistant") {
      history.push(attach(message, held, true));
      held = [];
    } else {
      if (held.length) history.push({ role: "user", content: held, timestamp: message.timestamp });
      held = [];
      history.push(message);
    }
  }
  if (held.length) history.push({ role: "user", content: held, timestamp: 0 });
  return { systemPrompt: first === undefined ? "" : getSystemMessageText(first), history };
}

/** The bridge's history/prompt split: all trailing user messages belong to this turn. */
export function claudeTurn(history: ModelMessage[]) {
  let start = history.length;
  while (start > 0 && history[start - 1]?.role === "user") start--;
  const content = history.slice(start).flatMap((message) => {
    if (message.role !== "user") return [];
    const converted = userContent(message.content);
    return typeof converted === "string" ? [{ type: "text" as const, text: converted }] : converted;
  });
  const prompt: SDKUserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: content.length
        ? content
        : "[Your context was compacted. What precedes this is a summary plus the most recent messages, ending with the tool result you were waiting for. Continue the task from there.]",
    },
  };
  return { history, prior: history.slice(0, start), prompt, hasUserPrompt: start < history.length };
}

/** Compare model history, not Durable timestamps or response bookkeeping, when detecting rewrites. */
export function claudeHistoryKeys(messages: Message[]): string[] {
  return messages.map((message) =>
    JSON.stringify({
      role: message.role,
      content: message.content,
      ...(message.role === "toolResult"
        ? { id: message.toolCallId, isError: message.isError }
        : {}),
    }),
  );
}

/** MCP only transports Durable's actual result, paired by the Claude tool-use id. */
export function claudeToolResult(
  message: Extract<Message, { role: "toolResult" }>,
): CallToolResult {
  return {
    content: message.content.map((block) =>
      block.type === "image"
        ? { type: "image", data: block.data, mimeType: block.mimeType }
        : { type: "text", text: block.text },
    ),
    isError: message.isError,
  };
}

/** Rebuild a Claude mirror from Durable's authoritative history, retaining its UUID unless rotated. */
export function rebuildClaudeSession(
  history: Message[],
  cwd: string,
  claudeDir: string,
  model: string,
  sessionId: string | undefined,
) {
  const session = createSession({
    projectPath: cwd,
    cwd,
    claudeDir,
    model,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  appendClaudeHistory(session, history);
  return session;
}

/**
 * Reopen a session Claude Code wrote itself, cut back to `bytes` (a clean turn end it recorded), and append the history
 * since. Claude Code's own records keep the request bytes it already sent, so its cached prefix survives a restart or an
 * abort; a rebuilt mirror would not render them identically. Undefined when the file no longer holds that point.
 */
export function restoreClaudeSession(
  missed: Message[],
  cwd: string,
  claudeDir: string,
  sessionId: string,
  bytes: number,
): Session | undefined {
  const path = getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir);
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (bytes <= 0 || content.length < bytes || content[bytes - 1] !== 0x0a) return undefined;
  if (content.length > bytes) writeFileSync(path, content.subarray(0, bytes));
  const session = openSession({ sessionId, projectPath: cwd, claudeDir });
  appendClaudeHistory(session, missed);
  return session;
}

function appendClaudeHistory(session: Session, history: Message[]): void {
  const pending = new Set<string>();
  const ids = new Map<string, string>();
  // Both directions use the same sanitized id; collisions are rejected, not silently merged.
  function toolId(id: string): string {
    const existing = ids.get(id);
    if (existing !== undefined) return existing;
    const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if ([...ids.values()].includes(clean))
      throw new Error("Claude Code history has colliding tool IDs");
    ids.set(id, clean);
    return clean;
  }
  for (const message of history) {
    if (message.role === "user") {
      if (pending.size)
        throw new Error("Claude Code history is missing tool results before a user message");
      session.addUserMessage(userContent(message.content));
    } else if (message.role === "assistant") {
      // An empty aborted attempt changes no model context and must not invent a response.
      if (!message.content.length) continue;
      if (pending.size)
        throw new Error("Claude Code history is missing tool results before an assistant message");
      const blocks: ContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        else if (block.type === "thinking") {
          if (message.provider === "claude-code" && block.thinkingSignature) {
            if (block.redacted)
              throw new Error("Claude Code session replay does not support redacted thinking");
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.thinkingSignature,
            });
          }
        } else {
          const id = toolId(block.id);
          if (pending.has(id)) throw new Error("Claude Code history has duplicate tool calls");
          pending.add(id);
          blocks.push({
            type: "tool_use",
            id,
            name: `mcp__monchu__${block.name}`,
            input: block.arguments,
          });
        }
      }
      if (blocks.length)
        session.addAssistantMessage(blocks, {
          model: message.model,
          stopReason: message.stopReason === "toolUse" ? "tool_use" : "end_turn",
        });
    } else if (message.role === "toolResult") {
      const id = toolId(message.toolCallId);
      if (!pending.delete(id)) throw new Error("Claude Code history has an unmatched tool result");
      session.addToolResults([
        { toolUseId: id, content: userContent(message.content), isError: message.isError },
      ]);
    }
  }
  if (pending.size) throw new Error("Claude Code history is missing tool results");
}
