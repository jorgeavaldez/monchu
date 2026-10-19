/**
 * The web client's state: signals the views read, and the actions behind every command. All core access goes through
 * the shared `Client` contract, so the web does what the terminal does, with the same command table.
 */
import { batch, effect, signal, type Signal } from "@preact/signals";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Attachment } from "../api/attachments.ts";
import type {
  Client,
  JobEvent,
  Goal,
  InboxItem,
  ModelPick,
  QueueChange,
  RootClient,
  RootSummary,
  WorkerSummary,
} from "../api/client.ts";
import { parseWorkerNotice, type WhenBusy } from "../api/notices.ts";
import { shortId } from "../api/ids.ts";
import { formatReports } from "../api/reports.ts";
import { releaseNotices } from "../api/release.ts";
import type { Connection } from "../api/remote.ts";
import { helpText, loginProviders, parseInput } from "../ui/commands.ts";
import { formatJobEvent } from "../ui/jobs.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints, pickTargets } from "../ui/login.ts";
import { parseRootsCommand, rootLabel, type RootsCommand } from "../ui/roots.ts";
import { age, contextUsage, lastActive, presentation, type QueuedItem } from "../ui/state.ts";
import { clearPending, openPicker } from "./attachments.tsx";
import type { MenuItem, Tone } from "./menu.tsx";

/** A line under the transcript; one with a `root` shows only while that root is shown. */
export type Notice = {
  id: number;
  at: number;
  text: string;
  kind: "system" | "warning" | "event";
  root?: string;
  /** A job's event, which shows as a folded job box instead of a line. */
  job?: JobEvent;
  /** Per attached conversation, the newest entry it showed when this was posted (-1 for none); it follows that entry. */
  after: ReadonlyMap<ConversationView["conversation"]["id"], number>;
};

/** A choice the user makes over the editor, typing to filter: a login prompt, a model, a thinking level, a worker. */
export type Choice = {
  title: string;
  options: MenuItem[];
  /** What the filter starts with, such as `/model`'s search. */
  query?: string;
  choose(id: string, alternate: boolean): void;
  cancel(): void;
  /** The alternate action's label (Ctrl+S or a second button), such as saving a model as the default. */
  alternate?: string;
};

/** A typed answer the user gives in place of the editor: a login code, key or pasted URL. */
export type Ask = {
  title: string;
  secret: boolean;
  placeholder?: string;
  answer(value: string): void;
  cancel(): void;
};

/** The link to the core, as the status bar's dot shows it; a drop and its redial never write to the transcript. */
export const connection = signal<Connection | "connecting">("connecting");
/** Every root, archived ones included, as the core reports them. */
export const roots = signal<readonly RootSummary[]>([]);
/** The root this page shows, by full id. */
export const rootId = signal<string | undefined>(undefined);
/** The panel open in place of the transcript, one at a time; Esc or ✕ closes it. */
export const panel = signal<"roots" | "client" | "secrets" | "goals" | "jobs" | undefined>(
  undefined,
);
/** The roots panel's last outcome. */
export const rootsMessage = signal<{ text: string; failed: boolean } | undefined>(undefined);
export const shown = signal<string | undefined>(undefined);
export const workers = signal<readonly WorkerSummary[]>([]);
export const notices = signal<Notice[]>([]);
export const mode = signal<WhenBusy>("followUp");
export const expandAll = signal(false);
export const choice = signal<Choice | undefined>(undefined);
export const ask = signal<Ask | undefined>(undefined);
/** What a login shows while it waits: its message, a link to open, a code to read. */
export const loginStatus = signal<{ message: string; url?: string; code?: string } | undefined>(
  undefined,
);
/** The newest job event this page heard, so the jobs panel lists them afresh. */
export const jobEvent = signal(0);
/** Bumped when the user sends a message, so the transcript goes back to its end and follows it. */
export const following = signal(0);
/** The editor's text, so a stopped front's queued messages can come back into it. Kept through a reload of the tab. */
export const draft = signal(sessionStorage.getItem("draft") ?? "");
/** The shown root's inbox: its front's messages with their labels. */
export const inbox = signal<readonly InboxItem[]>([]);
/** What the front's stream shows: every message, or only one kind, one goal's, or both. */
export type Filter = { kind?: "ask" | "milestone" | "update"; goal?: string };
export const filter = signal<Filter>({});
/** The shown root's goals, for the goal filter and its briefer. */
export const goalList = signal<readonly Goal[]>([]);
/** Why the page is not connected, and when it tries again. */
export const linkError = signal<string | undefined>(undefined);

let core: Client | undefined;
let current: RootClient | undefined;
/** What the shown root's binding stops when another root is shown. */
let unbind: (() => void)[] = [];
/** Attached views by conversation; a signal itself, so a view attached later re-renders whoever asked for it. */
const views = signal<ReadonlyMap<string, { state: Signal<ConversationView>; dispose(): void }>>(
  new Map(),
);
let nextNotice = 1;
let login: AbortController | undefined;

export function client(): Client {
  if (core === undefined) throw new Error("Not connected");
  return core;
}

/** The root this page shows. */
export function root(): RootClient {
  if (current === undefined) throw new Error("Not connected");
  return current;
}

/** A notice about the shown root, or with `home` one every root shows. */
export function notice(text: string, kind: Notice["kind"] = "system", home = false): void {
  rootNotice(text, kind, home ? undefined : rootId.value);
}

/** A notice that only `root` shows, or every root when undefined. */
function rootNotice(
  text: string,
  kind: Notice["kind"],
  root: string | undefined,
  job?: JobEvent,
): void {
  const after = new Map<ConversationView["conversation"]["id"], number>();
  for (const each of views.value.values()) {
    const value = each.state.value;
    after.set(value.conversation.id, value.entries.at(-1)?.id ?? -1);
  }
  notices.value = [
    ...notices.value,
    {
      id: nextNotice++,
      at: Date.now(),
      text,
      kind,
      after,
      ...(root === undefined ? {} : { root }),
      ...(job === undefined ? {} : { job }),
    },
  ].slice(-200);
}

/** The shown conversation's view, attached on first use and kept while the page lives. */
export function view(name: string | undefined): Signal<ConversationView> | undefined {
  return views.value.get(name ?? "")?.state;
}

async function attach(name: string | undefined): Promise<void> {
  const key = name ?? "";
  if (views.value.has(key)) return;
  const from = root();
  const attached = await from.viewState(name);
  // Another root was shown meanwhile: this view belongs to none.
  if (from !== current || views.value.has(key)) return attached.dispose();
  const state = signal(attached.value);
  const stop = attached.subscribe((value) => {
    state.value = value;
  });
  views.value = new Map(views.value).set(key, {
    state,
    dispose: () => {
      stop();
      attached.dispose();
    },
  });
}

async function refreshWorkers(): Promise<void> {
  const from = root();
  const list = await from.workers();
  if (from === current) workers.value = list;
}

/** The root a page load shows: the one in its address, else this tab's last, else the current root. */
async function initialRoot(connected: Client): Promise<string> {
  const asked = new URL(location.href).searchParams.get("root") ?? sessionStorage.getItem("root");
  if (asked !== null && asked !== "")
    try {
      return await connected.findRoot(asked);
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), "warning", true);
    }
  return connected.currentRoot();
}

/**
 * Show a root in this page: its front, crew, assessments and routing state, in place of the one shown. The address
 * names it, so a reload comes back here; `push` adds a history entry, so Back returns to the root before.
 */
async function openRoot(id: string, push = false): Promise<void> {
  const connected = client();
  for (const stop of unbind.splice(0)) stop();
  for (const each of views.value.values()) each.dispose();
  views.value = new Map();
  current = connected.root(id);
  batch(() => {
    rootId.value = id;
    shown.value = undefined;
    workers.value = [];
    inbox.value = [];
    filter.value = {};
    goalList.value = [];
  });
  sessionStorage.setItem("root", id);
  const url = new URL(location.href);
  if (url.searchParams.get("root") !== id) {
    url.searchParams.set("root", id);
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  const from = current;
  await attach(undefined);
  await refreshWorkers();
  if (from !== current) return;
  let lastEntry = view(undefined)?.value.entries.at(-1)?.id;
  let lastHead = view(undefined)?.value.entries[0]?.id;
  const front = views.value.get("");
  if (front !== undefined)
    unbind.push(
      front.state.subscribe((value) => {
        // A compaction commits a new head marker, far above the reader; one shown on opening is not news.
        const head = value.entries[0];
        if (head !== undefined && head.id !== lastHead) {
          lastHead = head.id;
          if (head.kind === "pi.compaction") {
            const reason =
              typeof head.data === "object" && head.data !== null && "reason" in head.data
                ? head.data.reason
                : undefined;
            notice(`context compacted${typeof reason === "string" ? ` · ${reason}` : ""}`);
          }
        }
        const newest = value.entries.at(-1)?.id;
        if (newest === lastEntry) return;
        lastEntry = newest;
        void refreshWorkers().catch(() => {});
      }),
    );
  const stopInbox = await from.watchInbox((items) => {
    if (from === current) inbox.value = items;
  });
  if (from !== current) return stopInbox();
  unbind.push(stopInbox);
  void refreshGoals().catch(() => {});
  // Plugins' lines from before this view opened stay unshown; their status lines show once now.
  let last: number | undefined;
  const stopNotices = await from.watchNotices((items) => {
    for (const item of items) if (last !== undefined && item.id > last) notice(item.text, "event");
    last = Math.max(last ?? 0, ...items.map((item) => item.id));
  });
  if (from !== current) return stopNotices();
  unbind.push(stopNotices);
  const status = await from.statusLines();
  if (from === current) for (const line of status) notice(line, "event");
}

/** Show another root from the panel or a command, saying which one it is. */
export async function switchRoot(id: string): Promise<void> {
  if (panel.value === "roots") panel.value = undefined;
  if (id === rootId.value) return;
  await openRoot(id, true);
  const summary = roots.value.find((each) => each.id === id);
  notice(`root · ${id}${summary === undefined ? "" : ` · ${rootLabel(summary)}`}`);
}

/** Bind to a connected client: attach the root, follow reports, assessments and job events. */
export async function start(connected: Client): Promise<void> {
  core = connected;
  // The terminal's first screen: the header, the core's startup notes, then what still needs a login.
  notice(`Monchu ${connected.release.version} · /help · home ${connected.home}`);
  for (const line of connected.notes) notice(line);
  let release = connected.release;
  for (const line of releaseNotices(undefined, release)) notice(line);
  connected.onRelease((next) => {
    for (const line of releaseNotices(release, next)) notice(line, "system", true);
    release = next;
  });
  for (const line of loginHints(await connected.loginNeeds(), true, connected.logins()))
    notice(line);
  await connected.watchRoots((list) => {
    roots.value = list;
  });
  await openRoot(await initialRoot(connected));
  // Back and Forward move between the roots this tab showed.
  addEventListener("popstate", () => {
    const id = new URL(location.href).searchParams.get("root");
    if (id !== null && id !== rootId.value) void openRoot(id).catch(reportFailure);
  });
  connected.onReport((message) => notice(message, "warning", true), { connection: false });
  await connected.watchJobEvents((await connected.jobs()).nextEvent - 1, (events) => {
    // Each job event shows in its own root; an event from before roots belongs to the first.
    const first = roots.value.reduce<RootSummary | undefined>(
      (oldest, each) => (oldest === undefined || each.createdAt < oldest.createdAt ? each : oldest),
      undefined,
    );
    jobEvent.value = Math.max(jobEvent.value, ...events.map((event) => event.id));
    for (const event of events)
      rootNotice(
        formatJobEvent(event),
        "event",
        event.rootId === undefined ? first?.id : shortId(event.rootId),
        event,
      );
  });
}

function reportFailure(error: unknown): void {
  notice(error instanceof Error ? error.message : String(error), "warning");
}

async function refreshGoals(): Promise<void> {
  const from = root();
  const list = await from.goals();
  if (from === current) goalList.value = list;
}

/** Filter the stream to one goal's messages, picked from the root's goals; none shows every goal's. */
export async function pickGoal(): Promise<void> {
  await refreshGoals();
  const picked = await pick("Goal", [
    { id: "", label: "every goal" },
    ...goalList.value.map((goal) => ({ id: goal.id, label: goal.title, detail: goal.status })),
  ]);
  if (picked === undefined) return;
  const { goal: _goal, ...rest } = filter.value;
  filter.value = picked.id ? { ...rest, goal: picked.id } : rest;
}

/** Start an answer to a message by its id in the editor. */
export function answerDraft(code: string): void {
  draft.value = `/answer ${code} `;
}

export async function show(name: string | undefined): Promise<void> {
  await attach(name);
  shown.value = name;
}

/** Pick one of `options` in place of the editor; resolves with its id, or `undefined` when cancelled. */
function pick(
  title: string,
  options: Choice["options"],
  alternate?: string,
  query?: string,
): Promise<{ id: string; alternate: boolean } | undefined> {
  return new Promise((resolve) => {
    choice.value = {
      title,
      options,
      ...(alternate === undefined ? {} : { alternate }),
      ...(query ? { query } : {}),
      choose: (id, second) => {
        choice.value = undefined;
        resolve({ id, alternate: second });
      },
      cancel: () => {
        choice.value = undefined;
        resolve(undefined);
      },
    };
  });
}

/** Ask for typed text in place of the editor; rejects when cancelled or `signal` aborts. */
function prompted(
  title: string,
  secret: boolean,
  signal: AbortSignal,
  placeholder?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      ask.value = undefined;
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    ask.value = {
      title,
      secret,
      ...(placeholder === undefined ? {} : { placeholder }),
      answer: (value) => {
        signal.removeEventListener("abort", cancel);
        ask.value = undefined;
        resolve(value);
      },
      cancel: () => {
        signal.removeEventListener("abort", cancel);
        cancel();
      },
    };
  });
}

/** A provider's prompt, answered here; the core's login asks it of this tab alone. */
async function answerPrompt(request: AuthPrompt, signal: AbortSignal): Promise<string> {
  if (request.type === "select") {
    const picked = await pick(
      request.message,
      request.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { detail: option.description }),
      })),
    );
    if (picked === undefined) throw new Error("Cancelled");
    return picked.id;
  }
  return prompted(
    request.message,
    request.type === "secret",
    signal,
    "placeholder" in request ? request.placeholder : undefined,
  );
}

function loginEvent(event: AuthEvent): void {
  switch (event.type) {
    case "device_code":
      loginStatus.value = {
        message: "Open the page and enter the code · Esc cancels",
        url: event.verificationUri,
        code: event.userCode,
      };
      break;
    case "auth_url":
      loginStatus.value = { message: "Sign in on the page · Esc cancels", url: event.url };
      break;
    case "info":
    case "progress":
      // Provider output stays out of notices and history.
      loginStatus.value = { message: event.message };
      break;
  }
}

export function cancelLogin(): void {
  login?.abort();
  choice.value?.cancel();
  ask.value?.cancel();
}

async function runLogin(): Promise<void> {
  const controller = new AbortController();
  login = controller;
  let loggedIn = false;
  try {
    const providers = loginProviders(client().logins());
    const picked = await pick(
      "Choose provider:",
      providers.map(({ id, label }) => ({ id, label })),
    );
    if (picked === undefined) return;
    const starting = { message: "Starting…" };
    loginStatus.value = starting;
    const auth = providers.find((entry) => entry.id === picked.id)?.auth ?? "oauth";
    await client().login(picked.id, auth, {
      signal: controller.signal,
      // Closing a prompt cancels the login it asks for.
      prompt: (request) => {
        // The prompt says what happens now; a provider's status (a sign-in page) stays.
        if (loginStatus.value === starting) loginStatus.value = undefined;
        return answerPrompt(request, controller.signal).catch((error: unknown) => {
          controller.abort();
          throw error;
        });
      },
      notify: loginEvent,
    });
    notice(`logged in · ${picked.id}`);
    loggedIn = true;
  } catch {
    // Provider failures can include entered credentials. Never echo raw login errors.
    notice(controller.signal.aborted ? "login cancelled" : LOGIN_FAILED, "warning");
  } finally {
    login = undefined;
    loginStatus.value = undefined;
    // A prompt still open belongs to a login that is over.
    controller.abort();
  }
  // As in the terminal: what still needs a login, once this one is done.
  if (loggedIn)
    for (const line of loginHints(await client().loginNeeds(), false, client().logins()))
      notice(line);
}

async function runMcp(text: string): Promise<void> {
  const [action = "", server = ""] = text.split(/\s+/);
  if (action === "logout" && server) return notice(`mcp · ${await client().mcpLogout(server)}`);
  if (action === "reconnect")
    return notice(
      formatReports(await client().mcpReconnect(), (name) => `/mcp login ${name}`).join("\n"),
    );
  if (action !== "login")
    return notice(
      formatReports(await client().mcpServers(), (name) => `/mcp login ${name}`).join("\n"),
    );
  let name = server;
  if (!name) {
    const { servers } = await client().mcpServers();
    const picked = await pick(
      "Sign in to MCP server",
      servers
        .filter((each) => each.state === "needs-auth")
        .map((each) => ({ id: each.name, label: each.name, detail: each.transport })),
    );
    if (picked === undefined) return;
    name = picked.id;
  }
  const controller = new AbortController();
  login = controller;
  try {
    const starting = { message: "Starting…" };
    loginStatus.value = starting;
    const message = await client().mcpLogin(
      name,
      {
        showAuthorizationUrl: (url) => {
          loginStatus.value = { message: "Sign in on the page · Esc cancels", url };
        },
        promptForRedirectUrl: (signal) =>
          prompted(
            "If the browser cannot reach this machine, paste the URL it was redirected to",
            false,
            signal,
          ).catch(() => undefined),
      },
      controller.signal,
    );
    notice(`mcp · ${message}`);
  } catch (error) {
    notice(
      controller.signal.aborted
        ? "mcp · sign-in cancelled"
        : `mcp · ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  } finally {
    login = undefined;
    loginStatus.value = undefined;
  }
}

/** `/model` and `/thinking`: first what to change, as the terminal asks, then the pick; Ctrl+S or a row's second button saves a role default. */
async function runModel(thinking: boolean, search: string): Promise<void> {
  await refreshWorkers();
  const targets = pickTargets(
    shown.value,
    workers.value.map((worker) => worker.name),
  );
  const which = await pick(
    thinking ? "Pick the thinking level of" : "Pick the model of",
    // The terminal's Ctrl+S is a button on each row of the next list here.
    targets.map(({ label, target, description }) => ({
      id: label,
      label,
      detail:
        target.kind === "conversation" ? "this conversation, or its role default" : description,
    })),
  );
  const target = targets.find((each) => each.label === which?.id)?.target;
  if (target === undefined) return;
  const name = target.kind === "default" ? `${target.role} default` : (target.name ?? "root");
  const current =
    target.kind === "default"
      ? await client().roleChoice(target.role)
      : await root().modelChoice(target.name);
  // A role default saves on Enter, so it has no separate save.
  const role = target.kind === "conversation" && target.name !== undefined ? "worker" : "front";
  const alternate = target.kind === "conversation" ? `save as ${role} default` : undefined;
  const apply = async (change: ModelPick, save: boolean, value: string) => {
    if (target.kind === "default") {
      await client().saveDefault(target.role, change);
      return notice(`${name} ${value} · saved`);
    }
    await root().pickModel(change, save, target.name);
    notice(`${name} ${value} · ${save ? `saved as ${role} default` : "this conversation only"}`);
  };
  if (thinking) {
    const picked = await pick(
      `Thinking level · ${name} (now ${current.thinkingLevel}, default ${current.defaults.thinkingLevel})`,
      current.thinkingLevels.map((level) => ({
        id: level,
        label: level,
        tags: [
          ...(level === current.thinkingLevel
            ? [{ text: "current", tone: "accent" as const }]
            : []),
          ...(level === current.defaults.thinkingLevel
            ? [{ text: "default", tone: "green" as const }]
            : []),
        ],
      })),
      alternate,
    );
    const level = current.thinkingLevels.find((each) => each === picked?.id);
    if (picked === undefined || level === undefined) return;
    return apply({ thinkingLevel: level }, picked.alternate, `thinking · ${level}`);
  }
  if (current.models.length === 0)
    return notice("no models with credentials yet · /login first", "warning");
  const key = (provider: string, id: string) => `${provider}/${id}`;
  const now =
    current.model === undefined ? undefined : key(current.model.provider, current.model.id);
  const fallback = key(current.defaults.provider, current.defaults.modelId);
  // The current model first and the role default second, as the terminal lists them; the search starts the filter.
  const models = current.models.toSorted((x, y) => {
    const rank = (model: (typeof current.models)[number]) =>
      key(model.provider, model.id) === now
        ? 0
        : key(model.provider, model.id) === fallback
          ? 1
          : 2;
    return rank(x) - rank(y);
  });
  const picked = await pick(
    `Model · ${name}`,
    models.map((model) => ({
      id: key(model.provider, model.id),
      label: key(model.provider, model.id),
      detail: model.name,
      tags: [
        ...(key(model.provider, model.id) === now
          ? [{ text: "current", tone: "accent" as const }]
          : []),
        ...(key(model.provider, model.id) === fallback
          ? [{ text: "default", tone: "green" as const }]
          : []),
      ],
    })),
    alternate,
    search.trim(),
  );
  const model = models.find((each) => key(each.provider, each.id) === picked?.id);
  if (picked === undefined || model === undefined) return;
  await apply(
    { model: { provider: model.provider, modelId: model.id } },
    picked.alternate,
    `model · ${picked.id}`,
  );
}

/** A roots panel action; its outcome shows in the panel, which hides the transcript. */
async function rootAction(run: () => Promise<string | undefined>): Promise<void> {
  try {
    const text = await run();
    if (text !== undefined) rootsMessage.value = { text, failed: false };
  } catch (error) {
    rootsMessage.value = {
      text: error instanceof Error ? error.message : String(error),
      failed: true,
    };
  }
}

/** `/roots new`: start a root and show it; it names itself from its first message. */
export function newRoot(): Promise<void> {
  return rootAction(async () => {
    await switchRoot(await client().createRoot(crypto.randomUUID()));
    return undefined;
  });
}

/** Name a root, asking for the label in place of the editor; an empty one names it from its next message again. */
export function renameRoot(id: string): Promise<void> {
  return rootAction(async () => {
    const label = await prompted(
      `Rename root ${id} · empty: name it from its next message · Esc cancels`,
      false,
      new AbortController().signal,
      roots.value.find((each) => each.named && each.id === id)?.label,
    ).catch(() => undefined);
    if (label === undefined) return undefined;
    await client().renameRoot(id, label.trim());
    return label.trim() === ""
      ? `root ${id} · named by its next message`
      : `root ${id} · ${label.trim()}`;
  });
}

/** Archive or unarchive a root; the core refuses while it works, and that reason shows as it is. */
export function archiveRoot(id: string, archived: boolean): Promise<void> {
  return rootAction(async () => {
    await client().archiveRoot(id, archived);
    return archived ? `archived · ${id} · show archived to find it again` : `unarchived · ${id}`;
  });
}

/** `/roots`: the panel, or one of its actions by id prefix; the shown root when none is given. */
async function runRoots(command: RootsCommand): Promise<void> {
  const id = rootId.value;
  switch (command.kind) {
    case "list":
      return toggleRoots(true);
    case "new":
      return await switchRoot(await client().createRoot(crypto.randomUUID()));
    case "switch":
      return await switchRoot(await client().findRoot(command.prefix));
    case "rename":
      if (id === undefined) return;
      await client().renameRoot(id, command.label);
      return notice(
        command.label === "" ? "root · named by its next message" : `root · ${command.label}`,
      );
    case "archive": {
      const target = command.prefix === undefined ? id : await client().findRoot(command.prefix);
      if (target === undefined) return;
      await client().archiveRoot(target, command.archived);
      return notice(`${command.archived ? "archived" : "unarchived"} · ${target}`);
    }
  }
}

/** Open or close the roots panel. */
export function toggleRoots(open = panel.value !== "roots"): void {
  batch(() => {
    if (open) panel.value = "roots";
    else if (panel.value === "roots") panel.value = undefined;
    rootsMessage.value = undefined;
  });
}

/** A queued message open in the editor: whose queue, its id, and the draft set aside for it. */
export const editing = signal<{ name: string | undefined; id: number; draft: string } | undefined>(
  undefined,
);
// What a reload of the tab brings back: the draft, or the one set aside while a queued message is open; that one stays
// queued.
effect(() => sessionStorage.setItem("draft", editing.value?.draft ?? draft.value));

/** Changes a still-queued message of the shown conversation; one that already left comes back as a draft. */
export async function editQueued(
  id: number,
  change: QueueChange,
  name = shown.value,
): Promise<void> {
  try {
    if (await root().editQueued(name, id, change)) return;
    notice("that message already left the queue");
    if (change.kind === "text") draft.value = [change.text, draft.value].filter(Boolean).join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The edit is never lost, and never sent twice: it opens again over the queued original.
    if (change.kind === "text" && editing.value === undefined) {
      batch(() => {
        editing.value = { name, id, draft: draft.value };
        draft.value = change.text;
      });
      return notice(`${reason} · the edit is open again; the original is still queued`, "warning");
    }
    notice(reason, "warning");
  }
}

/** Opens a queued message in the editor, setting the draft aside; a worker notice opens only its body. */
export function beginEdit(item: QueuedItem): void {
  batch(() => {
    editing.value = { name: shown.value, id: item.id, draft: draft.value };
    draft.value = parseWorkerNotice(item.text)?.text ?? item.text;
  });
}

/** Leaves a queued message's edit, saving `text` when given; the set-aside draft comes back either way. */
export function endEdit(text?: string): void {
  const current = editing.value;
  if (current === undefined) return;
  batch(() => {
    editing.value = undefined;
    draft.value = current.draft;
  });
  if (text !== undefined) void editQueued(current.id, { kind: "text", text }, current.name);
}

/** Alt+S: the busy mode new messages take. */
export function toggleMode(): void {
  mode.value = mode.value === "steer" ? "followUp" : "steer";
}

/** Esc: cancel a login in progress, else stop the shown front's run, putting the user's queued messages back in the editor. */
export async function interrupt(): Promise<void> {
  if (login !== undefined) return cancelLogin();
  if (shown.value !== undefined) return;
  const state = view(undefined)?.value;
  if (state === undefined || !presentation(state).busy) return;
  const restored = await root().abort();
  if (restored.length > 0) draft.value = [...restored, draft.value].filter(Boolean).join("\n");
  notice("stopped · root");
}

/** Stores a file the user attaches, for the next message. */
export function attachFile(name: string, data: Uint8Array): Promise<Attachment> {
  return root().attach(name, data);
}

/** The text of a failed send was edited or cleared: whatever is sent next is a new message. */
export function forgetRetry(): void {
  sessionStorage.removeItem("retry");
}

/**
 * One editor submission: a message, a skill, or a command, as the terminal handles it. Resolves `sent` once a message
 * or an answer carried `attachments` (files alone make a message, and with another command they wait for the next one), `failed` when it
 * didn't go, so the editor takes the text back.
 */
export async function submit(
  raw: string,
  attachments: readonly Attachment[] = [],
): Promise<"sent" | "done" | "failed"> {
  // A message that failed may have reached the core all the same (its answer lost with the link): sent again as it was,
  // it keeps its request id, so the core takes it once.
  const failed = sessionStorage.getItem("retry");
  const requestId = failed?.startsWith(`${raw}\u0000`)
    ? failed.slice(raw.length + 1)
    : crypto.randomUUID();
  sessionStorage.setItem("retry", `${raw}\u0000${requestId}`);
  try {
    const input =
      raw.trim() || attachments.length === 0
        ? parseInput(raw)
        : { command: "message" as const, text: "" };
    if (input === undefined) return "done";
    const sent = (await runInput(input, attachments, requestId)) === true;
    sessionStorage.removeItem("retry");
    return sent ? "sent" : "done";
  } catch (error) {
    notice(
      `${error instanceof Error ? error.message : String(error)} · back in the editor`,
      "warning",
    );
    return "failed";
  }
}

/** Context used as a percent, colored as the status bar's meter: yellow past 70, red past 90; `?%` while unknown. */
function contextTag(tokens: number | undefined, model: string | undefined) {
  const slash = model?.indexOf("/") ?? -1;
  const window =
    model === undefined || slash < 0
      ? undefined
      : client().model({ provider: model.slice(0, slash), modelId: model.slice(slash + 1) })
          ?.contextWindow;
  if (window === undefined) return [];
  // Unknown until a reply measures it, as after a compaction or /new.
  if (tokens === undefined) return [{ text: "?%", tone: "muted" as const }];
  const fill = tokens / window;
  const tone: Tone | undefined = fill > 0.9 ? "red" : fill > 0.7 ? "yellow" : undefined;
  return [{ text: `${Math.round(fill * 100)}%`, ...(tone === undefined ? {} : { tone }) }];
}

/** `/agents`: the root and each worker, working ones first, with its state, idle time, context and model. */
function agentRows(): MenuItem[] {
  const status = (busy: boolean, at: number | undefined) =>
    busy
      ? { text: "● working", tone: "accent" as const }
      : { text: `○ idle${at === undefined ? "" : ` ${age(at)}`}`, tone: "muted" as const };
  const here = (name: string | undefined) =>
    shown.value === name ? [{ text: "shown", tone: "green" as const }] : [];
  const front = view(undefined)?.value;
  const live = front === undefined ? undefined : presentation(front);
  const rootModel = live?.provider === undefined ? undefined : `${live.provider}/${live.model}`;
  return [
    {
      id: "",
      label: "root",
      tags: [
        status(live?.busy === true, front === undefined ? undefined : lastActive(front)),
        ...contextTag(front === undefined ? undefined : contextUsage(front).context, rootModel),
        ...here(undefined),
      ],
      detail: [rootModel, live?.thinkingLevel].filter(Boolean).join(" "),
    },
    ...workers.value
      .toSorted((x, y) => Number(y.busy) - Number(x.busy))
      .map((worker) => ({
        id: worker.name,
        label: worker.name,
        tags: [
          status(worker.busy, worker.activeAt),
          ...contextTag(worker.contextTokens, worker.model),
          ...here(worker.name),
        ],
        detail: [worker.model, worker.thinking].filter(Boolean).join(" "),
      })),
  ];
}

/** Runs one parsed submission; true when a message went. */
async function runInput(
  input: NonNullable<ReturnType<typeof parseInput>>,
  attachments: readonly Attachment[],
  requestId: string,
): Promise<boolean | void> {
  const name = shown.value;
  switch (input.command) {
    case "message":
    case "skill": {
      following.value++;
      const text =
        input.command === "skill" ? await client().skillInput(input.name, input.text) : input.text;
      if (name === undefined) await root().submit(text, requestId, mode.value, attachments);
      else await root().messageWorker(name, text, requestId, mode.value, attachments);
      notice(`received · ${name ?? "root"}`);
      return true;
    }
    case "/attach": {
      if (input.text !== "clear") {
        openPicker();
        break;
      }
      const count = clearPending();
      notice(count ? `dropped ${count} attachment${count === 1 ? "" : "s"}` : "nothing attached");
      break;
    }
    case "/roots":
      return await runRoots(parseRootsCommand(input.text));
    case "/help":
      return notice(helpText("web", client().commands()));
    case "/quit":
      return notice("close the tab to quit; Monchu keeps running");
    case "/agents":
      if (input.text) return await show(input.text === "root" ? undefined : input.text);
      {
        await refreshWorkers();
        const picked = await pick("Agents", agentRows());
        if (picked !== undefined) await show(picked.id || undefined);
      }
      return;
    case "/stop":
      if (input.text || name !== undefined) {
        const worker = input.text || name || "";
        await root().stopWorker(worker);
        return notice(`stopped · ${worker}`);
      }
      return await interrupt();
    case "/new":
      await root().reset(input.text || undefined);
      return notice("new context · root");
    case "/answer":
      following.value++;
      await root().answer(input.id, input.text, requestId, mode.value, attachments);
      notice(`answered · ${input.id}`);
      return true;
    case "/compact":
      await root().compact(input.text || undefined);
      return notice("compacting · root");
    case "/cd":
      return notice(`cwd · ${await root().changeDirectory(input.text, name)}`);
    case "/reload":
      return notice(`reloaded · ${(await client().reload()).join(", ")}`);
    case "/restart":
      await client().restart();
      return notice("restart requested · reconnects when Monchu is back");
    case "/update":
      await client().update(input.text);
      return notice(
        `installing ${input.text} · reconnects when Monchu is back, on it or on this version if npm fails`,
      );
    case "/jobs":
      panel.value = "jobs";
      return;
    case "/goals":
      panel.value = "goals";
      return;
    case "/queue": {
      const state = view(name)?.value;
      const queue = state === undefined ? [] : presentation(state).queue;
      return notice(
        queue.length === 0
          ? "queue · empty"
          : [
              `queue · ${queue.length}`,
              ...queue.map((item) => `${item.mode} · ${item.text.split("\n")[0] ?? ""}`),
            ].join("\n"),
      );
    }
    case "/logs": {
      const records = await client().logs(logQuery(input.text));
      return notice(
        records.length === 0
          ? "logs · nothing yet"
          : [`logs · ${records.length}`, ...records.map(formatRecord)].join("\n"),
      );
    }
    case "plugin":
      return notice(await root().command(input.name, input.text, name));
    case "/login":
      return await runLogin();
    case "/mcp":
      return await runMcp(input.text);
    case "/model":
      return await runModel(false, input.text);
    case "/thinking":
      return await runModel(true, "");
  }
}
