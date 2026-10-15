import {
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/backend.ts";
import { loadConfig } from "../src/config.ts";
import {
  cleanup,
  fauxRole,
  lastMessage,
  route,
  prepareHome,
  setup,
  textOf,
  waitFor,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

/** A real backend on faux roles in `<directory>/home`, isolated from the user's homes. */
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

describe("backend", () => {
  it.each([false, true])(
    "ignores Pi resources in the real source entry point (smoke=%s)",
    async (smoke) => {
      const value = await setup();
      const home = smoke
        ? await mkdtemp(join(tmpdir(), "monchu-smoke-"))
        : join(value.directory, ".monchu");
      prepareHome(home);
      await mkdir(value.agentDir, { recursive: true });
      for (const name of ["auth.json", "settings.json", "models.json"])
        await writeFile(join(value.agentDir, name), "decoy: not valid JSON");
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
            {
              env: {
                ...process.env,
                HOME: value.directory,
                USERPROFILE: value.directory,
                MONCHU_DEV_FAUX: smoke ? "1" : "0",
                ...(smoke ? { MONCHU_DEV_HOME: home } : {}),
                PI_OFFLINE: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 15000,
            },
          );
          let output = "";
          child.stdout.on("data", (data: Buffer) => {
            output += data.toString();
          });
          child.stderr.on("data", (data: Buffer) => {
            output += data.toString();
          });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, output }));
        },
      );
      expect(result, result.output).toMatchObject({ code: 1 });
      expect(result.output).toContain("TUI needs an interactive terminal");
      for (const name of ["auth.json", "settings.json", "models.json"])
        expect(await readFile(join(value.agentDir, name), "utf8")).toBe("decoy: not valid JSON");
      const auth: unknown = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      expect(auth).toEqual({});
      if (smoke) {
        await expect(
          readFile(join(value.directory, ".monchu", "owner.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const config: unknown = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
        expect(config).toMatchObject({
          front: { provider: "faux" },
          worker: { provider: "faux" },
          classifier: null,
        });
      }
    },
    20000,
  );

  it("owns auth independently of a decoy Pi directory and uses private provider login", async () => {
    const value = await setup();
    await mkdir(value.agentDir, { recursive: true });
    const decoy = join(value.agentDir, "auth.json");
    await writeFile(decoy, "not valid JSON: must not be read or written");
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
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
    prepareHome(home);
    const backend = await Monchu.open(home, provider);
    try {
      const prompts: string[] = [];
      await backend.login("faux", "api_key", {
        prompt: async (prompt) => {
          prompts.push(prompt.type);
          return "private-test-key";
        },
        notify: () => {},
      });
      expect(prompts).toEqual(["secret"]);
      const auth: unknown = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      expect(auth).toEqual({ faux: { type: "api_key", key: "private-test-key" } });
      expect(await readFile(decoy, "utf8")).toBe("not valid JSON: must not be read or written");
      const view = await backend.viewState();
      expect(view.value.entries).toEqual([]);
      view.dispose();
    } finally {
      await backend.close();
    }
  });

  it("forces Codex device-code selection through its provider without browser callbacks", async () => {
    const value = await setup({ provider: "openai-codex" });
    const home = join(value.directory, "home");
    await mkdir(home);
    const role = { ...fauxRole, provider: "openai-codex" };
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: role, worker: role, classifier: null }),
    );
    let method = "";
    const provider = createProvider({
      id: value.faux.provider.id,
      models: value.faux.models,
      api: value.faux.provider,
      auth: {
        oauth: {
          name: "Faux Codex OAuth",
          login: async (interaction) => {
            method = await interaction.prompt({
              type: "select",
              message: "Method",
              options: [
                { id: "browser", label: "Browser" },
                { id: "device_code", label: "Device" },
              ],
            });
            interaction.notify({
              type: "device_code",
              userCode: "TEST-CODE",
              verificationUri: "https://example.test/device",
            });
            return {
              type: "oauth",
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 3600000,
            };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    prepareHome(home);
    const backend = await Monchu.open(home, provider);
    try {
      const events: string[] = [];
      await backend.login("openai-codex", "oauth", {
        prompt: () => Promise.reject(new Error("Browser prompt must not be used")),
        notify: (event) => events.push(event.type),
      });
      expect(method).toBe("device_code");
      expect(events).toEqual(["device_code"]);
      expect(await readFile(join(home, "auth.json"), "utf8")).toContain("test-refresh");
    } finally {
      await backend.close();
    }
  });

  it("applies reloaded roles, tools and stream options to later requests, not an in-flight generation", async () => {
    const value = await setup({
      models: [{ id: "faux-1" }, { id: "next-front" }, { id: "next-worker" }],
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: {
      text: string;
      model: string;
      timeout: number | undefined;
      tools: string[];
    }[] = [];
    route(value.faux, async (request, options, _state, model) => {
      const text = textOf(lastMessage(request.messages));
      requests.push({
        text,
        model: model.id,
        timeout: options?.timeoutMs,
        tools: getCurrentTools(request.messages).map((tool) => tool.name),
      });
      if (text === "held") {
        started.resolve();
        await release.promise;
      }
      return fauxAssistantMessage("ok");
    });
    const { home, backend } = await openBackend(value);
    const state = await backend.viewState();
    try {
      await backend.submit("held", "held");
      await started.promise;
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: { ...fauxRole, modelId: "next-front" },
          worker: { ...fauxRole, modelId: "next-worker" },
          classifier: null,
          settings: {
            theme: "light",
            httpIdleTimeoutMs: 1234,
            retry: { enabled: false },
            compaction: { enabled: false },
            defaultTools: ["read"],
          },
        }),
      );
      const before = backend.settings;
      const reload = backend.reload();
      expect(backend.reload()).toBe(reload);
      await reload;
      expect(backend.settings).not.toBe(before);
      expect(backend.settings.theme).toBe("light");
      expect(backend.settings.retry.enabled).toBe(false);
      expect(backend.settings.compaction.enabled).toBe(false);
      release.resolve();
      await waitFor(() =>
        state.value.entries.some((entry) =>
          entry.model?.some((message) => message.role === "assistant"),
        ),
      );
      await backend.submit("next", "next");
      await waitFor(() => requests.some((request) => request.text === "next"));
      await backend.startWorker("new", "worker request", "new-worker");
      await waitFor(() => requests.some((request) => request.text === "worker request"));
      expect(requests.find((request) => request.text === "held")?.model).toBe("faux-1");
      expect(requests.find((request) => request.text === "held")?.timeout).not.toBe(1234);
      expect(requests.find((request) => request.text === "held")?.tools).toContain("bash");
      expect(requests.find((request) => request.text === "next")).toMatchObject({
        model: "next-front",
        timeout: 1234,
      });
      expect(requests.find((request) => request.text === "next")?.tools).not.toContain("bash");
      expect(requests.find((request) => request.text === "worker request")?.model).toBe(
        "next-worker",
      );
    } finally {
      release.resolve();
      state.dispose();
      await backend.close();
    }
  });

  // Windows has PowerShell installed; exercise both Durable shell tools there.
  describe.each(
    (process.platform === "win32" ? ["bash", "powershell"] : ["bash"]).flatMap((tool) => [
      { tool, nested: false },
      { tool, nested: true },
    ]),
  )("$tool child environment (codemode=$nested)", ({ tool, nested }) => {
    it("inherits the process environment unchanged in shell tools", async () => {
      const value = await setup();
      const command = `${tool === "powershell" ? "& " : ""}${JSON.stringify(process.execPath)} -e "console.log(JSON.stringify({HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,MONCHU_TEST_SHELL_ENV:process.env.MONCHU_TEST_SHELL_ENV}))"`;
      route(value.faux, (request) =>
        lastMessage(request.messages)?.role === "user"
          ? fauxAssistantMessage(
              nested
                ? fauxToolCall("codemode", {
                    code: `text(await tools.${tool}({ command: ${JSON.stringify(command)} }))`,
                  })
                : fauxToolCall(tool, { command }),
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("done"),
      );
      await writeFile(
        join(value.directory, "config.json"),
        JSON.stringify({
          front: fauxRole,
          worker: fauxRole,
          classifier: null,
          settings: { defaultTools: [tool] },
        }),
      );
      const backend = await Monchu.open(value.directory, value.faux.provider);
      const state = await backend.viewState();
      try {
        await backend.submit("check env", "env");
        await waitFor(() =>
          state.value.entries.some((entry) =>
            entry.model?.some(
              (message) => message.role === "assistant" && textOf(message) === "done",
            ),
          ),
        );
        const results = state.value.entries
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "toolResult")
          .map(textOf)
          .join("\n");
        const childEnv: unknown = JSON.parse(results.trim());
        expect(childEnv).toEqual({
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          MONCHU_TEST_SHELL_ENV: "unchanged-process-value",
        });
      } finally {
        state.dispose();
        await backend.close();
      }
    });
  });
  it("delivers home skill warnings with collision locations to subscribers and the log", async () => {
    const value = await setup();
    const homeSkills = join(value.directory, "home", "skills");
    const invalidPath = join(homeSkills, "broken", "SKILL.md");
    const firstPath = join(homeSkills, "monchu", "SKILL.md");
    const secondPath = fileURLToPath(new URL("../skills/monchu/SKILL.md", import.meta.url));
    await mkdir(join(homeSkills, "broken"), { recursive: true });
    await mkdir(join(homeSkills, "monchu"), { recursive: true });
    await writeFile(invalidPath, "---\nname: broken\n---\nno description");
    await writeFile(firstPath, "---\nname: monchu\ndescription: home workflow\n---\nbody");
    const { home, backend } = await openBackend(value);
    try {
      const warnings: string[] = [];
      const unsubscribe = backend.onReport((message) => warnings.push(message));
      unsubscribe();
      expect(
        warnings.some(
          (message) => message.includes("description is required") && message.includes(invalidPath),
        ),
      ).toBe(true);
      const collision = warnings.find((message) => message.includes('name "monchu" collision'));
      expect(collision).toContain(firstPath);
      expect(collision).toContain(secondPath);
      expect(collision).toContain("winner:");
      expect(collision).toContain("loser:");
      await expect(
        readFile(join(value.agentDir, "skills", "monchu", "SKILL.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await backend.close();
    }
    // Reports deliberately doesn't await logging; wait for the actual file contents, not a delay.
    await expect
      .poll(async () => {
        const log = await readFile(join(home, "monchu.log"), "utf8");
        return [invalidPath, firstPath, secondPath].every((item) => log.includes(item));
      })
      .toBe(true);
  });

  it("logs reload failures and reports reload warnings, keeping the previous front on failure", async () => {
    const value = await setup();
    const requests: string[] = [];
    route(value.faux, (_request, _options, _state, model) => {
      requests.push(model.id);
      return fauxAssistantMessage("ok");
    });
    const { home, backend } = await openBackend(value);
    const state = await backend.viewState();
    const warnings: string[] = [];
    const unsubscribe = backend.onReport((message) => warnings.push(message));
    try {
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: { ...fauxRole, provider: "openai-codex", modelId: "no-such-model" },
          worker: fauxRole,
          classifier: null,
        }),
      );
      await expect(backend.reload()).rejects.toThrow(
        "Monchu has no configured model openai-codex/no-such-model",
      );
      // The failure is logged before reload rejects; the caller shows it, so subscribers don't get it twice.
      expect(await readFile(join(home, "monchu.log"), "utf8")).toContain(
        "Reload failed: Monchu has no configured model openai-codex/no-such-model",
      );
      expect(warnings.filter((message) => message.includes("Reload failed"))).toEqual([]);
      await backend.submit("after failure", "after-failure");
      await waitFor(() => requests.length === 1);
      expect(requests).toEqual(["faux-1"]);

      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: fauxRole,
          worker: fauxRole,
          classifier: null,
          settings: { defaultTools: ["fffind"] },
        }),
      );
      await backend.reload();
      const warning =
        "Monchu defaultTools selects none of read, write, edit, bash; Monchu has no file or shell built-ins";
      expect(warnings).toContain(warning);
      // Reports deliberately doesn't await logging; wait for the actual file contents, not a delay.
      await expect
        .poll(async () => (await readFile(join(home, "monchu.log"), "utf8")).includes(warning))
        .toBe(true);
    } finally {
      unsubscribe();
      state.dispose();
      await backend.close();
    }
  });

  it("gives workers the root's memory and goal tools: a worker inherits the root's extension selection", async () => {
    const value = await setup();
    const tools = new Map<string, string[]>();
    route(value.faux, async (request) => {
      const text = textOf(lastMessage(request.messages));
      tools.set(
        text,
        getCurrentTools(request.messages).map((tool) => tool.name),
      );
      return fauxAssistantMessage("ok");
    });
    const { backend } = await openBackend(value);
    try {
      await backend.submit("root request", "root");
      await backend.startWorker("w", "worker request", "start:w");
      await waitFor(() => tools.has("root request") && tools.has("worker request"));
      for (const name of ["root request", "worker request"])
        expect(tools.get(name)).toEqual(
          expect.arrayContaining([
            "memory",
            "update_goal",
            "list_goals",
            "codemode",
            "start_worker",
            "reload_extensions",
          ]),
        );
      expect(tools.get("worker request")).toEqual(expect.arrayContaining(["post_update"]));
    } finally {
      await backend.close();
    }
  });

  it("changes directories only while idle, stops a worker explicitly, and refuses reload once closing", async () => {
    const value = await setup();
    // A worker holds its run until it is stopped; everything else answers at once.
    route(value.faux, async (request, options) => {
      if (textOf(lastMessage(request.messages)) === "hold") {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Worker hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
      }
      return fauxAssistantMessage("ok");
    });
    const { backend } = await openBackend(value);
    try {
      const project = join(value.directory, "project");
      await mkdir(project);
      expect(await backend.changeDirectory(project)).toBe(project);
      // A new worker starts in the root's directory.
      await backend.startWorker("w", "hold", "start:w");
      expect(await backend.workers()).toMatchObject([{ name: "w", cwd: project, busy: true }]);
      await expect(backend.changeDirectory(value.directory, "w")).rejects.toThrow("idle");
      await expect(backend.stopWorker("missing")).rejects.toThrow("No worker named missing");

      await backend.stopWorker("w");
      expect(await backend.workers()).toMatchObject([{ name: "w", busy: false }]);
      expect(await backend.changeDirectory(value.directory, "w")).toBe(value.directory);
      expect(await backend.workers()).toMatchObject([{ name: "w", cwd: value.directory }]);
    } finally {
      await backend.close();
    }
    await expect(backend.reload()).rejects.toThrow("Monchu is closing");
  });

  it("keeps a picked root model through reload and reopen, and saves role defaults only with Ctrl+S", async () => {
    const value = await setup({
      models: [
        { id: "faux-1" },
        { id: "picked", reasoning: true },
        { id: "saved", reasoning: true },
        { id: "edited", reasoning: true },
      ],
    });
    const requests: { text: string; model: string }[] = [];
    route(value.faux, async (request, _options, _state, model) => {
      const text = textOf(lastMessage(request.messages));
      requests.push({ text, model: model.id });
      if (text === "spawn")
        return fauxAssistantMessage(
          [fauxToolCall("start_worker", { name: "w3", task: "fourth" })],
          {
            stopReason: "toolUse",
          },
        );
      return fauxAssistantMessage("ok");
    });
    const opened = await openBackend(value);
    const { home } = opened;
    let backend = opened.backend;
    const path = join(home, "config.json");
    const sent = async (text: string) => {
      await backend.submit(text, text);
      await waitFor(() => requests.some((request) => request.text === text));
      return requests.find((request) => request.text === text)?.model;
    };
    try {
      // Enter changes only the root; config.json is untouched.
      const written = await readFile(path, "utf8");
      await backend.pickModel({ model: { provider: "faux", modelId: "picked" } }, false);
      expect(await readFile(path, "utf8")).toBe(written);
      expect(await backend.modelChoice()).toMatchObject({
        model: { id: "picked" },
        defaults: { modelId: "faux-1" },
      });
      expect(await sent("first")).toBe("picked");
      // Reload applies an edited default only to the fields not picked for the root.
      await writeFile(
        path,
        JSON.stringify({
          front: { ...fauxRole, modelId: "edited", thinkingLevel: "high" },
          worker: fauxRole,
          classifier: null,
        }),
      );
      await backend.reload();
      expect(await backend.modelChoice()).toMatchObject({
        model: { id: "picked" },
        thinkingLevel: "high",
        defaults: { modelId: "edited" },
      });
      await backend.close();
      backend = await Monchu.open(home, value.faux.provider);
      expect(await backend.modelChoice()).toMatchObject({
        model: { id: "picked" },
        thinkingLevel: "high",
      });
      expect(await sent("after reopen")).toBe("picked");
      // A fresh context keeps the pick too.
      await backend.reset(undefined);
      expect((await backend.modelChoice()).model?.id).toBe("picked");

      // Ctrl+S on a worker saves the worker default: new workers get it, existing ones keep theirs.
      await backend.startWorker("w0", "first worker", "w0");
      await backend.startWorker("w1", "second worker", "w1");
      await backend.pickModel({ model: { provider: "faux", modelId: "saved" } }, true, "w1");
      expect((await loadConfig(home)).worker).toEqual({ ...fauxRole, modelId: "saved" });
      expect((await backend.modelChoice("w0")).model?.id).toBe("faux-1");
      expect(await backend.modelChoice("w1")).toMatchObject({
        model: { id: "saved" },
        defaults: { modelId: "saved" },
      });
      await backend.startWorker("w2", "third worker", "w2");
      expect((await backend.modelChoice("w2")).model?.id).toBe("saved");
      await sent("spawn");
      await waitFor(async () => (await backend.workers()).some((worker) => worker.name === "w3"));
      expect((await backend.modelChoice("w3")).model?.id).toBe("saved");
      await backend.pickModel({ thinkingLevel: "low" }, false, "w0");
      expect((await backend.modelChoice("w0")).thinkingLevel).toBe("low");
      expect((await loadConfig(home)).worker.thinkingLevel).toBe("off");

      // Ctrl+S on the root saves the front default and clears the pick, so later edits apply on reload.
      await backend.pickModel({ model: { provider: "faux", modelId: "saved" } }, true);
      expect((await loadConfig(home)).front).toEqual({
        ...fauxRole,
        modelId: "saved",
        thinkingLevel: "high",
      });
      const config = await loadConfig(home);
      await writeFile(path, JSON.stringify({ ...config, front: fauxRole }));
      await backend.reload();
      expect(await backend.modelChoice()).toMatchObject({
        model: { id: "faux-1" },
        thinkingLevel: "off",
      });

      // A thinking level the shown conversation's model supports is saved only if the role default's model does too.
      await backend.pickModel({ model: { provider: "faux", modelId: "picked" } }, false);
      expect((await backend.modelChoice()).thinkingLevels).toContain("high");
      const unsaved = await readFile(path, "utf8");
      await expect(backend.pickModel({ thinkingLevel: "high" }, true)).rejects.toThrow(
        "faux/faux-1 does not support thinking level high (supported: off); the front default was not saved",
      );
      expect(await readFile(path, "utf8")).toBe(unsaved);
      expect(await backend.modelChoice()).toMatchObject({
        thinkingLevel: "off",
        defaults: { thinkingLevel: "off" },
      });
      await backend.pickModel({ thinkingLevel: "high" }, false);
      expect((await backend.modelChoice()).thinkingLevel).toBe("high");

      // Unknown models fail at the boundary without writing.
      const before = await readFile(path, "utf8");
      await expect(
        backend.pickModel({ model: { provider: "faux", modelId: "missing" } }, true),
      ).rejects.toThrow("no configured model faux/missing");
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await backend.close();
    }
  }, 30000);
});
