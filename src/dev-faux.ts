import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Monchu } from "./backend.ts";

/** Explicit offline smoke mode. Its home and Pi resources stay in a throwaway temp directory. */
export async function openDevMonchu(home: string): Promise<Monchu> {
  await mkdir(join(home, "agent"), { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      front: { provider: "faux", modelId: "front", thinkingLevel: "off" },
      worker: { provider: "faux", modelId: "worker", thinkingLevel: "off" },
      classifier: null,
    }),
  );
  const faux = fauxProvider({
    models: [{ id: "front" }, { id: "worker" }],
    tokensPerSecond: 80,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => (request, _options, _state, model) => {
      const last = request.messages.findLast((message) => message.role !== "system");
      if (model.id === "worker") {
        if (last?.role === "toolResult") return fauxAssistantMessage("Faux worker result: done.");
        return fauxAssistantMessage(
          [fauxToolCall("post_update", { text: "Faux worker progress: checking." })],
          { stopReason: "toolUse" },
        );
      }
      if (last?.role === "toolResult") return fauxAssistantMessage("Faux tool finished.");
      const text =
        typeof last?.content === "string"
          ? last.content
          : (last?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ??
            "");
      if (text === "read")
        return fauxAssistantMessage([fauxToolCall("read", { path: "missing-file.txt" })], {
          stopReason: "toolUse",
        });
      if (text.startsWith("[Worker")) return fauxAssistantMessage("Faux front: progress received.");
      if (text.startsWith("[Background worker"))
        return fauxAssistantMessage("Faux front: result received.");
      return fauxAssistantMessage(`Faux reply: ${text}. Streaming stays above the editor. DONE`);
    }),
  );
  return Monchu.open(home, faux.provider);
}
