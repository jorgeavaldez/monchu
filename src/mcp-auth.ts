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

/** One server's sign-in, keyed by server name and bound to its URL and redirect URI. */
type Stored = {
  url: string;
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
};

const CALLBACK_PATH = "/callback";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raised when a server needs the user to sign in; only `/login` starts a browser flow. */
export class McpSignInRequired extends Error {}

/**
 * OAuth credentials of remote MCP servers in `<home>/mcp-auth.json` (mode 0600, never synced). Connections send the
 * stored token and refresh it; when a server needs a new sign-in they fail with `McpSignInRequired`, and the user signs in
 * through `/login`, which runs the authorization code flow (PKCE, dynamic client registration) against a loopback
 * callback.
 */
export class McpOAuth {
  private readonly path: string;
  private data: Promise<Record<string, Stored>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.path = join(home, "mcp-auth.json");
  }

  /** The provider a connection uses: stored credentials only, never a browser flow. */
  provider(name: string, url: string): OAuthClientProvider {
    return this.create(name, url, undefined, undefined);
  }

  /** Whether the server has stored tokens for this URL. */
  async signedIn(name: string, url: string): Promise<boolean> {
    const stored = (await this.read())[name];
    return stored?.url === url && stored.tokens !== undefined;
  }

  /**
   * Sign in to a server: start a loopback callback, hand the authorization URL to `open`, wait for the redirect, and
   * store the tokens. Rejects when `signal` aborts.
   */
  async login(
    name: string,
    url: string,
    open: (authorizationUrl: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const previous = (await this.read())[name];
    const callback = await listen(
      previous?.url === url && previous.redirectUrl !== undefined
        ? Number(new URL(previous.redirectUrl).port)
        : 0,
    );
    try {
      const state = randomBytes(16).toString("hex");
      const provider = this.create(name, url, callback.redirectUrl, {
        state,
        open: (authorizationUrl) => open(authorizationUrl.href),
      });
      const result = await auth(provider, { serverUrl: url });
      if (result === "AUTHORIZED") return;
      const code = await callback.code(state, signal);
      if ((await auth(provider, { serverUrl: url, authorizationCode: code })) !== "AUTHORIZED")
        throw new Error(`${name} did not authorize`);
    } finally {
      callback.close();
    }
  }

  private create(
    name: string,
    url: string,
    redirect: string | undefined,
    interactive: { state: string; open: (authorizationUrl: URL) => void } | undefined,
  ): OAuthClientProvider {
    const read = () => this.read();
    const update = (change: (stored: Stored) => Stored) => this.update(name, url, change);
    const current = async () => {
      const stored = (await read())[name];
      return stored?.url === url ? stored : undefined;
    };
    // A connection refreshes with the redirect URI the client registered; without one it would try client credentials.
    let redirectUrl = redirect;
    const metadata = (): OAuthClientMetadata => ({
      client_name: "Monchu",
      redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    return {
      get redirectUrl() {
        return redirectUrl ?? `http://127.0.0.1${CALLBACK_PATH}`;
      },
      get clientMetadata() {
        return metadata();
      },
      ...(interactive === undefined ? {} : { state: () => interactive.state }),
      clientInformation: async () => {
        const stored = await current();
        if (redirect === undefined) {
          // Registering a client is part of signing in, which only `/login` starts.
          if (stored?.client === undefined || stored.tokens === undefined)
            throw new McpSignInRequired(`MCP server ${name} needs sign-in: run /login`);
          redirectUrl = stored.redirectUrl;
          return stored.client;
        }
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
      saveTokens: (tokens) => update((stored) => ({ ...stored, tokens })),
      redirectToAuthorization: (authorizationUrl) => {
        if (interactive === undefined)
          throw new McpSignInRequired(`MCP server ${name} needs sign-in: run /login`);
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

  private read(): Promise<Record<string, Stored>> {
    this.data ??= (async () => {
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
    })();
    return this.data;
  }

  /** Change one server's entry; a URL change starts it over. Writes are serialized and atomic. */
  private update(name: string, url: string, change: (stored: Stored) => Stored): Promise<void> {
    const next = this.writing.then(async () => {
      const data = await this.read();
      const stored = data[name];
      data[name] = change(stored?.url === url ? stored : { url });
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

/** A loopback HTTP server for the OAuth redirect, on `port` when free, else any port. */
async function listen(port: number): Promise<{
  redirectUrl: string;
  code: (state: string, signal: AbortSignal) => Promise<string>;
  close: () => void;
}> {
  const received = Promise.withResolvers<URLSearchParams>();
  void received.promise.catch(() => {});
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== CALLBACK_PATH) {
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
  const bound = (candidate: number) =>
    new Promise<Server>((resolve, reject) => {
      server.once("error", reject);
      server.listen(candidate, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  try {
    await bound(port);
  } catch (error) {
    if (port === 0) throw error;
    await bound(0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No callback port");
  return {
    redirectUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    code: async (state, signal) => {
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("sign-in cancelled"));
        signal.addEventListener("abort", () => reject(new Error("sign-in cancelled")), {
          once: true,
        });
      });
      const params = await Promise.race([received.promise, aborted]);
      const error = params.get("error");
      if (error !== null)
        throw new Error(`sign-in refused: ${params.get("error_description") ?? error}`);
      if (params.get("state") !== state) throw new Error("sign-in state did not match");
      const code = params.get("code");
      if (code === null) throw new Error("sign-in returned no code");
      return code;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
