/** What every panel in place of the transcript shares: its header, a ✕ and Esc to close, focus once it opens. */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { focusReturn, panel } from "./state.ts";

/** A way out, the touch Esc: a menu's, a panel's, a line's. */
export function Close({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      type="button"
      class="icon"
      aria-label={label}
      title={`${label} (Esc)`}
      onClick={onClose}
    >
      ✕
    </button>
  );
}

const close = () => {
  panel.value = undefined;
};

/** A panel named `name` (its title and its `<name>Panel` class), header actions before its ✕, and its last outcome. */
export function Panel(props: {
  name: string;
  class?: string;
  counts?: string;
  actions?: ComponentChildren;
  status?: { text: string; failed: boolean } | undefined;
  children: ComponentChildren;
}) {
  const element = useRef<HTMLElement>(null);
  // Focus moves into the panel once when it opens, not on every update of its list, and back where it was as it closes.
  useEffect(() => {
    const back = focusReturn();
    element.current?.focus();
    return back;
  }, []);
  return (
    <main
      class={`panel ${props.name}Panel ${props.class ?? ""}`}
      tabIndex={-1}
      ref={element}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <header>
        <h1>
          {props.name}
          {props.counts === undefined ? null : <span class="help">{props.counts}</span>}
        </h1>
        {props.actions}
        <Close label="close" onClose={close} />
      </header>
      {props.status === undefined ? null : (
        <p role="status" class={props.status.failed ? "warning" : "help"}>
          {props.status.text}
        </p>
      )}
      {props.children}
    </main>
  );
}
