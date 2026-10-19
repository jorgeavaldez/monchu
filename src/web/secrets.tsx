/**
 * Secrets in the page: agents' requests as lines over the editor, a masked form in the editor's place, and `/secrets`
 * to list, replace and delete them by name. A value goes to the core once, in `setSecret`, and is dropped from the page
 * as it goes; nothing ever sends one back.
 */
import { signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Client, SecretInput, SecretsState } from "../api/client.ts";
import { Close, Panel } from "./panel.tsx";
import { client, panel } from "./state.ts";

type Kind = SecretInput["kind"];

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
  if (open) panel.value = "secrets";
  else if (panel.value === "secrets") panel.value = undefined;
  message.value = undefined;
}

/** Opens the form for a pending request. */
function enter(request: SecretsState["requests"][number]): void {
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

/** Each pending request, one line over the editor: who asks, for what, and why. */
export function SecretRequests() {
  if (entering.value !== undefined) return null;
  const { requests } = state.value;
  const status = message.value;
  return (
    <>
      {status === undefined ? null : (
        <p role="status" class={`offer ${status.failed ? "warning" : "help"}`}>
          <span>{status.text}</span>
          <Close label="dismiss" onClose={() => (message.value = undefined)} />
        </p>
      )}
      {requests.map((request) => (
        <div key={request.id} class="offer secretRequest" role="status">
          <span>
            <b>{request.name}</b>
            {request.kind === "login" ? " login" : ""} · {request.by} · {request.reason}
          </span>
          <button type="button" aria-label={`enter ${request.name}`} onClick={() => enter(request)}>
            enter
          </button>
          <Close label={`decline ${request.name}`} onClose={() => void decline(request.name)} />
        </div>
      ))}
    </>
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
      <Close label="cancel" onClose={leave} />
    </form>
  );
}

/** `/secrets`: stored secrets by name, in place of the transcript; pending requests stay over the editor. */
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
