import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import {
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type ClassifierChoiceAnswer,
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

function isObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Offline provider for the real TUI smoke mode; all tool calls still execute through Durable. */
export function createDevProvider(): Provider {
  const faux = fauxProvider({
    models: [{ id: "front" }, { id: "worker" }],
    tokensPerSecond: 80,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses(
    Array.from({ length: 10_000 }, () => (request, _options, _state, model) => {
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
      // A compaction asks for a summary of the whole conversation: echoed, a long one would stream for minutes.
      if (text.startsWith("<conversation>")) return fauxAssistantMessage("Faux summary. DONE");
      if (text === "markdown") return fauxAssistantMessage(MARKDOWN);
      // `prompt` says what this request gave the model: its tools and prompt sections; `section <name>` one's text.
      const sections = request.messages.flatMap((message) =>
        message.role === "system" ? Object.entries(message.sections ?? {}) : [],
      );
      if (text === "prompt")
        return fauxAssistantMessage(
          `Faux prompt · tools: ${getCurrentTools(request.messages)
            .map((tool) => tool.name)
            .join(" ")}\nsections: ${[...new Set(sections.map(([key]) => key))].join(" ")}`,
        );
      if (text.startsWith("section ")) {
        const name = text.slice(8);
        // Later system messages replace a section by name.
        const value = sections.findLast(([key]) => key === name)?.[1];
        return fauxAssistantMessage(`Faux section ${name}: ${value ?? "none"}`);
      }
      // `call <tool> <json args>` makes that one call, so a check can drive any tool through the real front.
      const call = /^call (\S+)(?: ([\s\S]+))?$/.exec(text);
      if (call !== null) {
        let args: unknown;
        try {
          args = JSON.parse(call[2] ?? "{}");
        } catch {
          args = undefined;
        }
        if (!isObject(args)) return fauxAssistantMessage("Faux front: call takes a JSON object.");
        return fauxAssistantMessage([fauxToolCall(call[1] ?? "", args)], { stopReason: "toolUse" });
      }
      if (text === "read")
        return fauxAssistantMessage([fauxToolCall("read", { path: "missing-file.txt" })], {
          stopReason: "toolUse",
        });
      // `read <path>` reads that file, so an image shows as a tool's result.
      if (/^read \S+$/.test(text))
        return fauxAssistantMessage([fauxToolCall("read", { path: text.slice(5) })], {
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
      // `job` schedules a daily command job, whose first run at once only takes a baseline.
      if (text === "job")
        return fauxAssistantMessage(
          [
            fauxToolCall("job", {
              action: "create",
              type: "command",
              name: "smoke-job",
              schedule: "@daily",
              command: "echo smoke",
            }),
          ],
          { stopReason: "toolUse" },
        );
      // `label <id> <kind> [goal]` labels one of the front's messages in the inbox, as the routing helper would.
      const label = /^label (\S+) (ask|milestone|update|reply)(?: (\S+))?$/.exec(text);
      if (label !== null)
        return fauxAssistantMessage(
          [
            fauxToolCall("inbox", {
              id: label[1] ?? "",
              kind: label[2] ?? "reply",
              ...(label[3] === undefined ? {} : { goal: label[3] }),
            }),
          ],
          { stopReason: "toolUse" },
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
  return createProvider({
    id: faux.provider.id,
    name: faux.provider.name,
    auth: faux.provider.auth,
    models: [
      ...faux.models,
      // Off in smoke homes unless `plugins.classifier` names it: `faux/classifier` sends `work …` to a worker, the rest to the front.
      {
        type: "classifier",
        id: "classifier",
        name: "Faux classifier",
        api: "faux-classifier",
        provider: faux.provider.id,
        baseUrl: "http://localhost:0",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
      },
    ],
    api: faux.provider,
    classifiers: {
      "faux-classifier": {
        classify: async (model, request) => {
          const choice = (picked: string, other: string): ClassifierChoiceAnswer => ({
            type: "choice",
            choice: picked,
            confidence: 0.8,
            probabilities: { [picked]: 0.9, [other]: 0.1 },
          });
          const message = request.state.message;
          const worker = typeof message === "string" && /^work \S+ \S/.test(message);
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            answers: {
              route: worker ? choice("worker", "front") : choice("front", "worker"),
              split: choice("one", "several"),
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    },
  });
}
