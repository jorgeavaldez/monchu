import { createECDH, createDecipheriv, hkdfSync } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { UserEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { shortId } from "../src/api/ids.ts";
import { Monchu } from "../src/core/backend.ts";
import { closeAsk, headlineOf, markOf, openAsk, type InboxItem } from "../src/core/inbox.ts";
import { GoalsDoc } from "../src/core/agents/goals.ts";
import { noticeText } from "../src/api/notices.ts";
import { encrypt, Pusher } from "../src/core/push.ts";
import { parseInput } from "../src/ui/commands.ts";
import {
  allEntries,
  cleanup,
  context,
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
  it("files the front's replies by id, takes its relabels and closes, and quotes a /reply to it", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
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
      if (text === "shipped") return fauxAssistantMessage("done · nope: the inbox shipped");
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

      // The front labels its own message by its headline; an unknown goal is none.
      await front.submit("shipped", "r6", "followUp");
      await waitFor(() => items.some((each) => each.headline === "the inbox shipped"));
      expect(items.find((each) => each.headline === "the inbox shipped")).toMatchObject({
        kind: "milestone",
        goal: null,
        by: "front",
      });

      await front.reply(ask, "ship it", "r4", "followUp");
      await waitFor(() =>
        items.some((each) => each.entry === item.entry && each.state === "answered"),
      );
      const conversation = await front.conversation();
      const typed = async () =>
        (await allEntries(conversation)).flatMap((entry) =>
          UserEntry.is(entry) ? [textOf(entry.model?.[0])] : [],
        );
      const quoted = `[The user replies to your message #${shortId(item.entry)} (ask): "Monchu inbox: ship it now, or after a review?"]\nship it`;
      await waitFor(async () => (await typed()).includes(quoted));
      await expect(front.reply("zzzzzzz", "x", "r5", "followUp")).rejects.toThrow(/No message/);
      stop();
    } finally {
      await backend.close();
    }
  });

  it("files a plugin's ask beside the notice it sent, tied to the worker's goal, until the plugin closes it", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
    );
    prepareHome(home);
    const sections: string[] = [];
    route(value.faux, (request) => {
      sections.push(sectionTexts(request.messages).join("\n"));
      return fauxAssistantMessage("ok");
    });
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      const front = backend.root(await backend.currentRoot());
      const conversation = await front.conversation();
      let items: readonly InboxItem[] = [];
      const stop = await front.watchInbox((next) => {
        items = next;
      });
      await conversation.commit(async (tx) => {
        (await tx.doc(GoalsDoc, conversation.id)).goals.push({
          id: "taxes",
          title: "File the taxes",
          kind: "endeavor",
          status: "active",
          workstream: "logging in to the portal",
          workers: ["browser"],
          next: "upload",
          updatedAt: 0,
        });
        await openAsk(tx, conversation.id, {
          key: "handoff:k3",
          requestId: "asked:k3",
          headline: "browser needs you in the browser: solve the CAPTCHA",
          from: "browser",
        });
        // A replay opens nothing new.
        await openAsk(tx, conversation.id, {
          key: "handoff:k3",
          requestId: "asked:k3",
          headline: "again",
        });
      }, context);
      await conversation.submit(
        {
          type: "input",
          content: noticeText({ name: "browser", status: "update", text: "needs the user" }),
          whenBusy: "followUp",
          requestId: "asked:k3",
        },
        context,
      );
      await waitFor(() => items.some((item) => item.key === "handoff:k3"));
      expect(items.filter((item) => item.key === "handoff:k3")).toMatchObject([
        {
          kind: "ask",
          goal: "taxes",
          by: "plugin",
          state: "open",
          from: "browser",
          headline: "browser needs you in the browser: solve the CAPTCHA",
        },
      ]);
      const item = items.find((each) => each.key === "handoff:k3");
      const entry = (await allEntries(conversation)).find((each) => each.id === item?.entry);
      expect(textOf(entry?.model?.[0])).toContain("needs the user");

      await front.submit("next", "r1", "followUp");
      await waitFor(() => sections.some((text) => text.includes("solve the CAPTCHA")));
      expect(
        await conversation.commit(
          (tx) => closeAsk(tx, conversation.id, "handoff:k3", "answered"),
          context,
        ),
      ).toBe(true);
      await waitFor(() =>
        items.some((each) => each.key === "handoff:k3" && each.state === "answered"),
      );
      expect(
        await conversation.commit((tx) => closeAsk(tx, conversation.id, "nope", "closed"), context),
      ).toBe(false);
      stop();
    } finally {
      await backend.close();
    }
  });

  it("parses /reply and reads a headline", () => {
    expect(parseInput("/reply kx ship it\nnow")).toEqual({
      command: "/reply",
      id: "kx",
      text: "ship it\nnow",
    });
    expect(() => parseInput("/reply kx")).toThrow(/Usage/);
    expect(headlineOf("\n## **Done:** inbox shipped\nmore")).toBe("Done: inbox shipped");
    expect(markOf("done · monchu: inbox shipped")).toEqual({
      kind: "milestone",
      goal: "monchu",
      headline: "inbox shipped",
    });
    expect(markOf("ask: ship now or later?")).toEqual({
      kind: "ask",
      goal: undefined,
      headline: "ship now or later?",
    });
    expect(markOf("ask · Web Push: allow notifications?")).toEqual({
      kind: "ask",
      goal: "web-push",
      headline: "allow notifications?",
    });
    expect(markOf("done the thing")).toBeUndefined();
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
