import { createECDH, createDecipheriv, hkdfSync } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { UserEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { shortId } from "../src/api/ids.ts";
import { Monchu } from "../src/core/backend.ts";
import { headlineOf, type InboxItem } from "../src/core/inbox.ts";
import { encrypt, Pusher } from "../src/core/push.ts";
import { parseInput } from "../src/ui/commands.ts";
import {
  allEntries,
  cleanup,
  fauxRole,
  lastMessage,
  prepareHome,
  route,
  sectionTexts,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

describe("inbox", () => {
  it("files the front's replies by id, takes its relabels and closes, and quotes an /answer to it", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { clef: null } }),
    );
    prepareHome(home);
    const sections: string[] = [];
    let ask = "";
    route(value.faux, (request) => {
      sections.push(sectionTexts(request.messages).join("\n"));
      const last = lastMessage(request.messages);
      const text = textOf(last);
      if (text === "status")
        return fauxAssistantMessage("**Monchu inbox:** ship it now, or after a review?\nI'd ship.");
      if (text === "relabel")
        return fauxAssistantMessage([fauxToolCall("inbox", { id: ask, kind: "ask", goal: "" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("ok");
    });
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      const front = backend.root(await backend.currentRoot());
      let items: readonly InboxItem[] = [];
      const stop = await front.watchInbox((next) => {
        items = next;
      });
      await front.submit("status", "r1", "followUp");
      await waitFor(() => items.some((item) => item.headline.startsWith("Monchu inbox")));
      const item = items.find((each) => each.headline.startsWith("Monchu inbox"));
      if (item === undefined) throw new Error("no item");
      expect(item.headline).toBe("Monchu inbox: ship it now, or after a review?");
      ask = shortId(item.entry).slice(0, 3);

      await front.submit("relabel", "r2", "followUp");
      await waitFor(() => items.some((each) => each.entry === item.entry && each.kind === "ask"));
      expect(items.find((each) => each.entry === item.entry)).toMatchObject({
        kind: "ask",
        goal: null,
        by: "front",
        state: "open",
      });

      // The front sees the open ask by id at its next request.
      await front.submit("next", "r3", "followUp");
      await waitFor(() => sections.some((text) => text.includes("Open asks:")));
      expect(sections.join("\n")).toContain(`${shortId(item.entry)} · ask (open) · no goal`);

      await front.answer(ask, "ship it", "r4", "followUp");
      await waitFor(() =>
        items.some((each) => each.entry === item.entry && each.state === "answered"),
      );
      const conversation = await front.conversation();
      const typed = async () =>
        (await allEntries(conversation)).flatMap((entry) =>
          UserEntry.is(entry) ? [textOf(entry.model?.[0])] : [],
        );
      const quoted = `[The user answers your message #${shortId(item.entry)} (ask): "Monchu inbox: ship it now, or after a review?"]\nship it`;
      await waitFor(async () => (await typed()).includes(quoted));
      await expect(front.answer("zzzzzzz", "x", "r5", "followUp")).rejects.toThrow(/No message/);
      stop();
    } finally {
      await backend.close();
    }
  });

  it("parses /answer and reads a headline", () => {
    expect(parseInput("/answer kx ship it\nnow")).toEqual({
      command: "/answer",
      id: "kx",
      text: "ship it\nnow",
    });
    expect(() => parseInput("/answer kx")).toThrow(/Usage/);
    expect(headlineOf("\n## **Done:** inbox shipped\nmore")).toBe("Done: inbox shipped");
  });
});

describe("web push", () => {
  it("encrypts a message the browser can read (RFC 8291) and keeps subscriptions private", async () => {
    const value = await setup();
    const browser = createECDH("prime256v1");
    const ua = browser.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const body = encrypt(Buffer.from("hello push"), {
      p256dh: ua.toString("base64url"),
      auth: auth.toString("base64url"),
    });
    // The browser's side: header, the server's key, then the record.
    const salt = body.subarray(0, 16);
    const keyLength = body.readUInt8(20);
    const as = body.subarray(21, 21 + keyLength);
    const record = body.subarray(21 + keyLength);
    const info = (text: string, ...keys: Buffer[]) =>
      Buffer.concat([Buffer.from(`${text}\0`), ...keys]);
    const ikm = Buffer.from(
      hkdfSync("sha256", browser.computeSecret(as), auth, info("WebPush: info", ua, as), 32),
    );
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: aes128gcm"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: nonce"), 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(record.subarray(-16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
    expect(plain.toString()).toBe("hello push\u0002");

    const pusher = new Pusher(value.directory, () => {});
    const key = await pusher.publicKey();
    expect(Buffer.from(key, "base64url")).toHaveLength(65);
    expect(await pusher.publicKey()).toBe(key);
    const endpoint = "https://push.example.test/abc";
    await pusher.subscribe({
      endpoint,
      p256dh: ua.toString("base64url"),
      auth: auth.toString("base64url"),
      origin: "https://monchu.example.test",
      kinds: ["ask"],
    });
    expect(await pusher.kinds(endpoint)).toEqual(["ask"]);
    expect(await pusher.wants("ask")).toBe(true);
    expect(await pusher.wants("milestone")).toBe(false);
    if (process.platform !== "win32")
      expect((await stat(join(value.directory, "web-push.json"))).mode & 0o777).toBe(0o600);
    await pusher.subscribe({
      endpoint,
      p256dh: ua.toString("base64url"),
      auth: auth.toString("base64url"),
      origin: "https://monchu.example.test",
      kinds: [],
    });
    expect(await pusher.kinds(endpoint)).toBeUndefined();
    await expect(
      pusher.subscribe({ endpoint: "http://x.test", p256dh: "", auth: "", origin: "", kinds: [] }),
    ).rejects.toThrow(/https/);
  });
});
