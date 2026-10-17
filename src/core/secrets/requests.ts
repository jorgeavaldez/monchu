/**
 * Requests for secrets: an agent asks, the user answers in a signed-in client. A request holds only what may be shown
 * (a name, a reason, who asked) in the store-wide `monchu.secrets` document; its answer tells every conversation that
 * waits for it with a follow-up notice, so asking never blocks a turn and nothing in a prompt prefix changes.
 */
import type { Context } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { systemNoticeText } from "../../api/notices.ts";
import { messageWorker, parentOf, WorkersDoc } from "../agents/workers.ts";
import type { SecretInfo, SecretKind } from "./vault.ts";

type SecretRequest = {
  id: number;
  name: string;
  kind: SecretKind;
  reason: string;
  site?: string;
  /** Who asked first, as clients show it: a root's short id, with a worker's name. */
  by: string;
  at: number;
  /** The conversations told when it is answered. */
  waiting: ConversationId[];
};

export const SecretsDoc = defineDoc<{ requests: SecretRequest[]; next: number }>({
  kind: "monchu.secrets",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [], next: 1 }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 31,
});

/** How an agent uses a secret, in the words its notice and the `secret` tool share. */
export function usage(info: Pick<SecretInfo, "name" | "kind">): string {
  return info.kind === "login"
    ? `$${info.name}_USERNAME and $${info.name}_PASSWORD in a bash command, {{secret:${info.name}_USERNAME}} and {{secret:${info.name}_PASSWORD}} in agent_browser arguments`
    : `$${info.name} in a bash command, {{secret:${info.name}}} in agent_browser arguments`;
}

/** The notice an answered request sends: names only. */
function answerText(request: SecretRequest, info: SecretInfo | undefined): string {
  if (info === undefined)
    return systemNoticeText(
      `the user declined the secret ${request.name}`,
      "Carry on without it, or ask the user why if the work needs it.",
    );
  const what = info.kind === "login" ? "login" : "secret";
  return systemNoticeText(
    `secret ${info.name} is set`,
    `The user set the ${what} ${info.name}${info.site === undefined ? "" : ` for ${info.site}`}. Use it by name, never by value: ${usage(info)}.`,
  );
}

/**
 * Answers every pending request for `name`: `info` when it was set, `undefined` when declined. A worker hears it as a
 * message from its parent, so its answer is reported as usual; a front gets it as follow-up input.
 */
export async function answerRequests(
  harness: Harness,
  name: string,
  info: SecretInfo | undefined,
  context: Context,
): Promise<number> {
  const result = await harness.commit(async (tx) => {
    const state = await tx.doc(SecretsDoc);
    const answered = state.requests.filter((request) => request.name === name);
    state.requests = state.requests.filter((request) => request.name !== name);
    const roots: { id: ConversationId; text: string; requestId: string }[] = [];
    for (const request of answered)
      for (const id of request.waiting) {
        const text = answerText(request, info);
        const requestId = `secret:${request.id}:${info === undefined ? "declined" : info.setAt}:${id}`;
        const parent = await parentOf(tx, id);
        if (parent === undefined) {
          roots.push({ id, text, requestId });
          continue;
        }
        const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
          (each) => each.conversationId === id,
        );
        // A closed or vanished worker has nobody to tell.
        if (worker === undefined || worker.closed) continue;
        await messageWorker(tx, parent, worker.name, text, requestId, "followUp");
      }
    return { roots, count: answered.length };
  }, context);
  for (const { id, text, requestId } of result.roots) {
    const conversation = await harness.conversation(id, context);
    await conversation?.submit(
      { type: "input", content: text, requestId, whenBusy: "followUp" },
      context,
    );
  }
  return result.count;
}

/** What clients show: stored secrets by name, and the pending requests without whom they will tell. */
export type SecretsState = {
  secrets: SecretInfo[];
  requests: Omit<SecretRequest, "waiting">[];
};
