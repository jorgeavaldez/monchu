/** The page: who's working, the shown conversation, its queue, and the editor or whatever answer it waits for. */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { RootSummary } from "../api/client.ts";
import { escalationSummary, systemNoticeSummary } from "../api/notices.ts";
import {
  ARCHIVE_HELP,
  activeRoots,
  listedRoots,
  rootCounts,
  rootIds,
  rootLabel,
} from "../ui/roots.ts";
import { contextUsage, presentation, type QueuedItem } from "../ui/state.ts";
import { Editor } from "./editor.tsx";
import {
  archiveRoot,
  ask,
  beginEdit,
  cancelLogin,
  choice,
  client,
  connection,
  editing,
  editQueued,
  loginStatus,
  newRoot,
  renameRoot,
  rootId,
  roots,
  rootsMessage,
  rootsOpen,
  show,
  shown,
  switchRoot,
  toggleRoots,
  view,
  workers,
} from "./state.ts";
import { Transcript } from "./transcript.tsx";

const STATUS_TEXT = { working: "working", done: "done, not seen yet", idle: "idle" };

/**
 * The root menu, right of the agent tabs: one dot per active root (working, or done and not seen yet) with the shown
 * one underlined, or a hollow one while all are idle, and ▾. The shown root's name is its label and title; its detail is
 * the roots panel, which a tap opens.
 */
function RootTab() {
  const active = activeRoots(roots.value);
  const here = roots.value.find((root) => root.id === rootId.value);
  if (here === undefined) return null;
  const name = rootLabel(here);
  const summary = active
    .map(
      (root) => `${root.id === rootId.value ? "this root" : root.id} ${STATUS_TEXT[root.status]}`,
    )
    .join(", ");
  return (
    <button
      class={`roots${rootsOpen.value ? " on" : ""}`}
      aria-label={`roots: ${name}${summary ? `; ${summary}` : ""}`}
      aria-expanded={rootsOpen.value}
      title={summary ? `${name} · ${summary}` : name}
      onClick={() => toggleRoots()}
    >
      {active.length === 0 ? (
        <span aria-hidden="true" class="dot">
          ○
        </span>
      ) : (
        <span class="dots">
          {active.map((root) => (
            <span
              key={root.id}
              aria-hidden="true"
              class={`dot ${root.status}${root.id === rootId.value ? " here" : ""}`}
            >
              ●
            </span>
          ))}
        </span>
      )}
      <span aria-hidden="true">▾</span>
    </button>
  );
}

function RootRow({ root, ids }: { root: RootSummary; ids: ReturnType<typeof rootIds> }) {
  const { unique, rest } = ids(root.id);
  const here = root.id === rootId.value;
  return (
    <li class={here ? "here" : ""}>
      <button class="open" onClick={() => void switchRoot(root.id)} aria-current={here}>
        <span class="lines">
          <span class="name">
            <span aria-hidden="true" class={`dot ${root.status}`}>
              {root.status === "idle" ? "○" : "●"}
            </span>{" "}
            <span class="id">
              <b>{unique}</b>
              {rest}
            </span>{" "}
            {rootLabel(root)}
          </span>
          <span class="help">
            {[
              STATUS_TEXT[root.status],
              rootCounts(root),
              root.archived ? "archived" : "",
              here ? "shown" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <span class="actions">
        <button onClick={() => void renameRoot(root.id)} aria-label={`rename ${root.id}`}>
          rename
        </button>
        <button
          onClick={() => void archiveRoot(root.id, !root.archived)}
          aria-label={`${root.archived ? "unarchive" : "archive"} ${root.id}`}
        >
          {root.archived ? "unarchive" : "archive"}
        </button>
      </span>
    </li>
  );
}

/** `/roots`: every open root (archived ones on request) to switch to, start, rename or archive, in place of the transcript. */
function RootsPanel() {
  const archived = useSignal(false);
  const all = roots.value;
  const ids = rootIds(all);
  const listed = listedRoots(all, archived.value);
  const hidden = all.filter((root) => root.archived).length;
  const message = rootsMessage.value;
  const panel = useRef<HTMLElement>(null);
  // Focus moves into the panel once when it opens, not on every update of the list.
  useEffect(() => panel.current?.focus(), []);
  return (
    <main
      class="rootsPanel"
      tabIndex={-1}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === "Escape") toggleRoots(false);
      }}
    >
      <header>
        <h1>roots</h1>
        <button class="icon" aria-label="new root" title="new root" onClick={() => void newRoot()}>
          +
        </button>
        <Close label="close" onClose={() => toggleRoots(false)} />
      </header>
      {message === undefined ? null : (
        <p role="status" class={message.failed ? "warning" : "help"}>
          {message.text}
        </p>
      )}
      <ul>
        {listed.map((root) => (
          <RootRow key={root.id} root={root} ids={ids} />
        ))}
      </ul>
      {hidden === 0 && !archived.value ? null : (
        <label class="help">
          <input
            type="checkbox"
            checked={archived.value}
            onChange={(event) => {
              archived.value = event.currentTarget.checked;
            }}
          />{" "}
          show archived ({hidden})
        </label>
      )}
      <p class="help">{ARCHIVE_HELP}</p>
    </main>
  );
}

function Agents() {
  const root = view(undefined)?.value;
  const rootBusy = root === undefined ? false : presentation(root).busy;
  return (
    <nav class="agents">
      <div class="tabs">
        <button class={shown.value === undefined ? "on" : ""} onClick={() => void show(undefined)}>
          {rootBusy ? "●" : "○"} root
        </button>
        {/* Working workers first, idle ones after, each in the order the crew lists them. */}
        {workers.value
          .toSorted((x, y) => Number(y.busy) - Number(x.busy))
          .map((worker) => (
            <button
              key={worker.name}
              class={shown.value === worker.name ? "on" : ""}
              onClick={() => void show(worker.name)}
            >
              {worker.busy ? "●" : "○"} {worker.name}
            </button>
          ))}
      </div>
      <RootTab />
    </nav>
  );
}

/** A menu's way out, the touch Esc. */
function Close({ label, onClose }: { label: string; onClose: () => void }) {
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

function Pick() {
  const current = choice.value;
  const selected = useSignal(0);
  if (current === undefined) return null;
  return (
    <div
      class="pick"
      tabIndex={0}
      ref={(element) => element?.focus()}
      onKeyDown={(event) => {
        const count = current.options.length;
        if (event.key === "Escape") return current.cancel();
        if (event.key === "ArrowDown") selected.value = (selected.value + 1) % count;
        if (event.key === "ArrowUp") selected.value = (selected.value + count - 1) % count;
        const option = current.options[selected.value];
        if (event.key === "Enter" && option !== undefined) current.choose(option.id, false);
        if (
          event.key === "s" &&
          event.ctrlKey &&
          option !== undefined &&
          current.alternate !== undefined
        ) {
          event.preventDefault();
          current.choose(option.id, true);
        }
      }}
    >
      <header>
        <span class="title">
          {current.title}
          <span class="hint">
            {current.alternate === undefined ? "" : ` · Ctrl+S ${current.alternate}`} · Esc cancels
          </span>
        </span>
        <Close label="cancel" onClose={() => current.cancel()} />
      </header>
      <ul>
        {current.options.map((option, index) => (
          <li key={option.id} class={index === selected.value ? "selected" : ""}>
            <button class="enter" onClick={() => current.choose(option.id, false)}>
              <span>
                {option.label}
                {option.detail === undefined ? null : <span class="help"> {option.detail}</span>}
              </span>
              <span aria-hidden="true">›</span>
            </button>
            {current.alternate === undefined ? null : (
              <button class="alternate" onClick={() => current.choose(option.id, true)}>
                {current.alternate}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ask() {
  const current = ask.value;
  const value = useSignal("");
  if (current === undefined) return null;
  const input = {
    autoComplete: "off",
    spellcheck: false,
    ...(current.placeholder === undefined ? {} : { placeholder: current.placeholder }),
    value: value.value,
    ref: (element: HTMLInputElement | null) => element?.focus(),
    onInput: (event: { currentTarget: HTMLInputElement }) => {
      value.value = event.currentTarget.value;
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") current.cancel();
    },
  };
  return (
    <form
      class="ask"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.value;
        value.value = "";
        current.answer(text);
      }}
    >
      <label>
        {current.title}
        {current.secret ? <input type="password" {...input} /> : <input type="text" {...input} />}
      </label>
      <button type="submit" class="icon" aria-label="ok" title="ok (Enter)">
        ›
      </button>
      <Close label="cancel" onClose={() => current.cancel()} />
    </form>
  );
}

function Login() {
  const status = loginStatus.value;
  if (status === undefined) return null;
  return (
    <div class="login">
      <span>{status.message}</span>
      {status.code === undefined ? null : <code>{status.code}</code>}
      {status.url === undefined ? null : (
        <a href={status.url} target="_blank" rel="noreferrer noopener">
          open the sign-in page
        </a>
      )}
      <button onClick={cancelLogin}>cancel</button>
    </div>
  );
}

const LINK = {
  connecting: "connecting",
  live: "connected",
  lost: "reconnecting",
  updating: "reconnecting · installing an update",
  gone: "disconnected · tap to reload",
};

/** The link to the core as one dot: green while it answers, hollow while it redials, red once it's gone. */
function LinkDot() {
  const state = connection.value;
  if (state === "gone")
    return (
      <button
        class="link"
        data-state="gone"
        aria-label={LINK.gone}
        title={LINK.gone}
        onClick={() => location.reload()}
      >
        ●
      </button>
    );
  return (
    <span
      class="link"
      data-state={state}
      role="status"
      aria-label={LINK[state]}
      title={LINK[state]}
    >
      {state === "live" ? "●" : "○"}
    </span>
  );
}

function Footer() {
  const state = view(shown.value)?.value;
  const root = view(undefined)?.value;
  if (state === undefined) return null;
  const live = presentation(state);
  const model =
    live.provider === undefined
      ? undefined
      : client().model({ provider: live.provider, modelId: live.model });
  const meter = (value: typeof state) => {
    const usage = contextUsage(value);
    const window = model?.contextWindow;
    const fill =
      usage.context === undefined || window === undefined ? undefined : usage.context / window;
    return { usage, fill };
  };
  const { fill } = meter(state);
  const level = fill === undefined ? "" : fill > 0.9 ? "red" : fill > 0.7 ? "yellow" : "";
  const name = live.provider === undefined ? live.model : `${live.provider}/${live.model}`;
  return (
    <footer
      class="footer"
      style={{
        "--fill": `${Math.round(Math.min(1, fill ?? 0) * 100)}%`,
        "--meter": level === "" ? "var(--muted)" : `var(--${level})`,
      }}
    >
      <span class="cwd" title={live.cwd}>
        <bdi>{live.cwd ?? ""}</bdi>
      </span>
      <span>
        <span class={level} title="context used">
          {fill === undefined ? "?" : `${Math.round(fill * 100)}%`}
        </span>
        {shown.value !== undefined && root !== undefined
          ? ` · root ${Math.round((contextUsage(root).context ?? 0) / 1000)}k`
          : ""}
        {" · "}
        <span title="provider/model">{name}</span>
        {model?.reasoning === true ? ` · ${live.thinkingLevel ?? "off"}` : ""} <LinkDot />
      </span>
    </footer>
  );
}

/** A busy mode as the key bar and the queue show it. */
const MODE_ICON = { steer: "↯", followUp: "⇢" };

/**
 * One queued message. The terminal's Alt+Q panel, in place: a tap opens it in the editor, and its buttons switch its
 * mode or delete it. Writes and notices that aren't the user's words stay as they are.
 */
function QueueRow({ item }: { item: QueuedItem }) {
  const open = editing.value?.id === item.id;
  const editable =
    item.mode !== "write" &&
    escalationSummary(item.text) === undefined &&
    systemNoticeSummary(item.text) === undefined;
  const line = item.text.split("\n")[0] ?? "";
  if (item.mode === "write") return <li class={item.mode}>write · {line}</li>;
  const other = item.mode === "steer" ? "follow-up" : "steer";
  return (
    <li class={`${item.mode}${open ? " here" : ""}`}>
      {editable ? (
        <button
          class="text"
          aria-label={`edit: ${line}`}
          disabled={editing.value !== undefined}
          onClick={() => beginEdit(item)}
        >
          {line}
        </button>
      ) : (
        <span class="text">{line}</span>
      )}
      <button
        class="icon"
        aria-label={`${item.mode === "steer" ? "steer" : "follow-up"}, make it ${other}`}
        title={`${item.mode === "steer" ? "steer" : "follow-up"} · tap for ${other}`}
        onClick={() =>
          void editQueued(item.id, {
            kind: "mode",
            mode: item.mode === "steer" ? "followUp" : "steer",
          })
        }
      >
        {MODE_ICON[item.mode]}
      </button>
      <button
        class="icon"
        aria-label="delete it"
        title="delete it (Del in the terminal's queue)"
        disabled={open}
        onClick={() => void editQueued(item.id, { kind: "delete" })}
      >
        ✕
      </button>
    </li>
  );
}

function Queue() {
  const state = view(shown.value)?.value;
  const queue = state === undefined ? [] : presentation(state).queue;
  if (queue.length === 0) return null;
  return (
    <ul class="queue" aria-label="queued">
      {queue.map((item) => (
        <QueueRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

export function App() {
  const state = view(shown.value)?.value;
  return (
    <>
      <Agents />
      {rootsOpen.value ? (
        <RootsPanel />
      ) : state === undefined ? (
        <main class="transcript">connecting…</main>
      ) : (
        <Transcript key={state.conversation.id} view={state} />
      )}
      <Queue />
      <Login />
      {choice.value !== undefined ? <Pick /> : ask.value !== undefined ? <Ask /> : <Editor />}
      <Footer />
    </>
  );
}
