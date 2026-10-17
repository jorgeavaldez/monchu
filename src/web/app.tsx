/** The page: who's working, the shown conversation, its queue, and the editor or whatever answer it waits for. */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { RootSummary } from "../api/client.ts";
import {
  ARCHIVE_HELP,
  activeRoots,
  listedRoots,
  rootCounts,
  rootIds,
  rootLabel,
} from "../ui/roots.ts";
import { contextUsage, presentation } from "../ui/state.ts";
import { Editor } from "./editor.tsx";
import {
  archiveRoot,
  ask,
  cancelLogin,
  choice,
  client,
  connection,
  loginStatus,
  mode,
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
 * The root indicator: one dot per active root (working, or done and not seen yet), the shown one underlined, and none
 * at all while every root is idle. Its detail is the roots panel, which a tap opens.
 */
function RootDots() {
  const active = activeRoots(roots.value);
  if (active.length === 0) return null;
  const summary = active
    .map(
      (root) => `${root.id === rootId.value ? "this root" : root.id} ${STATUS_TEXT[root.status]}`,
    )
    .join(", ");
  return (
    <button
      class={`roots${rootsOpen.value ? " on" : ""}`}
      aria-label={`roots: ${summary}`}
      aria-expanded={rootsOpen.value}
      title={summary}
      onClick={() => toggleRoots()}
    >
      {active.map((root) => (
        <span
          key={root.id}
          aria-hidden="true"
          class={`dot ${root.status}${root.id === rootId.value ? " here" : ""}`}
        >
          ●
        </span>
      ))}
    </button>
  );
}

function RootRow({ root, ids }: { root: RootSummary; ids: ReturnType<typeof rootIds> }) {
  const { unique, rest } = ids(root.id);
  const here = root.id === rootId.value;
  return (
    <li class={here ? "here" : ""}>
      <button class="open" onClick={() => void switchRoot(root.id)} aria-current={here}>
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
        <button onClick={() => void newRoot()}>new root</button>
        <button onClick={() => toggleRoots(false)}>close</button>
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
      <RootDots />
      <button class={shown.value === undefined ? "on" : ""} onClick={() => void show(undefined)}>
        {rootBusy ? "●" : "○"} root
      </button>
      {workers.value.map((worker) => (
        <button
          key={worker.name}
          class={shown.value === worker.name ? "on" : ""}
          onClick={() => void show(worker.name)}
        >
          {worker.busy ? "●" : "○"} {worker.name}
        </button>
      ))}
    </nav>
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
        {current.title}
        {current.alternate === undefined ? "" : ` · Ctrl+S ${current.alternate}`} · Esc cancels
      </header>
      <ul>
        {current.options.map((option, index) => (
          <li key={option.id} class={index === selected.value ? "selected" : ""}>
            <button onClick={() => current.choose(option.id, false)}>
              {option.label}
              {option.detail === undefined ? null : <span class="help"> {option.detail}</span>}
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
  const shownMeter = meter(state);
  const percent = shownMeter.fill === undefined ? "?" : `${Math.round(shownMeter.fill * 100)}%`;
  return (
    <footer class="footer">
      <span>
        {shown.value ?? "root"} · {mode.value === "steer" ? "steer" : "follow-up"}
        {live.cwd === undefined ? "" : ` · ${live.cwd}`}
      </span>
      <span>
        <span
          class={
            shownMeter.fill !== undefined && shownMeter.fill > 0.9
              ? "red"
              : shownMeter.fill !== undefined && shownMeter.fill > 0.7
                ? "yellow"
                : ""
          }
        >
          {percent}
        </span>
        {shown.value !== undefined && root !== undefined
          ? ` · root ${Math.round((contextUsage(root).context ?? 0) / 1000)}k`
          : ""}
        {" · "}
        {live.provider === undefined ? live.model : `${live.provider}/${live.model}`}
        {model?.reasoning === true ? ` · ${live.thinkingLevel ?? "off"}` : ""}
        {connection.value === "open" ? "" : ` · ${connection.value}`}
      </span>
    </footer>
  );
}

function Queue() {
  const state = view(shown.value)?.value;
  const queue = state === undefined ? [] : presentation(state).queue;
  if (queue.length === 0) return null;
  return (
    <ul class="queue">
      {queue.map((item) => (
        <li key={item.id} class={item.mode}>
          {item.mode === "steer" ? "steer" : item.mode === "followUp" ? "follow-up" : "write"} ·{" "}
          {item.text.split("\n")[0]}
        </li>
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
        <Transcript view={state} />
      )}
      <Queue />
      <Login />
      {choice.value !== undefined ? <Pick /> : ask.value !== undefined ? <Ask /> : <Editor />}
      <Footer />
    </>
  );
}
