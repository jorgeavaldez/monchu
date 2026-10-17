/**
 * The key bar: every editor key the terminal binds, as a tap target for a touch keyboard that has no Esc, Alt or
 * Ctrl. There, the keyboard's Enter adds a line and the bar's send sends. Each button names its desktop key in its title; the keys keep working. Buttons keep the editor's focus, so the
 * on-screen keyboard stays up.
 */
import type { ComponentChildren, RefObject } from "preact";
import { presentation } from "../ui/state.ts";
import {
  draft,
  editing,
  endEdit,
  expandAll,
  interrupt,
  mode,
  shown,
  toggleMode,
  view,
} from "./state.ts";

function Key(props: {
  title: string;
  pressed?: boolean;
  wide?: boolean;
  onPress: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      title={props.title}
      class={props.wide ? "wide" : undefined}
      {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

export function Keys({
  area,
  send,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  send: () => void;
}) {
  const root = view(undefined)?.value;
  const stoppable = shown.value === undefined && root !== undefined && presentation(root).busy;
  const edit = editing.value !== undefined;
  const text = draft.value;
  return (
    <div class="keys" role="toolbar" aria-label="keys">
      {edit ? (
        <Key title="Esc: leave the edit, unsaved" onPress={() => endEdit()}>
          ✕ edit
        </Key>
      ) : stoppable ? (
        <Key title="Esc: stop the root's run" onPress={() => void interrupt()}>
          stop
        </Key>
      ) : null}
      <Key
        title="Alt+S: busy messages steer the run, else follow up after it"
        pressed={mode.value === "steer"}
        onPress={toggleMode}
      >
        steer
      </Key>
      <Key
        title="Ctrl+O: expand every card"
        pressed={expandAll.value}
        onPress={() => {
          expandAll.value = !expandAll.value;
        }}
      >
        expand
      </Key>
      {text === "" ? (
        <Key
          title="/: commands"
          onPress={() => {
            draft.value = "/";
            area.current?.focus();
          }}
        >
          /
        </Key>
      ) : null}
      <Key title={edit ? "Enter: save the queued message" : "Enter: send"} wide onPress={send}>
        {edit ? "save" : "send"}
      </Key>
    </div>
  );
}
