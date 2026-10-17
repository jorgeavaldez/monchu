import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  methods,
  topics,
  type Args,
  type Hello,
  type Key,
  type LoginPrompt,
  type LoginState,
  type Method,
  type Reports,
  type Results,
  type Topic,
} from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import type { JobsState } from "../core/jobs.ts";
import { Published, serveRpc, watchSource, type Source } from "./rpc.ts";

function hello(backend: Monchu): Hello {
  return {
    home: backend.home,
    settings: backend.settings,
    skills: [...backend.skills()],
    models: [...backend.catalog()],
    notes: [...backend.notes],
  };
}

function wirePrompt(prompt: AuthPrompt): LoginPrompt {
  switch (prompt.type) {
    case "select":
      return {
        type: "select",
        message: prompt.message,
        options: prompt.options.map((option) => ({ ...option })),
      };
    case "manual_code":
      return { type: "manual_code", message: prompt.message };
    default:
      return {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
  }
}

/** A value fed by a backend subscription for as long as one watch runs. */
async function fed<T>(
  initial: T,
  follow: (set: (value: T) => void) => Promise<() => void>,
): Promise<Source> {
  const published = new Published(initial);
  const stop = await follow((value) => published.set(value));
  const source = published.source();
  return {
    value: source.value,
    start: (emit, end) => source.start(emit, end),
    stop: () => {
      source.stop();
      stop();
    },
  };
}

/**
 * Serve one connection: `send` writes a message to it, and its owner feeds received ones to `receive`. The
 * conversations it watches and the logins it starts are its own, so another client never sees its login prompts.
 * `dispose` releases every watch and cancels its logins. `updates` is whether this connection's identity may replace
 * Monchu's code: a person, not a service login.
 */
export function serveConnection(
  backend: Monchu,
  { updates }: { updates: boolean },
  send: (text: string) => void,
): { receive(text: string): void; dispose(): void } {
  const cleanups: (() => void)[] = [];
  const helloState = new Published(hello(backend));
  cleanups.push(backend.onReload(() => helloState.set(hello(backend))));
  const reports = new Published<Reports>({ recent: [] });
  let nextReport = 1;
  cleanups.push(
    backend.onReport((message) =>
      reports.set({
        recent: [...reports.value.recent, { id: nextReport++, message }].slice(-20),
      }),
    ),
  );
  const release = new Published(backend.release);
  cleanups.push(backend.onRelease((value) => release.set(value)));

  const logins = new Map<
    number,
    {
      state: Published<LoginState>;
      controller: AbortController;
      answer(prompt: number, value: string | null): void;
    }
  >();
  let nextLogin = 1;

  /** Run one login for this connection: its prompts and events reach only this connection's `login` watch. */
  function startLogin(
    run: (
      update: (change: (state: LoginState) => LoginState) => void,
      ask: (request: LoginPrompt, signal?: AbortSignal) => Promise<string>,
      signal: AbortSignal,
    ) => Promise<string>,
  ): number {
    const id = nextLogin++;
    const controller = new AbortController();
    const state = new Published<LoginState>({ id, prompt: null, events: [], done: null });
    const update = (change: (state: LoginState) => LoginState) => state.set(change(state.value));
    let nextPrompt = 1;
    const answers = new Map<number, (value: string | null) => void>();
    const ask = (request: LoginPrompt, signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const promptId = nextPrompt++;
        const abort = () => {
          answers.delete(promptId);
          reject(new Error("Login cancelled"));
        };
        if (controller.signal.aborted || signal?.aborted) return abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        answers.set(promptId, (value) => {
          answers.delete(promptId);
          controller.signal.removeEventListener("abort", abort);
          signal?.removeEventListener("abort", abort);
          update((current) => ({ ...current, prompt: null }));
          if (value === null) reject(new Error("Login cancelled"));
          else resolve(value);
        });
        update((current) => ({ ...current, prompt: { id: promptId, request } }));
      });
    logins.set(id, { state, controller, answer: (prompt, value) => answers.get(prompt)?.(value) });
    void run(update, ask, controller.signal)
      .then(
        (message) => ({ ok: true as const, message }),
        // Provider failures can carry entered credentials; only the cancellation is named.
        () => ({
          ok: false as const,
          message: controller.signal.aborted ? "cancelled" : "failed",
        }),
      )
      .then((done) => {
        update((current) => ({ ...current, prompt: null, done }));
        // The client reads the outcome before the login goes.
        setTimeout(() => {
          logins.delete(id);
          state.end("closed");
        }, 30_000).unref();
      });
    return id;
  }

  const login = (id: number) => {
    const entry = logins.get(id);
    if (entry === undefined) throw new Error(`No login ${id} on this connection`);
    return entry;
  };

  const calls: { [M in Method]: (args: Args<M>) => Results[M] | Promise<Results[M]> } = {
    skillInput: ([name, text]) => backend.skillInput(name, text),
    findRoot: ([prefix]) => backend.findRoot(prefix),
    currentRoot: () => backend.currentRoot(),
    createRoot: ([requestId]) => backend.createRoot(requestId),
    renameRoot: ([id, label]) => backend.renameRoot(id, label),
    archiveRoot: ([id, archived]) => backend.archiveRoot(id, archived),
    submit: ([root, message, requestId, whenBusy]) =>
      backend.root(root).submit(message, requestId, whenBusy),
    messageWorker: ([root, name, message, requestId, whenBusy]) =>
      backend.root(root).messageWorker(name, message, requestId, whenBusy),
    editQueued: ([root, workerName, id, change]) =>
      backend.root(root).editQueued(workerName ?? undefined, id, change),
    abort: ([root]) => backend.root(root).abort(),
    stopWorker: ([root, name]) => backend.root(root).stopWorker(name),
    reset: ([root, handoff]) => backend.root(root).reset(handoff ?? undefined),
    compact: ([root, instructions]) => backend.root(root).compact(instructions ?? undefined),
    changeDirectory: ([root, path, workerName]) =>
      backend.root(root).changeDirectory(path, workerName ?? undefined),
    workers: async ([root]) => [...(await backend.root(root).workers())],
    handOff: ([root, workerName, toRoot]) => backend.root(root).handOff(workerName, toRoot),
    goals: async ([root]) => [...(await backend.root(root).goals())],
    seeGoal: ([root, id, updatedAt]) => backend.root(root).seeGoal(id, updatedAt),
    routing: ([root, paused]) => backend.root(root).routing(paused ?? undefined),
    modelChoice: ([root, workerName]) => backend.root(root).modelChoice(workerName ?? undefined),
    pickModel: ([root, pick, saveDefault, workerName]) =>
      backend.root(root).pickModel(pick, saveDefault, workerName ?? undefined),
    jobs: () => backend.jobs(),
    roleChoice: ([role]) => backend.roleChoice(role),
    saveDefault: ([role, pick]) => backend.saveDefault(role, pick),
    loginNeeds: async () => {
      const needs = await backend.loginNeeds();
      return { ...needs, classifier: needs.classifier ?? null };
    },
    mcpServers: () => backend.mcpServers(),
    mcpLogout: ([name]) => backend.mcpLogout(name),
    mcpReconnect: () => backend.mcpReconnect(),
    reload: async () => [...(await backend.reload())],
    logs: ([query]) => backend.logs(query),
    record: ([scope, body, attributes]) => backend.record(scope, body, attributes ?? undefined),
    restart: () => backend.requestRestart(),
    update: async ([text]) => {
      // A leaked service token must never swap the code that runs.
      if (!updates) throw new Error("Only a person's login can update Monchu, not a service token");
      await backend.update(text);
    },
    login: ([providerId, auth]) =>
      startLogin(async (update, ask, signal) => {
        await backend.login(providerId, auth, {
          signal,
          prompt: (prompt) => ask(wirePrompt(prompt), prompt.signal),
          notify: (event) => update((state) => ({ ...state, events: [...state.events, event] })),
        });
        return `logged in · ${providerId}`;
      }),
    mcpLogin: ([server]) =>
      startLogin((update, ask, signal) =>
        backend.mcpLogin(
          server,
          {
            showAuthorizationUrl: (url) =>
              update((state) => ({
                ...state,
                events: [...state.events, { type: "auth_url", url }],
              })),
            promptForRedirectUrl: (redirectSignal) =>
              ask(
                {
                  type: "text",
                  message:
                    "If the browser cannot reach this machine, paste the URL it was redirected to:",
                },
                redirectSignal,
              ).catch(() => undefined),
          },
          signal,
        ),
      ),
    loginAnswer: ([id, prompt, value]) => login(id).answer(prompt, value),
    loginCancel: ([id]) => login(id).controller.abort(),
  };

  const watches: { [T in Topic]: (key: Key<T>) => Source | Promise<Source> } = {
    hello: () => helloState.source(),
    release: () => release.source(),
    reports: () => reports.source(),
    roots: () => fed<unknown[]>([], (set) => backend.watchRoots((roots) => set([...roots]))),
    jobs: async () => {
      const state = ({ jobs, events, nextEvent }: JobsState): JobsState => ({
        jobs,
        events,
        nextEvent,
      });
      const initial = state(await backend.jobs());
      return fed(initial, (set) =>
        backend.watchJobEvents(initial.nextEvent - 1, () => {
          void backend.jobs().then((next) => set(state(next)));
        }),
      );
    },
    assessments: ([root]) =>
      fed<unknown[]>([], (set) => backend.root(root).watchAssessments((items) => set([...items]))),
    conversation: async ([root, name]) =>
      watchSource(await backend.root(root).viewWatch(name ?? undefined)),
    login: ([id]) => login(id).state.source(),
  };

  const rpc = serveRpc({ methods, topics }, { methods: calls, topics: watches }, send);
  return {
    receive: (text) => rpc.receive(text),
    dispose() {
      rpc.dispose();
      for (const cleanup of cleanups) cleanup();
      for (const entry of logins.values()) {
        entry.controller.abort();
        entry.state.end("closed");
      }
      logins.clear();
    },
  };
}
