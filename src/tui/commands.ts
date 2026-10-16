type Input =
  | { command: "message"; text: string }
  | {
      command:
        | "/quit"
        | "/help"
        | "/abort"
        | "/workers"
        | "/goals"
        | "/queue"
        | "/reload"
        | "/restart"
        | "/login"
        | "/thinking";
    }
  | {
      command: "/new" | "/compact" | "/cd" | "/stop" | "/agents" | "/model" | "/mcp";
      text: string;
    }
  | { command: "/work" | "/tell" | "/cd-worker"; name: string; text: string };

/** Every command once, in help order; parsing, help, and autocomplete all read this table. */
export const commands: Record<
  Exclude<Input["command"], "message">,
  { usage: string; help: string }
> = {
  "/work": { usage: "<name> <goal>", help: "start a background worker" },
  "/tell": { usage: "<name> <message>", help: "message a worker" },
  "/workers": { usage: "", help: "list workers and directories" },
  "/agents": { usage: "[name|root]", help: "view and talk to a worker; root is the default" },
  "/goals": { usage: "", help: "list ongoing endeavors and open commitments" },
  "/model": {
    usage: "[search]",
    help: "pick the model of a conversation or the front/worker default",
  },
  "/thinking": {
    usage: "",
    help: "pick the thinking level of a conversation or the front/worker default",
  },
  "/queue": { usage: "", help: "edit, steer or delete the shown conversation's queued messages" },
  "/stop": { usage: "<name>", help: "cancel a worker and its work" },
  "/abort": { usage: "", help: "stop the front only; workers continue" },
  "/new": { usage: "[handoff]", help: "fresh root context" },
  "/compact": { usage: "[instructions]", help: "summarize root context" },
  "/cd": { usage: "<path>", help: "change the idle root's directory" },
  "/cd-worker": { usage: "<name> <path>", help: "change an idle worker's directory" },
  "/login": {
    usage: "",
    help: "log in to a provider: Codex, Claude Code, or Cloudflare for routing advice",
  },
  "/mcp": {
    usage: "[login|logout|reconnect] [server]",
    help: "MCP servers: state and tools, browser sign-in, sign-out, reconnect",
  },
  "/reload": { usage: "", help: "reload config, extensions and home/bundled skills" },
  "/restart": {
    usage: "",
    help: "User-only approval: restore the terminal and restart Monchu",
  },
  "/help": { usage: "", help: "show commands" },
  "/quit": { usage: "", help: "save and close" },
};

export const help = [
  "Commands:",
  ...Object.entries(commands).map(([command, { usage, help }]) =>
    `${`${command} ${usage}`.padEnd(26)}${help}`.trimEnd(),
  ),
  "Esc interrupts a running front and puts your queued messages back in the editor. Ctrl-C clears the editor; twice quickly exits. Ctrl-D exits with an empty editor.",
  "Ctrl-O expands tools and worker messages; click one to toggle it. Shift-Enter or backslash-Enter inserts a newline.",
  "Alt+S toggles whether a message to a busy conversation steers its reply or follows up after it.",
  "Alt+Q opens /queue.",
  "Plain messages, /model and /thinking go to the conversation shown; root commands always target the root.",
].join("\n");

/** Parse once at the input boundary; directory/message tails may contain spaces and newlines. */
export function parseInput(raw: string): Input | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  if (!line.startsWith("/")) return { command: "message", text: line };
  const command = line.split(/\s+/, 1)[0];
  const rest = line.slice(command?.length ?? 0).trim();
  switch (command) {
    case "/quit":
    case "/help":
    case "/abort":
    case "/workers":
    case "/goals":
    case "/queue":
    case "/login":
    case "/thinking":
    case "/reload":
    case "/restart":
      if (rest) throw new Error(`Usage: ${command}`);
      return { command };
    case "/new":
    case "/compact":
    case "/agents":
    case "/model":
    case "/mcp":
      return { command, text: rest };
    case "/cd":
    case "/stop":
      if (!rest) throw new Error(`Usage: ${command} ${commands[command].usage}`);
      return { command, text: rest };
    case "/work":
    case "/tell":
    case "/cd-worker": {
      const [, name, text] = /^(\S+)\s+([\s\S]+)$/.exec(rest) ?? [];
      if (name === undefined || text === undefined)
        throw new Error(`Usage: ${command} ${commands[command].usage}`);
      return { command, name, text };
    }
    default:
      throw new Error("Unknown command. /help lists commands.");
  }
}
