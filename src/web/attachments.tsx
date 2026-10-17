/**
 * Files for the next message: the attach button, paste and drop add them, each uploads at once, and the tray shows them
 * (images as previews) until the message goes. A sent message shows its images and files under its text.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { signal, useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  attachmentName,
  formatBytes,
  imageFileName,
  toBase64,
  type AttachedFile,
  type Attachment,
} from "../api/attachments.ts";

type Pending = {
  key: number;
  name: string;
  size: number;
  /** An image's data URL, for its preview: the page's policy allows `data:` images, not `blob:`. */
  preview: string | undefined;
  stored: Attachment | undefined;
  error: string | undefined;
};

/** The files waiting for the next message, in the order added. */
const pending = signal<readonly Pending[]>([]);
let nextKey = 1;
let picker: HTMLInputElement | null = null;

function update(key: number, change: Partial<Pending>): void {
  pending.value = pending.value.map((item) => (item.key === key ? { ...item, ...change } : item));
}

function remove(key: number): void {
  pending.value = pending.value.filter((each) => each.key !== key);
}

/** Drops every waiting file; returns how many there were. */
export function clearPending(): number {
  const count = pending.value.length;
  pending.value = [];
  return count;
}

/** The stored attachments for a message; undefined while one still uploads. Failed ones are left out. */
export function readyAttachments(): Attachment[] | undefined {
  const items = pending.value.filter((item) => item.error === undefined);
  if (items.some((item) => item.stored === undefined)) return undefined;
  return items.flatMap((item) => (item.stored === undefined ? [] : [item.stored]));
}

/** Uploads each file through `attach` and shows it in the tray meanwhile. */
export function addFiles(
  files: Iterable<File>,
  attach: (name: string, data: Uint8Array) => Promise<Attachment>,
): void {
  for (const file of files) {
    const key = nextKey++;
    // A pasted image comes as "image.png" or with no name at all.
    const name = attachmentName(file.name || imageFileName(file.type));
    const image = file.type.startsWith("image/");
    const full =
      pending.value.filter((item) => item.error === undefined).length >= ATTACHMENTS_PER_MESSAGE;
    const error = full
      ? `a message takes at most ${ATTACHMENTS_PER_MESSAGE} attachments`
      : file.size > ATTACHMENT_MAX_BYTES
        ? `larger than the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit`
        : undefined;
    pending.value = [
      ...pending.value,
      {
        key,
        name,
        size: file.size,
        preview: undefined,
        stored: undefined,
        error,
      },
    ];
    if (error !== undefined) continue;
    void file
      .arrayBuffer()
      .then((buffer) => {
        const data = new Uint8Array(buffer);
        if (image) update(key, { preview: `data:${file.type};base64,${toBase64(data)}` });
        return attach(name, data);
      })
      .then(
        (stored) => update(key, { stored }),
        (failure: unknown) =>
          update(key, { error: failure instanceof Error ? failure.message : String(failure) }),
      );
  }
}

/** Opens the file picker, as `/attach` does. */
export function openPicker(): void {
  picker?.click();
}

/** The attach button and its hidden file input; any file type, several at once. */
export function AttachButton(props: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        class="attach-button icon"
        title="attach files or images (or paste, or drop)"
        aria-label="attach files"
        onClick={() => input.current?.click()}
      >
        +
      </button>
      <input
        ref={(element) => {
          input.current = element;
          picker = element;
        }}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // Picking the same file again must fire again.
          event.currentTarget.value = "";
          props.onFiles(files);
        }}
      />
    </>
  );
}

/** The waiting files: an image as a preview, any other file by name; each with its size or failure, and a remove. */
export function AttachmentTray() {
  if (pending.value.length === 0) return null;
  return (
    <ul class="attach-tray">
      {pending.value.map((item) => (
        <li key={item.key} class={item.error === undefined ? "" : "failed"}>
          {item.preview === undefined ? null : <img src={item.preview} alt="" />}
          <span class="attach-name">{item.name}</span>
          <span class="attach-meta">
            {item.error ?? (item.stored === undefined ? "uploading…" : formatBytes(item.size))}
          </span>
          <button type="button" aria-label={`remove ${item.name}`} onClick={() => remove(item.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A sent message's images and files: images as thumbnails that open full size on a tap, files by name. */
export function UserAttachments(props: {
  files: readonly AttachedFile[];
  images: readonly ImageContent[];
}) {
  const open = useSignal<number | undefined>(undefined);
  if (props.files.length === 0 && props.images.length === 0) return null;
  // An image file's line says the image follows; the others are listed by name.
  const listed = props.files.filter((file) => !file.detail?.startsWith("shown"));
  return (
    <div class="attached">
      {props.images.map((image, index) => (
        <img
          key={index}
          class={open.value === index ? "open" : ""}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={
            props.files.filter((file) => file.detail?.startsWith("shown"))[index]?.name ?? "image"
          }
          onClick={() => {
            open.value = open.value === index ? undefined : index;
          }}
        />
      ))}
      {listed.map((file) => (
        <span key={file.path} class="attached-file" title={file.path}>
          {file.name} · {file.size}
          {file.detail === undefined ? "" : ` · ${file.detail}`}
        </span>
      ))}
    </div>
  );
}
