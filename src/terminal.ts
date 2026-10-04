import {
  AssistantEntry,
  UserEntry,
  type AgentEvent,
  type AgentEventStream,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Monchu } from "./backend.ts";
import { WorkerResultEntry } from "./workers.ts";

const help = `Commands:
  /work <name> <goal>         start a Sol worker, keep chatting
  /tell <name> <message>      steer a worker (or start its next run)
  /workers                   list workers and execution directories
  /stop <name>                explicitly cancel a worker and its work
  /abort                     stop the front run; workers continue
  /cd <path>                 change the front's directory while idle
  /cd-worker <name> <path>    change an idle worker's directory
  /help                      show commands
  /quit                      save and close; pending work resumes next launch
Otherwise, just talk. You don't need a project or directory.`;

/** Terminal adapter only. Backend events are committed state, not speculative tokens. */
export async function runTerminal(backend: Monchu): Promise<void> {
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && stdout.isTTY),
    prompt: "> ",
  });
  // Register input consumption before asynchronous attachment so piped/early input is not lost.
  const lines = terminal[Symbol.asyncIterator]();
  let stream: AgentEventStream | undefined;
  let speaking = false;
  let printed = new Map<number, string>();

  function finishReply() {
    if (speaking) stdout.write("\n");
    speaking = false;
  }

  function notice(text: string) {
    finishReply();
    stdout.write(`\n${text}\n`);
    terminal.prompt(true);
  }

  function appendText(index: number, text: string) {
    if (!text) return;
    if (!speaking) {
      stdout.write("\nmonchu> ");
      speaking = true;
    }
    stdout.write(text);
    printed.set(index, (printed.get(index) ?? "") + text);
  }

  function showHistory(entry: EntryRecord) {
    if (WorkerResultEntry.is(entry) && entry.data !== undefined) {
      stdout.write(
        `[worker ${entry.data.name}: ${entry.data.status}; request ${entry.data.requestId}]\n${entry.data.text}\n`,
      );
      return;
    }
    if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) return;
    for (const message of entry.model ?? []) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text) stdout.write(`${message.role === "user" ? "you" : "monchu"}> ${text}\n`);
    }
  }

  function render(events: readonly AgentEvent[]) {
    for (const event of events) {
      switch (event.type) {
        case "snapshot": {
          finishReply();
          printed.clear();
          if (event.entries.length) {
            stdout.write("\n[conversation snapshot, recent messages]\n");
            event.entries
              .filter(
                (entry) =>
                  UserEntry.is(entry) || AssistantEntry.is(entry) || WorkerResultEntry.is(entry),
              )
              .slice(-10)
              .forEach(showHistory);
          }
          const partial = event.generation?.message;
          if (partial !== undefined)
            partial.content.forEach((part, index) => {
              if (part.type === "text") appendText(index, part.text);
            });
          break;
        }
        case "message_start":
          if (event.message.role === "assistant") {
            finishReply();
            printed = new Map();
          }
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "text_delta") appendText(change.contentIndex, change.delta);
            else if (change.type === "text_start" && change.block.type === "text")
              appendText(change.contentIndex, change.block.text);
          }
          break;
        case "message_end":
          if (WorkerResultEntry.is(event.entry) && event.entry.data !== undefined) {
            const result = event.entry.data;
            notice(
              `[worker ${result.name}: ${result.status}; request ${result.requestId}]\n${result.text}`,
            );
          } else if (AssistantEntry.is(event.entry)) {
            for (const message of event.entry.model ?? []) {
              if (message.role !== "assistant") continue;
              message.content.forEach((part, index) => {
                if (part.type !== "text") return;
                const previous = printed.get(index) ?? "";
                if (part.text.startsWith(previous))
                  appendText(index, part.text.slice(previous.length));
                else notice(`[committed revision]\n${part.text}`);
              });
              if (message.stopReason === "error")
                notice(`[model failed] ${message.errorMessage ?? "Unknown provider error"}`);
              if (message.stopReason === "aborted") notice("[front interrupted]");
            }
            finishReply();
            terminal.prompt(true);
          }
          break;
        case "tool_execution_start":
          notice(`[tool: ${event.toolName}]`);
          break;
        case "tool_execution_end":
          for (const message of event.entry?.model ?? []) {
            if (message.role === "toolResult" && message.isError) {
              notice(
                `[${event.toolName} failed] ${message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n")
                  .slice(0, 1000)}`,
              );
            }
          }
          break;
        case "submission":
          if (event.record.status === "unanswered")
            notice(`[input ${event.record.id}: ${event.record.reason}]`);
          break;
        case "auto_retry_start":
          notice(`[provider retry ${event.attempt}] ${event.errorMessage}`);
          break;
        case "task_failed":
          notice(`[task failed: ${event.kind}] ${event.message}`);
          break;
        case "run_end":
          finishReply();
          terminal.prompt(true);
          break;
      }
    }
  }

  const shutdown = () => terminal.close();
  const interrupt = () => {
    void backend.abort().then(
      () => notice("[front stopped; workers continue]"),
      (error: unknown) => notice(error instanceof Error ? error.message : String(error)),
    );
  };
  terminal.on("SIGINT", interrupt);
  process.on("SIGTERM", shutdown);
  stdout.write(
    `Monchu | Luna front / Sol workers | classifier disabled\nHome: ${backend.home}\n/help for commands.\n`,
  );
  try {
    stream = await backend.watch(render);
    void stream.closed.then((end) => {
      if (end.reason === "listener_error") {
        console.error(end.error.message);
        process.exitCode = 1;
        terminal.close();
      }
    });
    terminal.prompt();
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        terminal.prompt();
        continue;
      }
      try {
        const [command] = line.split(/\s+/, 1);
        const rest = line.slice(command?.length ?? 0).trim();
        if (command === "/quit") break;
        if (command === "/help") notice(help);
        else if (command === "/abort") {
          await backend.abort();
          notice("[front stopped; workers continue]");
        } else if (command === "/workers") {
          const workers = await backend.workers();
          notice(
            workers.length
              ? workers
                  .map(
                    (worker) =>
                      `${worker.name}: ${worker.busy ? "working" : "idle"} | ${worker.cwd}`,
                  )
                  .join("\n")
              : "No workers yet.",
          );
        } else if (command === "/stop") {
          await backend.stopWorker(rest);
          notice(`[stopped ${rest}]`);
        } else if (command === "/cd") {
          if (!rest) throw new Error("Usage: /cd <path>");
          notice(`[directory: ${await backend.changeDirectory(rest)}]`);
        } else if (command === "/work" || command === "/tell" || command === "/cd-worker") {
          const parsed = /^(\S+)\s+([\s\S]+)$/.exec(rest);
          const name = parsed?.[1];
          const message = parsed?.[2];
          if (name === undefined || message === undefined)
            throw new Error(
              `Usage: ${command} <name> <${command === "/cd-worker" ? "path" : "message"}>`,
            );
          if (command === "/cd-worker")
            notice(`[${name} directory: ${await backend.changeDirectory(message, name)}]`);
          else {
            const requestId = randomUUID();
            if (command === "/work") {
              await backend.startWorker(name, message, requestId);
              notice(`[worker ${name} creation committed; request ${requestId}]`);
            } else {
              await backend.messageWorker(name, message, requestId);
              notice(`[message to ${name} committed; request ${requestId}]`);
            }
          }
        } else if (line.startsWith("/")) throw new Error("Unknown command. /help lists commands.");
        else {
          const receipt = await backend.submit(line, randomUUID());
          notice(`[received ${receipt.submissionId}; classifier ${receipt.classification.status}]`);
        }
      } catch (error) {
        notice(`[error] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    finishReply();
    terminal.off("SIGINT", interrupt);
    process.off("SIGTERM", shutdown);
    terminal.close();
    await stream?.stop();
  }
}
