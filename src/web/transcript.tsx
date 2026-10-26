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
  parseJobNotice,
  parseReply,
  skillInvocation,
  systemNoticeSummary,
  workerNotice,
} from "../api/notices.ts";
import { addressable, sentAt } from "../api/messages.ts";
import { clock, ShortIds, stamp } from "../ui/ids.ts";
import { presentation } from "../ui/state.ts";
import { UserAttachments } from "./attachments.tsx";
import { ranges } from "./fuzzy.ts";
import { Markdown } from "./markdown.tsx";
import type { InboxItem } from "../api/client.ts";
import { Briefer } from "./inbox.tsx";
import { run } from "./commands.ts";
import { type FeedRow, jumpTo, offerRows, offerScroll, type ScrollKind } from "./feed.ts";
import {
  expandAll,
  expandPresses,
  filter,
  following,
  inbox,
  notices,
  pins,
  rootId,
  shown as shownName,
  view as viewOf,
  type Filter,
  type Notice,
} from "./state.ts";

const PREVIEW_LINES = 4;

/** Whether a card is open, and a way to open or close it by hand until the next expand-all press. */
function useFold(): [boolean, (open: boolean) => void] {
  const own = useSignal<{ open: boolean; press: number } | undefined>(undefined);
  const mine = own.value?.press === expandPresses.value ? own.value.open : undefined;
  return [mine ?? expandAll.value, (open) => (own.value = { open, press: expandPresses.peek() })];
}

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
  const [expanded, setOpen] = useFold();
  const preview = props.preview ?? PREVIEW_LINES;
  const lines = props.body.split("\n");
  // Whether the clamped preview hides wrapped lines; measured once it is laid out.
  const clipped = useSignal(false);
  const text = useRef<HTMLDivElement>(null);
  const long = lines.length > preview || clipped.value;
  const folded = long && !expanded;
  useLayoutEffect(() => {
    const element = text.current;
    if (!expanded && element !== null) clipped.value = element.scrollHeight > element.clientHeight;
  });
  return (
    <section
      class={`card ${props.kind}${props.error === true ? " error" : ""}`}
      onClick={(event) => {
        if (!long || (event.target instanceof HTMLElement && event.target.closest("a, button")))
          return;
        setOpen(!expanded);
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
 * output's first line (the newest one while it runs), and any images it returned. A tap, or expand all, shows the
 * arguments and all the output.
 */
function ToolCard(props: {
  name: string;
  args: unknown;
  result: ToolResultMessage | undefined;
  running: string | undefined;
}) {
  const [expanded, setOpen] = useFold();
  const output = props.result === undefined ? (props.running ?? "") : textOf(props.result.content);
  const lines = output.split("\n").filter((line) => line.trim());
  const line = props.result === undefined ? lines.at(-1) : lines[0];
  const error = props.result?.isError === true;
  // An image a tool returned (a screenshot, a read picture) shows under its row, folded or not, as a sent one does.
  const images =
    typeof props.result?.content === "string"
      ? []
      : (props.result?.content ?? []).filter((part) => part.type === "image");
  return (
    <section class={`tool${error ? " error" : ""}${props.result === undefined ? " running" : ""}`}>
      <button
        type="button"
        class="row"
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded);
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
      <UserAttachments files={[]} images={images} />
    </section>
  );
}

/**
 * A job's event, or the message it wakes a worker with: a grey box folded to one line under a ⏱, which a tap opens to
 * its whole text. Its dotted box sets it apart from tool rows and workers' cards.
 */
function JobBox(props: { name: string; what: string; text: string; at: ComponentChildren }) {
  const [expanded, setOpen] = useFold();
  const line = props.text.split("\n").find((each) => each.trim());
  return (
    <section class="job">
      <button
        type="button"
        class="row"
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded);
        }}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"} ⏱</span> {props.at} <b>{props.name}</b>{" "}
        {props.what}
        {line === undefined || expanded ? null : <span class="out"> · {line}</span>}
      </button>
      {expanded && props.text ? (
        <pre>
          <Text text={props.text} />
        </pre>
      ) : null}
    </section>
  );
}

/** The star after a message's stamp: hollow until it is pinned, filled after; a tap pins or unpins it. */
function PinToggle({ code }: { code: string }) {
  const pinned = pins.value.some((pin) => pin.code === code);
  return (
    <button
      type="button"
      class={`pin${pinned ? " on" : ""}`}
      aria-label={pinned ? `unpin ${code}` : `pin ${code}`}
      aria-pressed={pinned}
      title={pinned ? "unpin (/pins lists pins)" : "pin, to find it again in /pins"}
      onClick={() => run("pin", code)}
    >
      {pinned ? "★" : "☆"}
    </button>
  );
}

/**
 * When an entry was sent and its short id, the unique prefix highlighted as jj does, and its pin. A front's message
 * takes a reply: tapping its id starts one in the editor.
 */
function Stamp(props: { entry: EntryRecord; ids: ShortIds; reply: boolean }) {
  const { code, unique, rest } = props.ids.split(props.entry.id);
  const id = (
    <>
      <span class="prefix">{unique}</span>
      {rest}
    </>
  );
  return (
    <span class="stamp" id={`m-${code}`}>
      {stamp(sentAt(props.entry) ?? 0)} ·{" "}
      {props.reply ? (
        <button
          type="button"
          class="code"
          title={`reply to ${code}`}
          onClick={() => run("reply", code)}
        >
          {id}
        </button>
      ) : (
        id
      )}{" "}
      <PinToggle code={code} />
    </span>
  );
}

const KIND_LABELS = { ask: "ask", milestone: "done", update: "update", reply: "reply" };

/** An inbox item's label after its stamp: kind, goal and an ask's state, with a way to reply to an open ask. */
function Label({ item, code }: { item: InboxItem; code: string }) {
  if (item.kind === undefined) return null;
  return (
    <>
      <span class={`label k-${item.kind}`}>
        {" · "}
        {KIND_LABELS[item.kind]}
        {item.goal ? ` · ${item.goal}` : ""}
        {item.state === undefined || item.state === "open"
          ? ""
          : ` · ${item.state === "answered" ? "replied" : item.state}`}
      </span>
      {item.kind === "ask" && item.state === "open" ? (
        <button type="button" class="reply" onClick={() => run("reply", code)}>
          reply
        </button>
      ) : null}
    </>
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
  item: InboxItem | undefined,
): VNode | null {
  const shown = addressable(entry) ? (
    <Stamp entry={entry} ids={ids} reply={item !== undefined} />
  ) : undefined;
  const notice = workerNotice(entry);
  if (notice !== undefined) {
    const card = (
      <Card
        kind={notice.status === "update" ? "update" : "report"}
        header={
          <>
            <b>{notice.name}</b>
            {notice.status === "failed" ? <span class="failed"> · failed</span> : null}
          </>
        }
        stamp={
          item === undefined ? (
            shown
          ) : (
            <>
              {shown}
              <Label item={item} code={ids.split(entry.id).code} />
            </>
          )
        }
        body={notice.text}
      />
    );
    // A plugin's ask on a worker's notice, such as a browser handoff, is marked like the front's own.
    return item?.kind === "ask" ? <div class={`askCard ${item.state ?? ""}`}>{card}</div> : card;
  }
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") {
    const { text, files, images } = messageParts(message.content);
    const system = systemNoticeSummary(text);
    if (system !== undefined) return <div class="system">system · {system}</div>;
    const job = parseJobNotice(text);
    if (job !== undefined)
      return <JobBox name={job.name} what={job.header} text={job.text} at={shown} />;
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
    // A /reply shows what the user wrote under a link to the message it replies to; the front gets the quote too.
    const reply = parseReply(text);
    if (reply !== undefined)
      return (
        <>
          <div class="user">
            <a class="ref" href={`#m-${reply.id}`}>
              ↩ #{reply.id}
            </a>{" "}
            <Text text={reply.text} />
          </div>
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
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const reply = (
      <Assistant
        message={message}
        results={results}
        stamp={
          shown === undefined ? null : (
            <div class="meta">
              {shown}
              {item === undefined ? null : <Label item={item} code={ids.split(entry.id).code} />}
            </div>
          )
        }
      />
    );
    // An open ask carries a bold bar so it stands out in the stream; answered or closed, a faint box.
    return item?.kind === "ask" ? <div class={`askCard ${item.state ?? ""}`}>{reply}</div> : reply;
  }
  if (entry.kind === "pi.compaction") return <div class="system">context compacted</div>;
  if (entry.kind === "pi.reset") return <div class="system">new context</div>;
  return null;
}

const cache = new WeakMap<EntryRecord, { results: string; node: VNode | null }>();
// Each conversation's shown short ids; a new one can lengthen a neighbour's unique prefix, which re-renders it.
const shortIds = new Map<ConversationView["conversation"]["id"], ShortIds>();

function NoticeLine({ item }: { item: Notice }) {
  const at = <span class="time">{clock(item.at)} </span>;
  if (item.job !== undefined)
    return (
      <JobBox
        name={item.job.job}
        what={`${item.job.kind}${item.job.worker === undefined ? "" : ` → ${item.job.worker}`}`}
        text={item.job.text}
        at={at}
      />
    );
  return (
    <pre class={`notice ${item.kind}`}>
      {at}
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

/** Whether an entry with this inbox label shows under `shown`, the feed's filter. */
function inFeed(shown: Filter, item: InboxItem | undefined): boolean {
  if (shown.kind === undefined && shown.goal === undefined) return true;
  return (
    item !== undefined &&
    (shown.kind === undefined || item.kind === shown.kind) &&
    (shown.goal === undefined || item.goal === shown.goal)
  );
}

/** The text under `nodes`, and a way back from a place in it to a DOM position. */
function domText(nodes: readonly Node[]): { text: string; at(index: number): [Text, number] } {
  const texts: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (const node of nodes) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let each: Node | null = walker.currentNode; each !== null; each = walker.nextNode()) {
      const node = each;
      if (!(node instanceof globalThis.Text)) continue;
      starts.push(text.length);
      texts.push(node);
      text += node.data;
    }
  }
  return {
    text,
    at(index) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((starts[middle] ?? 0) <= index) low = middle;
        else high = middle - 1;
      }
      const node = texts[low];
      if (node === undefined) throw new Error("no text");
      return [node, index - (starts[low] ?? 0)];
    },
  };
}

/** Each of `found` in `nodes`' text as a DOM range. */
function domRanges(nodes: readonly Node[], found: (text: string) => { at: number; end: number }[]) {
  const text = domText(nodes);
  return found(text.text).map(({ at, end }) => {
    const range = new Range();
    range.setStart(...text.at(at));
    range.setEnd(...text.at(end + 1));
    return range;
  });
}

/**
 * Show what a search matched, as vim's hlsearch does: the query's words wherever the feed shows them, and its match in
 * the message it went to brighter. Highlights paint over the text without changing it, so nothing re-renders; they
 * stay until the next search or Esc. A browser without the highlight API shows the message's mark alone.
 */
function markSearch(feed: HTMLElement, stamp: HTMLElement | null, query: string | undefined): void {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete("search");
  CSS.highlights.delete("search-current");
  if (stamp === null || query === undefined || query.trim() === "") return;
  // Each term as typed, everywhere it shows; its letters in order only where the message it went to has them.
  const words = query.split(/\s+/).filter(Boolean);
  CSS.highlights.set(
    "search",
    new Highlight(
      ...domRanges([feed], (text) => words.flatMap((word) => ranges(text, word, false))),
    ),
  );
  // The message's own nodes: the feed's children after the last one with another message's stamp, up to its own.
  let last: Node | null = stamp;
  while (last !== null && last.parentNode !== feed) last = last.parentNode;
  const nodes: Node[] = [];
  for (let node = last; node !== null; node = node.previousSibling) {
    if (node !== last && node instanceof Element && node.querySelector(".stamp") !== null) break;
    nodes.unshift(node);
  }
  CSS.highlights.set(
    "search-current",
    new Highlight(...domRanges(nodes, (text) => ranges(text, query))),
  );
}

/** Clear a search's highlights, as vim's `:noh` does. */
function clearSearchMarks(): void {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete("search");
  CSS.highlights.delete("search-current");
}

const rowText = new WeakMap<EntryRecord, { who: string; text: string; lower: string }>();

/** What search matches in an entry: what it says, and each tool call's name and arguments; cached by its immutable record. */
function searchText(entry: EntryRecord): { who: string; text: string; lower: string } {
  const known = rowText.get(entry);
  if (known !== undefined) return known;
  let who = "monchu";
  let text = "";
  const notice = workerNotice(entry);
  const message = entry.model?.[0];
  if (notice !== undefined) {
    who = notice.name;
    text = notice.text;
  } else if (message?.role === "user") {
    who = "you";
    text = messageParts(message.content).text;
    // A skill's instructions stay out, as they stay folded: its name and what was typed with it are searched.
    const skill = skillInvocation(text);
    if (skill !== undefined) text = `/skill:${skill.name} ${skill.text}`;
  } else if (message?.role === "assistant")
    text = message.content
      .map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "toolCall"
            ? `${part.name} ${argSummary(part.arguments)}`
            : "",
      )
      .filter(Boolean)
      .join("\n");
  const row = { who, text, lower: text.toLowerCase() };
  rowText.set(entry, row);
  return row;
}

/** The messages of the feed on screen, oldest first: the shown conversation, under the front's filter. */
function feedRows(): FeedRow[] {
  const name = shownName.value;
  const state = viewOf(name)?.value;
  if (state === undefined) return [];
  const front = name === undefined;
  const items = new Map(front ? inbox.value.map((item) => [item.entry, item]) : []);
  const shownFilter = front ? filter.value : {};
  const ids = shortIds.get(state.conversation.id);
  if (ids === undefined) return [];
  const rows: FeedRow[] = [];
  for (const entry of state.entries) {
    if (!addressable(entry) || !inFeed(shownFilter, items.get(entry.id))) continue;
    const { who, text, lower } = searchText(entry);
    if (text.trim() === "") continue;
    rows.push({ code: ids.split(entry.id).code, who, at: sentAt(entry) ?? 0, text, lower });
  }
  return rows;
}

offerRows(feedRows);

/** The front's open asks, newest first, by short id with their first words: what `/reply` completes. */
export function openAsks(): { code: string; text: string }[] {
  const state = viewOf(undefined)?.value;
  const ids = state === undefined ? undefined : shortIds.get(state.conversation.id);
  if (state === undefined || ids === undefined) return [];
  const open = new Set(
    inbox.value
      .filter((item) => item.kind === "ask" && item.state === "open")
      .map((item) => item.entry),
  );
  return state.entries
    .filter((entry) => open.has(entry.id))
    .toReversed()
    .map((entry) => ({
      code: ids.split(entry.id).code,
      text: searchText(entry).text.replace(/\s+/g, " "),
    }));
}

/** How the shown transcript scrolls for an action; set while one is on screen. */

/** Whether the reader is at the newest line, give or take a line, so new content keeps them there. */
const AT_END = 48;

/**
 * Where the reader was, read back once per page load: a page the phone dropped in the background, or one loaded anew
 * after an update, opens where they left it rather than at the end. The conversation, the message at the view's top and
 * how far below the top it sat, in this tab; none while following the end.
 */
let placeRead = false;

/** One conversation's transcript; keyed by the conversation, so another one starts at its end. */
export function Transcript({ view, front }: { view: ConversationView; front: boolean }) {
  // The front's stream is the root's inbox: each reply's label, and the person's filter.
  const items = new Map(front ? inbox.value.map((item) => [item.entry, item]) : []);
  const shownFilter = front ? filter.value : {};
  const filtered = shownFilter.kind !== undefined || shownFilter.goal !== undefined;
  const keep = (entry: EntryRecord) => inFeed(shownFilter, items.get(entry.id));
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
  if (shownFilter.goal !== undefined) nodes.push(<Briefer key="brief" id={shownFilter.goal} />);
  const flush = (before: number) => {
    while (pending[0] !== undefined && pending[0].after < before) {
      const { item } = pending[0];
      pending.shift();
      if (!filtered) nodes.push(<NoticeLine key={`n${item.id}`} item={item} />);
    }
  };
  let kept = 0;
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
    if (!keep(entry)) continue;
    kept++;
    const item = items.get(entry.id);
    const key = `${calls}:${prefixes.get(entry.id) ?? 0}:${item?.kind}:${item?.goal}:${item?.state}`;
    const cached = cache.get(entry);
    let node = cached?.node;
    if (cached === undefined || cached.results !== key) {
      node = entryNode(entry, results, ids, item);
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
  const follow = useRef({ count: 0, top: 0, height: 0, pressed: false, touching: false, touch: 0 });
  follow.current.count = count;
  /** How many items there were when the reader left the end; undefined while following. */
  const left = useSignal<number | undefined>(undefined);
  const toEnd = () => {
    const element = main.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  };
  // The end moves when an item arrives or grows (a streamed reply, a card sizing on first paint) and when the editor
  // grows. Watched once, after layout, so neither a render nor a keystroke forces a layout of its own. Reading back,
  // the box getting shorter or taller (the editor growing, a keyboard opening) keeps what sits at its bottom in place.
  useLayoutEffect(() => {
    const element = main.current;
    if (element === null) return;
    follow.current.height = element.clientHeight;
    const sized = new ResizeObserver(() => {
      const height = element.clientHeight;
      const shrunk = follow.current.height - height;
      follow.current.height = height;
      if (left.peek() === undefined) toEnd();
      else if (shrunk !== 0) element.scrollTop += shrunk;
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
  // After the first scroll to the end above.
  useEffect(() => {
    const element = main.current;
    if (element === null) return;
    if (!placeRead) {
      placeRead = true;
      const [conversation, id = "", offset] = (sessionStorage.getItem("place") ?? "").split(" ");
      const stamp = document.getElementById(id);
      if (
        conversation === String(view.conversation.id) &&
        stamp !== null &&
        element.contains(stamp)
      ) {
        left.value = follow.current.count;
        element.scrollTop +=
          stamp.getBoundingClientRect().top - element.getBoundingClientRect().top - Number(offset);
        follow.current.top = element.scrollTop;
      }
    }
    // Hidden (a phone may drop it from there) or leaving.
    const keep = (event: Event) => {
      if (event.type !== "pagehide" && document.visibilityState === "visible") return;
      sessionStorage.removeItem("place");
      // Following the end, a new load starts there anyway.
      if (left.peek() === undefined) return;
      const top = element.getBoundingClientRect().top;
      const stamp = [...element.querySelectorAll('[id^="m-"]')].find(
        (each) => each.getBoundingClientRect().bottom > top,
      );
      if (stamp !== undefined)
        sessionStorage.setItem(
          "place",
          `${view.conversation.id} ${stamp.id} ${stamp.getBoundingClientRect().top - top}`,
        );
    };
    addEventListener("visibilitychange", keep);
    addEventListener("pagehide", keep);
    return () => {
      removeEventListener("visibilitychange", keep);
      removeEventListener("pagehide", keep);
    };
  }, []);
  const reading = () => {
    if (left.value === undefined) left.value = follow.current.count;
  };
  /** Scroll to a message by id, as a #id backlink or a push names it; a filter hiding it is cleared first. */
  const jump = (code: string, retry = true) => {
    const target = document.getElementById(`m-${code}`);
    if (target === null) {
      if (retry && filtered) {
        run("feed.clear");
        requestAnimationFrame(() => jump(code, false));
      }
      return;
    }
    reading();
    target.scrollIntoView({ block: "center" });
  };
  useEffect(() => {
    const scroll = (kind: ScrollKind, step: 1 | -1) => {
      const element = main.current;
      if (element === null) return;
      if (kind === "end") {
        left.value = undefined;
        toEnd();
        return;
      }
      if (step < 0 || kind === "top") reading();
      const by =
        kind === "top" ? -element.scrollHeight : kind === "half" ? element.clientHeight / 2 : 48;
      element.scrollBy({ top: step * Math.abs(by) });
    };
    return offerScroll(scroll);
  }, []);
  useEffect(() => {
    // Esc that nothing else took (a menu, the prompt) clears the search's highlights.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) clearSearchMarks();
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, []);
  useEffect(
    () =>
      jumpTo.subscribe((wanted) => {
        if (wanted === undefined) return;
        jumpTo.value = undefined;
        jump(wanted.code);
        const target = document.getElementById(`m-${wanted.code}`);
        if (main.current !== null) markSearch(main.current, target, wanted.query);
        target?.classList.add("found");
        setTimeout(() => target?.classList.remove("found"), 2000);
      }),
    [],
  );
  useEffect(() => {
    const hash = location.hash;
    if (hash.startsWith("#m-")) requestAnimationFrame(() => jump(hash.slice(3)));
  }, []);
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
        follow.current.touching = true;
        follow.current.touch = event.touches[0]?.clientY ?? 0;
      }}
      onTouchEnd={(event) => {
        follow.current.touching = event.touches.length > 0;
      }}
      onTouchCancel={(event) => {
        follow.current.touching = event.touches.length > 0;
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
      onClick={(event) => {
        const link =
          event.target instanceof Element ? event.target.closest('a[href^="#m-"]') : null;
        if (link === null) return;
        event.preventDefault();
        jump(link.getAttribute("href")?.slice(3) ?? "");
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
        // Following, nothing but the reader moves the view off the end: a browser that shifted it while laying the
        // page out (Firefox, as the editor measures itself) is put back before it paints.
        else if (
          left.peek() === undefined &&
          !state.pressed &&
          !state.touching &&
          element.scrollHeight - element.scrollTop - element.clientHeight > 1
        )
          toEnd();
      }}
    >
      {nodes}
      {live.partial && !filtered ? (
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
      {filtered && kept === 0 ? (
        <div class="status">
          nothing here yet · the front labels a message by starting it with ask, done or update;
          /classifier labels the rest
        </div>
      ) : null}
      {live.status && !filtered ? <div class="status">{live.status}</div> : null}
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
