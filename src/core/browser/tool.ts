/**
 * `remote_browser`: the device's browser farm (see `farm.ts`) as one deferred tool with seven actions. Each session
 * belongs to the conversation that opened it (the farm's owner is its short id); every result starts with the session,
 * tab, page and snapshot, so the state is always in the transcript. A handoff fences the agent, gives the user a link
 * that keeps working until they tap done, and a background task waits for that and messages the owner, once, by the
 * farm's handoff as request ID. `agent_browser` stays the default; this is for Camoufox privacy, the shared logins and
 * the user taking over.
 */
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { shortId } from "../../api/ids.ts";
import { noticeText, systemNoticeText } from "../../api/notices.ts";
import { messageWorker, parentOf, reopenWorker, WorkersDoc } from "../agents/workers.ts";
import { fillPlaceholders, originOf, redacting } from "../secrets/tool.ts";
import type { Vault } from "../secrets/vault.ts";
import type { ToolGroup } from "../tools/tool-search.ts";
import {
  Closed,
  Farm,
  FarmError,
  Page,
  Session,
  Sessions,
  type FarmUse,
  type PageView,
  type SessionView,
} from "./farm.ts";

const TOOL = "remote_browser";

const GUIDE = `remote_browser drives Camoufox (a privacy-hardened Firefox) on a remote browser farm. Use agent_browser for ordinary browsing; use this one when the user asks for the remote browser, or when the task needs what only it has: the user's saved logins (shared by every agent), Camoufox's privacy, or the user taking over (logins, CAPTCHAs, payments, anything only they should do).

- open {url}: opens your own session (a browser only you drive, starting from the shared logins) or reuses the one you have, and shows the page. new_tab opens another tab (up to 4); session picks one of yours.
- Each result starts with the session, tab, page and snapshot number. Refs look like s5e12: snapshot 5, element 12. Use them exactly as shown. An older ref still works while its element is on the page; otherwise you get stale_ref with the page as it is now, so nothing is clicked by mistake.
- snapshot {tab}: about 8000 characters of the page at a time; more {offset} for the next window, find {text} for matching lines, urls for link targets, image for a screenshot (costly: only when the layout matters).
- act {tab, do, ref?, text?}: click, type (submit presses Enter), select, press (a key: Enter, Escape), scroll (text: up or down), back, forward, reload, wait (text: seconds), js (text: an expression; its result comes back). After an act you see only what changed when the page stayed, else the new page.
- login {tab, secret, ref, password_ref}: fills a stored login (its site must be the page's) into the username and password fields without showing it; submit sends the form. In act text, {{secret:NAME}} also works.
- handoff {session, reason}: hand the browser to the user (a login, a CAPTCHA, a decision). The user gets a link; end your turn. They can leave and come back; you get a message when they tap done or give up, and then take a fresh snapshot (old refs are stale). Don't use the session meanwhile. handoff {session, cancel: true} takes it back.
- tabs: your sessions and tabs, and who holds the others. close {session} or {tab} ends them; close with no target closes every session you have. save keeps the logins the session changed for everyone.
- Close what you open as soon as you are done. Untouched sessions close by themselves after a while, but a handoff waits for the user.
- uncertain means the action may have happened: snapshot before anything else, never repeat it blindly.
- Stop at explicit boundaries: ask the user before purchases, account or security changes and destructive actions; never bypass CAPTCHAs (hand off instead); use web search and scrape tools, not search-engine forms, to search.`;

const ACT = [
  "click",
  "type",
  "select",
  "press",
  "scroll",
  "back",
  "forward",
  "reload",
  "wait",
  "js",
] as const;

const Parameters = Type.Object(
  {
    action: StringEnum(["open", "snapshot", "act", "tabs", "close", "handoff", "login"], {
      description: "What to do; see the guide tool_search returned",
    }),
    url: Type.Optional(Type.String({ description: "open: the page" })),
    session: Type.Optional(
      Type.String({ description: "open, close, handoff: a session id like k3" }),
    ),
    tab: Type.Optional(
      Type.String({ description: "snapshot, act, login, close: a tab id like k3.1" }),
    ),
    new_tab: Type.Optional(Type.Boolean({ description: "open: in a new tab of your session" })),
    profile: Type.Optional(
      Type.String({ description: "open: the login profile a new session starts from" }),
    ),
    do: Type.Optional(StringEnum([...ACT], { description: "act: the action" })),
    ref: Type.Optional(Type.String({ description: "act, login: an element ref like s5e12" })),
    text: Type.Optional(
      Type.String({
        description: "act: text to type, an option, a key, a direction, seconds, or js",
      }),
    ),
    submit: Type.Optional(Type.Boolean({ description: "act type, login: press Enter after" })),
    more: Type.Optional(
      Type.Integer({ minimum: 0, description: "snapshot: offset of the next window" }),
    ),
    find: Type.Optional(Type.String({ description: "snapshot: show only lines containing this" })),
    urls: Type.Optional(Type.Boolean({ description: "snapshot: keep link targets" })),
    image: Type.Optional(Type.Boolean({ description: "snapshot: add a screenshot" })),
    save: Type.Optional(
      Type.Boolean({ description: "close: save the logins this session changed" }),
    ),
    reason: Type.Optional(
      Type.String({ description: "handoff: what the user should do, in a line" }),
    ),
    cancel: Type.Optional(Type.Boolean({ description: "handoff: take the browser back" })),
    secret: Type.Optional(Type.String({ description: "login: a stored login's name" })),
    password_ref: Type.Optional(Type.String({ description: "login: the password field's ref" })),
  },
  { additionalProperties: false },
);

const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });
const failure = (value: string): ToolExecutionResult => ({
  output: [{ type: "text", text: value }],
  isError: true,
});

const ago = (seconds: number) =>
  seconds < 90
    ? `${Math.round(seconds)}s`
    : seconds < 5400
      ? `${Math.round(seconds / 60)}m`
      : `${Math.round(seconds / 3600)}h`;

/** A page with the header every result carries. */
function formatPage(page: PageView, lead?: string): string {
  const session = page.tab.split(".")[0] ?? "";
  const lines = [
    ...(lead === undefined ? [] : [lead]),
    `session ${session} · tab ${page.tab} · phase agent`,
  ];
  if (page.url !== "") lines.push(`${page.url}${page.title === "" ? "" : `  "${page.title}"`}`);
  if (page.note !== undefined) lines.push(page.note);
  if (page.snapshot === 0) return lines.join("\n");
  const where =
    page.found !== undefined
      ? `${page.found.matches} lines match "${page.found.query}"`
      : page.changed !== undefined
        ? `only what changed since your last look${page.changed.removed > 0 ? ` (${page.changed.removed} lines gone)` : ""}; snapshot shows the whole page`
        : page.more === null
          ? `${page.chars} chars`
          : `${page.chars} chars; more: ${page.more} for the next window`;
  lines.push(`snapshot ${page.snapshot} · ${where}`);
  if (page.result !== undefined) {
    const result = JSON.stringify(page.result) ?? "undefined";
    lines.push(`result: ${result.length > 8000 ? `${result.slice(0, 8000)}… (cut)` : result}`);
  }
  lines.push("", page.text === "" ? "(nothing new on the page)" : page.text);
  return lines.join("\n");
}

/** One session and its tabs, as `tabs` and `/browsers` list them. */
export function formatSession(view: SessionView): string {
  const lines = [
    `session ${view.id} (${view.yours ? "yours" : view.label}, profile ${view.profile}) · phase ${view.phase} · idle ${ago(view.idleSeconds)}${view.memoryMb === undefined ? "" : ` · ${view.memoryMb} MB`}`,
  ];
  if (view.handoff !== undefined)
    lines.push(
      `  waiting for the user since ${view.handoff.since}: ${view.handoff.reason}${view.handoff.link === undefined ? "" : ` · ${view.handoff.link}`}`,
    );
  for (const tab of view.tabs)
    lines.push(`  tab ${tab.id}  ${tab.url}${tab.title === "" ? "" : `  "${tab.title}"`}`);
  return lines.join("\n");
}

/** Who holds the browsers, as `farm_full` lists them. */
const Holders = Type.Array(
  Type.Object({ id: Type.String(), label: Type.String(), yours: Type.Boolean() }),
);

/** The farm's error as the model reads it: its code, its next step, and any page or sessions it carries. */
function formatError(error: unknown): string {
  if (!(error instanceof FarmError))
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  const lines = [`${error.code}: ${error.message}`];
  const page = error.body.page;
  if (Check(Page, page)) lines.push("", formatPage(page));
  const sessions = error.body.sessions;
  if (Check(Holders, sessions))
    for (const each of sessions) lines.push(`  ${each.id} · ${each.yours ? "yours" : each.label}`);
  return lines.join("\n");
}

/** Who is calling: the farm's owner key, a label people read, and the worker record when it is one. */
async function caller(api: ToolExecutionApi, context: Context) {
  return api.commit(async (tx) => {
    const parent = await parentOf(tx, api.conversationId);
    const worker =
      parent === undefined
        ? undefined
        : (await tx.doc(WorkersDoc, parent)).workers.find(
            (each) => each.conversationId === api.conversationId,
          );
    return {
      owner: shortId(api.conversationId),
      label: worker?.name ?? "front",
      parent: worker === undefined ? undefined : parent,
      name: worker?.name,
    };
  }, context);
}

/**
 * Closes this device's agent sessions whose owner is gone: a closed worker, or a conversation this store no longer has.
 * A session waiting for the user is left for them. Returns the ids it closed.
 */
async function reconcile(
  farm: Farm,
  list: { client: string; sessions: SessionView[] },
  commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>,
  use: FarmUse,
): Promise<string[]> {
  const prefix = `${list.client}/`;
  const candidates = list.sessions.filter(
    (each) => each.owner.startsWith(prefix) && each.phase !== "human",
  );
  if (candidates.length === 0) return [];
  const keys = new Set(candidates.map((each) => each.owner.slice(prefix.length)));
  const gone = await commit(async (tx) => {
    const found = new Map<string, ConversationId>();
    let cursor;
    do {
      const page = await tx.scanConversations({}, 500, cursor);
      for (const record of page.items)
        if (keys.has(shortId(record.id))) found.set(shortId(record.id), record.id);
      cursor = page.next;
    } while (cursor !== undefined && found.size < keys.size);
    const out = new Set<string>();
    for (const key of keys) {
      const id = found.get(key);
      if (id === undefined) {
        out.add(key);
        continue;
      }
      const parent = await parentOf(tx, id);
      if (parent === undefined) continue;
      const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
        (each) => each.conversationId === id,
      );
      if (worker === undefined || worker.closed) out.add(key);
    }
    return out;
  });
  const closed: string[] = [];
  for (const session of candidates)
    if (gone.has(session.owner.slice(prefix.length))) {
      await farm
        .call("DELETE", `/v1/sessions/${encodeURIComponent(session.id)}?force=1`, Closed, { use })
        .then(
          () => closed.push(session.id),
          () => undefined,
        );
    }
  return closed;
}

/** The handoff waiter's input: which handoff, and whose. */
type WaitInput = { session: string; owner: ConversationId; since: string };
type WaitEnd = { outcome: "done" | "cancelled" | "closed" | "ended"; detail: string };

/** The message a finished handoff sends its owner. */
function endText(input: WaitInput, end: WaitEnd): string {
  const summary =
    end.outcome === "done"
      ? `the user finished the browser handoff on session ${input.session}`
      : end.outcome === "cancelled"
        ? `the browser handoff on session ${input.session} ended without the user finishing`
        : end.outcome === "closed"
          ? `browser session ${input.session} closed while it waited for the user`
          : `the browser handoff on session ${input.session} is over`;
  const next =
    end.outcome === "closed"
      ? "Open a new session with remote_browser if you still need the browser."
      : "The browser is yours again: take a fresh snapshot with remote_browser (old refs are stale) and carry on.";
  return systemNoticeText(summary, `${end.detail}${end.detail === "" ? "" : "\n"}${next}`);
}

function tabsLine(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const tabs = value.flatMap((each: unknown) =>
    typeof each === "object" && each !== null && "id" in each && "url" in each
      ? [`${String(each.id)} ${String(each.url)}`]
      : [],
  );
  return tabs.length === 0 ? "" : `Tabs now: ${tabs.join(", ")}.`;
}

export function createRemoteBrowser(farm: Farm | undefined, vault: Vault) {
  /**
   * Waits for one handoff to end, then tells its owner once: a worker as a message from its parent (so its answer is
   * reported as usual, reopening it if it was closed meanwhile), a front as follow-up input. It follows the farm's
   * event stream and rechecks the session at every (re)connect, so an event missed while away is not lost.
   */
  const Waiter = defineTask<WaitInput, { phase: "wait" } | { phase: "tell"; end: WaitEnd }, null>({
    name: "monchu.browser-handoff",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const { session } = task.input;
        const use = { tool: TOOL, conversation: shortId(task.input.owner) };
        let end: WaitEnd | undefined;
        const check = async (): Promise<boolean> => {
          if (farm === undefined) {
            end = { outcome: "ended", detail: "This device no longer has a browser farm." };
            return true;
          }
          try {
            const view = await farm.call(
              "GET",
              `/v1/sessions/${encodeURIComponent(session)}`,
              Session,
              {
                use,
                timeoutMs: 20_000,
              },
            );
            if (view.phase === "human" && view.handoff?.since === task.input.since) return false;
            end = { outcome: "ended", detail: tabsLine(view.tabs) };
            return true;
          } catch (error) {
            if (
              error instanceof FarmError &&
              (error.code === "session_closed" || error.code === "not_found")
            ) {
              end = { outcome: "closed", detail: error.message };
              return true;
            }
            return false;
          }
        };
        while (end === undefined) {
          runtime.signal.throwIfAborted();
          const stream = withCancel(context);
          const stop = () => stream.cancel();
          runtime.signal.addEventListener("abort", stop, { once: true });
          try {
            if (farm === undefined) await check();
            else
              await farm.events(
                (event) => {
                  if (event.data.session !== session) return false;
                  if (event.type === "handoff.done" || event.type === "handoff.cancelled") {
                    const minutes =
                      typeof event.data.minutes === "number"
                        ? `after ${event.data.minutes} min`
                        : "";
                    const by = event.data.by === "agent" ? "You took the browser back." : "";
                    const warning =
                      typeof event.data.warning === "string" ? ` (${event.data.warning})` : "";
                    end = {
                      outcome: event.type === "handoff.done" ? "done" : "cancelled",
                      detail: [
                        `${event.type === "handoff.done" ? "Done" : "Given up"} ${minutes}${warning}.`,
                        by,
                        tabsLine(event.data.tabs),
                      ]
                        .filter((part) => part !== "")
                        .join(" "),
                    };
                    return true;
                  }
                  if (event.type === "session.closed") {
                    end = { outcome: "closed", detail: `It closed: ${String(event.data.reason)}.` };
                    return true;
                  }
                  return false;
                },
                check,
                use,
                stream.context,
              );
          } finally {
            runtime.signal.removeEventListener("abort", stop);
            stream.cancel();
          }
          if (end === undefined) await runtime.sleep(runtime.now() + 10_000, context);
        }
        const found = end;
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "tell", end: found } }),
          context,
        );
      },
      tell: async (task, runtime, context) => {
        const { owner, session, since } = task.input;
        const message = endText(task.input, task.state.checkpoint.end);
        const requestId = `browser-handoff:${session}:${since}`;
        let front = false;
        await runtime.commit(async (tx) => {
          const parent = await parentOf(tx, owner);
          front = parent === undefined;
          if (parent === undefined) return undefined;
          const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
            (each) => each.conversationId === owner,
          );
          if (worker !== undefined) {
            if (worker.closed) await reopenWorker(tx, parent, worker.name);
            await messageWorker(tx, parent, worker.name, message, requestId, "followUp");
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        if (!front) return;
        const conversation = await runtime.conversation(owner, context);
        await conversation?.submit(
          { type: "input", content: message, whenBusy: "followUp", requestId },
          context,
        );
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  const tool = defineTool({
    name: TOOL,
    description:
      "Drive your own Camoufox browser on the remote browser farm: open, snapshot, act, tabs, close, handoff (the user takes over), login. Use agent_browser for ordinary browsing; use this only when asked to, or when the task needs the user's shared logins, Camoufox's privacy, or the user taking over. Refs look like s5e12. Close what you open.",
    parameters: Parameters,
    outputLimits: { retain: "head" },
    execute: async (args, api, context) => {
      if (farm === undefined)
        return failure(
          "farm_unreachable: this device has no browser farm (browser-farm.json in Monchu's home); use agent_browser",
        );
      const use = { tool: TOOL, conversation: shortId(api.conversationId) };
      const me = await caller(api, context);
      const call = <S extends TSchema>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        schema: S,
        body?: Record<string, unknown>,
      ) =>
        farm.call(method, path, schema, {
          use,
          owner: me.owner,
          ...(body === undefined ? {} : { body }),
        });
      const list = async () => {
        const all = await call("GET", "/v1/sessions", Sessions);
        const closed = await reconcile(farm, all, (change) => api.commit(change, context), use);
        return { ...all, sessions: all.sessions.filter((each) => !closed.includes(each.id)) };
      };
      const need = (value: string | undefined, name: string, action: string) => {
        if (value === undefined || value.trim() === "")
          throw new FarmError("bad_request", 400, `${action} needs ${name}`);
        return value.trim();
      };
      const tabOrigin = async (tab: string) => {
        const view = await call(
          "GET",
          `/v1/sessions/${encodeURIComponent(tab.split(".")[0] ?? "")}`,
          Session,
        );
        return originOf(view.tabs.find((each) => each.id === tab)?.url ?? "");
      };
      const tabPath = (tab: string) => `/v1/tabs/${encodeURIComponent(tab)}`;
      try {
        switch (args.action) {
          case "open": {
            const url = need(args.url, "url", "open");
            let session: SessionView;
            let lead: string | undefined;
            if (args.session !== undefined) {
              session = await call(
                "GET",
                `/v1/sessions/${encodeURIComponent(args.session)}`,
                Session,
              );
              if (!session.yours)
                throw new FarmError(
                  "not_yours",
                  403,
                  `session ${session.id} belongs to ${session.label}`,
                );
            } else {
              const mine = (await list()).sessions.filter(
                (each) => each.yours && each.phase === "agent",
              );
              const reuse = mine[0];
              if (reuse !== undefined) {
                session = reuse;
                if (mine.length > 1)
                  lead = `using session ${reuse.id}; you also have ${mine
                    .slice(1)
                    .map((each) => each.id)
                    .join(", ")}`;
              } else {
                session = await call("POST", "/v1/sessions", Session, {
                  label: me.label,
                  ...(args.profile === undefined ? {} : { profile: args.profile }),
                });
                lead = `opened session ${session.id} (profile ${session.profile}: the shared logins). Close it when you are done.`;
              }
            }
            const target = args.tab ?? session.tabs[0]?.id;
            const page =
              args.new_tab === true || target === undefined
                ? await call("POST", `/v1/sessions/${encodeURIComponent(session.id)}/tabs`, Page, {
                    url,
                  })
                : await call("POST", `${tabPath(target)}/navigate`, Page, { url });
            return text(formatPage(page, lead));
          }
          case "snapshot": {
            const tab = need(args.tab, "tab", "snapshot");
            const query = new URLSearchParams();
            if (args.more !== undefined && args.more > 0) query.set("more", String(args.more));
            if (args.find !== undefined && args.find !== "") query.set("find", args.find);
            if (args.urls === true) query.set("urls", "1");
            const page = await call(
              "GET",
              `${tabPath(tab)}/snapshot${query.size === 0 ? "" : `?${query}`}`,
              Page,
            );
            if (args.image !== true) return text(formatPage(page));
            const png = await farm.screenshot(tab, me.owner, use);
            return {
              output: [
                { type: "text", text: formatPage(page) },
                { type: "image", data: png.toString("base64"), mimeType: "image/png" },
              ],
            };
          }
          case "act": {
            const tab = need(args.tab, "tab", "act");
            const action = args.do;
            if (action === undefined)
              throw new FarmError("bad_request", 400, `act needs do: ${ACT.join(", ")}`);
            let typed = args.text;
            if (typed?.includes("{{secret:") === true)
              typed = (
                await fillPlaceholders(vault, [typed], { ...use, origin: () => tabOrigin(tab) })
              )[0];
            const page = await call("POST", `${tabPath(tab)}/act`, Page, {
              do: action,
              ...(args.ref === undefined ? {} : { ref: args.ref }),
              ...(typed === undefined ? {} : { text: typed }),
              ...(args.submit === true ? { submit: true } : {}),
            });
            return text(formatPage(page));
          }
          case "login": {
            const tab = need(args.tab, "tab", "login");
            const name = need(args.secret, "secret", "login").toUpperCase();
            const ref = need(args.ref, "ref (the username field)", "login");
            const info = await vault.info(name);
            if (info === undefined)
              throw new FarmError(
                "bad_request",
                400,
                `no stored login ${name}: ask the user for it with the secret tool (request, kind login)`,
              );
            const fields =
              info.kind === "login"
                ? [
                    { key: `${name}_USERNAME`, ref },
                    {
                      key: `${name}_PASSWORD`,
                      ref: need(args.password_ref, "password_ref", "login"),
                    },
                  ]
                : [{ key: name, ref }];
            const values = await fillPlaceholders(
              vault,
              fields.map((field) => `{{secret:${field.key}}}`),
              { ...use, origin: () => tabOrigin(tab) },
            );
            let page: PageView | undefined;
            for (const [index, field] of fields.entries())
              page = await call("POST", `${tabPath(tab)}/act`, Page, {
                do: "type",
                ref: field.ref,
                text: values[index] ?? "",
                ...(args.submit === true && index === fields.length - 1 ? { submit: true } : {}),
              });
            const filled = info.kind === "login" ? "username and password" : "the value";
            return text(
              page === undefined
                ? `filled ${filled}`
                : formatPage(page, `filled ${filled} of ${name}`),
            );
          }
          case "tabs": {
            const all = await list();
            const mine = all.sessions.filter((each) => each.yours);
            const others = all.sessions.filter((each) => !each.yours);
            return text(
              [
                mine.length === 0
                  ? "you have no sessions; open {url} starts one"
                  : mine.map(formatSession).join("\n"),
                ...(others.length === 0
                  ? []
                  : [
                      `others: ${others.map((each) => `${each.id} (${each.label}, ${each.phase})`).join(", ")}`,
                    ]),
              ].join("\n"),
            );
          }
          case "close": {
            const save = args.save === true ? "?save=1" : "";
            if (args.tab !== undefined) {
              const closed = await call("DELETE", tabPath(args.tab), Closed);
              return text(
                `closed tab ${args.tab}; open tabs: ${closed.tabs?.map((each) => `${each.id} ${each.url}`).join(", ") || "none (the session stays open: close it too)"}`,
              );
            }
            const targets =
              args.session !== undefined
                ? [args.session]
                : (await list()).sessions.filter((each) => each.yours).map((each) => each.id);
            if (targets.length === 0) return text("you have no sessions to close");
            const lines: string[] = [];
            for (const id of targets) {
              const closed = await call(
                "DELETE",
                `/v1/sessions/${encodeURIComponent(id)}${save}`,
                Closed,
              );
              lines.push(
                `closed session ${id}${closed.saved === undefined ? "" : closed.saved.length === 0 ? "; no logins changed" : `; saved logins for ${closed.saved.join(", ")}`}${closed.warning === undefined ? "" : `; warning: ${closed.warning}`}`,
              );
            }
            return text(lines.join("\n"));
          }
          case "handoff": {
            const mine =
              args.session === undefined
                ? (await list()).sessions.filter((each) => each.yours)
                : [];
            const id = args.session ?? (mine.length === 1 ? mine[0]?.id : undefined);
            if (id === undefined)
              throw new FarmError(
                "bad_request",
                400,
                `handoff needs session: ${mine.length === 0 ? "you have none" : `yours are ${mine.map((each) => each.id).join(", ")}`}`,
              );
            const path = `/v1/sessions/${encodeURIComponent(id)}/handoff`;
            if (args.cancel === true) {
              await call("DELETE", path, Session);
              return text(`took session ${id} back; take a fresh snapshot (old refs are stale)`);
            }
            const reason = need(args.reason, "reason", "handoff");
            const view = await call("POST", path, Session, { reason });
            const since = view.handoff?.since ?? "";
            const link = view.handoff?.link ?? "";
            await api.commit(async (tx) => {
              await tx.createTask(
                Waiter,
                { session: id, owner: api.conversationId, since },
                {
                  conversationId: api.conversationId,
                  ownership: { kind: "conversation" },
                  background: true,
                },
              );
            }, context);
            // A worker's front hears it at once with the link, so the user can be told.
            if (me.parent !== undefined && me.name !== undefined) {
              const parent = await api.conversation(me.parent, context);
              await parent?.submit(
                {
                  type: "input",
                  content: noticeText({
                    name: me.name,
                    status: "update",
                    text: `needs the user in the browser: ${reason}\n${link}\nThe link keeps working until they tap done there (they can leave and come back); ${me.name} carries on by itself after.`,
                  }),
                  whenBusy: "followUp",
                  requestId: `browser-handoff-asked:${id}:${since}`,
                },
                context,
              );
            }
            return text(
              [
                `handed session ${id} to the user: ${link}`,
                me.parent === undefined
                  ? "Give the user this link now and end your turn. You get a message when they tap done or give up."
                  : "Your front got the link to give the user. End your turn now; you get a message when they tap done or give up.",
                "Don't use this session meanwhile; handoff {session, cancel: true} takes it back.",
              ].join("\n"),
            );
          }
        }
        return failure(
          `bad_request: action must be open, snapshot, act, tabs, close, handoff or login`,
        );
      } catch (error) {
        return failure(formatError(error));
      }
    },
  });

  const group: ToolGroup = {
    name: "remote-browser",
    preload: true,
    summary:
      "the remote browser farm: your own Camoufox browser with the user's shared logins and a takeover link for the user. agent_browser is the default; use this only when asked, or when a task needs those logins, Camoufox's privacy, or the user taking over",
    tools: [redacting(tool, vault)],
    details: async () => GUIDE,
  };
  return {
    group,
    extension: defineExtension({ name: "monchu.remote-browser", tasks: [Waiter] }),
  };
}
