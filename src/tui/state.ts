import type { JsonValue } from "@earendil-works/chord";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, JsonObject } from "@earendil-works/pi-durable";

/** Narrow the JSON document boundary before reading presentation fields. */
function object(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object in the Durable view");
  return value;
}

/** A scalar field as text; anything else as its JSON, never "[object Object]". */
function scalar(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function text(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = object(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

/** A queued inbox item by submission ID: input with its busy mode and text, or a passive write with its entry kind. */
export type QueuedItem = { id: number; mode: "steer" | "followUp" | "write"; text: string };

/** Only fields the terminal displays; no casts from Durable's erased JSON documents. */
export function presentation(view: ConversationView) {
  const live = view.docs["pi.live"];
  const agent = view.docs["pi.agent"];
  const generation = object(live?.generation);
  const message = object(generation?.message);
  const retry = object(generation?.retry);
  const tools = Array.isArray(live?.tools) ? live.tools : [];
  const running = tools.map(object).filter((slot) => slot?.status === "running");
  const compaction = Array.isArray(live?.compactions) ? object(live.compactions[0]) : undefined;
  const compactionRetry = object(compaction?.retry);
  const blocks = Array.isArray(message?.content) ? message.content.map(object) : [];
  let status = "";
  if (retry)
    status = `Retrying (attempt ${Number(generation?.attempt ?? 0) + 1}): ${scalar(retry.error)}`;
  else if (generation?.deferred) status = "Waiting for provider…";
  else if (compaction)
    status = compactionRetry
      ? `Retrying compaction: ${scalar(compactionRetry.error)}`
      : "Compacting…";
  else if (running.length)
    status = `Running ${running.map((slot) => scalar(slot?.name)).join(", ")}…`;
  else if (blocks.at(-1)?.type === "thinking") status = "Thinking…";
  else if (live?.run) status = "Working…";
  const calls: { id: string; name: string; arguments: JsonObject }[] = [];
  for (const block of blocks) {
    if (block?.type !== "toolCall") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string")
      throw new Error("Invalid tool call in the Durable view");
    calls.push({ id: block.id, name: block.name, arguments: object(block.arguments) ?? {} });
  }
  const output: { id: string; name: string; text: string; details: JsonValue | undefined }[] = [];
  for (const slot of running) {
    if (typeof slot?.callId !== "string" || typeof slot.name !== "string")
      throw new Error("Invalid running tool in the Durable view");
    output.push({
      id: slot.callId,
      name: slot.name,
      text: typeof slot.output === "string" ? slot.output : "",
      details: slot.details,
    });
  }
  const inbox = view.docs["pi.inbox"];
  const queue = (Array.isArray(inbox?.items) ? inbox.items : []).map((value): QueuedItem => {
    const item = object(value);
    if (typeof item?.id !== "number") throw new Error("Invalid inbox item in the Durable view");
    if (item.mode === "write")
      return { id: item.id, mode: "write", text: scalar(object(item.entry)?.kind) };
    if (item.mode !== "steer" && item.mode !== "followUp")
      throw new Error("Invalid inbox item in the Durable view");
    return { id: item.id, mode: item.mode, text: text(item.content) };
  });
  const model = object(agent?.model);
  const thinkingLevel = agent?.thinkingLevel;
  return {
    status,
    busy: live?.run !== undefined,
    partial: message === undefined ? undefined : text(message.content),
    calls,
    output,
    queue,
    cwd: typeof agent?.cwd === "string" ? agent.cwd : undefined,
    model: typeof model?.modelId === "string" ? model.modelId : "no model",
    provider: typeof model?.provider === "string" ? model.provider : undefined,
    thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
  };
}

/** Token use of the active context, as Pi's footer shows it; `context` is undefined until a reply measures it. */
export type ContextUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: number | undefined;
};

/** Pi's request-size measure of a reply's usage. */
function requestTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Pi's chars/4 estimate of a message not yet measured by a reply. */
function estimate(message: Message): number {
  let chars = 0;
  if (message.role === "assistant")
    for (const part of message.content)
      chars +=
        part.type === "text"
          ? part.text.length
          : part.type === "thinking"
            ? part.thinking.length
            : part.name.length + JSON.stringify(part.arguments).length;
  else if (message.role === "user" || message.role === "toolResult")
    for (const part of typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content)
      chars += part.type === "text" ? part.text.length : 4800;
  return Math.ceil(chars / 4);
}

/** When the conversation last did something: its newest message, a reply counted from when it ended. */
export function lastActive(view: ConversationView): number | undefined {
  for (const entry of view.entries.toReversed())
    for (const message of (entry.model ?? []).toReversed()) {
      if (message.role === "system") continue;
      return message.timestamp + (message.role === "assistant" ? (message.durationMs ?? 0) : 0);
    }
  return undefined;
}

const usages = new WeakMap<readonly EntryRecord[], ContextUsage>();

/**
 * Token totals of the replies in the active context, and its size as Durable's compaction measures it: the newest
 * reply's usage plus estimates of the messages after it. Views share unchanged entry arrays, so each is read once.
 */
export function contextUsage(view: ConversationView): ContextUsage {
  const cached = usages.get(view.entries);
  if (cached !== undefined) return cached;
  const usage: ContextUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    context: undefined,
  };
  let trailing = 0;
  for (const entry of view.entries.toReversed())
    for (const message of (entry.model ?? []).toReversed()) {
      if (message.role === "assistant") {
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        if (usage.context === undefined && requestTokens(message.usage) > 0)
          usage.context = requestTokens(message.usage) + trailing;
      }
      if (usage.context === undefined) trailing += estimate(message);
    }
  usages.set(view.entries, usage);
  return usage;
}
