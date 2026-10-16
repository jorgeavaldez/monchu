import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "./config.ts";
import { McpOAuth, McpSignInRequired } from "./mcp-auth.ts";

/** HTTP servers sign in with OAuth unless their configured headers already authorize them. */
export function usesOAuth(config: McpServerConfig): boolean {
  return (
    config.url !== undefined &&
    !Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization")
  );
}

/** A tool as a server lists it, kept in the cache file. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

/** A server's `tools/list` and `initialize` instructions. */
export type McpListing = { tools: McpTool[]; instructions?: string };

/** One content block of a tool result, as Monchu passes it to the model. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Close a server that has had no call for this long; Android kills Termux when it runs too many processes. */
const IDLE_MS = 5 * 60_000;
/** Long enough for a crawl; progress notifications restart it. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

type Connection = {
  fingerprint: string;
  client: Promise<Client>;
  calls: number;
  idle: NodeJS.Timeout | undefined;
  /** The tail of a stdio server's stderr, for error messages. */
  stderr: { text: string };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifies a configuration without storing its values, which may name secrets. */
function fingerprint(config: McpServerConfig): string {
  const { command, args, env, cwd, url, headers } = config;
  return createHash("sha256")
    .update(JSON.stringify({ command, args, env, cwd, url, headers }))
    .digest("hex")
    .slice(0, 16);
}

/** Server output worth showing with an error: the last few lines. */
function tail(stderr: { text: string }): string {
  return stderr.text.trim().split("\n").slice(-5).join("\n");
}

function listing(value: unknown): McpListing | undefined {
  if (!isObject(value) || !Array.isArray(value.tools)) return undefined;
  const tools: McpTool[] = [];
  for (const tool of value.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !isObject(tool.inputSchema))
      return undefined;
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly === true,
    });
  }
  return {
    tools,
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

/** MCP result content as model content: text and images pass through, other blocks become text. */
function content(blocks: unknown): McpContent[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block): McpContent => {
    if (!isObject(block)) return { type: "text", text: JSON.stringify(block) };
    if (block.type === "text" && typeof block.text === "string")
      return { type: "text", text: block.text };
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      return { type: "image", data: block.data, mimeType: block.mimeType };
    if (block.type === "resource_link" && typeof block.uri === "string")
      return {
        type: "text",
        text: `${typeof block.name === "string" ? `${block.name}: ` : ""}${block.uri}`,
      };
    if (block.type === "resource" && isObject(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      return { type: "text", text: `[binary resource ${String(resource.uri)}]` };
    }
    return { type: "text", text: `[${String(block.type)} content omitted]` };
  });
}

/**
 * The HTTP transport as the client's `Transport`. Its `sessionId` getter may be undefined, which the interface's
 * optional property does not allow under `exactOptionalPropertyTypes`, so this delegates instead.
 */
function httpTransport(inner: StreamableHTTPClientTransport): Transport {
  const transport: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion(version),
  };
  inner.onclose = () => transport.onclose?.();
  inner.onerror = (error) => transport.onerror?.(error);
  inner.onmessage = (message: JSONRPCMessage) => transport.onmessage?.(message);
  return transport;
}

/**
 * The MCP servers of one Monchu process: one shared connection per server, opened on first use and closed when idle
 * or on shutdown, and a cache of each server's tool list in `<home>/mcp-tools.json`. Host code: connections outlive
 * reloads, and tool definitions are built from the cache so a startup or reload spawns no server it has listed before.
 */
export class McpClients {
  private readonly cachePath: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly report: (warning: string) => void;
  private readonly oauth: McpOAuth;
  private readonly connections = new Map<string, Connection>();
  /** Servers whose live listing was compared with the cache in this process. */
  private readonly checked = new Set<string>();
  private cache: Promise<Record<string, { fingerprint: string } & McpListing>> | undefined;
  private closed = false;

  constructor(
    home: string,
    env: Readonly<Record<string, string | undefined>>,
    report: (warning: string) => void,
  ) {
    this.cachePath = join(home, "mcp-tools.json");
    this.oauth = new McpOAuth(home);
    this.env = env;
    this.report = report;
  }

  /** The cached listing of a server, or a live one, which is then cached. */
  async listing(name: string, config: McpServerConfig): Promise<McpListing> {
    const cached = (await this.readCache())[name];
    if (cached?.fingerprint === fingerprint(config)) return cached;
    return this.refresh(name, config);
  }

  async call(
    name: string,
    config: McpServerConfig,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: McpContent[]; isError: boolean }> {
    const connection = this.connect(name, config);
    connection.calls++;
    if (connection.idle !== undefined) clearTimeout(connection.idle);
    connection.idle = undefined;
    try {
      const client = await connection.client;
      if (!this.checked.has(name)) void this.check(name, config, client);
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        ...(signal === undefined ? {} : { signal }),
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      });
      const blocks = content(result.content);
      if (blocks.length === 0 && result.structuredContent !== undefined)
        blocks.push({ type: "text", text: JSON.stringify(result.structuredContent) });
      return { content: blocks, isError: result.isError === true };
    } catch (error) {
      const detail = tail(connection.stderr);
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}${detail ? `\nServer stderr:\n${detail}` : ""}`,
        { cause: error },
      );
    } finally {
      connection.calls--;
      if (connection.calls === 0 && this.connections.get(name) === connection)
        connection.idle = setTimeout(() => void this.disconnect(name, connection), IDLE_MS).unref();
    }
  }

  /** Sign in to an OAuth server through the browser, then list its tools again. */
  async login(
    name: string,
    config: McpServerConfig,
    open: (authorizationUrl: string) => void,
    signal: AbortSignal,
  ): Promise<McpListing> {
    if (config.url === undefined || !usesOAuth(config))
      throw new Error(`MCP server ${name} does not sign in with OAuth`);
    await this.oauth.login(name, config.url, open, signal);
    const existing = this.connections.get(name);
    if (existing !== undefined) await this.disconnect(name, existing);
    return this.refresh(name, config);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.connections.entries()].map(([name, connection]) =>
        this.disconnect(name, connection),
      ),
    );
  }

  /** List a server now and cache the result. */
  private async refresh(name: string, config: McpServerConfig): Promise<McpListing> {
    const connection = this.connect(name, config);
    try {
      const client = await connection.client;
      const listed = await this.list(client);
      this.checked.add(name);
      await this.writeCache(name, config, listed);
      return listed;
    } catch (error) {
      await this.disconnect(name, connection);
      const detail = tail(connection.stderr);
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT" && config.command
          ? `${config.command} is not installed or not on PATH here, so ${name}'s tools are off on this device`
          : undefined;
      if (
        error instanceof McpSignInRequired ||
        (error instanceof Error && error.cause instanceof McpSignInRequired)
      )
        throw new McpSignInRequired(
          `MCP server ${name} needs sign-in: run /login and pick ${name}`,
          {
            cause: error,
          },
        );
      throw new Error(
        missing ??
          `MCP server ${name} did not list its tools: ${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`,
        { cause: error },
      );
    } finally {
      if (connection.calls === 0 && this.connections.get(name) === connection)
        connection.idle ??= setTimeout(
          () => void this.disconnect(name, connection),
          IDLE_MS,
        ).unref();
    }
  }

  /** On the first call of a process, notice a server whose tools changed since they were cached. */
  private async check(name: string, config: McpServerConfig, client: Client): Promise<void> {
    this.checked.add(name);
    try {
      const listed = await this.list(client);
      const cached = (await this.readCache())[name];
      const same = (value: McpListing | undefined) =>
        JSON.stringify(value && { tools: value.tools, instructions: value.instructions });
      if (same(listed) === same(cached)) return;
      await this.writeCache(name, config, listed);
      this.report(`MCP server ${name} changed its tools; /reload or /restart to use them`);
    } catch {
      // The call itself reports a broken server.
    }
  }

  private async list(client: Client): Promise<McpListing> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      for (const tool of page.tools)
        tools.push({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: { ...tool.inputSchema },
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const instructions = client.getInstructions();
    return { tools, ...(instructions === undefined ? {} : { instructions }) };
  }

  private connect(name: string, config: McpServerConfig): Connection {
    if (this.closed) throw new Error("Monchu is closing");
    const key = fingerprint(config);
    const existing = this.connections.get(name);
    if (existing?.fingerprint === key) return existing;
    if (existing !== undefined) void this.disconnect(name, existing);
    const stderr = { text: "" };
    const connection: Connection = {
      fingerprint: key,
      client: (async () => {
        const client = new Client({ name: "monchu", version: "1.0.0" });
        const transport = this.transport(name, config, stderr);
        // A server that exits drops its connection; the next call starts it again.
        transport.onclose = () => {
          if (this.connections.get(name) === connection) this.connections.delete(name);
        };
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        return client;
      })(),
      calls: 0,
      idle: undefined,
      stderr,
    };
    // Rejections reach every caller; this keeps an unused failure from being unhandled.
    connection.client.catch(() => {
      if (this.connections.get(name) === connection) this.connections.delete(name);
    });
    this.connections.set(name, connection);
    return connection;
  }

  private transport(name: string, config: McpServerConfig, stderr: { text: string }): Transport {
    const expand = (values: Record<string, string> | undefined) =>
      Object.fromEntries(
        Object.entries(values ?? {}).map(([key, value]) => [
          key,
          value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
            const resolved = this.env[variable];
            if (resolved === undefined) throw new Error(`${key} uses unset variable ${variable}`);
            return resolved;
          }),
        ]),
      );
    if (config.url !== undefined)
      return httpTransport(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: expand(config.headers) },
          ...(usesOAuth(config) ? { authProvider: this.oauth.provider(name, config.url) } : {}),
        }),
      );
    if (config.command === undefined) throw new Error("MCP server needs command or url");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) if (value !== undefined) env[key] = value;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...env, ...expand(config.env) },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      // Inherited stderr would write over the terminal UI; keep its tail for error messages.
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr.text = (stderr.text + chunk.toString()).slice(-4000);
    });
    return transport;
  }

  private async disconnect(name: string, connection: Connection): Promise<void> {
    if (connection.idle !== undefined) clearTimeout(connection.idle);
    connection.idle = undefined;
    if (this.connections.get(name) === connection) this.connections.delete(name);
    try {
      await (await connection.client).close();
    } catch {
      // A connection that never opened has nothing to close.
    }
  }

  private readCache(): Promise<Record<string, { fingerprint: string } & McpListing>> {
    this.cache ??= (async () => {
      let raw: string;
      try {
        raw = await readFile(this.cachePath, "utf8");
      } catch {
        return {};
      }
      const cache: Record<string, { fingerprint: string } & McpListing> = {};
      try {
        const value: unknown = JSON.parse(raw);
        if (isObject(value))
          for (const [name, entry] of Object.entries(value)) {
            const parsed = listing(entry);
            if (parsed !== undefined && isObject(entry) && typeof entry.fingerprint === "string")
              cache[name] = { fingerprint: entry.fingerprint, ...parsed };
          }
      } catch {
        // A damaged cache is rebuilt from the servers.
      }
      return cache;
    })();
    return this.cache;
  }

  private async writeCache(name: string, config: McpServerConfig, listed: McpListing) {
    const cache = {
      ...(await this.readCache()),
      [name]: { fingerprint: fingerprint(config), ...listed },
    };
    this.cache = Promise.resolve(cache);
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, this.cachePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
