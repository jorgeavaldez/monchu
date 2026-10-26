import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxItem } from "../src/api/client.ts";
import { Monchu } from "../src/core/backend.ts";
import { Showing } from "../src/web/showing.ts";
import {
  cleanup,
  context,
  fauxRole,
  front,
  lastMessage,
  prepareHome,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

describe("a root's showing in the web page", () => {
  it("keeps nothing that arrives after it closed: views, subscriptions and notices", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
    );
    prepareHome(home);
    route(value.faux, () => fauxAssistantMessage("ok"));
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      const id = await backend.currentRoot();
      const posted: string[] = [];
      const show = () => new Showing(id, backend.root(id), (text) => posted.push(text));

      // The page moved on while the view was on its way: it never lands.
      const left = show();
      const arriving = left.attach(undefined);
      left.close();
      await arriving;
      expect(left.views.value.size).toBe(0);
      left.notice("late");
      expect(posted).toEqual([]);

      // A showing still open follows its root; one closed stops following, and so does a subscription taken after.
      const open = show();
      const closed = show();
      await open.attach(undefined);
      await closed.attach(undefined);
      let heard: readonly InboxItem[] = [];
      let late: readonly InboxItem[] = [];
      open.own(await open.root.watchInbox((items) => (heard = items)));
      closed.close();
      expect(
        closed.own(
          await closed.root.watchInbox((items) => {
            late = items;
          }),
        ),
      ).toBe(false);
      const before = closed.views.value.get("")?.state.value.entries.length;
      await open.root.submit("hello", "r1", "followUp");
      await waitFor(() => heard.length > 0);
      const now = () => open.views.value.get("")?.state.value.entries.length ?? 0;
      await waitFor(() => now() > (before ?? 0));
      expect(closed.views.value.get("")?.state.value.entries.length).toBe(before);
      expect(late).toEqual([]);
      open.notice("shown");
      expect(posted).toEqual(["shown"]);
      open.close();
    } finally {
      await backend.close();
    }
  });

  it("shows what compaction and /new took out of the view, a page at a time, in the order it was said", async () => {
    const value = await setup();
    route(value.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      return fauxAssistantMessage(text.startsWith("<conversation>") ? "the summary" : `re ${text}`);
    });
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        front: fauxRole,
        worker: fauxRole,
        plugins: { classifier: null },
        settings: { compaction: { keepRecentTokens: 1 } },
      }),
    );
    prepareHome(home);
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      const id = await backend.currentRoot();
      const root = await front(backend);
      const attached = async () => {
        const showing = new Showing(id, backend.root(id), () => {});
        await showing.attach(undefined);
        const views = showing.views.value.get("");
        if (views === undefined) throw new Error("No view");
        return { showing, ...views };
      };
      // What a page shows, one line an entry: who said what, and where each context starts.
      const lines = (view: ConversationView) =>
        view.entries.flatMap((entry: EntryRecord) => {
          if (entry.kind === "pi.compaction") return ["⟲ compacted"];
          if (entry.kind === "pi.reset") return ["⟲ new"];
          const message = entry.model?.[0];
          return message?.role === "user" || message?.role === "assistant"
            ? [`${message.role}: ${textOf(message)}`]
            : [];
        });
      const say = async (text: string) => {
        await root.submit(text, text, "followUp");
        const reply = await root.viewState();
        await waitFor(() => lines(reply.value).includes(`assistant: re ${text}`));
        reply.dispose();
      };

      // A page open through a compaction keeps what it dropped from the view, above the mark.
      const watching = await attached();
      await say("first");
      await say("second");
      expect(watching.earlier.value.more).toBe(false);
      await root.compact(undefined);
      await waitFor(() => watching.state.value.entries[0]?.kind === "pi.compaction");
      const kept = lines(watching.state.value);
      expect(kept).not.toContain("user: first");
      const watched = lines(watching.whole.value);
      expect(watched.slice(0, 2)).toEqual(["user: first", "assistant: re first"]);
      expect(watched.indexOf("⟲ compacted")).toBe(watched.length - kept.length);

      // A page opened after it loads the same history back, and the start of the conversation ends it.
      const opened = await attached();
      expect(lines(opened.whole.value)).toEqual(kept);
      expect(opened.earlier.value.more).toBe(true);
      await opened.showing.loadEarlier(undefined);
      expect(lines(opened.whole.value)).toEqual(watched);
      expect(opened.earlier.value).toMatchObject({ more: false, loading: false });
      expect(opened.earlier.value.entries.some((entry) => entry.kind === "pi.system")).toBe(false);

      // After /new too, a link to the first message loads back to it across both marks.
      await root.reset(undefined);
      await say("third");
      const later = await attached();
      expect(lines(later.whole.value)).toEqual(["⟲ new", "user: third", "assistant: re third"]);
      const first = watching.whole.value.entries.find(
        (entry) => entry.model?.[0]?.role === "user" && textOf(entry.model[0]) === "first",
      );
      if (first === undefined) throw new Error("No first message");
      await later.showing.loadEarlier(undefined, first.id);
      expect(lines(later.whole.value)).toEqual([
        ...watched,
        "⟲ new",
        "user: third",
        "assistant: re third",
      ]);
      for (const each of [watching, opened, later]) each.showing.close();
    } finally {
      await backend.close();
    }
  });

  it("shows every mark, one a newer context kept entries from before too, and what a skipped step dropped", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const id = await backend.currentRoot();
      const conversation = await (await front(backend)).conversation();
      const said = (text: string): EntryDraft => ({
        kind: "pi.user",
        model: [{ role: "user", content: text, timestamp: 1700000000000 }],
      });
      const mark = (head: EntryRecord | undefined): EntryDraft & { head: EntryRecord["id"] } => {
        if (head === undefined) throw new Error("No head");
        return {
          kind: "pi.compaction",
          data: { reason: "manual" },
          model: [{ role: "user", content: "summary", timestamp: 1700000000000 }],
          head: head.id,
        };
      };
      const append = (...drafts: EntryDraft[]) =>
        conversation.commit(async (tx) => {
          const done: EntryRecord[] = [];
          for (const draft of drafts) done.push(await tx.appendEntry(conversation.id, draft));
          return done;
        }, context);
      const lines = (view: ConversationView) =>
        view.entries.map((entry) =>
          entry.head === undefined
            ? textOf(entry.model?.[0])
            : `⟲ ${textOf(entry.model?.[0])} ${entry.id}`,
        );
      const attached = async () => {
        const showing = new Showing(id, backend.root(id), () => {});
        await showing.attach(undefined);
        const views = showing.views.value.get("");
        if (views === undefined) throw new Error("No view");
        return { showing, ...views };
      };
      const first = await append(...["u1", "u2", "u3", "u4", "u5", "u6"].map(said));
      await append(mark(first[2]));
      const watching = await attached();
      await append(said("u7"));
      // The newer context starts before the older mark, at u5.
      await append(mark(first[4]));
      await waitFor(() => watching.state.value.entries.length === 4);
      // A page opened now gets the older mark from history too, though the view's context starts before it.
      const between = await attached();
      await between.showing.loadEarlier(undefined, 0);
      expect(lines(between.whole.value).filter((line) => line.startsWith("⟲")).length).toBe(2);
      between.showing.close();
      await append(said("u8"));
      // One commit says u9 and u10 and marks a context from u10: the page hears only where it ended, as after a drop.
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, said("u9"));
        await tx.appendEntry(
          conversation.id,
          mark(await tx.appendEntry(conversation.id, said("u10"))),
        );
      }, context);
      await waitFor(() => lines(watching.state.value).join(" ").endsWith("u10"));
      await watching.showing.loadEarlier(undefined, 0);
      const opened = await attached();
      await opened.showing.loadEarlier(undefined, 0);
      const expected = (ids: number[]) => [
        "u1",
        "u2",
        `⟲ summary ${ids[0]}`,
        "u3",
        "u4",
        `⟲ summary ${ids[1]}`,
        "u5",
        "u6",
        "u7",
        "u8",
        "u9",
        `⟲ summary ${ids[2]}`,
        "u10",
      ];
      const marks = lines(opened.whole.value).flatMap((line) =>
        line.startsWith("⟲") ? [Number(line.split(" ").at(-1))] : [],
      );
      expect(lines(opened.whole.value)).toEqual(expected(marks));
      expect(lines(watching.whole.value)).toEqual(expected(marks));
      for (const each of [watching, opened]) each.showing.close();
    } finally {
      await backend.close();
    }
  });

  it("pages history newest first, oldest first within a page, each page bounded", async () => {
    const value = await setup();
    const backend = await Monchu.open(value.directory, value.faux.provider);
    try {
      const root = await front(backend);
      const conversation = await root.conversation();
      const entries = await conversation.commit(async (tx) => {
        const result: EntryRecord[] = [];
        for (let index = 0; index < 150; index++)
          result.push(
            await tx.appendEntry(conversation.id, {
              kind: "pi.user",
              model: [{ role: "user", content: `note ${index}`, timestamp: 1700000000000 + index }],
            }),
          );
        return result;
      }, context);
      const end = (entries.at(-1)?.id ?? 0) + 1;
      const newest = await root.history(end);
      expect(newest.more).toBe(true);
      expect(newest.entries.length).toBeLessThan(150);
      expect(newest.entries.map((entry) => entry.id)).toEqual(
        entries.slice(-newest.entries.length).map((entry) => entry.id),
      );
      const older = await root.history(newest.entries[0]?.id ?? 0);
      expect(older.more).toBe(false);
      expect(
        [...older.entries, ...newest.entries]
          .filter((entry) => entry.kind === "pi.user")
          .map((entry) => entry.id),
      ).toEqual(entries.map((entry) => entry.id));
      expect(await root.history(0)).toEqual({ entries: [], more: false });
    } finally {
      await backend.close();
    }
  });
});
