/**
 * The editor: Enter sends (adds a line on a touch screen), Shift-Enter adds a line, Esc stops a running front (or closes the typeahead, or leaves a
 * queued message's edit), Alt+S toggles steer and follow-up, Ctrl-O expands every card; the key bar under it taps the
 * same. Typeahead lists the terminal's commands with their help, then skills
 * as `/skill:<name>`, from the same command table.
 */
import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { clientCommands } from "../ui/commands.ts";
import {
  addFiles,
  AttachButton,
  AttachmentTray,
  clearPending,
  readyAttachments,
} from "./attachments.tsx";
import { openClient } from "./client.tsx";
import { openSecrets } from "./secrets.tsx";
import { Keys } from "./keys.tsx";
import {
  attachFile,
  client,
  connection,
  draft,
  editing,
  endEdit,
  expandAll,
  interrupt,
  mode,
  notice,
  submit,
  toggleMode,
} from "./state.ts";

const SIZES_ITSELF = CSS.supports("field-sizing", "content");

type Suggestion = { value: string; usage: string; help: string };

/** Commands only this page has, run here and never sent to the core. */
const WEB_COMMANDS: Suggestion[] = [
  { value: "/client", usage: "", help: "web only · this client: app name, install, theme" },
  {
    value: "/secrets",
    usage: "",
    help: "web only · secrets agents use by name: requests, add, replace, delete",
  },
];

function suggestions(text: string): Suggestion[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const all: Suggestion[] = [
    ...clientCommands("web", client().commands()).map(([command, { usage, help }]) => ({
      value: command,
      usage,
      help,
    })),
    ...WEB_COMMANDS,
    ...client()
      .skills()
      .map((skill) => ({
        value: `/skill:${skill.name}`,
        usage: "[text]",
        help: skill.description,
      })),
  ];
  return all.filter((item) => item.value.startsWith(text)).slice(0, 12);
}

export function Editor() {
  const selected = useSignal(0);
  const closed = useSignal(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useComputed(() => (closed.value ? [] : suggestions(draft.value)));
  // Back from a pick or a prompt, typing goes to the editor again.
  useEffect(() => area.current?.focus(), []);
  // The box grows with its text up to the stylesheet's max-height, then scrolls: by itself where the browser sizes a
  // field to its content, else measured here, which lays the page out again on every keystroke.
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null || SIZES_ITSELF) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
  }, [draft.value]);

  const attach = (files: Iterable<File>) => addFiles(files, attachFile);
  const send = () => {
    const text = draft.value;
    closed.value = false;
    if (editing.value !== undefined) return endEdit(text);
    if (text.trim() === "/client") {
      draft.value = "";
      return openClient();
    }
    if (text.trim() === "/secrets") {
      draft.value = "";
      return openSecrets();
    }
    const attachments = readyAttachments();
    if (attachments === undefined) return notice("still uploading · send when the files are up");
    draft.value = "";
    void submit(text, attachments).then((outcome) => {
      if (outcome === "sent") clearPending();
      // Never lost: what didn't go comes back ahead of anything typed since.
      if (outcome === "failed") draft.value = [text, draft.value].filter(Boolean).join("\n");
    });
  };
  const accept = (item: Suggestion) => {
    draft.value = `${item.value}${item.usage ? " " : ""}`;
    selected.value = 0;
    area.current?.focus();
  };

  return (
    <div
      class="editor"
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
      {list.value.length > 0 ? (
        <ul
          class="typeahead"
          role="listbox"
          aria-label="commands"
          // The command column fits the longest shown, up to half the row.
          style={{
            "--command": `min(${Math.max(...list.value.map((item) => item.value.length))}ch, 50%)`,
          }}
        >
          {list.value.map((item, index) => (
            <li
              key={item.value}
              role="option"
              aria-selected={index === selected.value}
              class={index === selected.value ? "selected" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(item);
              }}
            >
              <b>{item.value}</b>
              <span class="help">
                {item.usage ? <span class="usage">{item.usage} </span> : null}
                {item.help}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
        class={mode.value === "steer" ? "steer" : ""}
        rows={1}
        value={draft.value}
        placeholder={
          connection.value !== "live" && connection.value !== "connecting"
            ? "not connected · reconnecting"
            : editing.value === undefined
              ? "message"
              : "queued message"
        }
        autofocus
        onInput={(event) => {
          draft.value = event.currentTarget.value;
          selected.value = 0;
          closed.value = false;
        }}
        onKeyDown={(event) => {
          const items = list.value;
          if (event.altKey && event.key.toLowerCase() === "s") {
            event.preventDefault();
            toggleMode();
            return;
          }
          if (event.ctrlKey && event.key.toLowerCase() === "o") {
            event.preventDefault();
            expandAll.value = !expandAll.value;
            return;
          }
          if (items.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            selected.value =
              (selected.value + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
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
            if (items.length > 0) closed.value = true;
            else if (editing.value !== undefined) endEdit();
            else void interrupt();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            const item = items[selected.value];
            // A touch keyboard has no Shift: its Enter adds a line, and the key bar sends.
            if (item === undefined && matchMedia("(pointer: coarse)").matches) return;
            event.preventDefault();
            // A half-typed command takes the suggestion; an exact one, or one with arguments, is sent as typed.
            if (item !== undefined && item.value !== draft.value.trim()) accept(item);
            else send();
          }
        }}
      />
      <Keys area={area} send={send}>
        <AttachButton onFiles={attach} />
      </Keys>
    </div>
  );
}
