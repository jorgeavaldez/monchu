import { createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Frame } from "@earendil-works/chord";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../src/api/attachments.ts";
import { connectRemote, OUTDATED_CORE } from "../src/api/connect.ts";
import type { Principal } from "../src/api/contract.ts";
import { Monchu } from "../src/core/backend.ts";
import { MemoryStore } from "../src/core/secrets/vault.ts";
import { openCoreHost, type CoreHost } from "../src/server/host.ts";
import { presentation } from "../src/ui/state.ts";
import {
  cleanup,
  fauxRole,
  front,
  memoryDial,
  prepareHome,
  route,
  setup,
  tamper,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const person = (connection: string): Principal => ({ kind: "client", connection, person: true });

/** A core over a test home, whose faux provider also takes an API key login. */
async function openCore() {
  const value = await setup();
  const home = join(value.directory, "home");
  await mkdir(home);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
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
  route(value.faux, (request) => fauxAssistantMessage(`echo: ${textOf(request.messages.at(-1))}`));
  const backend = await Monchu.open(home, provider, { secretStore: new MemoryStore() });
  const host = await openCoreHost(backend);
  return {
    backend,
    host,
    close: async () => {
      await host.close();
      await backend.close();
    },
  };
}

async function attach(
  host: CoreHost,
  principal: Principal | (() => Principal),
  rewrite: Parameters<typeof tamper>[1] = {},
  /** Redials wait for it: a core that is still restarting. */
  redial: Promise<void> = Promise.resolve(),
) {
  const dialer = memoryDial(host, principal, (link) => tamper(link, rewrite));
  let dials = 0;
  const dial = async () => {
    if (dials++ > 0) await redial;
    return dialer.dial();
  };
  const attached = await connectRemote(dial, { onError: () => {} });
  if (attached === undefined) throw new Error("Nothing answered");
  return { ...attached, links: dialer.links };
}

/** A call frame's member and arguments replaced, as a client outside the contract would send them. */
const calling =
  (member: string, replace: { member?: string; args?: unknown }) =>
  (frame: Frame): Frame =>
    frame.t === "call" && frame.member === member ? { ...frame, ...replace } : frame;

describe("wire", () => {
  it("runs a call only with arguments that pass its schema, and never a prototype member", async () => {
    const core = await openCore();
    let rewrite: (frame: Frame) => Frame = (frame) => frame;
    const { client, close } = await attach(core.host, person("a"), {
      send: (frame) => rewrite(frame),
    });
    try {
      const root = client.root(await client.currentRoot());
      expect(await root.workers()).toEqual([]);
      rewrite = calling("submit", { args: { message: 42, requestId: "r", whenBusy: "followUp" } });
      await expect(root.submit("hi", "r", "followUp")).rejects.toThrow(/^invalid\/args/);
      rewrite = calling("submit", { args: { message: "hi", requestId: "r", whenBusy: "later" } });
      await expect(root.submit("hi", "r", "followUp")).rejects.toThrow(/^invalid\/args/);
      for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        rewrite = calling("workers", { member: name });
        await expect(root.workers()).rejects.toThrow(/^not_in_variant/);
      }
      rewrite = (frame) => frame;
      await root.submit("checked", "r:1", "followUp");
    } finally {
      await close();
      await core.close();
    }
  });

  it("refuses a core or a client that speaks another protocol", async () => {
    const core = await openCore();
    try {
      const hello = (frame: Frame): Frame =>
        frame.t === "hello" ? { ...frame, protocol: (frame.protocol ?? 1) + 1 } : frame;
      // The client says another version: the core closes, and the client learns it is outdated.
      await expect(attach(core.host, person("a"), { send: hello })).rejects.toThrow(OUTDATED_CORE);
      // The core says another version: the client refuses it itself.
      await expect(attach(core.host, person("b"), { receive: hello })).rejects.toThrow(
        OUTDATED_CORE,
      );
    } finally {
      await core.close();
    }
  });

  it("sends a view's snapshot, then ops that rebuild it", async () => {
    const core = await openCore();
    const frames: Frame[] = [];
    const { client, close } = await attach(core.host, person("a"), {
      receive: (frame) => {
        if (frame.t === "state" && frame.m === "view") frames.push(frame);
        return frame;
      },
    });
    try {
      const root = await front(client);
      const view = await root.viewState();
      await root.submit("hello over the wire", "wire:1", "followUp");
      const local = await (await front(core.backend)).viewState();
      await waitFor(
        () =>
          view.value.entries.some((entry) =>
            (entry.model ?? []).some((message) => textOf(message) === "echo: hello over the wire"),
          ) &&
          !presentation(local.value).busy &&
          !presentation(view.value).busy,
      );
      await waitFor(() => JSON.stringify(view.value) === JSON.stringify(local.value));
      const kinds = frames.map((frame) => (frame.t === "state" ? frame.as : frame.t));
      expect(kinds[0]).toBe("snap");
      expect(kinds.slice(1).every((kind) => kind === "ops")).toBe(true);
      expect(kinds.length).toBeGreaterThan(2);
      local.dispose();
      view.dispose();
    } finally {
      await close();
      await core.close();
    }
  });

  it("keeps the last values through a reconnect, fails calls meanwhile, then picks up fresh", async () => {
    const core = await openCore();
    const back = Promise.withResolvers<void>();
    const { client, close, links } = await attach(core.host, person("a"), {}, back.promise);
    try {
      const id = await client.currentRoot();
      const labels: string[] = [];
      const stop = await client.watchRoots((roots) => {
        const label = roots.find((root) => root.id === id)?.label;
        if (label !== undefined && label !== "" && labels.at(-1) !== label) labels.push(label);
      });
      await client.renameRoot(id, "first");
      await waitFor(() => labels.at(-1) === "first");
      const notices: string[] = [];
      const stopNotices = client.onReport((message) => notices.push(message));

      // The core drops the connection, as a restart does, and answers again only later.
      links[0]?.close("restart");
      await waitFor(() => notices.includes("connection to Monchu lost · reconnecting"));
      await expect(client.renameRoot(id, "lost")).rejects.toThrow("Not connected to Monchu");
      await core.backend.renameRoot(id, "while away");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(labels.at(-1)).toBe("first");
      expect(client.release.version).toBe(core.backend.release.version);
      back.resolve();
      await waitFor(() => notices.includes("reconnected to Monchu"));
      await waitFor(() => labels.at(-1) === "while away");
      await client.renameRoot(id, "back");
      await waitFor(() => labels.at(-1) === "back");
      expect(labels).toEqual(["first", "while away", "back"]);
      stop();
      stopNotices();
    } finally {
      await close();
      await core.close();
    }
  });

  it("gets the session again when the other side releases it, so calls work again", async () => {
    const core = await openCore();
    let session: number | undefined;
    let release = false;
    const { client, close } = await attach(core.host, person("a"), {
      send: (frame) => {
        if (frame.t === "hold" && JSON.stringify(frame.token).includes("monchu.session"))
          session ??= frame.id;
        return frame;
      },
      // The next frame for the session's hold arrives as its end, released, as a stopping core's relay may say it.
      receive: (frame) => {
        if (!release || frame.t !== "state" || frame.hold !== session) return frame;
        release = false;
        return { t: "gone", id: frame.hold, error: { code: "released", message: "released" } };
      },
    });
    try {
      const id = await client.currentRoot();
      const states: string[] = [];
      client.onConnection((state) => states.push(state));
      release = true;
      await core.backend.renameRoot(id, "released");
      await waitFor(() => states.includes("live"));
      expect(states).toEqual(["lost", "live"]);
      await client.renameRoot(id, "back");
    } finally {
      await close();
      await core.close();
    }
  });

  it("tells a client whose contracts the core outgrew that it is outdated, without waiting", async () => {
    const core = await openCore();
    let session: number | undefined;
    let outgrown = false;
    const errors: string[] = [];
    const dialer = memoryDial(core.host, person("a"), (link) =>
      tamper(link, {
        send: (frame) => {
          if (frame.t === "hold" && JSON.stringify(frame.token).includes("monchu.session"))
            session ??= frame.id;
          return frame;
        },
        // As a core updated to a new Session version answers this client's reference.
        receive: (frame) =>
          outgrown && frame.t === "state" && frame.hold === session
            ? { t: "gone", id: frame.hold, error: { code: "upgrade_required", message: "changed" } }
            : frame,
      }),
    );
    const attached = await connectRemote(dialer.dial, {
      onError: (error) => errors.push(error.message),
    });
    try {
      const id = await attached?.client.currentRoot();
      if (id === undefined) throw new Error("Nothing answered");
      outgrown = true;
      await core.backend.renameRoot(id, "outgrown");
      await waitFor(() => errors.length > 0, 2000);
      expect(errors).toEqual([OUTDATED_CORE]);
    } finally {
      await attached?.close();
      await core.close();
    }
  });

  it("uploads an attachment through dropped connections, before it starts and between its chunks", async () => {
    const core = await openCore();
    const back = Promise.withResolvers<void>();
    let cut: (() => void) | undefined;
    const { client, close, links } = await attach(
      core.host,
      person("a"),
      {
        // The second chunk never arrives: the link drops under it, as a phone suspending the page does.
        send: (frame) => {
          if (cut === undefined || frame.t !== "call" || frame.member !== "upload") return frame;
          const args = frame.args;
          if (typeof args !== "object" || args === null || !("offset" in args) || args.offset === 0)
            return frame;
          queueMicrotask(cut);
          cut = undefined;
          return undefined;
        },
      },
      back.promise,
    );
    try {
      const root = client.root(await client.currentRoot());
      const notices: string[] = [];
      const stopNotices = client.onReport((message) => notices.push(message));
      const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 1000).map((_, index) => index % 251);
      const stored = (attachment: { id: string }) =>
        readFile(join(core.backend.home, "attachments", attachment.id));

      // Picked while the connection is down: the upload waits for it instead of failing.
      links[0]?.close("suspended");
      await waitFor(() => notices.includes("connection to Monchu lost · reconnecting"));
      const waiting = root.attach("picked.bin", bytes);
      back.resolve();
      await waitFor(() => notices.includes("reconnected to Monchu"));
      const first = await waiting;
      expect(first).toMatchObject({ name: "picked.bin", size: bytes.length });
      expect((await stored(first)).equals(bytes)).toBe(true);

      // Dropped between chunks: the chunk goes again once the core is back.
      notices.length = 0;
      cut = () => links.at(-1)?.close("suspended");
      const second = root.attach("cut.bin", bytes);
      await waitFor(() => notices.includes("reconnected to Monchu"));
      expect(await second).toMatchObject({ name: "cut.bin", size: bytes.length });
      expect((await stored(await second)).equals(bytes)).toBe(true);
      stopNotices();
    } finally {
      await close();
      await core.close();
    }
  });

  it("answers a slow client's calls while its state waits, and catches it up once it reads", async () => {
    const core = await openCore();
    // The client stops acknowledging what it got, as one behind a stalled tunnel does.
    let stalled = false;
    const { client, close } = await attach(core.host, person("a"), {
      send: (frame) => (stalled && frame.t === "ack" ? undefined : frame),
    });
    try {
      const root = await front(client);
      const view = await root.viewState();
      stalled = true;
      // Enough streamed text to fill the window many times over.
      const long = "x".repeat(400_000);
      await root.submit(long, "slow:1", "followUp");
      const local = await (await front(core.backend)).viewState();
      await waitFor(() => !presentation(local.value).busy && local.value.entries.length > 1);
      // Calls never wait behind state.
      expect(await root.workers()).toEqual([]);
      expect(JSON.stringify(view.value).length).toBeLessThan(JSON.stringify(local.value).length);
      stalled = false;
      await root.submit("again", "slow:2", "followUp");
      await waitFor(() => JSON.stringify(view.value) === JSON.stringify(local.value), 20_000);
      local.dispose();
      view.dispose();
    } finally {
      await close();
      await core.close();
    }
  }, 30_000);

  it("keeps each connection's logins its own, and a service login can't update", async () => {
    const core = await openCore();
    const owner = await attach(core.host, person("owner"));
    let rewrite: (frame: Frame) => Frame = (frame) => frame;
    const stranger = await attach(core.host, person("stranger"), {
      send: (frame) => rewrite(frame),
    });
    const service = await attach(
      core.host,
      { kind: "client", connection: "service", person: false },
      { send: (frame) => rewrite(frame) },
    );
    try {
      const prompted = Promise.withResolvers<string>();
      const answer = Promise.withResolvers<string>();
      const login = owner.client.login("faux", "api_key", {
        prompt: (prompt) => {
          prompted.resolve(prompt.type);
          return answer.promise;
        },
        notify: () => {},
      });
      expect(await prompted.promise).toBe("secret");
      // Another connection can't answer it: the login is the owner's connection's alone.
      rewrite = calling("jobs", {
        member: "loginAnswer",
        args: { login: "1", prompt: 1, value: "stolen" },
      });
      await expect(stranger.client.jobs()).rejects.toThrow("No login 1 on this connection");
      rewrite = (frame) => frame;
      answer.resolve("owner-key");
      await login;

      await expect(service.client.update("edge")).rejects.toThrow(
        "Only a person's login can update Monchu, not a service token",
      );
      // Even sent by hand, `update` isn't a method of the service's session.
      rewrite = calling("restart", { member: "update", args: { release: "edge" } });
      await expect(service.client.restart()).rejects.toThrow(/^not_in_variant/);
    } finally {
      await owner.close();
      await stranger.close();
      await service.close();
      await core.close();
    }
  });

  it("keeps a login through a dropped connection, for the client's next one to finish", async () => {
    const core = await openCore();
    const back = Promise.withResolvers<void>();
    let dials = 0;
    // Every socket is a new connection, as the server stamps them.
    const { client, close, links } = await attach(
      core.host,
      () => person(`phone-${dials++}`),
      {},
      back.promise,
    );
    try {
      const notices: string[] = [];
      const stopNotices = client.onReport((message) => notices.push(message));
      const prompted = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<string>();
      const login = client.login("faux", "api_key", {
        prompt: () => {
          prompted.resolve();
          return answer.promise;
        },
        notify: () => {},
      });
      await prompted.promise;
      // The page goes away to fetch the key, and its socket with it.
      links[0]?.close("suspended");
      await waitFor(() => notices.includes("connection to Monchu lost · reconnecting"));
      back.resolve();
      await waitFor(() => notices.includes("reconnected to Monchu"));
      answer.resolve("fetched-key");
      await login;
      expect(dials).toBeGreaterThan(1);
      const auth: unknown = JSON.parse(
        await readFile(join(core.backend.home, "auth.json"), "utf8"),
      );
      expect(auth).toEqual({ faux: { type: "api_key", key: "fetched-key" } });

      // Declining a prompt cancels the login rather than failing it.
      await expect(
        client.login("faux", "api_key", {
          prompt: () => Promise.reject(new Error("closed")),
          notify: () => {},
        }),
      ).rejects.toThrow("Login cancelled");
      stopNotices();
    } finally {
      await close();
      await core.close();
    }
  });

  it("takes a secret from a person only, never echoing its value", async () => {
    const core = await openCore();
    const owner = await attach(core.host, person("owner"));
    let rewrite: (frame: Frame) => Frame = (frame) => frame;
    const ownerByHand = await attach(core.host, person("by-hand"), {
      send: (frame) => rewrite(frame),
    });
    const service = await attach(
      core.host,
      { kind: "client", connection: "service", person: false },
      { send: (frame) => rewrite(frame) },
    );
    const value = "wire-secret-value-123";
    try {
      const states: string[] = [];
      const stop = await owner.client.watchSecrets((state) => states.push(JSON.stringify(state)));
      await expect(
        owner.client.setSecret({ name: "WIRE_TOKEN", kind: "value", value }),
      ).resolves.toBeUndefined();
      await waitFor(() => states.some((state) => state.includes("WIRE_TOKEN")));
      expect(states.join("\n")).not.toContain(value);
      stop();

      await expect(
        service.client.setSecret({ name: "STOLEN", kind: "value", value }),
      ).rejects.toThrow("Only a person's login can change secrets, not a service token");
      // Even sent by hand, the service's session has no secret methods.
      rewrite = calling("restart", {
        member: "setSecret",
        args: { input: { name: "STOLEN", kind: "value", value } },
      });
      await expect(service.client.restart()).rejects.toThrow(/^not_in_variant/);
      rewrite = calling("restart", { member: "deleteSecret", args: { name: "WIRE_TOKEN" } });
      await expect(service.client.restart()).rejects.toThrow(/^not_in_variant/);
      // A malformed entry is refused without quoting the value back.
      rewrite = calling("restart", {
        member: "setSecret",
        args: { input: { name: "BAD", kind: "other", value } },
      });
      const refused = await ownerByHand.client.restart().then(
        () => "",
        (error: unknown) => String(error),
      );
      expect(refused).toMatch(/invalid\/args/);
      expect(refused).not.toContain(value);
    } finally {
      await owner.close();
      await ownerByHand.close();
      await service.close();
      await core.close();
    }
  });
});
