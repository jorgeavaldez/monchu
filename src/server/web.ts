/**
 * The web client's server: 127.0.0.1 only, published by a tunnel on the same host. Any local process can reach it, so
 * nothing is trusted for being local: every request, the WebSocket included, needs an allowed identity, the Host must
 * be the configured public host or this port's localhost, and the WebSocket's Origin must match it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebConfig } from "../core/config.ts";
import type { Log } from "../telemetry/log.ts";
import { WebAuth } from "./auth.ts";
import type { Ingress } from "./host.ts";

/** The built web client, in the package beside `dist/main.js` and from a checkout alike. */
const ASSETS = fileURLToPath(new URL("../../dist/web/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

/** The app's name when this device hasn't named its own. */
const DEFAULT_NAME = "Monchu";

/**
 * This device's client settings, in `<home>/web-client.json` beside `web.json`: per device, so each Monchu installed
 * from its own host (the phone's, a dev box's) can carry its own name.
 */
type ClientSettings = { name?: string };

function clientSettings(value: unknown): ClientSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Client settings must be an object");
  const name = "name" in value ? value.name : undefined;
  if (name === undefined) return {};
  if (typeof name !== "string") throw new Error("The name must be text");
  const trimmed = name.trim();
  if (trimmed.length > 30) throw new Error("The name is longer than 30 characters");
  // Control characters have no place in a home screen label.
  if (/\p{Cc}/u.test(trimmed)) throw new Error("The name has control characters");
  return trimmed === "" || trimmed === DEFAULT_NAME ? {} : { name: trimmed };
}

async function loadClientSettings(path: string): Promise<ClientSettings> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return {};
  try {
    return clientSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function saveClientSettings(path: string, settings: ClientSettings): Promise<void> {
  if (settings.name === undefined) return rm(path, { force: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temporary, path);
}

/** The install manifest, named for this device. */
function manifest(settings: ClientSettings): string {
  const name = settings.name ?? DEFAULT_NAME;
  return JSON.stringify({
    id: "/",
    name,
    short_name: name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  });
}

/** A request body, up to `limit` bytes. */
async function body(request: IncomingMessage, limit: number): Promise<string> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > limit) throw new Error("Too large");
  }
  return text;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The request's sign-in session cookie, if it has one. */
function sessionToken(request: IncomingMessage): string | undefined {
  return (header(request, "cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("monchu_session="))
    ?.slice("monchu_session=".length);
}

export async function serveWeb(
  ingress: Ingress,
  { home, log: logs }: { home: string; log: Log },
  config: WebConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const auth = new WebAuth(config, home, env);
  const settingsPath = join(home, "web-client.json");
  const local = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const hosts = new Set([...(config.host === undefined ? [] : [config.host]), ...local]);
  const origins = new Set([
    ...(config.host === undefined ? [] : [`https://${config.host}`]),
    ...local.map((host) => `http://${host}`),
  ]);
  const log = (
    severity: "info" | "warn",
    body: string,
    attributes?: Record<string, string | number>,
  ) => logs.write(severity, "server.web", body, attributes);

  /** The request's allowed identities, or a response already sent. */
  async function guard(request: IncomingMessage, response: ServerResponse | undefined) {
    const identities = await auth.identify(
      header(request, "cf-access-jwt-assertion"),
      header(request, "cookie"),
    );
    if (identities !== undefined && identities !== false) return identities;
    log("warn", identities === false ? "refused" : "not signed in", { path: request.url ?? "" });
    if (response === undefined) return undefined;
    const navigation =
      request.method === "GET" && (header(request, "accept") ?? "").includes("text/html");
    if (identities === undefined && navigation && auth.oidc)
      send(response, 302, "", { location: "/auth/login" });
    else
      send(
        response,
        identities === false ? 403 : 401,
        identities === false ? "Not allowed" : "Sign in first",
      );
    return undefined;
  }

  async function asset(response: ServerResponse, path: string): Promise<void> {
    const relative = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
    if (relative.split(sep).includes("..")) return send(response, 400, "Bad path");
    let file = join(ASSETS, relative || "index.html");
    // Client routes are the app's: anything without an extension gets the shell.
    if (!extname(file)) file = join(ASSETS, "index.html");
    const found = await stat(file).catch(() => undefined);
    if (found?.isFile() !== true)
      return send(
        response,
        extname(path) ? 404 : 503,
        extname(path) ? "Not found" : "The web client is not built",
      );
    // Hashed assets never change; the shell and the service worker must be refetched.
    const immutable = /\.[0-9A-Z]{8}\.(js|css)$/i.test(file);
    response.writeHead(200, {
      ...SECURITY,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    response.end(await readFile(file));
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (!hosts.has(header(request, "host") ?? "")) return send(response, 421, "Unknown host");
      const url = new URL(request.url ?? "/", "http://localhost");
      const publicHost = header(request, "host") === config.host;
      const callback = `${publicHost ? "https" : "http"}://${header(request, "host") ?? ""}/auth/callback`;
      if (url.pathname === "/auth/login" && request.method === "GET") {
        if (!auth.oidc) return send(response, 404, "No login here");
        return send(response, 302, "", { location: await auth.loginUrl(callback) });
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        try {
          const token = await auth.callback(
            url.searchParams.get("state") ?? "",
            url.searchParams.get("code") ?? "",
          );
          log("info", "signed in");
          return send(response, 302, "", {
            location: "/",
            "set-cookie": `monchu_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86_400}`,
          });
        } catch (error) {
          log("warn", "sign-in failed", { reason: error instanceof Error ? error.message : "" });
          return send(response, 403, error instanceof Error ? error.message : "Sign-in failed");
        }
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        if (!origins.has(header(request, "origin") ?? "")) return send(response, 403, "Bad origin");
        const token = sessionToken(request);
        await auth.logout(token);
        // Signed out means its open sockets go too: their objects are disposed and their links close.
        for (const connection of token === undefined ? [] : (signedIn.get(token) ?? []))
          await ingress.revoke(connection);
        if (token !== undefined) signedIn.delete(token);
        return send(response, 204, "", {
          "set-cookie": "monchu_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        });
      }
      const identities = await guard(request, response);
      if (identities === undefined) return;
      if (url.pathname === "/manifest.webmanifest" && request.method === "GET")
        return send(response, 200, manifest(await loadClientSettings(settingsPath)), {
          "content-type": "application/manifest+json",
        });
      if (url.pathname === "/client.json") {
        const person = !identities.some((identity) => identity.startsWith("service:"));
        if (request.method === "PUT") {
          // Only the person's own page changes how this device's app is named.
          if (!origins.has(header(request, "origin") ?? ""))
            return send(response, 403, "Bad origin");
          if (!person)
            return send(response, 403, "Only a person's login can change client settings");
          let settings;
          try {
            settings = clientSettings(JSON.parse(await body(request, 1024)));
          } catch (error) {
            return send(response, 400, error instanceof Error ? error.message : "Bad settings");
          }
          await saveClientSettings(settingsPath, settings);
          log("info", "client settings saved");
        } else if (request.method !== "GET") return send(response, 405, "Method not allowed");
        const settings = await loadClientSettings(settingsPath);
        return send(
          response,
          200,
          JSON.stringify({ name: settings.name ?? DEFAULT_NAME, editable: person }),
          { "content-type": "application/json" },
        );
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return send(response, 405, "Method not allowed");
      await asset(response, url.pathname);
    })().catch((error: unknown) => {
      log("warn", "request failed", { reason: error instanceof Error ? error.message : "" });
      if (!response.headersSent) send(response, 500, "Failed");
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  let next = 1;
  /** The connections each sign-in session opened, so signing out closes them. */
  const signedIn = new Map<string, Set<string>>();
  server.on("upgrade", (request, socket, head) => {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
    };
    void (async () => {
      if (!hosts.has(header(request, "host") ?? "")) return refuse(421);
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api") return refuse(404);
      // A page from anywhere else must never drive the core with this browser's credentials.
      if (!origins.has(header(request, "origin") ?? "")) return refuse(403);
      const identities = await guard(request, undefined);
      if (identities === undefined) return refuse(401);
      sockets.handleUpgrade(request, socket, head, (connection) => {
        connection.on("error", () => {});
        const attached = performance.now();
        log("info", "client attached", { clients: sockets.clients.size });
        const principal = {
          kind: "client" as const,
          connection: `w${next++}`,
          person: !identities.some((identity) => identity.startsWith("service:")),
        };
        const token = sessionToken(request);
        if (token !== undefined)
          signedIn.set(token, (signedIn.get(token) ?? new Set()).add(principal.connection));
        void ingress.accept(connection, principal).then((reason) => {
          if (token !== undefined) signedIn.get(token)?.delete(principal.connection);
          log("info", "client left", {
            clients: sockets.clients.size,
            ms: Math.round(performance.now() - attached),
            reason,
          });
        });
      });
    })().catch(() => refuse(500));
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  return {
    url: `http://127.0.0.1:${config.port}/`,
    close: () =>
      new Promise<void>((done) => {
        for (const client of sockets.clients) client.close(1012, "Monchu is restarting");
        sockets.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
