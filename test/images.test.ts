import { defineExtension } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { imageBudget } from "../src/core/tools/images.ts";
import {
  callTools,
  cleanup,
  context,
  open,
  route,
  setup,
  textOf,
  toolResults,
  writePng,
} from "./support.ts";

afterEach(cleanup);

const images = (message: Awaited<ReturnType<typeof toolResults>>[number] | undefined) =>
  (message?.content ?? []).filter((part) => part.type === "image");

describe("images", () => {
  it("read returns an image shrunk to the model's limits, with the scale", async () => {
    const value = await setup();
    await writePng(join(value.directory, "wide.png"), 3000, 200);
    route(value.faux, callTools({ look: { tool: "read", args: { path: "wide.png" } } }));
    const { harness, root } = await open(value);
    try {
      await (await root.submit({ type: "input", content: "look" }, context)).wait(context);
      const [result] = await toolResults(root);
      expect(result?.isError).toBe(false);
      expect(images(result)).toHaveLength(1);
      expect(textOf(result)).toContain("Resized from 3000x200 to 2000x133");
    } finally {
      await harness.close(context);
    }
  });

  it("refuses an image past the conversation's budget and keeps the conversation working", async () => {
    const value = await setup();
    const path = join(value.directory, "shot.png");
    await writePng(path, 300, 300);
    const size = Buffer.from(await readFile(path)).toString("base64").length;
    // Room for one image, not two.
    value.registry.install(
      defineExtension({ name: "test.budget", hooks: imageBudget(size * 1.5) }),
    );
    route(
      value.faux,
      callTools({
        first: { tool: "read", args: { path: "shot.png" } },
        second: { tool: "read", args: { path: "shot.png" } },
      }),
    );
    const { harness, root } = await open(value);
    try {
      for (const message of ["first", "second", "after"])
        await (await root.submit({ type: "input", content: message }, context)).wait(context);
      const [first, second] = await toolResults(root);
      expect(first?.isError).toBe(false);
      expect(images(first)).toHaveLength(1);
      expect(second?.isError).toBe(true);
      expect(images(second)).toHaveLength(0);
      expect(textOf(second)).toContain("Image refused");
      // The next turn still answers.
      const last = (await root.entries({}, 1, undefined, context)).items[0];
      expect(last?.model?.[0]?.role).toBe("assistant");
    } finally {
      await harness.close(context);
    }
  });
});
