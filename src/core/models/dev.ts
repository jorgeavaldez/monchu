import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";

/** A reply with every kind of markdown the clients render, for checking how they draw it. */
const MARKDOWN = [
  "# Heading one",
  "",
  "Some **bold**, *italic*, ~~struck~~ and `inline code`, a [link](https://example.com/docs) and snake_case_name.",
  "A second line in the same paragraph.",
  "",
  "## A list",
  "",
  "- first item",
  "- second item with `code`",
  "  - nested item",
  "1. ordered one",
  "2. ordered two",
  "",
  "> a quoted line",
  "> and another",
  "",
  "```ts",
  'const wide = "a long line of code that runs well past the width of a phone screen and scrolls";',
  "function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "```",
  "",
  "| tool | state |",
  "| --- | :---: |",
  "| read | done |",
  "| bash | **running** |",
  "",
  "---",
  "",
  "[unsafe](javascript:alert(1)) <b>raw html</b> DONE",
].join("\n");

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
      // `tools <n>` makes n tool calls in one reply, for a long transcript in a few steps.
      if (/^tools \d+$/.test(text))
        return fauxAssistantMessage(
          Array.from({ length: Number(text.slice(6)) }, (_, at) =>
            fauxToolCall("read", { path: `missing-${at}.txt` }),
          ),
          { stopReason: "toolUse" },
        );
      if (text === "markdown") return fauxAssistantMessage(MARKDOWN);
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
      // `secret <NAME>` asks the user for a secret, as an agent that needs a token does.
      if (/^secret [A-Z][A-Z0-9_]*$/.test(text))
        return fauxAssistantMessage(
          [
            fauxToolCall("secret", {
              action: "request",
              name: text.slice(7),
              reason: "the smoke check needs a token",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text.startsWith("close "))
        return fauxAssistantMessage(
          [fauxToolCall("close_workers", { names: text.slice(6).split(" ") })],
          {
            stopReason: "toolUse",
          },
        );
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
