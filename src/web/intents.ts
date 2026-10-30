/**
 * What the person can do on the page: send, run a command, sign in, pick a model, manage roots and drafts. An intent
 * about the shown root captures it as it starts (`showing()`) and carries it through: what it sends goes to that
 * root, and what comes back after the page moved on changes nothing on the page. Only `commands.ts`, the page's one
 * executor, calls these; every other module runs an action there.
 */
import { batch } from "@preact/signals";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { Attachment } from "../api/attachments.ts";
import type { JobControl, ModelPick, PinnedMessage, QueueChange } from "../api/client.ts";
import { parseWorkerNotice, type WhenBusy } from "../api/notices.ts";
import { randomId } from "../api/ids.ts";
import { formatReports } from "../api/reports.ts";
import { helpText, loginProviders, parseInput } from "../ui/commands.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints } from "../ui/login.ts";
import { parseRootsCommand, rootLabel, type RootsCommand } from "../ui/roots.ts";
import { presentation, type QueuedItem } from "../ui/state.ts";
import {
  clearPending,
  hasPending,
  openPicker,
  restorePending,
  sentPending,
  takePending,
  uploaded,
} from "./attachments.tsx";
import { jumpTo } from "./feed.ts";
import type { MenuItem } from "./menu.tsx";
import { sendInOrder } from "./sending.tsx";
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
  pick,
  pins,
  prompted,
  rootId,
  roots,
  sheet,
  openSheet,
  closeSheet,
  typeInEditor,
  workers,
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

/**
 * Send what the editor holds. A message takes the waiting files, uploaded or not, and goes as a row over the editor once
 * they are up and the messages before it went; what didn't go comes back to the editor, files too, never lost.
 */
export async function send(text: string): Promise<void> {
  let outcome: Awaited<ReturnType<typeof submit>>;
  if (!carriesFiles(text)) outcome = await submit(text);
  else {
    // Where it goes is where it was sent from, whatever is shown by the time its files are up.
    let target: Aim | undefined;
    try {
      target = aim();
    } catch {
      // Not connected: the submission says so, and the text and files come back.
    }
    const files = takePending();
    outcome = await sendInOrder(text, files, async () => {
      let attachments: Attachment[];
      try {
        attachments = await uploaded(files);
      } catch (error) {
        notice(`${failure(error)} · back in the editor`, "warning");
        return "failed";
      }
      return await submit(text, attachments, target);
    });
    if (outcome === "sent") sentPending(files);
    else restorePending(files);
  }
  if (outcome !== "failed") return;
  // Ahead of anything typed since (then it's a new message).
  if (draft.value !== "") forgetRetry();
  page.draft.value = [text, draft.value].filter(Boolean).join("\n");
}

/** Whether `text` sends a message, which takes the waiting files: words, a skill or a reply, or nothing but files. */
function carriesFiles(text: string): boolean {
  if (!text.trim()) return hasPending();
  try {
    const command = parseInput(text)?.command;
    return command === "message" || command === "skill" || command === "/reply";
  } catch {
    return false;
  }
}

/** Show another root from the roots menu or a command, saying which one it is. */
export async function switchRoot(id: string): Promise<void> {
  if (sheet.value?.kind === "roots") closeSheet();
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

/** Open the goals menu on the goal followed, its list read afresh; or close it. */
export function toggleGoals(open = sheet.value?.kind !== "goals"): void {
  if (!open) return closeSheet();
  const at = showing();
  openSheet("goals", "", at.filter.value.goal);
  void at.refreshGoals().catch((error: unknown) => at.notice(failure(error), "warning"));
}

/** Follow one goal's stream, from the goals menu: the menu closes, and the goal counts as seen. */
export function followGoal(id: string): void {
  const at = showing();
  closeSheet();
  const { goal: _goal, ...rest } = at.filter.value;
  at.filter.value = { ...rest, goal: id };
  const goal = at.goals.value.find((each) => each.id === id);
  if (goal?.changed !== true) return;
  at.goals.value = at.goals.value.map((each) =>
    each.id === id ? { ...each, changed: false } : each,
  );
  // Read again once seen, so a read that started before can't bring its • back.
  void at.root
    .seeGoal(id, goal.updatedAt)
    .then(() => at.refreshGoals())
    .catch(() => {});
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

/** Open the jobs menu or close it. */
export function toggleJobs(open = sheet.value?.kind !== "jobs"): void {
  if (open) openSheet("jobs");
  else closeSheet();
}

/** Pause, resume or run a job now, from the jobs menu; the menu reads it again on the event it makes. */
export async function controlJob(name: string, action: JobControl): Promise<void> {
  try {
    notice(`jobs · ${await client().controlJob(name, action)}`);
  } catch (error) {
    notice(failure(error), "warning");
  }
}

/** Open the drafts menu (newest first) or close it: the draft key. */
export function toggleDrafts(open = sheet.value?.kind !== "drafts"): void {
  if (open) openSheet("drafts");
  else closeSheet();
}

/** Set what is typed aside as a draft, from the drafts menu; the editor empties and the menu lists it. */
export async function saveDraft(): Promise<void> {
  const text = draft.value;
  if (text.trim() === "") return;
  await client().saveDraft(text);
  if (draft.value === text) page.draft.value = "";
}

/** Restore a draft: it fills the editor and leaves the list; what was typed is set aside in its place, never lost. */
export async function restoreDraft(id: number): Promise<void> {
  closeSheet();
  const typed = draft.value;
  const text = await client().takeDraft(id);
  if (typed.trim() !== "") await client().saveDraft(typed);
  page.draft.value = text;
  typeInEditor();
}

/** Delete a draft: taken out of the list, its text dropped. */
export async function deleteDraft(id: number): Promise<void> {
  await client().takeDraft(id);
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

/** A model's or level's state in its pick: ● the current one, ⌂ the role default. */
function mark(current: boolean, fallback: boolean): Pick<MenuItem, "mark"> {
  if (current)
    return {
      mark: { glyph: "●", tone: "accent", word: fallback ? "current, the default" : "current" },
    };
  return fallback ? { mark: { glyph: "⌂", tone: "muted", word: "default" } } : {};
}

/** `/model` and `/thinking` for the conversation shown; Shift+Enter or the ⌂ toggle also saves its role's default. */
async function runModel(thinking: boolean, search: string): Promise<void> {
  const at = showing();
  const shownName = at.shown.value;
  const name = shownName ?? "root";
  const current = await at.root.modelChoice(shownName);
  // Each pick opens only while the root it is about is still shown.
  if (!at.open) return;
  const role = shownName === undefined ? "front" : "worker";
  const alternate = `save as ${role} default`;
  const apply = async (change: ModelPick, save: boolean, value: string) => {
    await at.root.pickModel(change, save, shownName);
    at.notice(`${name} ${value} · ${save ? `saved as ${role} default` : "this conversation only"}`);
  };
  if (thinking) {
    const picked = await pick(
      `thinking · ${name}`,
      current.thinkingLevels.map((level) => ({
        id: level,
        label: level,
        ...mark(level === current.thinkingLevel, level === current.defaults.thinkingLevel),
      })),
      alternate,
      undefined,
      { class: "model" },
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
    `model · ${name}`,
    models.map((model) => ({
      id: key(model.provider, model.id),
      label: key(model.provider, model.id),
      detail: model.name,
      ...mark(key(model.provider, model.id) === now, key(model.provider, model.id) === fallback),
    })),
    alternate,
    search.trim(),
    { class: "model" },
  );
  const model = models.find((each) => key(each.provider, each.id) === picked?.id);
  if (picked === undefined || model === undefined) return;
  await apply(
    { model: { provider: model.provider, modelId: model.id } },
    picked.alternate,
    `model · ${picked.id}`,
  );
}

/** A root action from the roots menu: the list shows what it did, a refusal (a working root) shows as a warning. */
async function rootAction(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), "warning");
  }
}

/** `/roots new`: start a root and show it; it names itself from its first message. */
export function newRoot(): Promise<void> {
  return rootAction(async () => switchRoot(await client().createRoot(randomId())));
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
    if (label !== undefined) await client().renameRoot(id, label.trim());
  });
}

/** Archive or unarchive a root; the core refuses while it works, and that reason shows as it is. */
export function archiveRoot(id: string, archived: boolean): Promise<void> {
  return rootAction(() => client().archiveRoot(id, archived));
}

/** `/roots`: the menu, or one of its actions by id prefix; the shown root when none is given. */
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

/** Open the roots menu (every open root, the shown one selected) or close it. */
export function toggleRoots(open = sheet.value?.kind !== "roots"): void {
  if (open) openSheet("roots", "", rootId.value);
  else closeSheet();
}

/** Open the pins menu (newest pinned first) or close it: the star in the filter bar. */
export function togglePins(open = sheet.value?.kind !== "pins"): void {
  if (open) openSheet("pins");
  else closeSheet();
}

/** Open the workers menu (the root, then working workers first) or close it: the top bar. */
export function toggleWorkers(open = sheet.value?.kind !== "workers"): void {
  if (!open) return closeSheet();
  openSheet("workers");
  void showing()
    .refreshWorkers()
    .catch(() => {});
}

/**
 * Go to a pinned message: its root, the conversation it came from when it is one of that root's workers (else the
 * front), and the message itself, marked as a search finds it.
 */
export async function goToPin(pin: PinnedMessage): Promise<void> {
  if (pin.root !== rootId.value) await switchRoot(pin.root);
  // Pins from before they kept their conversation go by their sender.
  const from = workers.value.some((worker) => worker.name === pin.from) ? pin.from : undefined;
  await show(pin.worker ?? from);
  requestAnimationFrame(() => (jumpTo.value = { code: pin.code }));
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
  await stopFront(at);
}

/** The workers menu's ■: the root's run, wherever the page is, or a worker's. */
export async function stopOne(name: string | undefined): Promise<void> {
  const at = showing();
  if (name === undefined) return await stopFront(at);
  try {
    await at.root.stopWorker(name);
  } catch (error) {
    return at.notice(failure(error), "warning");
  }
  at.notice(`stopped · ${name}`);
  // The workers menu shows it idle now, not at the front's next entry.
  await at.refreshWorkers().catch(() => {});
}

/** ⏏ or `/close`: retire an idle worker; the page goes back to the root if it showed it. */
export async function closeWorker(name: string): Promise<void> {
  const at = showing();
  try {
    await at.root.closeWorker(name);
  } catch (error) {
    return at.notice(failure(error), "warning");
  }
  if (at.shown.value === name) at.shown.value = undefined;
  at.notice(`closed · ${name}`);
  await at.refreshWorkers();
}

/** Stop the root's front, putting the user's queued messages back in the editor. */
async function stopFront(at: Showing): Promise<void> {
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
  target?: Aim,
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
    const sent = (await runInput(input, attachments, requestId, target ?? aim())) === true;
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

/** Where a submission goes: the root and conversation on screen, and the busy mode, as it was made. */
type Aim = { at: Showing; name: string | undefined; when: WhenBusy };

function aim(): Aim {
  const at = showing();
  return { at, name: at.shown.value, when: mode.value };
}

/** Runs one parsed submission; true when a message went. */
async function runInput(
  input: NonNullable<ReturnType<typeof parseInput>>,
  attachments: readonly Attachment[],
  requestId: string,
  // Admitted under the root on screen: it goes there, and says so there, whatever is shown by then.
  { at, name, when }: Aim,
): Promise<boolean | void> {
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
      return toggleWorkers(true);
    case "/stop":
      if (input.text || name !== undefined) {
        const worker = input.text || name || "";
        await at.root.stopWorker(worker);
        return at.notice(`stopped · ${worker}`);
      }
      return await interrupt();
    case "/close":
      return await closeWorker(input.text);
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
      return toggleJobs(true);
    case "/goals":
      return toggleGoals(true);
    case "/pin": {
      const { pin, existed } = await at.root.pinMessage(input.id, name);
      return at.notice(`${existed ? "already pinned" : "pinned"} · ${pin.code} · ${pin.headline}`);
    }
    case "/pins":
      return openSheet("pins", input.text);
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
