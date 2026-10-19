/**
 * Prompt drafts: text the user set aside to finish later, in the store-wide `monchu.drafts` document, so a draft saved
 * in one client is there to restore in every other client of this device. Restoring takes a draft out.
 */
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export type Draft = { id: number; text: string; at: number };
export type DraftsState = { drafts: Draft[]; next: number };

export const DraftsDoc = defineDoc<DraftsState>({
  kind: "monchu.drafts",
  version: 1,
  scope: "session",
  initial: () => ({ drafts: [], next: 1 }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/** Sets `text` aside as the newest draft. */
export async function saveDraft(harness: Harness, text: string, context: Context): Promise<void> {
  if (text.trim() === "") throw new Error("A draft needs text");
  await harness.commit(async (tx) => {
    const state = await tx.doc(DraftsDoc);
    state.drafts.push({ id: state.next++, text, at: Date.now() });
  }, context);
}

/** Takes a draft out and returns its text; throws when another client took it first. */
export async function takeDraft(harness: Harness, id: number, context: Context): Promise<string> {
  const text = await harness.commit(async (tx) => {
    const state = await tx.doc(DraftsDoc);
    const draft = state.drafts.find((each) => each.id === id);
    state.drafts = state.drafts.filter((each) => each.id !== id);
    return draft?.text;
  }, context);
  if (text === undefined) throw new Error("That draft is gone: another client restored it");
  return text;
}
