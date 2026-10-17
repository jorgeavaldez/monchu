import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RootSummary } from "../src/api/client.ts";
import { shortId } from "../src/api/ids.ts";
import { parseRootNotice, parseWorkerNotice } from "../src/api/notices.ts";
import { Monchu } from "../src/core/backend.ts";
import type { Front } from "../src/core/front.ts";
import { presentation } from "../src/ui/state.ts";
import {
  allEntries,
  callTools,
  cleanup,
  context,
  fauxRole,
  lastMessage,
  prepareHome,
  route,
  sectionTexts,
  setup,
  textOf,
  toolResults,
  waitFor,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

async function openBackend(value: Setup): Promise<{ home: string; backend: Monchu }> {
  const home = join(value.directory, "home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  prepareHome(home);
  return { home, backend: await Monchu.open(home, value.faux.provider) };
}

/** The user-role inputs of a root's front transcript, as text: the user's messages and every notice. */
async function inputs(front: Front): Promise<string[]> {
  return (await allEntries(await front.conversation())).flatMap((entry) => {
    const message = UserEntry.is(entry) ? entry.model?.[0] : undefined;
    return message?.role === "user" ? [textOf(message)] : [];
  });
}

/** The newest root summaries a backend publishes, while watched. */
async function watch(backend: Monchu): Promise<{ value: readonly RootSummary[]; stop(): void }> {
  const seen: { value: readonly RootSummary[]; stop(): void } = { value: [], stop: () => {} };
  seen.stop = await backend.watchRoots((roots) => {
    seen.value = roots;
  });
  return seen;
}

async function idle(front: Front): Promise<void> {
  await (await front.conversation()).waitForIdle(context);
}

/** Answers `hold` only when its run is stopped, and anything else with "ok". */
function holding(value: Setup): void {
  route(value.faux, async (request, options) => {
    if (textOf(lastMessage(request.messages)) === "hold") {
      const signal = options?.signal;
      if (signal === undefined) throw new Error("hold requires cancellation");
      if (!signal.aborted) await once(signal, "abort");
    }
    return fauxAssistantMessage("ok");
  });
}

describe("roots", () => {
  it("keeps independent roots, names them from their first message, and opens the current one by stable ids", async () => {
    const value = await setup();
    holding(value);
    const opened = await openBackend(value);
    const { home } = opened;
    let backend = opened.backend;
    let current = "";
    const first = await backend.currentRoot();
    try {
      const watched = await watch(backend);
      expect(watched.value).toMatchObject([{ id: first, label: "", archived: false }]);
      const second = await backend.createRoot("create:second");
      expect(await backend.createRoot("create:second")).toBe(second);
      await backend.root(second).submit("plan the garden\nwith details", "m2", "followUp");
      await idle(backend.root(second));
      expect(await backend.currentRoot()).toBe(second);
      await backend.root(first).submit("hello", "m1", "followUp");
      await idle(backend.root(first));
      expect(await backend.currentRoot()).toBe(first);
      // Each root has its own transcript.
      expect(await inputs(backend.root(first))).toEqual(["hello"]);
      expect(await inputs(backend.root(second))).toEqual(["plan the garden\nwith details"]);
      await waitFor(() =>
        watched.value.some((root) => root.id === second && root.label === "plan the garden"),
      );
      watched.stop();

      // Prefixes: unique ones name a root, unknown and ambiguous ones fail naming candidates.
      const ids = [first, second];
      for (let index = 0; index < 8; index++) ids.push(await backend.createRoot(`more:${index}`));
      const prefix = (id: string) =>
        id.slice(
          0,
          Math.max(
            ...ids
              .filter((other) => other !== id)
              .map((other) => {
                let shared = 0;
                while (id[shared] === other[shared]) shared++;
                return shared;
              }),
          ) + 1,
        );
      for (const id of ids) expect(await backend.findRoot(prefix(id))).toBe(id);
      const shared = ids
        .flatMap((id) => ids.filter((other) => other !== id && other[0] === id[0]))
        .at(0);
      if (shared !== undefined)
        await expect(backend.findRoot(shared.slice(0, 1))).rejects.toThrow("ambiguous");
      const unknown = "kkkkkkkk";
      if (!ids.some((id) => id.startsWith(unknown)))
        await expect(backend.findRoot(unknown)).rejects.toThrow("No root");
      await expect(backend.findRoot("abc")).rejects.toThrow("Not a root id");
      await expect(backend.root("zzzzzzzz").workers()).rejects.toThrow("No root zzzzzzzz");
      current = await backend.currentRoot();
      expect(current).toBe(ids.at(-1));
    } finally {
      await backend.close();
    }
    backend = await Monchu.open(home, value.faux.provider);
    try {
      // A root just created counts as opened: the newest one is current, and stays so across a restart.
      expect(await backend.currentRoot()).toBe(current);
      expect(await inputs(backend.root(first))).toEqual(["hello"]);
    } finally {
      await backend.close();
    }
  });

  it("archives only quiet roots, unarchives on input, and lets /new rename an automatically named root", async () => {
    const value = await setup();
    holding(value);
    const { backend } = await openBackend(value);
    try {
      const first = await backend.currentRoot();
      await expect(backend.archiveRoot(first, true)).rejects.toThrow("last open root");
      const second = await backend.createRoot("create:second");
      await backend.root(second).submit("hold", "hold", "followUp");
      await waitFor(async () => {
        const view = await backend.root(second).viewState();
        const { busy } = presentation(view.value);
        view.dispose();
        return busy;
      });
      await expect(backend.archiveRoot(second, true)).rejects.toThrow("working");
      await backend.root(second).abort();
      await backend.archiveRoot(second, true);
      // Archived: hidden from plain `monchu` even though it had the newest input, yet still open by id.
      expect(await backend.currentRoot()).toBe(first);
      expect(await backend.findRoot(second)).toBe(second);
      await backend.root(second).submit("back again", "back", "followUp");
      await idle(backend.root(second));
      expect(await backend.currentRoot()).toBe(second);

      const label = async (id: string) => {
        const watched = await watch(backend);
        watched.stop();
        return watched.value.find((root) => root.id === id);
      };
      expect(await label(second)).toMatchObject({ label: "hold", named: false, archived: false });
      await backend.root(second).reset(undefined);
      expect(await label(second)).toMatchObject({ label: "" });
      await backend.root(second).submit("next topic", "next", "followUp");
      await idle(backend.root(second));
      expect(await label(second)).toMatchObject({ label: "next topic" });
      await backend.renameRoot(second, "  my  topic ");
      await backend.root(second).reset(undefined);
      expect(await label(second)).toMatchObject({ label: "my topic", named: true });
      await backend.renameRoot(second, "");
      expect(await label(second)).toMatchObject({ label: "", named: false });
    } finally {
      await backend.close();
    }
  });

  it("shows a working root, then done until a client shows it", async () => {
    const value = await setup();
    holding(value);
    const { backend } = await openBackend(value);
    try {
      const first = await backend.currentRoot();
      const second = await backend.createRoot("create:second");
      const watched = await watch(backend);
      const status = (id: string) => watched.value.find((root) => root.id === id)?.status;
      await backend.root(second).submit("hold", "hold", "followUp");
      await waitFor(() => status(second) === "working");
      expect(status(first)).toBe("idle");
      await backend.root(second).abort();
      await backend.root(second).submit("answer me", "answer", "followUp");
      await idle(backend.root(second));
      await waitFor(() => status(second) === "done");
      // Shown in a client: seen, so never done; closing the view keeps it seen.
      const view = await backend.root(second).viewState();
      await waitFor(() => status(second) === "idle");
      view.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(status(second)).toBe("idle");
      watched.stop();
    } finally {
      await backend.close();
    }
  });

  it("hands an idle worker, with its jobs, to another root, where it reports and reads the user from then on", async () => {
    const value = await setup();
    const calls = callTools({
      schedule: {
        tool: "job",
        args: {
          action: "create",
          type: "agent",
          name: "nightly",
          schedule: "0 3 * * *",
          worker: "w",
          prompt: "check",
        },
      },
      "who asked": { tool: "user_messages", args: {} },
    });
    route(value.faux, async (request, options) => {
      if (textOf(lastMessage(request.messages)) === "hold") {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
      }
      return calls(request);
    });
    const { backend } = await openBackend(value);
    try {
      const a = backend.root(await backend.currentRoot());
      const b = backend.root(await backend.createRoot("create:b"));
      const reports = async (front: Front) =>
        (await inputs(front)).filter((text) => parseWorkerNotice(text)?.name === "w");
      await a.startWorker("w", "first brief", "start:w");
      await waitFor(async () => (await reports(a)).length === 1);
      await a.submit("schedule", "schedule", "followUp");
      await waitFor(async () => (await backend.jobs()).jobs.some((job) => job.name === "nightly"));
      await b.submit("hello b", "hello", "followUp");
      await idle(a);
      await idle(b);

      await a.handOff("w", b.id);
      expect(await a.workers()).toEqual([]);
      expect(await b.workers()).toMatchObject([{ name: "w", busy: false }]);
      const job = (await backend.jobs()).jobs.find((item) => item.name === "nightly");
      expect(job && shortId(job.rootId)).toBe(b.id);
      expect(job && shortId(job.worker.parentId)).toBe(b.id);
      await waitFor(async () =>
        (await inputs(b)).some((text) => parseRootNotice(text)?.kind === "handoff"),
      );
      const handed = (await inputs(b)).map(parseRootNotice).find((notice) => notice !== undefined);
      expect(handed).toMatchObject({ from: a.id, kind: "handoff" });
      expect(handed?.text).toContain("worker w");

      // From now on it reports to the new root and reads that root's user.
      await b.messageWorker("w", "who asked", "ask:w", "followUp");
      await waitFor(async () => (await reports(b)).length === 1);
      expect(await reports(a)).toHaveLength(1);
      const view = await b.viewState("w");
      const answer = view.value.entries
        .flatMap((entry) => (ToolResultEntry.is(entry) ? [textOf(entry.model?.[0])] : []))
        .at(-1);
      view.dispose();
      expect(answer).toContain("hello b");
      expect(answer).not.toContain("schedule");

      // A busy worker and a taken name refuse.
      await b.messageWorker("w", "hold", "hold:w", "followUp");
      await waitFor(async () => (await b.workers())[0]?.busy === true);
      await expect(b.handOff("w", a.id)).rejects.toThrow("busy");
      await b.stopWorker("w");
      await a.startWorker("w", "another", "start:w2");
      await expect(b.handOff("w", a.id)).rejects.toThrow("already has a worker named w");
    } finally {
      await backend.close();
    }
  });

  it("lets fronts see and message each other and hand workers over, and keeps workers out", async () => {
    const value = await setup();
    const sections: string[] = [];
    const ids = { a: "", b: "" };
    const tool = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    route(value.faux, (request) => {
      sections.push(sectionTexts(request.messages, "roots").join("\n"));
      const last = lastMessage(request.messages);
      if (last?.role !== "user") return fauxAssistantMessage("ok");
      switch (textOf(last)) {
        case "tell b":
          return tool("message_root", { root: ids.b, message: "hi from a" });
        case "list":
          return tool("list_roots", {});
        case "give w":
          return tool("hand_off_worker", { name: "w", root: ids.b });
        case "sneak":
          return tool("message_root", { root: ids.a, message: "from a worker" });
        default:
          return fauxAssistantMessage("ok");
      }
    });
    const { backend } = await openBackend(value);
    try {
      ids.a = await backend.currentRoot();
      const a = backend.root(ids.a);
      await a.submit("alone", "alone", "followUp");
      await idle(a);
      // One root: no roots section, so today's prompt is unchanged.
      expect(sections.at(-1)).toBe("");

      ids.b = await backend.createRoot("create:b");
      const b = backend.root(ids.b);
      await a.submit("tell b", "tell", "followUp");
      await idle(a);
      await waitFor(async () =>
        (await inputs(b)).some((text) => parseRootNotice(text)?.text === "hi from a"),
      );
      await idle(b);
      expect((await inputs(b)).filter((text) => parseRootNotice(text) !== undefined)).toHaveLength(
        1,
      );
      expect(
        sections.some(
          (text) => text.includes(`You are root ${ids.a}`) && text.includes(`- ${ids.b}`),
        ),
      ).toBe(true);

      await a.submit("list", "list", "followUp");
      await idle(a);
      const listed: unknown = JSON.parse(
        textOf((await toolResults(await a.conversation())).at(-1)),
      );
      expect(listed).toMatchObject([
        { id: ids.a, you: true, front: "working" },
        { id: ids.b, front: "idle", workers: [], goals: [] },
      ]);

      await a.startWorker("w", "first brief", "start:w");
      await waitFor(async () => (await a.workers())[0]?.busy === false);
      await a.submit("give w", "give", "followUp");
      await idle(a);
      expect(await b.workers()).toMatchObject([{ name: "w" }]);

      await b.startWorker("x", "sneak", "start:x");
      await waitFor(async () => {
        const view = await b.viewState("x");
        const results = view.value.entries.flatMap((entry) =>
          ToolResultEntry.is(entry) ? [textOf(entry.model?.[0])] : [],
        );
        view.dispose();
        return results.some((text) => text.includes("Only a root's front"));
      });
      expect((await inputs(a)).some((text) => text.includes("from a worker"))).toBe(false);
    } finally {
      await backend.close();
    }
  });
});
