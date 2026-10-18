import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shortId } from "../src/api/ids.ts";
import { Farm, loadFarmConfig, Sessions } from "../src/core/browser/farm.ts";
import { createRemoteBrowser } from "../src/core/browser/tool.ts";
import {
  cleanup,
  context,
  lastMessage,
  open,
  route,
  setup,
  textOf,
  waitFor,
  type Setup,
} from "./support.ts";

afterEach(async () => {
  delete process.env.TEST_FARM_TOKEN;
  await cleanup();
});

type Seen = {
  method: string;
  path: string;
  owner: string | undefined;
  auth: string | undefined;
  body: unknown;
};

/**
 * A browser farm on loopback that speaks the farm's API for one session and one tab: enough to see what the tool sends
 * and what it makes of the answers. `emit` sends an event on every open stream.
 */
async function fakeFarm() {
  const seen: Seen[] = [];
  const streams = new Set<ServerResponse>();
  let session:
    | { id: string; owner: string; label: string; phase: "agent" | "human"; since?: string }
    | undefined;
  const view = (owner: string | undefined) =>
    session === undefined
      ? undefined
      : {
          id: session.id,
          owner: `phone/${session.owner}`,
          label: session.label,
          yours: owner === session.owner,
          profile: "default",
          phase: session.phase,
          created: "2026-10-18T00:00:00.000Z",
          idleSeconds: 3,
          tabs: [{ id: `${session.id}.1`, url: "https://example.com/", title: "Example Domain" }],
          ...(session.since === undefined
            ? {}
            : {
                handoff: {
                  reason: "log in",
                  since: session.since,
                  link: "https://farm.test/view/ticket/",
                },
              }),
        };
  const page = (snapshot: number) => ({
    tab: "k3.1",
    url: "https://example.com/",
    title: "Example Domain",
    snapshot,
    text: `- heading "Example Domain" [s${snapshot}e1]`,
    more: null,
    chars: 30,
  });
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const owner = req.headers["farm-owner"];
      const path = req.url ?? "";
      const method = req.method ?? "";
      seen.push({
        method,
        path,
        owner: typeof owner === "string" ? owner : undefined,
        auth: req.headers.authorization,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      if (req.headers.authorization !== "Bearer farm-token")
        return json(res, 401, { error: "unauthorized" });
      const who = typeof owner === "string" ? owner : undefined;
      if (path === "/v1/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: hello\ndata: {"boot":"b1"}\n\n`);
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      if (path === "/v1/sessions" && method === "GET")
        return json(res, 200, {
          boot: "b1",
          client: "phone",
          sessions: session === undefined ? [] : [view(who)],
        });
      if (path === "/v1/sessions" && method === "POST") {
        session = { id: "k3", owner: who ?? "", label: "front", phase: "agent" };
        return json(res, 201, { ...view(who), tabs: [] });
      }
      if (path === "/v1/sessions/k3/tabs" && method === "POST") return json(res, 200, page(1));
      if (path === "/v1/sessions/k3/handoff" && method === "POST" && session !== undefined) {
        session.phase = "human";
        session.since = "2026-10-18T00:01:00.000Z";
        return json(res, 200, view(who));
      }
      if (path === "/v1/sessions/k3" && method === "GET") return json(res, 200, view(who));
      if (path.startsWith("/v1/sessions/k3") && method === "DELETE") {
        session = undefined;
        return json(res, 200, { closed: true, session: "k3" });
      }
      json(res, 404, { error: "not_found", message: `no route ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake farm has no port");
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    emit(type: string, data: Record<string, unknown>) {
      if (type === "handoff.done" && session !== undefined) {
        session.phase = "agent";
        delete session.since;
      }
      for (const res of streams)
        res.write(`id: b1:9\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    streams: () => streams.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The front makes `calls` in order, one per user turn; tool results land in `outputs`, later inputs in `heard`. */
function script(value: Setup, calls: ReturnType<typeof fauxToolCall>[]) {
  const heard: string[] = [];
  const outputs = Object.assign<string[], { heard: string[] }>([], { heard });
  const step: FauxResponseStep = (request) => {
    const last = lastMessage(request.messages);
    if (last?.role === "toolResult") {
      outputs.push(textOf(last));
      return fauxAssistantMessage("ok");
    }
    const call = calls.shift();
    if (call !== undefined) return fauxAssistantMessage([call], { stopReason: "toolUse" });
    heard.push(textOf(last));
    return fauxAssistantMessage("heard");
  };
  route(value.faux, step);
  return outputs;
}

async function withFarm(value: Setup, url: string) {
  process.env.TEST_FARM_TOKEN = "farm-token";
  await writeFile(
    join(value.directory, "browser-farm.json"),
    JSON.stringify({ url, token: "${TEST_FARM_TOKEN}", headers: { "x-proxy": "static" } }),
  );
  const config = await loadFarmConfig(value.directory);
  if (config === undefined) throw new Error("no farm config");
  const remote = createRemoteBrowser(new Farm(config, value.vault), value.vault);
  value.registry.install(remote.extension);
  value.registry.install(
    defineExtension({ name: "test.remote-browser", tools: remote.group.tools }),
  );
}

describe("remote browser", () => {
  it("opens a session owned by the calling conversation and shows the page with its header", async () => {
    const farm = await fakeFarm();
    const value = await setup();
    await withFarm(value, farm.url);
    const outputs = script(value, [
      fauxToolCall("remote_browser", { action: "open", url: "example.com" }),
    ]);
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "browse" }, context)).wait(context);
    } finally {
      await harness.close(context);
      await farm.close();
    }
    expect(outputs[0]).toContain("opened session k3");
    expect(outputs[0]).toContain("session k3 · tab k3.1 · phase agent");
    expect(outputs[0]).toContain('- heading "Example Domain" [s1e1]');
    const opened = farm.seen.find((each) => each.method === "POST" && each.path === "/v1/sessions");
    expect(opened?.owner).toBe(shortId(root.id));
    expect(opened?.body).toEqual({ label: "front" });
    expect(farm.seen.every((each) => each.auth === "Bearer farm-token")).toBe(true);
  });

  it("hands the browser to the user and tells the front once they tap done", async () => {
    const farm = await fakeFarm();
    const value = await setup();
    await withFarm(value, farm.url);
    const outputs = script(value, [
      fauxToolCall("remote_browser", { action: "open", url: "https://example.com" }),
      fauxToolCall("remote_browser", { action: "handoff", session: "k3", reason: "log in" }),
    ]);
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "browse" }, context)).wait(context);
      await (await root.submit({ type: "input", content: "hand it over" }, context)).wait(context);
      expect(outputs[1]).toContain("handed session k3 to the user: https://farm.test/view/ticket/");
      await waitFor(() => farm.streams() > 0);
      farm.emit("handoff.done", {
        session: "k3",
        by: "person",
        minutes: 4,
        tabs: [{ id: "k3.1", url: "https://example.com/account", title: "Account" }],
      });
      await waitFor(() =>
        outputs.heard.some((each) => each.includes("finished the browser handoff on session k3")),
      );
      const told = outputs.heard.find((each) => each.includes("finished the browser handoff"));
      expect(told).toContain("Done after 4 min.");
      expect(told).toContain("Tabs now: k3.1 https://example.com/account.");
      expect(told).toContain("take a fresh snapshot");
    } finally {
      await harness.close(context);
      await farm.close();
    }
    expect(
      outputs.heard.filter((each) => each.includes("finished the browser handoff")),
    ).toHaveLength(1);
  });

  it("says how to fix a bad farm file and a refused token", async () => {
    const value = await setup();
    await writeFile(
      join(value.directory, "browser-farm.json"),
      JSON.stringify({ url: "ftp://x", token: "t" }),
    );
    await expect(loadFarmConfig(value.directory)).rejects.toThrow(
      /url must be the farm's http\(s\) URL/,
    );
    const farm = await fakeFarm();
    try {
      const client = new Farm({ url: farm.url, token: "wrong", headers: {} }, value.vault);
      const use = { tool: "test", conversation: "t" };
      await expect(client.call("GET", "/v1/sessions", Sessions, { use })).rejects.toThrow(
        /refused the token/,
      );
      const missing = new Farm(
        { url: farm.url, token: "${NO_SUCH_FARM_SECRET}", headers: {} },
        value.vault,
      );
      await expect(missing.call("GET", "/v1/sessions", Sessions, { use })).rejects.toThrow(
        /neither a Monchu secret nor in the environment/,
      );
    } finally {
      await farm.close();
    }
  });
});
