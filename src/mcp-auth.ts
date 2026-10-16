import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { McpOAuthConfig } from "./mcp-config.ts";

/** One server's sign-in, keyed by server name and bound to its URL and redirect URI. */
type Stored = {
  url: string;
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
};

/** OAuth settings of one server with `clientSecret` already resolved. */
export type McpOAuthSettings = Omit<McpOAuthConfig, "clientSecret"> & { clientSecret?: string };

/**
 * How a sign-in reaches the user, as in Pi: the authorization URL to show and open, and optionally the URL the browser
 * was redirected to, pasted by the user when the browser cannot reach this machine's loopback callback.
 */
export type McpSignInPrompt = {
  showAuthorizationUrl: (url: string) => void;
  promptForRedirectUrl?: (signal: AbortSignal) => Promise<string | undefined>;
};

const DEFAULT_CALLBACK = "http://127.0.0.1/callback";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raised when a server needs the user to sign in; only `/mcp login` or `monchu mcp login` starts a browser flow. */
export class McpSignInRequired extends Error {}

/**
 * OAuth credentials of remote MCP servers in `<home>/mcp-auth.json` (mode 0600, never synced). Connections send the
 * stored token and refresh it; when a server needs a new sign-in they fail with `McpSignInRequired`, and the user signs
 * in through `/mcp login` or `monchu mcp login`, which run the authorization code flow (PKCE, dynamic client
 * registration or a configured client) against a loopback callback. The file is read on every use, so a sign-in from
 * another process reaches running connections.
 */
export class McpOAuth {
  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.path = join(home, "mcp-auth.json");
  }

  /** The provider a connection uses: stored credentials only, never a browser flow. */
  provider(name: string, url: string, settings: McpOAuthSettings): OAuthClientProvider {
    return this.create(name, url, settings, undefined, undefined);
  }

  /** Forget a server's stored credentials. Resolves whether there were any. */
  async logout(name: string, url: string): Promise<boolean> {
    const stored = (await this.read())[name];
    if (stored?.url !== url || (stored.tokens === undefined && stored.client === undefined))
      return false;
    await this.write((data) => {
      delete data[name];
    });
    return true;
  }

  /**
   * Sign in to a server: start a loopback callback, show the authorization URL, wait for the redirect (or a pasted
   * redirect URL), and store the tokens. Rejects when `signal` aborts.
   */
  async login(
    name: string,
    url: string,
    settings: McpOAuthSettings,
    prompt: McpSignInPrompt,
    signal: AbortSignal,
  ): Promise<void> {
    if (settings.clientRegistration === "cimd")
      throw new Error(
        `${name}: oauth.clientRegistration "cimd" needs a client metadata document Monchu does not publish; use a registered oauth.clientId or dynamic registration`,
      );
    if (settings.authServerMetadataUrl !== undefined)
      throw new Error(`${name}: oauth.authServerMetadataUrl is not supported by Monchu yet`);
    const previous = (await this.read())[name];
    const callback = await listen(
      settings.callbackUrl ?? DEFAULT_CALLBACK,
      settings.callbackPort ??
        (previous?.url === url && previous.redirectUrl !== undefined
          ? Number(new URL(previous.redirectUrl).port)
          : undefined),
      settings.callbackPort !== undefined || settings.callbackUrl !== undefined,
    );
    try {
      const state = randomBytes(16).toString("hex");
      const provider = this.create(name, url, settings, callback.redirectUrl, {
        state,
        open: (authorizationUrl) => prompt.showAuthorizationUrl(authorizationUrl.href),
      });
      const scope = settings.scope === undefined ? {} : { scope: settings.scope };
      if ((await auth(provider, { serverUrl: url, ...scope })) === "AUTHORIZED") return;
      const code = await callback.code(state, signal, prompt.promptForRedirectUrl);
      if (
        (await auth(provider, { serverUrl: url, authorizationCode: code, ...scope })) !==
        "AUTHORIZED"
      )
        throw new Error(`${name} did not authorize`);
    } finally {
      callback.close();
    }
  }

  private create(
    name: string,
    url: string,
    settings: McpOAuthSettings,
    redirect: string | undefined,
    interactive: { state: string; open: (authorizationUrl: URL) => void } | undefined,
  ): OAuthClientProvider {
    const read = () => this.read();
    const update = (change: (stored: Stored) => Stored) => this.update(name, url, change);
    const current = async () => {
      const stored = (await read())[name];
      return stored?.url === url ? stored : undefined;
    };
    const configured: OAuthClientInformationMixed | undefined =
      settings.clientId === undefined
        ? undefined
        : {
            client_id: settings.clientId,
            ...(settings.clientSecret === undefined
              ? {}
              : { client_secret: settings.clientSecret }),
          };
    // A connection refreshes with the redirect URI the client registered; without one it would try client credentials.
    let redirectUrl = redirect;
    return {
      get redirectUrl() {
        return redirectUrl ?? DEFAULT_CALLBACK;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: settings.clientName ?? "Monchu",
          redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method:
            settings.clientSecret === undefined ? "none" : "client_secret_post",
          ...(settings.scope === undefined ? {} : { scope: settings.scope }),
        };
      },
      ...(interactive === undefined ? {} : { state: () => interactive.state }),
      clientInformation: async () => {
        const stored = await current();
        if (redirect === undefined) {
          // Registering a client is part of signing in, which only a login starts.
          if (stored?.tokens === undefined)
            throw new McpSignInRequired(`MCP server ${name} needs sign-in`);
          redirectUrl = stored.redirectUrl;
          return configured ?? stored.client;
        }
        if (configured !== undefined) return configured;
        // A client registered for another callback port cannot use this one.
        return stored?.redirectUrl === redirect ? stored.client : undefined;
      },
      saveClientInformation: (client) =>
        update((stored) => ({
          ...stored,
          client,
          ...(redirectUrl === undefined ? {} : { redirectUrl }),
        })),
      tokens: async () => (await current())?.tokens,
      saveTokens: (tokens) =>
        update((stored) => ({
          ...stored,
          tokens,
          ...(redirectUrl === undefined ? {} : { redirectUrl }),
        })),
      redirectToAuthorization: (authorizationUrl) => {
        if (interactive === undefined)
          throw new McpSignInRequired(`MCP server ${name} needs sign-in`);
        interactive.open(authorizationUrl);
      },
      saveCodeVerifier: (verifier) => update((stored) => ({ ...stored, verifier })),
      codeVerifier: async () => {
        const verifier = (await current())?.verifier;
        if (verifier === undefined) throw new Error(`MCP server ${name} has no pending sign-in`);
        return verifier;
      },
      invalidateCredentials: (scope) =>
        update((stored) => {
          if (scope === "all") return { url };
          const next = { ...stored };
          if (scope === "client") delete next.client;
          if (scope === "tokens") delete next.tokens;
          if (scope === "verifier") delete next.verifier;
          return next;
        }),
    };
  }

  private async read(): Promise<Record<string, Stored>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return {};
    }
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) throw new Error(`Invalid ${this.path}: expected an object`);
    const data: Record<string, Stored> = {};
    for (const [name, entry] of Object.entries(value))
      if (isObject(entry) && typeof entry.url === "string")
        data[name] = {
          url: entry.url,
          ...(typeof entry.redirectUrl === "string" ? { redirectUrl: entry.redirectUrl } : {}),
          // The SDK's own shapes, stored unchanged as it asks; it validates them on use.
          ...(isObject(entry.client) && typeof entry.client.client_id === "string"
            ? { client: { ...entry.client, client_id: entry.client.client_id } }
            : {}),
          ...(isObject(entry.tokens) &&
          typeof entry.tokens.access_token === "string" &&
          typeof entry.tokens.token_type === "string"
            ? {
                tokens: {
                  ...entry.tokens,
                  access_token: entry.tokens.access_token,
                  token_type: entry.tokens.token_type,
                },
              }
            : {}),
          ...(typeof entry.verifier === "string" ? { verifier: entry.verifier } : {}),
        };
    return data;
  }

  /** Change one server's entry; a URL change starts it over. */
  private update(name: string, url: string, change: (stored: Stored) => Stored): Promise<void> {
    return this.write((data) => {
      const stored = data[name];
      data[name] = change(stored?.url === url ? stored : { url });
    });
  }

  /** Writes are serialized within the process and atomic on disk. */
  private write(change: (data: Record<string, Stored>) => void): Promise<void> {
    const next = this.writing.then(async () => {
      const data = await this.read();
      change(data);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      try {
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    this.writing = next.catch(() => {});
    return next;
  }
}

/**
 * A loopback HTTP server for the OAuth redirect at `callback`'s host and path, on `port` (or the URL's own port). A
 * free port is used instead when that one is taken, unless the client was registered with a fixed redirect URI.
 */
async function listen(
  callback: string,
  port: number | undefined,
  fixed: boolean,
): Promise<{
  redirectUrl: string;
  code: (
    state: string,
    signal: AbortSignal,
    paste: McpSignInPrompt["promptForRedirectUrl"],
  ) => Promise<string>;
  close: () => void;
}> {
  const target = new URL(callback);
  const host = target.hostname === "[::1]" ? "::1" : target.hostname;
  const received = Promise.withResolvers<URLSearchParams>();
  void received.promise.catch(() => {});
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== target.pathname) {
      response.writeHead(404).end();
      return;
    }
    const failed = requestUrl.searchParams.has("error");
    response
      .writeHead(failed ? 400 : 200, { "content-type": "text/plain; charset=utf-8" })
      .end(
        failed
          ? "Monchu sign-in failed; you can close this tab."
          : "Monchu is signed in; you can close this tab.",
      );
    received.resolve(requestUrl.searchParams);
  });
  const bind = (candidate: number) =>
    new Promise<Server>((resolve, reject) => {
      server.once("error", reject);
      server.listen(candidate, host, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  const wanted = port ?? (target.port ? Number(target.port) : 0);
  try {
    await bind(wanted);
  } catch (error) {
    if (wanted === 0 || fixed) throw error;
    await bind(0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No callback port");
  target.port = String(address.port);
  return {
    redirectUrl: target.href,
    code: async (state, signal, paste) => {
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("sign-in cancelled"));
          signal.addEventListener("abort", () => reject(new Error("sign-in cancelled")), {
            once: true,
          });
        });
        const pasted =
          paste === undefined
            ? new Promise<never>(() => {})
            : paste(stop.signal).then((value) => {
                if (value === undefined || !URL.canParse(value.trim()))
                  return new Promise<never>(() => {});
                return new URL(value.trim()).searchParams;
              });
        const params = await Promise.race([received.promise, pasted, aborted]);
        const error = params.get("error");
        if (error !== null)
          throw new Error(`sign-in refused: ${params.get("error_description") ?? error}`);
        if (params.get("state") !== state) throw new Error("sign-in state did not match");
        const code = params.get("code");
        if (code === null) throw new Error("sign-in returned no code");
        return code;
      } finally {
        stop.abort();
        signal.removeEventListener("abort", abort);
      }
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
