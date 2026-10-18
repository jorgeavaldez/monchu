/**
 * Nothing in Monchu's home can keep it down: each case runs the real entry point (`serve`, which forks the core) on a
 * home that breaks it, and checks a client still reaches a front that answers. Every way the home adds code or
 * settings belongs here (see AGENTS.md).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteClient } from "../src/api/remote.ts";
import { attachSocket, socketPath } from "../src/server/socket.ts";
import {
  cleanup,
  front,
  logText,
  runEntry,
  smokeHome,
  textOf,
  waitFor,
  type EntryRun,
} from "./support.ts";

afterEach(cleanup);

/** Serve `home` until its core is ready, attached as a client; `stop` ends both. */
async function serve(home: string, web = false) {
  const server: EntryRun = runEntry(home, ["serve", ...(web ? ["--web"] : [])], "core ready");
  await server.seen;
  const notices: string[] = [];
  const attached = await attachSocket(socketPath(home), () => {});
  if (attached === undefined) throw new Error(`Nothing answers:\n${server.output()}`);
  attached.client.onReport((notice) => notices.push(notice));
  return {
    client: attached.client,
    notices,
    output: () => server.output(),
    stop: async () => {
      await attached.close();
      const stopped = await runEntry(home, ["stop"]).exited;
      expect(stopped.output).toContain("stopped the Monchu of");
      expect((await server.exited).code).toBe(0);
    },
  };
}

/** Every message text of the current front, oldest first. */
async function frontTexts(client: RemoteClient): Promise<() => string[]> {
  const view = await (await front(client)).viewState();
  return () => view.value.entries.flatMap((entry) => (entry.model ?? []).map(textOf));
}

/** The front answers a message (smoke mode's faux reply, unless `reply` names another): the core it reaches runs. */
async function answers(client: RemoteClient, text: string, reply = `Faux reply: ${text}.`) {
  const texts = await frontTexts(client);
  await (await front(client)).submit(text, `unbreakable:${text}`, "followUp");
  await waitFor(() => texts().some((each) => each.startsWith(reply)), 30_000);
}

describe("a home that breaks the core", () => {
  it("comes up in safe mode when a home plugin kills the core as it starts", async () => {
    const home = await smokeHome({ killer: "export default () => { process.exit(3); };\n" });
    const monchu = await serve(home);
    try {
      // The front hears why, and still answers.
      const texts = await frontTexts(monchu.client);
      await waitFor(() =>
        texts().some((text) =>
          text.includes("Monchu restarted in safe mode, without home plugins"),
        ),
      );
      expect(texts().find((text) => text.includes("safe mode"))).toContain("failed to start");
      await answers(monchu.client, "hi");
      expect(await logText(home)).toContain("Monchu restarted in safe mode");
    } finally {
      await monchu.stop();
    }
  }, 180_000);

  it("comes up in safe mode when a home plugin hangs the core as it starts", async () => {
    // A busy loop: no timer of the core's own can end it, only the server's 60 s wait for a ready core.
    const home = await smokeHome({ spinner: "export default () => { for (;;) {} };\n" });
    const monchu = await serve(home);
    try {
      const texts = await frontTexts(monchu.client);
      await waitFor(() => texts().some((text) => text.includes("child not ready in time")));
      await answers(monchu.client, "hi");
    } finally {
      await monchu.stop();
    }
  }, 240_000);

  it("restarts a core a plugin crashes once it runs, and in safe mode when it crashes again", async () => {
    const home = await smokeHome({
      bomb: `export default (monchu) => {
  monchu.registerCommand("boom", { description: "crash the core", handler: () => process.exit(4) });
};
`,
    });
    const monchu = await serve(home);
    try {
      const crashes = async () =>
        (await logText(home)).split("\n").filter((line) => line === "core crashed").length;
      const reconnected = () =>
        monchu.notices.filter((notice) => notice === "reconnected to Monchu").length;
      // The first crash: the core comes back as it was, plugin and all.
      await (await front(monchu.client)).command("boom", "").catch(() => "");
      await waitFor(async () => (await crashes()) === 1 && reconnected() === 1, 60_000);
      await answers(monchu.client, "back");
      expect(monchu.client.commands().map((command) => command.name)).toContain("boom");
      // The second crash within minutes: the core comes back without home plugins.
      await (await front(monchu.client)).command("boom", "").catch(() => "");
      await waitFor(async () => (await crashes()) === 2 && reconnected() === 2, 60_000);
      await expect((await front(monchu.client)).command("boom", "")).rejects.toThrow(
        "Unknown command",
      );
      const texts = await frontTexts(monchu.client);
      await waitFor(() =>
        texts().some((text) =>
          text.includes("Monchu restarted in safe mode, without home plugins"),
        ),
      );
      expect(texts().some((text) => text.includes("Monchu's core crashed and restarted"))).toBe(
        true,
      );
      await answers(monchu.client, "safe");
    } finally {
      await monchu.stop();
    }
  }, 240_000);

  it("opens as usual, without safe mode, when every file it reads from the home is broken", async () => {
    const home = await smokeHome({
      syntax: "export default (\n",
      throws: 'throw new Error("import boom");\n',
      clash: `import { defineTask } from "monchu/plugin";
export default (monchu) => monchu.registerTask(defineTask({ name: "monchu.job", version: 1, initial: () => ({ phase: "run" }), phases: { run: async () => {} } }));
`,
      handlers: `export default (monchu) => {
  monchu.on("context", () => { throw new Error("context boom"); });
  monchu.on("tool_call", () => { throw new Error("guard boom"); });
  monchu.registerSection("broken", () => { throw new Error("section boom"); });
};
`,
    });
    // Synced files an agent edits, and the device's own; none of them JSON.
    for (const file of [
      "mcp.json",
      "mcp-auth.json",
      "mcp-tools.json",
      "web.json",
      "web-sessions.json",
      "web-client.json",
    ])
      await writeFile(join(home, file), "{not json");
    await mkdir(join(home, "skills", "broken"), { recursive: true });
    await writeFile(join(home, "skills", "broken", "SKILL.md"), "---\nname: [\n---\n");
    await mkdir(join(home, "memories"), { recursive: true });
    await writeFile(join(home, "memories", "USER.md"), "\u0000\u0001 not text");
    const monchu = await serve(home, true);
    try {
      await answers(monchu.client, "hi");
      // A tool round, past the plugin's throwing guard.
      await answers(monchu.client, "read", "Faux tool finished.");
      const log = await logText(home);
      expect(log).not.toContain("safe mode");
      expect(log).not.toContain("core crashed");
      for (const part of ["mcp.json", "SKILL.md", "Plugin syntax", "Plugin throws", "Plugin clash"])
        expect(log).toContain(part);
      expect(monchu.output()).toContain("web is off");
    } finally {
      await monchu.stop();
    }
  }, 180_000);

  it("opens as usual when the device's plugin deny list is broken: no home plugin loads", async () => {
    const home = await smokeHome({ fine: "export default () => {};\n" });
    await writeFile(join(home, "plugins.local.json"), "{not json");
    const monchu = await serve(home);
    try {
      await answers(monchu.client, "hi");
      expect(await logText(home)).toContain("so no home plugin loads");
    } finally {
      await monchu.stop();
    }
  }, 180_000);

  it("opens as usual on a broken auth.json, and says what fails until it is fixed", async () => {
    const home = await smokeHome();
    await writeFile(join(home, "auth.json"), "{not json");
    const monchu = await serve(home);
    try {
      await waitFor(async () => (await logText(home)).includes("Invalid Monchu auth.json"));
      expect(await logText(home)).toContain("/login can't save one");
      expect(await logText(home)).not.toContain("safe mode");
    } finally {
      await monchu.stop();
    }
  }, 180_000);
});
