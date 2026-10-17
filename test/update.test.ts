import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdate } from "../src/core/update.ts";
import { cleanup, setup } from "./support.ts";

afterEach(cleanup);

async function update(home: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpdate(args, {
    home,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("monchu update", () => {
  it("rejects unknown releases and extra arguments with the usage", async () => {
    const { directory } = await setup();
    const bad = await update(directory, "latest; rm -rf ~");
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/^Usage: monchu update/);
    expect((await update(directory, "edge", "1.0.0")).code).toBe(2);
    const help = await update(directory, "--help");
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^Usage: monchu update/);
  });

  it("refuses while a Monchu holds the home, before touching npm", async () => {
    const { directory } = await setup();
    const owner = new DatabaseSync(join(directory, "owner.sqlite"));
    owner.exec("BEGIN EXCLUSIVE");
    try {
      expect(await update(directory, "1.2.0")).toEqual({
        code: 1,
        out: "",
        err: `Monchu is running on ${directory}. Quit it (/quit), then run monchu update again.`,
      });
    } finally {
      owner.close();
    }
  });

  it("leaves a checkout alone and names the release to switch to", async () => {
    const { directory } = await setup();
    const result = await update(directory, "v1.2.0");
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^monchu runs the checkout at .+ \(npm link or a source run\)/);
    expect(result.err).toContain(
      "npm install -g --allow-remote=root https://github.com/jorgeavaldez/monchu/releases/download/v1.2.0/monchu.tgz",
    );
  });
});
