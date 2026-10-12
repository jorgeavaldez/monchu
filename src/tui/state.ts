import type { JsonValue } from "@earendil-works/chord";
import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";

/** Narrow the JSON document boundary before reading presentation fields. */
function object(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object in the Durable view");
  return value;
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
  if (retry) status = `Retrying (attempt ${Number(generation?.attempt ?? 0) + 1}): ${retry.error}`;
  else if (generation?.deferred) status = "Waiting for provider…";
  else if (compaction)
    status = compactionRetry ? `Retrying compaction: ${compactionRetry.error}` : "Compacting…";
  else if (running.length) status = `Running ${running.map((slot) => slot?.name).join(", ")}…`;
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
  const queue = (Array.isArray(inbox?.items) ? inbox.items : []).map((value) => {
    const item = object(value);
    return item?.mode === "write"
      ? `[write] ${object(item.entry)?.kind}`
      : `[${item?.mode}] ${text(item?.content)}`;
  });
  const model = object(agent?.model);
  return {
    status,
    busy: live?.run !== undefined,
    partial: message === undefined ? undefined : text(message.content),
    calls,
    output,
    queue,
    cwd: typeof agent?.cwd === "string" ? agent.cwd : undefined,
    model: typeof model?.modelId === "string" ? model.modelId : "no model",
  };
}
