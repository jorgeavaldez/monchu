/*
Validation and the `mcpServers` shape follow Pi's coding agent
(packages/coding-agent/src/core/mcp-servers.ts and extensions/mcp/config.ts):
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
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * - `codemode` (default): callable from codemode scripts, which find them with `searchTools()`; never declared to the
 *   model. `codemode-deferred` is accepted as an alias.
 * - `deferred`: declared once `tool_search` loads the server's group.
 * - `direct`: declared in every request.
 * - `hidden`: not offered at all.
 */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
const ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

type McpServerBase = {
  /** Default: `codemode`. */
  exposure?: McpExposure;
  /** What the server offers, in a sentence; shown with its group and ranked by tool search. */
  description?: string;
  /** Exposure of single tools by the server's tool name, or a pattern where `*` matches anything. */
  toolExposure?: Record<string, McpExposure>;
  /** `false` keeps the entry without connecting. */
  enabled?: boolean;
  /** Per-request timeout in seconds; progress notifications reset it. Default 60. */
  timeout?: number;
  /**
   * Monchu only: load the server's deferred tools from the start in Claude Code conversations, whose prompt cache a
   * later load would miss. Codex loads them in place, so it still searches.
   */
  preload?: boolean;
};

type McpStdioServer = McpServerBase & {
  type?: "stdio";
  command: string;
  args?: string[];
  /** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
  env?: Record<string, string>;
  cwd?: string;
};

/** OAuth client settings for servers that do not support dynamic client registration. */
export type McpOAuthConfig = {
  clientId?: string;
  /** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
  clientSecret?: string;
  /** Fixed loopback callback port, for clients registered with a fixed redirect URI. */
  callbackPort?: number;
  /** Registered loopback redirect URI, such as `http://localhost:8080/oauth/callback`. */
  callbackUrl?: string;
  /** Scopes to request, separated by spaces. Default: what the server advertises. */
  scope?: string;
  /** `client_name` for dynamic client registration. Default: Monchu. */
  clientName?: string;
  /** Pi's Client ID Metadata Document registration; Monchu has no such document, so only `dcr` works. */
  clientRegistration?: "dcr" | "cimd";
  /** Authorization server metadata to use instead of discovery through the server. */
  authServerMetadataUrl?: string;
};

export type McpHttpServer = McpServerBase & {
  type?: "http" | "streamable-http";
  url: string;
  /** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  /** Send the token of a Monchu `/login` provider instead of using OAuth. */
  auth?: { provider: string };
};

export type McpServerConfig = McpStdioServer | McpHttpServer;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isExposure(value: unknown): value is McpExposure {
  return EXPOSURES.some((exposure) => exposure === value);
}

/** Whether a redirect URI can be served by a loopback callback server. */
function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.search === "" &&
    url.hash === ""
  );
}

/** HTTP servers sign in with OAuth unless they send a provider token or their own `Authorization` header. */
export function usesOAuth(config: McpServerConfig): config is McpHttpServer {
  if (!("url" in config) || config.auth !== undefined) return false;
  return !Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

function toolPattern(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Exposure of one tool: its exact `toolExposure` entry, else the first matching pattern, else the server's. */
export function toolExposure(config: McpServerConfig, tool: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[tool];
  if (exact !== undefined) return exact;
  for (const [pattern, exposure] of Object.entries(overrides))
    if (pattern.includes("*") && toolPattern(pattern).test(tool)) return exposure;
  return config.exposure ?? "codemode";
}

function validateOAuth(value: unknown): McpOAuthConfig | string {
  if (!isRecord(value)) return "oauth must be an object";
  const oauth: McpOAuthConfig = {};
  for (const key of ["clientId", "clientSecret", "scope"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "string") return `oauth.${key} must be a string`;
    oauth[key] = item;
  }
  const port = value.callbackPort;
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      return "oauth.callbackPort must be a port number";
    oauth.callbackPort = port;
  }
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl))
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port)
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    oauth.callbackUrl = value.callbackUrl;
  }
  if (value.clientName !== undefined) {
    if (typeof value.clientName !== "string" || !value.clientName.trim())
      return "oauth.clientName must be a non-empty string";
    oauth.clientName = value.clientName;
  }
  if (value.clientRegistration !== undefined) {
    if (value.clientRegistration !== "dcr" && value.clientRegistration !== "cimd")
      return 'oauth.clientRegistration must be "dcr" or "cimd"';
    oauth.clientRegistration = value.clientRegistration;
  }
  const metadata = value.authServerMetadataUrl;
  if (metadata !== undefined) {
    const url =
      typeof metadata === "string" && URL.canParse(metadata) ? new URL(metadata) : undefined;
    if (
      url === undefined ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
      )
    )
      return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
    oauth.authServerMetadataUrl = url.href;
  }
  return oauth;
}

/** Validate one `mcpServers` entry, Pi's format plus `preload`. Returns the config or an error message. */
export function validateMcpServer(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name))
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const fail = (message: string) => `server "${name}": ${message}`;
  const exposures = EXPOSURES.map((value) => `"${value}"`).join(", ");
  const alias = (value: unknown) => (typeof value === "string" ? (ALIASES[value] ?? value) : value);
  const base: McpServerBase = {};
  if (raw.exposure !== undefined) {
    const exposure = alias(raw.exposure);
    if (!isExposure(exposure)) return fail(`exposure must be one of ${exposures}`);
    base.exposure = exposure;
  }
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure)) return fail("toolExposure must map tool names to exposures");
    const overrides: Record<string, McpExposure> = {};
    for (const [tool, value] of Object.entries(raw.toolExposure)) {
      const exposure = alias(value);
      if (!isExposure(exposure)) return fail(`toolExposure "${tool}" must be one of ${exposures}`);
      overrides[tool] = exposure;
    }
    base.toolExposure = overrides;
  }
  for (const key of ["enabled", "preload"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return fail(`${key} must be a boolean`);
    base[key] = value;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return fail("description must be a string");
    base.description = raw.description;
  }
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "number" || !(raw.timeout > 0))
      return fail("timeout must be a positive number of seconds");
    base.timeout = raw.timeout;
  }
  const type = raw.type;
  if (type === "sse")
    return fail("legacy SSE transport is not supported; use the streamable HTTP URL");
  if (
    typeof raw.url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol))
      return fail("url must be an http or https URL");
    const server: McpHttpServer = {
      ...(type === undefined ? {} : { type }),
      url: raw.url,
      ...base,
    };
    if (raw.headers !== undefined) {
      if (!isStringRecord(raw.headers)) return fail("headers must map names to strings");
      server.headers = raw.headers;
    }
    if (raw.oauth !== undefined) {
      const oauth = validateOAuth(raw.oauth);
      if (typeof oauth === "string") return fail(oauth);
      server.oauth = oauth;
    }
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || !raw.auth.provider)
        return fail("auth.provider must be a provider name");
      const url = new URL(raw.url);
      if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname))
        return fail("auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]");
      server.auth = { provider: raw.auth.provider };
    }
    return server;
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    const server: McpStdioServer = {
      ...(type === undefined ? {} : { type }),
      command: raw.command,
      ...base,
    };
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string"))
        return fail("args must be an array of strings");
      server.args = raw.args;
    }
    if (raw.env !== undefined) {
      if (!isStringRecord(raw.env)) return fail("env must map names to strings");
      server.env = raw.env;
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== "string") return fail("cwd must be a string");
      server.cwd = raw.cwd;
    }
    return server;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** The servers of `<home>/mcp.json` and the entries that failed validation, which are left out. */
export type McpConfig = { servers: Record<string, McpServerConfig>; errors: string[] };

function mcpPath(home: string): string {
  return join(home, "mcp.json");
}

async function readMcpFile(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected a JSON object`);
  return value;
}

/**
 * `<home>/mcp.json`, in the `mcpServers` shape Pi and other MCP clients use, so their entries copy over unchanged. Like
 * Pi, an invalid entry is reported and left out; the other servers still load. A file that is not JSON fails.
 */
export async function loadMcpConfig(home: string): Promise<McpConfig> {
  const path = mcpPath(home);
  const value = await readMcpFile(path);
  if (value === undefined) return { servers: {}, errors: [] };
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];
  const entries = value.mcpServers;
  if (entries !== undefined && !isRecord(entries))
    return { servers, errors: [`${path}: mcpServers must be an object`] };
  for (const [name, raw] of Object.entries(entries ?? {})) {
    const validated = validateMcpServer(name, raw);
    if (typeof validated === "string") errors.push(`${path}: ${validated}`);
    else servers[name] = validated;
  }
  return { servers, errors };
}

/** Rewrite `<home>/mcp.json` with one server changed, keeping every other key as written. */
async function changeMcpFile(
  home: string,
  change: (servers: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const path = mcpPath(home);
  const value = (await readMcpFile(path)) ?? {};
  const servers = isRecord(value.mcpServers) ? { ...value.mcpServers } : {};
  if (!change(servers)) return false;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...value, mcpServers: servers }, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

/** Add or replace a server in `<home>/mcp.json`. Resolves whether one was replaced. */
export async function addMcpServer(
  home: string,
  name: string,
  config: McpServerConfig,
): Promise<boolean> {
  let replaced = false;
  await changeMcpFile(home, (servers) => {
    replaced = name in servers;
    servers[name] = config;
    return true;
  });
  return replaced;
}

/** Remove a server from `<home>/mcp.json`. Resolves whether it was there. */
export function removeMcpServer(home: string, name: string): Promise<boolean> {
  return changeMcpFile(home, (servers) => {
    if (!(name in servers)) return false;
    delete servers[name];
    return true;
  });
}
