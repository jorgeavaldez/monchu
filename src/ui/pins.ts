import type { PinnedMessage, RootSummary } from "../api/client.ts";

/** A pin's root as clients name it: its label now, else the label it had when pinned, else its id. */
export function pinRoot(pin: PinnedMessage, roots: readonly RootSummary[]): string {
  const root = roots.find((each) => each.id === pin.root);
  return root?.label || pin.rootLabel || pin.root;
}

/** The pins every typed word matches (in its text, headline, sender or root, any case), newest pinned first. */
export function findPins(
  pins: readonly PinnedMessage[],
  query: string,
  roots: readonly RootSummary[],
): PinnedMessage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pins
    .filter((pin) => {
      const text =
        `${pin.headline}\n${pin.text}\n${pin.from}\n${pinRoot(pin, roots)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .toReversed();
}
