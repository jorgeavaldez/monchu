/**
 * Messages on their way: each is a row in the queue strip over the editor from the tap until the core admits it, so the
 * editor is free for the next one. A message waits for its files and for the one sent before it, so they arrive in order.
 */
import { signal } from "@preact/signals";
import { upCount } from "./attachments.tsx";

type Going = { id: number; text: string; files: readonly number[]; shown: boolean };

const going = signal<readonly Going[]>([]);
let nextId = 1;
let tail: Promise<void> = Promise.resolve();

/** A quick send without files never flashes a row: it shows once it has taken this long. */
const SHOW_AFTER_MS = 400;

/** Whether a message is on its way, for the queue strip. */
export const sendingAny = (): boolean => going.value.some((item) => item.shown);

/** Runs `go` for one message once the messages sent before it are done, its row shown meanwhile. */
export async function sendInOrder<T>(
  text: string,
  files: readonly number[],
  go: () => Promise<T>,
): Promise<T> {
  const id = nextId++;
  going.value = [...going.value, { id, text, files, shown: files.length > 0 }];
  const timer = setTimeout(() => {
    going.value = going.value.map((item) => (item.id === id ? { ...item, shown: true } : item));
  }, SHOW_AFTER_MS);
  const before = tail;
  let done = () => {};
  tail = new Promise((resolve) => (done = resolve));
  try {
    await before;
    return await go();
  } finally {
    clearTimeout(timer);
    done();
    going.value = going.value.filter((item) => item.id !== id);
  }
}

/** Each message on its way: its first line, muted, then its files (up of all while they upload) and ↑. */
export function SendingRows() {
  return (
    <>
      {going.value
        .filter((item) => item.shown)
        .map((item) => {
          const count = item.files.length;
          const up = upCount(item.files);
          const line = item.text.trim().split("\n")[0] ?? "";
          return (
            <li key={item.id} class="sending" title="sending">
              <span class="text">{line}</span>
              {count === 0 ? null : (
                <span class="cell" aria-label={`${count} attached`}>
                  {up < count ? `+${up}/${count}` : `+${count}`}
                </span>
              )}
              <span class="cell" aria-label="sending">
                ↑
              </span>
            </li>
          );
        })}
    </>
  );
}
