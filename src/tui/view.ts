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
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  getSelectListTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
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
  TuiAltScreen,
  VStack,
  type Focusable,
  type SelectItem,
  type Terminal,
} from "@earendil-works/pi-tui";
import { ESCALATION_PREFIX } from "../classifier.ts";
import { workerNotice } from "../workers.ts";
import { commands } from "./commands.ts";
import { presentation } from "./state.ts";

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
    const list = new SelectList(items, 6, getSelectListTheme());
    list.onSelect = (item) => this.select(item.value);
    list.onCancel = this.cancel;
    this.listContainer.clear();
    this.listContainer.addChild(list);
    return list;
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
  private readonly chat = new Container();
  private readonly workers = new Container();
  private readonly queue = new Container();
  private readonly status = new Container();
  private readonly editorContainer = new Container();
  private readonly footer = new Container();
  private readonly editor: Editor;
  private readonly transcript: ScrollView;
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly cards: ToolExecutionComponent[] = [];
  private readonly streamedCalls = new Set<string>();
  private readonly renderers = new Map<
    string,
    ConstructorParameters<typeof ToolExecutionComponent>[4]
  >();
  private readonly notices: string[] = [];
  private renderedIds: number[] = [];
  private streaming: Container | undefined;
  private loader: Loader | undefined;
  private statusText = "";
  private expanded = false;
  private selector: AgentSelector | undefined;
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
    this.ui = new TuiAltScreen(terminal, true, home);
    // Exported definitions include Pi's renderers. Their execution functions are never used here.
    for (const definition of [
      createReadToolDefinition(home),
      createWriteToolDefinition(home),
      createEditToolDefinition(home),
      createBashToolDefinition(home),
      createPowerShellToolDefinition(home),
      createGrepToolDefinition(home),
      createFindToolDefinition(home),
      createLsToolDefinition(home),
    ])
      this.renderers.set(definition.name, definition);
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
      if (matchesKey(data, "ctrl+c")) {
        handlers.abort();
        return { consume: true };
      }
      if (this.selector) return;
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
    this.discardTools();
    this.ui.stop();
  }

  private discardTools(): void {
    // Bash renderer timers must be stopped even when a view is switched mid-call.
    for (const card of this.cards) card.updateResult({ content: [], isError: false }, false);
    this.cards.length = 0;
    this.tools.clear();
    this.streamedCalls.clear();
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

  private restoreEditor(): void {
    this.selector = undefined;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  notice(text: string): void {
    this.notices.push(text);
    this.chat.addChild(new Spacer(1));
    this.chat.addChild(new Text(getSelectListTheme().description(`system · ${text}`), 1, 0));
    this.ui.requestRender();
  }

  setWorkers(
    items: readonly { name: string; busy: boolean }[],
    selected: string | undefined,
  ): void {
    this.workers.clear();
    if (items.length)
      this.workers.addChild(
        new TruncatedText(
          getSelectListTheme().description(
            `Workers · ${items.map((item) => `${item.name}${selected === item.name ? " (shown)" : ""}: ${item.busy ? "working" : "idle"}`).join(" · ")} · /agents`,
          ),
          1,
          0,
        ),
      );
    this.ui.requestRender();
  }

  apply(view: ConversationView, selected?: string, force = false): void {
    const state = presentation(view);
    this.cwd = state.cwd ?? this.cwd;
    let rebuilt =
      force ||
      this.conversationId !== view.conversation.id ||
      this.renderedIds.some((id, index) => view.entries[index]?.id !== id);
    this.conversationId = view.conversation.id;
    if (
      state.partial === undefined &&
      this.streaming !== undefined &&
      !view.entries.slice(this.renderedIds.length).some((entry) => entry.kind === "pi.assistant")
    )
      rebuilt = true;
    if (rebuilt) {
      this.chat.clear();
      this.discardTools();
      this.renderedIds = [];
      this.streaming = undefined;
      this.ui.resetTextSelection();
    }
    for (const entry of view.entries.slice(this.renderedIds.length)) {
      this.addEntry(entry);
      this.renderedIds.push(entry.id);
    }
    if (state.partial !== undefined) {
      if (!this.streaming) {
        this.streaming = new Container();
        this.chat.addChild(this.streaming);
      }
      this.streaming.clear();
      if (state.partial)
        this.streaming.addChild(new Markdown(state.partial, 1, 1, getMarkdownTheme()));
      for (const call of state.calls) {
        this.tool(call.name, call.id, call.arguments, !this.streamedCalls.has(call.id));
        this.streamedCalls.add(call.id);
      }
    }
    for (const output of state.output) {
      const card = this.tool(output.name, output.id);
      card.setArgsComplete();
      card.markExecutionStarted();
      if (output.text || output.details !== undefined)
        card.updateResult(
          {
            content: [{ type: "text", text: output.text }],
            details: output.details,
            isError: false,
          },
          true,
        );
    }
    if (rebuilt) {
      for (const text of this.notices) {
        this.chat.addChild(new Spacer(1));
        this.chat.addChild(new Text(getSelectListTheme().description(`system · ${text}`), 1, 0));
      }
      this.transcript.scrollToEnd();
    }
    this.queue.clear();
    for (const line of state.queue)
      this.queue.addChild(new TruncatedText(getSelectListTheme().description(line), 1, 0));
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
          `${selected === undefined ? "root" : `worker: ${selected}`} · ${state.model} · /agents · /help · ${this.cwd}`,
        ),
        1,
        0,
      ),
    );
    this.ui.requestRender(rebuilt);
  }

  private addEntry(entry: EntryRecord): void {
    const worker = workerNotice(entry);
    const message = entry.model?.[0];
    if (worker) {
      this.chat.addChild(new Spacer(1));
      this.chat.addChild(
        new Text(
          getSelectListTheme().selectedText(`worker · ${worker.name} · ${worker.status}`),
          1,
          0,
        ),
      );
      this.chat.addChild(new Markdown(worker.text, 1, 0, getMarkdownTheme()));
    } else if (entry.kind === "pi.user" && message?.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      this.chat.addChild(new Spacer(1));
      this.chat.addChild(
        text.startsWith(ESCALATION_PREFIX)
          ? new Text(
              getSelectListTheme().description(`system · escalation · ${text.split("\n", 1)[0]}`),
              1,
              0,
            )
          : new UserMessageComponent(text),
      );
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const container = this.streaming ?? new Container();
      if (!this.streaming) this.chat.addChild(container);
      container.clear();
      // Thinking is private: even a clickable Pi thinking block must not reveal its content.
      container.addChild(
        new AssistantMessageComponent(
          { ...message, content: message.content.filter((part) => part.type !== "thinking") },
          true,
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
    const card = new ToolExecutionComponent(
      name,
      id,
      args ?? {},
      {},
      this.renderers.get(name),
      this.ui,
      this.cwd,
    );
    card.setExpanded(this.expanded);
    this.chat.addChild(card);
    this.cards.push(card);
    this.tools.set(id, card);
    return card;
  }
}
