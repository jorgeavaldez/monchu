export const help = `Commands:
/work <name> <goal>       start a background worker
/tell <name> <message>    message a worker
/workers                 list workers and directories
/agents [name|root]       view and talk to a worker; root is the default
/goals                   list open goals
/stop <name>              cancel a worker and its work
/abort                   stop the front only; workers continue
/new [handoff]            fresh root context
/compact [instructions]  summarize root context
/cd <path>               change the idle root's directory
/cd-worker <name> <path>  change an idle worker's directory
/reload                  reload extensions, skills, instructions, and settings
/restart                 Jorge-only approval: restore the terminal and restart Monchu
/help                    show commands
/quit                    save and close
Esc / Ctrl-C abort the front. Ctrl-D exits with an empty editor.
Ctrl-O expands tools. Shift-Enter or backslash-Enter inserts a newline.
Plain messages go to the conversation shown; root commands always target the root.`;

type Input =
  | { command: "message"; text: string }
  | { command: "/quit" | "/help" | "/abort" | "/workers" | "/goals" | "/reload" | "/restart" }
  | { command: "/new" | "/compact" | "/cd" | "/stop" | "/agents"; text: string }
  | { command: "/work" | "/tell" | "/cd-worker"; name: string; text: string };

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
    case "/reload":
    case "/restart":
      if (rest) throw new Error(`Usage: ${command}`);
      return { command };
    case "/new":
    case "/compact":
    case "/agents":
      return { command, text: rest };
    case "/cd":
    case "/stop":
      if (!rest) throw new Error(`Usage: ${command} <${command === "/cd" ? "path" : "name"}>`);
      return { command, text: rest };
    case "/work":
    case "/tell":
    case "/cd-worker": {
      const parsed = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      const name = parsed?.[1];
      const text = parsed?.[2];
      if (name === undefined || text === undefined)
        throw new Error(
          `Usage: ${command} <name> <${command === "/cd-worker" ? "path" : "message"}>`,
        );
      return { command, name, text };
    }
    default:
      throw new Error("Unknown command. /help lists commands.");
  }
}
