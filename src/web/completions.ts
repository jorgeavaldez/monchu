/**
 * What a slash command's argument can be, for the typeahead after `/command `: fixed words from the command's usage,
 * and names the page already has (workers, roots, open asks, the feed's messages). Pure: the editor passes in what it
 * knows.
 */
import { SEVERITIES } from "../ui/logs.ts";

/** A typeahead row: the whole draft it completes to, the argument, and what it is. */
type Row = { id: string; label: string; detail?: string };

export type ArgSources = {
  workers: readonly string[];
  roots: readonly { id: string; label: string }[];
  asks: readonly { code: string; text: string }[];
  /** The feed's messages, newest first, with who wrote them. */
  messages: readonly { code: string; who: string; text: string }[];
};

/** Each command's first argument: a row's id is the whole draft it completes to, its label the argument. */
function options(command: string, from: ArgSources): Row[] | undefined {
  const words = (list: readonly string[], detail?: string) =>
    list.map((word) => ({
      id: `${command} ${word}`,
      label: word,
      ...(detail === undefined ? {} : { detail }),
    }));
  switch (command) {
    case "/agents":
      return [...words(["root"], "the front"), ...words(from.workers, "worker")];
    case "/stop":
    case "/close":
      return words(from.workers, "worker");
    case "/roots":
      return [
        ...words(["new"], "start a root"),
        // These take more after them, so taking one leaves room for it.
        { id: `${command} rename `, label: "rename", detail: "name the shown root" },
        ...words(["archive"], "archive a root"),
        { id: `${command} unarchive `, label: "unarchive", detail: "unarchive a root" },
        ...from.roots.map((root) => ({
          id: `${command} ${root.id}`,
          label: root.id,
          detail: root.label,
        })),
      ];
    case "/reply":
      // The reply's text follows the id.
      return from.asks.map((ask) => ({
        id: `${command} ${ask.code} `,
        label: ask.code,
        detail: ask.text,
      }));
    case "/pin":
      return from.messages.map((message) => ({
        id: `${command} ${message.code}`,
        label: message.code,
        detail: `${message.who}: ${message.text}`,
      }));
    case "/logs":
      return words(SEVERITIES);
    case "/mcp":
      return words(["login", "logout", "enable", "disable", "reconnect"]);
    case "/update":
      return words(["edge"], "main's newest");
    case "/attach":
      return words(["clear"], "drop what is attached");
    default:
      return undefined;
  }
}

/**
 * The argument rows for `text` and the word typed so far, or undefined when `text` isn't a command's first argument
 * being typed. Only the first argument completes; past it the text is the command's own.
 */
export function argumentRows(
  text: string,
  from: ArgSources,
): { items: Row[]; query: string } | undefined {
  const match = /^(\/\S+) (\S*)$/.exec(text);
  if (match === null) return undefined;
  const [, command = "", query = ""] = match;
  const items = options(command, from);
  return items === undefined ? undefined : { items, query };
}
