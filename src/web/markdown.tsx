/**
 * A small markdown renderer for message text: headings, emphasis, code, fences, lists, quotes, tables, rules and
 * links. It builds Preact nodes and never HTML, so nothing in the text can inject markup, and links keep to http(s)
 * and mailto. A streamed reply re-renders only its last block: the blocks before it are reused while their source is
 * unchanged, and an unclosed fence or emphasis shows as it will once it closes, or as written.
 */
import type { ComponentChildren, VNode } from "preact";
import { useRef } from "preact/hooks";

/** One top-level block: its source, which keys its reuse, and how it renders. */
interface Block {
  source: string;
  render(): VNode;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?: +|$)/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** A link target the page may open: absolute http(s) or mailto only, never `javascript:` or a relative path. */
function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function link(href: string, children: ComponentChildren): ComponentChildren {
  const safe = safeHref(href);
  if (safe === undefined) return children;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/**
 * Inline spans, the earliest match first: code, an escape, strong, strike, emphasis, a link, an autolink or a bare URL.
 * Underscores only count at word edges, so snake_case stays as written.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\\([!-/:-@[-`{-~])|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*])\*(?=[^\s*])((?:[^*\n]|\*\*[^*\n]+\*\*)*?[^\s*])\*(?![\w*])|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(\s*<?([^\s()<>]+(?:\([^\s()<>]*\))?)>?\s*\)|<((?:https?|mailto):[^\s<>]+)>|(https?:\/\/[^\s<>()"'`]+(?:\([^\s<>()"'`]*\))?[^\s<>()"'`.,;:!?*_~])/g;

function inline(text: string): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, , code, escaped, strong, under, strike, em, emUnder, label, href, auto, bare] = match;
    if (code !== undefined) {
      // A span padded on both sides, as for a backtick inside it, loses one space each side.
      const trimmed = /^ .*[^ ].* $/s.test(code) ? code.slice(1, -1) : code;
      parts.push(<code>{trimmed.replace(/\n/g, " ")}</code>);
    } else if (escaped !== undefined) parts.push(escaped);
    else if (strong !== undefined || under !== undefined)
      parts.push(<strong>{inline(strong ?? under ?? "")}</strong>);
    else if (strike !== undefined) parts.push(<s>{inline(strike)}</s>);
    else if (em !== undefined || emUnder !== undefined)
      parts.push(<em>{inline(em ?? emUnder ?? "")}</em>);
    else if (label !== undefined && href !== undefined) parts.push(link(href, inline(label)));
    else if (auto !== undefined) parts.push(link(auto, auto));
    else if (bare !== undefined) parts.push(link(bare, bare));
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A table row's cells, split on pipes that aren't escaped, without the outer ones. */
function cells(line: string): string[] {
  const trimmed = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTable(lines: string[], at: number): boolean {
  const head = lines[at];
  const divider = lines[at + 1];
  return (
    head !== undefined &&
    divider !== undefined &&
    head.includes("|") &&
    divider.includes("-") &&
    (divider.includes("|") || head.trim().startsWith("|")) &&
    DIVIDER.test(divider)
  );
}

/** Whether `line` starts a block, so it ends the paragraph before it. */
function startsBlock(lines: string[], at: number): boolean {
  const line = lines[at] ?? "";
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    isTable(lines, at)
  );
}

const indent = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

/** Splits lines into top-level blocks, each rendering lazily so an unchanged one is never rebuilt. */
function parse(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;
  const take = (from: number, render: () => VNode) => {
    blocks.push({ source: lines.slice(from, at).join("\n"), render });
  };
  while (at < lines.length) {
    const line = lines[at] ?? "";
    const start = at;
    if (!line.trim()) {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      at++;
      // Unclosed while it streams: the rest is code, as it will be once the fence closes.
      while (at < lines.length) {
        const next = lines[at] ?? "";
        at++;
        if (
          next.trim().startsWith(marker) &&
          next.trim().replace(new RegExp(`^\\${marker[0] ?? "`"}+`), "") === ""
        )
          break;
        body.push(next);
      }
      take(start, () => (
        // Focusable, so a keyboard can scroll a wide one.
        <pre class="code" tabIndex={0}>
          <code>{body.join("\n")}</code>
        </pre>
      ));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      at++;
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      take(start, () => <p class={`h h${level}`}>{inline(text)}</p>);
      continue;
    }
    if (RULE.test(line)) {
      at++;
      take(start, () => <hr />);
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? "")) {
        body.push((lines[at] ?? "").replace(QUOTE, ""));
        at++;
      }
      take(start, () => <blockquote>{render(parse(body))}</blockquote>);
      continue;
    }
    if (isTable(lines, at)) {
      const head = cells(line);
      const align = cells(lines[at + 1] ?? "").map((cell) =>
        cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : undefined,
      );
      at += 2;
      const rows: string[][] = [];
      while (at < lines.length && (lines[at] ?? "").includes("|") && (lines[at] ?? "").trim()) {
        rows.push(cells(lines[at] ?? ""));
        at++;
      }
      take(start, () => (
        <div class="table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {head.map((cell, column) => (
                  <th style={{ textAlign: align[column] }}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  {head.map((_, column) => (
                    <td style={{ textAlign: align[column] }}>{inline(row[column] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ));
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      const ordered = /\d/.test(item[2] ?? "");
      const base = item[1]?.length ?? 0;
      const items: string[][] = [];
      // Items at this list's indent, of its kind; deeper lines, and a lazy line straight after one, belong to the item.
      while (at < lines.length) {
        const head = ITEM.exec(lines[at] ?? "");
        if (
          head === null ||
          (head[1]?.length ?? 0) > base + 1 ||
          /\d/.test(head[2] ?? "") !== ordered
        )
          break;
        const width = head[0].length;
        const body = [(lines[at] ?? "").slice(width)];
        at++;
        while (at < lines.length) {
          const next = lines[at] ?? "";
          if (!next.trim()) {
            const following = lines.slice(at).find((candidate) => candidate.trim());
            if (following === undefined || indent(following) < width) break;
            body.push("");
          } else if (indent(next) >= width) body.push(next.slice(width));
          else if (indent(next) > base && ITEM.test(next)) body.push(next.trimStart());
          else if (startsBlock(lines, at) || !(body.at(-1) ?? "").trim()) break;
          else body.push(next.trimStart());
          at++;
        }
        items.push(body);
      }
      const first = ordered ? Number.parseInt(item[2] ?? "1", 10) : 1;
      take(start, () => {
        const children = items.map((body) => <li>{render(parse(body))}</li>);
        return ordered ? (
          <ol start={first === 1 ? undefined : first}>{children}</ol>
        ) : (
          <ul>{children}</ul>
        );
      });
      continue;
    }
    at++;
    while (at < lines.length && (lines[at] ?? "").trim() && !startsBlock(lines, at)) at++;
    const text = lines
      .slice(start, at)
      .map((part) => part.trimStart())
      .join("\n");
    take(start, () => <p>{inline(text)}</p>);
  }
  return blocks;
}

function render(blocks: Block[]): VNode[] {
  return blocks.map((block) => block.render());
}

/**
 * Message text as markdown. While a reply streams the text grows at its end, so every block but the changed ones
 * keeps the node it rendered last time and Preact skips it.
 */
export function Markdown({ text }: { text: string }) {
  const previous = useRef<{ source: string; node: VNode }[]>([]);
  const blocks = parse(text.split("\n"));
  const nodes = blocks.map((block, at) => {
    const known = previous.current[at];
    return known !== undefined && known.source === block.source
      ? known
      : { source: block.source, node: block.render() };
  });
  previous.current = nodes;
  return <div class="md">{nodes.map((item) => item.node)}</div>;
}
