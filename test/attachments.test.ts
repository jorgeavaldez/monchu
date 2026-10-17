import { createProvider, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { messageParts, UPLOAD_CHUNK_BYTES } from "../src/api/attachments.ts";
import { attachedInput, storeAttachment } from "../src/core/attachments.ts";
import { Monchu } from "../src/core/backend.ts";
import { images } from "../src/core/tools/images.ts";
import { ingress, openCoreHost } from "../src/server/host.ts";
import { attachSocket, serveSocket, socketPath } from "../src/server/socket.ts";
import { pastedImagePaths } from "../src/tui/system.ts";
import { initTheme } from "../src/tui/theme/theme.ts";
import { MonchuTui } from "../src/tui/view.ts";
import { presentation } from "../src/ui/state.ts";
import {
  cleanup,
  context,
  fauxRole,
  front,
  open,
  prepareHome,
  route,
  setup,
  waitFor,
  writePng,
} from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(cleanup);

const LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

describe("attachments", () => {
  it("uploads files over the socket in chunks and sends the front the images inline and every file by path", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, classifier: null }),
    );
    prepareHome(home);
    const requests: Message[][] = [];
    route(value.faux, (request) => {
      requests.push([...request.messages]);
      return fauxAssistantMessage("seen");
    });
    const backend = await Monchu.open(
      home,
      createProvider({
        id: value.faux.provider.id,
        models: value.faux.models,
        api: value.faux.provider,
        auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
      }),
    );
    const path = socketPath(home);
    const host = await openCoreHost(backend);
    const server = await serveSocket(ingress(host), backend.log, path);
    const attached = await attachSocket(path, () => {});
    try {
      if (attached === undefined) throw new Error("Nothing answered on the socket");
      const root = await front(attached.client);
      // Noise past one upload chunk, and wider than the model takes.
      const png = join(value.directory, "wide.png");
      await writePng(png, 2400, 300);
      const bytes = new Uint8Array(await readFile(png));
      expect(bytes.length).toBeGreaterThan(UPLOAD_CHUNK_BYTES);
      const image = await root.attach("screen shot (1).png", bytes);
      const notes = await root.attach("notes.txt", new TextEncoder().encode("remember this"));
      expect(image).toMatchObject({ name: "screen shot _1_.png", size: bytes.length });

      const view = await root.viewState();
      await root.submit("what is this?", "attach:1", "followUp", [image, notes]);
      await waitFor(() => requests.length > 0 && !presentation(view.value).busy);

      // The model gets the text, the note naming both files by path, and the image shrunk to its limits.
      const last = requests.at(-1)?.at(-1);
      if (last?.role !== "user" || typeof last.content === "string")
        throw new Error("Expected the user's message with attachments");
      const { text, files, images: inline } = messageParts(last.content);
      expect(text).toBe("what is this?");
      expect(files.map((file) => [file.name, file.mimeType, file.detail])).toEqual([
        ["screen shot _1_.png", "image/png", "shown below resized from 2400x300 to 2000x250"],
        ["notes.txt", "text/plain", undefined],
      ]);
      expect(inline).toHaveLength(1);
      // Each file is stored whole in the home, where the agent can read it or hand it on.
      expect(new Uint8Array(await readFile(files[0]?.path ?? ""))).toEqual(bytes);
      expect(await readFile(files[1]?.path ?? "", "utf8")).toBe("remember this");
      expect(files[0]?.path.startsWith(join(home, "attachments"))).toBe(true);
      view.dispose();
    } finally {
      await attached?.close();
      await server.close();
      await host.close();
      await backend.close();
    }
  }, 60_000);

  it("names a worker's attachments by path, and refuses images past the conversation's budget", async () => {
    const value = await setup();
    const png = join(value.directory, "shot.png");
    await writePng(png, 300, 300);
    const stored = await storeAttachment(value.directory, "shot.png", await readFile(png));
    const worker = await attachedInput(value.directory, "", [stored], undefined);
    expect(worker.content).toBe(worker.text);
    expect(worker.text).toMatch(
      /^<attachments>\n- .*shot\.png \(image\/png, .*, an image: read it to see it\)\n<\/attachments>$/,
    );

    const input = (held: number, budget: number) =>
      attachedInput(value.directory, "look", [stored], {
        processor: images,
        limits: LIMITS,
        budget,
        held: async () => held,
      });
    expect(messageParts((await input(0, 10 * 1024 * 1024)).content).images).toHaveLength(1);
    await expect(input(10 * 1024 * 1024, 10 * 1024 * 1024)).rejects.toThrow("Images refused");
    // An id outside the attachments folder is refused.
    await expect(
      attachedInput(
        value.directory,
        "x",
        [{ id: "../../etc/passwd", name: "passwd", size: 1 }],
        undefined,
      ),
    ).rejects.toThrow("Invalid attachment");
  });

  it("attaches an image path pasted into the terminal, as a dropped file pastes it", async () => {
    const value = await setup();
    const png = join(value.directory, "my shot.png");
    await writePng(png, 10, 10);
    const escaped = png.replaceAll(" ", "\\ ");
    expect(pastedImagePaths(`'${png}'`)).toEqual([png]);
    expect(pastedImagePaths(pathToFileURL(png).href)).toEqual([png]);
    if (process.platform !== "win32") expect(pastedImagePaths(escaped)).toEqual([png]);
    // Text, a missing file and a file that isn't an image type as usual.
    expect(pastedImagePaths("look at this")).toBeUndefined();
    expect(pastedImagePaths(join(value.directory, "missing.png"))).toBeUndefined();
    expect(pastedImagePaths(join(value.directory, "config.json"))).toBeUndefined();
  });

  it("attaches in the terminal by paste and Ctrl+V, sends the files with the message, and labels them in the transcript", async () => {
    const value = await setup();
    const png = join(value.directory, "shot.png");
    await writePng(png, 40, 40);
    route(value.faux, () => fauxAssistantMessage("seen"));
    const { harness, root } = await open(value);
    initTheme("dark");
    const screen = new VirtualTerminal(80, 24);
    const sent: [string, string[]][] = [];
    let clipboard = 0;
    const ui: MonchuTui = new MonchuTui(screen, value.directory, {
      submit: (text, _whenBusy, files) => sent.push([text, files.map((file) => file.name)]),
      pasteClipboard: () => clipboard++,
      pasted: (text) => {
        const paths = pastedImagePaths(text);
        if (paths === undefined) return false;
        ui.attachFiles(
          paths.map((path) => ({ name: "shot.png", data: new Uint8Array(path.length) })),
        );
        return true;
      },
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const viewport = async () => {
      ui.ui.renderNow();
      return (await screen.flushAndGetViewport()).join("\n");
    };
    const state = await root.viewState(context);
    try {
      ui.apply(state.value);
      ui.start();
      screen.sendInput(`\x1b[200~${png}\x1b[201~`);
      await waitFor(async () => (await viewport()).includes("attached · shot.png"));
      // Text pastes type as before.
      screen.sendInput("\x1b[200~plain text\x1b[201~");
      await waitFor(async () => (await viewport()).includes("plain text"));
      screen.sendInput(process.platform === "win32" ? "\x1bv" : "\x16");
      await waitFor(() => clipboard === 1);
      screen.sendInput("\r");
      await waitFor(() => sent.length === 1);
      expect(sent).toEqual([["plain text", ["shot.png"]]]);
      expect(await viewport()).not.toContain("attached · shot.png");
      // Files alone make a message.
      ui.attachFiles([{ name: "a.pdf", data: new Uint8Array(3) }]);
      screen.sendInput("\r");
      await waitFor(() => sent.length === 2);
      expect(sent[1]).toEqual(["", ["a.pdf"]]);

      const stored = await storeAttachment(value.directory, "shot.png", await readFile(png));
      const input = await attachedInput(value.directory, "look", [stored], {
        processor: images,
        limits: LIMITS,
        budget: 10 * 1024 * 1024,
        held: async () => 0,
      });
      await (await root.submit({ type: "input", content: input.content }, context)).wait(context);
      ui.apply(state.value);
      await waitFor(async () => /attached · shot\.png · \d+ KB · image/.test(await viewport()));
    } finally {
      state.dispose();
      ui.stop();
      await harness.close(context);
    }
  });
});
