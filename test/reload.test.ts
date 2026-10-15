import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type ConversationDocToken,
  type Extension,
  type Task,
} from "@earendil-works/pi-durable";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReloadControls,
  Extensions,
  installExtensions,
  RestartRequest,
} from "../src/reload.ts";
import {
  cleanup,
  classifierModel,
  context,
  fauxRole,
  lastMessage,
  open,
  route,
  scriptedClassifier,
  sectionTexts,
  setup,
  textOf,
  toolResults,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const config = {
  front: fauxRole,
  worker: fauxRole,
  classifier: { provider: classifierModel.provider, modelId: classifierModel.id },
  cloudflareAccountId: undefined,
  settings: {},
  claude: { executable: undefined, plan: "pro" as const, longContextExtraUsage: false },
};

type VersionedModule = {
  extension: Extension;
  Doc: ConversationDocToken<{ value: string }>;
  Task: Task<null, { phase: "run" }, string, object>;
  started: Promise<void>;
  release: () => void;
};

/** Real edited ESM file: every import defines fresh doc/task tokens of the same kind/name/version. */
function source(version: string, gated = false) {
  return `
    import { Type } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
    import { defineDoc, defineExtension, defineTask, defineTool } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
    export const Doc = defineDoc({ kind: "test.reload", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ value: "initial" }) });
    const gate = Promise.withResolvers();
    const start = Promise.withResolvers();
    export const started = start.promise;
    export const release = () => gate.resolve();
    export const Task = defineTask({
      name: "test.reload-task", version: 1, initial: () => ({ phase: "run" }),
      phases: { run: async (_task, api, context) => {
        await api.commit(async tx => {
          (await tx.doc(Doc, api.conversationId)).value = ${JSON.stringify(version)};
          return { status: "terminal", outcome: { status: "completed", result: ${JSON.stringify(version)} } };
        }, context);
      } },
      abort: (_task, api, context) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    export const extension = defineExtension({ name: "test.versioned", tasks: [Task], tools: [defineTool({
      name: "version", description: "Version", parameters: Type.Object({}), replay: "safe",
      execute: async (_args, api, context) => {
        start.resolve();
        ${gated ? "await gate.promise;" : ""}
        const value = (await api.snapshot(Doc, api.conversationId, context))?.value;
        return { content: [{ type: "text", text: ${JSON.stringify(version)} + ":" + value }] };
      },
    })] });
  `;
}

async function fixture(directory: string) {
  const path = join(directory, "versioned.mjs");
  await writeFile(path, source("v1", true));
  const load = async (version: string): Promise<VersionedModule> =>
    // oxlint-disable-next-line typescript/no-unsafe-return -- The fixture is generated source; `VersionedModule` names its exports.
    import(`${pathToFileURL(path).href}?v=${version}`);
  const initial = await load("initial");
  return { path, load, initial };
}

async function results(root: Awaited<ReturnType<typeof open>>["root"]) {
  return (await toolResults(root)).map(textOf);
}

describe("in-process reload", () => {
  it("keeps a running call on old code and uses edited code with existing document state on the next call", async () => {
    const value = await setup();
    const module = await fixture(value.directory);
    value.registry.install(module.initial.extension);
    route(value.faux, (request) =>
      lastMessage(request.messages)?.role === "user"
        ? fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage("done"),
    );
    const { harness, root } = await open(value);
    try {
      await root.commit(async (tx) => {
        (await tx.doc(module.initial.Doc, root.id)).value = "kept";
      }, context);
      const running = await root.submit({ type: "input", content: "version?" }, context);
      await module.initial.started;
      await writeFile(module.path, source("v2"));
      installExtensions(value.registry, [(await module.load("v2")).extension]);
      module.initial.release();
      await running.wait(context);
      await (await root.submit({ type: "input", content: "now?" }, context)).wait(context);
      expect(await results(root)).toEqual(["v1:kept", "v2:kept"]);
      const fresh = await module.load("doc-read");
      expect(fresh.Doc).not.toBe(module.initial.Doc);
      expect(await harness.snapshot(fresh.Doc, root.id, context)).toEqual({ value: "kept" });
    } finally {
      module.initial.release();
      await harness.close(context);
    }
  });

  it("validates registry collisions before publishing anything", async () => {
    const value = await setup();
    const module = await fixture(value.directory);
    value.registry.install(module.initial.extension);
    const before = value.registry.snapshot();
    expect(() =>
      installExtensions(value.registry, [
        defineExtension({ name: "valid" }),
        defineExtension({ name: "collision", tasks: [module.initial.Task] }),
      ]),
    ).toThrow("already installed");
    expect(value.registry.snapshot()).toBe(before);
  });

  it("resumes a pending task with a fresh same-name/version token and existing doc after reopen", async () => {
    const value = await setup();
    const module = await fixture(value.directory);
    let { harness, root } = await open(value);
    const id = await root.commit(async (tx) => {
      (await tx.doc(module.initial.Doc, root.id)).value = "kept";
      return tx.createTask(module.initial.Task, null, {
        conversationId: root.id,
        ownership: { kind: "conversation" },
        background: true,
      });
    }, context);
    // Definition is deliberately absent, so the pending task cannot start.
    await harness.close(context);
    ({ harness, root } = await open(value));
    try {
      expect((await harness.getTask(id, context))?.state.status).not.toBe("terminal");
      await writeFile(module.path, source("v2"));
      const fresh = await module.load("fresh-token");
      expect(fresh.Task).not.toBe(module.initial.Task);
      expect(await harness.snapshot(fresh.Doc, root.id, context)).toEqual({ value: "kept" });
      installExtensions(value.registry, [(await module.load("v2")).extension]);
      await waitFor(async () => (await harness.getTask(id, context))?.state.status === "terminal");
      expect(await harness.snapshot(module.initial.Doc, root.id, context)).toEqual({ value: "v2" });
    } finally {
      await harness.close(context);
    }
  });

  it("records restart requests from any role without restarting, and exposes the reload tool", async () => {
    const value = await setup();
    const module = await fixture(value.directory);
    await writeFile(module.path, source("v2"));
    const { harness, root } = await open(value);
    let reloads = 0;
    value.registry.install(
      createReloadControls(root.id, async () => {
        reloads++;
        installExtensions(value.registry, [(await module.load("v2")).extension]);
        return [module.path];
      }),
    );
    route(value.faux, (request) =>
      lastMessage(request.messages)?.role === "user"
        ? fauxAssistantMessage(
            textOf(lastMessage(request.messages)) === "reload"
              ? fauxToolCall("reload_extensions", {})
              : fauxToolCall("request_restart", { reason: "host changed" }),
            {
              stopReason: "toolUse",
            },
          )
        : fauxAssistantMessage("done"),
    );
    try {
      await (await root.submit({ type: "input", content: "request" }, context)).wait(context);
      const request = (await harness.snapshot(RestartRequest, root.id, context))?.request;
      expect(request?.reason).toBe("host changed");
      expect(typeof request?.requestedAt).toBe("number");
      const worker = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        },
        context,
      );
      await (await worker.submit({ type: "input", content: "request" }, context)).wait(context);
      expect(await harness.snapshot(RestartRequest, worker.id, context)).toBeUndefined();
      expect(reloads).toBe(0);
      await (await worker.submit({ type: "input", content: "reload" }, context)).wait(context);
      expect(reloads).toBe(1);
      expect((await results(worker)).at(-1)).toBe(`Reloaded: ${module.path}`);
      expect((await root.agent(context)).tools.map((tool) => tool.name)).toContain(
        "reload_extensions",
      );
      expect((await root.agent(context)).tools.map((tool) => tool.name)).not.toContain("restart");
    } finally {
      await harness.close(context);
    }
    const reopened = await open(value);
    try {
      expect(
        (await reopened.harness.snapshot(RestartRequest, reopened.root.id, context))?.request
          ?.reason,
      ).toBe("host changed");
    } finally {
      await reopened.harness.close(context);
    }
  });

  it("reloads the real manifest and home skills", async () => {
    const value = await setup();
    await mkdir(join(value.directory, "skills", "sample"), { recursive: true });
    await writeFile(join(value.directory, "AGENTS.md"), "old home guidance");
    await writeFile(
      join(value.directory, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: old skill\n---\ncontent\n",
    );
    scriptedClassifier(value.models);
    const extensions = await Extensions.load(value.models, config, value.directory, () => {});
    await writeFile(join(value.directory, "AGENTS.md"), "fresh home guidance");
    await writeFile(
      join(value.directory, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: fresh skill\n---\ncontent\n",
    );
    await writeFile(join(value.directory, "config.json"), JSON.stringify(config));
    // Concurrent requests share one reload.
    const reloading = extensions.reload();
    expect(extensions.reload()).toBe(reloading);
    expect(await reloading).toEqual([
      "context",
      "pi-tools",
      "workers",
      "codemode",
      "goals",
      "memory",
      "identity",
      "classifier",
    ]);
    const sections: string[] = [];
    route(value.faux, (request) => {
      sections.push(...sectionTexts(request.messages));
      return fauxAssistantMessage("done");
    });
    const { harness, root } = await open({ ...value, registry: extensions.registry });
    try {
      await (await root.submit({ type: "input", content: "hello" }, context)).wait(context);
      expect(sections.join("\n")).toContain("fresh home guidance");
      expect(sections.join("\n")).not.toContain("old home guidance");
      expect(sections.join("\n")).toContain("fresh skill");
      expect(sections.join("\n")).not.toContain("old skill");
      expect((await root.agent(context)).tools.map((tool) => tool.name)).toContain("bash");
      await writeFile(
        join(value.directory, "config.json"),
        JSON.stringify({ ...config, classifier: null }),
      );
      await extensions.reload();
      expect(extensions.assessment).toBeUndefined();
      expect(extensions.defaults().map((extension) => extension.name)).not.toContain(
        "monchu.classifier",
      );
      expect(
        extensions.registry
          .snapshot()
          .installed()
          .map((extension) => extension.name),
      ).toContain("monchu.classifier");
    } finally {
      await harness.close(context);
    }
  });

  it("leaves installed extensions, config and settings unchanged when replacement preparation fails", async () => {
    const value = await setup();
    const initial = { ...config, settings: { theme: "dark", defaultTools: ["read", "bash"] } };
    await writeFile(join(value.directory, "config.json"), JSON.stringify(initial));
    scriptedClassifier(value.models);
    const extensions = await Extensions.load(value.models, initial, value.directory, () => {});
    const registry = extensions.registry.snapshot();
    const settings = extensions.settings;
    const assessment = extensions.assessment;
    await writeFile(
      join(value.directory, "config.json"),
      JSON.stringify({
        ...initial,
        settings: { theme: "light", defaultTools: ["fffind"] },
        classifier: { provider: "missing", modelId: "missing" },
      }),
    );
    await expect(extensions.reload()).rejects.toThrow("no configured classifier model");
    expect(extensions.registry.snapshot()).toBe(registry);
    expect(extensions.settings).toBe(settings);
    expect(extensions.config).toBe(initial);
    expect(extensions.assessment).toBe(assessment);
    expect(settings.theme).toBe("dark");
    const { harness, root } = await open({ ...value, registry: extensions.registry });
    route(value.faux, () => fauxAssistantMessage("old registry works"));
    try {
      expect((await root.agent(context)).tools.map((tool) => tool.name)).toContain("bash");
      expect((await root.agent(context)).tools.map((tool) => tool.name)).not.toContain("fffind");
      await (await root.submit({ type: "input", content: "still works" }, context)).wait(context);
      await writeFile(join(value.directory, "config.json"), JSON.stringify(initial));
      await extensions.reload();
      expect(extensions.settings).not.toBe(settings);
    } finally {
      await harness.close(context);
    }
  });

  // Workers still get them by inheriting the root's selection; see the backend's worker tool test.
  it("adds goals and memory to the root, not the host default, in the real manifest", async () => {
    const value = await setup();
    scriptedClassifier(value.models);
    const extensions = await Extensions.load(value.models, config, value.directory, () => {});
    expect(extensions.root.map((extension) => extension.name)).toEqual([
      "monchu.goals",
      "monchu.memory",
    ]);
    const defaults = extensions.defaults().map((extension) => extension.name);
    expect(defaults).not.toContain("monchu.goals");
    expect(defaults).not.toContain("monchu.memory");
  });
});
