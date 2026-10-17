/**
 * The transcript: committed entries render once and are reused while their immutable Durable record is unchanged, so a
 * streaming token re-renders only the live tail. Tool calls and worker reports collapse to a header row, as in the
 * terminal; a click toggles one, and the expand-all switch opens every one.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren, VNode } from "preact";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { escalationSummary, systemNoticeSummary, workerNotice } from "../api/notices.ts";
import { addressable, sentAt, ShortIds, stamp } from "../ui/ids.ts";
import { presentation } from "../ui/state.ts";
import { expandAll, notices, rootId, type Notice } from "./state.ts";

const PREVIEW_LINES = 4;

/** Plain text with links made clickable; markdown stays as written, which reads fine in monospace. */
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

/** A card that shows a header and a few lines, and everything when open. */
function Card(props: {
  kind: string;
  header: ComponentChildren;
  body: string;
  stamp?: ComponentChildren;
  error?: boolean;
}) {
  const open = useSignal<boolean | undefined>(undefined);
  const lines = props.body.split("\n");
  const long = lines.length > PREVIEW_LINES;
  const expanded = open.value ?? expandAll.value;
  const shownText = !long || expanded ? props.body : lines.slice(0, PREVIEW_LINES).join("\n");
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
        {props.stamp === undefined ? null : <> · {props.stamp}</>}
      </header>
      {props.body ? (
        <pre>
          <Text text={shownText} />
        </pre>
      ) : null}
      {long && !expanded ? (
        <footer>
          … {lines.length - PREVIEW_LINES} more line{lines.length - PREVIEW_LINES === 1 ? "" : "s"}
        </footer>
      ) : null}
    </section>
  );
}

/** A tool call and its result, collapsed to its name, a short argument summary and the first lines of output. */
function ToolCard(props: {
  name: string;
  args: unknown;
  result: ToolResultMessage | undefined;
  running: string | undefined;
}) {
  const summary = JSON.stringify(props.args) ?? "";
  const output = props.result === undefined ? (props.running ?? "") : textOf(props.result.content);
  return (
    <Card
      kind="tool"
      header={
        <>
          <b>{props.name}</b> {summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}
          {props.result === undefined ? " · running" : ""}
        </>
      }
      body={output}
      error={props.result?.isError === true}
    />
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
              <Text text={part.text} />
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
    const text = textOf(message.content);
    const escalation = escalationSummary(text);
    if (escalation !== undefined) return <div class="system">clef · escalated · {escalation}</div>;
    const system = systemNoticeSummary(text);
    if (system !== undefined) return <div class="system">system · {system}</div>;
    return (
      <>
        <div class="user">
          <Text text={text} />
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
  const nodes = view.entries.map((entry) => {
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
    if (cached !== undefined && cached.results === key) return cached.node;
    const node = entryNode(entry, results, ids);
    cache.set(entry, { results: key, node });
    return node;
  });
  const live = presentation(view);
  return (
    <main class="transcript">
      {nodes}
      {live.partial ? (
        <div class="assistant live">
          <Text text={live.partial} />
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
      {notices.value
        .filter((item) => item.root === undefined || item.root === rootId.value)
        .map((item) => (
          <NoticeLine key={item.id} item={item} />
        ))}
      {live.status ? <div class="status">{live.status}</div> : null}
    </main>
  );
}
