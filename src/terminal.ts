import {
  AssistantEntry,
  UserEntry,
  type AgentEvent,
  type AgentEventStream,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { clearScreenDown, createInterface, cursorTo, moveCursor } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Monchu } from "./backend.ts";
import { ClassificationEntry } from "./classifier.ts";
import { WorkerResultEntry } from "./workers.ts";

const help = `Commands:
  /work <name> <goal>         start a background worker, keep chatting
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
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: interactive,
    prompt: "you> ",
  });
  // Register input consumption before asynchronous attachment so piped/early input is not lost.
  const lines = terminal[Symbol.asyncIterator]();
  let stream: AgentEventStream | undefined;
  let speaking = false;
  let promptVisible = false;
  let activity: string | undefined;
  let background = "";
  let printed = new Map<number, string>();
  const tools = new Map<string, string>();

  function erasePrompt() {
    if (!promptVisible) return;
    const { rows } = terminal.getCursorPos();
    cursorTo(stdout, 0);
    if (rows) moveCursor(stdout, 0, -rows);
    clearScreenDown(stdout);
    promptVisible = false;
  }

  function prompt() {
    if (!interactive || speaking) return;
    terminal.prompt(true);
    promptVisible = true;
  }

  function finishReply() {
    if (speaking) stdout.write("\n");
    speaking = false;
  }

  function notice(text: string) {
    finishReply();
    erasePrompt();
    stdout.write(`\nsystem · ${text}\n`);
    prompt();
  }

  function setActivity(next: string | undefined) {
    if (next === activity) return;
    activity = next;
    if (next !== undefined) notice(next);
  }

  async function updateWorkers() {
    const names = (await backend.workers())
      .filter((worker) => worker.busy)
      .map((worker) => worker.name)
      .join(", ");
    if (names === background) return;
    background = names;
    notice(names ? `background work · ${names}` : "background work idle");
  }

  function appendText(index: number, text: string) {
    if (!text) return;
    erasePrompt();
    activity = undefined;
    if (!speaking) {
      stdout.write("\nmonchu · response\n");
      speaking = true;
    }
    stdout.write(text);
    printed.set(index, (printed.get(index) ?? "") + text);
  }

  function reconcileText(index: number, text: string) {
    const previous = printed.get(index) ?? "";
    if (text.startsWith(previous)) appendText(index, text.slice(previous.length));
    else {
      notice("response updated");
      printed.delete(index);
      appendText(index, text);
    }
  }

  function showEntry(entry: EntryRecord) {
    if (ClassificationEntry.is(entry)) {
      const result = entry.data;
      finishReply();
      erasePrompt();
      stdout.write(
        result.status === "failed"
          ? `\nsystem · classifier failed · ${result.message}\n`
          : `\nsystem · routing · ${result.disposition} (${Math.round(result.confidence * 100)}%) · effort ${result.effort} (${Math.round(result.effortConfidence * 100)}%)\n`,
      );
      return;
    }
    if (WorkerResultEntry.is(entry)) {
      finishReply();
      erasePrompt();
      stdout.write(`\nworker · ${entry.data.name} · ${entry.data.status}\n${entry.data.text}\n`);
      return;
    }
    if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) return;
    for (const message of entry.model ?? []) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text)
        stdout.write(
          message.role === "user" ? `\nyou> ${text}\n` : `\nmonchu · response\n${text}\n`,
        );
    }
  }

  async function render(events: readonly AgentEvent[]) {
    let workersChanged = false;
    for (const event of events) {
      switch (event.type) {
        case "snapshot": {
          finishReply();
          erasePrompt();
          activity = undefined;
          printed.clear();
          tools.clear();
          if (event.entries.length) {
            stdout.write("\nsystem · recent conversation\n");
            event.entries
              .filter(
                (entry) =>
                  UserEntry.is(entry) ||
                  AssistantEntry.is(entry) ||
                  WorkerResultEntry.is(entry) ||
                  ClassificationEntry.is(entry),
              )
              .slice(-10)
              .forEach(showEntry);
          }
          const partial = event.generation?.message;
          if (partial !== undefined) {
            partial.content.forEach((part, index) => {
              if (part.type === "text") appendText(index, part.text);
            });
          }
          for (const tool of event.tools)
            if (tool.status === "running") tools.set(tool.callId, tool.name);
          if (tools.size) setActivity(`running ${[...tools.values()].join(", ")}…`);
          else if (partial?.content.at(-1)?.type === "thinking") setActivity("thinking…");
          else if (event.generation?.retry)
            setActivity(`retrying · ${event.generation.retry.error}`);
          else if (event.run && !speaking) setActivity("loading…");
          workersChanged = true;
          break;
        }
        case "run_start":
        case "turn_start":
          setActivity("loading…");
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            finishReply();
            printed = new Map();
            setActivity("loading…");
          }
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "thinking_start" || change.type === "thinking_delta")
              setActivity("thinking…");
            else if (change.type === "text_delta") appendText(change.contentIndex, change.delta);
            else if (
              (change.type === "text_start" || change.type === "block") &&
              change.block.type === "text"
            )
              reconcileText(change.contentIndex, change.block.text);
            else if (change.type === "message") {
              change.message.content.forEach((part, index) => {
                if (part.type === "text") reconcileText(index, part.text);
              });
              if (change.message.content.at(-1)?.type === "thinking") setActivity("thinking…");
            }
          }
          break;
        case "entry_appended":
          if (ClassificationEntry.is(event.entry)) {
            showEntry(event.entry);
            prompt();
          }
          break;
        case "message_end":
          if (WorkerResultEntry.is(event.entry)) {
            showEntry(event.entry);
            workersChanged = true;
            prompt();
          } else if (AssistantEntry.is(event.entry)) {
            for (const message of event.entry.model ?? []) {
              if (message.role !== "assistant") continue;
              message.content.forEach((part, index) => {
                if (part.type === "text") reconcileText(index, part.text);
              });
              if (message.stopReason === "error")
                notice(`model failed · ${message.errorMessage ?? "Unknown provider error"}`);
              if (message.stopReason === "aborted") notice("front interrupted");
            }
            finishReply();
            setActivity(undefined);
            prompt();
          }
          break;
        case "tool_execution_start":
          tools.set(event.toolCallId, event.toolName);
          setActivity(`running ${[...tools.values()].join(", ")}…`);
          break;
        case "tool_execution_end":
          tools.delete(event.toolCallId);
          setActivity(tools.size ? `running ${[...tools.values()].join(", ")}…` : "loading…");
          for (const message of event.entry?.model ?? []) {
            if (message.role === "toolResult" && message.isError)
              notice(
                `${event.toolName} failed · ${message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n")
                  .slice(0, 1000)}`,
              );
          }
          if (["start_worker", "message_worker", "stop_worker"].includes(event.toolName))
            workersChanged = true;
          break;
        case "submission":
          if (event.record.status === "unanswered")
            notice(`input ${event.record.id} · ${event.record.reason}`);
          break;
        case "auto_retry_start":
          setActivity(`retrying · ${event.errorMessage}`);
          break;
        case "deferred_poll":
          setActivity("waiting for provider…");
          break;
        case "compaction_start":
          setActivity("updating conversation context…");
          break;
        case "task_failed":
          notice(`task failed · ${event.kind} · ${event.message}`);
          break;
        case "run_end":
          finishReply();
          tools.clear();
          setActivity(undefined);
          prompt();
          break;
      }
    }
    if (workersChanged) await updateWorkers();
  }

  const shutdown = () => terminal.close();
  const interrupt = () => {
    void backend.abort().then(
      () => notice("front stopped; workers continue"),
      (error: unknown) => notice(error instanceof Error ? error.message : String(error)),
    );
  };
  terminal.on("SIGINT", interrupt);
  process.on("SIGTERM", shutdown);
  const { front, worker, classifier } = backend.config;
  stdout.write(
    `Monchu | front ${front.modelId} / workers ${worker.modelId} | classifier ${classifier?.modelId ?? "off"}\nHome: ${backend.home}\n/help for commands.\n`,
  );
  const stopReports = backend.onReport((message) => notice(`warning · ${message}`));
  try {
    stream = await backend.watch(render);
    void stream.closed.then((end) => {
      if (end.reason === "listener_error") {
        console.error(`system · ${end.error.message}`);
        process.exitCode = 1;
        terminal.close();
      }
    });
    prompt();
    for await (const raw of lines) {
      promptVisible = false;
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (!interactive) stdout.write(`\nyou> ${line}\n`);
      try {
        const [command] = line.split(/\s+/, 1);
        const rest = line.slice(command?.length ?? 0).trim();
        if (command === "/quit") break;
        if (command === "/help") notice(help);
        else if (command === "/abort") {
          await backend.abort();
          notice("front stopped; workers continue");
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
          notice(`stopped worker · ${rest}`);
          await updateWorkers();
        } else if (command === "/cd") {
          if (!rest) throw new Error("Usage: /cd <path>");
          notice(`directory · ${await backend.changeDirectory(rest)}`);
        } else if (command === "/work" || command === "/tell" || command === "/cd-worker") {
          const parsed = /^(\S+)\s+([\s\S]+)$/.exec(rest);
          const name = parsed?.[1];
          const message = parsed?.[2];
          if (name === undefined || message === undefined)
            throw new Error(
              `Usage: ${command} <name> <${command === "/cd-worker" ? "path" : "message"}>`,
            );
          if (command === "/cd-worker")
            notice(`${name} directory · ${await backend.changeDirectory(message, name)}`);
          else {
            const requestId = randomUUID();
            if (command === "/work") {
              await backend.startWorker(name, message, requestId);
              notice(`worker ${name} · creation committed`);
            } else {
              await backend.messageWorker(name, message, requestId);
              notice(`worker ${name} · message committed`);
            }
            await updateWorkers();
          }
        } else if (line.startsWith("/")) throw new Error("Unknown command. /help lists commands.");
        else {
          await backend.submit(line, randomUUID());
          notice("received");
        }
      } catch (error) {
        notice(`error · ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    finishReply();
    erasePrompt();
    stopReports();
    terminal.off("SIGINT", interrupt);
    process.off("SIGTERM", shutdown);
    terminal.close();
    await stream?.stop();
  }
}
