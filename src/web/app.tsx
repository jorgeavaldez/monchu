/** The page: who's working, the shown conversation, its queue, and the editor or whatever answer it waits for. */
import { signal, useSignal } from "@preact/signals";
import type { RootSummary } from "../api/client.ts";
import { systemNoticeSummary } from "../api/notices.ts";
import {
  ARCHIVE_HELP,
  activeRoots,
  listedRoots,
  rootCounts,
  rootIds,
  rootLabel,
} from "../ui/roots.ts";
import { contextUsage, presentation, type QueuedItem } from "../ui/state.ts";
import { ClientPanel, InstallOffer } from "./client.tsx";
import { Editor } from "./editor.tsx";
import { GoalsPanel, JobsPanel } from "./lists.tsx";
import { Close, Panel } from "./panel.tsx";
import { entering, SecretForm, SecretRequests, SecretsPanel } from "./secrets.tsx";
import {
  archiveRoot,
  ask,
  beginEdit,
  cancelLogin,
  choice,
  client,
  connection,
  linkError,
  editing,
  editQueued,
  loginStatus,
  newRoot,
  renameRoot,
  rootId,
  roots,
  rootsMessage,
  panel,
  inbox,
  show,
  shown,
  switchRoot,
  toggleRoots,
  view,
  workers,
} from "./state.ts";
import { FilterBar } from "./inbox.tsx";
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
      class={`roots${panel.value === "roots" ? " on" : ""}`}
      aria-label={`roots: ${name}${summary ? `; ${summary}` : ""}`}
      aria-expanded={panel.value === "roots"}
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
  return (
    <Panel
      name="roots"
      status={rootsMessage.value}
      actions={
        <button class="icon" aria-label="new root" title="new root" onClick={() => void newRoot()}>
          +
        </button>
      }
    >
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
    </Panel>
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
        ● {LINK.gone}
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
      {state === "live" ? "●" : `○ ${LINK[state]}`}
    </span>
  );
}

/** A user's home directory at the start of a path, on Linux, macOS, Termux and Windows; the page has no other way to know it. */
const HOME =
  /^(\/home\/[^/]+|\/Users\/[^/]+|\/root|\/data\/data\/com\.termux\/files\/home|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/;

/** Tokens compactly: 900, 42k, 1.2M. */
function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  return `${(count / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Whether the status bar's details are open above it. */
const details = signal(false);

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
  const { usage, fill } = meter(state);
  const level = fill === undefined ? "" : fill > 0.9 ? "red" : fill > 0.7 ? "yellow" : "";
  const name = live.provider === undefined ? live.model : `${live.provider}/${live.model}`;
  const thinking = model?.reasoning === true ? (live.thinkingLevel ?? "off") : undefined;
  const dir = live.cwd?.replace(HOME, "~");
  const base = dir?.split(/[/\\]/).findLast(Boolean) ?? dir ?? "";
  const open = details.value;
  const percent = fill === undefined ? "?" : `${Math.round(fill * 100)}%`;
  const meterTitle = usage.compacted ? "compacted: unknown until the next reply" : "context used";
  const rows: [string, string][] = [
    ["dir", dir ?? "?"],
    ["model", thinking === undefined ? name : `${name} · ${thinking}`],
    [
      "context",
      `${usage.context === undefined ? "?" : tokens(usage.context)} / ${
        model?.contextWindow === undefined ? "?" : tokens(model.contextWindow)
      } · ${percent}${usage.compacted ? " · compacted, next reply measures it" : ""}`,
    ],
    [
      "tokens",
      `↑${tokens(usage.input)} ↓${tokens(usage.output)} R${tokens(usage.cacheRead)} W${tokens(usage.cacheWrite)}`,
    ],
  ];
  if (shown.value !== undefined && root !== undefined) {
    const size = contextUsage(root).context;
    rows.push(["root", size === undefined ? "?" : tokens(size)]);
  }
  rows.push(["link", LINK[connection.value]]);
  return (
    <>
      {open ? (
        <dl class="status" id="status">
          {rows.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>
                <bdi>{value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <footer
        class="footer"
        style={{
          "--fill": `${Math.round(Math.min(1, fill ?? 0) * 100)}%`,
          "--meter": level === "" ? "var(--muted)" : `var(--${level})`,
        }}
      >
        <button
          class={`more${open ? " on" : ""}`}
          aria-expanded={open}
          aria-controls="status"
          aria-label={`status details: ${dir ?? ""}`}
          title={live.cwd}
          onClick={() => (details.value = !open)}
        >
          <span aria-hidden="true">{open ? "▾" : "▴"}</span> <bdi>{base}</bdi>
        </button>
        <span class="meta">
          <span class={level} title={meterTitle}>
            {percent}
          </span>{" "}
          <span title={name}>{live.model}</span>
          {thinking === undefined ? "" : ` ${thinking}`}
        </span>
        <LinkDot />
      </footer>
    </>
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
  const editable = item.mode !== "write" && systemNoticeSummary(item.text) === undefined;
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
      {panel.value === "roots" ? (
        <RootsPanel />
      ) : panel.value === "client" ? (
        <ClientPanel />
      ) : panel.value === "secrets" ? (
        <SecretsPanel />
      ) : panel.value === "goals" ? (
        <GoalsPanel />
      ) : panel.value === "jobs" ? (
        <JobsPanel />
      ) : state === undefined ? (
        <main class="transcript">connecting…{linkError.value ? ` ${linkError.value}` : ""}</main>
      ) : (
        <>
          {shown.value === undefined && inbox.value.length > 0 ? <FilterBar /> : null}
          <Transcript key={state.conversation.id} view={state} front={shown.value === undefined} />
        </>
      )}
      <Queue />
      <Login />
      <InstallOffer />
      <SecretRequests />
      {choice.value !== undefined ? (
        <Pick />
      ) : ask.value !== undefined ? (
        <Ask />
      ) : entering.value !== undefined ? (
        <SecretForm />
      ) : (
        <Editor />
      )}
      <Footer />
    </>
  );
}
