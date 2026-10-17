import type { RootStatus, RootSummary } from "../api/client.ts";
import { ShortIds } from "./ids.ts";

/** A root's id split into its unique prefix among every root, archived ones included, and the rest, as jj shows ids. */
export function rootIds(
  roots: readonly RootSummary[],
): (id: string) => { unique: string; rest: string } {
  const ids = new ShortIds();
  for (const root of roots) ids.addCode(root.id);
  return (id) => {
    const length = ids.prefix(id);
    return { unique: id.slice(0, length), rest: id.slice(length) };
  };
}

/** The roots the indicator shows, one dot each in creation order: open roots that work or finished unseen. */
export function activeRoots(
  roots: readonly RootSummary[],
): readonly { id: string; status: Exclude<RootStatus, "idle"> }[] {
  return roots.flatMap((root) =>
    root.archived || root.status === "idle" ? [] : [{ id: root.id, status: root.status }],
  );
}

/** The roots a list shows, newest input first; archived ones only when asked for. */
export function listedRoots(
  roots: readonly RootSummary[],
  archived: boolean,
): readonly RootSummary[] {
  const recent = (root: RootSummary) => root.lastInputAt ?? root.createdAt;
  return roots
    .filter((root) => archived || !root.archived)
    .toSorted((a, b) => recent(b) - recent(a));
}

/** A root's label, or what stands in until its first message names it. */
export function rootLabel(root: Pick<RootSummary, "label">): string {
  return root.label || "new root";
}

/** A root's crew in a few words for a list row: busy and open workers, and running background commands. */
export function rootCounts(root: Pick<RootSummary, "workers" | "jobs">): string {
  const { open, busy } = root.workers;
  return [
    ...(open
      ? [busy ? `${busy}/${open} workers busy` : `${open} worker${open === 1 ? "" : "s"}`]
      : []),
    ...(root.jobs ? [`${root.jobs} bg`] : []),
  ].join(" · ");
}

/** Why archive exists and what it keeps, the same words in every client. */
export const ARCHIVE_HELP =
  "Archive hides a root from this list, the indicator and plain monchu. Its history, workers, goals and jobs stay; resume it by id or here, and typing in it unarchives it. Nothing is deleted. A working root can't be archived.";

/** What `/roots` asks for: the list, a switch by prefix, a new root, a label for the shown root, or (un)archiving one. */
export type RootsCommand =
  | { kind: "list" }
  | { kind: "switch"; prefix: string }
  | { kind: "new" }
  | { kind: "rename"; label: string }
  | { kind: "archive"; prefix: string | undefined; archived: boolean };

/** Parses `/roots` arguments; ids are letters `k`-`z`, so no subcommand is ever taken for one. */
export function parseRootsCommand(text: string): RootsCommand {
  const [word = "", ...rest] = text.trim().split(/\s+/).filter(Boolean);
  const tail = text.trim().slice(word.length).trim();
  switch (word) {
    case "":
      return { kind: "list" };
    case "new":
      if (tail) break;
      return { kind: "new" };
    case "rename":
      return { kind: "rename", label: tail };
    case "archive":
    case "unarchive":
      if (rest.length > 1 || (word === "unarchive" && rest.length === 0)) break;
      return { kind: "archive", prefix: rest[0], archived: word === "archive" };
    default:
      if (rest.length === 0 && /^[k-z]+$/.test(word)) return { kind: "switch", prefix: word };
  }
  throw new Error("Usage: /roots [id|new|rename <label>|archive [id]|unarchive <id>]");
}
