import { createProvider } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { OUTDATED_CLIENT, OUTDATED_CORE, parseMessage, PROTOCOL, Rpc } from "../src/api/rpc.ts";
import { Monchu } from "../src/core/backend.ts";
import { Published, serveRpc, type Implementation } from "../src/server/rpc.ts";
import { serveConnection } from "../src/server/session.ts";
import { cleanup, fauxRole, prepareHome, setup, waitFor } from "./support.ts";

afterEach(cleanup);

/** A client and a served connection, with every message passed asynchronously as over a socket. */
function connect(
  rpc: Rpc,
  serve: (send: (text: string) => void) => { receive(text: string): void; dispose(): void },
) {
  const sent: (Record<string, unknown> | undefined)[] = [];
  const served = serve((text) => {
    sent.push(parseMessage(text));
    queueMicrotask(() => rpc.receive(text));
  });
  const hello = rpc.attach({ send: (text) => queueMicrotask(() => served.receive(text)) });
  return { served, sent, hello };
}

type Doc = { items: { id: number; text: string }[]; title: string };

const contract = {
  methods: { add: Type.Tuple([Type.Number(), Type.Number()]) },
  topics: { doc: Type.Null(), other: Type.Null() },
};

function implementation(
  doc: Published<Doc>,
  other: Published<{ n: number }>,
): Implementation<typeof contract> {
  return {
    methods: { add: ([a, b]) => a + b },
    topics: { doc: () => doc.source(), other: () => other.source() },
  };
}

describe("rpc", () => {
  it("runs a call only with arguments that pass its schema, and never a prototype member", async () => {
    const doc = new Published<Doc>({ items: [], title: "" });
    const other = new Published({ n: 0 });
    const rpc = new Rpc();
    const { hello } = connect(rpc, (send) => serveRpc(contract, implementation(doc, other), send));
    await hello;
    expect(await rpc.call<number>("add", [1, 2])).toBe(3);
    await expect(rpc.call("add", [1, "2"])).rejects.toThrow("Invalid arguments");
    await expect(rpc.call("add", { 0: 1, 1: 2 })).rejects.toThrow("Invalid message");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      await expect(rpc.call(name, [])).rejects.toThrow(`Unknown method ${name}`);
    await expect(rpc.watch("missing", null)).rejects.toThrow("Unknown topic missing");
    await expect(rpc.watch("doc", 1)).rejects.toThrow("Invalid arguments");
  });

  it("tells an older client to reload, refuses another protocol, and a client refuses a core that does", async () => {
    const doc = new Published<Doc>({ items: [], title: "" });
    const other = new Published({ n: 0 });
    const sent: (Record<string, unknown> | undefined)[] = [];
    const served = serveRpc(contract, implementation(doc, other), (text) =>
      sent.push(parseMessage(text)),
    );
    // The old Chord envelope, and any request before a hello.
    served.receive(JSON.stringify({ t: "invoke", id: 1, call: { service: "monchu.session" } }));
    served.receive(JSON.stringify({ t: "call", id: 2, method: "add", args: [1, 2] }));
    expect(sent).toEqual([
      { t: "error", id: 1, message: OUTDATED_CLIENT },
      { t: "error", id: 2, message: OUTDATED_CLIENT },
    ]);
    // Another protocol hears this one's, and nothing it sends runs.
    served.receive(JSON.stringify({ t: "hello", protocol: PROTOCOL + 1 }));
    served.receive(JSON.stringify({ t: "call", id: 3, method: "add", args: [1, 2] }));
    expect(sent.slice(2)).toEqual([{ t: "hello", protocol: PROTOCOL }]);

    const rpc = new Rpc();
    const attached = rpc.attach({
      send: () => queueMicrotask(() => rpc.receive(JSON.stringify({ t: "hello", protocol: 0 }))),
    });
    await expect(attached).rejects.toThrow(OUTDATED_CORE);
  });

  it("sends a snapshot, then ops that rebuild every value, until unwatched or ended", async () => {
    const doc = new Published<Doc>({ items: [{ id: 1, text: "one" }], title: "start" });
    const other = new Published({ n: 0 });
    const rpc = new Rpc();
    const { hello, sent } = connect(rpc, (send) =>
      serveRpc(contract, implementation(doc, other), send),
    );
    await hello;
    const watch = await rpc.watch<Doc>("doc", null);
    const seen: Doc[] = [];
    watch.subscribe((value) => seen.push(value));
    expect(watch.value).toEqual(doc.value);
    const revisions: Doc[] = [
      { items: [{ id: 1, text: "one, edited" }], title: "start" },
      {
        items: [
          { id: 1, text: "one, edited" },
          { id: 2, text: "two" },
        ],
        title: "start",
      },
      { items: [{ id: 2, text: "two" }], title: "renamed" },
      { items: [], title: "" },
    ];
    for (const revision of revisions) {
      doc.set(revision);
      await waitFor(() => JSON.stringify(watch.value) === JSON.stringify(revision));
    }
    // One snapshot, then only ops; an unchanged value sends nothing.
    doc.set({ items: [], title: "" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((frame) => frame?.t === "snap")).toHaveLength(1);
    expect(sent.filter((frame) => frame?.t === "ops")).toHaveLength(revisions.length);
    expect(seen.at(-1)).toEqual({ items: [], title: "" });

    // Unwatched: nothing more is sent for it.
    watch.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = sent.length;
    doc.set({ items: [], title: "after" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.length).toBe(before);

    // Ended by the core: the last value stays readable and says why.
    const ending = await rpc.watch<{ n: number }>("other", null);
    other.set({ n: 1 });
    await waitFor(() => ending.value.n === 1);
    other.end("closed");
    expect(await ending.ended).toBe("closed");
    expect(ending.value).toEqual({ n: 1 });
  });

  it("keeps a watch's last value through a reconnect until the fresh snapshot", async () => {
    const doc = new Published<Doc>({ items: [], title: "first" });
    const other = new Published({ n: 0 });
    const rpc = new Rpc();
    const first = connect(rpc, (send) => serveRpc(contract, implementation(doc, other), send));
    await first.hello;
    const watch = await rpc.watch<Doc>("doc", null);
    const seen: string[] = [];
    watch.subscribe((value) => seen.push(value.title));

    rpc.detach("Connection to Monchu lost");
    first.served.dispose();
    await expect(rpc.call("add", [1, 2])).rejects.toThrow("Not connected to Monchu");
    doc.set({ items: [], title: "while away" });
    expect(watch.value.title).toBe("first");

    const second = connect(rpc, (send) => serveRpc(contract, implementation(doc, other), send));
    await second.hello;
    await waitFor(() => watch.value.title === "while away");
    doc.set({ items: [{ id: 1, text: "new" }], title: "back" });
    await waitFor(() => watch.value.title === "back");
    expect(seen).toEqual(["first", "while away", "back"]);
  });

  it("keeps each connection's logins its own, and checks a real call's arguments", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    const provider = createProvider({
      id: value.faux.provider.id,
      models: value.faux.models,
      api: value.faux.provider,
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async () => ({ auth: {} }),
          login: async (interaction) => ({
            type: "api_key",
            key: await interaction.prompt({ type: "secret", message: "Test key" }),
          }),
        },
      },
    });
    const backend = await Monchu.open(home, provider);
    const owner = new Rpc();
    const stranger = new Rpc();
    const first = connect(owner, (send) => serveConnection(backend, { updates: true }, send));
    const second = connect(stranger, (send) => serveConnection(backend, { updates: true }, send));
    try {
      await Promise.all([first.hello, second.hello]);
      const id = await owner.call<number>("login", ["faux", "api_key"]);
      const login = await owner.watch<{ prompt: { request: { type: string } } | null }>("login", [
        id,
      ]);
      await waitFor(() => login.value.prompt?.request.type === "secret");
      await expect(stranger.watch("login", [id])).rejects.toThrow(
        `No login ${id} on this connection`,
      );
      await expect(stranger.call("loginAnswer", [id, 1, "stolen"])).rejects.toThrow(
        `No login ${id} on this connection`,
      );
      await owner.call("loginCancel", [id]);

      const root = await stranger.call<string>("currentRoot", []);
      await expect(stranger.call("submit", [root, 42, "request", "followUp"])).rejects.toThrow(
        "Invalid arguments",
      );
      await expect(stranger.call("submit", [root, "hi", "request", "later"])).rejects.toThrow(
        "Invalid arguments",
      );
    } finally {
      first.served.dispose();
      second.served.dispose();
      await backend.close();
    }
  });
});
