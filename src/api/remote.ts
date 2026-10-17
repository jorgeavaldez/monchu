/**
 * `Client` for a core in another process, over Chord remote services. Browser-safe: the terminal attached over the
 * local socket uses it now, the web later. The connection's owner calls `disconnected` and `reconnected`; views keep
 * their last value meanwhile and pick up again from a fresh snapshot.
 */
import {
  createRemoteServiceBinding,
  type AttachedReplicatedState,
  type Context,
  type RemoteServiceBinding,
  type ReplicatedStateDelivery,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AuthInteraction, AuthType, Model } from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";
import type { Client } from "./client.ts";
import type { Release } from "./release.ts";
import {
  Conversations,
  Logins,
  Session,
  type ConversationService,
  type Hello,
  type LoginService,
  type LoginState,
  type SessionService,
} from "./services.ts";
import type { RemoteServiceTransport } from "@earendil-works/chord";

const context = BACKGROUND_CONTEXT;

type Listener<T> = (
  value: T,
  context: Context,
  delivery: ReplicatedStateDelivery,
) => void | Promise<void>;

/** A conversation view that outlives reconnects: it follows whichever instance currently carries its conversation. */
class RemoteView implements AttachedReplicatedState<ConversationView> {
  value: ConversationView;
  private readonly listeners = new Set<Listener<ConversationView>>();
  private stop: (() => void) | undefined;
  private sequence = 0;
  private readonly release: () => void;
  private disposed = false;

  constructor(initial: ConversationView, release: () => void) {
    this.value = initial;
    this.release = release;
  }

  bind(instance: ConversationService): void {
    this.stop?.();
    this.stop = instance.view.subscribe((value) => {
      if (this.disposed) return;
      this.value = value;
      this.sequence += 1;
      for (const listener of this.listeners)
        void listener(value, context, { kind: "update", sequence: this.sequence });
    });
  }

  subscribe(listener: Listener<ConversationView>): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      if (this.listeners.has(listener))
        void listener(this.value, context, { kind: "hydrate", sequence: this.sequence });
    });
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop?.();
    this.listeners.clear();
    this.release();
  }
}

/** Resolves with the first value a state's subscription delivers that matches. */
function first<T>(
  subscribe: (listener: (value: T) => void) => () => void,
  matches: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let done = false;
    stop = subscribe((value) => {
      if (done || !matches(value)) return;
      done = true;
      stop?.();
      resolve(value);
    });
    if (done) stop();
  });
}

export class RemoteClient implements Client {
  readonly restartsProcess = false;
  private info: Hello;
  private releaseInfo: Release;
  private readonly instances = new Map<string, ConversationService>();
  private readonly instanceWaiters = new Set<() => void>();
  private readonly views = new Map<string, Set<RemoteView>>();
  private readonly logins = new Map<number, LoginService>();
  private readonly loginWaiters = new Set<() => void>();
  private readonly localReports = new Set<(message: string) => void>();

  private readonly binding: RemoteServiceBinding;
  private readonly session: SessionService;

  private constructor(
    binding: RemoteServiceBinding,
    session: SessionService,
    info: Hello,
    release: Release,
  ) {
    this.binding = binding;
    this.session = session;
    this.info = info;
    this.releaseInfo = release;
    binding.observe(Conversations, (instance) => {
      const name = instance.about.value?.name;
      if (name === undefined) return;
      this.instances.set(name, instance);
      for (const view of this.views.get(name) ?? []) view.bind(instance);
      for (const waiter of this.instanceWaiters) waiter();
    });
    binding.observe(Logins, (instance) => {
      const id = instance.state.value?.id;
      if (id === undefined) return;
      this.logins.set(id, instance);
      for (const waiter of this.loginWaiters) waiter();
    });
    session.hello.subscribe((value) => {
      this.info = value;
    });
    session.release.subscribe((value) => {
      this.releaseInfo = value;
    });
  }

  /** Bind to a connected transport and wait for the core's hello. */
  static async open(
    transport: RemoteServiceTransport,
    onError: (error: Error) => void,
  ): Promise<RemoteClient> {
    const binding = createRemoteServiceBinding({
      services: [Session, Conversations, Logins].map(({ id }) => ({ id })),
      transport,
      onError,
    });
    const session = binding.use(Session);
    await binding.ready(context);
    const info = session.hello.value;
    const release = session.release.value;
    if (info === undefined || release === undefined) throw new Error("Monchu sent no hello");
    return new RemoteClient(binding, session, info, release);
  }

  /** The connection dropped: calls fail until `reconnected`. */
  async disconnected(): Promise<void> {
    this.instances.clear();
    this.logins.clear();
    this.notice(
      this.releaseInfo.updating === null
        ? "connection to Monchu lost · reconnecting"
        : `Monchu is installing ${this.releaseInfo.updating} · reconnecting`,
    );
    await this.binding.rebind(false, context).catch(() => {});
  }

  /** A new connection is attached: resubscribe, then reopen every conversation still shown. */
  async reconnected(): Promise<void> {
    await this.binding.rebind(true, context);
    await this.binding.ready(context);
    for (const name of this.views.keys()) await this.session.open(name, context);
    this.notice("reconnected to Monchu");
  }

  /** Tell this client's report listeners something about the connection itself. */
  notice(message: string): void {
    for (const listener of this.localReports) listener(message);
  }

  async close(): Promise<void> {
    await this.binding.dispose(context).catch(() => {});
  }

  get home(): string {
    return this.info.home;
  }

  get notes(): readonly string[] {
    return this.info.notes;
  }

  get settings(): Hello["settings"] {
    return this.info.settings;
  }

  skills(): readonly { name: string; description: string }[] {
    return this.info.skills;
  }

  model(ref: ModelRef): Model<Api> | undefined {
    return this.info.models.find(
      (model) => model.provider === ref.provider && model.id === ref.modelId,
    );
  }

  /** Chord facades are proxies that treat any member as remote, `then` included: never resolve a promise with one. */
  private instance(name: string): Promise<{ instance: ConversationService }> {
    return new Promise((resolve) => {
      const check = () => {
        const instance = this.instances.get(name);
        if (instance === undefined) return;
        this.instanceWaiters.delete(check);
        resolve({ instance });
      };
      this.instanceWaiters.add(check);
      check();
    });
  }

  async viewState(workerName?: string): Promise<AttachedReplicatedState<ConversationView>> {
    const name = workerName ?? "";
    await this.session.open(name, context);
    const { instance } = await this.instance(name);
    const initial = await first<ConversationView>(
      (listener) => instance.view.subscribe(listener),
      () => true,
    );
    const view = new RemoteView(initial, () => {
      const views = this.views.get(name);
      views?.delete(view);
      if (views?.size === 0) this.views.delete(name);
      void this.session.close(name, context).catch(() => {});
    });
    const views = this.views.get(name) ?? new Set();
    views.add(view);
    this.views.set(name, views);
    view.bind(instance);
    return view;
  }

  skillInput(name: string, text: string) {
    return this.session.skillInput(name, text, context);
  }
  submit(message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.session.submit(message, requestId, whenBusy, context);
  }
  messageWorker(name: string, message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.session.messageWorker(name, message, requestId, whenBusy, context);
  }
  editQueued(
    workerName: string | undefined,
    id: number,
    change: Parameters<Client["editQueued"]>[2],
  ) {
    return this.session.editQueued(workerName ?? null, id, change, context);
  }
  abort() {
    return this.session.abort(context);
  }
  stopWorker(name: string) {
    return this.session.stopWorker(name, context);
  }
  reset(handoff: string | undefined) {
    return this.session.reset(handoff ?? null, context);
  }
  compact(instructions: string | undefined) {
    return this.session.compact(instructions ?? null, context);
  }
  changeDirectory(path: string, workerName?: string) {
    return this.session.changeDirectory(path, workerName ?? null, context);
  }
  workers() {
    return this.session.workers(context);
  }
  goals() {
    return this.session.goals(context);
  }
  seeGoal(id: string, updatedAt: number) {
    return this.session.seeGoal(id, updatedAt, context);
  }
  async jobs() {
    const state = this.session.jobs.value ?? { jobs: [], events: [], nextEvent: 1 };
    return { ...state, listing: await this.session.jobsListing(context) };
  }
  async watchJobEvents(after: number, listener: Parameters<Client["watchJobEvents"]>[1]) {
    let seen = after;
    return this.session.jobs.subscribe((value) => {
      const fresh = value.events.filter((event) => event.id > seen);
      const last = fresh.at(-1);
      if (last === undefined) return;
      seen = last.id;
      listener(fresh);
    });
  }
  async watchAssessments(listener: Parameters<Client["watchAssessments"]>[0]) {
    return this.session.assessments.subscribe((value) => listener(value.items));
  }
  modelChoice(workerName?: string) {
    return this.session.modelChoice(workerName ?? null, context);
  }
  roleChoice(role: "front" | "worker") {
    return this.session.roleChoice(role, context);
  }
  pickModel(pick: Parameters<Client["pickModel"]>[0], saveDefault: boolean, workerName?: string) {
    return this.session.pickModel(pick, saveDefault, workerName ?? null, context);
  }
  saveDefault(role: "front" | "worker", pick: Parameters<Client["saveDefault"]>[1]) {
    return this.session.saveDefault(role, pick, context);
  }
  async loginNeeds() {
    const needs = await this.session.loginNeeds(context);
    return { ...needs, classifier: needs.classifier ?? undefined };
  }
  mcpServers() {
    return this.session.mcpServers(context);
  }
  mcpLogout(name: string) {
    return this.session.mcpLogout(name, context);
  }
  mcpReconnect() {
    return this.session.mcpReconnect(context);
  }
  reload() {
    return this.session.reload(context);
  }
  routing(paused?: boolean) {
    return this.session.routing(paused ?? null, context);
  }
  logs(query: Parameters<Client["logs"]>[0]) {
    return this.session.logs(query, context);
  }
  record(scope: "tui" | "web", body: string, attributes?: Parameters<Client["record"]>[2]): void {
    // Telemetry is best effort: a lost record never fails the client.
    void this.session.record(scope, body, attributes ?? null, context).catch(() => {});
  }
  restart() {
    return this.session.restart(context);
  }
  onRestartRequest(): () => void {
    return () => {};
  }
  get release(): Release {
    return this.releaseInfo;
  }
  onRelease(listener: (release: Release) => void): () => void {
    return this.session.release.subscribe((value) => listener(value));
  }
  update(release: string) {
    return this.session.update(release, context);
  }

  onReload(listener: () => void): () => void {
    let hydrated = false;
    return this.session.hello.subscribe(() => {
      if (hydrated) listener();
      hydrated = true;
    });
  }

  onReport(listener: (message: string) => void): () => void {
    let seen = 0;
    const stop = this.session.reports.subscribe((value) => {
      const newest = value.recent.at(-1)?.id ?? 0;
      // A restarted core numbers its reports from 1 again.
      if (newest < seen) seen = 0;
      for (const report of value.recent) if (report.id > seen) listener(report.message);
      seen = Math.max(seen, newest);
    });
    this.localReports.add(listener);
    return () => {
      stop();
      this.localReports.delete(listener);
    };
  }

  private loginInstance(id: number): Promise<{ instance: LoginService }> {
    return new Promise((resolve) => {
      const check = () => {
        const instance = this.logins.get(id);
        if (instance === undefined) return;
        this.loginWaiters.delete(check);
        resolve({ instance });
      };
      this.loginWaiters.add(check);
      check();
    });
  }

  /** Follow one login on the core: answer its prompts here, pass its events on, settle with its outcome. */
  private follow(
    id: number,
    signal: AbortSignal | undefined,
    onEvent: (event: LoginState["events"][number]) => void,
    answer: (request: NonNullable<LoginState["prompt"]>["request"]) => Promise<string | null>,
  ): Promise<string> {
    return this.loginInstance(id).then(
      ({ instance }) =>
        new Promise<string>((resolve, reject) => {
          let events = 0;
          let prompted = 0;
          const cancel = () => void instance.cancel(context).catch(() => {});
          signal?.addEventListener("abort", cancel, { once: true });
          const stop = instance.state.subscribe((state) => {
            for (const event of state.events.slice(events)) onEvent(event);
            events = state.events.length;
            const prompt = state.prompt;
            if (prompt !== null && prompt.id > prompted) {
              prompted = prompt.id;
              void answer(prompt.request)
                .catch(() => null)
                .then((value) => instance.answer(prompt.id, value, context))
                .catch(() => {});
            }
            if (state.done === null) return;
            stop();
            signal?.removeEventListener("abort", cancel);
            if (state.done.ok) resolve(state.done.message);
            else reject(new Error(`Login ${state.done.message}`));
          });
        }),
    );
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    const id = await this.session.login(
      providerId,
      type === "api_key" ? "api_key" : "oauth",
      context,
    );
    await this.follow(
      id,
      interaction.signal,
      (event) => interaction.notify(event),
      (request) =>
        interaction.prompt(
          interaction.signal === undefined ? request : { ...request, signal: interaction.signal },
        ),
    );
  }

  async mcpLogin(
    name: string,
    prompt: Parameters<Client["mcpLogin"]>[1],
    signal: AbortSignal,
  ): Promise<string> {
    const id = await this.session.mcpLogin(name, context);
    return this.follow(
      id,
      signal,
      (event) => {
        if (event.type === "auth_url") prompt.showAuthorizationUrl(event.url);
      },
      async () => (await prompt.promptForRedirectUrl?.(signal)) ?? null,
    );
  }
}
