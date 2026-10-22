/**
 * What the person can do on the page: send, run a command, sign in, pick a model, manage roots and drafts. An intent
 * about the shown root captures it as it starts (`showing()`) and carries it through: what it sends goes to that
 * root, and what comes back after the page moved on changes nothing on the page. Only `commands.ts`, the page's one
 * executor, calls these; every other module runs an action there.
 */
import { batch } from "@preact/signals";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { Attachment } from "../api/attachments.ts";
import type { ModelPick, QueueChange } from "../api/client.ts";
import { parseWorkerNotice } from "../api/notices.ts";
import { randomId } from "../api/ids.ts";
import { formatReports } from "../api/reports.ts";
import { helpText, loginProviders, parseInput } from "../ui/commands.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints, pickTargets } from "../ui/login.ts";
import { parseRootsCommand, rootLabel, type RootsCommand } from "../ui/roots.ts";
import { age, contextUsage, lastActive, presentation, type QueuedItem } from "../ui/state.ts";
import { clearPending, openPicker } from "./attachments.tsx";
import type { MenuItem, Tone } from "./menu.tsx";
import type { Showing } from "./showing.ts";
import {
  ask,
  choice,
  client,
  draft,
  editing,
  escapeLeaves,
  expandAll,
  forgetRetry,
  type Filter,
  loginStatus,
  MCP_CALLBACK,
  mode,
  notice,
  openRoot,
  panel,
  pick,
  pins,
  prompted,
  promptDrafts,
  rootId,
  roots,
  typeInEditor,
} from "./state.ts";
// oxlint-disable-next-line no-restricted-imports -- intents are what writes the page's state.
import { page, showing } from "./state.ts";

let login: AbortController | undefined;

/** The root whose queued message is open in the editor: its edit saves there, wherever the page is by then. */
let editingAt: Showing | undefined;

/** Whether a login or MCP sign-in is under way, which Esc and stop cancel first. */
export const loggingIn = (): boolean => login !== undefined;

/**
 * Begin a slash command in the prompt. Where Esc leaves the prompt (a key plugin's modes), it begins like vim's `:`:
 * the draft is set aside, and Esc gives it back with focus.
 */
export function startCommandLine(): void {
  const area = document.querySelector(".editor textarea");
  if (escapeLeaves.value)
    page.commandLine.value = { draft: draft.value, fromPrompt: document.activeElement === area };
  page.draft.value = "/";
  typeInEditor();
}

/** Send what the editor holds; what didn't go comes back to it, never lost. */
export async function send(text: string, attachments: readonly Attachment[]): Promise<void> {
  const outcome = await submit(text, attachments);
  if (outcome === "sent") clearPending();
  if (outcome !== "failed") return;
  // Ahead of anything typed since (then it's a new message).
  if (draft.value !== "") forgetRetry();
  page.draft.value = [text, draft.value].filter(Boolean).join("\n");
}

/** Show another root from the panel or a command, saying which one it is. */
export async function switchRoot(id: string): Promise<void> {
  if (panel.value === "roots") page.panel.value = undefined;
  if (id === rootId.value) return;
  await openRoot(id, true);
  const summary = roots.value.find((each) => each.id === id);
  // Said in the root it names, unless another was shown meanwhile.
  if (rootId.value === id)
    notice(`root · ${id}${summary === undefined ? "" : ` · ${rootLabel(summary)}`}`);
}

/** Open or close every card, including the ones opened or closed by hand. */
export function toggleExpandAll(): void {
  batch(() => {
    page.expandAll.value = !expandAll.value;
    page.expandPresses.value++;
  });
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

function reportFailure(error: unknown): void {
  notice(failure(error), "warning");
}

/** Filter the stream to one goal's messages, picked from the root's goals; none shows every goal's. */
export async function pickGoal(): Promise<void> {
  const at = showing();
  try {
    await at.refreshGoals();
  } catch (error) {
    return at.notice(failure(error), "warning");
  }
  // A pick opens on the page shown, so it opens only while the root it is about is.
  if (!at.open) return;
  const picked = await pick("Goal", [
    { id: "", label: "every goal" },
    ...at.goals.value.map((goal) => ({ id: goal.id, label: goal.title, detail: goal.status })),
  ]);
  if (picked === undefined) return;
  const { goal: _goal, ...rest } = at.filter.value;
  at.filter.value = picked.id ? { ...rest, goal: picked.id } : rest;
}

/** Show only one kind of the front's messages, or every kind; the goal filter stays. */
export function filterKind(kind: Filter["kind"]): void {
  const at = showing();
  const { kind: _kind, ...rest } = at.filter.value;
  at.filter.value = kind === undefined ? rest : { ...rest, kind };
}

/** Show the front's whole stream: every kind, every goal. */
export function clearFilter(): void {
  showing().filter.value = {};
}

/** Start a reply to a message by its id in the editor, keeping what was typed after an earlier one, and type there. */
export function replyDraft(code: string): void {
  page.draft.value = `/reply ${code} ${draft.value.replace(/^\/reply \S+ ?/, "")}`;
  typeInEditor();
}

/**
 * Pin a message of the conversation shown by its id, or unpin it when it is pinned: the star on it shows which. A pin
 * keeps a copy of the message in this device's pins, from every client.
 */
export async function togglePin(code: string): Promise<void> {
  const at = showing();
  try {
    if (pins.value.some((pin) => pin.code === code)) await client().unpinMessage(code);
    else await at.root.pinMessage(code, at.shown.value);
  } catch (error) {
    at.notice(failure(error), "warning");
  }
}

/** Unpin a message: from the pins panel, whatever is shown. */
export async function unpin(code: string): Promise<void> {
  try {
    await client().unpinMessage(code);
  } catch (error) {
    notice(failure(error), "warning");
  }
}

/** A prompt on one line: its whitespace and line breaks as single spaces, cut at a word with … past `width`. */
function oneLine(text: string, width = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= width) return line;
  const cut = line.slice(0, width);
  const space = cut.lastIndexOf(" ");
  return `${space > width / 2 ? cut.slice(0, space) : cut}…`;
}

/** The draft key: save what is typed, or restore one; with nothing typed it goes straight to restore. */
export async function openDrafts(): Promise<void> {
  try {
    const text = draft.value;
    if (text.trim() !== "") {
      const count = promptDrafts.value.length;
      const picked = await pick("Draft", [
        { id: "save", label: "save", detail: oneLine(text) },
        { id: "restore", label: "restore", detail: `${count} saved` },
      ]);
      if (picked === undefined) return;
      if (picked.id === "save") {
        await client().saveDraft(text);
        if (draft.value === text) page.draft.value = "";
        notice("draft saved");
        return;
      }
    }
    await restoreDraft();
  } catch (error) {
    reportFailure(error);
  }
}

/** Pick a draft, newest first, typing to filter; it fills the editor and leaves the list. Esc keeps what was typed. */
async function restoreDraft(): Promise<void> {
  if (promptDrafts.value.length === 0) return notice("no drafts", "warning");
  const picked = await pick(
    "Restore a draft",
    promptDrafts.value.toReversed().map((each) => ({
      id: String(each.id),
      // The label column is half the editor's width: a 14 px monospace character is about 8.4 px.
      label: oneLine(
        each.text,
        Math.floor((document.querySelector("textarea")?.clientWidth ?? 0) / 17) - 2,
      ),
      detail: `${age(each.at)} ago`,
    })),
  );
  if (picked === undefined) return;
  const typed = draft.value;
  const text = await client().takeDraft(Number(picked.id));
  // What was typed is set aside in its place, never lost.
  if (typed.trim() !== "") await client().saveDraft(typed);
  page.draft.value = text;
  typeInEditor();
}

/** Show the front (undefined) or a worker's conversation of the shown root. */
export async function show(name: string | undefined): Promise<void> {
  const at = showing();
  try {
    await at.attach(name);
  } catch (error) {
    return at.notice(failure(error), "warning");
  }
  at.shown.value = name;
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
      undefined,
      undefined,
      { requested: true, signal },
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
      page.loginStatus.value = {
        message: "Open the page and enter the code · Esc cancels",
        url: event.verificationUri,
        code: event.userCode,
      };
      break;
    case "auth_url":
      page.loginStatus.value = { message: "Sign in on the page · Esc cancels", url: event.url };
      break;
    case "info":
    case "progress":
      // Provider output stays out of notices and history.
      page.loginStatus.value = { message: event.message };
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
    page.loginStatus.value = starting;
    const auth = providers.find((entry) => entry.id === picked.id)?.auth ?? "oauth";
    await client().login(picked.id, auth, {
      signal: controller.signal,
      // Closing a prompt cancels the login it asks for.
      prompt: (request) => {
        // The prompt says what happens now; a provider's status (a sign-in page) stays.
        if (loginStatus.value === starting) page.loginStatus.value = undefined;
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
    page.loginStatus.value = undefined;
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
  if (action === "enable" || action === "disable") {
    const enable = action === "enable";
    let name = server;
    if (!name) {
      const { servers } = await client().mcpServers();
      const picked = await pick(
        `Turn ${enable ? "on" : "off"} on this device`,
        servers
          .filter((each) => each.enabled !== enable)
          .map((each) => ({ id: each.name, label: each.name, detail: each.transport })),
      );
      if (picked === undefined) return;
      name = picked.id;
    }
    return notice(`mcp · ${await client().mcpSetEnabled(name, enable)}`);
  }
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
    page.loginStatus.value = starting;
    const message = await client().mcpLogin(
      name,
      {
        showAuthorizationUrl: (url) => loginEvent({ type: "auth_url", url }),
        // The sign-in comes back to this server's own page, which hands it here (main.tsx); pasting it still works.
        redirectUrl: location.origin + MCP_CALLBACK,
        promptForRedirectUrl: (signal) =>
          new Promise((resolve) => {
            const channel = new BroadcastChannel(MCP_CALLBACK);
            signal.addEventListener("abort", () => channel.close());
            channel.onmessage = ({ data }) => resolve(String(data));
            prompted("Or paste the URL the sign-in page went to", false, signal).then(resolve, () =>
              resolve(undefined),
            );
          }),
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
    page.loginStatus.value = undefined;
    // The paste box still open belongs to a sign-in that is over.
    controller.abort();
  }
}

/** `/model` and `/thinking`: first what to change, as the terminal asks, then the pick; Shift+Enter or the toggle saves a role default. */
async function runModel(thinking: boolean, search: string): Promise<void> {
  const at = showing();
  await at.refreshWorkers();
  // Each pick opens only while the root it is about is still shown.
  if (!at.open) return;
  const targets = pickTargets(
    at.shown.value,
    at.workers.value.map((worker) => worker.name),
  );
  const which = await pick(
    thinking ? "Pick the thinking level of" : "Pick the model of",
    // The terminal's Ctrl+S is Shift+Enter or the toggle under the next list here.
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
      : await at.root.modelChoice(target.name);
  if (!at.open) return;
  // A role default saves on Enter, so it has no separate save.
  const role = target.kind === "conversation" && target.name !== undefined ? "worker" : "front";
  const alternate = target.kind === "conversation" ? `save as ${role} default` : undefined;
  const apply = async (change: ModelPick, save: boolean, value: string) => {
    if (target.kind === "default") {
      await client().saveDefault(target.role, change);
      return at.notice(`${name} ${value} · saved`);
    }
    await at.root.pickModel(change, save, target.name);
    at.notice(`${name} ${value} · ${save ? `saved as ${role} default` : "this conversation only"}`);
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
    return at.notice("no models with credentials yet · /login first", "warning");
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
    if (text !== undefined) page.rootsMessage.value = { text, failed: false };
  } catch (error) {
    page.rootsMessage.value = {
      text: error instanceof Error ? error.message : String(error),
      failed: true,
    };
  }
}

/** `/roots new`: start a root and show it; it names itself from its first message. */
export function newRoot(): Promise<void> {
  return rootAction(async () => {
    await switchRoot(await client().createRoot(randomId()));
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
      false,
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
  const at = showing();
  const id = at.id;
  switch (command.kind) {
    case "list":
      return toggleRoots(true);
    case "new":
      return await switchRoot(await client().createRoot(randomId()));
    case "switch":
      return await switchRoot(await client().findRoot(command.prefix));
    case "rename":
      await client().renameRoot(id, command.label);
      return at.notice(
        command.label === "" ? "root · named by its next message" : `root · ${command.label}`,
      );
    case "archive": {
      const target = command.prefix === undefined ? id : await client().findRoot(command.prefix);
      await client().archiveRoot(target, command.archived);
      return at.notice(`${command.archived ? "archived" : "unarchived"} · ${target}`);
    }
  }
}

/** Open or close the roots panel. */
export function toggleRoots(open = panel.value !== "roots"): void {
  batch(() => {
    if (open) page.panel.value = "roots";
    else if (panel.value === "roots") page.panel.value = undefined;
    page.rootsMessage.value = undefined;
  });
}

/** Open the pins panel with an empty filter, or close it: the star in the top bar. */
export function togglePins(open = panel.value !== "pins"): void {
  batch(() => {
    if (open) {
      page.pinsQuery.value = { text: "" };
      page.panel.value = "pins";
    } else if (panel.value === "pins") page.panel.value = undefined;
  });
}

/**
 * Changes a still-queued message of a conversation of `at` (the shown one by default); one that already left comes
 * back as a draft. What the person wrote stays theirs wherever the page went meanwhile.
 */
export async function editQueued(
  id: number,
  change: QueueChange,
  at = showing(),
  name = at.shown.value,
): Promise<void> {
  try {
    if (await at.root.editQueued(name, id, change)) return;
    notice("that message already left the queue");
    if (change.kind === "text")
      page.draft.value = [change.text, draft.value].filter(Boolean).join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The edit is never lost, and never sent twice: it opens again over the queued original.
    if (change.kind === "text" && editing.value === undefined) {
      batch(() => {
        editingAt = at;
        page.editing.value = { name, id, draft: draft.value };
        page.draft.value = change.text;
      });
      return notice(`${reason} · the edit is open again; the original is still queued`, "warning");
    }
    notice(reason, "warning");
  }
}

/** Opens a queued message in the editor, setting the draft aside; a worker notice opens only its body. */
export function beginEdit(item: QueuedItem): void {
  batch(() => {
    const at = showing();
    editingAt = at;
    page.editing.value = { name: at.shown.value, id: item.id, draft: draft.value };
    page.draft.value = parseWorkerNotice(item.text)?.text ?? item.text;
  });
}

/** Leaves a queued message's edit, saving `text` when given; the set-aside draft comes back either way. */
export function endEdit(text?: string): void {
  const current = editing.value;
  const at = editingAt;
  if (current === undefined || at === undefined) return;
  batch(() => {
    page.editing.value = undefined;
    page.draft.value = current.draft;
  });
  if (text !== undefined) void editQueued(current.id, { kind: "text", text }, at, current.name);
}

/** The busy mode new messages take: steer joins a busy run, follow-up waits for it. */
export function toggleMode(): void {
  page.mode.value = mode.value === "steer" ? "followUp" : "steer";
}

/** Esc: cancel a login in progress, else stop the shown front's run, putting the user's queued messages back in the editor. */
export async function interrupt(): Promise<void> {
  if (login !== undefined) return cancelLogin();
  const at = showing();
  if (at.shown.value !== undefined) return;
  const state = at.views.value.get("")?.state.value;
  if (state === undefined || !presentation(state).busy) return;
  let restored: string[];
  try {
    restored = await at.root.abort();
  } catch (error) {
    return at.notice(failure(error), "warning");
  }
  // The person's queued words come back to them wherever the page is now.
  if (restored.length > 0) page.draft.value = [...restored, draft.value].filter(Boolean).join("\n");
  at.notice("stopped · root");
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
  const requestId = failed?.startsWith(`${raw}\u0000`) ? failed.slice(raw.length + 1) : randomId();
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
function agentRows(at: Showing): MenuItem[] {
  const status = (busy: boolean, at: number | undefined) =>
    busy
      ? { text: "● working", tone: "accent" as const }
      : { text: `○ idle${at === undefined ? "" : ` ${age(at)}`}`, tone: "muted" as const };
  const here = (name: string | undefined) =>
    at.shown.value === name ? [{ text: "shown", tone: "green" as const }] : [];
  const front = at.views.value.get("")?.state.value;
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
    ...at.workers.value
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
  // Admitted under the root on screen: it goes there, and says so there, whatever is shown by then.
  const at = showing();
  const name = at.shown.value;
  const when = mode.value;
  switch (input.command) {
    case "message":
    case "skill": {
      page.following.value++;
      const text =
        input.command === "skill" ? await client().skillInput(input.name, input.text) : input.text;
      if (name === undefined) await at.root.submit(text, requestId, when, attachments);
      else await at.root.messageWorker(name, text, requestId, when, attachments);
      at.notice(`received · ${name ?? "root"}`);
      return true;
    }
    case "/attach": {
      if (input.text !== "clear") {
        openPicker();
        break;
      }
      const count = clearPending();
      at.notice(
        count ? `dropped ${count} attachment${count === 1 ? "" : "s"}` : "nothing attached",
      );
      break;
    }
    case "/roots":
      return await runRoots(parseRootsCommand(input.text));
    case "/help":
      return at.notice(helpText("web", client().commands()));
    case "/quit":
      return at.notice("close the tab to quit; Monchu keeps running");
    case "/agents":
      if (input.text) return await show(input.text === "root" ? undefined : input.text);
      {
        await at.refreshWorkers();
        if (!at.open) return;
        const picked = await pick("Agents", agentRows(at));
        if (picked !== undefined && at.open) await show(picked.id || undefined);
      }
      return;
    case "/stop":
      if (input.text || name !== undefined) {
        const worker = input.text || name || "";
        await at.root.stopWorker(worker);
        return at.notice(`stopped · ${worker}`);
      }
      return await interrupt();
    case "/new":
      await at.root.reset(input.text || undefined);
      return at.notice("new context · root");
    case "/reply":
      page.following.value++;
      await at.root.reply(input.id, input.text, requestId, when, attachments);
      at.notice(`replied · ${input.id}`);
      return true;
    case "/compact":
      await at.root.compact(input.text || undefined);
      return at.notice("compacting · root");
    case "/cd":
      return at.notice(`cwd · ${await at.root.changeDirectory(input.text, name)}`);
    case "/reload":
      return at.notice(`reloaded · ${(await client().reload()).join(", ")}`);
    case "/restart":
      await client().restart();
      return at.notice("restart requested · reconnects when Monchu is back");
    case "/update":
      await client().update(input.text);
      return at.notice(
        `installing ${input.text} · reconnects when Monchu is back, on it or on this version if npm fails`,
      );
    case "/jobs":
      page.panel.value = "jobs";
      return;
    case "/goals":
      page.panel.value = "goals";
      return;
    case "/pin": {
      const { pin, existed } = await at.root.pinMessage(input.id, name);
      return at.notice(`${existed ? "already pinned" : "pinned"} · ${pin.code} · ${pin.headline}`);
    }
    case "/pins":
      page.pinsQuery.value = { text: input.text };
      page.panel.value = "pins";
      return;
    case "/queue": {
      const state = at.views.value.get(name ?? "")?.state.value;
      const queue = state === undefined ? [] : presentation(state).queue;
      return at.notice(
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
      return at.notice(
        records.length === 0
          ? "logs · nothing yet"
          : [`logs · ${records.length}`, ...records.map(formatRecord)].join("\n"),
      );
    }
    case "plugin":
      return at.notice(await at.root.command(input.name, input.text, name));
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
