/**
 * `Client` for a core in another process, over Monchu's own call + watch wire (`rpc.ts`). Browser-safe: the terminal
 * attached over the local socket and the web page both use it. Watches keep their last value through a reconnect and
 * pick up again from a fresh snapshot.
 */
import type { Api, AuthInteraction, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Client, RootClient, RootSummary } from "./client.ts";
import type {
  Args,
  Hello,
  Key,
  LoginState,
  Method,
  Reports,
  Results,
  Topic,
  Values,
} from "./contract.ts";
import type { Release } from "./release.ts";
import type { Rpc, Watch } from "./rpc.ts";

/** One root of a remote core: every call names it first. */
class RemoteRoot implements RootClient {
  readonly id: string;
  private readonly client: RemoteClient;
  constructor(client: RemoteClient, id: string) {
    this.client = client;
    this.id = id;
  }

  viewState(workerName?: string) {
    return this.client.watch("conversation", [this.id, workerName ?? null]);
  }
  submit(message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.client.call("submit", [this.id, message, requestId, whenBusy]);
  }
  messageWorker(name: string, message: string, requestId: string, whenBusy: "steer" | "followUp") {
    return this.client.call("messageWorker", [this.id, name, message, requestId, whenBusy]);
  }
  editQueued(
    workerName: string | undefined,
    id: number,
    change: Parameters<RootClient["editQueued"]>[2],
  ) {
    return this.client.call("editQueued", [this.id, workerName ?? null, id, change]);
  }
  abort() {
    return this.client.call("abort", [this.id]);
  }
  stopWorker(name: string) {
    return this.client.call("stopWorker", [this.id, name]);
  }
  reset(handoff: string | undefined) {
    return this.client.call("reset", [this.id, handoff ?? null]);
  }
  compact(instructions: string | undefined) {
    return this.client.call("compact", [this.id, instructions ?? null]);
  }
  changeDirectory(path: string, workerName?: string) {
    return this.client.call("changeDirectory", [this.id, path, workerName ?? null]);
  }
  workers() {
    return this.client.call("workers", [this.id]);
  }
  handOff(workerName: string, toRoot: string) {
    return this.client.call("handOff", [this.id, workerName, toRoot]);
  }
  goals() {
    return this.client.call("goals", [this.id]);
  }
  seeGoal(id: string, updatedAt: number) {
    return this.client.call("seeGoal", [this.id, id, updatedAt]);
  }
  watchAssessments(listener: Parameters<RootClient["watchAssessments"]>[0]) {
    return this.client.listen("assessments", [this.id], listener);
  }
  routing(paused?: boolean) {
    return this.client.call("routing", [this.id, paused ?? null]);
  }
  modelChoice(workerName?: string) {
    return this.client.call("modelChoice", [this.id, workerName ?? null]);
  }
  pickModel(
    pick: Parameters<RootClient["pickModel"]>[0],
    saveDefault: boolean,
    workerName?: string,
  ) {
    return this.client.call("pickModel", [this.id, pick, saveDefault, workerName ?? null]);
  }
}

export class RemoteClient implements Client {
  readonly restartsProcess = false;
  private readonly localReports = new Set<(message: string) => void>();
  private readonly rpc: Rpc;
  private readonly hello: Watch<Hello>;
  private readonly releaseState: Watch<Release>;
  private readonly reports: Watch<Reports>;

  private constructor(
    rpc: Rpc,
    hello: Watch<Hello>,
    release: Watch<Release>,
    reports: Watch<Reports>,
  ) {
    this.rpc = rpc;
    this.hello = hello;
    this.releaseState = release;
    this.reports = reports;
  }

  /** Start on an attached `Rpc`: the values every client shows from its first screen. */
  static async open(rpc: Rpc): Promise<RemoteClient> {
    const [hello, release, reports] = await Promise.all([
      rpc.watch<Hello>("hello", null),
      rpc.watch<Release>("release", null),
      rpc.watch<Reports>("reports", null),
    ]);
    return new RemoteClient(rpc, hello, release, reports);
  }

  call<M extends Method>(method: M, args: Args<M>): Promise<Results[M]> {
    return this.rpc.call<Results[M]>(method, args);
  }

  watch<T extends Topic>(topic: T, key: Key<T>): Promise<Watch<Values[T]>> {
    return this.rpc.watch<Values[T]>(topic, key);
  }

  /** Follows a topic until the returned function runs. */
  async listen<T extends Topic>(
    topic: T,
    key: Key<T>,
    listener: (value: Values[T]) => void,
  ): Promise<() => void> {
    const watch = await this.watch(topic, key);
    const stop = watch.subscribe(listener);
    return () => {
      stop();
      watch.dispose();
    };
  }

  /** The connection dropped: calls fail until it is back; values stay as they were. */
  disconnected(): void {
    const updating = this.releaseState.value.updating;
    this.notice(
      updating === null
        ? "connection to Monchu lost · reconnecting"
        : `Monchu is installing ${updating} · reconnecting`,
    );
  }

  /** A new connection said hello, and every watch asked again. */
  reconnected(): void {
    this.notice("reconnected to Monchu");
  }

  /** Tell this client's report listeners something about the connection itself. */
  notice(message: string): void {
    for (const listener of this.localReports) listener(message);
  }

  close(): void {
    for (const watch of [this.hello, this.releaseState, this.reports]) watch.dispose();
  }

  get home(): string {
    return this.hello.value.home;
  }

  get notes(): readonly string[] {
    return this.hello.value.notes;
  }

  get settings(): Hello["settings"] {
    return this.hello.value.settings;
  }

  skills(): readonly { name: string; description: string }[] {
    return this.hello.value.skills;
  }

  model(ref: ModelRef): Model<Api> | undefined {
    return this.hello.value.models.find(
      (model) => model.provider === ref.provider && model.id === ref.modelId,
    );
  }

  root(id: string): RootClient {
    return new RemoteRoot(this, id);
  }
  watchRoots(listener: (roots: readonly RootSummary[]) => void) {
    return this.listen("roots", null, listener);
  }
  findRoot(prefix: string) {
    return this.call("findRoot", [prefix]);
  }
  currentRoot() {
    return this.call("currentRoot", []);
  }
  createRoot(requestId: string) {
    return this.call("createRoot", [requestId]);
  }
  renameRoot(id: string, label: string) {
    return this.call("renameRoot", [id, label]);
  }
  archiveRoot(id: string, archived: boolean) {
    return this.call("archiveRoot", [id, archived]);
  }

  skillInput(name: string, text: string) {
    return this.call("skillInput", [name, text]);
  }
  jobs() {
    return this.call("jobs", []);
  }
  watchJobEvents(after: number, listener: Parameters<Client["watchJobEvents"]>[1]) {
    let seen = after;
    return this.listen("jobs", null, (value) => {
      const fresh = value.events.filter((event) => event.id > seen);
      const last = fresh.at(-1);
      if (last === undefined) return;
      seen = last.id;
      listener(fresh);
    });
  }
  roleChoice(role: "front" | "worker") {
    return this.call("roleChoice", [role]);
  }
  saveDefault(role: "front" | "worker", pick: Parameters<Client["saveDefault"]>[1]) {
    return this.call("saveDefault", [role, pick]);
  }
  async loginNeeds() {
    const needs = await this.call("loginNeeds", []);
    return { ...needs, classifier: needs.classifier ?? undefined };
  }
  mcpServers() {
    return this.call("mcpServers", []);
  }
  mcpLogout(name: string) {
    return this.call("mcpLogout", [name]);
  }
  mcpReconnect() {
    return this.call("mcpReconnect", []);
  }
  reload() {
    return this.call("reload", []);
  }
  logs(query: Parameters<Client["logs"]>[0]) {
    return this.call("logs", [query]);
  }
  record(scope: "tui" | "web", body: string, attributes?: Parameters<Client["record"]>[2]): void {
    // Telemetry is best effort: a lost record never fails the client.
    void this.call("record", [scope, body, attributes ?? null]).catch(() => {});
  }
  restart() {
    return this.call("restart", []);
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
    return this.call("update", [release]);
  }

  onReload(listener: () => void): () => void {
    let hydrated = false;
    return this.hello.subscribe(() => {
      if (hydrated) listener();
      hydrated = true;
    });
  }

  onReport(listener: (message: string) => void): () => void {
    let seen = 0;
    const stop = this.reports.subscribe((value) => {
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

  /** Follow one of this connection's logins: answer its prompts here, pass its events on, settle with its outcome. */
  private async follow(
    id: number,
    signal: AbortSignal | undefined,
    onEvent: (event: LoginState["events"][number]) => void,
    answer: (request: NonNullable<LoginState["prompt"]>["request"]) => Promise<string | null>,
  ): Promise<string> {
    const watch = await this.watch("login", [id]);
    return new Promise<string>((resolve, reject) => {
      let events = 0;
      let prompted = 0;
      const cancel = () => void this.call("loginCancel", [id]).catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        stop();
        watch.dispose();
        signal?.removeEventListener("abort", cancel);
      };
      const stop = watch.subscribe((state) => {
        for (const event of state.events.slice(events)) onEvent(event);
        events = state.events.length;
        const prompt = state.prompt;
        if (prompt !== null && prompt.id > prompted) {
          prompted = prompt.id;
          void answer(prompt.request)
            .catch(() => null)
            .then((value) => this.call("loginAnswer", [id, prompt.id, value]))
            .catch(() => {});
        }
        if (state.done === null) return;
        finish();
        if (state.done.ok) resolve(state.done.message);
        else reject(new Error(`Login ${state.done.message}`));
      });
      // A reconnect can't bring a login back: the core cancels a connection's logins when it goes.
      void watch.ended.then((reason) => {
        finish();
        reject(new Error(`Login ended: ${reason}`));
      });
    });
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    const id = await this.call("login", [providerId, type === "api_key" ? "api_key" : "oauth"]);
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
    const id = await this.call("mcpLogin", [name]);
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
