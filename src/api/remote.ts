/**
 * `Client` for a core in another process, over Chord references to the contracts in `contract.ts`. Browser-safe: the
 * terminal attached over the local socket and the web page both use it. State keeps its last value through a reconnect
 * and picks up again from a fresh snapshot.
 */
import { isChordError, type Host, type Readable, type Ref } from "@earendil-works/chord";
import type { Api, AuthInteraction, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Client, RootClient, RootSummary, Watched } from "./client.ts";
import {
  Conversation,
  Root,
  Session,
  type Hello,
  type LoginState,
  type Principal,
} from "./contract.ts";
import type { Release } from "./release.ts";

/** A failure as a client shows it: the core's own message, without Chord's code for an ordinary error. */
function plain(error: unknown): Error {
  if (isChordError(error, "unavailable") && error.reason === undefined)
    return new Error(error.message.replace(/^unavailable: /, ""), { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/** A state member as clients render it: its last value stays readable after the reference goes. */
function watched<T>(state: Readable<T>, release: () => void): Watched<T> {
  let last = state.value;
  const listeners = new Set<(value: T) => void>();
  const stop = state.subscribe((value) => {
    last = value;
    for (const listener of listeners) listener(value);
  });
  return {
    get value() {
      return last;
    },
    subscribe(listener) {
      listeners.add(listener);
      queueMicrotask(() => {
        if (listeners.has(listener)) listener(last);
      });
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      stop();
      release();
    },
  };
}

/** Follows `state`, its current value first, until the returned function runs. */
function following<T>(state: Readable<T>, listener: (value: T) => void): () => void {
  return state.subscribe(listener);
}

/** One root of a remote core. */
class RemoteRoot implements RootClient {
  readonly id: string;
  private readonly client: RemoteClient;
  constructor(client: RemoteClient, id: string) {
    this.client = client;
    this.id = id;
  }

  private run<T>(call: (root: Ref<typeof Root>) => Promise<T>): Promise<T> {
    return this.client.run(async () => call(await this.client.rootRef(this.id)));
  }

  async viewState(workerName?: string) {
    const ref = await this.client.run(() =>
      this.client.host.get(Conversation, {
        root: this.id,
        ...(workerName === undefined ? {} : { worker: workerName }),
      }),
    );
    return watched(ref.view, () => ref.release());
  }
  submit(message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.run((root) => root.submit({ message, requestId, whenBusy }));
  }
  messageWorker(name: string, message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.run((root) => root.messageWorker({ worker: name, message, requestId, whenBusy }));
  }
  editQueued(
    workerName: string | undefined,
    id: number,
    change: Parameters<RootClient["editQueued"]>[2],
  ) {
    return this.run((root) =>
      root.editQueued({ id, change, ...(workerName === undefined ? {} : { worker: workerName }) }),
    );
  }
  abort() {
    return this.run((root) => root.abort());
  }
  stopWorker(name: string) {
    return this.run((root) => root.stopWorker({ worker: name }));
  }
  reset(handoff: string | undefined) {
    return this.run((root) => root.reset(handoff === undefined ? {} : { handoff }));
  }
  compact(instructions: string | undefined) {
    return this.run((root) => root.compact(instructions === undefined ? {} : { instructions }));
  }
  changeDirectory(path: string, workerName?: string) {
    return this.run((root) =>
      root.changeDirectory({ path, ...(workerName === undefined ? {} : { worker: workerName }) }),
    );
  }
  workers() {
    return this.run((root) => root.workers());
  }
  handOff(workerName: string, toRoot: string) {
    return this.run((root) => root.handOff({ worker: workerName, toRoot }));
  }
  goals() {
    return this.run((root) => root.goals());
  }
  seeGoal(id: string, updatedAt: number) {
    return this.run((root) => root.seeGoal({ id, updatedAt }));
  }
  async watchAssessments(listener: Parameters<RootClient["watchAssessments"]>[0]) {
    const ref = await this.client.run(() => this.client.host.get(Root, { root: this.id }));
    const stop = following(ref.assessments, listener);
    return () => {
      stop();
      ref.release();
    };
  }
  routing(paused?: boolean) {
    return this.run((root) => root.routing(paused === undefined ? {} : { paused }));
  }
  modelChoice(workerName?: string) {
    return this.run((root) =>
      root.modelChoice(workerName === undefined ? {} : { worker: workerName }),
    );
  }
  pickModel(
    pick: Parameters<RootClient["pickModel"]>[0],
    saveDefault: boolean,
    workerName?: string,
  ) {
    return this.run((root) =>
      root.pickModel({
        pick,
        saveDefault,
        ...(workerName === undefined ? {} : { worker: workerName }),
      }),
    );
  }
}

export class RemoteClient implements Client {
  readonly restartsProcess = false;
  /** The client host whose upstream is the core. */
  readonly host: Host<Principal>;
  private readonly localReports = new Set<(message: string) => void>();
  private readonly session: Ref<typeof Session>;
  /** Method-only references to the roots this client called, kept until it closes. */
  private readonly roots = new Map<string, Promise<Ref<typeof Root>>>();

  private constructor(host: Host<Principal>, session: Ref<typeof Session>) {
    this.host = host;
    this.session = session;
  }

  /** Start on a client host connected to the core: the values every client shows from its first screen. */
  static async open(host: Host<Principal>): Promise<RemoteClient> {
    return new RemoteClient(host, await host.get(Session, {}));
  }

  /** Whether the core answers: false while a reconnect re-holds the session. */
  get connected(): boolean {
    return this.session.status === "live";
  }

  /** Resolves once the session is live again after a reconnect. */
  live(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.session.onStatus((status) => {
        if (status !== "live") return;
        stop();
        resolve();
      });
    });
  }

  /** Runs a call while connected: calls fail at once while the connection is down, as the client's notices say. */
  async run<T>(call: () => Promise<T>): Promise<T> {
    if (!this.connected) throw new Error("Not connected to Monchu");
    try {
      return await call();
    } catch (error) {
      throw plain(error);
    }
  }

  rootRef(id: string): Promise<Ref<typeof Root>> {
    let ref = this.roots.get(id);
    if (ref === undefined) {
      ref = this.host.get(Root, { root: id }, { state: false });
      this.roots.set(id, ref);
      // An unknown root is asked again next time.
      ref.catch(() => this.roots.delete(id));
    }
    return ref;
  }

  /** The connection dropped: calls fail until it is back; values stay as they were. */
  disconnected(): void {
    const updating = this.release.updating;
    this.notice(
      updating === null
        ? "connection to Monchu lost · reconnecting"
        : `Monchu is installing ${updating} · reconnecting`,
    );
  }

  /** A new connection was admitted, and every reference held again. */
  reconnected(): void {
    this.notice("reconnected to Monchu");
  }

  /** Tell this client's report listeners something about the connection itself. */
  notice(message: string): void {
    for (const listener of this.localReports) listener(message);
  }

  close(): void {
    this.session.release();
    for (const ref of this.roots.values())
      void ref.then(
        (root) => root.release(),
        () => {},
      );
    this.roots.clear();
  }

  private get hello(): Hello {
    return this.session.hello.value;
  }

  get home(): string {
    return this.hello.home;
  }

  get notes(): readonly string[] {
    return this.hello.notes;
  }

  get settings(): Hello["settings"] {
    return this.hello.settings;
  }

  skills(): readonly { name: string; description: string }[] {
    return this.hello.skills;
  }

  model(ref: ModelRef): Model<Api> | undefined {
    return this.hello.models.find(
      (model) => model.provider === ref.provider && model.id === ref.modelId,
    );
  }

  root(id: string): RootClient {
    return new RemoteRoot(this, id);
  }
  async watchRoots(listener: (roots: readonly RootSummary[]) => void) {
    return following(this.session.roots, listener);
  }
  findRoot(prefix: string) {
    return this.run(() => this.session.findRoot({ prefix }));
  }
  currentRoot() {
    return this.run(() => this.session.currentRoot());
  }
  createRoot(requestId: string) {
    return this.run(() => this.session.createRoot({ requestId }));
  }
  renameRoot(id: string, label: string) {
    return this.run(() => this.session.renameRoot({ root: id, label }));
  }
  archiveRoot(id: string, archived: boolean) {
    return this.run(() => this.session.archiveRoot({ root: id, archived }));
  }

  skillInput(name: string, text: string) {
    return this.run(() => this.session.skillInput({ name, text }));
  }
  jobs() {
    return this.run(() => this.session.jobs());
  }
  async watchJobEvents(after: number, listener: Parameters<Client["watchJobEvents"]>[1]) {
    let seen = after;
    return following(this.session.jobsState, (value) => {
      const fresh = value.events.filter((event) => event.id > seen);
      const last = fresh.at(-1);
      if (last === undefined) return;
      seen = last.id;
      listener(fresh);
    });
  }
  roleChoice(role: "front" | "worker") {
    return this.run(() => this.session.roleChoice({ role }));
  }
  saveDefault(role: "front" | "worker", pick: Parameters<Client["saveDefault"]>[1]) {
    return this.run(() => this.session.saveDefault({ role, pick }));
  }
  async loginNeeds() {
    const needs = await this.run(() => this.session.loginNeeds());
    return { ...needs, classifier: needs.classifier ?? undefined };
  }
  mcpServers() {
    return this.run(() => this.session.mcpServers());
  }
  mcpLogout(name: string) {
    return this.run(() => this.session.mcpLogout({ name }));
  }
  mcpReconnect() {
    return this.run(() => this.session.mcpReconnect());
  }
  reload() {
    return this.run(() => this.session.reload());
  }
  logs(query: Parameters<Client["logs"]>[0]) {
    return this.run(() => this.session.logs({ query }));
  }
  record(scope: "tui" | "web", body: string, attributes?: Parameters<Client["record"]>[2]): void {
    // Telemetry is best effort: a lost record never fails the client.
    void this.run(() =>
      this.session.record({ scope, body, ...(attributes === undefined ? {} : { attributes }) }),
    ).catch(() => {});
  }
  restart() {
    return this.run(() => this.session.restart());
  }
  onRestartRequest(): () => void {
    return () => {};
  }
  get release(): Release {
    return this.session.releaseState.value;
  }
  onRelease(listener: (release: Release) => void): () => void {
    return this.session.releaseState.subscribe(listener);
  }
  update(release: string) {
    const session = this.session;
    if (session.variant !== "owner")
      return Promise.reject(
        new Error("Only a person's login can update Monchu, not a service token"),
      );
    return this.run(() => session.update({ release }));
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
      // A restarted core, or a new connection, numbers its reports from 1 again.
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

  /** Follow one of this connection's logins: answer its prompts here, pass its events on, settle with its outcome. */
  private follow(
    id: number,
    signal: AbortSignal | undefined,
    onEvent: (event: LoginState["events"][number]) => void,
    answer: (request: NonNullable<LoginState["prompt"]>["request"]) => Promise<string | null>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let events = 0;
      let prompted = 0;
      let started = false;
      const cancel = () =>
        void this.run(() => this.session.loginCancel({ login: id })).catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        queueMicrotask(() => stop());
        stopStatus();
        signal?.removeEventListener("abort", cancel);
      };
      // A reconnect can't bring a login back: the core cancels a connection's logins when it goes.
      const stopStatus = this.session.onStatus((status) => {
        if (status === "live") return;
        finish();
        reject(new Error(`Login ended: ${status === "loading" ? "connection lost" : status}`));
      });
      const stop = this.session.logins.subscribe((logins) => {
        const state = logins[String(id)];
        if (state === undefined) {
          if (!started) return;
          finish();
          return reject(new Error("Login ended: closed"));
        }
        started = true;
        for (const event of state.events.slice(events)) onEvent(event);
        events = state.events.length;
        const prompt = state.prompt;
        if (prompt !== null && prompt.id > prompted) {
          prompted = prompt.id;
          void answer(prompt.request)
            .catch(() => null)
            .then((value) =>
              this.run(() => this.session.loginAnswer({ login: id, prompt: prompt.id, value })),
            )
            .catch(() => {});
        }
        if (state.done === null) return;
        finish();
        if (state.done.ok) resolve(state.done.message);
        else reject(new Error(`Login ${state.done.message}`));
      });
    });
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    const id = await this.run(() =>
      this.session.login({ provider: providerId, auth: type === "api_key" ? "api_key" : "oauth" }),
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
    const id = await this.run(() => this.session.mcpLogin({ server: name }));
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
