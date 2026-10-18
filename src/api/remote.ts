/**
 * `Client` for a core in another process, over Chord references to the contracts in `contract.ts`. Browser-safe: the
 * terminal attached over the local socket and the web page both use it. State keeps its last value through a reconnect
 * and picks up again from a fresh snapshot.
 */
import {
  isChordError,
  type AnyContract,
  type GetOptions,
  type Host,
  type InputOf,
  type Readable,
  type Ref,
} from "@earendil-works/chord";
import type { Api, AuthInteraction, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  ATTACHMENT_MAX_BYTES,
  formatBytes,
  toBase64,
  UPLOAD_CHUNK_BYTES,
  type Attachment,
} from "./attachments.ts";
import type { Client, LoginEntry, RootClient, RootSummary, Watched } from "./client.ts";
import {
  Conversation,
  Root,
  Session,
  type Hello,
  type LoginState,
  type Principal,
} from "./contract.ts";
import { Lasting, UPDATE_REGAIN_FOR_MS } from "./lasting.ts";
import type { Release } from "./release.ts";

/** A failure as a client shows it: the core's own message, without Chord's code for an ordinary error. */
function plain(error: unknown): Error {
  if (isChordError(error, "unavailable") && error.reason === undefined)
    return new Error(error.message.replace(/^unavailable: /, ""), { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/** Attachments as a call carries them: left out when there are none. */
const sent = (attachments: readonly Attachment[] | undefined) =>
  attachments?.length ? { attachments: [...attachments] } : {};

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
    const lasting = await this.client.hold(Conversation, {
      root: this.id,
      ...(workerName === undefined ? {} : { worker: workerName }),
    });
    return lasting.state((ref) => ref.view, true);
  }
  /**
   * Sends the file in chunks under the socket's message limit. A chunk waits through a dropped connection, such as a
   * phone's file picker suspending the page, and goes again once the core is back: a retried chunk writes the same bytes.
   */
  async attach(name: string, data: Uint8Array) {
    if (data.length > ATTACHMENT_MAX_BYTES)
      throw new Error(
        `${name} is larger than the ${formatBytes(ATTACHMENT_MAX_BYTES)} attachment limit`,
      );
    const upload = crypto.randomUUID();
    for (let offset = 0; ; offset += UPLOAD_CHUNK_BYTES) {
      const done = offset + UPLOAD_CHUNK_BYTES >= data.length;
      const chunk = toBase64(data.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
      const stored = await this.client.outlast(async () =>
        (await this.client.rootRef(this.id)).upload({ upload, name, offset, data: chunk, done }),
      );
      if (done) {
        if (stored === null) throw new Error(`Upload of ${name} did not finish`);
        return stored;
      }
    }
  }
  submit(
    message: string,
    requestId: string,
    whenBusy: "steer" | "followUp",
    attachments?: readonly Attachment[],
  ) {
    return this.run((root) => root.submit({ message, requestId, whenBusy, ...sent(attachments) }));
  }
  messageWorker(
    name: string,
    message: string,
    requestId: string,
    whenBusy: "steer" | "followUp",
    attachments?: readonly Attachment[],
  ) {
    return this.run((root) =>
      root.messageWorker({ worker: name, message, requestId, whenBusy, ...sent(attachments) }),
    );
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
  async watchNotices(listener: Parameters<RootClient["watchNotices"]>[0]) {
    const state = (await this.client.hold(Root, { root: this.id })).state(
      (ref) => ref.notices,
      true,
    );
    const stop = state.subscribe(listener);
    return () => {
      stop();
      state.dispose();
    };
  }
  statusLines() {
    return this.run((root) => root.statusLines());
  }
  command(name: string, text: string, workerName?: string) {
    return this.run((root) =>
      root.command({ name, text, ...(workerName === undefined ? {} : { worker: workerName }) }),
    );
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

/** Whether the core answers: live, out of reach and redialled (`updating` while it installs a release), or gone. */
export type Connection = "live" | "lost" | "updating" | "gone";

export class RemoteClient implements Client {
  readonly restartsProcess = false;
  /** The client host whose upstream is the core. */
  readonly host: Host<Principal>;
  private readonly localReports = new Set<(message: string) => void>();
  private readonly reconnects = new Set<(ms: number) => void>();
  private readonly connections = new Set<(state: Connection) => void>();
  private readonly session: Lasting<typeof Session>;
  private readonly helloState: Watched<Hello>;
  private readonly releaseState: Watched<Release>;
  /** Method-only references to the roots this client called, kept until it closes. */
  private readonly roots = new Map<string, Promise<Lasting<typeof Root>>>();
  private lostAt: number | undefined;
  /** Says `gone` if the session is still out of reach once its patience is over, whatever kept it from answering. */
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private ended = false;

  private readonly outdated: () => void;

  private constructor(
    host: Host<Principal>,
    session: Lasting<typeof Session>,
    outdated: () => void,
  ) {
    this.host = host;
    this.session = session;
    this.outdated = outdated;
    session.onOutdated = outdated;
    this.helloState = session.state((ref) => ref.hello);
    this.releaseState = session.state((ref) => ref.releaseState);
    session.patience = () => this.patience();
    session.onReach((reach) => {
      if (reach === "lost") return this.disconnected();
      if (reach === "gone") return this.gone();
      clearTimeout(this.watchdog);
      this.ended = false;
      const lost = this.lostAt;
      this.lostAt = undefined;
      if (lost === undefined) return;
      this.notice("reconnected to Monchu");
      this.tell("live");
      for (const listener of this.reconnects) listener(Date.now() - lost);
    });
  }

  /**
   * Start on a client host connected to the core: the values every client shows from its first screen. `outdated` hears
   * a core that came back with contracts newer than this client's.
   */
  static async open(host: Host<Principal>, outdated: () => void): Promise<RemoteClient> {
    return new RemoteClient(host, await Lasting.open(host, Session, {}), outdated);
  }

  /** How long a lost core is waited for: longer while it installs an update. */
  patience(): number {
    return this.release.updating === null ? 30_000 : UPDATE_REGAIN_FOR_MS;
  }

  /** A lasting reference of this client, as patient as its session. */
  async hold<C extends AnyContract>(
    type: C,
    input: InputOf<C>,
    options: GetOptions<Principal> = {},
  ): Promise<Lasting<C>> {
    const lasting = await this.run(() => Lasting.open(this.host, type, input, options));
    lasting.patience = () => this.patience();
    lasting.onOutdated = this.outdated;
    // A view or root that can't be had again leaves this client showing stale values: it is as gone as the session.
    lasting.onReach((reach) => {
      if (reach === "gone") this.gone();
    });
    return lasting;
  }

  /** Whether the core answers: false while a reconnect or a new core gets the session again. */
  get connected(): boolean {
    return this.session.reach === "live";
  }

  /** Resolves once the session is live again. */
  live(): Promise<void> {
    return this.session.live();
  }

  /** Hears each reconnect, with how long the core was out of reach; returns an unsubscribe function. */
  onReconnect(listener: (ms: number) => void): () => void {
    this.reconnects.add(listener);
    return () => this.reconnects.delete(listener);
  }

  /** Runs a call while connected: calls fail at once while the core is out of reach, as the client's notices say. */
  async run<T>(call: () => Promise<T>): Promise<T> {
    if (!this.connected) throw new Error("Not connected to Monchu");
    try {
      return await call();
    } catch (error) {
      throw plain(error);
    }
  }

  /** Runs a call that is safe to repeat, waiting while the core is out of reach and again after a drop cut it off. */
  async outlast<T>(call: () => Promise<T>): Promise<T> {
    for (;;) {
      await this.live();
      try {
        return await call();
      } catch (error) {
        // The link closed under the call; anything else is the core's answer.
        if (this.connected) throw plain(error);
      }
    }
  }

  async rootRef(id: string): Promise<Ref<typeof Root>> {
    let lasting = this.roots.get(id);
    if (lasting === undefined) {
      lasting = this.hold(Root, { root: id }, { state: false });
      this.roots.set(id, lasting);
      // An unknown root is asked again next time.
      lasting.catch(() => this.roots.delete(id));
    }
    return (await lasting).ref;
  }

  /** The core is out of reach: calls fail until it is back; values stay as they were. */
  private disconnected(): void {
    if (this.lostAt !== undefined) return;
    this.lostAt = Date.now();
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.gone(), this.patience() + 5000);
    const updating = this.release.updating;
    this.notice(
      updating === null
        ? "connection to Monchu lost · reconnecting"
        : `Monchu is installing ${updating} · reconnecting`,
    );
    this.tell(updating === null ? "lost" : "updating");
  }

  /** The redials gave up: the core stays out of reach until it is started again. */
  gone(): void {
    clearTimeout(this.watchdog);
    if (this.ended) return;
    this.ended = true;
    this.notice("Monchu is gone; start it again, then reload");
    this.tell("gone");
  }

  /** Hears each change of the connection; returns an unsubscribe function. */
  onConnection(listener: (state: Connection) => void): () => void {
    this.connections.add(listener);
    return () => this.connections.delete(listener);
  }

  private tell(state: Connection): void {
    for (const listener of this.connections) listener(state);
  }

  /** Tell this client's report listeners something about the connection itself. */
  private notice(message: string): void {
    for (const listener of this.localReports) listener(message);
  }

  close(): void {
    clearTimeout(this.watchdog);
    this.session.release();
    for (const lasting of this.roots.values())
      void lasting.then(
        (root) => root.release(),
        () => {},
      );
    this.roots.clear();
  }

  private get hello(): Hello {
    return this.helloState.value;
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

  commands(): readonly { name: string; usage: string; help: string }[] {
    return this.hello.commands;
  }

  logins(): readonly LoginEntry[] {
    return this.hello.logins;
  }

  model(ref: ModelRef): Model<Api> | undefined {
    return this.hello.models.find(
      (model) => model.provider === ref.provider && model.id === ref.modelId,
    );
  }

  /** Follows one of the session's state members, its current value first, until the returned function runs. */
  private followState<T>(
    pick: (ref: Ref<typeof Session>) => Readable<T>,
    listener: (value: T) => void,
  ) {
    const state = this.session.state(pick);
    const stop = state.subscribe(listener);
    return () => {
      stop();
      state.dispose();
    };
  }

  root(id: string): RootClient {
    return new RemoteRoot(this, id);
  }
  async watchRoots(listener: (roots: readonly RootSummary[]) => void) {
    return this.followState((ref) => ref.roots, listener);
  }
  findRoot(prefix: string) {
    return this.run(() => this.session.ref.findRoot({ prefix }));
  }
  currentRoot() {
    return this.run(() => this.session.ref.currentRoot());
  }
  createRoot(requestId: string) {
    return this.run(() => this.session.ref.createRoot({ requestId }));
  }
  renameRoot(id: string, label: string) {
    return this.run(() => this.session.ref.renameRoot({ root: id, label }));
  }
  archiveRoot(id: string, archived: boolean) {
    return this.run(() => this.session.ref.archiveRoot({ root: id, archived }));
  }

  skillInput(name: string, text: string) {
    return this.run(() => this.session.ref.skillInput({ name, text }));
  }
  jobs() {
    return this.run(() => this.session.ref.jobs());
  }
  async watchJobEvents(after: number, listener: Parameters<Client["watchJobEvents"]>[1]) {
    let seen = after;
    return this.followState(
      (ref) => ref.jobsState,
      (value) => {
        const fresh = value.events.filter((event) => event.id > seen);
        const last = fresh.at(-1);
        if (last === undefined) return;
        seen = last.id;
        listener(fresh);
      },
    );
  }
  async watchSecrets(listener: Parameters<Client["watchSecrets"]>[0]) {
    return this.followState((ref) => ref.secrets, listener);
  }
  /** The owner's session, or a refusal for a service login, which has no secret methods. */
  private owner() {
    const session = this.session.ref;
    if (session.variant !== "owner")
      throw new Error("Only a person's login can change secrets, not a service token");
    return session;
  }
  setSecret(input: Parameters<Client["setSecret"]>[0]) {
    return this.run(() => this.owner().setSecret({ input }));
  }
  deleteSecret(name: string) {
    return this.run(() => this.owner().deleteSecret({ name }));
  }
  declineSecret(name: string) {
    return this.run(() => this.owner().declineSecret({ name }));
  }
  roleChoice(role: "front" | "worker") {
    return this.run(() => this.session.ref.roleChoice({ role }));
  }
  saveDefault(role: "front" | "worker", pick: Parameters<Client["saveDefault"]>[1]) {
    return this.run(() => this.session.ref.saveDefault({ role, pick }));
  }
  async loginNeeds() {
    return this.run(() => this.session.ref.loginNeeds());
  }
  mcpServers() {
    return this.run(() => this.session.ref.mcpServers());
  }
  mcpLogout(name: string) {
    return this.run(() => this.session.ref.mcpLogout({ name }));
  }
  mcpReconnect() {
    return this.run(() => this.session.ref.mcpReconnect());
  }
  reload() {
    return this.run(() => this.session.ref.reload());
  }
  logs(query: Parameters<Client["logs"]>[0]) {
    return this.run(() => this.session.ref.logs({ query }));
  }
  record(scope: "tui" | "web", body: string, attributes?: Parameters<Client["record"]>[2]): void {
    // Telemetry is best effort: a lost record never fails the client.
    void this.run(() =>
      this.session.ref.record({ scope, body, ...(attributes === undefined ? {} : { attributes }) }),
    ).catch(() => {});
  }
  restart() {
    return this.run(() => this.session.ref.restart());
  }
  onRestartRequest(): () => void {
    return () => {};
  }
  get release(): Release {
    return this.releaseState.value;
  }
  onRelease(listener: (release: Release) => void): () => void {
    return this.releaseState.subscribe(listener);
  }
  update(release: string) {
    const session = this.session.ref;
    if (session.variant !== "owner")
      return Promise.reject(
        new Error("Only a person's login can update Monchu, not a service token"),
      );
    return this.run(() => session.update({ release }));
  }

  onReload(listener: () => void): () => void {
    let hydrated = false;
    return this.helloState.subscribe(() => {
      if (hydrated) listener();
      hydrated = true;
    });
  }

  onReport(
    listener: (message: string) => void,
    options: { connection?: boolean } = {},
  ): () => void {
    let seen = 0;
    const stop = this.followState(
      (ref) => ref.reports,
      (value) => {
        const newest = value.recent.at(-1)?.id ?? 0;
        // A restarted core, or a new connection, numbers its reports from 1 again.
        if (newest < seen) seen = 0;
        for (const report of value.recent) if (report.id > seen) listener(report.message);
        seen = Math.max(seen, newest);
      },
    );
    if (options.connection !== false) this.localReports.add(listener);
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
        void this.run(() => this.session.ref.loginCancel({ login: id })).catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        queueMicrotask(() => stop());
        stopStatus();
        signal?.removeEventListener("abort", cancel);
      };
      // A reconnect can't bring a login back: the core cancels a connection's logins when it goes.
      const stopStatus = this.session.onReach((reach) => {
        if (reach === "live") return;
        finish();
        reject(new Error("Login ended: connection lost"));
      });
      const stop = this.followState(
        (ref) => ref.logins,
        (logins) => {
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
                this.run(() =>
                  this.session.ref.loginAnswer({ login: id, prompt: prompt.id, value }),
                ),
              )
              .catch(() => {});
          }
          if (state.done === null) return;
          finish();
          if (state.done.ok) resolve(state.done.message);
          else reject(new Error(`Login ${state.done.message}`));
        },
      );
    });
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    const id = await this.run(() =>
      this.session.ref.login({
        provider: providerId,
        auth: type === "api_key" ? "api_key" : "oauth",
      }),
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
    const id = await this.run(() => this.session.ref.mcpLogin({ server: name }));
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
