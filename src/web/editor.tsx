/**
 * The editor: Enter sends, Shift-Enter adds a line, Esc stops a running front (or closes the typeahead), Alt+S toggles
 * steer and follow-up, Ctrl-O expands every card. Typeahead lists the terminal's commands with their help, then skills
 * as `/skill:<name>`, from the same command table.
 */
import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { commands } from "../ui/commands.ts";
import { client, draft, expandAll, interrupt, mode, submit } from "./state.ts";

type Suggestion = { value: string; usage: string; help: string };

function suggestions(text: string): Suggestion[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const all: Suggestion[] = [
    ...Object.entries(commands).map(([command, { usage, help }]) => ({
      value: command,
      usage,
      help,
    })),
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

  const send = () => {
    const text = draft.value;
    draft.value = "";
    closed.value = false;
    void submit(text);
  };
  const accept = (item: Suggestion) => {
    draft.value = `${item.value}${item.usage ? " " : ""}`;
    selected.value = 0;
    area.current?.focus();
  };

  return (
    <div class="editor">
      {list.value.length > 0 ? (
        <ul class="typeahead" role="listbox">
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
              <b>{item.value}</b> <span class="usage">{item.usage}</span>
              <span class="help">{item.help}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        class={mode.value === "steer" ? "steer" : ""}
        rows={Math.min(8, draft.value.split("\n").length)}
        value={draft.value}
        placeholder={`message · ${mode.value === "steer" ? "steer" : "follow-up"} (Alt+S) · / for commands`}
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
            mode.value = mode.value === "steer" ? "followUp" : "steer";
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
            else void interrupt();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            const item = items[selected.value];
            // A half-typed command takes the suggestion; an exact one, or one with arguments, is sent as typed.
            if (item !== undefined && item.value !== draft.value.trim()) accept(item);
            else send();
          }
        }}
      />
    </div>
  );
}
