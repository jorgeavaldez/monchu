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
import { AssistantMessageComponent } from "./components/assistant-message.ts";
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
  ScrollView,
  SelectList,
  Spacer,
  Text,
  TruncatedText,
  truncateToWidth,
  TuiAltScreen,
  VStack,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { escalationSummary } from "../classifier.ts";
import { parseWorkerNotice, workerNotice } from "../workers.ts";
import { commands } from "./commands.ts";
import { presentation, type QueuedItem } from "./state.ts";

/**
 * What a chat notice reports: Monchu's own status, or input delivered to a worker. A delivery says `start` or
 * `message`, never `steer`: whether it steers a run depends on the worker's state when it arrives, not when it is sent.
 */
type NoticeKind = "system" | "start" | "message";

/** A notice's styled line: a delivery has a yellow rule and label, as queued input does in the dock. */
function noticeLine(text: string, kind: NoticeKind): string {
  const muted = getSelectListTheme().description;
  return kind === "system"
    ? muted(`system · ${text}`)
    : `${theme.fg("warning", `│ ${kind}`)}${muted(` · ${text}`)}`;
}

/** The first line of a text, marked when more follows: dock rows show one line each. */
function firstLine(text: string): string {
  const [line = "", ...rest] = text.trim().split(/\r\n|\r|\n/);
  return rest.length ? `${line} …` : line;
}

/**
 * A queued inbox row: input waiting for a boundary has a yellow rule and its mode, then its source when it is not the
 * user's own text, then its first line; a passive write stays muted.
 */
function queuedLine(item: QueuedItem): string {
  const muted = getSelectListTheme().description;
  if (item.mode === "write") return muted(`│ write · ${item.text}`);
  const worker = parseWorkerNotice(item.text);
  const assessment = worker === undefined ? escalationSummary(item.text) : undefined;
  const source =
    worker !== undefined
      ? `${worker.name} ${worker.status === "completed" ? "reply" : worker.status} · `
      : assessment !== undefined
        ? "effort assessment · "
        : "";
  const text = worker?.text ?? assessment ?? item.text;
  return `${theme.fg("warning", `│ ${item.mode === "steer" ? "steer" : "follow-up"}`)}${muted(
    ` · ${source}${firstLine(text)}`,
  )}`;
}

class AgentSelector extends Container implements Focusable {
  readonly input = new Input();
  readonly listContainer = new Container();
  list: SelectList;

  readonly items: SelectItem[];
  readonly select: (value: string) => void;
  readonly cancel: () => void;

  constructor(items: SelectItem[], select: (value: string) => void, cancel: () => void) {
    super();
    this.items = items;
    this.select = select;
    this.cancel = cancel;
    this.addChild(new Text("View and talk to (Esc to cancel):", 1, 0));
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
    // Every agent stays visible, so the menu is the full list behind the dock's compact counts.
    const list = new SelectList(items, Math.max(1, this.items.length), getSelectListTheme());
    list.onSelect = (item) => this.select(item.value);
    list.onCancel = this.cancel;
    this.listContainer.clear();
    this.listContainer.addChild(list);
    return list;
  }
}

/**
 * Read-only text pinned in the editor's place, as the agent menu is: never transcript. Each source line wraps under
 * its own indent; long text scrolls within a height capped by the terminal, re-measured every frame.
 */
class TextPanel implements Component, Focusable {
  focused = false;
  private readonly title: string;
  private readonly lines: string[];
  private readonly rows: () => number;
  private readonly close: () => void;
  private offset = 0;
  private visible = 1;

  constructor(title: string, text: string, rows: () => number, close: () => void) {
    this.title = title;
    this.lines = text.split(/\r\n|\r|\n/);
    this.rows = rows;
    this.close = close;
  }

  render(width: number): string[] {
    const theme = getSelectListTheme();
    const body = this.lines.flatMap((line) => {
      const indent = " ".repeat(line.length - line.trimStart().length);
      const wrapped = wrapTextWithAnsi(line.trimStart(), Math.max(1, width - 2 - indent.length));
      return wrapped.map((part) => truncateToWidth(` ${indent}${part}`, width, ""));
    });
    // The whole panel, with its rules, title and hint, takes at most 60% of the rows; the transcript keeps the rest.
    this.visible = Math.max(3, Math.min(body.length, Math.floor(this.rows() * 0.6) - 4));
    this.offset = Math.max(0, Math.min(this.offset, body.length - this.visible));
    const scroll =
      body.length > this.visible
        ? ` · ${this.offset + 1}-${this.offset + this.visible} of ${body.length} · ↑↓ PgUp PgDn`
        : "";
    const rule = theme.description("─".repeat(width));
    return [
      rule,
      truncateToWidth(` ${theme.selectedText(this.title)}`, width, "..."),
      ...body.slice(this.offset, this.offset + this.visible),
      truncateToWidth(theme.description(` Esc to close${scroll}`), width, "..."),
      rule,
    ];
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up")) this.offset -= 1;
    else if (keys.matches(data, "tui.select.down")) this.offset += 1;
    else if (keys.matches(data, "tui.select.pageUp")) this.offset -= this.visible;
    else if (keys.matches(data, "tui.select.pageDown")) this.offset += this.visible;
    else if (
      keys.matches(data, "tui.select.cancel") ||
      keys.matches(data, "tui.select.confirm") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    )
      this.close();
    // render clamps the offset to the content it measures.
    this.offset = Math.max(0, this.offset);
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

/** Pi's viewport/editor/message components over committed Durable views. No agent loop lives here. */
export class MonchuTui {
  readonly ui: TuiAltScreen;
  private readonly chat = new Transcript();
  private readonly workers = new Container();
  private readonly queue = new Container();
  private readonly status = new Container();
  private readonly editorContainer = new Container();
  private readonly footer = new Container();
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
  private readonly loginStatus = new Container();
  private readonly loginPrompt = new Container();
  private conversationId: number | undefined;
  private cwd: string;

  constructor(
    terminal: Terminal,
    home: string,
    handlers: { submit(text: string): void; abort(): void; exit(): void },
  ) {
    this.cwd = home;
    // As in Pi, the editor draws its own cursor; a shown hardware cursor is moved and re-shown every frame.
    this.ui = new TuiAltScreen(terminal, false, home);
    this.editor = new Editor(
      this.ui,
      {
        borderColor: (text) => getSelectListTheme().selectedText(text),
        selectList: getSelectListTheme(),
      },
      { paddingX: 1 },
    );
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        Object.keys(commands).map((command) => ({ name: command.slice(1) })),
        home,
      ),
    );
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return;
      this.editor.addToHistory(text);
      this.editor.setText("");
      handlers.submit(text);
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
    this.ui.addInputListener((data) => {
      if (this.loginCancel !== undefined) {
        if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
          this.loginCancel();
          return { consume: true };
        }
        return;
      }
      if (this.selector) return;
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
        handlers.abort();
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

  loginMessage(message: string): void {
    this.loginStatus.clear();
    this.loginStatus.addChild(new Text(message, 1, 0));
    this.ui.requestRender();
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
    this.loginStatus.clear();
    this.loginPrompt.clear();
    this.restoreEditor();
  }

  selectAgents(items: SelectItem[], select: (value: string) => void): void {
    this.selector = new AgentSelector(
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

  /** Shows read-only text pinned above the footer until Esc, Enter, q or Ctrl-C closes it. */
  showPanel(title: string, text: string): void {
    this.selector = new TextPanel(
      title,
      text,
      () => this.ui.terminal.rows,
      () => this.restoreEditor(),
    );
    this.editorContainer.clear();
    this.editorContainer.addChild(this.selector);
    this.ui.setFocus(this.selector);
    this.ui.requestRender();
  }

  private restoreEditor(): void {
    this.selector = undefined;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  notice(text: string, kind: NoticeKind = "system"): void {
    this.posted.push({ text, kind });
    this.chat.addChild(new Spacer(1));
    this.chat.addChild(new Text(noticeLine(text, kind), 1, 0));
    this.ui.requestRender();
  }

  setWorkers(items: readonly { name: string; busy: boolean }[]): void {
    // Every revision of any shown or worker view lands here; render only when the styled line changes.
    // Counts only: /agents lists every worker, and the footer names the one shown.
    const working = items.filter((item) => item.busy).length;
    const counts = [
      ...(items.length > working ? [`${items.length - working} idle`] : []),
      ...(working ? [`${working} working`] : []),
    ];
    const line = items.length
      ? getSelectListTheme().description(`Workers · ${counts.join(" · ")} · /agents`)
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
    this.queue.clear();
    for (const item of state.queue) this.queue.addChild(new TruncatedText(queuedLine(item), 1, 0));
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
    this.footer.clear();
    this.footer.addChild(
      new TruncatedText(
        getSelectListTheme().description(
          `${selected === undefined ? "root" : `worker: ${selected}`} · ${state.model} · ${this.cwd}`,
        ),
        1,
        0,
      ),
    );
    // The alt screen rewrites every changed row; a forced render would clear the screen first and flash.
    this.ui.requestRender();
  }

  private addEntry(entry: EntryRecord): void {
    const worker = workerNotice(entry);
    const message = entry.model?.[0];
    if (worker) {
      const component = new WorkerMessageComponent(worker, (changed) => {
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
          : new Text(getSelectListTheme().description(`system · escalation · ${assessment}`), 1, 0),
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
