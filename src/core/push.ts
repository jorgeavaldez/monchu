/**
 * Web push: this device's browsers that asked to be told of inbox items of some kinds, and the messages sent to them
 * (RFC 8030), encrypted for each browser (RFC 8291, `aes128gcm`) and signed with this device's VAPID key (RFC 8292).
 * Both live in `<home>/web-push.json` (0600, never synced): each device keeps its own key and its own browsers.
 * Node's crypto does it all, so no dependency is needed.
 */
import {
  createCipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFile } from "./config.ts";
import type { InboxKind } from "./inbox.ts";

/** A browser's subscription, as the Push API gives it, and the kinds it wants. */
export type PushSubscription = {
  endpoint: string;
  /** The browser's P-256 public key and auth secret, base64url. */
  p256dh: string;
  auth: string;
  /** The page's origin, the VAPID contact. */
  origin: string;
  kinds: InboxKind[];
};

/** What a notification shows, and the page it opens. */
export type PushMessage = { title: string; body: string; url: string; tag: string };

type Stored = {
  key: { publicKey: string; privateKey: string };
  subscriptions: (PushSubscription & { createdAt: number })[];
};

const isString = (value: unknown): value is string => typeof value === "string";
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** The file is only written here; checked anyway, since a hand edit must not crash a send. */
function isStored(value: unknown): value is Stored {
  const key = field(value, "key");
  const subscriptions = field(value, "subscriptions");
  return (
    isString(field(key, "publicKey")) &&
    isString(field(key, "privateKey")) &&
    Array.isArray(subscriptions) &&
    subscriptions.every(
      (each: unknown) =>
        ["endpoint", "p256dh", "auth", "origin"].every((name) => isString(field(each, name))) &&
        Array.isArray(field(each, "kinds")) &&
        typeof field(each, "createdAt") === "number",
    )
  );
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

/** A VAPID key pair: the public key as its uncompressed point, the private one as PKCS#8 PEM. */
function newKey(): Stored["key"] {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("No P-256 public key");
  return {
    publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

const info = (text: string, ...keys: Uint8Array[]) =>
  Buffer.concat([Buffer.from(`${text}\0`), ...keys]);

/** The `aes128gcm` body of one push message to a browser (RFC 8291, section 3.4), as a single record. */
export function encrypt(
  plaintext: Uint8Array,
  browser: { p256dh: string; auth: string },
  salt = randomBytes(16),
): Buffer {
  const ua = unb64(browser.p256dh);
  const ecdh = createECDH("prime256v1");
  const as = ecdh.generateKeys();
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      ecdh.computeSecret(ua),
      unb64(browser.auth),
      info("WebPush: info", ua, as),
      32,
    ),
  );
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: nonce"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Buffer.from([2])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(as.length, 20);
  return Buffer.concat([header, as, body, cipher.getAuthTag()]);
}

/** The VAPID `Authorization` header for one push service (RFC 8292). */
function vapid(key: Stored["key"], endpoint: string, contact: string): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: contact,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${key.publicKey}`;
}

export class Pusher {
  private readonly path: string;
  private work: Promise<unknown> = Promise.resolve();

  private readonly log: (body: string, attributes: Record<string, string | number>) => void;

  constructor(
    home: string,
    log: (body: string, attributes: Record<string, string | number>) => void,
  ) {
    this.path = join(home, "web-push.json");
    this.log = log;
  }

  private async read(): Promise<Stored | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isStored(parsed)) throw new Error(`${this.path} is not Monchu's web push file`);
    return parsed;
  }

  /** One change at a time, read and written whole. */
  private change<T>(edit: (stored: Stored) => T): Promise<T> {
    const run = this.work.then(async () => {
      const stored = (await this.read()) ?? { key: newKey(), subscriptions: [] };
      const result = edit(stored);
      await replaceFile(this.path, stored);
      await chmod(this.path, 0o600);
      return result;
    });
    this.work = run.catch(() => {});
    return run;
  }

  /** This device's public key, made on first use, for a browser to subscribe with. */
  async publicKey(): Promise<string> {
    const stored = await this.read();
    return stored?.key.publicKey ?? this.change((each) => each.key.publicKey);
  }

  /** Adds or replaces a browser's subscription; no kinds removes it. */
  async subscribe(subscription: PushSubscription): Promise<void> {
    if (new URL(subscription.endpoint).protocol !== "https:")
      throw new Error("A push endpoint must be https");
    await this.change((stored) => {
      stored.subscriptions = stored.subscriptions.filter(
        (each) => each.endpoint !== subscription.endpoint,
      );
      if (subscription.kinds.length > 0)
        stored.subscriptions.push({ ...subscription, createdAt: Date.now() });
    });
  }

  /** The kinds a browser's subscription wants, or `undefined` when this device has none for it. */
  async kinds(endpoint: string): Promise<InboxKind[] | undefined> {
    return (await this.read())?.subscriptions.find((each) => each.endpoint === endpoint)?.kinds;
  }

  /** Whether any browser wants `kind`. */
  async wants(kind: InboxKind): Promise<boolean> {
    return (await this.read())?.subscriptions.some((each) => each.kinds.includes(kind)) ?? false;
  }

  /** Sends `message` to every browser that wants `kind`; one a push service says is gone is dropped. */
  async send(message: PushMessage, kind: InboxKind): Promise<void> {
    const stored = await this.read();
    if (stored === undefined) return;
    const payload = Buffer.from(JSON.stringify(message));
    const gone: string[] = [];
    await Promise.all(
      stored.subscriptions
        .filter((each) => each.kinds.includes(kind))
        .map(async (each) => {
          const host = new URL(each.endpoint).host;
          try {
            const response = await fetch(each.endpoint, {
              method: "POST",
              headers: {
                Authorization: vapid(stored.key, each.endpoint, each.origin),
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                TTL: String(24 * 3600),
                Urgency: kind === "ask" ? "high" : "normal",
                Topic: message.tag.slice(0, 32),
              },
              body: new Uint8Array(encrypt(payload, each)),
              signal: AbortSignal.timeout(15_000),
            });
            if (response.status === 404 || response.status === 410) gone.push(each.endpoint);
            if (!response.ok) this.log("push refused", { host, status: response.status, kind });
            else this.log("push sent", { host, kind });
          } catch (error) {
            this.log("push failed", {
              host,
              kind,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
    if (gone.length > 0)
      await this.change((each) => {
        each.subscriptions = each.subscriptions.filter((sub) => !gone.includes(sub.endpoint));
      });
  }
}
