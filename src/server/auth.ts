/**
 * Who a web request is: an identity-aware proxy's signed JWT (Cloudflare Access sends `Cf-Access-Jwt-Assertion`), or a
 * session from this server's own OpenID Connect login (authorization code with PKCE). Both are generic: the issuer,
 * audience and claims come from `config.json`. Either way the identity must be on `web.allow`.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { WebConfig } from "../core/config.ts";

const SESSION_DAYS = 7;
const PENDING_MS = 10 * 60_000;

/** A claim by dotted path, as a string, or `undefined`. */
function claim(payload: JWTPayload, path: string): string | undefined {
  let value: unknown = payload;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Object.fromEntries(Object.entries(value))[key];
  }
  return typeof value === "string" && value ? value : undefined;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");

/** The identities a token proves, as `web.allow` writes them. */
export type Identities = string[];

type Discovery = {
  authorization: string;
  token: string;
  keys: ReturnType<typeof createRemoteJWKSet>;
  endSession: string | undefined;
};

export class WebAuth {
  private readonly config: WebConfig;
  private readonly sessionsPath: string;
  private readonly accessKeys: ReturnType<typeof createRemoteJWKSet> | undefined;
  private discovery: Promise<Discovery> | undefined;
  private sessions: Map<string, { identities: Identities; expires: number }> | undefined;
  private readonly pending = new Map<
    string,
    { verifier: string; nonce: string; redirect: string; expires: number }
  >();
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(config: WebConfig, home: string, env: Readonly<Record<string, string | undefined>>) {
    if (config.access === undefined && config.oidc === undefined)
      throw new Error(
        "web needs a login: set web.access (an identity-aware proxy) or web.oidc in config.json",
      );
    if (config.allow.length === 0)
      throw new Error("web.allow is empty: list who may use it (sub:, email: or service:)");
    this.config = config;
    this.env = env;
    this.sessionsPath = join(home, "web-sessions.json");
    this.accessKeys =
      config.access === undefined
        ? undefined
        : createRemoteJWKSet(new URL(`${config.access.teamDomain}/cdn-cgi/access/certs`));
  }

  get oidc(): boolean {
    return this.config.oidc !== undefined;
  }

  private allowed(identities: Identities): Identities | undefined {
    return identities.some((identity) => this.config.allow.includes(identity))
      ? identities
      : undefined;
  }

  /**
   * The allowed identities of a request: from the proxy's JWT when it sends one (a bad one is refused, never ignored),
   * else from the session cookie. `undefined` means not signed in; `false`, signed in but not allowed.
   */
  async identify(
    proxyJwt: string | undefined,
    cookie: string | undefined,
  ): Promise<Identities | false | undefined> {
    if (proxyJwt !== undefined) {
      const access = this.config.access;
      if (access === undefined || this.accessKeys === undefined) return false;
      const { payload, protectedHeader } = await jwtVerify(proxyJwt, this.accessKeys, {
        issuer: access.teamDomain,
        audience: access.audience,
        algorithms: ["RS256"],
      }).catch(() => ({ payload: undefined, protectedHeader: undefined }));
      // Several keys can match a token without `kid`; refuse it rather than guess.
      if (payload === undefined || protectedHeader?.kid === undefined) return false;
      const service = claim(payload, "common_name");
      const identities = service !== undefined ? [`service:${service}`] : [];
      const subject = service === undefined ? claim(payload, access.subjectClaim) : undefined;
      if (subject !== undefined) identities.push(`sub:${subject}`);
      const email = claim(payload, "email");
      if (email !== undefined) identities.push(`email:${email}`);
      return this.allowed(identities) ?? false;
    }
    const token = cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("monchu_session="))
      ?.slice("monchu_session=".length);
    if (!token) return undefined;
    const session = (await this.loadSessions()).get(sha256(token));
    if (session === undefined || session.expires < Date.now()) return undefined;
    return this.allowed(session.identities) ?? false;
  }

  private discover(): Promise<Discovery> {
    const oidc = this.config.oidc;
    if (oidc === undefined) return Promise.reject(new Error("web.oidc is not configured"));
    this.discovery ??= (async () => {
      const response = await fetch(`${oidc.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
      const document: unknown = await response.json();
      if (typeof document !== "object" || document === null)
        throw new Error("OIDC discovery returned no document");
      const fields = Object.fromEntries(Object.entries(document));
      const text = (key: string) => {
        const value: unknown = fields[key];
        if (typeof value !== "string") throw new Error(`OIDC discovery has no ${key}`);
        return value;
      };
      if (text("issuer").replace(/\/+$/, "") !== oidc.issuer)
        throw new Error("OIDC discovery names another issuer");
      const endSession: unknown = fields.end_session_endpoint;
      return {
        authorization: text("authorization_endpoint"),
        token: text("token_endpoint"),
        keys: createRemoteJWKSet(new URL(text("jwks_uri"))),
        endSession: typeof endSession === "string" ? endSession : undefined,
      };
    })().catch((error: unknown) => {
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  /** Where to send a browser to sign in, with PKCE; `redirect` is this server's own callback URL. */
  async loginUrl(redirect: string): Promise<string> {
    const oidc = this.config.oidc;
    if (oidc === undefined) throw new Error("web.oidc is not configured");
    const { authorization } = await this.discover();
    const now = Date.now();
    for (const [state, item] of this.pending) if (item.expires < now) this.pending.delete(state);
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    this.pending.set(state, { verifier, nonce, redirect, expires: now + PENDING_MS });
    const url = new URL(authorization);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: oidc.clientId,
      redirect_uri: redirect,
      scope: oidc.scopes.join(" "),
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  /**
   * Finish a login: exchange the code, verify the ID token (issuer, audience, nonce, signature), and open a session
   * when the identity is allowed. Resolves with the session token for the cookie.
   */
  async callback(state: string, code: string): Promise<string> {
    const oidc = this.config.oidc;
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (oidc === undefined || pending === undefined || pending.expires < Date.now())
      throw new Error("Unknown or expired login; start again");
    const { token: tokenEndpoint, keys } = await this.discover();
    const secret = oidc.clientSecretEnv === undefined ? undefined : this.env[oidc.clientSecretEnv];
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect,
      client_id: oidc.clientId,
      code_verifier: pending.verifier,
      ...(secret === undefined ? {} : { client_secret: secret }),
    });
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
    const tokens: unknown = await response.json();
    const idToken =
      typeof tokens === "object" && tokens !== null && "id_token" in tokens
        ? tokens.id_token
        : undefined;
    if (typeof idToken !== "string") throw new Error("The token response has no ID token");
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: oidc.issuer,
      audience: oidc.clientId,
    });
    if (payload.nonce !== pending.nonce) throw new Error("The ID token's nonce does not match");
    const identities: Identities = [];
    const subject = claim(payload, oidc.subjectClaim);
    if (subject !== undefined) identities.push(`sub:${subject}`);
    const email = claim(payload, "email");
    if (email !== undefined && payload.email_verified !== false) identities.push(`email:${email}`);
    if (this.allowed(identities) === undefined) throw new Error("This account may not use Monchu");
    const session = base64url(randomBytes(32));
    const sessions = await this.loadSessions();
    sessions.set(sha256(session), {
      identities,
      expires: Date.now() + SESSION_DAYS * 86_400_000,
    });
    await this.saveSessions(sessions);
    return session;
  }

  async logout(cookieToken: string | undefined): Promise<void> {
    if (!cookieToken) return;
    const sessions = await this.loadSessions();
    if (sessions.delete(sha256(cookieToken))) await this.saveSessions(sessions);
  }

  /** Sessions by token hash: a leaked file never yields a usable cookie. */
  private async loadSessions(): Promise<Map<string, { identities: Identities; expires: number }>> {
    if (this.sessions !== undefined) return this.sessions;
    const sessions = new Map<string, { identities: Identities; expires: number }>();
    const raw = await readFile(this.sessionsPath, "utf8").catch(() => "{}");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = {};
    }
    if (typeof value === "object" && value !== null)
      for (const [hash, entry] of Object.entries(value)) {
        const item: unknown = entry;
        if (typeof item !== "object" || item === null) continue;
        const fields = Object.fromEntries(Object.entries(item));
        const identities: unknown = fields.identities;
        const expires: unknown = fields.expires;
        if (
          Array.isArray(identities) &&
          identities.every((identity) => typeof identity === "string") &&
          typeof expires === "number" &&
          expires > Date.now()
        )
          sessions.set(hash, { identities, expires });
      }
    this.sessions = sessions;
    return sessions;
  }

  private async saveSessions(
    sessions: Map<string, { identities: Identities; expires: number }>,
  ): Promise<void> {
    const temporary = `${this.sessionsPath}.${base64url(randomBytes(6))}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    await rename(temporary, this.sessionsPath);
  }
}
