import { createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import { openCoreHost } from "../src/server/host.ts";
import { attachSocket, serveSocket, socketPath } from "../src/server/socket.ts";
import { presentation } from "../src/ui/state.ts";
import { cleanup, fauxRole, prepareHome, route, setup, textOf, waitFor, front } from "./support.ts";

afterEach(cleanup);

describe("local socket", () => {
  it("serves a client the same core over the wire: views, input, workers, login prompts, and a reconnect", async () => {
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
    route(value.faux, (request) =>
      fauxAssistantMessage(`echo: ${textOf(request.messages.at(-1))}`),
    );
    const backend = await Monchu.open(home, provider);
    const path = socketPath(home);
    const reports: string[] = [];
    backend.addNotes("seeded a test home");
    const host = await openCoreHost(backend);
    let server = await serveSocket(host, backend, path);
    const attached = await attachSocket(path, (error) => reports.push(error.message));
    try {
      if (attached === undefined) throw new Error("Nothing answered on the socket");
      const { client } = attached;
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(client.home).toBe(backend.home);
      // A remote client starts on the same first screen: the core's startup notes.
      expect(client.notes).toEqual(["seeded a test home"]);
      expect(client.restartsProcess).toBe(false);
      expect(client.model({ provider: "faux", modelId: "faux-1" })?.id).toBe("faux-1");

      // The root's view streams over the wire as delta ops and matches the core's own.
      const view = await (await front(client)).viewState();
      await (await front(client)).submit("hello over the socket", "remote:1", "followUp");
      await waitFor(() =>
        view.value.entries.some((entry) =>
          (entry.model ?? []).some((message) => textOf(message) === "echo: hello over the socket"),
        ),
      );
      const local = await (await front(backend)).viewState();
      await waitFor(() => !presentation(local.value).busy && !presentation(view.value).busy);
      expect(view.value.entries.map((entry) => entry.id)).toEqual(
        local.value.entries.map((entry) => entry.id),
      );
      local.dispose();

      // Workers start from the core and show up for the client, with their own view.
      await (await front(backend)).startWorker("reader", "inspect", "start:reader");
      await waitFor(async () =>
        (await (await front(client)).workers()).some((worker) => worker.name === "reader"),
      );
      const worker = await (await front(client)).viewState("reader");
      await waitFor(() => worker.value.entries.length > 0);
      worker.dispose();

      // A login's prompt reaches only the client that started it, which answers it.
      const prompts: string[] = [];
      await client.login("faux", "api_key", {
        prompt: async (prompt) => {
          prompts.push(prompt.type);
          return "remote-test-key";
        },
        notify: () => {},
      });
      expect(prompts).toEqual(["secret"]);
      const auth: unknown = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      expect(auth).toEqual({ faux: { type: "api_key", key: "remote-test-key" } });

      // Telemetry and logs cross the wire too: the client's record lands in the core's log, which it can read back.
      client.record("tui", "ready", { ms: 321 });
      await waitFor(async () =>
        (await client.logs({ limit: 20, scope: "tui" })).some(
          (record) => record.attributes?.ms === 321,
        ),
      );
      expect((await client.logs({ limit: 50, scope: "server.socket" }))[0]?.body).toBe(
        "client attached",
      );

      // A restart request needs someone on the core's side who can restart it, and is answered before it happens.
      await expect(client.restart()).rejects.toThrow("Nothing here can restart this Monchu");
      let requested = 0;
      const stopRequests = backend.onRestartRequest(() => requested++);
      await client.restart();
      await waitFor(() => requested === 1);
      // /update checks before anything closes: a checkout is updated by hand, so the core refuses and keeps running.
      expect(client.release).toMatchObject({ version: backend.release.version, updating: null });
      await expect(client.update("v1.x")).rejects.toThrow("Not a release: v1.x");
      await expect(client.update("edge")).rejects.toThrow(
        process.platform === "win32" ? "Windows keeps" : /^monchu runs the checkout at/,
      );
      expect(requested).toBe(1);
      expect(backend.plannedUpdate).toBeUndefined();
      // The outcome of the update the core came back from reaches clients with its release.
      backend.updated("updated · 1.0.0 → 1.0.1");
      await waitFor(() => client.release.outcome === "updated · 1.0.0 → 1.0.1");
      stopRequests();

      // The server goes away and comes back: the client reconnects and its view picks up again.
      const notices: string[] = [];
      const stop = client.onReport((message) => notices.push(message));
      await server.close();
      await waitFor(() => notices.includes("connection to Monchu lost · reconnecting"));
      server = await serveSocket(host, backend, path);
      await waitFor(() => notices.includes("reconnected to Monchu"));
      await (await front(client)).submit("after reconnect", "remote:2", "followUp");
      await waitFor(() =>
        view.value.entries.some((entry) =>
          (entry.model ?? []).some((message) => textOf(message) === "echo: after reconnect"),
        ),
      );
      stop();
      view.dispose();
      expect(reports, JSON.stringify(reports)).toEqual([]);
    } finally {
      await attached?.close();
      await server.close();
      await host.close();
      await backend.close();
    }
  }, 30_000);

  it("finds nothing to attach to when no core serves the home", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    expect(await attachSocket(socketPath(home), () => {})).toBeUndefined();
  });
});
