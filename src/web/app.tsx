/** The page: who's working, the shown conversation, its queue, and the editor or whatever answer it waits for. */
import { useSignal } from "@preact/signals";
import { contextUsage, presentation } from "../ui/state.ts";
import { Editor } from "./editor.tsx";
import {
  ask,
  cancelLogin,
  choice,
  client,
  connection,
  loginStatus,
  mode,
  show,
  shown,
  view,
  workers,
} from "./state.ts";
import { Transcript } from "./transcript.tsx";

function Agents() {
  const root = view(undefined)?.value;
  const rootBusy = root === undefined ? false : presentation(root).busy;
  return (
    <nav class="agents">
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
      {state === undefined ? (
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
