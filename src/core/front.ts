import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  cleanupSessionResources,
  getSupportedThinkingLevels,
  type Models,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  defineDoc,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import type { Attachment } from "../api/attachments.ts";
import type { ModelChoice, ModelPick, QueueChange, RootClient } from "../api/client.ts";
import { shortId } from "../api/ids.ts";
import {
  escalationSummary,
  noticeText,
  parseRootNotice,
  parseWorkerNotice,
  systemNoticeSummary,
  type WhenBusy,
} from "../api/notices.ts";
import { attachedInput, storeAttachment, writeUpload, type ImageInput } from "./attachments.ts";
import { AssessmentsDoc, RoutingDoc, type Assessment } from "./agents/classifier.ts";
import { GoalsDoc, GOALS_COMPACTION_FOCUS, type Goal } from "./agents/goals.ts";
import { noteInput, rootRecord, RootsDoc, sendHandOff, type RootRecord } from "./agents/roots.ts";
import {
  DELETED_FROM_QUEUE,
  hasPendingDelivery,
  listWorkers,
  messageWorker,
  startWorker,
  stopWorker,
  workerConversationId,
  WorkersDoc,
} from "./agents/workers.ts";
import { thinkingLevels, type ModelRole } from "./config.ts";
import { FRONT_INSTRUCTIONS } from "./identity.ts";
import type { Extensions } from "./reload.ts";
import { IMAGE_BUDGET_BYTES, imageBytes, images } from "./tools/images.ts";
import { attachPlugins, preloadGroups } from "./tools/tool-search.ts";
import { resolveDirectory } from "./workdir.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Which of a root's model fields were picked for this conversation only. Startup and reload apply `config.front`
 * to the other fields; saving a field as the default clears its pick.
 */
const FrontPicks = defineDoc<{ model: boolean; thinkingLevel: boolean }>({
  kind: "monchu.front-picks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ model: false, thinkingLevel: false }),
});

/**
 * When the user last opened each goal, as that goal's `updatedAt`, by goal ID. Goals that existed when it was first
 * read count as seen, so only later changes are news.
 */
const GoalsSeen = defineDoc<{ seeded: boolean; seen: Record<string, number> }>({
  kind: "monchu.goals-seen",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ seeded: false, seen: {} }),
});

/** A root's front agent: the root extensions and front instructions, then the front role. Inside any commit. */
export async function prepareFront(
  tx: Tx,
  id: ConversationId,
  extensions: Extensions,
): Promise<void> {
  // Groups the root already loaded and its plugins stay, in place: dropping one at a restart changes its tools and
  // costs the prompt cache. Plugins it lacks append after them.
  const selected = (await tx.doc(AgentDoc, id)).extensions;
  const names = Array.isArray(selected) ? selected : (selected?.add ?? []);
  const kept = [...extensions.groups, ...extensions.attached]
    .filter((extension) => names.includes(extension.name))
    .sort((left, right) => names.indexOf(left.name) - names.indexOf(right.name));
  const added = extensions.attached.filter((extension) => !names.includes(extension.name));
  await configure(tx, id, {
    // Goals, memory and roots are not in the host default. Workers get them too: a new worker copies this agent.
    extensions: { add: [...extensions.root, ...kept, ...added] },
    instructions: FRONT_INSTRUCTIONS,
  });
  await applyFrontRole(tx, id, extensions.config.front, extensions.preload);
}

/** Apply the configured front role from the next request, keeping the fields picked for this root only. */
export async function applyFrontRole(
  tx: Tx,
  id: ConversationId,
  role: ModelRole,
  preload: readonly string[],
): Promise<void> {
  const picks = await tx.doc(FrontPicks, id);
  await configure(tx, id, {
    ...(picks.model ? {} : { model: { provider: role.provider, modelId: role.modelId } }),
    ...(picks.thinkingLevel ? {} : { thinkingLevel: role.thinkingLevel }),
  });
  await preloadGroups(tx, id, preload);
}

/**
 * Bring a root and every worker under it up to the current build: the preloaded tool groups on the Claude Code bridge
 * and the home plugins, so a group or plugin added reaches existing conversations once, at a reload or start, instead
 * of mid-run.
 */
export async function selectAll(
  harness: Harness,
  rootId: ConversationId,
  extensions: Pick<Extensions, "preload" | "attached">,
): Promise<void> {
  const attached = extensions.attached.map((extension) => extension.name);
  const ids: ConversationId[] = [];
  for (const pending = [rootId]; pending.length;) {
    const id = pending.pop();
    if (id === undefined) break;
    ids.push(id);
    for (const worker of (await harness.snapshot(WorkersDoc, id, context))?.workers ?? [])
      pending.push(worker.conversationId);
  }
  await harness.commit(async (tx) => {
    for (const id of ids) {
      await preloadGroups(tx, id, extensions.preload);
      await attachPlugins(tx, id, attached);
    }
  }, context);
}

/** What a root's front needs from the core that owns it. */
export type FrontHost = {
  readonly home: string;
  readonly harness: Harness;
  readonly models: Models;
  readonly extensions: Extensions;
  /** Refuses a pick naming an unknown model or level, or once the core is closing. */
  checkPick(pick: ModelPick): void;
  saveDefault(role: "front" | "worker", pick: ModelPick): Promise<void>;
  /** The provider Clef still needs a login for, if any. */
  classifierNeedsLogin(): Promise<boolean>;
  /** Counts a client view of a root while it stays attached; the returned function releases it. */
  show(id: ConversationId): () => void;
  /** Another root's record, by any unique prefix of its id. */
  findRoot(prefix: string): Promise<RootRecord>;
};

/** One root's front and crew, in process: the core's `RootClient`. */
export class Front implements RootClient {
  readonly id: string;
  private readonly host: FrontHost;
  private loaded: Promise<Conversation> | undefined;

  constructor(host: FrontHost, id: string) {
    this.host = host;
    this.id = id;
  }

  /** The root's conversation; rejects for an id that names no root. */
  conversation(): Promise<Conversation> {
    this.loaded ??= (async () => {
      const roots = await this.host.harness.snapshot(RootsDoc, context);
      const record = roots?.roots.find((root) => shortId(root.id) === this.id);
      if (record === undefined) throw new Error(`No root ${this.id}`);
      const conversation = await this.host.harness.conversation(record.id, context);
      if (conversation === undefined) throw new Error(`Root ${this.id}'s conversation is missing`);
      return conversation;
    })();
    // A failed lookup is not remembered: the root may be created after.
    this.loaded.catch(() => {
      this.loaded = undefined;
    });
    return this.loaded;
  }

  private async target(workerName: string | undefined): Promise<Conversation> {
    const front = await this.conversation();
    if (workerName === undefined) return front;
    const conversation = await this.host.harness.conversation(
      await workerConversationId(this.host.harness, front.id, workerName, context),
      context,
    );
    if (conversation === undefined) throw new Error("Worker conversation is missing");
    return conversation;
  }

  /** Read-only committed conversation state; showing it marks this root seen while it stays attached. */
  async viewState(workerName?: string) {
    const conversation = await this.target(workerName);
    const state = await conversation.viewState(context);
    const release = this.host.show((await this.conversation()).id);
    const dispose = state.dispose.bind(state);
    let disposed = false;
    state.dispose = () => {
      if (!disposed) release();
      disposed = true;
      dispose();
    };
    return state;
  }

  /** The same view as an exact-frame watch with its delta ops, for remote clients; marks the root seen while it runs. */
  async viewWatch(workerName?: string) {
    const watch = await (await this.target(workerName)).watch(context);
    const release = this.host.show((await this.conversation()).id);
    const stop = watch.stop.bind(watch);
    let stopped = false;
    watch.stop = () => {
      if (!stopped) release();
      stopped = true;
      return stop();
    };
    return watch;
  }

  /**
   * Resolves on durable admission, never on the model answer. Retry with the same request ID. `whenBusy` decides
   * whether a message reaching a busy front steers its run or waits for it to finish.
   */
  async submit(
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if ((!message.trim() && attachments.length === 0) || !requestId.trim())
      throw new Error("Message and request ID are required");
    const front = await this.conversation();
    const input = await attachedInput(
      this.host.home,
      message,
      attachments,
      attachments.length ? await this.imageInput(front) : undefined,
    );
    await front.commit(
      (tx) => noteInput(tx, front.id, message || attachments.map(({ name }) => name).join(", ")),
      context,
    );
    const assessment = this.host.extensions.assessment;
    if (assessment === undefined)
      await front.submit({ type: "input", content: input.content, requestId, whenBusy }, context);
    else await assessment.submit(front, input.text, requestId, whenBusy, context, input.content);
  }

  /** How the front's model takes images: its limits, and the image bytes its context holds now. */
  private async imageInput(front: Conversation): Promise<ImageInput> {
    const ref = (await front.agent(context)).model;
    const model =
      ref === undefined ? undefined : this.host.models.getModel(ref.provider, ref.modelId);
    const resize = model?.inputLimits?.images?.resize;
    return {
      processor: images,
      limits: {
        maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
        maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
        maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
      },
      budget: IMAGE_BUDGET_BYTES,
      held: async () => imageBytes((await front.context(context)).messages),
    };
  }

  attach(name: string, data: Uint8Array): Promise<Attachment> {
    return storeAttachment(this.host.home, name, data);
  }

  /** One chunk of a remote client's upload. */
  upload(chunk: Parameters<typeof writeUpload>[1]): Promise<Attachment | null> {
    return writeUpload(this.host.home, chunk);
  }

  /**
   * The routing helper's state, pausing or resuming it first when `paused` is given. A pause is stored on the root, so
   * it outlasts restarts; `configured` is false when config.json turns Clef off or its provider has no login.
   */
  async routing(paused?: boolean): Promise<{ configured: boolean; paused: boolean }> {
    const front = await this.conversation();
    const stored = await front.commit(async (tx) => {
      const state = await tx.doc(RoutingDoc, front.id);
      if (paused !== undefined) state.paused = paused;
      return state.paused;
    }, context);
    return {
      configured:
        this.host.extensions.assessment !== undefined && !(await this.host.classifierNeedsLogin()),
      paused: stored,
    };
  }

  /** Routing assessments of this front's inputs as they settle, newest last. Returns a stop function. */
  async watchAssessments(listener: (items: readonly Assessment[]) => void): Promise<() => void> {
    const front = await this.conversation();
    // Observation needs a stored document; reading it in a commit creates it on a fresh home.
    await front.commit(async (tx) => {
      await tx.doc(AssessmentsDoc, front.id);
    }, context);
    const state = await this.host.harness.documentState(AssessmentsDoc, front.id, context);
    if (state === undefined) throw new Error("Assessments document is missing");
    const unsubscribe = state.subscribe((value) => listener(value?.items ?? []));
    return () => {
      unsubscribe();
      state.dispose();
    };
  }

  /**
   * `/new`: a fresh model context, optionally carrying a handoff note. Storage keeps every entry, and the crew, goals,
   * jobs and picks stay. A label taken from the first message goes, so the next message names the root again.
   */
  async reset(handoff: string | undefined): Promise<void> {
    const front = await this.conversation();
    await front.commit(async (tx) => {
      const root = rootRecord(await tx.doc(RootsDoc), front.id);
      if (root !== undefined && !root.named) root.label = "";
    }, context);
    await front.reset(handoff?.trim() || undefined, context);
    const provider = await this.host.harness.snapshot(ProviderDoc, front.id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
  }

  /** Summarize older context now, keeping goal ids and open commitments; the conversation keeps working meanwhile. */
  async compact(instructions: string | undefined): Promise<void> {
    const focus = instructions?.trim();
    await (
      await this.conversation()
    ).compact(focus ? `${GOALS_COMPACTION_FOCUS} ${focus}` : GOALS_COMPACTION_FOCUS, context);
  }

  /**
   * The root's goals in stored order, including recently closed ones, each with whether it changed since the user last
   * opened it with `seeGoal`.
   */
  async goals(): Promise<readonly (Goal & { changed: boolean })[]> {
    const front = await this.conversation();
    const goals = (await this.host.harness.snapshot(GoalsDoc, front.id, context))?.goals ?? [];
    const seen = await front.commit(async (tx) => {
      const doc = await tx.doc(GoalsSeen, front.id);
      if (!doc.seeded) {
        doc.seeded = true;
        for (const goal of goals) doc.seen[goal.id] = goal.updatedAt;
      }
      return { ...doc.seen };
    }, context);
    return goals.map((goal) => ({ ...goal, changed: goal.updatedAt > (seen[goal.id] ?? 0) }));
  }

  /** Records that the user opened a goal as of its `updatedAt`. */
  async seeGoal(id: string, updatedAt: number): Promise<void> {
    const front = await this.conversation();
    await front.commit(async (tx) => {
      const doc = await tx.doc(GoalsSeen, front.id);
      doc.seen[id] = Math.max(doc.seen[id] ?? 0, updatedAt);
    }, context);
  }

  /** Starts a worker of this root in the front's directory, on the worker role. Not a client call: tests use it. */
  async startWorker(name: string, message: string, requestId: string): Promise<void> {
    if (!name.trim() || !message.trim() || !requestId.trim())
      throw new Error("Worker name, message, and request ID are required");
    const front = await this.conversation();
    const cwd = (await front.agent(context)).cwd ?? this.host.home;
    const { config, preload } = this.host.extensions;
    await front.commit(
      (tx) => startWorker(tx, front.id, name, message, cwd, requestId, config.worker, preload),
      context,
    );
    this.host.harness.resume();
  }

  /** Steers a busy worker's run, or with `followUp` waits for it to finish. */
  async messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: WhenBusy,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if ((!message.trim() && attachments.length === 0) || !requestId.trim())
      throw new Error("Message and request ID are required");
    const front = await this.conversation();
    const { text } = await attachedInput(this.host.home, message, attachments, undefined);
    await front.commit(
      (tx) => messageWorker(tx, front.id, name, text, requestId, whenBusy),
      context,
    );
    this.host.harness.resume();
  }

  async workers() {
    return listWorkers(this.host.harness, (await this.conversation()).id, context);
  }

  /** Moves an idle worker, with its jobs, to another root; that root's front is told. */
  async handOff(workerName: string, toRoot: string): Promise<void> {
    const front = await this.conversation();
    const roots = await this.host.harness.snapshot(RootsDoc, context);
    const from = roots === undefined ? undefined : rootRecord(roots, front.id);
    if (from === undefined) throw new Error(`No root ${this.id}`);
    const to = await this.host.findRoot(toRoot);
    await sendHandOff(
      this.host.harness,
      from,
      to,
      workerName,
      `root-handoff:user:${randomUUID()}`,
      context,
    );
  }

  /**
   * Change a still-queued input of the front, or of the named worker, in place, keeping its place in the queue. A
   * worker notice keeps its label: new text replaces only its body. A deleted input settles unanswered, so a worker
   * report is dropped and a message to a worker reports a failure to its parent. Returns false once the input left
   * the queue.
   */
  async editQueued(
    workerName: string | undefined,
    id: number,
    change: QueueChange,
  ): Promise<boolean> {
    const front = await this.conversation();
    const conversation = await this.target(workerName);
    // Only the front's inputs are assessed. A re-assessment reads the front's context first; the commit can't.
    const assessment = workerName === undefined ? this.host.extensions.assessment : undefined;
    const recent =
      assessment !== undefined && change.kind === "text"
        ? await assessment.recent(front, context)
        : [];
    return conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const index = inbox.items.findIndex((item) => item.id === id);
      const item = inbox.items[index];
      if (item === undefined || item.mode === "write") return false;
      if (change.kind === "mode") item.mode = change.mode;
      else if (change.kind === "delete") {
        tx.settleSubmission(item.id, { status: "unanswered", reason: DELETED_FROM_QUEUE });
        inbox.items.splice(index, 1);
        await assessment?.revise(tx, conversation.id, item.id, undefined);
      } else {
        if (!change.text.trim()) throw new Error("A queued message needs text");
        if (typeof item.content !== "string") throw new Error("Only text messages can be edited");
        const notice = parseWorkerNotice(item.content);
        item.content =
          notice === undefined ? change.text : noticeText({ ...notice, text: change.text });
        await assessment?.revise(tx, conversation.id, item.id, { message: change.text, recent });
      }
      return true;
    }, context);
  }

  async stopWorker(name: string): Promise<void> {
    await stopWorker(this.host.harness, (await this.conversation()).id, name, context);
  }

  /**
   * Stop the front only. Returns the user's own queued messages, oldest first, withdrawn so the caller can put them
   * back in the editor. The abort withdraws the rest as before: a worker report is posted again, an update is dropped.
   */
  async abort(): Promise<string[]> {
    const front = await this.conversation();
    const restored = await front.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, front.id);
      const mine = inbox.items.flatMap((item) => {
        if (item.mode === "write") return [];
        // A message with attachments comes back as its text and their note: sent again, it still names them.
        const text =
          typeof item.content === "string"
            ? item.content
            : item.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n\n");
        return parseWorkerNotice(text) === undefined &&
          parseRootNotice(text) === undefined &&
          escalationSummary(text) === undefined &&
          systemNoticeSummary(text) === undefined
          ? [{ id: item.id, text }]
          : [];
      });
      for (const { id } of mine) {
        tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
        inbox.items.splice(
          inbox.items.findIndex((item) => item.id === id),
          1,
        );
        // The front never gets it, so its assessment neither advises nor escalates.
        await this.host.extensions.assessment?.revise(tx, front.id, id, undefined);
      }
      return mine.map((item) => item.text);
    }, context);
    await front.abort(context);
    const provider = await this.host.harness.snapshot(ProviderDoc, front.id, context);
    if (provider !== undefined) cleanupSessionResources(provider.sessionId);
    return restored;
  }

  /** The model and thinking level of the front or a worker, its role's default, and the chat models with credentials. */
  async modelChoice(workerName?: string): Promise<ModelChoice> {
    const agent = await (await this.target(workerName)).agent(context);
    const { models, extensions } = this.host;
    const model =
      agent.model === undefined
        ? undefined
        : models.getModel(agent.model.provider, agent.model.modelId);
    return {
      model,
      thinkingLevel: agent.thinkingLevel,
      thinkingLevels: model === undefined ? thinkingLevels : getSupportedThinkingLevels(model),
      defaults: workerName === undefined ? extensions.config.front : extensions.config.worker,
      models: await models.getAvailable(),
    };
  }

  /**
   * Change the front's or a worker's model or thinking level from its next request. `saveDefault` also writes it to
   * that role's default in `config.json`: `front` for a root, `worker` for workers. Existing workers keep theirs.
   */
  async pickModel(pick: ModelPick, saveDefault: boolean, workerName?: string): Promise<void> {
    this.host.checkPick(pick);
    const conversation = await this.target(workerName);
    if (saveDefault)
      await this.host.saveDefault(workerName === undefined ? "front" : "worker", pick);
    await conversation.commit(async (tx) => {
      if (workerName === undefined)
        (await tx.doc(FrontPicks, conversation.id))["model" in pick ? "model" : "thinkingLevel"] =
          !saveDefault;
      await configure(tx, conversation.id, pick);
      await preloadGroups(tx, conversation.id, this.host.extensions.preload);
    }, context);
  }

  async changeDirectory(path: string, workerName?: string): Promise<string> {
    const front = await this.conversation();
    const conversation = await this.target(workerName);
    const agent = await conversation.agent(context);
    const cwd = await resolveDirectory(path, agent.cwd ?? this.host.home);
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run !== undefined)
        throw new Error(
          "Directory changes require an idle conversation; stop or finish the current run first",
        );
      if (workerName !== undefined && (await hasPendingDelivery(tx, front.id, workerName)))
        throw new Error("Directory changes require an idle worker with no pending deliveries");
      await configure(tx, conversation.id, { cwd });
    }, context);
    return cwd;
  }
}
