import { fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiContext } from "../src/context.ts";
import { cleanup, context, open, route, setup } from "./support.ts";

afterEach(cleanup);

describe("Pi context", () => {
  it("sends Pi's AGENTS.md files and skills in the system prompt", async () => {
    const value = await setup();
    const agentDir = join(value.directory, "agent");
    await mkdir(join(agentDir, "skills", "vault"), { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "Always answer in lowercase.");
    await writeFile(
      join(agentDir, "skills", "vault", "SKILL.md"),
      "---\nname: vault\ndescription: Edit the Obsidian vault.\n---\nSteps.",
    );
    value.registry.install(createPiContext(agentDir, [], value.directory));
    let system = "";
    route(value.faux, (request) => {
      system = request.messages
        .flatMap((message: Message) =>
          message.role === "system" ? Object.values(message.sections ?? {}) : [],
        )
        .join("\n");
      return fauxAssistantMessage([fauxText("ok")]);
    });
    const { harness, root } = await open(value);
    await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);

    expect(system).toContain("Always answer in lowercase.");
    expect(system).toContain("vault");
    expect(system).toContain("Edit the Obsidian vault.");
    await harness.close(context);
  });
});
