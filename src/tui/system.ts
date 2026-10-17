import { getNativeClipboard } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isImageName } from "../api/attachments.ts";

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

/** A clipboard command's output; undefined when it is missing, fails or prints nothing. */
function output(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 5000 },
      (error, stdout) => resolve(error || stdout.length === 0 ? undefined : stdout),
    );
  });
}

/** What Ctrl+V finds: copied files, an image, or text. */
export type Clipboard =
  | { kind: "files"; paths: string[] }
  | { kind: "image"; data: Uint8Array }
  | { kind: "text"; text: string };

/**
 * The clipboard for Ctrl+V: copied files first, then an image, then text, through Pi's native helper (macOS, Windows,
 * X11) or `wl-paste` on Wayland. Undefined when it is empty or out of reach: over SSH it is another machine's, and
 * Termux's holds only text.
 */
export async function readClipboard(): Promise<Clipboard | undefined> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return undefined;
  if (process.env.TERMUX_VERSION) {
    const text = await output("termux-clipboard-get", []);
    return text === undefined ? undefined : { kind: "text", text: text.toString() };
  }
  const native = getNativeClipboard();
  if (native === undefined && process.env.WAYLAND_DISPLAY) {
    const types = (await output("wl-paste", ["--list-types"]))?.toString().split(/\r?\n/) ?? [];
    const type = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((item) =>
      types.includes(item),
    );
    const image = type === undefined ? undefined : await output("wl-paste", ["--type", type]);
    if (image !== undefined) return { kind: "image", data: new Uint8Array(image) };
    const text = await output("wl-paste", ["--no-newline"]);
    return text === undefined ? undefined : { kind: "text", text: text.toString() };
  }
  if (native === undefined) return undefined;
  const paths = await native.getFilePaths?.();
  if (paths?.length) return { kind: "files", paths };
  const image = await native.getImage();
  if (image?.length) return { kind: "image", data: image };
  const text = await native.getText();
  return text ? { kind: "text", text } : undefined;
}

/**
 * The image files a terminal paste names, as dropping files on a terminal pastes their paths: quoted, escaped, or as
 * `file://` URLs, one per line. Undefined unless every line is an existing image file, so other pastes type as usual.
 */
export function pastedImagePaths(text: string): string[] | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const paths: string[] = [];
  for (const line of lines) {
    let path = line.replace(/^(['"])(.*)\1$/, "$2");
    if (path.startsWith("file://")) {
      try {
        path = fileURLToPath(path);
      } catch {
        return undefined;
      }
    } else if (process.platform !== "win32") path = path.replace(/\\(.)/g, "$1");
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (!isAbsolute(path) || !isImageName(path)) return undefined;
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
    paths.push(path);
  }
  return paths;
}
