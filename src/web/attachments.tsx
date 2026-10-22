/**
 * Files for the next message: the attach button, the paste key, a paste anywhere on the page and a drop add them, each
 * uploads at once, and the tray shows them (images as previews) until a message takes them, uploaded or not; the message's
 * row over the editor counts them while it goes. A sent message shows its images and files under its text.
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
  /** Settles with `stored`, or fails with the error named. */
  ready: Promise<Attachment>;
};

/** Every file the page holds, by key: in the tray, or going with a message being sent. */
const files = signal<ReadonlyMap<number, Pending>>(new Map());
/** The tray: the files waiting for the next message, in the order added. */
const tray = signal<readonly number[]>([]);
let nextKey = 1;
let picker: HTMLInputElement | null = null;

function update(key: number, change: Partial<Pending>): void {
  const item = files.value.get(key);
  if (item !== undefined) files.value = new Map(files.value).set(key, { ...item, ...change });
}

function forget(keys: readonly number[]): void {
  const next = new Map(files.value);
  for (const key of keys) next.delete(key);
  files.value = next;
}

function remove(key: number): void {
  tray.value = tray.value.filter((each) => each !== key);
  forget([key]);
}

/** Drops every waiting file; returns how many there were. */
export function clearPending(): number {
  const count = tray.value.length;
  forget(tray.value);
  tray.value = [];
  return count;
}

/** Whether a file waits for the next message. */
export const hasPending = (): boolean => tray.value.length > 0;

/** Takes the waiting files for a message being sent, uploaded or not; failed ones stay in the tray to be seen. */
export function takePending(): number[] {
  const taken = tray.value.filter((key) => files.value.get(key)?.error === undefined);
  tray.value = tray.value.filter((key) => !taken.includes(key));
  return taken;
}

/** Taken files' attachments once every one is up; fails with the first that didn't make it. */
export function uploaded(keys: readonly number[]): Promise<Attachment[]> {
  return Promise.all(
    keys.map((key) => files.value.get(key)?.ready ?? Promise.reject(new Error("file removed"))),
  );
}

/** How many of the taken files are up. */
export const upCount = (keys: readonly number[]): number =>
  keys.filter((key) => files.value.get(key)?.stored !== undefined).length;

/** A message that didn't go: its files go back to the tray, ahead of any added since. */
export function restorePending(keys: readonly number[]): void {
  tray.value = [...keys.filter((key) => files.value.has(key)), ...tray.value];
}

/** A message went: its files are done with. */
export const sentPending = (keys: readonly number[]): void => forget(keys);

/** Uploads each file through `attach` and shows it in the tray meanwhile. */
export function addFiles(
  added: Iterable<File>,
  attach: (name: string, data: Uint8Array) => Promise<Attachment>,
): void {
  for (const file of added) {
    const key = nextKey++;
    // A pasted image comes as "image.png" or with no name at all.
    const name = attachmentName(file.name || imageFileName(file.type));
    const image = file.type.startsWith("image/");
    const full =
      tray.value.filter((each) => files.value.get(each)?.error === undefined).length >=
      ATTACHMENTS_PER_MESSAGE;
    const error = full
      ? `a message takes at most ${ATTACHMENTS_PER_MESSAGE} attachments`
      : file.size > ATTACHMENT_MAX_BYTES
        ? `larger than the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit`
        : undefined;
    const ready =
      error !== undefined
        ? Promise.reject(new Error(`${name} · ${error}`))
        : file
            .arrayBuffer()
            .then((buffer) => {
              const data = new Uint8Array(buffer);
              if (image) update(key, { preview: `data:${file.type};base64,${toBase64(data)}` });
              return attach(name, data);
            })
            .then(
              (stored) => {
                update(key, { stored });
                return stored;
              },
              (failure: unknown) => {
                const message = failure instanceof Error ? failure.message : String(failure);
                update(key, { error: message });
                throw new Error(`${name} · ${message}`);
              },
            );
    // Its failure shows in the tray; a message waiting on it hears it from `uploaded`.
    ready.catch(() => {});
    files.value = new Map(files.value).set(key, {
      key,
      name,
      size: file.size,
      preview: undefined,
      stored: undefined,
      error,
      ready,
    });
    tray.value = [...tray.value, key];
  }
}

/** Whether the page may read the clipboard: a secure page in a browser that has `read`. */
const canReadClipboard = (): boolean =>
  "clipboard" in navigator && typeof navigator.clipboard.read === "function";

/**
 * Ctrl+V for a touch screen, whose keyboard can't put an image in a text box: the clipboard's images attach, else its
 * text goes to `text`. Fails when the browser refuses or the clipboard holds neither.
 */
async function pasteClipboard(
  onFiles: (files: File[]) => void,
  onText: (text: string) => void,
): Promise<void> {
  const images: File[] = [];
  let text = "";
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((each) => each.startsWith("image/"));
    if (type !== undefined)
      images.push(new File([await item.getType(type)], imageFileName(type), { type }));
    else if (!text && item.types.includes("text/plain"))
      text = await (await item.getType("text/plain")).text();
  }
  if (images.length > 0) onFiles(images);
  else if (text) onText(text);
  else throw new Error("nothing to paste");
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

/** The paste key, where the page may read the clipboard: Ctrl+V for a touch keyboard, which can't paste an image here. */
export function PasteButton(props: {
  onFiles: (files: File[]) => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  if (!canReadClipboard()) return null;
  return (
    <button
      type="button"
      class="icon"
      title="paste an image or text from the clipboard (Ctrl+V)"
      aria-label="paste"
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() =>
        void pasteClipboard(props.onFiles, props.onText).catch((error: unknown) =>
          props.onError(error instanceof Error ? error.message : String(error)),
        )
      }
    >
      ❐
    </button>
  );
}

/** The waiting files: an image as a preview, any other file by name; each with its size or failure, and a remove. */
export function AttachmentTray() {
  const items = tray.value.flatMap((key) => files.value.get(key) ?? []);
  if (items.length === 0) return null;
  return (
    <ul class="attach-tray">
      {items.map((item) => (
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

/** A sent message's or tool result's images and files: images as thumbnails that open full size on a tap, files by name. */
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
