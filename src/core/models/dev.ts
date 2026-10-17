import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";

/** Offline provider for the real TUI smoke mode; all tool calls still execute through Durable. */
export function createDevProvider(): Provider {
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
      // `work <name> <task>` starts a worker through the front, as a real front delegates.
      if (/^work \S+ \S/.test(text)) {
        const [, name = "", task = ""] = /^work (\S+) ([\s\S]+)$/.exec(text) ?? [];
        return fauxAssistantMessage([fauxToolCall("start_worker", { name, task })], {
          stopReason: "toolUse",
        });
      }
      if (text.startsWith("close "))
        return fauxAssistantMessage([fauxToolCall("close_worker", { name: text.slice(6) })], {
          stopReason: "toolUse",
        });
      if (text === "goal waiting")
        return fauxAssistantMessage(
          [fauxToolCall("update_goal", { id: "smoke", status: "waiting" })],
          { stopReason: "toolUse" },
        );
      if (text === "goal")
        return fauxAssistantMessage(
          [
            fauxToolCall("update_goal", {
              id: "smoke",
              title: "Smoke goal",
              kind: "endeavor",
              workstream: "Checking the goals panel wraps a long workstream under its field",
              next: "first step\r\nsecond step\nthird step\nfourth step\nfifth step",
              workers: ["reader"],
              vault: "projects/smoke",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text.startsWith("[Worker")) return fauxAssistantMessage("Faux front: progress received.");
      if (text.startsWith("[Background worker"))
        return fauxAssistantMessage("Faux front: result received.");
      // A skill's instructions name a home path; the reply names the skill alone, so checks read the same anywhere.
      const skill = /^<skill name="([^"]*)"/.exec(text);
      if (skill !== null) return fauxAssistantMessage(`Faux reply: skill ${skill[1] ?? ""}. DONE`);
      return fauxAssistantMessage(`Faux reply: ${text}. Streaming stays above the editor. DONE`);
    }),
  );
  return faux.provider;
}
