import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { glob, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { createIdentity, FRONT_INSTRUCTIONS } from "../src/identity.ts";
import { Extensions } from "../src/reload.ts";
import { startWorker, WorkersDoc } from "../src/workers.ts";
import {
  cleanup,
  context,
  fauxRole,
  lastMessage,
  open,
  route,
  sectionTexts,
  setup,
  textOf,
} from "./support.ts";

afterEach(cleanup);

const homeFiles = ["SOUL.md", "AGENTS.md", "DEVICES.md", "memories/USER.md", "memories/MEMORY.md"];

describe("Monchu home context", () => {
  it("reads all five files for the front on every request, but only memories and devices for workers", async () => {
    const value = await setup();
    const home = value.directory;
    await mkdir(join(home, "memories"));
    for (const file of homeFiles) await writeFile(join(home, file), `CONTENT ${file}`);
    value.registry.install(createIdentity(home, (path) => value.reports.push(path)));
    const requests: { message: string; home: string; instructions: string }[] = [];
    route(value.faux, (request) => {
      requests.push({
        message: textOf(lastMessage(request.messages)),
        home: sectionTexts(request.messages, "home").at(-1) ?? "",
        instructions: sectionTexts(request.messages, "instructions").join("\n"),
      });
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open(value);
    try {
      await root.configure({ instructions: FRONT_INSTRUCTIONS }, context);
      await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
      const first = requests.find(({ message }) => message === "first");
      expect(first?.instructions).toContain(FRONT_INSTRUCTIONS);
      for (const file of homeFiles) {
        expect(first?.home).toContain(`<home_file path="${join(home, file)}">`);
        expect(first?.home).toContain(`CONTENT ${file}`);
      }
      await writeFile(join(home, "SOUL.md"), "EDITED SOUL");
      await writeFile(join(home, "memories", "MEMORY.md"), "EDITED MEMORY");
      await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
      const second = requests.find(({ message }) => message === "second");
      expect(second?.home).toContain("EDITED SOUL");
      expect(second?.home).toContain("EDITED MEMORY");
      expect(second?.home).not.toContain("CONTENT SOUL.md");
      expect(second?.home).not.toContain("CONTENT memories/MEMORY.md");
      await root.commit(
        (tx) => startWorker(tx, root.id, "reader", "inspect", home, "worker-request", fauxRole),
        context,
      );
      const state = await harness.snapshot(WorkersDoc, root.id, context);
      for (const delivery of state?.deliveries ?? [])
        await harness.waitForTask(delivery.taskId, context);
      const worker = requests.find(({ message }) => message === "inspect");
      for (const file of ["memories/USER.md", "memories/MEMORY.md", "DEVICES.md"])
        expect(worker?.home).toContain(`<home_file path="${join(home, file)}">`);
      expect(worker?.home).toContain("EDITED MEMORY");
      expect(worker?.home).not.toMatch(/SOUL\.md|AGENTS\.md/);
      expect(worker?.instructions).toBe(
        "<instructions>\nYou are Monchu's background worker reader: a delegated agent doing one bounded job on the user's behalf. Do the job in your brief and nothing broader. Your final answer is reported to Monchu automatically: say what you did, what you checked and how, what failed or is left, and anything worth remembering about the user or the work; Monchu decides what to save. Use post_update for progress worth hearing before you finish. If a decision belongs to the user, stop and say so in your answer. Follow the device rules for the machine you run on.\n</instructions>",
      );
      expect(value.reports).toEqual([]);
    } finally {
      await harness.close(context);
    }
  });

  it("skips missing files and reports each path once, including across reloads", async () => {
    const value = await setup();
    const warnings: string[] = [];
    const extensions = await Extensions.load(
      value.models,
      await loadConfig(value.directory),
      value.directory,
      (warning) => warnings.push(warning),
    );
    route(value.faux, () => fauxAssistantMessage("ok"));
    const { harness, root } = await open({ ...value, registry: extensions.registry });
    try {
      await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
      await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
      await extensions.reload();
      await (await root.submit({ type: "input", content: "third" }, context)).wait(context);
      expect(warnings.filter((warning) => warning.startsWith("Missing Monchu home file"))).toEqual(
        homeFiles.map(
          (file) => `Missing Monchu home file (skipped): ${join(value.directory, file)}`,
        ),
      );
      await writeFile(join(value.directory, "SOUL.md"), "ADDED SOUL");
      let home = "";
      route(value.faux, (request) => {
        home = sectionTexts(request.messages, "home").join("\n");
        return fauxAssistantMessage("ok");
      });
      await (await root.submit({ type: "input", content: "fourth" }, context)).wait(context);
      expect(home).toContain("ADDED SOUL");
    } finally {
      await harness.close(context);
    }
  });

  it("supplies device facts to all roles and tracks execution cwd independently of home", async () => {
    const value = await setup();
    value.registry.install(createIdentity(value.directory, () => {}));
    const project = join(value.directory, "project");
    await mkdir(project);
    const devices: string[] = [];
    route(value.faux, (request) => {
      devices.push(sectionTexts(request.messages, "device").at(-1) ?? "");
      expect(sectionTexts(request.messages, "execution")).toEqual([]);
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
      await root.configure({ cwd: project }, context);
      await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
      await root.commit(
        (tx) => startWorker(tx, root.id, "reader", "inspect", project, "worker-request", fauxRole),
        context,
      );
      const state = await harness.snapshot(WorkersDoc, root.id, context);
      for (const delivery of state?.deliveries ?? [])
        await harness.waitForTask(delivery.taskId, context);
      expect(devices.length).toBeGreaterThanOrEqual(3);
      for (const device of devices) {
        for (const fact of [
          `Hostname: ${hostname()}`,
          `OS: ${type()}`,
          `OS release: ${release()}`,
          `User: ${userInfo().username}`,
          `Home directory: ${homedir()}`,
          `Monchu home: ${value.directory}`,
        ])
          expect(device).toContain(fact);
      }
      expect(devices[0]).toContain(`Execution directory: ${value.directory}`);
      expect(
        devices.slice(1).every((device) => device.includes(`Execution directory: ${project}`)),
      ).toBe(true);
    } finally {
      await harness.close(context);
    }
  });

  it("loads home and bundled skills in place for all roles and reads their bodies on demand", async () => {
    const value = await setup();
    const skillFile = join(value.directory, "skills", "vault", "SKILL.md");
    await mkdir(join(value.directory, "skills", "vault"), { recursive: true });
    await writeFile(
      skillFile,
      "---\nname: vault\ndescription: vault workflow\n---\nPRIVATE HOME BODY",
    );
    const resources = createContext(value.directory, {});
    value.registry.install(resources.extension);
    const bundledFile = fileURLToPath(new URL("../skills/monchu/SKILL.md", import.meta.url));
    const advertised: string[] = [];
    const loaded: string[] = [];
    route(value.faux, (request) => {
      advertised.push(sectionTexts(request.messages, "skills").join("\n"));
      const last = lastMessage(request.messages);
      if (last?.role === "toolResult") {
        loaded.push(textOf(last));
        return fauxAssistantMessage([fauxText("loaded")]);
      }
      return fauxAssistantMessage(
        fauxToolCall("read", { path: textOf(last) === "bundled" ? bundledFile : skillFile }),
        { stopReason: "toolUse" },
      );
    });
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "home" }, context)).wait(context);
      await (await root.submit({ type: "input", content: "bundled" }, context)).wait(context);
      await root.commit(
        (tx) =>
          startWorker(
            tx,
            root.id,
            "reader",
            "inspect",
            value.directory,
            "worker-request",
            fauxRole,
          ),
        context,
      );
      const state = await harness.snapshot(WorkersDoc, root.id, context);
      for (const delivery of state?.deliveries ?? [])
        await harness.waitForTask(delivery.taskId, context);
      for (const skills of advertised) {
        expect(skills).toContain("vault workflow");
        expect(skills).toContain(skillFile);
        expect(skills).toContain(bundledFile);
        expect(skills).not.toContain("PRIVATE HOME BODY");
      }
      expect(loaded.some((body) => body.includes("PRIVATE HOME BODY"))).toBe(true);
      expect(loaded.some((body) => body.includes("# Changing Monchu"))).toBe(true);
      expect(resources.warnings).toEqual([]);
    } finally {
      await harness.close(context);
    }
  });

  it("does not load or write Pi instructions, skills, packages, or execution-directory resources", async () => {
    const value = await setup();
    const { agentDir, directory } = value;
    const project = join(directory, "project");
    for (const skillDir of [
      join(agentDir, "skills", "pi-only"),
      join(project, ".pi", "skills", "project-only"),
      join(directory, ".agents", "skills", "shared"),
    ]) {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: forbidden\ndescription: FORBIDDEN SKILL\n---\nbody`,
      );
    }
    for (const file of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"])
      await writeFile(join(agentDir, file), `FORBIDDEN ${file}`);
    await writeFile(join(project, "AGENTS.md"), "FORBIDDEN PROJECT");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:monchu-nonexistent-test-package@0.0.0"],
        defaultTools: ["ls"],
      }),
    );
    const paths = await readdir(agentDir, { recursive: true });
    const before: { path: string; contents: string; modified: number }[] = [];
    for (const path of paths) {
      const fullPath = join(agentDir, path);
      const info = await stat(fullPath);
      before.push({
        path,
        contents: info.isFile() ? await readFile(fullPath, "utf8") : "",
        modified: info.mtimeMs,
      });
    }
    const agentModified = (await stat(agentDir)).mtimeMs;
    const warnings: string[] = [];
    const extensions = await Extensions.load(
      value.models,
      await loadConfig(value.directory),
      directory,
      (warning) => warnings.push(warning),
    );
    const prompts: string[] = [];
    route(value.faux, (request) => {
      prompts.push(sectionTexts(request.messages).join("\n"));
      return fauxAssistantMessage("ok");
    });
    const { harness, root } = await open({ ...value, registry: extensions.registry });
    try {
      await root.configure({ cwd: project }, context);
      await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
      await extensions.reload();
      await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
      expect(prompts.length).toBe(2);
      for (const prompt of prompts) expect(prompt).not.toContain("FORBIDDEN");
      expect(warnings.join("\n")).not.toMatch(/Pi package|FORBIDDEN/);
      expect(extensions.settings.getDefaultTools()).toBeUndefined();
      expect(await readdir(agentDir, { recursive: true })).toEqual(paths);
      expect((await stat(agentDir)).mtimeMs).toBe(agentModified);
      for (const entry of before) {
        const fullPath = join(agentDir, entry.path);
        expect((await stat(fullPath)).mtimeMs).toBe(entry.modified);
        if ((await stat(fullPath)).isFile())
          expect(await readFile(fullPath, "utf8")).toBe(entry.contents);
      }
    } finally {
      await harness.close(context);
    }
  });

  it("does not hardcode the user name", async () => {
    await setup();
    const repo = fileURLToPath(new URL("../", import.meta.url));
    for await (const path of glob("src/**/*.ts", { cwd: repo })) {
      expect(await readFile(join(repo, path), "utf8"), path).not.toMatch(/jorge/i);
    }
    expect(
      await readFile(new URL("../skills/monchu/SKILL.md", import.meta.url), "utf8"),
    ).not.toMatch(/jorge/i);
  });
});
