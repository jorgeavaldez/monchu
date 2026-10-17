/**
 * The web client's state: signals the views read, and the actions behind every command. All core access goes through
 * the shared `Client` contract, so the web does what the terminal does, with the same command table.
 */
import { batch, signal, type Signal } from "@preact/signals";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Client, ModelPick, WorkerSummary } from "../api/client.ts";
import type { WhenBusy } from "../api/notices.ts";
import { describeAssessment, formatReports } from "../api/reports.ts";
import { help, LOGIN_PROVIDERS, parseInput } from "../ui/commands.ts";
import { formatJobEvent } from "../ui/jobs.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints, pickTargets } from "../ui/login.ts";
import { presentation } from "../ui/state.ts";

export type Notice = { id: number; at: number; text: string; kind: "system" | "warning" | "event" };

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
/** The editor's text, so a stopped front's queued messages can come back into it. */
export const draft = signal("");

let core: Client | undefined;
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

export function notice(text: string, kind: Notice["kind"] = "system"): void {
  notices.value = [...notices.value, { id: nextNotice++, at: Date.now(), text, kind }].slice(-200);
}

/** The shown conversation's view, attached on first use and kept while the page lives. */
export function view(name: string | undefined): Signal<ConversationView> | undefined {
  return views.value.get(name ?? "")?.state;
}

async function attach(name: string | undefined): Promise<void> {
  const key = name ?? "";
  if (views.value.has(key)) return;
  const attached = await client().viewState(name);
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
  workers.value = await client().workers();
}

/** Bind to a connected client: attach the root, follow reports, assessments and job events. */
export async function start(connected: Client): Promise<void> {
  core = connected;
  // The terminal's first screen: the header, the core's startup notes, then what still needs a login.
  notice(`Monchu · /help · home ${connected.home}`);
  for (const line of connected.notes) notice(line);
  for (const line of loginHints(await connected.loginNeeds(), true)) notice(line);
  await attach(undefined);
  await refreshWorkers();
  let lastEntry = view(undefined)?.value.entries.at(-1)?.id;
  const root = views.value.get("");
  root?.state.subscribe((value) => {
    const newest = value.entries.at(-1)?.id;
    if (newest === lastEntry) return;
    lastEntry = newest;
    void refreshWorkers().catch(() => {});
  });
  connected.onReport((message) => notice(message, "warning"));
  const shownAssessments = new Set<number>();
  let hydrated = false;
  await connected.watchAssessments((items) => {
    for (const item of items) {
      if (item.result === null || shownAssessments.has(item.taskId)) continue;
      shownAssessments.add(item.taskId);
      if (hydrated) notice(`clef · ${describeAssessment(item.result)}`, "event");
    }
    hydrated = true;
  });
  await connected.watchJobEvents((await connected.jobs()).nextEvent - 1, (events) => {
    for (const event of events) notice(formatJobEvent(event), "event");
  });
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
      : await client().modelChoice(target.name);
  // A role default saves on Enter, so it has no separate save.
  const role = target.kind === "conversation" && target.name !== undefined ? "worker" : "front";
  const alternate = target.kind === "conversation" ? `save as ${role} default` : undefined;
  const apply = async (change: ModelPick, save: boolean, value: string) => {
    if (target.kind === "default") {
      await client().saveDefault(target.role, change);
      return notice(`${name} ${value} · saved`);
    }
    await client().pickModel(change, save, target.name);
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

/** Esc: cancel a login in progress, else stop the shown front's run, putting the user's queued messages back in the editor. */
export async function interrupt(): Promise<void> {
  if (login !== undefined) return cancelLogin();
  if (shown.value !== undefined) return;
  const state = view(undefined)?.value;
  if (state === undefined || !presentation(state).busy) return;
  const restored = await client().abort();
  if (restored.length > 0) draft.value = [...restored, draft.value].filter(Boolean).join("\n");
  notice("stopped · root");
}

/** One editor submission: a message, a skill, or a command, as the terminal handles it. */
export async function submit(raw: string): Promise<void> {
  let input;
  try {
    input = parseInput(raw);
  } catch (error) {
    return notice(error instanceof Error ? error.message : String(error), "warning");
  }
  if (input === undefined) return;
  const name = shown.value;
  try {
    switch (input.command) {
      case "message":
      case "skill": {
        const text =
          input.command === "skill"
            ? await client().skillInput(input.name, input.text)
            : input.text;
        if (name === undefined) await client().submit(text, crypto.randomUUID(), mode.value);
        else await client().messageWorker(name, text, crypto.randomUUID(), mode.value);
        return notice(`received · ${name ?? "root"}`);
      }
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
          await client().stopWorker(worker);
          return notice(`stopped · ${worker}`);
        }
        return await interrupt();
      case "/new":
        await client().reset(input.text || undefined);
        return notice("new context · root");
      case "/compact":
        await client().compact(input.text || undefined);
        return notice("compacting · root");
      case "/cd":
        return notice(`cwd · ${await client().changeDirectory(input.text, name)}`);
      case "/reload":
        return notice(`reloaded · ${(await client().reload()).join(", ")}`);
      case "/restart":
        await client().restart();
        return notice("restart requested · reconnects when Monchu is back");
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
        const goals = await client().goals();
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
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), "warning");
  }
}

/** Connection changes, as the shell shows them. */
export function connected(state: "open" | "lost" | "gone"): void {
  batch(() => {
    connection.value = state;
  });
}
