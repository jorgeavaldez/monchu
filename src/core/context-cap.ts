import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  InboxDoc,
  LiveDoc,
  type CommitPublication,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { GOALS_COMPACTION_FOCUS } from "./agents/goals.ts";
import { rootRecord, RootsDoc } from "./agents/root-records.ts";
import { WorkersDoc } from "./agents/workers.ts";
import type { PluginCommandEntry } from "./plugins.ts";

/**
 * Whether the cap compacts on its own on this device, as `/autocompact` set it: everywhere (`all`), and for single
 * conversations, which win. Unset follows `settings.compaction.auto`.
 */
const AutoCompactDoc = defineDoc<{ all?: boolean; conversations: Record<string, boolean> }>({
  kind: "monchu.autocompact",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
});

/** Whether the cap compacts conversation `id` on its own. */
function autoCompacts(
  state:
    | { readonly all?: boolean; readonly conversations: Readonly<Record<string, boolean>> }
    | undefined,
  id: ConversationId,
  configured: boolean,
): boolean {
  return state?.conversations[String(id)] ?? state?.all ?? configured;
}

/**
 * `/autocompact [on|off] [here|<worker>]`: show or set whether the cap compacts on its own, everywhere on this device,
 * in the conversation the client shows (`here`), or in one of the root's workers by name.
 */
export function autoCompactCommand(
  configured: () => boolean,
  caps: () => string,
): PluginCommandEntry {
  return {
    name: "autocompact",
    plugin: "monchu",
    usage: "[on|off] [here|<worker>]",
    description:
      "automatic compaction at the context cap: show it, or turn it on or off everywhere, here or for a worker",
    handler: async (args, ctx) => {
      const [action, target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length > 0 || (action !== undefined && action !== "on" && action !== "off"))
        throw new Error("Usage: /autocompact [on|off] [here|<worker>]");
      const line = await ctx.commit(async (tx) => {
        const state = await tx.doc(AutoCompactDoc);
        let id: ConversationId | undefined;
        if (target === "here") id = ctx.conversationId;
        else if (target !== undefined) {
          id = (await tx.doc(WorkersDoc, ctx.root)).workers.find(
            (worker) => worker.name === target,
          )?.conversationId;
          if (id === undefined) throw new Error(`No worker named ${target}`);
        }
        const where =
          target === undefined ? "everywhere" : target === "here" ? "here" : `for ${target}`;
        if (action !== undefined) {
          if (id === undefined) state.all = action === "on";
          else state.conversations[String(id)] = action === "on";
        }
        const on = autoCompacts(state, id ?? ctx.conversationId, configured());
        return `automatic compaction ${on ? "on" : "off"} ${action === undefined ? "here" : where} · ${caps()}`;
      });
      ctx.ui.notify(line);
    },
  };
}

/**
 * Leads the instructions of a compaction the cap starts, so the compaction hook can decline it when a run started
 * meanwhile: it then waits for that run's final answer instead of summarizing under it.
 */
export const CAP_COMPACTION = "Compacting at the context cap.";

/** What a worker's summary keeps, so it can carry on its line from the summary alone. */
const WORKER_COMPACTION_FOCUS =
  "Keep the worker's line and brief, the user's own decisions and words, what is done and checked, what is left, open asks, and every workspace, branch, file and artifact it left.";

/**
 * Compacts a conversation once a final answer leaves its context above `percent(window)` of its model's window, so its
 * next turn starts small however late it comes: Durable compacts on its own only near the window's end, and only when a
 * turn starts. Only at a natural boundary, never cutting work short: the answer ended its run and nothing waits in its
 * queue. Busy again by then, it is left for its next final answer. `undefined` turns it off for that window.
 */
export class ContextCap {
  private readonly pending = new Set<ConversationId>();
  private readonly harness: Harness;
  private readonly models: Pick<Models, "getModel">;
  private readonly percent: (window: number) => number | undefined;
  private readonly auto: () => boolean;
  private readonly report: (error: unknown) => void;
  private readonly context: Context;

  constructor(
    harness: Harness,
    models: Pick<Models, "getModel">,
    percent: (window: number) => number | undefined,
    auto: () => boolean,
    report: (error: unknown) => void,
    context: Context,
  ) {
    this.harness = harness;
    this.models = models;
    this.percent = percent;
    this.auto = auto;
    this.report = report;
    this.context = context;
  }

  /** For `subscribeCommits`: each final answer over the cap starts one compaction, after the commit. */
  observe(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type !== "entry" || !AssistantEntry.is(change.value)) continue;
      const message = change.value.model?.[0];
      if (message?.role !== "assistant" || message.stopReason !== "stop") continue;
      const { input, cacheRead, cacheWrite, output } = message.usage;
      const id = change.value.conversationId;
      if (this.pending.has(id)) continue;
      this.pending.add(id);
      void Promise.resolve()
        .then(() => this.compact(id, input + cacheRead + cacheWrite + output))
        .catch((error: unknown) => this.report(error))
        .finally(() => this.pending.delete(id));
    }
  }

  private async compact(id: ConversationId, tokens: number): Promise<void> {
    const toggled = await this.harness.snapshot(AutoCompactDoc, this.context);
    if (!autoCompacts(toggled, id, this.auto())) return;
    const conversation = await this.harness.conversation(id, this.context);
    if (conversation === undefined) return;
    const { model } = await conversation.agent(this.context);
    const window =
      model === undefined
        ? undefined
        : this.models.getModel(model.provider, model.modelId)?.contextWindow;
    if (window === undefined || window <= 0) return;
    const percent = this.percent(window);
    if (percent === undefined || tokens <= (window * percent) / 100) return;
    // The answer's commit may come before the one that ends its run.
    await conversation.waitForIdle(this.context);
    const live = await this.harness.snapshot(LiveDoc, id, this.context);
    const inbox = await this.harness.snapshot(InboxDoc, id, this.context);
    // A run or queued input is work in flight; one compaction at a time, a user's /compact or Durable's own included.
    if (live?.run !== undefined || (inbox?.items.length ?? 0) > 0 || live?.compactions?.length)
      return;
    const roots = await this.harness.snapshot(RootsDoc, this.context);
    const front = roots !== undefined && rootRecord(roots, id) !== undefined;
    const task = await conversation.compact(
      `${CAP_COMPACTION} ${front ? GOALS_COMPACTION_FOCUS : WORKER_COMPACTION_FOCUS}`,
      this.context,
    );
    await this.harness.waitForTask(task, this.context);
  }
}
