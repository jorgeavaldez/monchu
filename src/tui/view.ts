/*
 * Transcript reconciliation and viewport layout adapted from Pi's experimental/durable/tui.ts.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import {
  AgentsPanel,
  statusText,
  type AgentRow,
  type AgentStatus,
} from "./components/agents-panel.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { Footer, shortPath, type FooterState } from "./components/footer.ts";
import { GoalsPanel, type GoalRow } from "./components/goals-panel.ts";
import { LinkRows } from "./components/link.ts";
import { copyText, openUrl } from "./system.ts";
import { formatKeyText } from "./components/keybinding-hints.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { WorkerMessageComponent } from "./components/worker-message.ts";
import { getMarkdownTheme, getSelectListTheme, theme } from "./theme/theme.ts";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  type ConversationView,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  fuzzyFilter,
  getKeybindings,
  Input,
  Loader,
  Markdown,
  matchesKey,
  MouseRegion,
  ScrollView,
  SelectList,
  Spacer,
  Text,
  TruncatedText,
  truncateToWidth,
  TuiAltScreen,
  VStack,
  type Component,
  type Focusable,
  type SelectItem,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { Goal, QueueChange } from "../api/client.ts";
import { shortId } from "../api/ids.ts";
import {
  escalationSummary,
  parseWorkerNotice,
  workerNotice,
  type WhenBusy,
} from "../api/notices.ts";
import { commands } from "../ui/commands.ts";
import { presentation, type QueuedItem } from "../ui/state.ts";

/**
 * What a chat notice reports: Monchu's own status, the startup header, or input delivered to a worker. A delivery says
 * `message`, never `steer`: whether it steers a run depends on the worker's state when it arrives, not when it is sent.
 */
type NoticeKind = "system" | "message" | "intro";

/**
 * A notice's styled line: a delivery has a yellow rule and label, as queued input does in the dock. Monchu's own status
 * is muted, with a warning in yellow and an error in red, as Pi shows them.
 */
function noticeLine(text: string, kind: NoticeKind): string {
  const muted = getSelectListTheme().description;
  if (kind === "intro") return introLines(text);
  if (kind !== "system") return `${theme.fg("warning", `│ ${kind}`)}${muted(` · ${text}`)}`;
  const [, level, rest] = /^(warning|error) · ([\s\S]*)$/.exec(text) ?? [];
  if (level === "warning" && rest !== undefined)
    return `${theme.fg("warning", "warning")}${muted(` · ${rest}`)}`;
  if (level === "error" && rest !== undefined)
    return `${theme.fg("error", "error")}${theme.fg("error", ` · ${rest}`)}`;
  return muted(`system · ${text}`);
}

/** Pi's startup header: the name, where home is, and the keys worth knowing. */
function introLines(home: string): string {
  const muted = getSelectListTheme().description;
  const hint = (key: string, text: string) =>
    `${theme.fg("dim", formatKeyText(key))}${muted(` ${text}`)}`;
  return `${theme.bold(theme.fg("accent", "Monchu"))}${muted(` · /help · home ${shortPath(home)}`)}\n${[
    hint("escape", "interrupt"),
    hint("ctrl+c/ctrl+d", "clear/exit"),
    hint("alt+s", "steer"),
    hint("alt+q", "queue"),
    hint("ctrl+o", "expand"),
    `${theme.fg("dim", "/agents")}${muted(" workers")}`,
  ].join(muted(" · "))}`;
}

/** The thinking level's border color, as Pi colors its editor; a model without reasoning uses `off`'s. */
function thinkingColor(level: string | undefined) {
  switch (level) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "thinkingOff";
  }
}

/** The first line of a text, marked when more follows: dock rows show one line each. */
function firstLine(text: string): string {
  const [line = "", ...rest] = text.trim().split(/\r\n|\r|\n/);
  return rest.length ? `${line} …` : line;
}

/**
 * A queued inbox row, styled by who sent it: the user's own message has a yellow `you` rule and its text in the user's
 * color; a worker's keeps its transcript style, a purple rule and name for a reply or failure and gray for an update;
 * routing advice and a passive write stay muted. Every input row names its mode.
 */
function queuedLine(item: QueuedItem): string {
  const muted = getSelectListTheme().description;
  if (item.mode === "write") return muted(`│ write · ${item.text}`);
  const mode = item.mode === "steer" ? "steer" : "follow-up";
  const worker = parseWorkerNotice(item.text);
  if (worker !== undefined) {
    const update = worker.status === "update";
    const kind = update ? "update" : worker.status === "completed" ? "reply" : "failed";
    return `${theme.fg(update ? "borderMuted" : "borderAccent", "│")} ${theme.fg(
      update ? "muted" : "accent",
      `${worker.name} ${kind}`,
    )}${muted(` · ${mode} · ${firstLine(worker.text)}`)}`;
  }
  const assessment = escalationSummary(item.text);
  if (assessment !== undefined)
    return muted(`│ routing advice · ${mode} · ${firstLine(assessment)}`);
  return `${theme.fg("warning", `│ you · ${mode}`)}${theme.fg("userMessageText", ` · ${firstLine(item.text)}`)}`;
}

/** A filterable list in the editor's place: the agent menu, and the first step of the model and thinking menus. */
class ListSelector extends Container implements Focusable {
  readonly input = new Input();
  readonly listContainer = new Container();
  list: SelectList;

  readonly items: SelectItem[];
  readonly select: (value: string) => void;
  readonly cancel: () => void;

  constructor(
    title: string,
    items: SelectItem[],
    select: (value: string) => void,
    cancel: () => void,
  ) {
    super();
    this.items = items;
    this.select = select;
    this.cancel = cancel;
    this.addChild(new Text(`${title} (Esc to cancel):`, 1, 0));
    this.addChild(this.input);
    this.addChild(this.listContainer);
    this.list = this.build(items);
  }

  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const forwarded = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;
    if (forwarded.some((key) => keys.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    this.list = this.build(
      fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.description}`),
    );
  }

  private build(items: SelectItem[]): SelectList {
    // Every item stays visible, so the agent menu is the full list behind the dock's compact counts.
    const list = new SelectList(items, Math.max(1, this.items.length), getSelectListTheme());
    list.onSelect = (item) => this.select(item.value);
    list.onCancel = this.cancel;
    this.listContainer.clear();
    this.listContainer.addChild(list);
    return list;
  }
}

/**
 * The shown conversation's queue in the editor's place, one row per item as the dock shows it. The selection follows its
 * item while the queue changes underneath; a passive write is listed but takes no action.
 */
class QueuePanel implements Component, Focusable {
  focused = false;
  private items: readonly QueuedItem[];
  private selected: number | undefined;
  private readonly act: (item: QueuedItem, action: "edit" | "toggle" | "delete") => void;
  private readonly close: () => void;

  constructor(
    items: readonly QueuedItem[],
    act: (item: QueuedItem, action: "edit" | "toggle" | "delete") => void,
    close: () => void,
  ) {
    this.items = items;
    this.selected = items[0]?.id;
    this.act = act;
    this.close = close;
  }

  update(items: readonly QueuedItem[]): void {
    const index = this.items.findIndex((item) => item.id === this.selected);
    this.items = items;
    // When the selected item leaves the queue, select the one that took its place.
    if (!items.some((item) => item.id === this.selected))
      this.selected = items[Math.min(Math.max(0, index), items.length - 1)]?.id;
  }

  render(width: number): string[] {
    const theme = getSelectListTheme();
    const rule = theme.description("─".repeat(width));
    const rows = this.items.length
      ? this.items.map((item) =>
          truncateToWidth(
            `${item.id === this.selected ? theme.selectedText("›") : " "}${queuedLine(item)}`,
            width,
            "...",
          ),
        )
      : [theme.description("  Nothing queued")];
    return [
      rule,
      truncateToWidth(` ${theme.selectedText("Queue")}`, width, "..."),
      ...rows,
      truncateToWidth(
        theme.description(" Enter edit · Alt+S mode · Del delete · Esc"),
        width,
        "...",
      ),
      rule,
    ];
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const index = this.items.findIndex((item) => item.id === this.selected);
    const item = this.items[index];
    if (keys.matches(data, "tui.select.up"))
      this.selected = this.items[Math.max(0, index - 1)]?.id ?? this.selected;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = this.items[Math.min(this.items.length - 1, index + 1)]?.id ?? this.selected;
    else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) this.close();
    else if (item === undefined || item.mode === "write") return;
    else if (keys.matches(data, "tui.select.confirm")) this.act(item, "edit");
    else if (matchesKey(data, "alt+s")) this.act(item, "toggle");
    else if (matchesKey(data, "delete")) this.act(item, "delete");
  }

  invalidate(): void {}
}

/**
 * The chat document. Layout renders the whole scroll content every frame, so re-rendering every entry made each
 * frame cost grow with the conversation. Children before the settled index keep their lines per width until
 * `changed` names one of them or the tree is invalidated; later children render every frame. Every entry stays
 * mounted, so scrollback, selection, and search still reach the whole conversation.
 */
class Transcript extends Container {
  private settled = 0;
  private cache: { width: number; lines: string[]; heights: number[] } | undefined;
  private live: { width: number; heights: number[] } | undefined;
  // Hosts one child at a time so Container's own dispatch translates mouse events into it.
  private readonly hit = new Container();

  /** Children before `index` change only through `changed`. */
  settle(index: number): void {
    this.settled = index;
  }

  changed(child: Component): void {
    if (this.cache === undefined) return;
    const index = this.children.lastIndexOf(child);
    if (index !== -1 && index < this.cache.heights.length) this.cache = undefined;
  }

  override invalidate(): void {
    this.cache = undefined;
    super.invalidate();
  }

  override clear(): void {
    super.clear();
    this.settled = 0;
    this.cache = undefined;
  }

  override removeChild(component: Component): void {
    super.removeChild(component);
    this.settled = Math.min(this.settled, this.children.length);
    this.cache = undefined;
  }

  override render(width: number): string[] {
    const settled = Math.min(this.settled, this.children.length);
    if (this.cache?.width !== width || this.cache.heights.length > settled)
      this.cache = { width, lines: [], heights: [] };
    const cache = this.cache;
    if (cache.heights.length < settled) {
      const lines = [...cache.lines];
      for (const child of this.children.slice(cache.heights.length, settled)) {
        const rendered = child.render(width);
        cache.heights.push(rendered.length);
        for (const line of rendered) lines.push(line);
      }
      cache.lines = lines;
    }
    this.live = { width, heights: [] };
    if (settled === this.children.length) return cache.lines;
    const lines = [...cache.lines];
    for (const child of this.children.slice(settled)) {
      const rendered = child.render(width);
      this.live.heights.push(rendered.length);
      for (const line of rendered) lines.push(line);
    }
    return lines;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const cache = this.cache;
    if (cache?.width !== event.width || this.live?.width !== event.width)
      return super.handleMouse(event);
    const settled = cache.heights.length;
    let top = 0;
    for (const [index, child] of this.children.entries()) {
      const height = index < settled ? cache.heights[index] : this.live.heights[index - settled];
      if (height === undefined) break;
      if (event.y >= top && event.y < top + height) {
        this.hit.children = [child];
        return this.hit.handleMouse({ ...event, y: event.y - top, height });
      }
      top += height;
    }
    return undefined;
  }
}

/** Input editing stays local, but secret contents are never rendered or added to editor history. */
class SecretInput extends Input {
  override render(width: number): string[] {
    return ["•".repeat(Math.min(this.getValue().length, Math.max(0, width - 1)))];
  }
}

/** What the terminal asks of its owner; input admission and every side effect stay there. */
type Handlers = {
  submit(text: string, whenBusy: WhenBusy): void;
  editQueued(id: number, change: QueueChange): void;
  abort(): void;
  exit(): void;
};

/** Pi's viewport/editor/message components over committed Durable views. No agent loop lives here. */
export class MonchuTui {
  readonly ui: TuiAltScreen;
  private readonly chat = new Transcript();
  private readonly workers = new Container();
  private readonly queue = new Container();
  private readonly status = new Container();
  private readonly editorContainer = new Container();
  private readonly footer = new Footer();
  private readonly editor: Editor;
  private readonly transcript: ScrollView;
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly cards: ToolExecutionComponent[] = [];
  private readonly workerMessages: WorkerMessageComponent[] = [];
  private readonly unfinished = new Set<ToolExecutionComponent>();
  private readonly streamedCalls = new Set<string>();
  /** Notices posted since the last apply, which places each after an entry. */
  private readonly posted: { text: string; kind: NoticeKind }[] = [];
  /** Placed notices, each after the entry it follows; `undefined` when no entry was shown. */
  private readonly notices: { text: string; kind: NoticeKind; after: number | undefined }[] = [];
  private renderedIds: number[] = [];
  private applied: ConversationView | undefined;
  private workersLine = "";
  private streaming: Container | undefined;
  private streamingText = "";
  private loader: Loader | undefined;
  private statusText = "";
  private expanded = false;
  private lastCtrlC = 0;
  private selector: (Component & Focusable) | undefined;
  private loginCancel: (() => void) | undefined;
  // The sign-in URL shown, which Alt+O opens and Ctrl+X copies; its hint row reports what happened.
  private loginUrl: { url: string; hint: Text } | undefined;
  private readonly loginStatus = new Container();
  private readonly loginPrompt = new Container();
  private conversationId: number | undefined;
  private cwd: string;
  // What a message sent to a busy conversation does; Alt+S toggles it for the root and workers alike.
  private mode: WhenBusy = "followUp";
  private queueItems: readonly QueuedItem[] = [];
  // A queued message open in the editor, and the draft it set aside; Enter saves the edit, Esc cancels it.
  private editing: { id: number; draft: string } | undefined;
  private readonly handlers: Handlers;
  private readonly home: string;
  // Every command and `/skill:<name>`, for Enter while the typeahead's list is open.
  private commandNames = new Set<string>();

  constructor(terminal: Terminal, home: string, handlers: Handlers) {
    this.handlers = handlers;
    this.cwd = home;
    // As in Pi, the editor draws its own cursor; a shown hardware cursor is moved and re-shown every frame.
    // A tap on any OSC 8 link, such as a markdown link in a reply, opens it in the browser.
    this.ui = new TuiAltScreen(terminal, false, home, { openUrl: (url) => void openUrl(url) });
    this.editor = new Editor(
      this.ui,
      {
        borderColor: (text) => getSelectListTheme().selectedText(text),
        selectList: getSelectListTheme(),
      },
      { paddingX: 1 },
    );
    this.home = home;
    this.setSkills([]);
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return;
      if (this.editing !== undefined) {
        handlers.editQueued(this.editing.id, { kind: "text", text });
        this.endEdit();
        return;
      }
      this.editor.addToHistory(text);
      this.editor.setText("");
      handlers.submit(text, this.mode);
    };
    this.editorContainer.addChild(this.editor);
    this.transcript = new ScrollView(this.chat, {
      follow: "end",
      primary: true,
      overscroll: "chain",
    });
    const dock = new VStack([
      { component: this.workers, shrink: 1, minSize: 0 },
      { component: this.queue, shrink: 1, minSize: 0 },
      { component: this.status, shrink: 1, minSize: 0 },
      { component: this.editorContainer, shrink: 1, minSize: 3 },
      { component: this.footer, shrink: 1, minSize: 0 },
    ]);
    for (const component of [
      this.chat,
      this.workers,
      this.queue,
      this.status,
      this.editorContainer,
      this.footer,
    ])
      this.ui.addChild(component);
    this.ui.setLayoutRoot(
      new VStack([
        { component: this.transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
      ]),
    );
    this.ui.setFocus(this.editor);
    this.showMode();
    this.ui.addInputListener((data) => {
      if (this.loginCancel !== undefined) {
        if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
          this.loginCancel();
          return { consume: true };
        }
        // Pi's copy key; Alt+O opens, since Ctrl+O expands tool output.
        if (this.loginUrl !== undefined && matchesKey(data, "alt+o")) {
          this.openLoginUrl();
          return { consume: true };
        }
        if (this.loginUrl !== undefined && matchesKey(data, "ctrl+x")) {
          const { url, hint } = this.loginUrl;
          void copyText(url, (sequence) => this.ui.terminal.write(sequence)).then((how) => {
            hint.setText(theme.fg("success", `URL ${how}`));
            this.ui.requestRender();
          });
          return { consume: true };
        }
        return;
      }
      if (this.selector) return;
      // The typeahead's list can lag a burst of typing, a phone keyboard's whole words, or a paste: Enter would then
      // apply a suggestion for an older prefix. A command already typed in full, or with arguments, goes as typed.
      if (
        this.editor.isShowingAutocomplete() &&
        getKeybindings().matches(data, "tui.input.submit") &&
        this.typedInFull(this.editor.getText())
      ) {
        // Setting the same text closes the list; the editor then submits it unchanged.
        this.editor.setText(this.editor.getExpandedText());
        return;
      }
      if (matchesKey(data, "ctrl+c")) {
        // As in Pi: clear the editor; a second press within 500 ms exits.
        const now = Date.now();
        if (now - this.lastCtrlC < 500) handlers.exit();
        else {
          this.lastCtrlC = now;
          this.editor.setText("");
          this.ui.requestRender();
        }
        return { consume: true };
      }
      if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) {
        if (this.editing !== undefined) this.endEdit();
        else handlers.abort();
        return { consume: true };
      }
      if (matchesKey(data, "alt+q") && this.editing === undefined) {
        this.openQueue();
        return { consume: true };
      }
      if (matchesKey(data, "alt+s")) {
        this.mode = this.mode === "steer" ? "followUp" : "steer";
        this.showMode();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) {
        handlers.exit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o")) {
        this.expanded = !this.expanded;
        for (const card of this.cards) card.setExpanded(this.expanded);
        for (const message of this.workerMessages) message.setExpanded(this.expanded);
        this.ui.requestRender();
        return { consume: true };
      }
      return;
    });
  }

  /** The typeahead: every command with its help and usage, then each skill as `skill:<name>` with its description. */
  /** A slash command with arguments after it, or exactly a known command or skill. */
  private typedInFull(text: string): boolean {
    const [, command = "", args] = /^(\/\S*)(\s[\s\S]*)?$/.exec(text.trimStart()) ?? [];
    if (!command) return false;
    return args !== undefined || this.commandNames.has(command);
  }

  setSkills(skills: readonly { name: string; description: string }[]): void {
    this.commandNames = new Set([
      ...Object.keys(commands),
      ...skills.map((skill) => `/skill:${skill.name}`),
    ]);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          ...Object.entries(commands).map(([command, { usage, help }]) => ({
            name: command.slice(1),
            description: help,
            ...(usage ? { argumentHint: usage } : {}),
          })),
          ...skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            argumentHint: "[text]",
          })),
        ],
        this.home,
      ),
    );
  }

  start(): void {
    this.ui.start();
  }

  stop(): void {
    this.loader?.stop();
    this.ui.stop();
  }

  beginLogin(cancel: () => void): void {
    this.loginCancel = cancel;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.loginStatus);
    this.editorContainer.addChild(this.loginPrompt);
    this.loginMessage("Login · Esc / Ctrl-C to cancel");
  }

  /**
   * Login status text; with `url`, the URL first on rows of its own with no padding, so a selection copies only the
   * URL, then a hint row: a tap or Alt+O opens it in the browser and Ctrl+X copies it. `open` also opens it at once,
   * as Pi opens a sign-in URL.
   */
  loginMessage(message: string, url?: string, open = false): void {
    this.loginStatus.clear();
    this.loginUrl = undefined;
    if (url !== undefined) {
      const hint = new Text("", 1, 0);
      this.loginUrl = { url, hint };
      this.setLoginHint();
      this.loginStatus.addChild(new Text(theme.fg("muted", "Open in the browser:"), 1, 0));
      this.loginStatus.addChild(
        new MouseRegion(new LinkRows(url), (event) => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          this.openLoginUrl();
          return { handled: true };
        }),
      );
      this.loginStatus.addChild(hint);
    }
    if (message) this.loginStatus.addChild(new Text(message, 1, 0));
    if (open) this.openLoginUrl();
    this.ui.requestRender();
  }

  private setLoginHint(status?: string): void {
    const muted = getSelectListTheme().description;
    this.loginUrl?.hint.setText(status ?? muted("tap or Alt+O to open · Ctrl+X to copy"));
  }

  private openLoginUrl(): void {
    const shown = this.loginUrl;
    if (shown === undefined) return;
    void openUrl(shown.url).then((opened) => {
      if (this.loginUrl !== shown) return;
      this.setLoginHint(
        opened
          ? `${theme.fg("success", "opened in the browser")}${getSelectListTheme().description(" · Alt+O again · Ctrl+X copy")}`
          : theme.fg("error", "no browser launcher; Ctrl+X to copy"),
      );
      this.ui.requestRender();
    });
  }

  /** Dedicated, ephemeral controls; no notices, chat submissions, autocomplete or editor history. */
  promptLogin(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
    const abort = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
    return new Promise((resolve, reject) => {
      const cancel = () => finish(undefined);
      const finish = (value: string | undefined) => {
        abort.removeEventListener("abort", cancel);
        this.loginPrompt.clear();
        this.ui.setFocus(this.loginStatus);
        this.ui.requestRender();
        if (value === undefined) reject(new Error("Login cancelled"));
        else resolve(value);
      };
      if (abort.aborted) {
        finish(undefined);
        return;
      }
      abort.addEventListener("abort", cancel, { once: true });
      this.loginPrompt.clear();
      this.loginPrompt.addChild(new Text(prompt.message, 1, 0));
      if (prompt.type === "select") {
        const list = new SelectList(
          prompt.options.map((option) => ({
            value: option.id,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          6,
          getSelectListTheme(),
        );
        list.onSelect = (item) => finish(item.value);
        list.onCancel = cancel;
        this.loginPrompt.addChild(list);
        this.ui.setFocus(list);
      } else {
        const input = prompt.type === "secret" ? new SecretInput() : new Input();
        input.onSubmit = (value) => {
          input.setValue("");
          finish(value);
        };
        input.onEscape = cancel;
        this.loginPrompt.addChild(input);
        this.ui.setFocus(input);
      }
      this.ui.requestRender();
    });
  }

  endLogin(): void {
    this.loginCancel = undefined;
    this.loginUrl = undefined;
    this.loginStatus.clear();
    this.loginPrompt.clear();
    this.restoreEditor();
  }

  choose(title: string, items: SelectItem[], select: (value: string) => void): void {
    this.selector = new ListSelector(
      title,
      items,
      (value) => {
        this.restoreEditor();
        select(value);
      },
      () => this.restoreEditor(),
    );
    this.editorContainer.clear();
    this.editorContainer.addChild(this.selector);
    this.ui.setFocus(this.selector);
    this.ui.requestRender();
  }

  /** Shows a selector in the editor's place until its owner calls `closeSelector`. */
  showSelector(selector: Component & Focusable): void {
    this.selector = selector;
    this.editorContainer.clear();
    this.editorContainer.addChild(selector);
    this.ui.setFocus(selector);
    this.ui.requestRender();
  }

  closeSelector(): void {
    this.restoreEditor();
  }

  /** Lists the root and every worker in the editor's place; `updateAgents` keeps it live while open. */
  openAgents(rows: readonly AgentRow[], shown: string, select: (value: string) => void): void {
    this.showSelector(
      new AgentsPanel(
        rows,
        shown,
        (value) => {
          this.restoreEditor();
          select(value);
        },
        () => this.restoreEditor(),
      ),
    );
  }

  updateAgents(rows: readonly AgentRow[]): void {
    if (!(this.selector instanceof AgentsPanel)) return;
    this.selector.update(rows);
    this.ui.requestRender();
  }

  /** Shows the goals list in the editor's place, with drilldown, until Esc, q or Ctrl-C closes it. */
  openGoals(goals: readonly GoalRow[], seen: (goal: Goal) => void): void {
    this.showSelector(
      new GoalsPanel(
        goals,
        seen,
        () => this.ui.terminal.rows,
        () => this.restoreEditor(),
      ),
    );
  }

  private restoreEditor(): void {
    this.selector = undefined;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.renderQueue();
  }

  /**
   * Lists the shown conversation's queue in the editor's place. Enter opens a message in the editor; a worker notice
   * opens only its body, and routing advice is not editable. Alt+S and Delete apply at once.
   */
  openQueue(): void {
    this.selector = new QueuePanel(
      this.queueItems,
      (item, action) => {
        if (action === "toggle")
          this.handlers.editQueued(item.id, {
            kind: "mode",
            mode: item.mode === "steer" ? "followUp" : "steer",
          });
        else if (action === "delete") this.handlers.editQueued(item.id, { kind: "delete" });
        else if (escalationSummary(item.text) === undefined) {
          this.editing = { id: item.id, draft: this.editor.getText() };
          this.restoreEditor();
          this.editor.setText(parseWorkerNotice(item.text)?.text ?? item.text);
          this.showMode();
        }
      },
      () => this.restoreEditor(),
    );
    this.editorContainer.clear();
    this.editorContainer.addChild(this.selector);
    this.ui.setFocus(this.selector);
    // The panel lists the queue; the dock would repeat it.
    this.renderQueue();
  }

  /** Leave a queued message's edit, saved or not: the set-aside draft returns, then the queue reopens. */
  private endEdit(): void {
    this.editor.setText(this.editing?.draft ?? "");
    this.editing = undefined;
    this.showMode();
    this.openQueue();
  }

  private renderQueue(): void {
    this.queue.clear();
    if (!(this.selector instanceof QueuePanel)) {
      for (const item of this.queueItems)
        this.queue.addChild(new TruncatedText(queuedLine(item), 1, 0));
      if (this.queueItems.some((item) => item.mode !== "write"))
        this.queue.addChild(
          new TruncatedText(
            getSelectListTheme().description("↳ Alt+Q to edit, steer or delete"),
            1,
            0,
          ),
        );
    }
    this.ui.requestRender();
  }

  /** Put withdrawn queued messages back in the editor, oldest first, ahead of anything already typed. */
  restoreQueued(texts: readonly string[]): void {
    const combined = [...texts, this.editor.getText()].filter((text) => text.trim());
    this.editor.setText(combined.join("\n\n"));
    this.ui.requestRender();
  }

  /**
   * Steer mode is yellow on the editor's border and named in the footer; follow-up colors the border by the shown
   * conversation's thinking level, as Pi does.
   */
  private showMode(): void {
    const steer = this.mode === "steer";
    const color = steer ? "warning" : thinkingColor(this.footer.state.thinking);
    this.editor.borderColor = (text) => theme.fg(color, text);
    this.setFooter({ steer, editing: this.editing !== undefined });
  }

  /** Change footer fields; renders only when what it shows changed. */
  setFooter(change: Partial<FooterState>): void {
    const next = { ...this.footer.state, ...change };
    if (JSON.stringify(next) === JSON.stringify(this.footer.state)) return;
    this.footer.state = next;
    this.ui.requestRender();
  }

  /** Pi's startup header, placed as a notice so a view switch keeps it. */
  intro(home: string): void {
    this.notice(home, "intro");
  }

  notice(text: string, kind: NoticeKind = "system"): void {
    this.posted.push({ text, kind });
    this.chat.addChild(new Spacer(1));
    this.chat.addChild(new Text(noticeLine(text, kind), 1, 0));
    this.ui.requestRender();
  }

  setWorkers(items: readonly { name: string; status: AgentStatus }[]): void {
    // Every revision of any shown or worker view lands here; render only when the styled line changes.
    // Counts only: /agents lists every worker, and the footer names the one shown.
    const muted = getSelectListTheme().description;
    const counts = (["working", "idle"] as const).flatMap((status) => {
      const count = items.filter((item) => item.status === status).length;
      return count ? [statusText(status).replace(status, `${count} ${status}`)] : [];
    });
    const line = items.length
      ? `${muted("Workers · ")}${counts.join(muted(" · "))}${muted(" · /agents")}`
      : "";
    if (line === this.workersLine) return;
    this.workersLine = line;
    this.workers.clear();
    // A blank row keeps the bar apart from the last message's timestamp.
    if (line) {
      this.workers.addChild(new Spacer(1));
      this.workers.addChild(new TruncatedText(line, 1, 0));
    }
    this.ui.requestRender();
  }

  apply(view: ConversationView, selected?: string, force = false): void {
    // Worker revisions re-show the unchanged root view; skip the full-frame render it would cost.
    if (!force && view === this.applied) return;
    this.applied = view;
    const state = presentation(view);
    this.cwd = state.cwd ?? this.cwd;
    let rebuilt =
      force ||
      this.conversationId !== view.conversation.id ||
      this.renderedIds.some((id, index) => view.entries[index]?.id !== id);
    // A compaction commits a new head marker; a summary already shown, or shown on opening, is not news.
    const head = view.entries[0];
    const compacted =
      CompactionEntry.is(head) &&
      this.conversationId === view.conversation.id &&
      this.renderedIds.length > 0 &&
      !this.renderedIds.includes(head.id)
        ? head.data.reason
        : undefined;
    this.conversationId = view.conversation.id;
    if (
      state.partial === undefined &&
      this.streaming !== undefined &&
      !view.entries.slice(this.renderedIds.length).some((entry) => entry.kind === "pi.assistant")
    )
      rebuilt = true;
    // A notice follows the entries shown when it was posted; a rebuild, such as a view switch, moves it below the new ones.
    if (!rebuilt)
      for (const notice of this.posted.splice(0))
        this.notices.push({ ...notice, after: this.renderedIds.at(-1) });
    if (rebuilt) {
      this.chat.clear();
      this.cards.length = 0;
      this.workerMessages.length = 0;
      this.tools.clear();
      this.unfinished.clear();
      this.streamedCalls.clear();
      this.renderedIds = [];
      this.streaming = undefined;
      this.ui.resetTextSelection();
    }
    for (const entry of view.entries.slice(this.renderedIds.length)) {
      this.addEntry(entry);
      this.renderedIds.push(entry.id);
      // A rebuild puts each notice back after its entry; notices about entries no longer shown stay out.
      if (rebuilt)
        for (const notice of this.notices) {
          if (notice.after !== entry.id) continue;
          this.chat.addChild(new Spacer(1));
          this.chat.addChild(new Text(noticeLine(notice.text, notice.kind), 1, 0));
        }
    }
    if (rebuilt)
      for (const notice of this.posted.splice(0)) {
        this.chat.addChild(new Spacer(1));
        this.chat.addChild(new Text(noticeLine(notice.text, notice.kind), 1, 0));
        this.notices.push({ ...notice, after: this.renderedIds.at(-1) });
      }
    // The summary marker heads the transcript, far above the reader; say so where they are looking.
    if (compacted !== undefined) this.notice(`context compacted · ${compacted}`);
    if (state.partial !== undefined) {
      if (!this.streaming) {
        this.streaming = new Container();
        this.streamingText = "";
        this.chat.addChild(this.streaming);
      }
      // A revision often moves only tool or status state; re-parse the reply only when its text grew.
      if (state.partial !== this.streamingText) {
        this.streamingText = state.partial;
        this.streaming.clear();
        if (state.partial)
          this.streaming.addChild(new Markdown(state.partial, 1, 1, getMarkdownTheme()));
      }
      for (const call of state.calls) {
        this.tool(call.name, call.id, call.arguments, !this.streamedCalls.has(call.id));
        this.streamedCalls.add(call.id);
      }
    }
    for (const output of state.output) {
      const card = this.tool(output.name, output.id);
      card.setArgsComplete();
      if (output.text || output.details !== undefined)
        card.updatePartialOutput(output.text, output.details);
    }
    if (rebuilt) this.transcript.scrollToEnd();
    // Cache everything before the first entry a run may still change: the streaming reply or an unfinished card.
    // Cards report later changes themselves, so once the run is over even a card left without a result settles.
    if (!state.busy) this.unfinished.clear();
    for (const card of this.unfinished) if (card.finished) this.unfinished.delete(card);
    let settled = this.chat.children.length;
    for (const component of [this.streaming, ...this.unfinished]) {
      const index = component === undefined ? -1 : this.chat.children.lastIndexOf(component);
      if (index !== -1) settled = Math.min(settled, index);
    }
    this.chat.settle(settled);
    this.queueItems = state.queue;
    if (this.selector instanceof QueuePanel) this.selector.update(state.queue);
    this.renderQueue();
    if (state.status !== this.statusText) {
      this.statusText = state.status;
      this.loader?.stop();
      this.status.clear();
      this.loader = state.status
        ? new Loader(
            this.ui,
            (text) => getSelectListTheme().selectedText(text),
            (text) => getSelectListTheme().description(text),
            state.status,
          )
        : undefined;
      if (this.loader) this.status.addChild(this.loader);
    }
    this.setFooter({ cwd: this.cwd, worker: selected, model: state.model });
    // The alt screen rewrites every changed row; a forced render would clear the screen first and flash.
    this.showMode();
  }

  private addEntry(entry: EntryRecord): void {
    const worker = workerNotice(entry);
    const message = entry.model?.[0];
    if (worker) {
      const component = new WorkerMessageComponent(worker, shortId(entry.id), (changed) => {
        this.chat.changed(changed);
        this.ui.requestRender();
      });
      component.setExpanded(this.expanded);
      this.workerMessages.push(component);
      this.chat.addChild(new Spacer(1));
      this.chat.addChild(component);
    } else if (entry.kind === "pi.user" && message?.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      const assessment = escalationSummary(text);
      this.chat.addChild(new Spacer(1));
      this.chat.addChild(
        assessment === undefined
          ? new UserMessageComponent(text)
          : new Text(
              getSelectListTheme().description(`system · routing advice · ${assessment}`),
              1,
              0,
            ),
      );
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const container = this.streaming ?? new Container();
      if (!this.streaming) this.chat.addChild(container);
      container.clear();
      // Monchu's component never renders private thinking content.
      container.addChild(new AssistantMessageComponent(message));
      // When the reply was sent: the request start plus its duration, in local time.
      if (message.content.some((part) => part.type === "text" && part.text.trim()))
        container.addChild(
          new Text(
            getSelectListTheme().description(
              new Date(message.timestamp + (message.durationMs ?? 0)).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            ),
            1,
            0,
          ),
        );
      this.streaming = undefined;
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const streamed = this.streamedCalls.has(part.id);
        if (message.stopReason !== "toolUse" && !streamed) continue;
        const card = this.tool(part.name, part.id, part.arguments, !streamed);
        card.setArgsComplete();
        if (message.stopReason !== "toolUse")
          card.updateResult(
            {
              content: [{ type: "text", text: "Not run: the answer was interrupted." }],
              isError: true,
            },
            false,
          );
      }
      this.streamedCalls.clear();
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      this.tool(message.toolName, message.toolCallId).updateResult(message);
    } else if (entry.kind === "pi.compaction") {
      this.chat.addChild(new Spacer(1));
      this.chat.addChild(
        new Text(getSelectListTheme().description("[Earlier context summarized]"), 1, 0),
      );
    } else if (entry.kind === "pi.reset") {
      this.chat.addChild(new Text(getSelectListTheme().description("[New context]"), 1, 0));
    }
  }

  private tool(name: string, id: string, args?: unknown, fresh = false): ToolExecutionComponent {
    const existing = fresh ? undefined : this.tools.get(id);
    if (existing) {
      if (args !== undefined) existing.updateArgs(args);
      return existing;
    }
    const card = new ToolExecutionComponent(name, args ?? {}, this.ui, this.cwd, (changed) =>
      this.chat.changed(changed),
    );
    this.unfinished.add(card);
    card.setExpanded(this.expanded);
    this.chat.addChild(card);
    this.cards.push(card);
    this.tools.set(id, card);
    return card;
  }
}
