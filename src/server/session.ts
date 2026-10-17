import {
  replicatedState,
  RemoteServiceProvider,
  type Context,
  type MutableReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  Conversations,
  Logins,
  Session,
  type Hello,
  type LoginPrompt,
  type LoginState,
  type Reports,
} from "../api/services.ts";
import type { Assessment } from "../core/agents/classifier.ts";
import type { Monchu } from "../core/backend.ts";
import type { JobsState } from "../core/jobs.ts";

const context = BACKGROUND_CONTEXT;

/** A JSON copy the state takes ownership of; core values stay the core's. */
const own = <T>(value: T): T => structuredClone(value);

function hello(backend: Monchu): Hello {
  return own({
    home: backend.home,
    settings: backend.settings,
    skills: [...backend.skills()],
    models: [...backend.catalog()],
    notes: [...backend.notes],
  });
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

/**
 * The services one connection sees. Conversations it opens and logins it starts are spawned in its own provider, so
 * another client never sees its login prompts. `dispose` releases every attachment and cancels its logins.
 */
export async function connectionServices(
  backend: Monchu,
): Promise<{ provider: RemoteServiceProvider; dispose(): void }> {
  const provider = new RemoteServiceProvider([
    { service: Session, mode: "singleton" },
    { service: Conversations, mode: "keyed" },
    { service: Logins, mode: "keyed" },
  ]);
  const cleanups: (() => void)[] = [];
  const helloState = replicatedState(hello(backend));
  cleanups.push(backend.onReload(() => helloState.replace(context, hello(backend))));
  const reports = replicatedState<Reports>({ recent: [] });
  let nextReport = 1;
  cleanups.push(
    backend.onReport((message) =>
      reports.replace(context, {
        recent: [...reports.value.recent, { id: nextReport++, message }].slice(-20),
      }),
    ),
  );
  const assessments = replicatedState<{ items: Assessment[] }>({ items: [] });
  cleanups.push(
    await backend.watchAssessments((items) =>
      assessments.replace(context, own({ items: [...items] })),
    ),
  );
  const initialJobs = await backend.jobs();
  const jobs = replicatedState<JobsState>(
    own({ jobs: initialJobs.jobs, events: initialJobs.events, nextEvent: initialJobs.nextEvent }),
  );
  cleanups.push(
    await backend.watchJobEvents(initialJobs.nextEvent - 1, () => {
      void backend
        .jobs()
        .then((state) =>
          jobs.replace(
            context,
            own({ jobs: state.jobs, events: state.events, nextEvent: state.nextEvent }),
          ),
        );
    }),
  );

  const opened = new Map<string, { count: number; close(): void }>();
  const logins = new Map<number, AbortController>();
  let nextLogin = 1;

  /** Run one login for this connection: its prompts and events reach only this connection's `login` instance. */
  function startLogin(
    run: (
      state: MutableReplicatedState<LoginState>,
      ask: (request: LoginPrompt, signal?: AbortSignal) => Promise<string>,
      signal: AbortSignal,
    ) => Promise<string>,
  ): number {
    const id = nextLogin++;
    const controller = new AbortController();
    logins.set(id, controller);
    const state = replicatedState<LoginState>({ id, prompt: null, events: [], done: null });
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
          state.change(context, (draft) => {
            draft.prompt = null;
          });
          if (value === null) reject(new Error("Login cancelled"));
          else resolve(value);
        });
        state.change(context, (draft) => {
          draft.prompt = { id: promptId, request };
        });
      });
    const close = provider.spawn(Logins, String(id), {
      state,
      answer: async (prompt: number, value: string | null, _context: Context) => {
        answers.get(prompt)?.(value);
      },
      cancel: async (_context: Context) => controller.abort(),
    });
    void run(state, ask, controller.signal)
      .then(
        (message) => ({ ok: true as const, message }),
        // Provider failures can carry entered credentials; only the cancellation is named.
        () => ({
          ok: false as const,
          message: controller.signal.aborted ? "cancelled" : "failed",
        }),
      )
      .then((done) => {
        state.change(context, (draft) => {
          draft.prompt = null;
          draft.done = done;
        });
        logins.delete(id);
        // The client reads the outcome before the instance goes.
        setTimeout(close, 30_000).unref();
      });
    return id;
  }

  provider.provide(Session, {
    hello: helloState,
    assessments,
    jobs,
    reports,
    open: async (name: string, _context: Context) => {
      const existing = opened.get(name);
      if (existing !== undefined) {
        existing.count += 1;
        return;
      }
      const view = await backend.viewState(name === "" ? undefined : name);
      // Instance keys must not be empty, and a worker can't be mistaken for the root.
      const close = provider.spawn(Conversations, name === "" ? "root" : `worker:${name}`, {
        about: replicatedState({ name }),
        view,
      });
      opened.set(name, {
        count: 1,
        close: () => {
          close();
          view.dispose();
        },
      });
    },
    close: async (name: string, _context: Context) => {
      const existing = opened.get(name);
      if (existing === undefined) return;
      existing.count -= 1;
      if (existing.count > 0) return;
      opened.delete(name);
      existing.close();
    },
    skillInput: async (name: string, text: string) => backend.skillInput(name, text),
    submit: (message, requestId, whenBusy) => backend.submit(message, requestId, whenBusy),
    messageWorker: (name, message, requestId, whenBusy) =>
      backend.messageWorker(name, message, requestId, whenBusy),
    editQueued: (workerName, id, change) => backend.editQueued(workerName ?? undefined, id, change),
    abort: () => backend.abort(),
    stopWorker: (name) => backend.stopWorker(name),
    reset: (handoff) => backend.reset(handoff ?? undefined),
    compact: (instructions) => backend.compact(instructions ?? undefined),
    changeDirectory: (path, workerName) => backend.changeDirectory(path, workerName ?? undefined),
    workers: async () => own([...(await backend.workers())]),
    goals: async () => own([...(await backend.goals())]),
    seeGoal: (id, updatedAt) => backend.seeGoal(id, updatedAt),
    jobsListing: async () => (await backend.jobs()).listing,
    modelChoice: async (workerName) => own(await backend.modelChoice(workerName ?? undefined)),
    roleChoice: async (role) => own(await backend.roleChoice(role)),
    pickModel: (pick, saveDefault, workerName) =>
      backend.pickModel(pick, saveDefault, workerName ?? undefined),
    saveDefault: (role, pick) => backend.saveDefault(role, pick),
    loginNeeds: async () => {
      const needs = await backend.loginNeeds();
      return { ...needs, classifier: needs.classifier ?? null };
    },
    mcpServers: async () => own(await backend.mcpServers()),
    mcpLogout: (name) => backend.mcpLogout(name),
    mcpReconnect: async () => own(await backend.mcpReconnect()),
    reload: async () => [...(await backend.reload())],
    logs: (query) => backend.logs(query),
    record: async (scope, body, attributes) => backend.record(scope, body, attributes ?? undefined),
    restart: async () => backend.requestRestart(),
    login: async (providerId: string, auth: "oauth" | "api_key") =>
      startLogin(async (state, ask, signal) => {
        await backend.login(providerId, auth, {
          signal,
          prompt: (prompt) => ask(wirePrompt(prompt), prompt.signal),
          notify: (event) =>
            state.replace(context, own({ ...state.value, events: [...state.value.events, event] })),
        });
        return `logged in · ${providerId}`;
      }),
    mcpLogin: async (server: string) =>
      startLogin((state, ask, signal) =>
        backend.mcpLogin(
          server,
          {
            showAuthorizationUrl: (url) =>
              state.replace(
                context,
                own({ ...state.value, events: [...state.value.events, { type: "auth_url", url }] }),
              ),
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
  });

  return {
    provider,
    dispose() {
      for (const cleanup of cleanups) cleanup();
      for (const controller of logins.values()) controller.abort();
      for (const entry of opened.values()) entry.close();
      opened.clear();
      provider.dispose();
    },
  };
}
