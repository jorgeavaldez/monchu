/** The page: who's working, the shown conversation, its queue, and the editor or whatever answer it waits for. */
import { signal, useSignal } from "@preact/signals";
import { systemNoticeSummary } from "../api/notices.ts";
import { activeRoots, rootLabel } from "../ui/roots.ts";
import { contextUsage, presentation, type QueuedItem } from "../ui/state.ts";
import { ClientPanel, InstallOffer } from "./client.tsx";
import { Editor } from "./editor.tsx";
import { GoalsPanel, JobsPanel, PinsPanel } from "./lists.tsx";
import { Close } from "./panel.tsx";
import { entering, SecretForm, SecretRequests, SecretsPanel } from "./secrets.tsx";
import { run } from "./commands.ts";
import {
  ask,
  choice,
  client,
  connection,
  linkError,
  editing,
  loginStatus,
  rootId,
  roots,
  panel,
  pins,
  inbox,
  shown,
  view,
  workers,
} from "./state.ts";
import { FilterBar } from "./inbox.tsx";
import { Transcript } from "./transcript.tsx";

const STATUS_TEXT = { working: "working", done: "done, not seen yet", idle: "idle" };

/**
 * The root menu, right of the agent tabs: one dot per active root (working, or done and not seen yet) with the shown
 * one underlined, or a hollow one while all are idle, and ▾. The shown root's name is its label and title; its detail is
 * the roots picker, which a tap opens.
 */
function RootTab() {
  const active = activeRoots(roots.value);
  const open = choice.value?.title === "Roots";
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
      class={`roots${open ? " on" : ""}`}
      aria-label={`roots: ${name}${summary ? `; ${summary}` : ""}`}
      aria-expanded={open}
      title={summary ? `${name} · ${summary}` : name}
      onClick={() => run("roots.toggle")}
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

/**
 * The pins button, left of the root menu once anything is pinned: ★ and how many, opening the pins panel as `/pins`
 * does, or closing it.
 */
function PinsTab() {
  const open = panel.value === "pins";
  const count = pins.value.length;
  if (count === 0 && !open) return null;
  return (
    <button
      class={`pins${open ? " on" : ""}`}
      aria-label={`pins: ${String(count)}`}
      aria-expanded={open}
      title="pinned messages (/pins)"
      onClick={() => run("pins.toggle")}
    >
      <span aria-hidden="true">★</span> {count}
    </button>
  );
}

function Agents() {
  const root = view(undefined)?.value;
  const rootBusy = root === undefined ? false : presentation(root).busy;
  return (
    <nav class="agents">
      <div class="tabs">
        <button
          class={shown.value === undefined ? "on" : ""}
          onClick={() => run("show", undefined)}
        >
          {rootBusy ? "●" : "○"} root
        </button>
        {/* Working workers first, idle ones after, each in the order the crew lists them. */}
        {workers.value
          .toSorted((x, y) => Number(y.busy) - Number(x.busy))
          .map((worker) => (
            <button
              key={worker.name}
              class={shown.value === worker.name ? "on" : ""}
              onClick={() => run("show", worker.name)}
            >
              {worker.busy ? "●" : "○"} {worker.name}
            </button>
          ))}
      </div>
      <PinsTab />
      <RootTab />
    </nav>
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
      <label for="ask">{current.title}</label>
      <div class="row">
        {current.secret ? (
          <input id="ask" type="password" {...input} />
        ) : (
          <input id="ask" type="text" {...input} />
        )}
        <button type="submit" class="icon" aria-label="ok" title="ok (Enter)">
          ›
        </button>
        <Close label="cancel" onClose={() => current.cancel()} />
      </div>
    </form>
  );
}

function Login() {
  const status = loginStatus.value;
  if (status === undefined) return null;
  return (
    <div class="offer login" role="status">
      <span>
        {status.message}
        {status.code === undefined ? null : <code>{status.code}</code>}
      </span>
      {status.url === undefined ? null : (
        <a href={status.url} target="_blank" rel="noreferrer noopener">
          open
        </a>
      )}
      <Close label="cancel the sign-in" onClose={() => run("login.cancel")} />
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
          onClick={() => run("queue.open", item)}
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
          run("queue.change", item.id, {
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
        onClick={() => run("queue.change", item.id, { kind: "delete" })}
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
      {panel.value === "client" ? (
        <ClientPanel />
      ) : panel.value === "secrets" ? (
        <SecretsPanel />
      ) : panel.value === "goals" ? (
        <GoalsPanel />
      ) : panel.value === "jobs" ? (
        <JobsPanel />
      ) : panel.value === "pins" ? (
        <PinsPanel />
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
      {/* A pick opens over the editor, which stays to filter it. */}
      {choice.value === undefined && ask.value !== undefined ? (
        <Ask />
      ) : choice.value === undefined && entering.value !== undefined ? (
        <SecretForm />
      ) : (
        <Editor />
      )}
      <Footer />
    </>
  );
}
