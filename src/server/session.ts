/**
 * The core's half of the wire, as a Chord facet: the factories of the contracts in `src/api/contract.ts`. Objects are
 * per connection (`principalKey`), so the views a client opens and the logins it starts are its own. The backend comes
 * from the host's `Core` object; values it keeps current reach cells through listeners, so they survive a reload.
 */
import {
  copyJson,
  defineFacet,
  local,
  opaque,
  type Cell,
  type ImplementationOf,
  type Self,
} from "@earendil-works/chord";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { ConversationView, WatchHandle } from "@earendil-works/pi-durable";
import type { RootSummary } from "../api/client.ts";
import type { Assessment } from "../core/agents/classifier.ts";
import { Type, type TUnsafe } from "typebox";
import { Check } from "typebox/value";
import {
  Conversation,
  Root,
  Session,
  type Hello,
  type LoginPrompt,
  type LoginState,
  type Principal,
  type Reports,
} from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";
import type { JobsState } from "../core/jobs.ts";

/** The running backend, for the facets: the host that serves it owns and closes it. */
export const Core = local("monchu.core", {
  version: 1,
  input: Type.Object({}),
  members: { monchu: opaque<Monchu>("monchu.core@1") },
});

/** A value of the core's, typed and not checked. */
const any = <T>(): TUnsafe<T> => Type.Unsafe<T>(Type.Unknown());

/** A JSON copy cells own: core values stay the core's, and undefined properties drop as in JSON. */
function json<T>(value: T): T {
  const copy = copyJson(value, { omitUndefinedProperties: true });
  // The core's own values: the check only types the copy.
  if (!Check(any<T>(), copy)) throw new Error("Not a JSON value");
  return copy;
}

/**
 * A value kept outside Chord (a backend subscription, logins in progress) as an event source: a listener hears the
 * current value at once, then each new one.
 */
class Latest<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private current: T;
  stop: () => void = () => {};
  constructor(value: T) {
    this.current = value;
  }
  get value(): T {
    return this.current;
  }
  set(value: T): void {
    this.current = value;
    for (const listener of this.listeners) listener(value);
  }
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
}

/**
 * A cell fed by a backend subscription: `follow` gets a setter and returns its stop function. The subscription is a
 * resource and the cell's listener is kept, so a reload doesn't subscribe again.
 */
function fed<T>(
  self: Self<Principal>,
  name: string,
  initial: () => Promise<T>,
  follow: (set: (value: T) => void, first: T) => Promise<() => void> | (() => void),
): Cell<T> {
  const source = self.resource(name, {
    version: 1,
    open: () =>
      initial().then(async (first) => {
        const latest = new Latest(json(first));
        latest.stop = await follow((value) => latest.set(json(value)), latest.value);
        return latest;
      }),
    close: (latest) => latest.stop(),
  });
  const cell = self.state(name, any<T>(), { init: () => source.value.value });
  self.on(name, source, (value, ctx) => cell.replace(ctx, value, { diff: true }));
  return cell;
}

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

type LoginRun = (
  update: (change: (state: LoginState) => LoginState) => void,
  ask: (request: LoginPrompt, signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
) => Promise<string>;

/** One connection's logins: their prompts and events reach only its `logins` state. */
class Logins extends Latest<Record<string, LoginState>> {
  private readonly runs = new Map<
    number,
    { controller: AbortController; answer(prompt: number, value: string | null): void }
  >();
  private next = 1;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    super({});
  }

  private update(id: number, change: (state: LoginState) => LoginState): void {
    const state = this.value[String(id)];
    if (state !== undefined) this.set({ ...this.value, [String(id)]: json(change(state)) });
  }

  start(run: LoginRun): number {
    const id = this.next++;
    const controller = new AbortController();
    this.set({ ...this.value, [String(id)]: { id, prompt: null, events: [], done: null } });
    const update = (change: (state: LoginState) => LoginState) => this.update(id, change);
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
    this.runs.set(id, { controller, answer: (prompt, value) => answers.get(prompt)?.(value) });
    void run(update, ask, controller.signal)
      .then(
        (message) => ({ ok: true as const, message }),
        // Provider failures can carry entered credentials; only the cancellation is named.
        () => ({ ok: false as const, message: controller.signal.aborted ? "cancelled" : "failed" }),
      )
      .then((done) => {
        update((current) => ({ ...current, prompt: null, done }));
        // The client reads the outcome before the login goes.
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.runs.delete(id);
          const { [String(id)]: _gone, ...rest } = this.value;
          this.set(rest);
        }, 30_000);
        timer.unref();
        this.timers.add(timer);
      });
    return id;
  }

  private run(id: number) {
    const entry = this.runs.get(id);
    if (entry === undefined) throw new Error(`No login ${id} on this connection`);
    return entry;
  }

  answer(id: number, prompt: number, value: string | null): void {
    this.run(id).answer(prompt, value);
  }

  cancel(id: number): void {
    this.run(id).controller.abort();
  }

  close(): void {
    for (const entry of this.runs.values()) entry.controller.abort();
    this.runs.clear();
    for (const timer of this.timers) clearTimeout(timer);
  }
}

/** The backend, once the object is live. */
function backendOf(core: { monchu: Monchu | undefined }): Monchu {
  const backend = core.monchu;
  if (backend === undefined) throw new Error("Monchu's core is not open");
  return backend;
}

/** A Durable watch as the event source of its frames' values. */
const frames = <T>(handle: WatchHandle<T>) => ({
  subscribe(listener: (value: T) => void): () => void {
    handle.start(async (value) => {
      listener(value);
    });
    return () => {};
  },
});

export default defineFacet<Principal>(
  (api) => {
    api.serve(Session, (_input, principal, self) => {
      const core = self.get(Core, {});
      const monchu = () => backendOf(core);
      const helloState = fed(
        self,
        "hello",
        async () => hello(monchu()),
        (set) => monchu().onReload(() => set(hello(monchu()))),
      );
      const releaseState = fed(
        self,
        "releaseState",
        async () => monchu().release,
        (set) => monchu().onRelease(set),
      );
      const reports = fed<Reports>(
        self,
        "reports",
        async () => ({ recent: [] }),
        (set, first) => {
          let current = first;
          let next = 1;
          return monchu().onReport((message) => {
            current = { recent: [...current.recent, { id: next++, message }].slice(-20) };
            set(current);
          });
        },
      );
      const roots = fed<RootSummary[]>(
        self,
        "roots",
        async () => [],
        (set) => monchu().watchRoots((items) => set([...items])),
      );
      const jobState = ({ jobs, events, nextEvent }: JobsState): JobsState => ({
        jobs,
        events,
        nextEvent,
      });
      const jobsState = fed(
        self,
        "jobsState",
        async () => jobState(await monchu().jobs()),
        (set, first) =>
          monchu().watchJobEvents(first.nextEvent - 1, () => {
            void monchu()
              .jobs()
              .then((next) => set(jobState(next)));
          }),
      );
      const runs = self.resource("logins", {
        version: 1,
        open: () => new Logins(),
        close: (logins) => logins.close(),
      });
      const logins = self.state("logins", any<Record<string, LoginState>>(), {});
      self.on("logins", runs, (value, ctx) => logins.replace(ctx, value, { diff: true }));

      const start = (run: LoginRun) => runs.value.start(run);
      const owner: Extract<ImplementationOf<typeof Session, Principal>, { variant: "owner" }> = {
        variant: "owner",
        hello: helloState,
        releaseState,
        reports,
        roots,
        jobsState,
        logins,
        skillInput: ({ name, text }) => monchu().skillInput(name, text),
        findRoot: ({ prefix }) => monchu().findRoot(prefix),
        currentRoot: () => monchu().currentRoot(),
        createRoot: ({ requestId }) => monchu().createRoot(requestId),
        renameRoot: ({ root, label }) => monchu().renameRoot(root, label),
        archiveRoot: ({ root, archived }) => monchu().archiveRoot(root, archived),
        jobs: () => monchu().jobs(),
        roleChoice: ({ role }) => monchu().roleChoice(role),
        saveDefault: ({ role, pick }) => monchu().saveDefault(role, pick),
        loginNeeds: async () => {
          const needs = await monchu().loginNeeds();
          return { ...needs, classifier: needs.classifier ?? null };
        },
        mcpServers: () => monchu().mcpServers(),
        mcpLogout: ({ name }) => monchu().mcpLogout(name),
        mcpReconnect: () => monchu().mcpReconnect(),
        reload: async () => [...(await monchu().reload())],
        logs: ({ query }) => monchu().logs(query),
        record: ({ scope, body, attributes }) => monchu().record(scope, body, attributes),
        restart: () => monchu().requestRestart(),
        update: async ({ release }) => {
          // A leaked service token must never swap the code that runs: its variant has no `update` either.
          if (principal.kind === "client" && !principal.person)
            throw new Error("Only a person's login can update Monchu, not a service token");
          await monchu().update(release);
        },
        login: ({ provider, auth }) =>
          start(async (update, ask, signal) => {
            await monchu().login(provider, auth, {
              signal,
              prompt: (prompt) => ask(wirePrompt(prompt), prompt.signal),
              notify: (event) =>
                update((state) => ({ ...state, events: [...state.events, event] })),
            });
            return `logged in · ${provider}`;
          }),
        mcpLogin: ({ server }) =>
          start((update, ask, signal) =>
            monchu().mcpLogin(
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
        loginAnswer: ({ login, prompt, value }) => runs.value.answer(login, prompt, value),
        loginCancel: ({ login }) => runs.value.cancel(login),
      };
      if (principal.kind !== "client" || principal.person) return owner;
      const { update: _update, variant: _variant, ...service } = owner;
      return { ...service, variant: "service" };
    });

    api.serve(Root, ({ root }, _principal, self) => {
      const core = self.get(Core, {});
      const front = () => backendOf(core).root(root);
      const assessments = fed<Assessment[]>(
        self,
        "assessments",
        async () => [],
        (set) => front().watchAssessments((items) => set([...items])),
      );
      return {
        variant: "owner",
        assessments,
        submit: ({ message, requestId, whenBusy, attachments }) =>
          front().submit(message, requestId, whenBusy, attachments),
        messageWorker: ({ worker, message, requestId, whenBusy, attachments }) =>
          front().messageWorker(worker, message, requestId, whenBusy, attachments),
        upload: (chunk) => front().upload(chunk),
        editQueued: ({ worker, id, change }) => front().editQueued(worker, id, change),
        abort: () => front().abort(),
        stopWorker: ({ worker }) => front().stopWorker(worker),
        reset: ({ handoff }) => front().reset(handoff),
        compact: ({ instructions }) => front().compact(instructions),
        changeDirectory: ({ path, worker }) => front().changeDirectory(path, worker),
        workers: async () => [...(await front().workers())],
        handOff: ({ worker, toRoot }) => front().handOff(worker, toRoot),
        goals: async () => [...(await front().goals())],
        seeGoal: ({ id, updatedAt }) => front().seeGoal(id, updatedAt),
        routing: ({ paused }) => front().routing(paused),
        modelChoice: ({ worker }) => front().modelChoice(worker),
        pickModel: ({ pick, saveDefault, worker }) => front().pickModel(pick, saveDefault, worker),
      };
    });

    api.serve(Conversation, ({ root, worker }, _principal, self) => {
      const core = self.get(Core, {});
      const watch = self.resource("watch", {
        version: 1,
        open: () => backendOf(core).root(root).viewWatch(worker),
        close: async (handle) => {
          await handle.stop();
        },
      });
      const view = self.state("view", any<ConversationView>(), {
        init: () => watch.value.value,
      });
      self.on(
        "view",
        watch,
        (handle) => frames(handle),
        (value, ctx) => view.replace(ctx, value),
      );
      return { variant: "owner", view };
    });
  },
  { uses: [Core] },
);
