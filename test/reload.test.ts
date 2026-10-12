import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  defineExtension,
  ToolResultEntry,
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
  allEntries,
  cleanup,
  classifierModel,
  context,
  fauxRole,
  lastMessage,
  open,
  route,
  scriptedClassifier,
  setup,
  textOf,
  waitFor,
} from "./support.ts";

afterEach(cleanup);

const config = {
  front: fauxRole,
  worker: fauxRole,
  classifier: { provider: classifierModel.provider, modelId: classifierModel.id },
  cloudflareAccountId: undefined,
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
    import(`${pathToFileURL(path).href}?v=${version}`);
  const initial = await load("initial");
  return { path, load, initial };
}

async function results(root: Awaited<ReturnType<typeof open>>["root"]) {
  return (await allEntries(root)).flatMap((entry) =>
    ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult"
      ? [textOf(entry.model[0])]
      : [],
  );
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
      expect((await harness.snapshot(RestartRequest, root.id, context))?.request).toMatchObject({
        reason: "host changed",
        requestedAt: expect.any(Number),
      });
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

  it("reloads the real manifest, user instructions, skills and settings", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    await mkdir(join(agentDir, "skills", "sample"), { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "old user guidance");
    scriptedClassifier(value.models);
    const extensions = await Extensions.load(value.models, config, agentDir, () => {});
    expect(extensions.settings.getDefaultTools()).toBeUndefined();
    await writeFile(join(agentDir, "AGENTS.md"), "fresh user guidance");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
    await writeFile(
      join(agentDir, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: fresh skill\n---\ncontent\n",
    );
    // Concurrent requests share one reload.
    const reloading = extensions.reload();
    expect(extensions.reload()).toBe(reloading);
    expect(await reloading).toEqual([
      "context",
      "pi-tools",
      "workers",
      "codemode",
      "goals",
      "identity",
      "classifier",
    ]);
    expect(extensions.settings.getDefaultTools()).toEqual(["read"]);
    const sections: string[] = [];
    route(value.faux, (request) => {
      sections.push(
        ...request.messages.flatMap((m) =>
          m.role === "system"
            ? Object.values(m.sections ?? {}).flatMap((value) =>
                typeof value === "string" ? [value] : [],
              )
            : [],
        ),
      );
      return fauxAssistantMessage("done");
    });
    const { harness, root } = await open({ ...value, registry: extensions.registry });
    try {
      await (await root.submit({ type: "input", content: "hello" }, context)).wait(context);
      expect(sections.join("\n")).toContain("fresh user guidance");
      expect(sections.join("\n")).not.toContain("old user guidance");
      expect(sections.join("\n")).toContain("fresh skill");
      expect((await root.agent(context)).tools.map((tool) => tool.name)).not.toContain("bash");
    } finally {
      await harness.close(context);
    }
  });

  it("leaves installed extensions and settings unchanged when a reload fails", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    await mkdir(agentDir);
    scriptedClassifier(value.models);
    const extensions = await Extensions.load(value.models, config, agentDir, () => {});
    const registry = extensions.registry.snapshot();
    const settings = extensions.settings;
    await writeFile(join(agentDir, "settings.json"), "{");
    await expect(extensions.reload()).rejects.toThrow("Pi settings failed");
    expect(extensions.registry.snapshot()).toBe(registry);
    expect(extensions.settings).toBe(settings);
  });
});
