import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RemoteClient } from "../src/api/remote.ts";
import { Rpc } from "../src/api/rpc.ts";
import { Monchu } from "../src/core/backend.ts";
import type { WebConfig } from "../src/core/config.ts";
import { serveWeb } from "../src/server/web.ts";
import { cleanup, fauxRole, front, prepareHome, setup } from "./support.ts";

afterEach(cleanup);

/** A free loopback port. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/** One request to the web server, with the headers a proxy or browser would send. */
function get(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((done, fail) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      response.resume();
      response.on("end", () =>
        done({ status: response.statusCode ?? 0, headers: response.headers }),
      );
    });
    call.on("error", fail);
    call.end();
  });
}

/**
 * A stand-in identity provider on loopback: an access proxy's certs, and an OpenID provider with discovery, keys and a
 * token endpoint that checks the PKCE verifier.
 */
async function identityProvider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/cdn-cgi/access/certs" || url.pathname === "/jwks")
      return json({ keys: [jwk] });
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const code = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (code === undefined || code.challenge !== challenge) {
          response.writeHead(400);
          return response.end();
        }
        void new SignJWT({ nonce: code.nonce, email: "user@example.test" })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience("client-1")
          .setSubject("user-1")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey)
          .then((idToken) => json({ id_token: idToken, token_type: "Bearer" }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return {
    issuer,
    privateKey,
    /** The provider "authorizes" a login: remember its PKCE challenge and nonce under a code. */
    authorize(location: string): string {
      const url = new URL(location);
      codes.set("code-1", {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
      });
      return url.searchParams.get("state") ?? "";
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function accessJwt(
  key: CryptoKey,
  issuer: string,
  claims: Record<string, unknown>,
  options: { audience?: string; kid?: string | null } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader(
      options.kid === null ? { alg: "RS256" } : { alg: "RS256", kid: options.kid ?? "k1" },
    )
    .setIssuer(issuer)
    .setAudience(options.audience ?? "aud-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

async function openCore() {
  const value = await setup();
  const home = join(value.directory, "home");
  await mkdir(home);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  prepareHome(home);
  return { home, backend: await Monchu.open(home, value.faux.provider) };
}

describe("web server", () => {
  it("refuses to start without a login or with nobody allowed", async () => {
    const { backend } = await openCore();
    try {
      const port = await freePort();
      const bare: WebConfig = {
        port,
        host: undefined,
        access: undefined,
        oidc: undefined,
        allow: ["sub:x"],
      };
      await expect(serveWeb(backend, bare, {})).rejects.toThrow("web needs a login");
      await expect(
        serveWeb(
          backend,
          {
            ...bare,
            access: { teamDomain: "https://team.example.test", audience: "a", subjectClaim: "sub" },
            allow: [],
          },
          {},
        ),
      ).rejects.toThrow("web.allow is empty");
    } finally {
      await backend.close();
    }
  });

  it("takes an access proxy's signed identity, checks host, audience, key id and the allow list, and serves the core over a WebSocket", async () => {
    const provider = await identityProvider();
    const { backend } = await openCore();
    const port = await freePort();
    const site = await serveWeb(
      backend,
      {
        port,
        host: "monchu.example.test",
        access: { teamDomain: provider.issuer, audience: "aud-1", subjectClaim: "custom.sub" },
        oidc: undefined,
        allow: ["sub:user-1", "service:svc-1"],
      },
      {},
    );
    try {
      const host = { host: "monchu.example.test", accept: "text/html" };
      const user = await accessJwt(provider.privateKey, provider.issuer, {
        custom: { sub: "user-1" },
      });
      expect((await get(port, "/", { ...host, host: "elsewhere.test" })).status).toBe(421);
      expect((await get(port, "/", host)).status).toBe(401);
      const allowed = await get(port, "/", { ...host, "cf-access-jwt-assertion": user });
      expect([200, 503]).toContain(allowed.status);
      expect(allowed.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const refused = async (jwt: string) =>
        (await get(port, "/", { ...host, "cf-access-jwt-assertion": jwt })).status;
      expect(
        await refused(
          await accessJwt(
            provider.privateKey,
            provider.issuer,
            { custom: { sub: "user-1" } },
            { audience: "other" },
          ),
        ),
      ).toBe(403);
      expect(
        await refused(
          await accessJwt(
            provider.privateKey,
            provider.issuer,
            { custom: { sub: "user-1" } },
            { kid: null },
          ),
        ),
      ).toBe(403);
      expect(
        await refused(
          await accessJwt(provider.privateKey, provider.issuer, {
            custom: { sub: "someone-else" },
          }),
        ),
      ).toBe(403);
      expect(
        await refused(
          await accessJwt(provider.privateKey, "https://forged.example.test", {
            custom: { sub: "user-1" },
          }),
        ),
      ).toBe(403);
      const service = await accessJwt(provider.privateKey, provider.issuer, {
        common_name: "svc-1",
      });
      expect([200, 503]).toContain(await refused(service));

      // A page from another origin can't open the API, even with valid credentials.
      const open = (origin: string) =>
        new Promise<WebSocket>((done, fail) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/api`, {
            headers: { host: "monchu.example.test", origin, "cf-access-jwt-assertion": user },
          });
          socket.once("open", () => done(socket));
          socket.once("error", fail);
        });
      await expect(open("https://evil.example.test")).rejects.toThrow();
      const socket = await open("https://monchu.example.test");
      const rpc = new Rpc();
      socket.on("message", (data: Buffer) => rpc.receive(data.toString("utf8")));
      await rpc.attach({ send: (text) => socket.send(text) });
      const client = await RemoteClient.open(rpc);
      expect(client.home).toBe(backend.home);
      expect(await (await front(client)).workers()).toEqual([]);
      // A person may ask for an update (this checkout refuses it later, for its own reason).
      await expect(client.update("edge")).rejects.toThrow("Nothing here can restart this Monchu");
      client.close();
      socket.close();

      // A service token reaches the core, but never swaps its code.
      const serviceSocket = await new Promise<WebSocket>((done, fail) => {
        const opened = new WebSocket(`ws://127.0.0.1:${port}/api`, {
          headers: {
            host: "monchu.example.test",
            origin: "https://monchu.example.test",
            "cf-access-jwt-assertion": service,
          },
        });
        opened.once("open", () => done(opened));
        opened.once("error", fail);
      });
      const serviceRpc = new Rpc();
      serviceSocket.on("message", (data: Buffer) => serviceRpc.receive(data.toString("utf8")));
      await serviceRpc.attach({ send: (text) => serviceSocket.send(text) });
      const serviceClient = await RemoteClient.open(serviceRpc);
      await expect(serviceClient.update("edge")).rejects.toThrow(
        "Only a person's login can update Monchu",
      );
      serviceClient.close();
      serviceSocket.close();
    } finally {
      await site.close();
      await backend.close();
      await provider.close();
    }
  }, 30_000);

  it("signs in through OpenID Connect with PKCE, keeps the session hashed on disk, and signs out", async () => {
    const provider = await identityProvider();
    const { home, backend } = await openCore();
    const port = await freePort();
    const site = await serveWeb(
      backend,
      {
        port,
        host: undefined,
        access: undefined,
        oidc: {
          issuer: provider.issuer,
          clientId: "client-1",
          clientSecretEnv: undefined,
          scopes: ["openid", "email"],
          subjectClaim: "sub",
        },
        allow: ["email:user@example.test"],
      },
      {},
    );
    try {
      const local = { host: `127.0.0.1:${port}`, accept: "text/html" };
      const start = await get(port, "/", local);
      expect(start).toMatchObject({ status: 302, headers: { location: "/auth/login" } });
      const login = await get(port, "/auth/login", local);
      const location = String(login.headers.location);
      expect(location).toMatch(new RegExp(`^${provider.issuer}/authorize\\?`));
      const url = new URL(location);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/auth/callback`);
      const state = provider.authorize(location);
      expect((await get(port, `/auth/callback?state=wrong&code=code-1`, local)).status).toBe(403);
      const done = await get(port, `/auth/callback?state=${state}&code=code-1`, local);
      expect(done.status).toBe(302);
      const cookie = String(done.headers["set-cookie"]).split(";")[0] ?? "";
      expect(String(done.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Lax/);
      expect([200, 503]).toContain((await get(port, "/", { ...local, cookie })).status);
      const file = join(home, "web-sessions.json");
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, "utf8")).not.toContain(cookie.split("=")[1] ?? "-");
      expect((await get(port, "/auth/logout", { ...local, cookie }, "POST")).status).toBe(403);
      const out = await get(
        port,
        "/auth/logout",
        { ...local, cookie, origin: `http://127.0.0.1:${port}` },
        "POST",
      );
      expect(out.status).toBe(204);
      expect((await get(port, "/", { ...local, cookie, accept: "application/json" })).status).toBe(
        401,
      );
    } finally {
      await site.close();
      await backend.close();
      await provider.close();
    }
  }, 30_000);
});
