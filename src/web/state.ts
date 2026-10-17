/**
 * The web client's state: signals the views read, and the actions behind every command. All core access goes through
 * the shared `Client` contract, so the web does what the terminal does, with the same command table.
 */
import { batch, signal, type Signal } from "@preact/signals";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Attachment } from "../api/attachments.ts";
import type {
  Client,
  ModelPick,
  QueueChange,
  RootClient,
  RootSummary,
  WorkerSummary,
} from "../api/client.ts";
import { parseWorkerNotice, type WhenBusy } from "../api/notices.ts";
import { shortId } from "../api/ids.ts";
import { assessmentNotice, formatReports, routingText } from "../api/reports.ts";
import { releaseNotices } from "../api/release.ts";
import { help, LOGIN_PROVIDERS, parseInput } from "../ui/commands.ts";
import { formatJobEvent } from "../ui/jobs.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints, pickTargets } from "../ui/login.ts";
import { parseRootsCommand, rootLabel, type RootsCommand } from "../ui/roots.ts";
import { presentation, type QueuedItem } from "../ui/state.ts";
import { clearPending, openPicker } from "./attachments.tsx";

/** A line under the transcript; one with a `root` shows only while that root is shown. */
export type Notice = {
  id: number;
  at: number;
  text: string;
  kind: "system" | "warning" | "event";
  root?: string;
  /** Per attached conversation, the newest entry it showed when this was posted (-1 for none); it follows that entry. */
  after: ReadonlyMap<ConversationView["conversation"]["id"], number>;
};

/** A choice the user makes in place of the editor: a login prompt, a model, a thinking level, a worker. */
export type Choice = {
  title: string;
  options: { id: string; label: string; detail?: string }[];
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

export const connection = signal<"connecting" | "open" | "lost" | "gone">("connecting");
/** Every root, archived ones included, as the core reports them. */
export const roots = signal<readonly RootSummary[]>([]);
/** The root this page shows, by full id. */
export const rootId = signal<string | undefined>(undefined);
/** Whether the roots panel is open in place of the transcript, and its last outcome. */
export const rootsOpen = signal(false);
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
/** Bumped when the user sends a message, so the transcript goes back to its end and follows it. */
export const following = signal(0);
/** The editor's text, so a stopped front's queued messages can come back into it. */
export const draft = signal("");

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
function root(): RootClient {
  if (current === undefined) throw new Error("Not connected");
  return current;
}

/** A notice about the shown root, or with `home` one every root shows. */
export function notice(text: string, kind: Notice["kind"] = "system", home = false): void {
  rootNotice(text, kind, home ? undefined : rootId.value);
}

/** A notice that only `root` shows, or every root when undefined. */
function rootNotice(text: string, kind: Notice["kind"], root: string | undefined): void {
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
  const front = views.value.get("");
  if (front !== undefined)
    unbind.push(
      front.state.subscribe((value) => {
        const newest = value.entries.at(-1)?.id;
        if (newest === lastEntry) return;
        lastEntry = newest;
        void refreshWorkers().catch(() => {});
      }),
    );
  const shownAssessments = new Set<number>();
  const seen: { failure?: string } = {};
  let hydrated = false;
  const stopAssessments = await from.watchAssessments((items) => {
    for (const item of items) {
      if (item.result === null || shownAssessments.has(item.taskId)) continue;
      shownAssessments.add(item.taskId);
      const text = hydrated ? assessmentNotice(item.result, seen) : undefined;
      if (text !== undefined) notice(text, "event");
    }
    hydrated = true;
  });
  if (from !== current) return stopAssessments();
  unbind.push(stopAssessments);
  const routing = await from.routing();
  if (routing.paused && from === current) notice(routingText(routing), "event");
}

/** Show another root from the panel or a command, saying which one it is. */
export async function switchRoot(id: string): Promise<void> {
  rootsOpen.value = false;
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
  for (const line of loginHints(await connected.loginNeeds(), true)) notice(line);
  await connected.watchRoots((list) => {
    roots.value = list;
  });
  await openRoot(await initialRoot(connected));
  // Back and Forward move between the roots this tab showed.
  addEventListener("popstate", () => {
    const id = new URL(location.href).searchParams.get("root");
    if (id !== null && id !== rootId.value) void openRoot(id).catch(reportFailure);
  });
  connected.onReport((message) => notice(message, "warning", true));
  await connected.watchJobEvents((await connected.jobs()).nextEvent - 1, (events) => {
    // Each job event shows in its own root; an event from before roots belongs to the first.
    const first = roots.value.reduce<RootSummary | undefined>(
      (oldest, each) => (oldest === undefined || each.createdAt < oldest.createdAt ? each : oldest),
      undefined,
    );
    for (const event of events)
      rootNotice(
        formatJobEvent(event),
        "event",
        event.rootId === undefined ? first?.id : shortId(event.rootId),
      );
  });
}

function reportFailure(error: unknown): void {
  notice(error instanceof Error ? error.message : String(error), "warning");
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
): Promise<{ id: string; alternate: boolean } | undefined> {
  return new Promise((resolve) => {
    choice.value = {
      title,
      options,
      ...(alternate === undefined ? {} : { alternate }),
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
    const picked = await pick(
      "Choose provider:",
      LOGIN_PROVIDERS.map(({ id, label }) => ({ id, label })),
    );
    if (picked === undefined) return;
    loginStatus.value = { message: "Starting…" };
    await client().login(picked.id, picked.id === "cloudflare-workers-ai" ? "api_key" : "oauth", {
      signal: controller.signal,
      prompt: (request) => answerPrompt(request, controller.signal),
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
  }
  // As in the terminal: what still needs a login, once this one is done.
  if (loggedIn) for (const line of loginHints(await client().loginNeeds(), false)) notice(line);
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
    loginStatus.value = { message: "Starting…" };
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

/** `/model` and `/thinking`: first what to change, as the terminal asks, then the pick; Ctrl+S saves a role default. */
async function runModel(thinking: boolean, search: string): Promise<void> {
  await refreshWorkers();
  const targets = pickTargets(
    shown.value,
    workers.value.map((worker) => worker.name),
  );
  const which = await pick(
    thinking ? "Pick the thinking level of" : "Pick the model of",
    targets.map(({ label, description }) => ({ id: label, label, detail: description })),
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
      current.thinkingLevels.map((level) => ({ id: level, label: level })),
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
  // The current model first and the role default second, as the terminal lists them.
  const models = current.models
    .filter((model) =>
      `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(search.toLowerCase()),
    )
    .toSorted((x, y) => {
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
      detail: `${model.name}${key(model.provider, model.id) === now ? " · current" : ""}${key(model.provider, model.id) === fallback ? " · default" : ""}`,
    })),
    alternate,
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
export function toggleRoots(open = !rootsOpen.value): void {
  batch(() => {
    rootsOpen.value = open;
    rootsMessage.value = undefined;
  });
}

/** A queued message open in the editor: whose queue, its id, and the draft set aside for it. */
export const editing = signal<{ name: string | undefined; id: number; draft: string } | undefined>(
  undefined,
);

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
    notice(error instanceof Error ? error.message : String(error), "warning");
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

/**
 * One editor submission: a message, a skill, or a command, as the terminal handles it. Resolves true once a message
 * carried `attachments`; files alone make a message, and with a command they wait for the next one.
 */
export async function submit(
  raw: string,
  attachments: readonly Attachment[] = [],
): Promise<boolean> {
  let input;
  try {
    input =
      raw.trim() || attachments.length === 0
        ? parseInput(raw)
        : { command: "message" as const, text: "" };
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), "warning");
    return false;
  }
  if (input === undefined) return false;
  try {
    return (await runInput(input, attachments)) === true;
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), "warning");
    return false;
  }
}

/** Runs one parsed submission; true when a message went. */
async function runInput(
  input: NonNullable<ReturnType<typeof parseInput>>,
  attachments: readonly Attachment[],
): Promise<boolean | void> {
  const name = shown.value;
  switch (input.command) {
    case "message":
    case "skill": {
      following.value++;
      const text =
        input.command === "skill" ? await client().skillInput(input.name, input.text) : input.text;
      if (name === undefined)
        await root().submit(text, crypto.randomUUID(), mode.value, attachments);
      else await root().messageWorker(name, text, crypto.randomUUID(), mode.value, attachments);
      notice(`received · ${name ?? "root"}`);
      return true;
    }
    case "/attach":
      openPicker();
      break;
    case "/detach": {
      const count = clearPending();
      notice(count ? `dropped ${count} attachment${count === 1 ? "" : "s"}` : "nothing attached");
      break;
    }
    case "/roots":
      return await runRoots(parseRootsCommand(input.text));
    case "/help":
      return notice(help);
    case "/quit":
      return notice("close the tab to quit; Monchu keeps running");
    case "/agents":
      if (input.text) return await show(input.text === "root" ? undefined : input.text);
      {
        await refreshWorkers();
        const picked = await pick("Show", [
          { id: "", label: "root" },
          ...workers.value.map((worker) => ({
            id: worker.name,
            label: worker.name,
            detail: `${worker.busy ? "working" : "idle"}${worker.model === undefined ? "" : ` · ${worker.model}`}`,
          })),
        ]);
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
    case "/compact":
      await root().compact(input.text || undefined);
      return notice("compacting · root");
    case "/cd":
      return notice(`cwd · ${await root().changeDirectory(input.text, name)}`);
    case "/reload":
      return notice(`reloaded · ${(await client().reload()).join(", ")}`);
    case "/clef":
      return notice(
        routingText(await root().routing(input.text === "" ? undefined : input.text === "off")),
      );
    case "/restart":
      await client().restart();
      return notice("restart requested · reconnects when Monchu is back");
    case "/update":
      await client().update(input.text);
      return notice(
        `installing ${input.text} · reconnects when Monchu is back, on it or on this version if npm fails`,
      );
    case "/jobs": {
      const { jobs, events, listing } = await client().jobs();
      return notice(
        [
          `jobs · ${jobs.length}`,
          listing,
          ...(events.length === 0 ? [] : ["recent:", ...events.slice(-8).map(formatJobEvent)]),
        ].join("\n"),
      );
    }
    case "/goals": {
      const goals = await root().goals();
      const open = goals.filter((goal) => goal.status === "active" || goal.status === "waiting");
      return notice(
        open.length === 0
          ? "goals · none open"
          : [
              `goals · ${open.length}`,
              ...open.map(
                (goal) =>
                  `${goal.changed ? "• " : "  "}${goal.status} ${goal.id} · ${goal.title}\n    now: ${goal.workstream}\n    next: ${goal.next}`,
              ),
            ].join("\n"),
      );
    }
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

/** Connection changes, as the shell shows them. */
export function connected(state: "open" | "lost" | "gone"): void {
  batch(() => {
    connection.value = state;
  });
}
