/**
 * The user's attachments on the core's side: uploads land in the home's `attachments/<upload>/<name>`, and a message
 * carrying them names each by path, with the images a model can take inline after the note.
 */
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  attachmentName,
  attachmentsNote,
  formatBytes,
  imageMimeType,
  mimeTypeOf,
  UPLOAD_ID,
  type Attachment,
} from "../api/attachments.ts";

const directory = (home: string) => join(home, "attachments");

const tooLarge = (name: string) =>
  new Error(`${name} is larger than the ${formatBytes(ATTACHMENT_MAX_BYTES)} attachment limit`);

/** Stores a whole file from a client in this process. */
export async function storeAttachment(
  home: string,
  name: string,
  data: Uint8Array,
): Promise<Attachment> {
  const safe = attachmentName(name);
  if (data.length > ATTACHMENT_MAX_BYTES) throw tooLarge(safe);
  const upload = randomUUID();
  await mkdir(join(directory(home), upload), { recursive: true });
  await writeFile(join(directory(home), upload, safe), data);
  return { id: `${upload}/${safe}`, name: safe, size: data.length };
}

/**
 * One chunk of a remote upload, written at `offset`; a retried chunk writes the same bytes again. With `done`, the
 * file takes its name and the attachment comes back; a retried `done` returns it again.
 */
export async function writeUpload(
  home: string,
  chunk: { upload: string; name: string; offset: number; data: string; done: boolean },
): Promise<Attachment | null> {
  if (!UPLOAD_ID.test(chunk.upload)) throw new Error("Invalid upload id");
  const safe = attachmentName(chunk.name);
  const folder = join(directory(home), chunk.upload);
  const partial = join(folder, ".part");
  const final = join(folder, safe);
  const bytes = Buffer.from(chunk.data, "base64");
  const finished = await stat(final).catch(() => undefined);
  if (finished !== undefined)
    return { id: `${chunk.upload}/${safe}`, name: safe, size: finished.size };
  await mkdir(folder, { recursive: true });
  const size = (await stat(partial).catch(() => undefined))?.size ?? 0;
  if (chunk.offset > size) throw new Error(`Upload of ${safe} is missing a chunk`);
  if (chunk.offset + bytes.length > ATTACHMENT_MAX_BYTES) throw tooLarge(safe);
  const file = await open(partial, size === 0 && chunk.offset === 0 ? "w" : "r+");
  try {
    await file.write(bytes, 0, bytes.length, chunk.offset);
  } finally {
    await file.close();
  }
  if (!chunk.done) return null;
  const total = chunk.offset + bytes.length;
  if ((await stat(partial)).size !== total) throw new Error(`Upload of ${safe} is incomplete`);
  await rename(partial, final);
  return { id: `${chunk.upload}/${safe}`, name: safe, size: total };
}

/** A stored attachment's path; refuses an id that names anything outside the attachments folder. */
function pathOf(home: string, id: string): string {
  const [upload = "", name = "", ...rest] = id.split("/");
  if (rest.length || !UPLOAD_ID.test(upload) || attachmentName(name) !== name)
    throw new Error(`Invalid attachment ${id}`);
  return join(directory(home), upload, name);
}

/** What turns a message's images into content the model takes, and how many image bytes its conversation holds. */
export type ImageInput = {
  processor: ImageProcessor;
  limits: ImageLimits;
  budget: number;
  held(): Promise<number>;
};

/**
 * A message with its attachments, and the text the routing helper reads. With `images`, the images the model can take
 * follow the note inline, refused as a whole when they would take the conversation past its image budget; without it,
 * as for a worker, the note alone names them for the agent to read.
 */
export async function attachedInput(
  home: string,
  message: string,
  attachments: readonly Attachment[],
  images: ImageInput | undefined,
): Promise<{ content: UserMessage["content"]; text: string }> {
  if (attachments.length === 0) return { content: message, text: message };
  if (attachments.length > ATTACHMENTS_PER_MESSAGE)
    throw new Error(`A message takes at most ${ATTACHMENTS_PER_MESSAGE} attachments`);
  const files: Parameters<typeof attachmentsNote>[0][number][] = [];
  const inline: ImageContent[] = [];
  for (const attachment of attachments) {
    const path = pathOf(home, attachment.id);
    const bytes = await readFile(path).catch(() => {
      throw new Error(`Attachment ${attachment.name} is missing; attach it again`);
    });
    const type = imageMimeType(bytes);
    const file = { path, mimeType: type ?? mimeTypeOf(path), size: formatBytes(bytes.length) };
    if (type === undefined) files.push({ ...file, detail: undefined });
    else if (images === undefined) files.push({ ...file, detail: "an image: read it to see it" });
    else {
      const prepared = await images.processor.prepare(bytes, type, images.limits);
      if (prepared === undefined) {
        files.push({ ...file, detail: "an image that could not be prepared for the model" });
        continue;
      }
      const { resized } = prepared;
      files.push({
        ...file,
        detail:
          resized === undefined
            ? "shown below"
            : `shown below resized from ${resized.from.width}x${resized.from.height} to ${resized.to.width}x${resized.to.height}`,
      });
      inline.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
    }
  }
  const adding = inline.reduce((sum, image) => sum + image.data.length, 0);
  if (images !== undefined && adding > 0) {
    const held = await images.held();
    if (held + adding > images.budget)
      throw new Error(
        `Images refused: this conversation already holds ${formatBytes(held)} of images and these add ${formatBytes(adding)}, past its ${formatBytes(images.budget)} budget. Start a fresh context with /new, or send fewer or smaller images.`,
      );
  }
  const note = attachmentsNote(files);
  const text = message.trim() ? `${message}\n\n${note}` : note;
  if (images === undefined) return { content: text, text };
  const blocks: TextContent[] = [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    { type: "text", text: note },
  ];
  return { content: [...blocks, ...inline], text };
}
