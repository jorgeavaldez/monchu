/**
 * The key bar: every editor key the terminal binds, as a tap for a touch keyboard that has no Esc, Alt or Ctrl. There,
 * the keyboard's Enter adds a line and the bar's send sends. Each button shows its state rather than explaining it,
 * names its desktop key in its title, and keeps the editor's focus so the on-screen keyboard stays up.
 */
import type { ComponentChildren, RefObject } from "preact";
import { presentation } from "../ui/state.ts";
import {
  draft,
  editing,
  endEdit,
  escapeLeaves,
  expandAll,
  toggleExpandAll,
  interrupt,
  mode,
  openDrafts,
  promptDrafts,
  shown,
  toggleMode,
  view,
} from "./state.ts";

function Key(props: {
  label: string;
  title: string;
  class?: string;
  pressed?: boolean;
  onPress: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      class={props.class}
      aria-label={props.label}
      title={props.title}
      {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/** The bar; `children` go after the editing keys, before send (the attach button). */
export function Keys({
  area,
  send,
  children,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  send: () => void;
  children?: ComponentChildren;
}) {
  const root = view(undefined)?.value;
  const stoppable = shown.value === undefined && root !== undefined && presentation(root).busy;
  const edit = editing.value !== undefined;
  const steer = mode.value === "steer";
  return (
    <div class="keys" role="toolbar" aria-label="keys">
      {edit ? (
        <Key
          class="icon"
          label="leave the edit"
          title="leave the edit, unsaved (Esc)"
          onPress={() => endEdit()}
        >
          ✕
        </Key>
      ) : stoppable ? (
        <Key
          class="icon"
          label="stop"
          title={escapeLeaves.value ? "stop the root's run" : "stop the root's run (Esc)"}
          onPress={() => void interrupt()}
        >
          ■
        </Key>
      ) : null}
      <Key
        class={`mode${steer ? " steer" : ""}`}
        label={steer ? "steer" : "follow-up"}
        title={`${steer ? "steer: joins a busy run" : "follow-up: waits for a busy run"} · tap to switch`}
        onPress={toggleMode}
      >
        {steer ? "↯ steer" : "⇢ follow-up"}
      </Key>
      <Key
        class="icon"
        label="drafts"
        title={`drafts: save or restore (${promptDrafts.value.length} saved)`}
        onPress={() => void openDrafts()}
      >
        ✎
      </Key>
      <Key
        class="icon"
        label="expand all"
        title="expand every card"
        pressed={expandAll.value}
        onPress={() => {
          toggleExpandAll();
        }}
      >
        {expandAll.value ? "⊟" : "⊞"}
      </Key>
      {draft.value === "" ? (
        <Key
          class="icon"
          label="commands"
          title="commands (/)"
          onPress={() => {
            draft.value = "/";
            area.current?.focus();
          }}
        >
          /
        </Key>
      ) : null}
      {children}
      <Key
        class="icon send"
        label={edit ? "save" : "send"}
        title={edit ? "save the queued message (Enter)" : "send (Enter)"}
        onPress={send}
      >
        {edit ? "✓" : "➤"}
      </Key>
    </div>
  );
}

/**
 * The bar under a pick's filter, the key bar's height so the box above stays put: the pick's alternate as a toggle
 * (Shift+Enter takes the row with it), and choose in send's place.
 */
export function PickKeys(props: {
  alternate: string | undefined;
  on: boolean;
  toggle: () => void;
  choose: () => void;
}) {
  return (
    <div class="keys" role="toolbar" aria-label="keys">
      {props.alternate === undefined ? null : (
        <Key
          class="alternate"
          label={props.alternate}
          title={`${props.alternate} with the pick · tap to switch (Shift+Enter takes a row with it)`}
          pressed={props.on}
          onPress={props.toggle}
        >
          {props.on ? "✓ " : ""}
          {props.alternate}
        </Key>
      )}
      <Key class="icon send" label="choose" title="choose (Enter)" onPress={props.choose}>
        ✓
      </Key>
    </div>
  );
}
