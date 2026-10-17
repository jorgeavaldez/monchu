/**
 * The transcript: committed entries render once and are reused while their immutable Durable record is unchanged, so a
 * streaming token re-renders only the live tail. Tool calls fold to one line and worker reports to a header and a few
 * lines, as in the terminal; a click toggles one, and the expand-all switch opens every one.
 */
import { useSignal } from "@preact/signals";
import { Fragment, type ComponentChildren, type VNode } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { messageParts } from "../api/attachments.ts";
import {
  escalationSummary,
  skillInvocation,
  systemNoticeSummary,
  workerNotice,
} from "../api/notices.ts";
import { addressable, sentAt, ShortIds, stamp } from "../ui/ids.ts";
import { presentation } from "../ui/state.ts";
import { UserAttachments } from "./attachments.tsx";
import { Markdown } from "./markdown.tsx";
import { expandAll, following, notices, rootId, type Notice } from "./state.ts";

const PREVIEW_LINES = 4;

/** Plain text with links made clickable: what the user typed, tool output and notices. */
function Text({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g)) {
    parts.push(text.slice(last, match.index));
    parts.push(
      <a href={match[0]} target="_blank" rel="noreferrer noopener">
        {match[0]}
      </a>,
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function textOf(content: UserMessage["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}

/**
 * A card that shows a header and its first few lines as the screen wraps them, and everything when open. It folds when
 * there is more to show: more lines than the preview, or fewer that wrap past it, such as a one-paragraph report.
 */
function Card(props: {
  kind: string;
  header: ComponentChildren;
  body: string;
  stamp?: ComponentChildren;
  error?: boolean;
  /** Lines shown while collapsed; none shows the header alone. */
  preview?: number;
}) {
  const open = useSignal<boolean | undefined>(undefined);
  const preview = props.preview ?? PREVIEW_LINES;
  const lines = props.body.split("\n");
  // Whether the clamped preview hides wrapped lines; measured once it is laid out.
  const clipped = useSignal(false);
  const text = useRef<HTMLDivElement>(null);
  const long = lines.length > preview || clipped.value;
  const expanded = open.value ?? expandAll.value;
  const folded = long && !expanded;
  useLayoutEffect(() => {
    const element = text.current;
    if (!expanded && element !== null) clipped.value = element.scrollHeight > element.clientHeight;
  });
  return (
    <section
      class={`card ${props.kind}${props.error === true ? " error" : ""}`}
      onClick={(event) => {
        if (!long || (event.target instanceof HTMLElement && event.target.closest("a"))) return;
        open.value = !expanded;
      }}
    >
      <header>
        {long ? (expanded ? "▾ " : "▸ ") : ""}
        {props.header}
        {folded && preview === 0 ? (
          <span class="help">
            {" "}
            · {lines.length} line{lines.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {props.stamp === undefined ? null : <> · {props.stamp}</>}
      </header>
      {props.body && !(folded && preview === 0) ? (
        <div
          ref={text}
          class={expanded ? "body" : "body clamp"}
          style={expanded ? undefined : { WebkitLineClamp: preview }}
        >
          {/* Folded, only the lines it can show: a long report never lays out unseen. */}
          <Markdown text={expanded ? props.body : lines.slice(0, preview).join("\n")} />
        </div>
      ) : null}
      {folded && preview > 0 && lines.length > preview ? (
        <footer>{`… ${lines.length - preview} more line${lines.length - preview === 1 ? "" : "s"}`}</footer>
      ) : null}
    </section>
  );
}

/** A tool call's arguments in a few words, as the terminal heads its card: the plain values, not the JSON around them. */
function argSummary(args: unknown): string {
  if (typeof args !== "object" || args === null) return JSON.stringify(args) ?? "";
  return Object.values(args)
    .flatMap((value) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [String(value)]
        : [],
    )
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * A tool call and its result, folded to one line as in the terminal: its name, its arguments in a few words, and the
 * output's first line (the newest one while it runs). A tap, or expand all, shows the arguments and all the output.
 */
function ToolCard(props: {
  name: string;
  args: unknown;
  result: ToolResultMessage | undefined;
  running: string | undefined;
}) {
  const open = useSignal<boolean | undefined>(undefined);
  const expanded = open.value ?? expandAll.value;
  const output = props.result === undefined ? (props.running ?? "") : textOf(props.result.content);
  const lines = output.split("\n").filter((line) => line.trim());
  const line = props.result === undefined ? lines.at(-1) : lines[0];
  const error = props.result?.isError === true;
  return (
    <section class={`tool${error ? " error" : ""}${props.result === undefined ? " running" : ""}`}>
      <button
        type="button"
        class="row"
        aria-expanded={expanded}
        onClick={() => {
          open.value = !expanded;
        }}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> <b>{props.name}</b>{" "}
        <span class="args">{argSummary(props.args)}</span>
        {line === undefined || expanded ? null : <span class="out"> · {line}</span>}
      </button>
      {expanded ? (
        <>
          <pre class="args">{JSON.stringify(props.args, null, 2)}</pre>
          {output ? (
            <pre>
              <Text text={output} />
            </pre>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** When an entry was sent and its short id, the unique prefix highlighted as jj does. */
function Stamp(props: { entry: EntryRecord; ids: ShortIds }) {
  const { unique, rest } = props.ids.split(props.entry.id);
  return (
    <span class="stamp">
      {stamp(sentAt(props.entry) ?? 0)} · <span class="prefix">{unique}</span>
      {rest}
    </span>
  );
}

function Assistant(props: {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  stamp: ComponentChildren;
}) {
  return (
    <>
      {props.message.content.map((part) => {
        if (part.type === "text")
          return part.text.trim() ? (
            <div class="assistant">
              <Markdown text={part.text} />
            </div>
          ) : null;
        if (part.type === "toolCall")
          return (
            <ToolCard
              key={part.id}
              name={part.name}
              args={part.arguments}
              result={props.results.get(part.id)}
              running={undefined}
            />
          );
        // Thinking stays private, as in the terminal.
        return null;
      })}
      {props.stamp}
      {props.message.stopReason === "error" ? (
        <div class="system warning">reply failed · {props.message.errorMessage ?? "error"}</div>
      ) : null}
    </>
  );
}

/** One committed entry; cached by its immutable record (and its tool results'), so unchanged entries never re-render. */
function entryNode(
  entry: EntryRecord,
  results: Map<string, ToolResultMessage>,
  ids: ShortIds,
): VNode | null {
  const shown = addressable(entry) ? <Stamp entry={entry} ids={ids} /> : undefined;
  const notice = workerNotice(entry);
  if (notice !== undefined)
    return (
      <Card
        kind={notice.status === "update" ? "update" : "report"}
        header={
          <>
            <b>{notice.name}</b>
            {notice.status === "failed" ? <span class="failed"> · failed</span> : null}
          </>
        }
        stamp={shown}
        body={notice.text}
      />
    );
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") {
    const { text, files, images } = messageParts(message.content);
    const escalation = escalationSummary(text);
    if (escalation !== undefined) return <div class="system">clef · escalated · {escalation}</div>;
    const system = systemNoticeSummary(text);
    if (system !== undefined) return <div class="system">system · {system}</div>;
    // A skill's instructions stay folded under its name; what the user typed with it shows as usual.
    const skill = skillInvocation(text);
    if (skill !== undefined)
      return (
        <>
          <Card kind="skill" header={<b>/skill:{skill.name}</b>} body={skill.body} preview={0} />
          {skill.text || files.length > 0 || images.length > 0 ? (
            <div class="user">
              <Text text={skill.text} />
              <UserAttachments files={files} images={images} />
            </div>
          ) : null}
          <div class="meta">{shown}</div>
        </>
      );
    return (
      <>
        <div class="user">
          {/* Typed text stays as written; a fenced block says markdown is meant. */}
          {/^ {0,3}(```|~~~)/m.test(text) ? <Markdown text={text} /> : <Text text={text} />}
          <UserAttachments files={files} images={images} />
        </div>
        <div class="meta">{shown}</div>
      </>
    );
  }
  if (entry.kind === "pi.assistant" && message?.role === "assistant")
    return (
      <Assistant
        message={message}
        results={results}
        stamp={shown === undefined ? null : <div class="meta">{shown}</div>}
      />
    );
  if (entry.kind === "pi.compaction") return <div class="system">context compacted</div>;
  if (entry.kind === "pi.reset") return <div class="system">new context</div>;
  return null;
}

const cache = new WeakMap<EntryRecord, { results: string; node: VNode | null }>();
// Each conversation's shown short ids; a new one can lengthen a neighbour's unique prefix, which re-renders it.
const shortIds = new Map<ConversationView["conversation"]["id"], ShortIds>();

function NoticeLine({ item }: { item: Notice }) {
  return (
    <pre class={`notice ${item.kind}`}>
      <span class="time">{new Date(item.at).toTimeString().slice(0, 5)} </span>
      <Text text={item.text} />
    </pre>
  );
}

/** Notices placed by time in a conversation they weren't posted beside, kept so later entries always go below them. */
const placed = new WeakMap<Notice, Map<ConversationView["conversation"]["id"], number>>();

/**
 * The entry a notice follows in `view`: the newest one shown when it was posted, or for a conversation not attached
 * then, the last one sent before it. A leading compaction marker sits in front whatever its id, so it never counts.
 */
function anchor(item: Notice, view: ConversationView): number {
  const key = view.conversation.id;
  const known = item.after.get(key) ?? placed.get(item)?.get(key);
  if (known !== undefined) return known;
  let found = -1;
  let latest = 0;
  for (const [index, entry] of view.entries.entries()) {
    if (index === 0 && entry.head !== undefined) continue;
    latest = Math.max(latest, sentAt(entry) ?? latest);
    if (latest > item.at) break;
    found = entry.id;
  }
  const map = placed.get(item) ?? new Map<ConversationView["conversation"]["id"], number>();
  map.set(key, found);
  placed.set(item, map);
  return found;
}

/** Whether the reader is at the newest line, give or take a line, so new content keeps them there. */
const AT_END = 48;

/** One conversation's transcript; keyed by the conversation, so another one starts at its end. */
export function Transcript({ view }: { view: ConversationView }) {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of view.entries)
    for (const message of entry.model ?? [])
      if (message.role === "toolResult") results.set(message.toolCallId, message);
  const ids = shortIds.get(view.conversation.id) ?? new ShortIds();
  shortIds.set(view.conversation.id, ids);
  const shown = view.entries.filter(addressable);
  for (const entry of shown) ids.add(entry.id);
  const prefixes = new Map(shown.map((entry) => [entry.id, ids.split(entry.id).unique.length]));
  // Notices go in among the entries in the order things happened; anything newer comes below them.
  const pending = notices.value
    .filter((item) => item.root === undefined || item.root === rootId.value)
    .map((item) => ({ item, after: anchor(item, view) }))
    .toSorted((x, y) => x.after - y.after);
  const nodes: ComponentChildren[] = [];
  const flush = (before: number) => {
    while (pending[0] !== undefined && pending[0].after < before) {
      const { item } = pending[0];
      pending.shift();
      nodes.push(<NoticeLine key={`n${item.id}`} item={item} />);
    }
  };
  for (const [index, entry] of view.entries.entries()) {
    if (index > 0 || entry.head === undefined) flush(entry.id);
    const calls =
      entry.kind === "pi.assistant"
        ? (entry.model ?? [])
            .flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
                : [],
            )
            .map((id) => (results.has(id) ? "1" : "0"))
            .join("")
        : "";
    const key = `${calls}:${prefixes.get(entry.id) ?? 0}`;
    const cached = cache.get(entry);
    let node = cached?.node;
    if (cached === undefined || cached.results !== key) {
      node = entryNode(entry, results, ids);
      cache.set(entry, { results: key, node });
    }
    nodes.push(<Fragment key={entry.id}>{node}</Fragment>);
  }
  flush(Infinity);
  const live = presentation(view);
  const count = nodes.length;
  const main = useRef<HTMLElement>(null);
  // Follow the newest line while the reader is at it. Reading back (a wheel, drag, touch or key scroll up) stops that
  // and never moves the view again until they scroll back down to the end or tap the pill; layout alone never stops it.
  const follow = useRef({ count: 0, top: 0, pressed: false, touch: 0 });
  follow.current.count = count;
  /** How many items there were when the reader left the end; undefined while following. */
  const left = useSignal<number | undefined>(undefined);
  const toEnd = () => {
    const element = main.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  };
  // The end moves when an item arrives or grows (a streamed reply, a card sizing on first paint) and when the editor
  // grows. Watched once, after layout, so neither a render nor a keystroke forces a layout of its own.
  useLayoutEffect(() => {
    const element = main.current;
    if (element === null) return;
    const sized = new ResizeObserver(() => {
      if (left.peek() === undefined) toEnd();
    });
    sized.observe(element);
    for (const child of element.children) sized.observe(child);
    const items = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) sized.observe(node);
        for (const node of record.removedNodes) if (node instanceof Element) sized.unobserve(node);
      }
    });
    items.observe(element, { childList: true });
    return () => {
      items.disconnect();
      sized.disconnect();
    };
  }, []);
  useEffect(() => {
    const stop = following.subscribe(() => {
      left.value = undefined;
      toEnd();
    });
    return stop;
  }, []);
  const reading = () => {
    if (left.value === undefined) left.value = follow.current.count;
  };
  const unread = left.value === undefined ? 0 : count - left.value;
  const streaming = live.partial !== undefined || live.calls.length > 0;
  return (
    <main
      class="transcript"
      ref={main}
      // Focusable, so a keyboard can scroll it.
      tabIndex={0}
      aria-label="transcript"
      onWheel={(event) => {
        if (event.deltaY < 0) reading();
      }}
      onTouchStart={(event) => {
        follow.current.touch = event.touches[0]?.clientY ?? 0;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY ?? 0;
        if (y > follow.current.touch) reading();
        follow.current.touch = y;
      }}
      onPointerDown={() => {
        follow.current.pressed = true;
      }}
      onPointerUp={() => {
        follow.current.pressed = false;
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) reading();
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const state = follow.current;
        const down = element.scrollTop > state.top;
        state.top = element.scrollTop;
        const end = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END;
        // Only the reader moving down reaches the end again; a smooth scroll up starts there too.
        if (end && down) left.value = undefined;
        else if (!down && state.pressed && !end) reading();
      }}
    >
      {nodes}
      {live.partial ? (
        <div class="assistant live">
          <Markdown text={live.partial} />
        </div>
      ) : null}
      {live.calls
        .filter((call) => !results.has(call.id))
        .map((call) => (
          <ToolCard
            key={call.id}
            name={call.name}
            args={call.arguments}
            result={undefined}
            running={live.output.find((output) => output.id === call.id)?.text}
          />
        ))}
      {live.status ? <div class="status">{live.status}</div> : null}
      {left.value !== undefined && (unread > 0 || streaming) ? (
        <button
          class="unread"
          onClick={() => {
            left.value = undefined;
            toEnd();
          }}
        >
          ↓ {unread > 0 ? `${unread} new` : "new output"}
        </button>
      ) : null}
    </main>
  );
}
