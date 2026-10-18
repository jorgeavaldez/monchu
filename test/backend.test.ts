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
import { Monchu } from "../src/core/backend.ts";
import { loadConfig } from "../src/core/config.ts";
import { presentation } from "../src/ui/state.ts";
import { parseWorkerNotice, systemNoticeSummary, workerNotice } from "../src/api/notices.ts";
import {
  cleanup,
  fauxRole,
  lastMessage,
  logText,
  route,
  prepareHome,
  setup,
  textOf,
  waitFor,
  type Setup,
  front,
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
    "ignores Pi resources in the real source entry point: serve, then stop (smoke=%s)",
    async (smoke) => {
      const value = await setup();
      const home = smoke
        ? await mkdtemp(join(tmpdir(), "monchu-smoke-"))
        : join(value.directory, ".monchu");
      prepareHome(home);
      await mkdir(value.agentDir, { recursive: true });
      for (const name of ["auth.json", "settings.json", "models.json"])
        await writeFile(join(value.agentDir, name), "decoy: not valid JSON");
      // A plugin whose own timer throws and whose dropped promise rejects: the core is told, and runs on.
      await mkdir(join(home, "plugins", "faulty"), { recursive: true });
      await writeFile(
        join(home, "plugins", "faulty", "index.js"),
        `export default () => {
  setTimeout(() => { throw new Error("timer boom"); }, 50);
  setTimeout(() => void Promise.reject(new Error("promise boom")), 50);
};
`,
      );
      const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
      /** Run the entry point; `until` resolves `seen` once its output contains that text. */
      const run = (args: string[], until?: string) => {
        const child = spawn(process.execPath, [entry, ...args], {
          env: {
            ...process.env,
            HOME: value.directory,
            USERPROFILE: value.directory,
            MONCHU_DEV_FAUX: smoke ? "1" : "0",
            ...(smoke ? { MONCHU_DEV_HOME: home } : {}),
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
          // A cold Windows runner type-strips every source module first; it takes 13-15 s there, for each process.
          timeout: 60_000,
        });
        let output = "";
        const seen = Promise.withResolvers<void>();
        const read = (data: Buffer) => {
          output += data.toString();
          if (until !== undefined && output.includes(until)) seen.resolve();
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        const exited = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => {
            seen.reject(new Error(`exited before "${until}":\n${output}`));
            resolve({ code, output });
          });
        });
        seen.promise.catch(() => {});
        return { seen: seen.promise, exited };
      };

      // A plain `monchu` needs a terminal, and starts nothing without one.
      const plain = await run([]).exited;
      expect(plain, plain.output).toMatchObject({ code: 1 });
      expect(plain.output).toContain("TUI needs an interactive terminal");

      // `serve` runs the server, which forks the core; `stop` closes both.
      const serve = run(["serve"], "core ready");
      await serve.seen;
      await waitFor(async () => {
        const log = await logText(home);
        return ["timer boom", "promise boom"].every((boom) =>
          log.includes(
            `Plugin faulty threw where nothing catches it (its own timer, callback or promise), and Monchu kept running: ${boom}`,
          ),
        );
      }, 30_000);
      const stop = await run(["stop"]).exited;
      expect(stop, stop.output).toMatchObject({ code: 0 });
      expect(stop.output).toContain("stopped the Monchu of");
      const served = await serve.exited;
      expect(served, served.output).toMatchObject({ code: 0 });
      // The core closed normally: it outlived the plugin's faults.
      expect(await logText(home)).toMatch(/\nclosed(\n|$)/);
      // Nothing answers any more.
      expect((await run(["stop"]).exited).output).toContain("no Monchu runs for");

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
    150_000,
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
      const view = await (await front(backend)).viewState();
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
    const state = await (await front(backend)).viewState();
    try {
      await (await front(backend)).submit("held", "held", "followUp");
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
      await (await front(backend)).submit("next", "next", "followUp");
      await waitFor(() => requests.some((request) => request.text === "next"));
      await (await front(backend)).startWorker("new", "worker request", "new-worker");
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

  it("tells the front once per home budget crossing, re-arming when a file falls back under, across restarts", async () => {
    const value = await setup();
    const seen: string[] = [];
    const notices: string[] = [];
    route(value.faux, (request) => {
      const text = textOf(lastMessage(request.messages));
      seen.push(text);
      if (systemNoticeSummary(text) !== undefined) notices.push(text);
      return fauxAssistantMessage("ok");
    });
    let { home, backend } = await openBackend(value);
    const frontFile = join(home, "FRONT.md");
    // Each request renders the home files first; a notice it causes is a follow-up with its own turn.
    const send = async (text: string) => {
      await (await front(backend)).submit(text, text, "followUp");
      await waitFor(() => seen.includes(text));
    };
    try {
      await writeFile(frontFile, "f".repeat(11000));
      await send("one");
      await waitFor(() => notices.length === 1);
      expect(systemNoticeSummary(notices[0] ?? "")).toBe("FRONT.md near the home size budget");
      expect(notices[0]).toContain("FRONT.md: 11000/12000 characters (91%), 1000 left");
      expect(notices[0]).toContain("Nothing is truncated");
      await send("two");
      await writeFile(frontFile, "f".repeat(12100));
      await send("three");
      await waitFor(() => notices.length === 2);
      expect(systemNoticeSummary(notices[1] ?? "")).toBe(
        "FRONT.md at or over the home size budget",
      );
      expect(notices[1]).toContain("FRONT.md: 12100/12000 characters (100%), 100 over its budget");
      await writeFile(frontFile, "small");
      await send("four");
      await writeFile(frontFile, "f".repeat(11000));
      await send("five");
      await waitFor(() => notices.length === 3);
      await backend.close();
      ({ backend } = await openBackend(value));
      await send("six");
      await send("seven");
      expect(notices).toHaveLength(3);
      expect(await logText(home)).toContain(
        "Home budget: FRONT.md at or over the home size budget",
      );
    } finally {
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
      const state = await (await front(backend)).viewState();
      try {
        await (await front(backend)).submit("check env", "env", "followUp");
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
        const log = await logText(home);
        return [invalidPath, firstPath, secondPath].every((item) => log.includes(item));
      })
      .toBe(true);
  });

  it("opens on the defaults when config.json is broken and says what still needs a login", async () => {
    const value = await setup();
    const home = join(value.directory, "broken");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ front: fauxRole, bogus: 1 }));
    prepareHome(home);
    const backend = await Monchu.open(home, value.faux.provider);
    const warnings: string[] = [];
    const unsubscribe = backend.onReport((message) => warnings.push(message));
    try {
      expect(warnings.join("\n")).toContain("unknown fields: bogus. Using the built-in defaults");
      // No role is chosen, so logging in to either default provider is enough.
      expect(await backend.loginNeeds()).toEqual({
        chat: ["openai-codex", "claude-code"],
        anyOf: true,
        classifier: "cloudflare-workers-ai",
      });
    } finally {
      unsubscribe();
      await backend.close();
    }
  });

  it("logs reload failures and reports reload warnings, keeping the previous front on failure", async () => {
    const value = await setup();
    const requests: string[] = [];
    route(value.faux, (_request, _options, _state, model) => {
      requests.push(model.id);
      return fauxAssistantMessage("ok");
    });
    const { home, backend } = await openBackend(value);
    const state = await (await front(backend)).viewState();
    const warnings: string[] = [];
    const unsubscribe = backend.onReport((message) => warnings.push(message));
    try {
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null, bogus: 1 }),
      );
      await expect(backend.reload()).rejects.toThrow("unknown fields: bogus");
      // The failure is logged before reload rejects; the caller shows it, so subscribers don't get it twice.
      expect(await logText(home)).toContain("Reload failed: Invalid");
      expect(warnings.filter((message) => message.includes("Reload failed"))).toEqual([]);
      // A bad model reloads everything else and keeps the running front, with a warning.
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          front: { ...fauxRole, provider: "openai-codex", modelId: "no-such-model" },
          worker: fauxRole,
          classifier: null,
        }),
      );
      await backend.reload();
      expect(warnings).toContainEqual(
        expect.stringContaining(
          "no configured model openai-codex/no-such-model (front); openai-codex has",
        ),
      );
      expect(warnings.join("\n")).toContain("Using faux/faux-1 until config.json is fixed");
      await (await front(backend)).submit("after failure", "after-failure", "followUp");
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
      await expect.poll(async () => (await logText(home)).includes(warning)).toBe(true);
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
      await (await front(backend)).submit("root request", "root", "followUp");
      await (await front(backend)).startWorker("w", "worker request", "start:w");
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
      expect(await (await front(backend)).changeDirectory(project)).toBe(project);
      // A new worker starts in the root's directory.
      await (await front(backend)).startWorker("w", "hold", "start:w");
      expect(await (await front(backend)).workers()).toMatchObject([
        { name: "w", cwd: project, busy: true },
      ]);
      await expect((await front(backend)).changeDirectory(value.directory, "w")).rejects.toThrow(
        "idle",
      );
      await expect((await front(backend)).stopWorker("missing")).rejects.toThrow(
        "No worker named missing",
      );

      await (await front(backend)).stopWorker("w");
      expect(await (await front(backend)).workers()).toMatchObject([{ name: "w", busy: false }]);
      expect(await (await front(backend)).changeDirectory(value.directory, "w")).toBe(
        value.directory,
      );
      expect(await (await front(backend)).workers()).toMatchObject([
        { name: "w", cwd: value.directory },
      ]);
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
      await (await front(backend)).submit(text, text, "followUp");
      await waitFor(() => requests.some((request) => request.text === text));
      return requests.find((request) => request.text === text)?.model;
    };
    try {
      // Enter changes only the root; config.json is untouched.
      const written = await readFile(path, "utf8");
      await (
        await front(backend)
      ).pickModel({ model: { provider: "faux", modelId: "picked" } }, false);
      expect(await readFile(path, "utf8")).toBe(written);
      expect(await (await front(backend)).modelChoice()).toMatchObject({
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
      expect(await (await front(backend)).modelChoice()).toMatchObject({
        model: { id: "picked" },
        thinkingLevel: "high",
        defaults: { modelId: "edited" },
      });
      await backend.close();
      backend = await Monchu.open(home, value.faux.provider);
      expect(await (await front(backend)).modelChoice()).toMatchObject({
        model: { id: "picked" },
        thinkingLevel: "high",
      });
      expect(await sent("after reopen")).toBe("picked");
      // A fresh context keeps the pick too.
      await (await front(backend)).reset(undefined);
      expect((await (await front(backend)).modelChoice()).model?.id).toBe("picked");

      // Ctrl+S on a worker saves the worker default: new workers get it, existing ones keep theirs.
      await (await front(backend)).startWorker("w0", "first worker", "w0");
      await (await front(backend)).startWorker("w1", "second worker", "w1");
      await (
        await front(backend)
      ).pickModel({ model: { provider: "faux", modelId: "saved" } }, true, "w1");
      expect((await loadConfig(home)).worker).toEqual({ ...fauxRole, modelId: "saved" });
      expect((await (await front(backend)).modelChoice("w0")).model?.id).toBe("faux-1");
      expect(await (await front(backend)).modelChoice("w1")).toMatchObject({
        model: { id: "saved" },
        defaults: { modelId: "saved" },
      });
      await (await front(backend)).startWorker("w2", "third worker", "w2");
      expect((await (await front(backend)).modelChoice("w2")).model?.id).toBe("saved");
      await sent("spawn");
      await waitFor(async () =>
        (await (await front(backend)).workers()).some((worker) => worker.name === "w3"),
      );
      expect((await (await front(backend)).modelChoice("w3")).model?.id).toBe("saved");
      await (await front(backend)).pickModel({ thinkingLevel: "low" }, false, "w0");
      expect((await (await front(backend)).modelChoice("w0")).thinkingLevel).toBe("low");
      expect((await loadConfig(home)).worker.thinkingLevel).toBe("off");

      // Ctrl+S on the root saves the front default and clears the pick, so later edits apply on reload.
      await (
        await front(backend)
      ).pickModel({ model: { provider: "faux", modelId: "saved" } }, true);
      expect((await loadConfig(home)).front).toEqual({
        ...fauxRole,
        modelId: "saved",
        thinkingLevel: "high",
      });
      const config = await loadConfig(home);
      await writeFile(path, JSON.stringify({ ...config, front: fauxRole, chosen: undefined }));
      await backend.reload();
      expect(await (await front(backend)).modelChoice()).toMatchObject({
        model: { id: "faux-1" },
        thinkingLevel: "off",
      });

      // A thinking level the shown conversation's model supports is saved only if the role default's model does too.
      await (
        await front(backend)
      ).pickModel({ model: { provider: "faux", modelId: "picked" } }, false);
      expect((await (await front(backend)).modelChoice()).thinkingLevels).toContain("high");
      const unsaved = await readFile(path, "utf8");
      await expect(
        (await front(backend)).pickModel({ thinkingLevel: "high" }, true),
      ).rejects.toThrow(
        "faux/faux-1 does not support thinking level high (supported: off); the front default was not saved",
      );
      expect(await readFile(path, "utf8")).toBe(unsaved);
      expect(await (await front(backend)).modelChoice()).toMatchObject({
        thinkingLevel: "off",
        defaults: { thinkingLevel: "off" },
      });
      await (await front(backend)).pickModel({ thinkingLevel: "high" }, false);
      expect((await (await front(backend)).modelChoice()).thinkingLevel).toBe("high");

      // Unknown models fail at the boundary without writing.
      const before = await readFile(path, "utf8");
      await expect(
        (await front(backend)).pickModel({ model: { provider: "faux", modelId: "missing" } }, true),
      ).rejects.toThrow("no configured model faux/missing");
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await backend.close();
    }
  }, 30000);

  it("queues messages as steer or follow-up, and abort hands back only the user's own queued text", async () => {
    const value = await setup();
    let holding = true;
    // The front and one worker hold their runs until aborted; everything else answers at once.
    route(value.faux, async (request, options) => {
      const text = textOf(lastMessage(request.messages));
      if ((text === "hold front" && holding) || text === "hold worker") {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
      }
      return fauxAssistantMessage(`done ${text}`);
    });
    const { backend } = await openBackend(value);
    const root = await (await front(backend)).viewState();
    try {
      await (await front(backend)).submit("hold front", "hold", "followUp");
      await waitFor(() => presentation(root.value).busy);
      // A worker's report queues behind the held front with the user's own messages.
      await (await front(backend)).startWorker("quick", "quick", "start:quick");
      await waitFor(() => presentation(root.value).queue.length === 1);
      await (await front(backend)).submit("one", "one", "followUp");
      await (await front(backend)).submit("two", "two", "steer");
      await waitFor(() => presentation(root.value).queue.length === 3);
      expect(presentation(root.value).queue.slice(1)).toMatchObject([
        { mode: "followUp", text: "one" },
        { mode: "steer", text: "two" },
      ]);

      // Messages to a busy worker take the chosen mode too.
      await (await front(backend)).startWorker("held", "hold worker", "start:held");
      const worker = await (await front(backend)).viewState("held");
      try {
        await waitFor(() => presentation(worker.value).busy);
        await (await front(backend)).messageWorker("held", "later", "later", "followUp");
        await waitFor(() => presentation(worker.value).queue.length === 1);
        expect(presentation(worker.value).queue).toMatchObject([
          { mode: "followUp", text: "later" },
        ]);
      } finally {
        worker.dispose();
      }
      await (await front(backend)).stopWorker("held");

      holding = false;
      expect(await (await front(backend)).abort()).toEqual(["one", "two"]);
      // The withdrawn report is posted again and answered; the user's messages never reach the transcript.
      await waitFor(() =>
        root.value.entries.some((entry) => workerNotice(entry)?.name === "quick"),
      );
      await waitFor(() => !presentation(root.value).busy);
      const users = root.value.entries.flatMap((entry) => {
        const message = entry.model?.[0];
        return message?.role === "user" && workerNotice(entry) === undefined
          ? [textOf(message)]
          : [];
      });
      expect(users).toEqual(["hold front"]);
      expect(presentation(root.value).queue).toEqual([]);
    } finally {
      root.dispose();
      await backend.close();
    }
  });

  it("edits queued messages in place for the root and a worker, and a deleted report stays deleted", async () => {
    const value = await setup();
    const release = Promise.withResolvers<void>();
    route(value.faux, async (request, options) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "hold front") await release.promise;
      if (text === "hold worker") {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Hold requires cancellation");
        if (!signal.aborted) await once(signal, "abort");
      }
      return fauxAssistantMessage(`done ${text}`);
    });
    const { backend } = await openBackend(value);
    const root = await (await front(backend)).viewState();
    const queue = () => presentation(root.value).queue;
    try {
      await (await front(backend)).submit("hold front", "hold", "followUp");
      await waitFor(() => presentation(root.value).busy);
      await (await front(backend)).startWorker("quick", "quick", "start:quick");
      await waitFor(() => queue().length === 1);
      await (await front(backend)).submit("one", "one", "followUp");
      await (await front(backend)).submit("two", "two", "followUp");
      await waitFor(() => queue().length === 3);
      const [report, one, two] = queue();
      if (report === undefined || one === undefined || two === undefined)
        throw new Error("Queue is missing items");

      expect(
        await (
          await front(backend)
        ).editQueued(undefined, one.id, { kind: "text", text: "one edited" }),
      ).toBe(true);
      expect(
        await (await front(backend)).editQueued(undefined, two.id, { kind: "mode", mode: "steer" }),
      ).toBe(true);
      // A report's new text replaces only its body; it stays a report from its worker.
      await (
        await front(backend)
      ).editQueued(undefined, report.id, { kind: "text", text: "edited report" });
      await waitFor(() => queue()[1]?.text === "one edited");
      expect(parseWorkerNotice(queue()[0]?.text ?? "")).toEqual({
        name: "quick",
        status: "completed",
        text: "edited report",
      });
      expect(queue().map(({ id, mode }) => ({ id, mode }))).toEqual([
        { id: report.id, mode: "followUp" },
        { id: one.id, mode: "followUp" },
        { id: two.id, mode: "steer" },
      ]);
      expect(
        await (await front(backend)).editQueued(undefined, report.id, { kind: "delete" }),
      ).toBe(true);
      expect(
        await (await front(backend)).editQueued(undefined, report.id, { kind: "delete" }),
      ).toBe(false);
      await expect(
        (await front(backend)).editQueued(undefined, one.id, { kind: "text", text: " " }),
      ).rejects.toThrow("needs text");

      // A worker's queue edits the same way; deleting a message reports the failure to the front.
      await (await front(backend)).startWorker("held", "hold worker", "start:held");
      const worker = await (await front(backend)).viewState("held");
      try {
        await waitFor(() => presentation(worker.value).busy);
        await (await front(backend)).messageWorker("held", "later", "later", "followUp");
        await waitFor(() => presentation(worker.value).queue.length === 1);
        const [later] = presentation(worker.value).queue;
        if (later === undefined) throw new Error("Worker queue is missing its message");
        await (await front(backend)).editQueued("held", later.id, { kind: "text", text: "sooner" });
        await (await front(backend)).editQueued("held", later.id, { kind: "mode", mode: "steer" });
        await waitFor(() => presentation(worker.value).queue[0]?.mode === "steer");
        expect(presentation(worker.value).queue).toEqual([
          { id: later.id, mode: "steer", text: "sooner" },
        ]);
        await (await front(backend)).editQueued("held", later.id, { kind: "delete" });
        await waitFor(() => presentation(worker.value).queue.length === 0);
      } finally {
        worker.dispose();
      }

      release.resolve();
      await waitFor(() =>
        root.value.entries.some(
          (entry) =>
            workerNotice(entry)?.name === "held" && workerNotice(entry)?.text === "deleted",
        ),
      );
      await waitFor(() => !presentation(root.value).busy && queue().length === 0);
      await (await front(backend)).stopWorker("held");
      // Past the reporter's 250 ms poll: a deleted report is never posted again.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const users = root.value.entries.flatMap((entry) => {
        const message = entry.model?.[0];
        return message?.role === "user" && workerNotice(entry) === undefined
          ? [textOf(message)]
          : [];
      });
      expect(users).toEqual(["hold front", "one edited", "two"]);
      expect(root.value.entries.some((entry) => workerNotice(entry)?.name === "quick")).toBe(false);
    } finally {
      root.dispose();
      await backend.close();
    }
  });

  it("streams job events with growing ids, from any point, to every client", async () => {
    const value = await setup();
    route(value.faux, (request) => {
      const text = textOf(lastMessage(request.messages));
      if (text === "schedule")
        return fauxAssistantMessage(
          [
            fauxToolCall("job", {
              action: "create",
              name: "brief",
              type: "agent",
              schedule: "@daily",
              prompt: "write the brief",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text === "run")
        return fauxAssistantMessage([fauxToolCall("job", { action: "run_now", name: "brief" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("ok");
    });
    const { backend } = await openBackend(value);
    const all: number[] = [];
    const later: string[] = [];
    const stopAll = await backend.watchJobEvents(0, (events) =>
      all.push(...events.map((event) => event.id)),
    );
    try {
      await (await front(backend)).submit("schedule", "schedule", "followUp");
      await waitFor(() => all.length === 1);
      // A client that saw event 1 resumes after it and never gets it again.
      const stopLater = await backend.watchJobEvents(1, (events) =>
        later.push(...events.map((event) => `${event.id}:${event.kind}:${event.worker ?? ""}`)),
      );
      await (await front(backend)).submit("run", "run", "followUp");
      await waitFor(() => later.length === 1);
      stopLater();
      expect(all).toEqual([1, 2]);
      expect(later).toEqual(["2:fired:job-brief"]);
      expect((await backend.jobs()).jobs.map((job) => job.name)).toEqual(["brief"]);
    } finally {
      stopAll();
      await backend.close();
    }
  });
});
