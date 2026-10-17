/**
 * Files the user attaches to a message, as every client and the core share them. Browser-safe. The core stores each
 * one in the home's `attachments/<id>`, and the message names it by path in an `<attachments>` note, so the agent can
 * read it or hand it to a worker; an image the model can take also goes inline after the note.
 */
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";

/** A stored attachment: `id` is `<upload>/<name>` under the home's `attachments/`. */
export type Attachment = { id: string; name: string; size: number };

/** Largest file one attachment may be. */
export const ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
/** Most attachments one message may carry. */
export const ATTACHMENTS_PER_MESSAGE = 10;
/** Raw bytes per upload call: its base64 stays well under the socket's 4 MB message limit. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/** A client's upload id: one random UUID per file. */
export const UPLOAD_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A file name safe on every platform and in the note: letters, digits, `.`, `_`, `-` and spaces, no leading dot, at most
 * 100 characters.
 */
export function attachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const safe = base
    .replace(/[^\w. -]/g, "_")
    .replace(/^[. ]+/, "")
    .trim();
  if (!safe) return "attachment";
  if (safe.length <= 100) return safe;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
  return safe.slice(0, 100 - extension.length) + extension;
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

/** A MIME type from a file name's extension, for display and for clients that only have a path. */
export function mimeTypeOf(name: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (
    (extension === undefined ? undefined : MIME_TYPES[extension]) ?? "application/octet-stream"
  );
}

/** Whether a file name looks like an image a model can take once prepared. */
export const isImageName = (name: string): boolean =>
  /^image\/(png|jpeg|gif|webp|bmp)$/.test(mimeTypeOf(name));

/** An image's format by its first bytes, for those Photon decodes: a name's extension may lie. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  return undefined;
}

/** A file name for a clipboard or pasted image of `mimeType`. */
export function imageFileName(mimeType: string, stem = "pasted"): string {
  const extension = Object.entries(MIME_TYPES).find(([, type]) => type === mimeType)?.[0];
  return `${stem}.${extension ?? "png"}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Standard base64, 8 KiB at a time: one `String.fromCharCode` call with megabytes of arguments overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

/** One attached file as the message's note lists it. */
export type AttachedFile = {
  path: string;
  name: string;
  mimeType: string;
  size: string;
  /** What else the note says: that the image follows, was resized, or couldn't be shown. */
  detail: string | undefined;
};

const NOTE_START = "<attachments>\n";
const NOTE_END = "\n</attachments>";

/** The note that names each attached file by path; one line each, with its type, size and what became of it. */
export function attachmentsNote(files: readonly Omit<AttachedFile, "name">[]): string {
  const lines = files.map(
    (file) =>
      `- ${file.path} (${[file.mimeType, file.size, ...(file.detail === undefined ? [] : [file.detail])].join(", ")})`,
  );
  return `${NOTE_START}${lines.join("\n")}${NOTE_END}`;
}

/** The files a note lists; undefined for any other text. */
export function parseAttachmentsNote(text: string): AttachedFile[] | undefined {
  if (!text.startsWith(NOTE_START) || !text.endsWith(NOTE_END)) return undefined;
  const files: AttachedFile[] = [];
  for (const line of text.slice(NOTE_START.length, -NOTE_END.length).split("\n")) {
    const match = /^- (.+) \(([^()]*)\)$/.exec(line);
    if (match === null) return undefined;
    const [path = "", fields = ""] = match.slice(1);
    const [mimeType = "", size = "", ...detail] = fields.split(", ");
    files.push({
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      mimeType,
      size,
      detail: detail.length ? detail.join(", ") : undefined,
    });
  }
  return files;
}

/** A user message split for display: its own text, the files its note lists, and its inline images. */
export function messageParts(content: UserMessage["content"]): {
  text: string;
  files: AttachedFile[];
  images: ImageContent[];
} {
  if (typeof content === "string") return { text: content, files: [], images: [] };
  const text: string[] = [];
  const files: AttachedFile[] = [];
  const images: ImageContent[] = [];
  for (const part of content) {
    if (part.type === "image") images.push(part);
    else {
      const note = parseAttachmentsNote(part.text);
      if (note === undefined) text.push(part.text);
      else files.push(...note);
    }
  }
  return { text: text.join("\n\n"), files, images };
}
