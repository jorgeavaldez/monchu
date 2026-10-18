/**
 * A client for a browser farm: a service that runs Camoufox browsers for agents, with owned sessions, shared logins and
 * a handoff page for the user (its HTTP API is documented with the farm). Where it is and how to reach it come from the
 * device's `<home>/browser-farm.json`, never synced:
 *
 *   { "url": "https://browser.example.com", "token": "${BROWSER_FARM_TOKEN}",
 *     "headers": { "cf-access-client-id": "${CF_ACCESS_CLIENT_ID}" } }
 *
 * `${NAME}` is a Monchu secret of that name, else the environment variable; other text is taken as is. Requests use
 * fetch; the event stream uses node:http(s), since undici stalls later requests to an origin while one streams.
 */
import type { Context } from "@earendil-works/chord";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { Vault } from "../secrets/vault.ts";

export const FARM_FILE = "browser-farm.json";

export type FarmConfig = {
  url: string;
  token: string;
  headers: Record<string, string>;
};

const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The device's farm, or `undefined` when it has none. A file that is there but wrong throws, naming the field. */
export async function loadFarmConfig(home: string): Promise<FarmConfig | undefined> {
  const path = join(home, FARM_FILE);
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
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  const { url, token, headers } = value;
  if (typeof url !== "string" || !/^https?:\/\/[^/]/.test(url))
    throw new Error(`${path}: url must be the farm's http(s) URL`);
  if (typeof token !== "string" || token === "") throw new Error(`${path}: token is required`);
  const extra: Record<string, string> = {};
  if (headers !== undefined) {
    if (!isObject(headers)) throw new Error(`${path}: headers must be an object of strings`);
    for (const [name, header] of Object.entries(headers)) {
      if (typeof header !== "string") throw new Error(`${path}: headers.${name} must be a string`);
      extra[name.toLowerCase()] = header;
    }
  }
  return { url: url.replace(/\/+$/, ""), token, headers: extra };
}

export class FarmError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(code: string, status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** A farm event as the stream sends it. */
export type FarmEvent = { id: string; type: string; data: Record<string, unknown> };

/** Who is calling, for the secrets audit: the tool and the conversation's short id. */
export type FarmUse = { tool: string; conversation: string };

const Tab = Type.Object({ id: Type.String(), url: Type.String(), title: Type.String() });
export const Session = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  label: Type.String(),
  yours: Type.Boolean(),
  profile: Type.String(),
  phase: Type.Union([Type.Literal("starting"), Type.Literal("agent"), Type.Literal("human")]),
  created: Type.String(),
  idleSeconds: Type.Number(),
  memoryMb: Type.Optional(Type.Number()),
  tabs: Type.Array(Tab),
  handoff: Type.Optional(
    Type.Object({
      reason: Type.String(),
      since: Type.String(),
      link: Type.Optional(Type.String()),
    }),
  ),
});
export const Sessions = Type.Object({
  boot: Type.String(),
  client: Type.String(),
  sessions: Type.Array(Session),
});
export const Page = Type.Object({
  tab: Type.String(),
  url: Type.String(),
  title: Type.String(),
  snapshot: Type.Number(),
  text: Type.String(),
  more: Type.Union([Type.Number(), Type.Null()]),
  chars: Type.Number(),
  changed: Type.Optional(Type.Object({ removed: Type.Number() })),
  found: Type.Optional(Type.Object({ query: Type.String(), matches: Type.Number() })),
  result: Type.Optional(Type.Unknown()),
  note: Type.Optional(Type.String()),
});
export const Closed = Type.Object({
  closed: Type.Literal(true),
  session: Type.Optional(Type.String()),
  tab: Type.Optional(Type.String()),
  saved: Type.Optional(Type.Array(Type.String())),
  warning: Type.Optional(Type.String()),
  tabs: Type.Optional(Type.Array(Tab)),
});

export type SessionView = Static<typeof Session>;
export type PageView = Static<typeof Page>;

export class Farm {
  readonly config: FarmConfig;
  private readonly vault: Vault;
  constructor(config: FarmConfig, vault: Vault) {
    this.config = config;
    this.vault = vault;
  }

  /** The token and headers with their references resolved; an unknown name throws, naming it but no value. */
  private async credentials(use: FarmUse): Promise<Record<string, string>> {
    const entries: [string, string][] = [
      ["authorization", this.config.token],
      ...Object.entries(this.config.headers),
    ];
    const out: Record<string, string> = {};
    for (const [name, raw] of entries) {
      const match = REFERENCE.exec(raw);
      let value = raw;
      if (match?.[1] !== undefined) {
        const key = match[1];
        if ((await this.vault.owner(key)) !== undefined)
          value = (await this.vault.resolve([key], use))[key] ?? "";
        else value = process.env[key] ?? "";
        if (value === "")
          throw new FarmError(
            "farm_unreachable",
            0,
            `${FARM_FILE} names \${${key}} for ${name === "authorization" ? "the farm token" : `the ${name} header`}, and it is neither a Monchu secret nor in the environment`,
          );
      }
      out[name] = name === "authorization" ? `Bearer ${value}` : value;
    }
    return out;
  }

  /** One API call; `owner` names the agent making it. Errors carry the farm's code and next step. */
  async call<S extends TSchema>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: S,
    options: { owner?: string; body?: Record<string, unknown>; timeoutMs?: number; use: FarmUse },
  ): Promise<Static<S>> {
    const headers = {
      ...(await this.credentials(options.use)),
      ...(options.owner === undefined ? {} : { "farm-owner": options.owner }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    };
    let response: Response;
    try {
      response = await fetch(this.config.url + path, {
        method,
        headers,
        redirect: "manual",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      if (timedOut && method !== "GET")
        throw new FarmError(
          "uncertain",
          0,
          `the farm did not answer in time; the action may have happened: take a snapshot before trying again, never repeat it blindly`,
        );
      throw new FarmError(
        "farm_unreachable",
        0,
        `the farm at ${this.config.url} is not reachable (${timedOut ? "timed out" : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)})`,
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new FarmError(
        "farm_unreachable",
        response.status,
        `the farm at ${this.config.url} redirected to a sign-in: its access proxy refused the headers in ${FARM_FILE}`,
      );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      if (isObject(parsed) && typeof parsed.error === "string")
        throw new FarmError(
          parsed.error === "unauthorized" ? "farm_unreachable" : parsed.error,
          response.status,
          parsed.error === "unauthorized"
            ? `the farm refused the token in ${FARM_FILE}`
            : typeof parsed.message === "string"
              ? parsed.message
              : parsed.error,
          parsed,
        );
      throw new FarmError(
        response.status === 403 ? "farm_unreachable" : "browser_error",
        response.status,
        `the farm at ${this.config.url} answered ${response.status}${response.status === 403 ? ": its access proxy refused the headers" : ""}`,
      );
    }
    if (!Check(schema, parsed))
      throw new FarmError(
        "browser_error",
        response.status,
        `the farm's answer to ${method} ${path} has an unexpected shape`,
      );
    return parsed;
  }

  /** A tab's screenshot as PNG bytes. */
  async screenshot(tab: string, owner: string, use: FarmUse): Promise<Buffer> {
    const response = await fetch(
      `${this.config.url}/v1/tabs/${encodeURIComponent(tab)}/screenshot`,
      {
        headers: { ...(await this.credentials(use)), "farm-owner": owner },
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/"))
      throw new FarmError(
        "browser_error",
        response.status,
        `the screenshot failed (${response.status})`,
      );
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Follows the event stream until `onEvent` returns true, the stream ends, or `context` aborts. Resolves `true` when
   * `onEvent` asked to stop, `false` when the stream ended or failed (the caller decides whether to reconnect).
   * `onOpen` runs once the stream is connected, so a caller can check state it may have missed.
   */
  async events(
    onEvent: (event: FarmEvent) => boolean,
    onOpen: () => Promise<boolean>,
    use: FarmUse,
    context: Context,
  ): Promise<boolean> {
    const headers = await this.credentials(use);
    const url = new URL(`${this.config.url}/v1/events`);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (stopped: boolean) => {
        if (done) return;
        done = true;
        context.abortSignal?.removeEventListener("abort", abort);
        req.destroy();
        resolve(stopped);
      };
      const abort = () => finish(false);
      const req = request(
        url,
        { method: "GET", headers: { ...headers, accept: "text/event-stream" } },
        (res: IncomingMessage) => {
          if (res.statusCode !== 200) return finish(false);
          res.setEncoding("utf8");
          let buffer = "";
          let opened = false;
          res.on("data", (chunk: string) => {
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              let id = "";
              let type = "message";
              let data = "";
              for (const line of block.split("\n")) {
                if (line.startsWith("id: ")) id = line.slice(4);
                else if (line.startsWith("event: ")) type = line.slice(7);
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (type === "hello" && !opened) {
                opened = true;
                void onOpen().then(
                  (stop) => stop && finish(true),
                  () => finish(false),
                );
                continue;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(data);
              } catch {
                continue;
              }
              if (isObject(parsed) && onEvent({ id, type, data: parsed })) return finish(true);
            }
          });
          res.on("end", () => finish(false));
          res.on("error", () => finish(false));
        },
      );
      req.on("error", () => finish(false));
      req.end();
      if (context.abortSignal?.aborted) finish(false);
      else context.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}
