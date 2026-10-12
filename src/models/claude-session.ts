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
import type { ImageContent, Message, UserMessage } from "@earendil-works/pi-ai";
import { createSession, type ContentBlock } from "cc-session-io";

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

/** Fresh disposable mirror, never a second source of conversation state. No pairing repair or fabricated results. */
export function rebuildClaudeSession(
  messages: Message[],
  cwd: string,
  claudeDir: string,
  model: string,
) {
  const history = messages.filter((message) => message.role !== "system");
  const last = history.at(-1);
  const prompt: SDKUserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content:
        last?.role === "user"
          ? userContent(last.content)
          : "Continue from the tool results in the restored transcript.",
    },
  };
  if (last?.role === "user") history.pop();
  const session = createSession({ projectPath: cwd, cwd, claudeDir, model });
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
  return { session, prompt };
}
