/**
 * The editor: Enter sends (adds a line on a touch screen), Shift-Enter adds a line, Esc stops a running front (or closes
 * the typeahead, or leaves a queued message's edit); the key bar under it taps the same and toggles steer and expand.
 * No key here is one a browser or the system binds. Typeahead lists the terminal's commands with their help, then skills
 * as `/skill:<name>`, from the same command table, and after a command, what its first argument can be. A pick (`choice`) opens in the same place: the editor's box filters
 * it while the draft waits, so the box never moves and a touch keyboard stays up.
 */
import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { Client } from "../api/client.ts";
import {
  addFiles,
  AttachButton,
  AttachmentTray,
  clearPending,
  readyAttachments,
} from "./attachments.tsx";
import { runWebCommand, slashCommands } from "./commands.ts";
import { argumentRows } from "./completions.ts";
import { Keys, PickKeys } from "./keys.tsx";
import { matching, Menu, type MenuItem } from "./menu.tsx";
import {
  attachFile,
  choice,
  client,
  commandLine,
  connection,
  draft,
  linkError,
  menuOpen,
  pageHint,
  editing,
  endEdit,
  escapeLeaves,
  focusOnMount,
  forgetRetry,
  interrupt,
  mode,
  notice,
  roots,
  submit,
  workers,
} from "./state.ts";
import { openAsks } from "./transcript.tsx";

const SIZES_ITSELF = CSS.supports("field-sizing", "content");

/**
 * What completes `text`, matched as every menu matches, the exact one first: a command's name while it is typed, then
 * its first argument. Before the page connects only this page's commands complete.
 */
function suggestions(text: string, core: Client | undefined): { items: MenuItem[]; query: string } {
  if (!text.startsWith("/")) return { items: [], query: "" };
  const argument = argumentRows(text, {
    workers: workers.value.map((worker) => worker.name),
    roots: roots.value.filter((each) => !each.archived).map(({ id, label }) => ({ id, label })),
    asks: core === undefined ? [] : openAsks(),
  });
  if (argument !== undefined) {
    const items = matching(argument.items, argument.query)
      .toSorted((x, y) => Number(y.id.trim() === text.trim()) - Number(x.id.trim() === text.trim()))
      .slice(0, 12);
    return { items, query: argument.query };
  }
  if (/\s/.test(text)) return { items: [], query: "" };
  const items = matching(slashCommands(core), text.slice(1))
    .toSorted((x, y) => Number(y.label === text) - Number(x.label === text))
    .slice(0, 12);
  return { items, query: text.slice(1) };
}

export function Editor() {
  const selected = useSignal(0);
  const closed = useSignal(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picking = choice.value;
  // A pick's filter and whether its alternate (Shift+Enter) is on; both start afresh with each pick.
  const query = useSignal("");
  const second = useSignal(false);
  useEffect(() => {
    query.value = picking?.query ?? "";
    second.value = false;
    selected.value = 0;
    // On a desktop typing filters at once; a touch screen keeps its keyboard as it was.
    if (picking !== undefined && !matchMedia("(pointer: coarse)").matches) area.current?.focus();
  }, [picking]);
  // Typing (or a draft kept over a reload) can come before the page connects: then only this page's commands complete.
  const list = useComputed(() =>
    closed.value
      ? { items: [], query: "" }
      : suggestions(draft.value, connection.value === "connecting" ? undefined : client()),
  );
  // On load, and back from a question asked from the prompt, typing goes to the editor again.
  useEffect(() => {
    if (focusOnMount()) area.current?.focus();
  }, []);
  // The box grows with its text up to the stylesheet's max-height, then scrolls: by itself where the browser sizes a
  // field to its content, else measured here, which lays the page out again on every keystroke. The editor holds its
  // height while the box is measured, so the transcript above never shrinks and grows back (Firefox moves its scroll).
  useLayoutEffect(() => {
    const element = area.current;
    const box = element?.parentElement ?? null;
    if (element === null || box === null || SIZES_ITSELF) return;
    box.style.height = `${box.offsetHeight}px`;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
    box.style.height = "";
  }, [draft.value, query.value, picking]);

  const attach = (files: Iterable<File>) => addFiles(files, attachFile);
  const send = () => {
    const text = draft.value;
    closed.value = false;
    if (editing.value !== undefined) return endEdit(text);
    // A slash command begun from the page runs and gives back the draft it set aside, and focus to where it was.
    const line = commandLine.value;
    commandLine.value = undefined;
    if (line !== undefined && !line.fromPrompt) area.current?.blur();
    const rest = line?.draft ?? "";
    if (runWebCommand(text)) {
      draft.value = rest;
      return;
    }
    const attachments = readyAttachments();
    if (attachments === undefined) {
      commandLine.value = line;
      return notice("still uploading · send when the files are up");
    }
    draft.value = rest;
    void submit(text, attachments).then((outcome) => {
      if (outcome === "sent") clearPending();
      if (outcome !== "failed") return;
      // Never lost: what didn't go comes back, ahead of anything typed since (then it's a new message).
      if (draft.value !== "") forgetRetry();
      draft.value = [text, draft.value].filter(Boolean).join("\n");
    });
  };
  const accept = (item: MenuItem) => {
    // A row's id is the whole text it completes to.
    draft.value = `${item.id}${item.usage ? " " : ""}`;
    selected.value = 0;
    area.current?.focus();
  };
  const items =
    picking === undefined
      ? list.value.items
      : (picking.rows?.(query.value) ?? matching(picking.options, query.value));
  const menu = picking === undefined && items.length > 0;
  useEffect(() => {
    menuOpen.value = menu;
  }, [menu]);
  const take = (item: MenuItem | undefined, alternate = second.value) => {
    if (picking === undefined) {
      if (item !== undefined) accept(item);
    } else if (item !== undefined) picking.choose(item.id, alternate);
  };

  return (
    // A landmark, so the editor, its key bar and any menu over it are a named region of the page.
    <section
      class="editor"
      aria-label="editor"
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      }}
    >
      {picking !== undefined ? (
        <Menu
          label={picking.title}
          class={`pick ${picking.class ?? ""}`}
          items={items}
          query={query.value}
          selected={selected.value}
          empty={picking.empty ?? "nothing matches"}
          marks={picking.marks}
          onTake={(item) => take(item)}
          header={
            <header>
              <span class="title">
                {picking.title}
                <span class="hint">
                  {picking.alternate === undefined ? "" : ` · Shift+Enter ${picking.alternate}`} ·
                  Esc cancels
                </span>
              </span>
              <button
                type="button"
                class="icon"
                aria-label="cancel"
                title="cancel (Esc)"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => picking.cancel()}
              >
                ✕
              </button>
            </header>
          }
        />
      ) : items.length > 0 ? (
        <Menu
          label="commands"
          items={items}
          query={list.value.query}
          selected={selected.value}
          onTake={accept}
        />
      ) : null}
      {pageHint.value === undefined ? null : (
        <div class="pagehint" role="status">
          {pageHint.value}
        </div>
      )}
      <AttachmentTray />
      <textarea
        ref={area}
        onPaste={(event) => {
          // Pasted images and files attach; text pastes as usual.
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0) return;
          event.preventDefault();
          attach(files);
        }}
        class={mode.value === "steer" && picking === undefined ? "steer" : ""}
        rows={1}
        value={picking === undefined ? draft.value : query.value}
        aria-label={picking === undefined ? "message" : `filter: ${picking.title}`}
        placeholder={
          picking !== undefined
            ? "type to filter"
            : linkError.value !== undefined
              ? `not connected · ${linkError.value}`
              : connection.value === "gone"
                ? "not connected · reloading once Monchu answers"
                : connection.value !== "live" && connection.value !== "connecting"
                  ? "not connected · reconnecting"
                  : editing.value === undefined
                    ? "message"
                    : "queued message"
        }
        autofocus
        onBlur={() => {
          // Leaving for elsewhere on the page ends a slash command begun from it; leaving the window doesn't.
          if (document.hasFocus()) commandLine.value = undefined;
        }}
        onInput={(event) => {
          if (picking !== undefined) {
            query.value = event.currentTarget.value;
            selected.value = 0;
            return;
          }
          forgetRetry();
          draft.value = event.currentTarget.value;
          selected.value = 0;
          closed.value = false;
        }}
        onKeyDown={(event) => {
          // Keys while an input method composes are its own (Esc there cancels the composition, not the run).
          if (event.isComposing || event.keyCode === 229) return;
          if (items.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            selected.value =
              (selected.value + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            return;
          }
          if (picking !== undefined) {
            const item = items[selected.value];
            if (event.key === "Escape") {
              event.preventDefault();
              picking.cancel();
            } else if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
              event.preventDefault();
              if (picking.alternate !== undefined) take(item, true);
            } else if (
              event.key === "Tab" ||
              (event.key === "Enter" && !event.shiftKey && !event.isComposing)
            ) {
              event.preventDefault();
              take(item);
            }
            return;
          }
          if (items.length > 0 && event.key === "Tab") {
            event.preventDefault();
            const item = items[selected.value];
            if (item !== undefined) accept(item);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            const line = commandLine.value;
            commandLine.value = undefined;
            if (line !== undefined) {
              draft.value = line.draft;
              if (!line.fromPrompt) event.currentTarget.blur();
            } else if (items.length > 0) closed.value = true;
            else if (editing.value !== undefined) endEdit();
            else if (escapeLeaves.value) event.currentTarget.blur();
            else void interrupt();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            const item = items[selected.value];
            // A touch keyboard has no Shift: its Enter adds a line, and the key bar sends.
            if (item === undefined && matchMedia("(pointer: coarse)").matches) return;
            event.preventDefault();
            // A half-typed command takes the suggestion; an exact one, or one with arguments, is sent as typed.
            if (item !== undefined && item.id !== draft.value.trim()) accept(item);
            else send();
          }
        }}
      />
      {picking !== undefined ? (
        <PickKeys
          alternate={picking.alternate}
          on={second.value}
          toggle={() => (second.value = !second.value)}
          choose={() => take(items[selected.value])}
        />
      ) : (
        <Keys area={area} send={send}>
          <AttachButton onFiles={attach} />
        </Keys>
      )}
    </section>
  );
}
