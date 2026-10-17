import type { Message } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import {
  callTools,
  cleanup,
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

describe("prompt cache", () => {
  // Providers cache a request's prefix. Every request must extend the previous one exactly: a prompt change is a
  // later system message, never an edit of what was already sent.
  it("keeps every request an extension of the previous one across a home edit, a goal change, a tool load and a restart", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    await writeFile(join(home, "FRONT.md"), "FRONT BEFORE");
    const requests: Message[][] = [];
    const answer = callTools({
      goal: {
        tool: "update_goal",
        args: {
          id: "cache",
          title: "Cache",
          kind: "endeavor",
          workstream: "testing",
          next: "ship",
        },
      },
      load: { tool: "tool_search", args: { query: "browser" } },
      restart: { tool: "request_restart", args: { reason: "cache test" } },
    });
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return answer(request);
    });
    const turn = async (backend: Monchu, text: string) => {
      const count = requests.length;
      await (await front(backend)).submit(text, `cache:${text}`, "followUp");
      // A tool call takes a second request; the turn is done once the last one answered with text.
      await waitFor(async () => {
        if (requests.length <= count) return false;
        const entries = await (await front(backend)).viewState();
        const last = lastMessage(entries.value.entries.flatMap((entry) => entry.model ?? []));
        entries.dispose();
        return last?.role === "assistant" && textOf(last) === "ok";
      });
    };
    let backend = await Monchu.open(home, value.faux.provider);
    try {
      await turn(backend, "hello");
      await writeFile(join(home, "FRONT.md"), "FRONT EDITED");
      await turn(backend, "goal");
      await turn(backend, "load");
      await turn(backend, "restart");
    } finally {
      await backend.close();
    }
    backend = await Monchu.open(home, value.faux.provider);
    try {
      await turn(backend, "after restart");
      // Faux simulates a prompt cache per provider session, as the reply log reports it.
      const replies = await backend.logs({ limit: 100, scope: "core.model" });
      expect(replies.some((reply) => reply.attributes?.cacheMiss === true)).toBe(false);
      // Every request reads all of the previous one from cache, restart included. Faux counts a prompt as its cached
      // part plus what it wrote, each rounded up.
      const prompts = replies.map(
        ({ attributes }) => Number(attributes?.cacheRead) + Number(attributes?.cacheWrite) - 1,
      );
      for (let i = 1; i < replies.length; i++)
        expect(Number(replies[i]?.attributes?.cacheRead), `reply ${i}`).toBeGreaterThanOrEqual(
          prompts[i - 1] ?? 0,
        );
    } finally {
      await backend.close();
    }
    expect(requests.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1] ?? [];
      expect(requests[i]?.slice(0, previous.length), `request ${i}`).toEqual(previous);
    }
    // Each change reached the model as one later system message that patches only what changed: nothing dynamic
    // re-renders on every request, and a section that appears does not re-send the others.
    const later = (requests.at(-1) ?? []).slice(1).filter((message) => message.role === "system");
    expect(
      later.map((message) => [
        ...Object.keys(message.sections ?? {}),
        ...(message.toolsAdded ?? []).map((tool) => tool.name),
      ]),
    ).toEqual([["home"], ["goals"], ["agent_browser"], ["restart_request"]]);
    expect(JSON.stringify(later)).toContain("FRONT EDITED");
    expect(JSON.stringify(later)).toContain("[cache] Cache");
    expect(
      later.some((message) => message.toolsAdded?.some((tool) => tool.name === "agent_browser")),
    ).toBe(true);
  });
});
