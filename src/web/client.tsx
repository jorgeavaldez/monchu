/**
 * `/client`: this client's own settings, which never reach the core. The app's name is this device's, kept by the web
 * server, which names its install manifest with it; the theme is this browser's. The install offer is here too: a
 * browser's own prompt, offered once and kept in the menu, since no page can install itself. A phone is offered push
 * once the same way, since that is where it matters and nobody looks for it in a menu.
 */
import { signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Close, Panel } from "./panel.tsx";
import type { InboxKind } from "../api/client.ts";
import { client, connection, panel, setPanel } from "./state.ts";

/** What Chrome hands a page it would install: its prompt, and how the person answered. */
type InstallPrompt = Event & {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isInstallPrompt(event: Event): event is InstallPrompt {
  return "prompt" in event && typeof event.prompt === "function" && "userChoice" in event;
}

type Theme = "system" | "light" | "dark";
const THEMES: readonly Theme[] = ["system", "light", "dark"];
const THEME_KEY = "monchu.theme";
const OFFER_KEY = "monchu.install";
const PUSH_OFFER_KEY = "monchu.push";

/** The app's name on this device, and whether this sign-in may change it (a service token may not). */
const appName = signal("Monchu");
const editable = signal(false);
const theme = signal<Theme>("system");
const offer = signal<InstallPrompt | undefined>(undefined);
const installed = signal(false);
/** The offer's dismissal outlives the page, so it is made once. */
const offerDismissed = signal(false);
/** The push offer's, likewise; set too once push is turned on from it. */
const pushOffered = signal(false);

/** The menu's last outcome. */
const message = signal<{ text: string; failed: boolean } | undefined>(undefined);

function applyTheme(value: Theme): void {
  theme.value = value;
  if (value === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}

/** Before the first render: the saved theme, the browser's install offer, and this device's name. */
export function startClient(): void {
  const saved = THEMES.find((each) => each === localStorage.getItem(THEME_KEY));
  if (saved !== undefined) applyTheme(saved);
  offerDismissed.value = localStorage.getItem(OFFER_KEY) === "dismissed";
  pushOffered.value = localStorage.getItem(PUSH_OFFER_KEY) === "offered";
  installed.value = matchMedia("(display-mode: standalone)").matches;
  addEventListener("beforeinstallprompt", (event) => {
    // Held for the menu and the one-time offer, in place of the browser's own mini bar.
    event.preventDefault();
    if (isInstallPrompt(event)) offer.value = event;
  });
  addEventListener("appinstalled", () => {
    installed.value = true;
    offer.value = undefined;
  });
  void fetch("/client.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      if ("name" in value && typeof value.name === "string") appName.value = value.name;
      editable.value = "editable" in value && value.editable === true;
      document.title = appName.value;
    })
    .catch(() => {});
}

export function openClient(open = true): void {
  if (open) setPanel("client");
  else if (panel.value === "client") setPanel(undefined);
  message.value = undefined;
}

async function install(): Promise<void> {
  const prompt = offer.value;
  if (prompt === undefined) return;
  // A prompt is good for one ask; the browser offers another later if this one is declined.
  offer.value = undefined;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === "accepted") installed.value = true;
  else dismissOffer();
}

function dismissOffer(): void {
  offerDismissed.value = true;
  localStorage.setItem(OFFER_KEY, "dismissed");
}

async function saveName(name: string): Promise<void> {
  const response = await fetch("/client.json", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).catch(() => undefined);
  if (response === undefined || !response.ok) {
    const reason = response === undefined ? "Monchu is unreachable" : await response.text();
    message.value = { text: `not saved · ${reason}`, failed: true };
    return;
  }
  const value: unknown = await response.json();
  if (typeof value === "object" && value !== null && "name" in value)
    appName.value = String(value.name);
  document.title = appName.value;
  message.value = {
    text: installed.value
      ? `named ${appName.value} · the installed app takes it on its next launch, once Chrome asks you to confirm; if it never does, reinstall`
      : `named ${appName.value} · an install takes this name`,
    failed: false,
  };
}

/** Why the install row has no button, said as it is. */
function installState(): string {
  if (installed.value) return "installed · this window is the app";
  if (offer.value !== undefined) return "this browser can install it";
  if (!isSecureContext) return "can't install: browsers install only from https or localhost";
  if (!("onbeforeinstallprompt" in window))
    return "no install prompt in this browser: its menu's Add to Home Screen, where it has one";
  return "not offered: installed already, or the browser hasn't offered yet; its menu's Install app works too";
}

function NameRow() {
  const value = useSignal(appName.value);
  return (
    <li>
      <form
        class="lines"
        onSubmit={(event) => {
          event.preventDefault();
          void saveName(value.value);
        }}
      >
        <label class="name" for="client-name">
          app name
        </label>
        <input
          id="client-name"
          type="text"
          maxLength={30}
          autoComplete="off"
          spellcheck={false}
          disabled={!editable.value}
          value={value.value}
          placeholder="Monchu"
          onInput={(event) => {
            value.value = event.currentTarget.value;
          }}
        />
        <span class="help">
          {editable.value
            ? "app and tab name; empty: Monchu"
            : "read only: only a person's login can rename it"}
        </span>
      </form>
      <span class="actions">
        <button
          type="button"
          aria-label="save the name"
          title="save (Enter)"
          disabled={!editable.value || value.value.trim() === appName.value}
          onClick={() => void saveName(value.value)}
        >
          ✓
        </button>
      </span>
    </li>
  );
}

/** What this browser is pushed: `undefined` until known, or where the browser has no push. */
const pushed = signal<InboxKind[] | undefined>(undefined);
const PUSH_KINDS: [InboxKind, string][] = [
  ["ask", "asks"],
  ["milestone", "done"],
];

async function subscription(): Promise<PushSubscription | null> {
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

async function loadPush(): Promise<void> {
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) return;
  const current = await subscription();
  pushed.value = current === null ? [] : ((await client().pushKinds(current.endpoint)) ?? []);
}

/** Push this browser one kind more or less. */
async function togglePush(kind: InboxKind): Promise<void> {
  const kinds = pushed.value ?? [];
  await setPush(kinds.includes(kind) ? kinds.filter((each) => each !== kind) : [...kinds, kind]);
}

/** Push this browser these kinds: asks the browser's permission, and subscribes on the first. */
async function setPush(next: InboxKind[]): Promise<void> {
  if (next.length > 0 && (await Notification.requestPermission()) !== "granted") {
    message.value = {
      text: "notifications are blocked for this site in the browser",
      failed: true,
    };
    return;
  }
  let current = await subscription();
  if (current === null && next.length > 0)
    current = await (
      await navigator.serviceWorker.ready
    ).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(
        atob((await client().pushKey()).replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0),
      ),
    });
  if (current === null) return;
  const keys = current.toJSON().keys ?? {};
  await client().pushSubscribe({
    endpoint: current.endpoint,
    p256dh: keys.p256dh ?? "",
    auth: keys.auth ?? "",
    origin: location.origin,
    kinds: next,
  });
  if (next.length === 0) await current.unsubscribe();
  pushed.value = next;
}

function PushRow() {
  useEffect(() => {
    void loadPush().catch(() => {});
  }, []);
  return (
    <li>
      <span class="lines">
        <span class="name">push</span>
        <span class="help">
          {pushed.value === undefined
            ? "this browser has no push"
            : "notify this browser when Monchu needs you or finishes something"}
        </span>
      </span>
      {pushed.value === undefined ? null : (
        <span class="actions">
          {PUSH_KINDS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={pushed.value?.includes(kind) === true}
              onClick={() =>
                void togglePush(kind).catch((error: unknown) => {
                  message.value = {
                    text: `push: ${error instanceof Error ? error.message : String(error)}`,
                    failed: true,
                  };
                })
              }
            >
              {label}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

/** The menu, in place of the transcript like `/roots`. */
export function ClientPanel() {
  return (
    <Panel name="client" status={message.value}>
      <ul>
        <NameRow />
        <PushRow />
        <li>
          <span class="lines">
            <span class="name">install</span>
            <span class="help">{installState()}</span>
          </span>
          {offer.value === undefined || installed.value ? null : (
            <span class="actions">
              <button type="button" onClick={() => void install()}>
                install
              </button>
            </span>
          )}
        </li>
        <li>
          <span class="lines">
            <span class="name">theme</span>
            <span class="help">this browser's</span>
          </span>
          <span class="actions">
            {THEMES.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={theme.value === each}
                onClick={() => {
                  applyTheme(each);
                  if (each === "system") localStorage.removeItem(THEME_KEY);
                  else localStorage.setItem(THEME_KEY, each);
                }}
              >
                {each}
              </button>
            ))}
          </span>
        </li>
      </ul>
    </Panel>
  );
}

function pushOfferDone(): void {
  pushOffered.value = true;
  localStorage.setItem(PUSH_OFFER_KEY, "offered");
}

/** Push of asks and done on this phone, offered once until it's turned on or dismissed; the menu keeps it after. */
function PushOffer() {
  const phone = matchMedia("(pointer: coarse)").matches;
  const wanted = phone && !pushOffered.value && panel.value !== "client";
  const live = connection.value === "live";
  useEffect(() => {
    if (wanted && live) void loadPush().catch(() => {});
  }, [wanted, live]);
  if (
    !wanted ||
    pushed.value === undefined ||
    pushed.value.length > 0 ||
    Notification.permission === "denied"
  )
    return null;
  return (
    <div class="offer" role="status">
      <span>notify this phone when Monchu needs you or finishes something</span>
      <button
        type="button"
        onClick={() => {
          pushOfferDone();
          // Whatever goes wrong shows in the menu, where push can be tried again.
          message.value = undefined;
          void setPush(PUSH_KINDS.map(([kind]) => kind))
            .catch((error: unknown) => {
              message.value = {
                text: `push: ${error instanceof Error ? error.message : String(error)}`,
                failed: true,
              };
            })
            .then(() => {
              if (message.value?.failed === true) setPanel("client");
            });
        }}
      >
        turn on
      </button>
      <Close label="close" onClose={pushOfferDone} />
    </div>
  );
}

/**
 * The browser's install offer, once: a line over the editor until it's taken or dismissed. Push is offered on a phone
 * in its place once there's no install to offer.
 */
export function InstallOffer() {
  if (
    offer.value === undefined ||
    installed.value ||
    offerDismissed.value ||
    panel.value === "client"
  )
    return <PushOffer />;
  return (
    <div class="offer" role="status">
      <span>install {appName.value} as an app</span>
      <button type="button" onClick={() => void install()}>
        install
      </button>
      <Close label="close" onClose={dismissOffer} />
    </div>
  );
}
