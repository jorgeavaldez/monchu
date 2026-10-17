import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Monchu } from "../src/core/backend.ts";
import { Log } from "../src/telemetry/log.ts";
import { formatRecord, logQuery } from "../src/ui/logs.ts";
import { cleanup, fauxRole, prepareHome, route, setup, waitFor } from "./support.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

afterEach(cleanup);

describe("structured log", () => {
  it("appends JSON lines in order, tails them by severity and scope, and drops files older than 14 days", async () => {
    const value = await setup();
    const log = new Log(value.directory);
    await mkdir(log.directory, { recursive: true });
    await writeFile(join(log.directory, "monchu-2000-01-01.jsonl"), "{}\n");
    await writeFile(join(log.directory, "notes.txt"), "not a log\n");
    log.write("info", "core.open", "opened", { config: 3 });
    log.write("warn", "core", "something broke");
    log.write("info", "tui", "ready", { ms: 812 });
    await log.flushed();
    const files = await readdir(log.directory);
    expect(files.filter((name) => name.startsWith("monchu-2000"))).toEqual([]);
    expect(files).toContain("notes.txt");
    const [file = ""] = files.filter((name) => name.endsWith(".jsonl"));
    const lines = (await readFile(join(log.directory, file), "utf8")).trim().split("\n");
    const keys = lines.map((line) => {
      const record: unknown = JSON.parse(line);
      return typeof record === "object" && record !== null ? Object.keys(record) : [];
    });
    expect(keys).toEqual([
      ["time", "severity", "scope", "body", "attributes"],
      ["time", "severity", "scope", "body"],
      ["time", "severity", "scope", "body", "attributes"],
    ]);
    expect((await log.tail({ limit: 10 })).map((record) => record.body)).toEqual([
      "opened",
      "something broke",
      "ready",
    ]);
    expect((await log.tail(logQuery("warn"))).map((record) => record.body)).toEqual([
      "something broke",
    ]);
    expect((await log.tail(logQuery("core"))).map((record) => record.scope)).toEqual([
      "core.open",
      "core",
    ]);
    expect((await log.tail({ limit: 1 })).map(formatRecord)).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\d\.\d{3} info tui · ready · ms=812$/),
    ]);
  });

  it("records the core's open phases, model replies without their content, and client telemetry", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    route(value.faux, () => fauxAssistantMessage("a secret answer"));
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      await backend.submit("a private question", "log:1", "followUp");
      await waitFor(
        async () => (await backend.logs({ limit: 10, scope: "core.model" })).length > 0,
      );
      backend.record("tui", "ready", { ms: 900 });
      const records = await backend.logs({ limit: 50 });
      const open = records.find((record) => record.scope === "core.open");
      expect(Object.keys(open?.attributes ?? {})).toEqual([
        "config",
        "extensions",
        "store",
        "root",
      ]);
      const reply = records.find((record) => record.scope === "core.model");
      expect(reply?.attributes).toMatchObject({ model: "faux/faux-1", stop: "stop" });
      expect(records.find((record) => record.scope === "tui")?.attributes).toEqual({ ms: 900 });
      const raw = (await readdir(join(home, "logs"))).map((name) => join(home, "logs", name));
      const text = (await Promise.all(raw.map((file) => readFile(file, "utf8")))).join("");
      expect(text).not.toContain("secret answer");
      expect(text).not.toContain("private question");
    } finally {
      await backend.close();
    }
  });
});
