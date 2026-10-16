import { spawn } from "node:child_process";

/**
 * Open a URL in the platform's browser, best effort: Termux's Android handler, macOS `open`, Windows' URL handler, or
 * `xdg-open`. Never through a shell, which would re-parse a URL's metacharacters. Resolves false when no launcher ran.
 */
export function openUrl(url: string): Promise<boolean> {
  const [command, args]: [string, string[]] = process.env.TERMUX_VERSION
    ? ["termux-open-url", [url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => resolve(true));
    child.unref();
  });
}

/**
 * Whether a browser opened from here reaches the user: not over SSH, where it would open on this machine instead, and
 * only where a launcher has a screen to open on (Android, macOS, Windows, or a Linux desktop session).
 */
export function browserHere(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.env.TERMUX_VERSION) return true;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Feed `text` to a clipboard command; false when it is missing or fails. */
function pipe(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill(), 5000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

/**
 * Copy `text` to the system clipboard with the platform's command, else through the terminal with OSC 52 (`osc52`
 * writes it), which works over SSH and in terminals that allow it. Resolves how it was copied.
 */
export async function copyText(text: string, osc52: (sequence: string) => void): Promise<string> {
  const commands: [string, string[]][] = process.env.TERMUX_VERSION
    ? [["termux-clipboard-set", []]]
    : process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] satisfies [string, string[]]] : []),
            ...(process.env.DISPLAY
              ? [["xclip", ["-selection", "clipboard"]] satisfies [string, string[]]]
              : []),
          ];
  // Over SSH the local clipboard belongs to another machine: only the terminal reaches the user's.
  if (!process.env.SSH_CONNECTION && !process.env.SSH_TTY)
    for (const [command, args] of commands) if (await pipe(command, args, text)) return "copied";
  osc52(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return "copied through the terminal";
}
