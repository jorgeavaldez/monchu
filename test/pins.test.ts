import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { PinnedMessage } from "../src/api/client.ts";
import { parseShortId, shortId } from "../src/api/ids.ts";
import { addressable, messageOf } from "../src/api/messages.ts";
import { jobNoticeText, noticeText, replyText, rootNoticeText } from "../src/api/notices.ts";
import { Monchu } from "../src/core/backend.ts";
import { pinMessage, unpinMessage } from "../src/core/pins.ts";
import {
  cleanup,
  context,
  fauxRole,
  lastMessage,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

describe("pinned messages", () => {
  it("pins a unique prefix or whole id once, watches every change, and unpins idempotently", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      await backend.renameRoot(root.id, "Outreach");
      const conversation = await root.conversation();
      const entries = await conversation.commit(async (tx) => {
        const result: EntryRecord[] = [];
        for (let index = 0; index < 24; index++)
          result.push(
            await tx.appendEntry(conversation.id, {
              kind: "pi.user",
              model: [
                { role: "user", content: `Keep note ${index}`, timestamp: 1700000000000 + index },
              ],
            }),
          );
        return result;
      }, context);
      let pins: readonly PinnedMessage[] = [];
      const stop = await backend.watchPins((state) => (pins = state.items));
      try {
        await waitFor(() => pins.length === 0);
        const target = entries.find(
          (entry) =>
            !entries.some(
              (other) =>
                other.id !== entry.id &&
                shortId(other.id).startsWith(shortId(entry.id).slice(0, 3)),
            ),
        );
        if (target === undefined) throw new Error("No unique three-letter prefix in fixture");
        const code = shortId(target.id);
        const before = Date.now();
        const first = await root.pinMessage(code.slice(0, 3));
        expect(first.existed).toBe(false);
        expect(first.pin).toMatchObject({
          code,
          root: root.id,
          rootLabel: "Outreach",
          from: "you",
          text: `Keep note ${entries.indexOf(target)}`,
          sentAt: 1700000000000 + entries.indexOf(target),
        });
        expect(first.pin.pinnedAt).toBeGreaterThanOrEqual(before);
        expect(first.pin.pinnedAt).toBeLessThanOrEqual(Date.now());
        await waitFor(() => pins.length === 1);
        expect(pins).toEqual([first.pin]);
        await backend.renameRoot(root.id, "Renamed outreach");
        expect(await root.pinMessage(code)).toEqual({ pin: first.pin, existed: true });
        expect(pins).toEqual([first.pin]);
        const second = entries.find((entry) => entry.id !== target.id);
        if (second === undefined) throw new Error("Missing second fixture");
        const another = await root.pinMessage(shortId(second.id));
        expect(another.existed).toBe(false);
        expect(another.pin.rootLabel).toBe("Renamed outreach");
        await waitFor(() => pins.length === 2);
        expect(pins).toEqual([first.pin, another.pin]);
        await backend.unpinMessage(code);
        await waitFor(() => pins.length === 1);
        expect(pins).toEqual([another.pin]);
        await backend.unpinMessage(code);
        expect(pins).toEqual([another.pin]);
      } finally {
        stop();
      }
    } finally {
      await backend.close();
    }
  });

  it("keeps the worker whose conversation a pin came from, and none for the front's", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      const conversation = await root.conversation();
      // Each pin in its own commit: a pin reads the conversation, which a write earlier in the commit forbids.
      const entry = await conversation.commit(
        (tx) =>
          tx.appendEntry(conversation.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "Look into it", timestamp: 1700000000000 }],
          }),
        context,
      );
      const where = { conversation: conversation.id, root: conversation.id, rootLabel: "" };
      const code = shortId(entry.id);
      const front = await conversation.commit((tx) => pinMessage(tx, where, code), context);
      await conversation.commit((tx) => unpinMessage(tx, code), context);
      const worker = await conversation.commit(
        (tx) => pinMessage(tx, { ...where, worker: "reader" }, code),
        context,
      );
      const pinned = { front, worker };
      expect(pinned.front.pin).not.toHaveProperty("worker");
      expect(pinned.worker.pin).toMatchObject({ from: "to reader", worker: "reader" });
    } finally {
      await backend.close();
    }
  });

  it("rejects an ambiguous prefix naming its candidates, and rejects an unknown id", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      const conversation = await root.conversation();
      const entries = await conversation.commit(async (tx) => {
        const result: EntryRecord[] = [];
        for (let index = 0; index < 24; index++)
          result.push(
            await tx.appendEntry(conversation.id, {
              kind: "pi.user",
              model: [{ role: "user", content: `Candidate ${index}`, timestamp: 1700000000000 }],
            }),
          );
        return result;
      }, context);
      const codes = entries.map((entry) => shortId(entry.id));
      const prefix = codes
        .find((code) => codes.filter((other) => other.startsWith(code.slice(0, 1))).length > 1)
        ?.slice(0, 1);
      if (prefix === undefined) throw new Error("Pigeonhole fixture has no collision");
      await expect(root.pinMessage(prefix)).rejects.toThrow();
      for (const candidate of codes.filter((code) => code.startsWith(prefix)))
        await expect(root.pinMessage(prefix)).rejects.toThrow(candidate);
      await expect(root.pinMessage("zzzzzzzz")).rejects.toThrow(/no message|unknown|not found/i);
    } finally {
      await backend.close();
    }
  });

  it("a whole four-letter id wins over a newer five-letter id with that prefix, even outside the newest 500 entries", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      const conversation = await root.conversation();
      // Real store-assigned ids, not casts or fabricated EntryRecords. One transaction keeps padding cheap.
      const pair = await conversation.commit(async (tx) => {
        let old: EntryRecord | undefined;
        let newer: EntryRecord | undefined;
        let previous: number = conversation.id;
        while (previous < 65536) {
          const next = previous + 1;
          const text =
            next === 24920
              ? "Keep the old four-letter message"
              : next === 65536
                ? "Do not mistake this newer message for the old one"
                : undefined;
          const entry = await tx.appendEntry(
            conversation.id,
            text === undefined
              ? { kind: "pins.padding" }
              : {
                  kind: "pi.user",
                  model: [{ role: "user", content: text, timestamp: 1700000000000 }],
                },
          );
          previous = entry.id;
          if (entry.id === 24920) old = entry;
          if (entry.id === 65536) newer = entry;
        }
        return { old, newer };
      }, context);
      if (pair.old === undefined || pair.newer === undefined)
        throw new Error("Collision entries were not assigned");
      expect(shortId(pair.old.id)).toBe("nyrv");
      expect(shortId(pair.newer.id)).toBe("nyrvt");
      expect(parseShortId("nyrv")).toBe(24920);
      expect((await root.pinMessage("nyrv")).pin).toMatchObject({
        code: "nyrv",
        text: "Keep the old four-letter message",
      });
      expect((await root.pinMessage("nyrvt")).pin).toMatchObject({
        code: "nyrvt",
        text: "Do not mistake this newer message for the old one",
      });
    } finally {
      await backend.close();
    }
  }, 60000);

  it("snapshots the table's senders and visible text without quotes, instructions, guidance or truncation", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      const conversation = await root.conversation();
      const long = `Full schedule\n${"all appointments stay here 🧷\n".repeat(5000)}last appointment`;
      const cases: {
        name: string;
        draft: EntryDraft;
        from: string;
        text: string;
        headline?: string;
      }[] = [
        ...(["completed", "failed", "update"] as const).map((status) => ({
          name: `worker ${status}`,
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user" as const,
                content: noticeText({
                  name: "research",
                  status,
                  text: "The complete research\nwith sources",
                }),
                timestamp: 1700000000000,
              },
            ],
          },
          from: "research",
          text: "The complete research\nwith sources",
        })),
        ...[false, true].map((front) => ({
          name: front ? "job to front" : "job to worker",
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user" as const,
                content: jobNoticeText(
                  { name: "nightly", header: "exited (0)", text: "job output\nall lines" },
                  front,
                ),
                timestamp: 1700000000000,
              },
            ],
          },
          from: "job nightly",
          text: "exited (0)\njob output\nall lines",
        })),
        {
          name: "root note",
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: rootNoticeText({
                  from: "kkkk",
                  label: "Other work",
                  kind: "message",
                  text: "Other root's text\nsecond line",
                }),
                timestamp: 1700000000000,
              },
            ],
          },
          from: "root Other work",
          text: "Other root's text\nsecond line",
        },
        {
          name: "typed input",
          draft: {
            kind: "pi.user",
            model: [
              { role: "user", content: "my own words\nkeep both lines", timestamp: 1700000000000 },
            ],
          },
          from: "you",
          text: "my own words\nkeep both lines",
        },
        {
          name: "/reply",
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: replyText({
                  id: "kkkk",
                  about: "ask",
                  headline: "Which day?",
                  again: false,
                  text: "Tuesday\nafter lunch",
                }),
                timestamp: 1700000000000,
              },
            ],
          },
          from: "you",
          text: "Tuesday\nafter lunch",
        },
        {
          name: "skill invocation",
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user",
                content:
                  '<skill name="research" location="/skills/research/SKILL.md">\nPrivate skill instructions\n</skill>\n\nfind the full links',
                timestamp: 1700000000000,
              },
            ],
          },
          from: "you",
          text: "/skill:research find the full links",
        },
        {
          name: "attached files",
          draft: {
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: [
                  { type: "text", text: "read these" },
                  {
                    type: "text",
                    text: "<attachments>\n- /uploads/notes.txt (text/plain, 10 B)\n- /uploads/report.pdf (application/pdf, 20 B)\n</attachments>",
                  },
                ],
                timestamp: 1700000000000,
              },
            ],
          },
          from: "you",
          text: "read these\n[attached: notes.txt, report.pdf]",
        },
        {
          name: "reply text parts",
          draft: {
            kind: "pi.assistant",
            model: [
              fauxAssistantMessage([
                { type: "text", text: "first part" },
                fauxToolCall("read", { path: "ignored" }),
                { type: "text", text: "second part" },
              ]),
            ],
          },
          from: "monchu",
          text: "first part\nsecond part",
        },
        {
          name: "labeled headline",
          draft: {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("done · outreach: schedule ready\nall the times")],
          },
          from: "monchu",
          text: "done · outreach: schedule ready\nall the times",
          headline: "schedule ready",
        },
        {
          name: "whole long text",
          draft: { kind: "pi.assistant", model: [fauxAssistantMessage(long)] },
          from: "monchu",
          text: long,
          headline: "Full schedule",
        },
      ];
      for (const row of cases) {
        const entry = await conversation.commit(
          (tx) => tx.appendEntry(conversation.id, row.draft),
          context,
        );
        expect(addressable(entry), row.name).toBe(true);
        expect(messageOf(entry), row.name).toEqual({ from: row.from, text: row.text });
        const { pin, existed } = await root.pinMessage(shortId(entry.id));
        expect(existed, row.name).toBe(false);
        expect(pin.from, row.name).toBe(row.from);
        expect(pin.text, row.name).toBe(row.text);
        if (row.headline !== undefined) expect(pin.headline, row.name).toBe(row.headline);
      }
    } finally {
      await backend.close();
    }
  });

  it("pins input and replies in a worker conversation by the worker's name", async () => {
    const value = await setup();
    route(value.faux, (request) => {
      if (textOf(lastMessage(request.messages)) === "delegate research")
        return fauxAssistantMessage(
          [fauxToolCall("start_worker", { name: "research", task: "Find the source links" })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("Here are all the source links\nhttps://example.test/source");
    });
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      await root.submit("delegate research", "delegate", "followUp");
      await waitFor(async () =>
        (await root.workers()).some((worker) => worker.name === "research" && !worker.busy),
      );
      const view = await root.viewState("research");
      try {
        const input = view.value.entries.find(
          (entry) =>
            entry.kind === "pi.user" && textOf(entry.model?.[0]) === "Find the source links",
        );
        const answer = view.value.entries.find(
          (entry) =>
            entry.kind === "pi.assistant" &&
            textOf(entry.model?.[0]) ===
              "Here are all the source links\nhttps://example.test/source",
        );
        if (input === undefined || answer === undefined)
          throw new Error("Worker did not complete its conversation");
        expect(messageOf(input, "research")).toEqual({
          from: "to research",
          text: "Find the source links",
        });
        expect((await root.pinMessage(shortId(input.id), "research")).pin).toMatchObject({
          from: "to research",
          text: "Find the source links",
          root: root.id,
        });
        expect(messageOf(answer, "research")).toEqual({
          from: "research",
          text: "Here are all the source links\nhttps://example.test/source",
        });
        expect((await root.pinMessage(shortId(answer.id), "research")).pin).toMatchObject({
          from: "research",
          text: "Here are all the source links\nhttps://example.test/source",
          root: root.id,
        });
        await expect(root.pinMessage(shortId(input.id))).rejects.toThrow(
          /no message|unknown|not found/i,
        );
      } finally {
        view.dispose();
      }
    } finally {
      await backend.close();
    }
  });

  it("keeps the same snapshots after real compaction and /new reset", async () => {
    const value = await setup();
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({
        front: fauxRole,
        worker: fauxRole,
        plugins: { classifier: null },
        settings: { compaction: { keepRecentTokens: 1 } },
      }),
    );
    route(value.faux, (request) => {
      const text = textOf(lastMessage(request.messages));
      return fauxAssistantMessage(
        text.startsWith("<conversation>") ? "short summary" : `Answer ${text}`,
      );
    });
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = backend.root(await backend.currentRoot());
      const view = await root.viewState();
      let pins: readonly PinnedMessage[] = [];
      const stop = await backend.watchPins((state) => (pins = state.items));
      try {
        for (const text of ["first", "second"]) {
          await root.submit(text, text, "followUp");
          await waitFor(() =>
            view.value.entries.some((entry) => textOf(entry.model?.[0]) === `Answer ${text}`),
          );
        }
        const original = view.value.entries.find(
          (entry) => textOf(entry.model?.[0]) === "Answer first",
        );
        if (original === undefined) throw new Error("No first answer");
        const saved = await root.pinMessage(shortId(original.id));
        await waitFor(() => pins.length === 1);
        expect(saved.pin.text).toBe("Answer first");
        await root.compact(undefined);
        await waitFor(() => view.value.entries[0]?.kind === "pi.compaction");
        expect(view.value.entries.some((entry) => entry.id === original.id)).toBe(false);
        expect(pins).toEqual([saved.pin]);
        await root.reset(undefined);
        await waitFor(
          () =>
            !view.value.entries.some((entry) => entry.id === original.id) &&
            !view.value.entries.some((entry) => entry.kind === "pi.compaction"),
        );
        expect(pins).toEqual([saved.pin]);
        // A newly attached client reads the stored snapshot, not just the old watch's cached value.
        let restored: readonly PinnedMessage[] | undefined;
        const reread = await backend.watchPins((state) => (restored = state.items));
        try {
          await waitFor(() => restored !== undefined);
          expect(restored).toEqual([saved.pin]);
        } finally {
          reread();
        }
      } finally {
        stop();
        view.dispose();
      }
    } finally {
      await backend.close();
    }
  });
});
