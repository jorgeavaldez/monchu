import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectRemote } from "../src/api/connect.ts";
import { Server, type Principal } from "../src/api/contract.ts";
import { Monchu } from "../src/core/backend.ts";
import { openServerHost } from "../src/server/host.ts";
import { Log } from "../src/telemetry/log.ts";
import { presentation } from "../src/ui/state.ts";
import {
  cleanup,
  fauxRole,
  front,
  memoryCore,
  memoryDial,
  prepareHome,
  route,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

async function openServer(opened: (backend: Monchu) => void = () => {}) {
  const value = await setup();
  const home = join(value.directory, "home");
  await mkdir(home);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  prepareHome(home);
  route(value.faux, (request) => fauxAssistantMessage(`echo: ${textOf(request.messages.at(-1))}`));
  const core = memoryCore(async () => {
    const backend = await Monchu.open(home, value.faux.provider);
    opened(backend);
    return backend;
  });
  let stops = 0;
  const server = openServerHost(core, {
    mode: "background",
    log: new Log(home),
    stop: () => stops++,
    update: () => {},
  });
  const attach = async (principal: Principal) => {
    const dialer = memoryDial(server.host, principal);
    const attached = await connectRemote(dialer.dial, { onError: () => {} });
    if (attached === undefined) throw new Error("Nothing answered");
    return { ...attached, links: dialer.links };
  };
  return {
    core,
    server,
    attach,
    stops: () => stops,
    close: async () => {
      await core.stop();
      await server.close();
    },
  };
}

describe("server", () => {
  it("starts the core for the first client, and keeps every client's socket across a restart", async () => {
    const { core, attach, close } = await openServer();
    try {
      // Nothing starts the core but a client that needs it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(core.starts).toBe(0);
      const {
        client,
        links,
        close: detach,
      } = await attach({
        kind: "client",
        connection: "a",
        person: true,
      });
      expect(core.starts).toBe(1);
      const notices: string[] = [];
      client.onReport((message) => notices.push(message));
      // A page that shows the link as a dot hears its states, and none of its notices.
      const states: string[] = [];
      client.onConnection((state) => states.push(state));
      const quiet: string[] = [];
      client.onReport((message) => quiet.push(message), { connection: false });
      const root = await front(client);
      const view = await root.viewState();
      await root.submit("before", "server:1", "followUp");
      const said = (text: string) =>
        view.value.entries.some((entry) =>
          (entry.model ?? []).some((message) => textOf(message) === `echo: ${text}`),
        );
      await waitFor(() => said("before") && !presentation(view.value).busy);

      // `/restart` replaces the core; the client's link to the server stays, and its view carries on.
      await client.restart();
      await waitFor(() => notices.includes("reconnected to Monchu"));
      expect(core.starts).toBe(2);
      expect(
        notices.filter((notice) => /Monchu/.test(notice) && !notice.includes("home file")),
      ).toEqual(["connection to Monchu lost · reconnecting", "reconnected to Monchu"]);
      expect(states).toEqual(["lost", "live"]);
      expect(
        quiet.filter((notice) => notice.includes("connection") || notice.includes("reconnected")),
      ).toEqual([]);
      expect(links.map((link) => link.closed)).toEqual([false]);
      expect(said("before")).toBe(true);
      await root.submit("after", "server:2", "followUp");
      await waitFor(() => said("after"));
      view.dispose();
      await detach();
    } finally {
      await close();
    }
  }, 30_000);

  it("reloads the core through the server, keeping clients' views, and catches a restarted core up", async () => {
    const cores: Monchu[] = [];
    const { server, attach, close } = await openServer((backend) => cores.push(backend));
    try {
      const {
        client,
        links,
        close: detach,
      } = await attach({
        kind: "client",
        connection: "a",
        person: true,
      });
      const notices: string[] = [];
      client.onReport((message) => notices.push(message));
      const root = await front(client);
      const view = await root.viewState();
      const said = (text: string) =>
        view.value.entries.some((entry) =>
          (entry.model ?? []).some((message) => textOf(message) === `echo: ${text}`),
        );
      await root.submit("before", "server:1", "followUp");
      await waitFor(() => said("before") && !presentation(view.value).busy);
      const first = server.host.codeVersion;

      // One reload moves the server and the core to the next code version; the client's socket and view stay.
      expect(await client.reload()).toEqual(["extensions", "session"]);
      expect(server.host.codeVersion).toBeGreaterThan(first);
      expect(cores[0]?.host.codeVersion).toBe(server.host.codeVersion);
      await root.submit("reloaded", "server:2", "followUp");
      await waitFor(() => said("reloaded") && !presentation(view.value).busy);
      expect(links.map((link) => link.closed)).toEqual([false]);
      expect(
        notices.filter((notice) => /Monchu/.test(notice) && !notice.includes("home file")),
      ).toEqual([]);

      // A new core starts behind the server; the server brings it to its code version before anything reaches it.
      await client.restart();
      await waitFor(() => notices.includes("reconnected to Monchu"));
      await root.submit("restarted", "server:3", "followUp");
      await waitFor(() => said("restarted"));
      expect(cores[1]?.host.codeVersion).toBe(server.host.codeVersion);
      view.dispose();
      await detach();
    } finally {
      await close();
    }
  }, 30_000);

  it("tells clients the server's state, lets a person stop it, and a service login only look", async () => {
    const { attach, stops, close } = await openServer();
    try {
      const person = await attach({ kind: "client", connection: "a", person: true });
      const service = await attach({ kind: "client", connection: "b", person: false });
      await person.client.currentRoot();
      const owner = await person.client.host.get(Server, {});
      expect(owner.state.value).toMatchObject({ mode: "background", core: { state: "running" } });
      const viewer = await service.client.host.get(Server, {});
      expect(viewer.variant).toBe("viewer");
      if (owner.variant !== "owner") throw new Error("A person's server is the owner's");
      await owner.stop();
      await waitFor(() => stops() === 1);
      owner.release();
      viewer.release();
      await person.close();
      await service.close();
    } finally {
      await close();
    }
  });
});
