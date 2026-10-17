import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { webSocketLink, type Link } from "@earendil-works/chord";
import { connectRemote } from "../src/api/connect.ts";
import { Monchu } from "../src/core/backend.ts";
import type { WebConfig } from "../src/core/config.ts";
import { ingress, openCoreHost } from "../src/server/host.ts";
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
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  return new Promise((done, fail) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString()));
      response.on("end", () =>
        done({ status: response.statusCode ?? 0, headers: response.headers, text }),
      );
    });
    call.on("error", fail);
    call.end(body);
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
  const backend = await Monchu.open(home, value.faux.provider);
  return { home, backend, host: await openCoreHost(backend) };
}

describe("web server", () => {
  it("refuses to start without a login or with nobody allowed", async () => {
    const { backend, host: core } = await openCore();
    try {
      const port = await freePort();
      const bare: WebConfig = {
        port,
        host: undefined,
        access: undefined,
        oidc: undefined,
        allow: ["sub:x"],
      };
      await expect(serveWeb(ingress(core), backend, bare, {})).rejects.toThrow("web needs a login");
      await expect(
        serveWeb(
          ingress(core),
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
      await core.close();
      await backend.close();
    }
  });

  it("takes an access proxy's signed identity, checks host, audience, key id and the allow list, and serves the core over a WebSocket", async () => {
    const provider = await identityProvider();
    const { backend, host: core } = await openCore();
    const port = await freePort();
    const site = await serveWeb(
      ingress(core),
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
      const open = (origin: string, jwt = user) =>
        new Promise<Link>((done, fail) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/api`, {
            headers: { host: "monchu.example.test", origin, "cf-access-jwt-assertion": jwt },
          });
          const link = webSocketLink(socket);
          socket.once("open", () => done(link));
          socket.once("error", fail);
        });
      await expect(open("https://evil.example.test")).rejects.toThrow();
      const link = await open("https://monchu.example.test");
      const attached = await connectRemote(async () => link, {
        onError: () => {},
      });
      if (attached === undefined) throw new Error("The web socket did not connect");
      const { client } = attached;
      expect(client.home).toBe(backend.home);
      expect(await (await front(client)).workers()).toEqual([]);
      // A person may ask for an update (this checkout refuses it later, for its own reason).
      await expect(client.update("edge")).rejects.toThrow("Nothing here can restart this Monchu");
      await attached.close();

      // A service token reaches the core, but never swaps its code.
      const serviceLink = await open("https://monchu.example.test", service);
      const serviceClient = await connectRemote(async () => serviceLink, {
        onError: () => {},
      });
      if (serviceClient === undefined) throw new Error("The service socket did not connect");
      await expect(serviceClient.client.update("edge")).rejects.toThrow(
        "Only a person's login can update Monchu",
      );
      await serviceClient.close();
    } finally {
      await site.close();
      await core.close();
      await backend.close();
      await provider.close();
    }
  }, 30_000);

  it("signs in through OpenID Connect with PKCE, keeps the session hashed on disk, and signs out", async () => {
    const provider = await identityProvider();
    const { home, backend, host: core } = await openCore();
    const port = await freePort();
    const site = await serveWeb(
      ingress(core),
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

      // A page signed in with this session is connected until it signs out.
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api`, {
        headers: { ...local, cookie, origin: `http://127.0.0.1:${port}` },
      });
      const link = webSocketLink(socket);
      await new Promise<void>((done, fail) => {
        socket.once("open", () => done());
        socket.once("error", fail);
      });
      const page = await connectRemote(async () => link, { onError: () => {} });
      if (page === undefined) throw new Error("The signed-in page did not connect");
      expect(page.client.home).toBe(home);
      const dropped = new Promise<string>((done) => link.onClose(done));

      const out = await get(
        port,
        "/auth/logout",
        { ...local, cookie, origin: `http://127.0.0.1:${port}` },
        "POST",
      );
      expect(out.status).toBe(204);
      // Signing out closes the session's sockets; it can't sign back in on its own.
      await dropped;
      await page.close();
      expect((await get(port, "/", { ...local, cookie, accept: "application/json" })).status).toBe(
        401,
      );
    } finally {
      await site.close();
      await core.close();
      await backend.close();
      await provider.close();
    }
  }, 30_000);

  it("names this device's install manifest from client settings only a person's login changes", async () => {
    const provider = await identityProvider();
    const { home, backend, host: core } = await openCore();
    const port = await freePort();
    const site = await serveWeb(
      ingress(core),
      backend,
      {
        port,
        host: "monchu.example.test",
        access: { teamDomain: provider.issuer, audience: "aud-1", subjectClaim: "sub" },
        oidc: undefined,
        allow: ["sub:user-1", "service:svc-1"],
      },
      {},
    );
    try {
      const person = {
        host: "monchu.example.test",
        "cf-access-jwt-assertion": await accessJwt(provider.privateKey, provider.issuer, {
          sub: "user-1",
        }),
      };
      const service = {
        ...person,
        "cf-access-jwt-assertion": await accessJwt(provider.privateKey, provider.issuer, {
          common_name: "svc-1",
        }),
      };
      const named = async (): Promise<unknown> =>
        JSON.parse((await get(port, "/manifest.webmanifest", person)).text);
      expect(await named()).toMatchObject({ name: "Monchu", short_name: "Monchu", id: "/" });
      expect((await get(port, "/manifest.webmanifest", { host: person.host })).status).toBe(401);
      expect(JSON.parse((await get(port, "/client.json", service)).text)).toEqual({
        name: "Monchu",
        editable: false,
      });

      const put = (
        headers: Record<string, string>,
        value: unknown,
        origin = "https://monchu.example.test",
      ) => get(port, "/client.json", { ...headers, origin }, "PUT", JSON.stringify(value));
      expect((await put(service, { name: "Monchu svc" })).status).toBe(403);
      expect((await put(person, { name: "Monchu evil" }, "https://evil.example.test")).status).toBe(
        403,
      );
      expect((await put(person, { name: "x".repeat(31) })).status).toBe(400);
      expect((await put(person, { name: "a\nb" })).status).toBe(400);
      expect(await named()).toMatchObject({ name: "Monchu" });

      const saved = await put(person, { name: "  Monchu dev " });
      expect(saved.status).toBe(200);
      expect(JSON.parse(saved.text)).toEqual({ name: "Monchu dev", editable: true });
      expect(await named()).toMatchObject({ name: "Monchu dev", short_name: "Monchu dev" });
      expect(JSON.parse(await readFile(join(home, "web-client.json"), "utf8"))).toEqual({
        name: "Monchu dev",
      });

      // Empty goes back to the default, and leaves no file behind.
      expect((await put(person, { name: "" })).status).toBe(200);
      expect(await named()).toMatchObject({ name: "Monchu" });
      await expect(stat(join(home, "web-client.json"))).rejects.toThrow();
    } finally {
      await site.close();
      await core.close();
      await backend.close();
      await provider.close();
    }
  }, 30_000);
});
