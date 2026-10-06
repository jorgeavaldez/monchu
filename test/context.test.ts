import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPiConfiguration } from "../src/context.ts";
import { createPiTools } from "../src/pi-tools.ts";
import { startWorker, WorkersDoc } from "../src/workers.ts";
import { cleanup, context, fauxRole, lastMessage, open, route, setup, textOf } from "./support.ts";

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

describe("Pi user configuration", () => {
  it("imports global context precedence and both prompts, without execution-directory resources", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    vi.stubEnv("HOME", value.directory);
    const project = join(value.directory, "project");
    await mkdir(join(agentDir, ".pi"), { recursive: true });
    await mkdir(join(project, ".pi", "skills", "local"), { recursive: true });
    await writeFile(join(agentDir, "AGENTS.override.md"), "global override");
    await writeFile(join(agentDir, "AGENTS.md"), "shadowed global");
    await writeFile(join(agentDir, "SYSTEM.md"), "coding identity");
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "appended guidance");
    await writeFile(join(value.directory, "AGENTS.md"), "ancestor instructions");
    await writeFile(join(project, "AGENTS.md"), "project instructions");
    await writeFile(join(project, ".pi", "SYSTEM.md"), "project system");
    await writeFile(join(agentDir, ".pi", "APPEND_SYSTEM.md"), "nested project append");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ shellCommandPrefix: "user prefix" }),
    );
    await writeFile(
      join(agentDir, ".pi", "settings.json"),
      JSON.stringify({ shellCommandPrefix: "local prefix" }),
    );
    await writeFile(
      join(project, ".pi", "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: project-only skill\n---\nlocal body",
    );
    const pi = await loadPiConfiguration(agentDir);
    value.registry.install(pi.extension);
    const systems: string[] = [];
    route(value.faux, (request) => {
      systems.push(
        request.messages
          .flatMap((message: Message) =>
            message.role === "system" ? Object.values(message.sections ?? {}) : [],
          )
          .join("\n"),
      );
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const { harness, root } = await open(value);
    await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
    await root.configure({ cwd: project }, context);
    await (await root.submit({ type: "input", content: "again" }, context)).wait(context);
    await root.commit(
      (tx) => startWorker(tx, root.id, "reader", "inspect", project, "worker-request", fauxRole),
      context,
    );
    harness.resume();
    const state = await harness.snapshot(WorkersDoc, root.id, context);
    for (const delivery of state?.deliveries ?? []) {
      await harness.waitForTask(delivery.taskId, context);
    }
    expect(pi.settings.getShellCommandPrefix()).toBe("user prefix");
    expect(pi.settings.getProjectSettings()).toEqual({});
    expect(systems.length).toBeGreaterThanOrEqual(3);
    for (const system of systems) {
      expect(system).toContain("global override");
      expect(system).toContain("coding identity");
      expect(system).toContain("appended guidance");
      expect(system).not.toMatch(
        /shadowed global|ancestor instructions|project instructions|project system|nested project append|project-only skill/,
      );
    }
    await harness.close(context);
  });

  it.each(["read", "bash"] as const)(
    "advertises filtered skills and loads instructions on demand with %s",
    async (fileReadTool) => {
      const value = await setup();
      const agentDir = join(value.directory, "agent");
      vi.stubEnv("HOME", value.directory);
      const packageDir = join(agentDir, "skill-package");
      for (const path of [
        join(agentDir, "skills", "vault"),
        join(agentDir, "skills", "excluded"),
        join(agentDir, "extra", "configured"),
        join(packageDir, "skills", "packaged"),
        join(packageDir, "skills", "hidden"),
        join(value.directory, ".agents", "skills", "shared"),
        join(agentDir, ".agents", "skills", "ancestor"),
      ]) {
        await mkdir(path, { recursive: true });
        const name = basename(path);
        await writeFile(
          join(path, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} workflow\n---\nPRIVATE ${name} BODY`,
        );
      }
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "test-skills", pi: { skills: ["./skills"] } }),
      );
      // Would throw if executable extensions were imported.
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "bad.ts"),
        'throw new Error("extension executed");',
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: [fileReadTool],
          skills: ["extra", "!skills/excluded/**"],
          packages: [{ source: "./skill-package", skills: ["skills/packaged/**"] }],
        }),
      );
      const pi = await loadPiConfiguration(agentDir);
      value.registry.install(pi.extension);
      value.registry.install(createPiTools(pi.settings, process.platform).extension);
      const skillFile = join(agentDir, "skills", "vault", "SKILL.md");
      let advertised = "";
      let loaded = "";
      route(value.faux, (request) => {
        advertised = request.messages
          .flatMap((message) =>
            message.role === "system" ? Object.values(message.sections ?? {}) : [],
          )
          .join("\n");
        if (lastMessage(request.messages)?.role === "toolResult") {
          loaded = textOf(lastMessage(request.messages));
          return fauxAssistantMessage([fauxText("loaded")]);
        }
        return fauxAssistantMessage(
          [
            fileReadTool === "read"
              ? fauxToolCall("read", { path: skillFile })
              : fauxToolCall("bash", { command: `cat '${skillFile}'` }),
          ],
          {
            stopReason: "toolUse",
          },
        );
      });
      const { harness, root } = await open(value);
      await (await root.submit({ type: "input", content: "use vault" }, context)).wait(context);
      expect(advertised).toContain("vault workflow");
      expect(advertised).toContain("configured workflow");
      expect(advertised).toContain("packaged workflow");
      expect(advertised).toContain("shared workflow");
      expect(advertised).not.toMatch(/excluded workflow|hidden workflow|ancestor workflow|PRIVATE/);
      expect(loaded).toContain("PRIVATE vault BODY");
      await harness.close(context);
    },
  );

  it.each([
    { tools: undefined, skills: "automatic", reader: "read" },
    { tools: ["-read"], skills: "automatic", reader: "bash" },
    { tools: ["-bash"], skills: "automatic", reader: "read" },
    { tools: [], skills: "automatic", reader: undefined },
    { tools: ["edit", "ls"], skills: "automatic", reader: undefined },
    { tools: ["read", "bash"], skills: "disabled", reader: undefined },
    { tools: ["read", "bash"], skills: "absent", reader: undefined },
  ])(
    "omits unreadable, non-invocable or absent skills: $tools / $skills",
    async ({ tools, skills, reader }) => {
      const value = await setup();
      const agentDir = join(value.directory, "agent");
      vi.stubEnv("HOME", value.directory);
      await mkdir(agentDir);
      if (skills !== "absent") {
        const skillDir = join(agentDir, "skills", "available");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          `---\nname: available\ndescription: available workflow\ndisable-model-invocation: ${skills === "disabled"}\n---\nPRIVATE BODY`,
        );
      }
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: tools }));
      const pi = await loadPiConfiguration(agentDir);
      value.registry.install(createPiTools(pi.settings, process.platform).extension);
      value.registry.install(pi.extension);
      const sections: Record<string, string | null>[] = [];
      route(value.faux, (request) => {
        for (const message of request.messages) {
          if (message.role === "system" && message.sections) sections.push(message.sections);
        }
        return fauxAssistantMessage([fauxText("ok")]);
      });
      const { harness, root } = await open(value);
      await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
      const skillSection = sections.find((item) => "skills" in item)?.skills;
      if (reader === undefined) {
        expect(skillSection).toBeUndefined();
      } else {
        expect(skillSection).toContain("available workflow");
        expect(skillSection).toContain(reader === "read" ? "Use the read tool" : "Use bash");
        expect(skillSection).not.toContain("PRIVATE BODY");
        expect(
          value.registry
            .snapshot()
            .tools()
            .map(({ tool }) => tool.name),
        ).toContain(reader);
      }
      await harness.close(context);
    },
  );

  it.each([
    { content: '{"token": "TOP_SECRET"', reason: "invalid JSON" },
    { content: "TOP_SECRET", reason: "invalid JSON" },
    { content: '"TOP_SECRET"', reason: "invalid settings structure" },
  ])(
    "fails fast with a credential-safe path and reason for $reason",
    async ({ content, reason }) => {
      const value = await setup();
      const agentDir = join(value.directory, "agent");
      await mkdir(agentDir);
      const path = join(agentDir, "settings.json");
      await writeFile(path, content);
      await expect(loadPiConfiguration(agentDir)).rejects.toThrow(
        `Pi settings failed:\n${path}: ${reason}`,
      );
      await expect(loadPiConfiguration(agentDir)).rejects.not.toThrow("TOP_SECRET");
    },
  );

  it.each(["EISDIR", "ELOCKED"])(
    "reports a settings read/lock failure with its path and %s",
    async (code) => {
      const value = await setup();
      const agentDir = join(value.directory, "agent");
      await mkdir(agentDir);
      const path = join(agentDir, "settings.json");
      if (code === "EISDIR") await mkdir(path);
      else {
        await writeFile(path, "{}");
        await mkdir(`${path}.lock`);
      }
      await expect(loadPiConfiguration(agentDir)).rejects.toThrow(
        `${path}: could not read or lock settings (${code})`,
      );
    },
  );

  it("does not install a missing configured package", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    vi.stubEnv("HOME", value.directory);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:monchu-nonexistent-test-package@0.0.0"] }),
    );
    const pi = await loadPiConfiguration(agentDir);
    expect(pi.settings.getPackages()).toEqual(["npm:monchu-nonexistent-test-package@0.0.0"]);
    expect(pi.diagnostics.some(({ type }) => type === "warning")).toBe(true);
  });

  it("redacts URL userinfo and token parameters from missing package sources", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    vi.stubEnv("HOME", value.directory);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          "git:https://user:ghp_SECRET1@github.com/org/repo",
          "https://SECRET2@example.com/org/other?access_token=SECRET3&ref=main&key=SECRET4",
        ],
      }),
    );
    const pi = await loadPiConfiguration(agentDir);
    const messages = pi.diagnostics.map(({ message }) => message);
    expect(messages).toEqual([
      "Pi package unavailable; not installed: git:https://***@github.com/org/repo",
      "Pi package unavailable; not installed: https://***@example.com/org/other?access_token=***&ref=main&key=***",
    ]);
  });
});
