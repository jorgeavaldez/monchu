import { parseRelease } from "../api/release.ts";

type Input =
  | { command: "message"; text: string }
  | {
      command:
        | "/quit"
        | "/help"
        | "/goals"
        | "/jobs"
        | "/queue"
        | "/reload"
        | "/restart"
        | "/login"
        | "/thinking"
        | "/detach";
    }
  | {
      command:
        | "/new"
        | "/compact"
        | "/cd"
        | "/stop"
        | "/agents"
        | "/roots"
        | "/model"
        | "/mcp"
        | "/logs"
        | "/clef"
        | "/update"
        | "/attach";
      text: string;
    }
  | { command: "skill"; name: string; text: string };

/**
 * Every command once, in help order; parsing, help, and the editor's typeahead all read this table. `help` is short
 * enough to show beside the command on a phone.
 */
export const commands: Record<
  Exclude<Input["command"], "message" | "skill">,
  { usage: string; help: string }
> = {
  "/agents": {
    usage: "[name|root]",
    help: "show the root or a worker; messages go to the one shown",
  },
  "/roots": {
    usage: "[id|new|rename|archive]",
    help: "roots: switch, start, rename, archive; each has its own crew",
  },
  "/goals": { usage: "", help: "ongoing projects and commitments" },
  "/jobs": {
    usage: "",
    help: "every job (agent, command, bg) and recent job events",
  },
  "/logs": {
    usage: "[severity|scope]",
    help: "recent log records: warnings, timings, model replies, connections",
  },
  "/model": { usage: "[search]", help: "pick a model, for a conversation or a role default" },
  "/thinking": { usage: "", help: "pick a thinking level, for a conversation or a role default" },
  "/queue": { usage: "", help: "edit, steer or delete queued messages (Alt+Q)" },
  "/stop": {
    usage: "[name]",
    help: "stop the shown conversation, or the named worker; others keep going",
  },
  "/attach": {
    usage: "[path]",
    help: "attach a file or image to your next message (Ctrl+V pastes one)",
  },
  "/detach": { usage: "", help: "drop the files waiting for your next message" },
  "/new": { usage: "[handoff]", help: "fresh root context, optionally carrying a handoff" },
  "/compact": { usage: "[instructions]", help: "summarize the root's context now" },
  "/cd": { usage: "<path>", help: "change the shown conversation's directory (while idle)" },
  "/login": {
    usage: "",
    help: "sign in to a model provider: Codex, Claude Code, Cloudflare, OpenCode, OpenRouter",
  },
  "/mcp": {
    usage: "[login|logout|reconnect] [server]",
    help: "MCP servers and their tools; sign in, sign out, reconnect",
  },
  "/clef": { usage: "[on|off]", help: "routing advice (Clef): show, pause or resume it" },
  "/reload": {
    usage: "",
    help: "apply config, skill and extension edits now; running work keeps going",
  },
  "/restart": {
    usage: "",
    help: "restart Monchu for its own code changes; running steps rerun after",
  },
  "/update": {
    usage: "[edge|version]",
    help: "install a release (edge: main's newest) and restart on it",
  },
  "/help": { usage: "", help: "commands and keys" },
  "/quit": { usage: "", help: "save and close" },
};

/** Providers /login offers, in menu order, in every client, with the login each takes. */
export const LOGIN_PROVIDERS: readonly { id: string; label: string; auth: "oauth" | "api_key" }[] =
  [
    { id: "openai-codex", label: "OpenAI Codex (ChatGPT subscription)", auth: "oauth" },
    { id: "claude-code", label: "Claude Code (Pro/Max, via claude setup-token)", auth: "oauth" },
    {
      id: "cloudflare-workers-ai",
      label: "Cloudflare Workers AI (optional routing advice)",
      auth: "api_key",
    },
    { id: "opencode-go", label: "OpenCode Go (API key)", auth: "api_key" },
    { id: "opencode", label: "OpenCode Zen (API key)", auth: "api_key" },
    { id: "openrouter", label: "OpenRouter (API key)", auth: "api_key" },
  ];

/** The login a /login provider takes. */
export function loginAuth(provider: string): "oauth" | "api_key" {
  return LOGIN_PROVIDERS.find((entry) => entry.id === provider)?.auth ?? "oauth";
}

export const help = [
  "Commands:",
  ...Object.entries(commands).map(([command, { usage, help }]) =>
    `${`${command} ${usage}`.padEnd(21)} ${help}`.trimEnd(),
  ),
  `${"/skill:<name> [text]".padEnd(21)} send a skill's instructions with your text`,
  "Esc interrupts a running front and puts your queued messages back in the editor. Ctrl-C clears the editor; twice quickly exits. Ctrl-D exits with an empty editor.",
  "Ctrl-O expands tools and worker messages; click one to toggle it. Shift-Enter or backslash-Enter inserts a newline.",
  "Ctrl+V (Alt+V on Windows) attaches a copied image or file, and a pasted image path attaches that image; in the web, use the attach button, paste or drop.",
  "Alt+S toggles whether a message to a busy conversation steers its reply or follows up after it.",
  "Plain messages and /model, /thinking, /stop and /cd go to the conversation shown; /new and /compact always target the shown root. Footer dots are roots at work (●) or done unseen; /roots has them.",
].join("\n");

/** Parse once at the input boundary; directory/message tails may contain spaces and newlines. */
export function parseInput(raw: string): Input | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  if (!line.startsWith("/")) return { command: "message", text: line };
  const command = line.split(/\s+/, 1)[0] ?? "";
  const rest = line.slice(command.length).trim();
  if (command.startsWith("/skill:") && command.length > "/skill:".length)
    return { command: "skill", name: command.slice("/skill:".length), text: rest };
  switch (command) {
    case "/quit":
    case "/help":
    case "/goals":
    case "/jobs":
    case "/queue":
    case "/login":
    case "/thinking":
    case "/reload":
    case "/restart":
    case "/detach":
      if (rest) throw new Error(`Usage: ${command}`);
      return { command };
    case "/new":
    case "/compact":
    case "/agents":
    case "/roots":
    case "/model":
    case "/mcp":
    case "/stop":
    case "/logs":
    case "/attach":
      return { command, text: rest };
    case "/clef":
      if (rest !== "" && rest !== "on" && rest !== "off")
        throw new Error(`Usage: ${command} ${commands[command].usage}`);
      return { command, text: rest };
    case "/update": {
      const release = parseRelease(rest || "edge");
      if (release === undefined) throw new Error(`Usage: ${command} ${commands[command].usage}`);
      return { command, text: release };
    }
    case "/cd":
      if (!rest) throw new Error(`Usage: ${command} ${commands[command].usage}`);
      return { command, text: rest };
    default:
      throw new Error("Unknown command. /help lists commands.");
  }
}
