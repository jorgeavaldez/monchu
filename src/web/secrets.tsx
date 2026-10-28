/**
 * Secrets in the page: agents' requests as asks (a line each under the front's asks, opened in the editor's place),
 * a masked form in the editor's place, and `/secrets` to list, replace and delete them by name. A value goes to the
 * core once, in `setSecret`, and is dropped from the page as it goes; nothing ever sends one back.
 */
import { computed, signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Client, SecretInput, SecretsState } from "../api/client.ts";
import { Close, Panel } from "./panel.tsx";
import { client, panel, setPanel } from "./state.ts";

type Kind = SecretInput["kind"];
type Request = SecretsState["requests"][number];

/** What the form asks for: a named secret (a request's or one being replaced), or a new one when `name` is absent. */
type Entry = { name?: string; kind: Kind; site?: string; reason?: string; by?: string };

const state = signal<SecretsState>({ secrets: [], requests: [] });
export const entering = signal<Entry | undefined>(undefined);
/** The last outcome, shown in the panel and over the editor. */
const message = signal<{ text: string; failed: boolean } | undefined>(undefined);

export async function startSecrets(connected: Client): Promise<void> {
  await connected.watchSecrets((next) => {
    state.value = next;
  });
}

export function openSecrets(open = true): void {
  if (open) setPanel("secrets");
  else if (panel.value === "secrets") setPanel(undefined);
  message.value = undefined;
}

/** Opens the form for a pending request. */
function enter(request: Request): void {
  message.value = undefined;
  const { name, kind, reason, by, site } = request;
  entering.value = { name, kind, reason, by, ...(site === undefined ? {} : { site }) };
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function decline(name: string): Promise<void> {
  try {
    await client().declineSecret(name);
    message.value = { text: `declined · ${name}`, failed: false };
  } catch (error) {
    message.value = { text: `not declined · ${failure(error)}`, failed: true };
  }
}

async function remove(name: string): Promise<void> {
  if (!confirm(`Delete ${name}? Agents using it fail until it is set again.`)) return;
  try {
    await client().deleteSecret(name);
    message.value = { text: `deleted · ${name}`, failed: false };
  } catch (error) {
    message.value = { text: `not deleted · ${failure(error)}`, failed: true };
  }
}

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The pending requests: asks of the person, counted with the front's and listed under its asks. */
export const secretRequests = computed(() => state.value.requests);
/** The request opened from its line, by id, shown in the editor's place until provided, declined or closed. */
const viewing = signal<number | undefined>(undefined);
export const viewed = computed(() =>
  state.value.requests.find((request) => request.id === viewing.value),
);

/** The last outcome over the editor: saved, declined, or why not. */
export function SecretStatus() {
  const status = message.value;
  if (entering.value !== undefined || status === undefined) return null;
  return (
    <p role="status" class={`offer ${status.failed ? "warning" : "help"}`}>
      <span>{status.text}</span>
      <Close label="dismiss" onClose={() => (message.value = undefined)} />
    </p>
  );
}

/** Under the asks, pinned to the bottom: each pending request on one line; tapping it opens it. */
export function SecretAsks() {
  const requests = secretRequests.value;
  if (requests.length === 0) return null;
  return (
    <ul class="secretAsks">
      {requests.map((request) => (
        <li key={request.id}>
          <button
            type="button"
            class="secretRequest"
            aria-expanded={viewing.value === request.id}
            onClick={() => {
              entering.value = undefined;
              viewing.value = request.id;
            }}
          >
            <span class="line">
              <b>{request.name}</b>
              {request.kind === "login" ? " login" : ""}
              <span class="help">
                {" "}
                · {request.by} · {request.reason}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Focuses a cell as it mounts: a stable ref, so later renders leave focus where the person put it. */
const focus = (button: HTMLButtonElement | null) => button?.focus();

/** An opened request, in the editor's place: what, who asked and when, and why; ✕ closes, ⊘ declines, ✓ provides. */
export function SecretDetail({ request }: { request: Request }) {
  const close = () => (viewing.value = undefined);
  return (
    <section
      class="secretDetail"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div class="body">
        <div>
          <span class="key">⚷</span> <b>{request.name}</b> · {request.kind}
          {request.site === undefined ? "" : ` · fills only on ${request.site}`}
        </div>
        <div class="help">
          asked by {request.by} · {when(request.at)}
        </div>
        <div>{request.reason}</div>
      </div>
      <div class="bar">
        <Close label="close" onClose={close} />
        <button
          type="button"
          class="icon"
          aria-label="decline"
          onClick={() => {
            close();
            void decline(request.name);
          }}
        >
          ⊘
        </button>
        <button
          type="button"
          class="icon provide"
          aria-label="provide"
          ref={focus}
          onClick={() => {
            close();
            enter(request);
          }}
        >
          ✓
        </button>
      </div>
    </section>
  );
}

/** The masked form, in the editor's place: Enter saves, Esc or ✕ leaves; fields empty themselves as the value goes. */
export function SecretForm() {
  const entry = entering.value;
  const name = useSignal("");
  const kind = useSignal<Kind>("value");
  const site = useSignal("");
  const value = useSignal("");
  const username = useSignal("");
  // The name being saved, while the core stores it and tells whoever asked.
  const saving = useSignal<string | undefined>(undefined);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    kind.value = entry?.kind ?? "value";
    site.value = entry?.site ?? "";
    first.current?.focus();
  }, [entry]);
  if (entry === undefined) return null;
  const leave = () => {
    value.value = "";
    username.value = "";
    entering.value = undefined;
  };
  const save = async () => {
    const target = (entry.name ?? name.value).trim();
    const common = {
      name: target,
      ...(site.value.trim() === "" ? {} : { site: site.value.trim() }),
      ...(entry.reason === undefined ? {} : { description: entry.reason }),
    };
    const input: SecretInput =
      kind.value === "login"
        ? { ...common, kind: "login", username: username.value, password: value.value }
        : { ...common, kind: "value", value: value.value };
    // The page keeps no copy: the fields empty before the call settles.
    value.value = "";
    username.value = "";
    saving.value = target;
    try {
      await client().setSecret(input);
      message.value = { text: `saved · ${target}`, failed: false };
      entering.value = undefined;
    } catch (error) {
      message.value = { text: `not saved · ${failure(error)}`, failed: true };
    } finally {
      saving.value = undefined;
    }
  };
  const field = (
    label: string,
    signalValue: typeof value,
    type: "text" | "password",
    ref?: typeof first,
  ) => {
    const props = {
      autoComplete: "off",
      autoCapitalize: "off" as const,
      spellcheck: false,
      value: signalValue.value,
      ...(ref === undefined ? {} : { ref }),
      onInput: (event: { currentTarget: HTMLInputElement }) => {
        signalValue.value = event.currentTarget.value;
      },
    };
    return (
      <label>
        {label}
        {type === "password" ? (
          <input type="password" {...props} />
        ) : (
          <input type="text" {...props} />
        )}
      </label>
    );
  };
  const status = message.value;
  return (
    <form
      class="secretForm"
      onKeyDown={(event) => {
        if (event.key === "Escape") leave();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (saving.value === undefined) void save();
      }}
    >
      <Close label="cancel" onClose={leave} />
      <span class="fields">
        <span class="help">
          {entry.name === undefined
            ? "new secret · agents use it by name, never see it"
            : `${entry.name}${entry.by === undefined ? "" : ` · ${entry.by}`}${entry.reason === undefined ? "" : ` · ${entry.reason}`}`}
        </span>
        {saving.value !== undefined ? (
          <span class="saving" role="status">
            saving {saving.value}…
          </span>
        ) : status?.failed === true ? (
          <span class="warning">{status.text}</span>
        ) : null}
        {entry.name === undefined ? (
          <>
            {field("name", name, "text", first)}
            <span class="kinds" role="group" aria-label="kind">
              {(["value", "login"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  aria-pressed={kind.value === each}
                  onClick={() => (kind.value = each)}
                >
                  {each}
                </button>
              ))}
            </span>
          </>
        ) : null}
        {kind.value === "login" ? (
          <>
            {entry.name === undefined || entry.site === undefined
              ? field("site (optional): fill only there", site, "text")
              : null}
            {field("username", username, "text", entry.name === undefined ? undefined : first)}
            {field("password", value, "password")}
          </>
        ) : (
          field("value", value, "password", entry.name === undefined ? undefined : first)
        )}
      </span>
      <button
        type="submit"
        class="icon"
        aria-label="save"
        title="save (Enter)"
        disabled={saving.value !== undefined}
      >
        {saving.value === undefined ? "✓" : "…"}
      </button>
    </form>
  );
}

/** `/secrets`: stored secrets by name, in place of the transcript; pending requests are asks. */
export function SecretsPanel() {
  const { secrets } = state.value;
  return (
    <Panel
      name="secrets"
      actions={
        <button
          type="button"
          class="icon"
          aria-label="new secret"
          title="new secret"
          onClick={() => {
            message.value = undefined;
            entering.value = { kind: "value" };
          }}
        >
          +
        </button>
      }
    >
      <ul>
        {secrets.map((info) => (
          <li key={info.name}>
            <span class="lines">
              <span class="name">
                {info.name}
                {info.kind === "login" ? " · login" : ""}
                {info.site === undefined ? "" : ` · ${info.site}`}
              </span>
              <span class="help">
                {[
                  info.description,
                  `set ${when(info.setAt)}`,
                  info.usedAt === undefined ? "never used" : `used ${when(info.usedAt)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span class="actions">
              <button
                type="button"
                aria-label={`replace ${info.name}`}
                onClick={() => {
                  entering.value = {
                    name: info.name,
                    kind: info.kind,
                    ...(info.site === undefined ? {} : { site: info.site }),
                    ...(info.description === undefined ? {} : { reason: info.description }),
                  };
                }}
              >
                replace
              </button>
              <button
                type="button"
                aria-label={`delete ${info.name}`}
                onClick={() => void remove(info.name)}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {secrets.length === 0 ? (
        <p class="help">none yet · agents ask with the secret tool, or add one with +</p>
      ) : (
        <p class="help">agents use these by name; values never reach them or the transcript</p>
      )}
    </Panel>
  );
}
