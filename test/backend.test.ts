import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/backend.ts";
import { cleanup, fauxRole, lastMessage, route, setup, textOf, type Setup } from "./support.ts";

afterEach(cleanup);

/** A real backend on faux roles in `<directory>/home`, with Pi user resources in the test's agent directory. */
async function openBackend(value: Setup): Promise<{ home: string; backend: Monchu }> {
  const home = join(value.directory, "home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  return { home, backend: await Monchu.open(home, value.faux.provider) };
}

describe("backend", () => {
  it("delivers skill and defaultTools warnings with collision locations to subscribers and the log", async () => {
    const value = await setup();
    const { agentDir } = value;
    const invalidPath = join(agentDir, "skills", "broken", "SKILL.md");
    const firstPath = join(agentDir, "skills", "vault", "SKILL.md");
    const secondPath = join(agentDir, "extra", "vault", "SKILL.md");
    for (const directory of [
      join(agentDir, "skills", "broken"),
      join(agentDir, "skills", "vault"),
      join(agentDir, "extra", "vault"),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(invalidPath, "---\nname: broken\n---\nno description");
    for (const path of [firstPath, secondPath]) {
      await writeFile(path, "---\nname: vault\ndescription: vault workflow\n---\nbody");
    }
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ skills: ["extra"], defaultTools: ["read", "bash", "Typo"] }),
    );
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
      const collision = warnings.find((message) => message.includes('name "vault" collision'));
      expect(collision).toContain(firstPath);
      expect(collision).toContain(secondPath);
      expect(collision).toContain("winner:");
      expect(collision).toContain("loser:");
      expect(warnings).toContain("Pi defaultTools has unknown built-ins (ignored): Typo");
    } finally {
      await backend.close();
    }
    // Reports deliberately doesn't await logging; wait for the actual file contents, not a delay.
    await expect
      .poll(async () => {
        const log = await readFile(join(home, "monchu.log"), "utf8");
        return [invalidPath, firstPath, secondPath, "Typo"].every((item) => log.includes(item));
      })
      .toBe(true);
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
});
