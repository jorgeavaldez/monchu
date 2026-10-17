/*
Commands and options follow Pi's `pi mcp` (packages/coding-agent/src/extensions/mcp/cli.ts):
https://github.com/earendil-works/pi
Copyright (c) 2025 Mario Zechner
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { McpSignInPrompt } from "./auth.ts";
import { addMcpServer, removeMcpServer, usesOAuth, validateMcpServer } from "./config.ts";
import { formatReports, mcpLogin, mcpLogout, mcpReports } from "./manage.ts";
import { McpClients } from "./index.ts";

const HELP = `Usage:
  monchu mcp add <server> [options] -- <command> [args...]
  monchu mcp add <server> [options] --url <url>
  monchu mcp remove <server>
  monchu mcp list [--json]
  monchu mcp login <server> [--timeout <seconds>]
  monchu mcp logout <server>

Configure and check MCP servers in <home>/mcp.json and sign in to OAuth servers, like pi mcp.
A running Monchu offers changes after /reload (or /mcp reconnect).

Options for add:
  --url <url>             Streamable HTTP server URL (instead of a command)
  --env <KEY=VALUE>       Environment variable for a stdio server (repeatable)
  --cwd <dir>             Working directory for a stdio server
  --header <KEY=VALUE>    HTTP header (repeatable)
  --bearer-token-env-var <NAME>
                          Send "Authorization: Bearer \${NAME}"
  --oauth-client-id <id>  Pre-registered OAuth client id
  --oauth-client-secret <secret>
                          OAuth client secret (may be \${NAME} or !command)
  --oauth-callback-port <port>
                          Fixed OAuth callback port
  --oauth-client-name <name>
                          Client name sent when registering with the OAuth server
  --exposure <mode>       codemode (default), deferred, direct, or hidden
  --description <text>    What the server offers, shown with its tools
  --preload               Load its deferred tools from the start in Claude Code conversations

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     How long login waits for the browser (default: 300)`;

type Kind = "flag" | "value" | "list";

type Output = { log: (line: string) => void; error: (line: string) => void };

export type McpCommandOptions = Output & {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Token of a `/login` provider, for servers with `auth.provider`. */
  providerToken?: (provider: string) => Promise<string | undefined>;
  /** Default: the platform's browser opener, best effort. */
  openUrl?: (url: string) => void;
  /** Whether to offer pasting the redirect URL. Default: stdin is a terminal. */
  interactive?: boolean;
};

/** Parse `--name value` options; `--` ends them, so a stdio command keeps its own flags. */
function parseOptions(
  args: string[],
  spec: Record<string, Kind>,
  error: (line: string) => void,
):
  | { positional: string[]; values: Map<string, string | true>; lists: Map<string, string[]> }
  | undefined {
  const positional: string[] = [];
  const values = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [flag, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const name = flag ?? "";
    const kind = spec[name];
    if (kind === undefined) {
      error(`Unknown option --${name}. Use "monchu mcp --help" for usage.`);
      return undefined;
    }
    if (kind === "flag") {
      values.set(name, true);
      continue;
    }
    const value = inline ?? args[++index];
    if (value === undefined) {
      error(`--${name} needs a value.`);
      return undefined;
    }
    if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
    else values.set(name, value);
  }
  return { positional, values, lists };
}

function pairs(
  option: string,
  items: string[] | undefined,
  error: (line: string) => void,
): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const pair of items ?? []) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      error(`--${option} expects KEY=VALUE, got "${pair}".`);
      return undefined;
    }
    record[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return record;
}

/** The platform's browser opener, best effort: the URL is always printed too. */
function openBrowser(url: string, env: Readonly<Record<string, string | undefined>>): void {
  const [command, ...args] =
    process.platform === "win32"
      ? ["cmd", "/c", "start", '""', url.replace(/&/g, "^&")]
      : process.platform === "darwin"
        ? ["open", url]
        : env.TERMUX_VERSION !== undefined
          ? ["termux-open-url", url]
          : ["xdg-open", url];
  try {
    const child = spawn(command ?? "", args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL still works.
  }
}

async function add(args: string[], options: McpCommandOptions): Promise<number> {
  const { log, error } = options;
  const parsed = parseOptions(
    args,
    {
      url: "value",
      env: "list",
      cwd: "value",
      header: "list",
      "bearer-token-env-var": "value",
      "oauth-client-id": "value",
      "oauth-client-secret": "value",
      "oauth-callback-port": "value",
      "oauth-client-name": "value",
      exposure: "value",
      description: "value",
      preload: "flag",
    },
    error,
  );
  if (parsed === undefined) return 1;
  const { positional, values, lists } = parsed;
  const [name, ...command] = positional;
  const value = (option: string) => {
    const found = values.get(option);
    return typeof found === "string" ? found : undefined;
  };
  const url = value("url");
  if (name === undefined || (url === undefined) === (command.length === 0)) {
    error(
      'Usage: monchu mcp add <server> [options] (--url <url> | -- <command> [args...])\nUse "monchu mcp --help" for usage.',
    );
    return 1;
  }
  const httpOnly = [
    "header",
    "bearer-token-env-var",
    "oauth-client-id",
    "oauth-client-secret",
    "oauth-callback-port",
    "oauth-client-name",
  ];
  const misplaced = (url === undefined ? httpOnly : ["env", "cwd"]).find(
    (option) => values.has(option) || lists.has(option),
  );
  if (misplaced !== undefined) {
    error(
      `--${misplaced} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}.`,
    );
    return 1;
  }
  let raw: Record<string, unknown>;
  if (url !== undefined) {
    const headers = pairs("header", lists.get("header"), error);
    if (headers === undefined) return 1;
    const bearer = value("bearer-token-env-var");
    if (bearer !== undefined) headers.Authorization = `Bearer \${${bearer}}`;
    const port = value("oauth-callback-port");
    const oauth = {
      ...(value("oauth-client-id") === undefined ? {} : { clientId: value("oauth-client-id") }),
      ...(value("oauth-client-secret") === undefined
        ? {}
        : { clientSecret: value("oauth-client-secret") }),
      ...(port === undefined ? {} : { callbackPort: Number(port) }),
      ...(value("oauth-client-name") === undefined
        ? {}
        : { clientName: value("oauth-client-name") }),
    };
    raw = {
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(oauth).length ? { oauth } : {}),
    };
  } else {
    const env = pairs("env", lists.get("env"), error);
    if (env === undefined) return 1;
    const [executable, ...commandArgs] = command;
    raw = {
      command: executable,
      ...(commandArgs.length ? { args: commandArgs } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(value("cwd") === undefined ? {} : { cwd: value("cwd") }),
    };
  }
  if (value("exposure") !== undefined) raw.exposure = value("exposure");
  if (value("description") !== undefined) raw.description = value("description");
  if (values.has("preload")) raw.preload = true;
  const validated = validateMcpServer(name, raw);
  if (typeof validated === "string") {
    error(validated);
    return 1;
  }
  const path = join(options.home, "mcp.json");
  // Written in the order the options name the fields, with aliases resolved.
  const replaced = await addMcpServer(options.home, name, { ...raw, ...validated });
  log(`${replaced ? "Replaced" : "Added"} MCP server "${name}" in ${path}.`);
  log(
    `Check it with: monchu mcp list${usesOAuth(validated) ? `. If it requires sign-in: monchu mcp login ${name}` : ""}`,
  );
  return 0;
}

/** `monchu mcp …`: runs without opening Monchu's store, so it works while Monchu runs. Resolves the exit code. */
export async function runMcpCommand(args: string[], options: McpCommandOptions): Promise<number> {
  const { log, error } = options;
  const [command, ...rest] = args;
  if (
    command === undefined ||
    command === "help" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    log(HELP);
    return 0;
  }
  if (command === "add") return add(rest, options);
  const parsed = parseOptions(
    rest,
    command === "list" ? { json: "flag" } : command === "login" ? { timeout: "value" } : {},
    error,
  );
  if (parsed === undefined) return 1;
  const [name, ...extra] = parsed.positional;
  if (command === "remove") {
    if (name === undefined || extra.length) {
      error("Usage: monchu mcp remove <server>");
      return 1;
    }
    const path = join(options.home, "mcp.json");
    if (!(await removeMcpServer(options.home, name))) {
      error(`No MCP server named "${name}" in ${path}.`);
      return 1;
    }
    log(`Removed MCP server "${name}" from ${path}.`);
    return 0;
  }
  const clients = new McpClients(options.home, options.env, () => {}, options.providerToken);
  try {
    switch (command) {
      case "list": {
        if (parsed.positional.length) {
          error("Usage: monchu mcp list [--json]");
          return 1;
        }
        const report = await mcpReports(options.home, clients);
        if (parsed.values.has("json")) log(JSON.stringify(report, null, 2));
        else
          for (const line of formatReports(report, (server) => `monchu mcp login ${server}`))
            log(line);
        const failed =
          report.errors.length > 0 ||
          report.servers.some((server) => server.enabled && server.state !== "connected");
        return failed ? 1 : 0;
      }
      case "login": {
        if (name === undefined || extra.length) {
          error("Usage: monchu mcp login <server> [--timeout <seconds>]");
          return 1;
        }
        const timeout = Number(parsed.values.get("timeout") ?? 300);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          error("--timeout must be a positive number of seconds.");
          return 1;
        }
        const openUrl = options.openUrl ?? ((url: string) => openBrowser(url, options.env));
        const interactive = options.interactive ?? process.stdin.isTTY === true;
        const prompt: McpSignInPrompt = {
          showAuthorizationUrl: (url) => {
            log(`Sign in to MCP server "${name}" in your browser:\n${url}`);
            openUrl(url);
          },
          ...(interactive
            ? {
                promptForRedirectUrl: async (signal) => {
                  const readline = createInterface({
                    input: process.stdin,
                    output: process.stderr,
                  });
                  try {
                    return await readline.question(
                      "If the browser cannot reach this machine, paste the URL it was redirected to: ",
                      { signal },
                    );
                  } catch {
                    return undefined;
                  } finally {
                    readline.close();
                  }
                },
              }
            : {}),
        };
        try {
          log(
            await mcpLogin(
              options.home,
              clients,
              name,
              prompt,
              AbortSignal.timeout(timeout * 1000),
            ),
          );
          return 0;
        } catch (signInError) {
          error(
            `Sign-in to MCP server "${name}" failed: ${signInError instanceof Error ? signInError.message : String(signInError)}`,
          );
          return 1;
        }
      }
      case "logout": {
        if (name === undefined || extra.length) {
          error("Usage: monchu mcp logout <server>");
          return 1;
        }
        log(await mcpLogout(options.home, clients, name));
        return 0;
      }
      default:
        error(`Unknown mcp command "${command}". Use "monchu mcp --help" for usage.`);
        return 1;
    }
  } catch (failure) {
    error(failure instanceof Error ? failure.message : String(failure));
    return 1;
  } finally {
    await clients.close();
  }
}
