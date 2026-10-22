/**
 * The typeahead every menu over the editor shares: the slash commands and each pick (`/agents`, `/model`, `/thinking`,
 * `/login`'s providers). Typing filters it, arrows move, Enter or Tab or a tap takes a row, Esc leaves; it opens above
 * the editor, which stays where it is.
 */
import type { ComponentChildren } from "preact";

/** A status color from the stylesheet's tokens. */
export type Tone = "accent" | "green" | "yellow" | "red" | "muted";

/** One row: its label, colored tags after it, then muted detail. */
export type MenuItem = {
  id: string;
  label: string;
  detail?: string;
  /** A command's arguments, before its detail. */
  usage?: string;
  tags?: readonly { text: string; tone?: Tone }[];
};

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The rows `query` matches, best first: every word must be somewhere in a row's label, tags or detail. Rows whose label
 * starts with the first word come first, then rows whose label holds every word, then the rest, each in their own order.
 */
export function matching<T extends MenuItem>(items: readonly T[], query: string): T[] {
  const wanted = words(query);
  if (wanted.length === 0) return [...items];
  const ranked: T[][] = [[], [], []];
  for (const item of items) {
    const label = item.label.toLowerCase().replace(/^\//, "");
    const all = [label, ...(item.tags ?? []).map((tag) => tag.text), item.detail ?? ""]
      .join(" ")
      .toLowerCase();
    if (!wanted.every((word) => all.includes(word))) continue;
    const tier = label.startsWith(wanted[0] ?? "")
      ? 0
      : wanted.every((word) => label.includes(word))
        ? 1
        : 2;
    ranked[tier]?.push(item);
  }
  return ranked.flat();
}

/** Where to mark `query` in a row's text: what it matched, as first and last characters. */
export type Marks = (text: string, query: string) => readonly { at: number; end: number }[];

/** The first place each word of `query` appears in `text`, as `matching` finds them. */
const firstPlaces: Marks = (text, query) => {
  const lower = text.toLowerCase();
  return words(query).flatMap((word) => {
    const at = lower.indexOf(word);
    return at < 0 ? [] : [{ at, end: at + word.length - 1 }];
  });
};

/** `text` with what `query` matched in it underlined; by default each word's first place. */
export function Marked({
  text,
  query,
  marks = firstPlaces,
}: {
  text: string;
  query: string;
  marks?: Marks;
}) {
  const hit = Array.from({ length: text.length }, () => false);
  for (const { at, end } of marks(text, query)) hit.fill(true, at, end + 1);
  const parts: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = parts.at(-1);
    const char = text.charAt(index);
    if (last !== undefined && last.hit === hit[index]) last.text += char;
    else parts.push({ text: char, hit: hit[index] === true });
  }
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} class="hit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** The list over the editor, its optional header (a pick's title and ✕) above the rows. */
export function Menu(props: {
  label: string;
  class?: string;
  header?: ComponentChildren;
  items: readonly MenuItem[];
  query: string;
  selected: number;
  empty?: string;
  /** How rows mark what the query matched; by default each word's first place, as `matching` finds them. */
  marks?: Marks | undefined;
  onTake: (item: MenuItem) => void;
}) {
  const longest = Math.max(1, ...props.items.map((item) => item.label.length));
  return (
    <div class={`menu ${props.class ?? ""}`}>
      {props.header}
      <ul
        role="listbox"
        aria-label={props.label}
        // The label column fits the longest shown, up to half the row.
        style={{ "--label": `min(${longest + 1}ch, 50%)` }}
      >
        {props.items.length === 0 && props.empty !== undefined ? (
          <li class="help empty">{props.empty}</li>
        ) : null}
        {props.items.map((item, index) => (
          <li
            key={item.id}
            role="option"
            aria-selected={index === props.selected}
            class={index === props.selected ? "selected" : ""}
            // A tap must not take focus from the editor, or the keyboard closes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onTake(item)}
          >
            <span class="enter">
              <b>
                <Marked text={item.label} query={props.query} marks={props.marks ?? firstPlaces} />
              </b>
              <span class="more">
                {(item.tags ?? []).map((tag) => (
                  <span key={tag.text} class={`tag ${tag.tone ?? ""}`}>
                    {tag.text}{" "}
                  </span>
                ))}
                {item.usage ? <span class="usage">{item.usage} </span> : null}
                {item.detail === undefined ? null : <span class="help">{item.detail}</span>}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
