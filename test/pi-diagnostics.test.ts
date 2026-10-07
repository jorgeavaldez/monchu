import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Monchu } from "../src/backend.ts";
import { cleanup, fauxRole, setup } from "./support.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
});

it("delivers skill and defaultTools warnings with collision locations to subscribers and the log", async () => {
  const value = await setup();
  const agentDir = join(value.directory, "agent");
  const home = join(value.directory, "home");
  vi.stubEnv("HOME", value.directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const invalidPath = join(agentDir, "skills", "broken", "SKILL.md");
  const firstPath = join(agentDir, "skills", "vault", "SKILL.md");
  const secondPath = join(agentDir, "extra", "vault", "SKILL.md");
  for (const directory of [
    join(agentDir, "skills", "broken"),
    join(agentDir, "skills", "vault"),
    join(agentDir, "extra", "vault"),
    home,
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
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
  );
  // Real runtime and Durable storage, with a registered local faux provider and no model requests.
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(value.faux.provider);
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(models);
  const backend = await Monchu.open(home);
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
