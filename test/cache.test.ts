import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type Provider,
} from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import type { ClaudeConfig, ModelRole } from "../src/core/config.ts";
import {
  callTools,
  cleanup,
  fauxRole,
  front,
  lastMessage,
  openClaudeModels,
  prepareHome,
  route,
  setup,
  simulatedClaudeCode,
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
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
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

  // A plugin added while conversations run appends its tools, and patches only the plugins' section, also after a
  // restart: Durable redeclares every tool when their order changes, and re-sends every section after a new one.
  it("appends a home plugin's direct tool, patches only the plugins section, and keeps both across a restart", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
    );
    prepareHome(home);
    await mkdir(join(home, "plugins", "base"), { recursive: true });
    await writeFile(
      join(home, "plugins", "base", "index.js"),
      `export default (monchu) => monchu.registerSection("state", () => "base state");`,
    );
    const requests: Message[][] = [];
    route(value.faux, (request) => {
      requests.push(structuredClone([...request.messages]));
      return fauxAssistantMessage("ok");
    });
    const turn = async (backend: Monchu, text: string) => {
      const count = requests.length;
      await (await front(backend)).submit(text, `cache:${text}`, "followUp");
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
      await mkdir(join(home, "plugins", "probe"), { recursive: true });
      await writeFile(
        join(home, "plugins", "probe", "index.js"),
        `import { defineTool, Type } from "monchu/plugin";
export default (monchu) => {
  monchu.registerTool(defineTool({ name: "probe_now", description: "Probe", parameters: Type.Object({}), exposure: "direct", execute: async () => ({ content: [] }) }));
  monchu.registerSection("state", () => "probe state");
};`,
      );
      await backend.reload();
      await turn(backend, "after reload");
    } finally {
      await backend.close();
    }
    backend = await Monchu.open(home, value.faux.provider);
    try {
      await turn(backend, "after restart");
    } finally {
      await backend.close();
    }
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1] ?? [];
      expect(requests[i]?.slice(0, previous.length), `request ${i}`).toEqual(previous);
    }
    const later = (requests.at(-1) ?? []).slice(1).filter((message) => message.role === "system");
    expect(
      later.map((message) => [
        ...Object.keys(message.sections ?? {}),
        ...(message.toolsAdded ?? []).map((tool) => tool.name),
        ...(message.toolsRemoved ?? []).map((tool) => `-${tool.name}`),
      ]),
    ).toEqual([["plugins", "probe_now"]]);
    const plugins = later[0]?.sections?.plugins;
    expect(plugins).toContain("<base_state>\nbase state\n</base_state>");
    expect(plugins).toContain("<probe_state>\nprobe state\n</probe_state>");
  });
});

/**
 * Each way a provider caches, simulated where Monchu can't see the request itself. Request-prefix providers (the
 * Anthropic API, Codex, OpenRouter and the rest of pi-ai's) cache what Monchu sends, which faux compares per session.
 * Claude Code sends its own session file, so its simulation keeps one the way Claude Code does and caches by TTL.
 * A new kind of provider cache gets a simulation here.
 */
type CacheSimulation = {
  role: ModelRole;
  provider(): Provider;
  /** Forget everything cached. */
  bust(): void;
  /** The TTL of each request, where the provider chooses one. */
  ttls?: string[];
};

const claudeConfig: ClaudeConfig = {
  executable: process.execPath,
  plan: "pro",
  longContextExtraUsage: false,
};

function fauxSimulation(answer: Answer): CacheSimulation {
  const respond = (request: { messages: readonly Message[] }) => {
    const messages = request.messages.filter((message) => message.role !== "system");
    let start = messages.length;
    while (start > 0 && messages[start - 1]?.role !== "user") start--;
    const round = messages.slice(start).filter((message) => message.role === "assistant").length;
    const content = answer(textOf(messages[start - 1]), round);
    return fauxAssistantMessage(content, {
      stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    });
  };
  let faux = fauxProvider();
  route(faux, respond);
  return {
    role: fauxRole,
    provider: () => faux.provider,
    bust: () => {
      faux = fauxProvider();
      route(faux, respond);
    },
  };
}

function claudeSimulation(home: string, answer: Answer, overage: boolean): CacheSimulation {
  const simulated = simulatedClaudeCode(home, claudeConfig, answer, { overage });
  return {
    role: { provider: "claude-code", modelId: "claude-sonnet-4-6", thinkingLevel: "high" },
    provider: () => simulated.provider,
    bust: simulated.bust,
    ttls: simulated.ttls,
  };
}

type Answer = (prompt: string, round: number) => AssistantMessage["content"];

describe("prompt cache, for every way a provider caches", () => {
  it.each([
    {
      name: "request-prefix providers (faux)",
      simulate: (_home: string, answer: Answer) => fauxSimulation(answer),
    },
    {
      name: "Claude Code within the subscription's limits",
      simulate: (home: string, answer: Answer) => claudeSimulation(home, answer, false),
    },
    {
      name: "Claude Code drawing on overage",
      simulate: (home: string, answer: Answer) => claudeSimulation(home, answer, true),
    },
  ])(
    "$name: each reply reads the previous prompt across tool rounds, a home edit and restarts idle and mid-turn, and a miss after a restart is flagged",
    async ({ simulate }) => {
      const value = await setup();
      const home = join(value.directory, "home");
      await mkdir(home);
      prepareHome(home);
      await writeFile(join(home, "FRONT.md"), "FRONT BEFORE");
      const marker = join(home, "tool-started");
      const command = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('${marker}', 'ready'); setTimeout(() => {}, 4000)"`;
      let calls = 0;
      const call = (name: string, args: Record<string, string>) =>
        fauxToolCall(name, args, { id: `toolu_${++calls}` });
      const answer: Answer = (prompt, round) => {
        if ((prompt === "tool" || prompt === "block") && round === 0)
          return [call("list_goals", {})];
        if (prompt === "block" && round === 1) return [call("bash", { command })];
        return [{ type: "text", text: "ok" }];
      };
      const simulation = simulate(home, answer);
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: simulation.role,
          worker: simulation.role,
          plugins: { classifier: null },
          claude: claudeConfig,
        }),
      );
      if (simulation.role.provider === "claude-code")
        await openClaudeModels(home, simulation.provider(), "sk-ant-oat01-simulated-token");
      const answered = async (backend: Monchu) => {
        const view = await (await front(backend)).viewState();
        const count = view.value.entries
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "assistant" && textOf(message) === "ok").length;
        view.dispose();
        return count;
      };
      const turn = async (backend: Monchu, text: string) => {
        const before = await answered(backend);
        await (await front(backend)).submit(text, `cache:${text}`, "followUp");
        await waitFor(async () => (await answered(backend)) > before);
      };
      const replies = async (backend: Monchu) =>
        (await backend.logs({ limit: 200, scope: "core.model" })).map(
          (reply) => reply.attributes ?? {},
        );
      let backend = await Monchu.open(home, simulation.provider());
      try {
        await turn(backend, "hello");
        await turn(backend, "tool");
        await writeFile(join(home, "FRONT.md"), "FRONT EDITED");
        await turn(backend, "edited");
      } finally {
        await backend.close();
      }
      backend = await Monchu.open(home, simulation.provider());
      let answers = 0;
      try {
        await turn(backend, "after restart");
        answers = await answered(backend);
        await (await front(backend)).submit("block", "cache:block", "followUp");
        await waitFor(async () => {
          try {
            return (await readFile(marker, "utf8")) === "ready";
          } catch {
            return false;
          }
        });
      } finally {
        // Mid-turn: the model's tool is still running.
        await backend.close();
      }
      backend = await Monchu.open(home, simulation.provider());
      try {
        await waitFor(async () => (await answered(backend)) > answers);
        await turn(backend, "after");
        const all = await replies(backend);
        expect(all.length).toBeGreaterThanOrEqual(9);
        expect(all.filter((reply) => reply.cacheMiss === true)).toEqual([]);
        for (let i = 1; i < all.length; i++)
          expect(
            Number(all[i]?.cacheRead),
            `reply ${i} of ${JSON.stringify(all)}`,
          ).toBeGreaterThanOrEqual(
            Number(all[i - 1]?.cacheRead) + Number(all[i - 1]?.cacheWrite) - 1,
          );
        // Where the provider reports how it reached its cache (Claude Code's session), no reply re-renders history.
        expect(all.map((reply) => reply.cachePath)).not.toContain("rebuild");
        // A TTL Claude Code chose for itself never goes back from 5m to 1h: 1h requests read nothing 5m ones wrote.
        const ttls = simulation.ttls ?? [];
        expect(ttls.slice(ttls.indexOf("5m") < 0 ? ttls.length : ttls.indexOf("5m"))).not.toContain(
          "1h",
        );
      } finally {
        await backend.close();
      }
      // The first reply after a restart has no earlier reply in memory; a miss there is still flagged.
      simulation.bust();
      backend = await Monchu.open(home, simulation.provider());
      try {
        await turn(backend, "busted");
        expect((await replies(backend)).at(-1)?.cacheMiss).toBe(true);
      } finally {
        await backend.close();
      }
    },
  );
});
