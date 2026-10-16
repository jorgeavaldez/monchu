import type { AttachedReplicatedState } from "@earendil-works/chord";
import { initTheme } from "./theme/theme.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ProcessTerminal, setCapabilityOverrides, type Terminal } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import type { ModelPick, Monchu } from "../backend.ts";
import { describe as describeAssessment } from "../classifier.ts";
import type { HerdrAgent } from "../herdr-agent.ts";
import type { WhenBusy } from "../workers.ts";
import { help, parseInput } from "./commands.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import type { AgentRow, AgentStatus } from "./components/agents-panel.ts";
import type { Meter } from "./components/footer.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { contextUsage, lastActive, presentation } from "./state.ts";
import { MonchuTui } from "./view.ts";

/** What /model and /thinking change: a conversation, the root when unnamed, or a role default. */
type PickTarget =
  | { kind: "conversation"; name: string | undefined }
  | { kind: "default"; role: "front" | "worker" };

/**
 * Terminal adapter. Input admission and all side effects remain backend-owned. Inside Herdr, `herdr` reports what
 * Monchu is doing in its pane: working while the root or any worker runs.
 */
export async function runTerminal(
  backend: Monchu,
  terminal: Terminal = new ProcessTerminal(),
  herdr?: HerdrAgent,
): Promise<void> {
  if (terminal instanceof ProcessTerminal && (!stdin.isTTY || !stdout.isTTY))
    throw new Error("Monchu's TUI needs an interactive terminal.");
  let scheme: "light" | "dark" = ["7", "9", "10", "11", "12", "13", "14", "15"].includes(
    process.env.COLORFGBG?.split(";").at(-1) ?? "",
  )
    ? "light"
    : "dark";
  function applyTheme(): void {
    const configuredTheme = backend.settings.theme;
    setCapabilityOverrides(backend.settings.terminalCapabilities);
    const pair = configuredTheme?.split("/");
    const name = pair?.length === 2 ? pair[scheme === "light" ? 0 : 1]?.trim() : configuredTheme;
    initTheme(name && name !== "system" ? name : scheme);
  }
  applyTheme();
  let exit = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  let closing = false;
  let restarting = false;
  let selected: string | undefined;
  let root: AttachedReplicatedState<ConversationView> | undefined;
  let stopRoot: (() => void) | undefined;
  let stopReports: (() => void) | undefined;
  let stopAssessments: (() => void) | undefined;
  let stopScheme: (() => void) | undefined;
  let stopReload: (() => void) | undefined;
  let login: AbortController | undefined;
  type Worker = Awaited<ReturnType<Monchu["workers"]>>[number];
  const describe = (worker: Worker) => `${worker.busy ? "working" : "idle"} | ${worker.cwd}`;
  const workers = new Map<
    string,
    { summary: Worker; state: AttachedReplicatedState<ConversationView>; stop(): void }
  >();
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let lastRootEntry: number | undefined;
  // Each worker's status as last shown, for linked workers in the goals panel.
  let statuses: ReadonlyMap<string, AgentStatus> = new Map();

  // Herdr alone shows `done`: it turns working then idle into done until its pane is seen.
  function status(busy: boolean): AgentStatus {
    return busy ? "working" : "idle";
  }

  function meter(value: ConversationView): Meter {
    const state = presentation(value);
    const model =
      state.provider === undefined
        ? undefined
        : backend.model({ provider: state.provider, modelId: state.model });
    return { usage: contextUsage(value), window: model?.contextWindow };
  }

  function agentRows(): AgentRow[] {
    const rootRow: AgentRow[] =
      root === undefined
        ? []
        : [
            {
              value: "",
              name: "root",
              status: status(presentation(root.value).busy),
              meter: meter(root.value),
              cwd: presentation(root.value).cwd,
              active: lastActive(root.value),
            },
          ];
    return [
      ...rootRow,
      ...[...workers.values()].map(({ summary, state }) => ({
        value: summary.name,
        name: summary.name,
        status: status(presentation(state.value).busy),
        meter: meter(state.value),
        cwd: presentation(state.value).cwd ?? summary.cwd,
        active: lastActive(state.value),
      })),
    ];
  }

  function show(force = false): void {
    if (closing) return;
    const state = selected === undefined ? root : workers.get(selected)?.state;
    if (state) view.apply(state.value, selected, force);
    const rows = agentRows();
    statuses = new Map(rows.filter((row) => row.value !== "").map((row) => [row.name, row.status]));
    view.setWorkers(rows.filter((row) => row.value !== ""));
    view.updateAgents(rows);
    if (state) {
      const shown = presentation(state.value);
      const model =
        shown.provider === undefined
          ? undefined
          : backend.model({ provider: shown.provider, modelId: shown.model });
      view.setFooter({
        shown: meter(state.value),
        root: root === undefined ? undefined : meter(root.value),
        thinking: model?.reasoning ? (shown.thinkingLevel ?? "off") : undefined,
        autoCompact: backend.settings.compaction.enabled,
      });
    }
    herdr?.report(
      login !== undefined
        ? "blocked"
        : rows.some((row) => row.status === "working")
          ? "working"
          : "idle",
      login !== undefined ? "login" : undefined,
    );
  }

  function fail(error: unknown): void {
    view.notice(`error · ${error instanceof Error ? error.message : String(error)}`);
  }

  let inputs = Promise.resolve();
  async function abort(): Promise<void> {
    view.restoreQueued(await backend.abort());
    view.notice("front stopped; workers continue");
  }
  const interrupt = () => {
    if (login !== undefined) {
      login.abort();
      return;
    }
    inputs = inputs.then(abort).catch(fail);
  };
  const view = new MonchuTui(terminal, backend.home, {
    submit: (text, whenBusy) => {
      inputs = inputs.then(() => handle(text, whenBusy)).catch(fail);
    },
    editQueued: (id, change) => {
      // The queue shown now: a later view switch must not redirect the edit.
      const name = selected;
      inputs = inputs
        .then(async () => {
          if (await backend.editQueued(name, id, change)) return;
          view.notice("that message already left the queue");
          // An edit that came too late stays in the editor, to send as a new message.
          if (change.kind === "text") view.restoreQueued([change.text]);
        })
        .catch(fail);
    },
    // As in Pi, Esc interrupts only a front that shows activity (a run, retry, or compaction).
    abort: () => {
      if (root !== undefined && presentation(root.value).status) interrupt();
    },
    exit,
  });

  // Coalesce discovery, and never query the worker registry on every streaming revision.
  async function refreshWorkers(): Promise<void> {
    if (closing) return;
    refreshAgain = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (refreshAgain && !closing) {
        refreshAgain = false;
        const summaries = await backend.workers();
        if (closing) return;
        // A closed worker leaves the active list: drop its view, and return a selected view to the root.
        const active = new Set(summaries.map((summary) => summary.name));
        for (const [name, worker] of workers) {
          if (active.has(name)) continue;
          worker.stop();
          worker.state.dispose();
          workers.delete(name);
          if (selected === name) {
            selected = undefined;
            view.notice(`worker ${name} closed · back to root`);
          }
        }
        for (const summary of summaries) {
          if (closing) return;
          const existing = workers.get(summary.name);
          if (existing) {
            existing.summary = summary;
            continue;
          }
          const state = await backend.viewState(summary.name);
          if (closing) {
            state.dispose();
            return;
          }
          let busy = presentation(state.value).busy;
          const stop = state.subscribe((value) => {
            try {
              const next = presentation(value).busy;
              if (next !== busy) {
                busy = next;
                void refreshWorkers().catch(fail);
              }
              show();
            } catch (error) {
              fail(error);
              process.exitCode = 1;
              exit();
            }
          });
          workers.set(summary.name, { summary, state, stop });
        }
        show();
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function switchTo(name: string | undefined): Promise<void> {
    await refreshWorkers();
    if (name !== undefined && !workers.has(name)) throw new Error(`No worker named ${name}`);
    selected = name;
    show();
  }

  /** The model or thinking selector for one conversation or role default; Enter applies, Ctrl+S also saves. */
  async function pickFor(
    command: "/model" | "/thinking",
    target: PickTarget,
    search: string | undefined,
  ): Promise<void> {
    const name = target.kind === "default" ? `${target.role} default` : (target.name ?? "root");
    const choice =
      target.kind === "default"
        ? await backend.roleChoice(target.role)
        : await backend.modelChoice(target.name);
    const pick = (change: ModelPick, save: boolean) => {
      view.closeSelector();
      inputs = inputs
        .then(async () => {
          const value =
            "model" in change
              ? `model · ${change.model.provider}/${change.model.modelId}`
              : `thinking · ${change.thinkingLevel}`;
          if (target.kind === "default") {
            await backend.saveDefault(target.role, change);
            view.notice(`${name} ${value} · saved`);
          } else {
            await backend.pickModel(change, save, target.name);
            const role = target.name === undefined ? "front" : "worker";
            view.notice(
              `${name} ${value} · ${save ? `saved as ${role} default` : "this conversation only"}`,
            );
          }
        })
        .catch(fail);
    };
    // A role default saves on Enter, so it has no separate Ctrl+S.
    const conversation = target.kind === "conversation";
    view.showSelector(
      command === "/model"
        ? new ModelSelectorComponent(
            choice.model,
            choice.models,
            (model) => pick({ model: { provider: model.provider, modelId: model.id } }, false),
            () => view.closeSelector(),
            search,
            conversation
              ? (model) => pick({ model: { provider: model.provider, modelId: model.id } }, true)
              : undefined,
            { provider: choice.defaults.provider, id: choice.defaults.modelId },
          )
        : new ThinkingSelectorComponent(
            choice.thinkingLevel,
            choice.thinkingLevels,
            (thinkingLevel) => pick({ thinkingLevel }, false),
            () => view.closeSelector(),
            conversation ? (thinkingLevel) => pick({ thinkingLevel }, true) : undefined,
            choice.defaults.thinkingLevel,
          ),
    );
  }

  async function handle(raw: string, whenBusy: WhenBusy): Promise<void> {
    if (closing) return;
    const input = parseInput(raw);
    if (!input) return;
    switch (input.command) {
      case "/quit":
        exit();
        break;
      case "/help":
        view.notice(help);
        break;
      case "/login": {
        const controller = new AbortController();
        login = controller;
        show();
        view.beginLogin(() => controller.abort());
        try {
          const provider = await view.promptLogin(
            {
              type: "select",
              message: "Choose provider:",
              options: [
                { id: "openai-codex", label: "OpenAI Codex (device code)" },
                { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI (API key)" },
                { id: "claude-code", label: "Claude Code (setup-token)" },
              ],
            },
            controller.signal,
          );
          await backend.login(
            provider,
            provider === "cloudflare-workers-ai" ? "api_key" : "oauth",
            {
              signal: controller.signal,
              prompt: (prompt) => view.promptLogin(prompt, controller.signal),
              notify: (event) => {
                switch (event.type) {
                  case "device_code":
                    view.loginMessage(
                      `Open ${event.verificationUri}\nCode: ${event.userCode}\nWaiting for approval · Esc to cancel`,
                    );
                    break;
                  case "auth_url":
                    view.loginMessage(`Open ${event.url}`);
                    break;
                  case "info":
                  case "progress":
                    // Keep provider output ephemeral, outside chat/history/logs.
                    view.loginMessage(event.message);
                    break;
                }
              },
            },
          );
          view.notice(`logged in · ${provider}`);
        } catch {
          // Provider failures can include entered credentials. Never echo raw login errors.
          view.notice(
            controller.signal.aborted
              ? "login cancelled"
              : "login failed; credentials may have been saved; retry /login",
          );
        } finally {
          login = undefined;
          view.endLogin();
          show();
        }
        break;
      }
      case "/reload": {
        view.notice(`reloaded · ${(await backend.reload()).join(", ")}`);
        break;
      }
      case "/restart":
        // Only editor input reaches this handler; model output never authorizes a restart.
        restarting = true;
        closing = true;
        exit();
        break;
      case "/abort":
        await abort();
        break;
      case "/workers": {
        await refreshWorkers();
        view.notice(
          workers.size
            ? [...workers.values()]
                .map(({ summary }) => `${summary.name}: ${describe(summary)}`)
                .join("\n")
            : "No workers yet.",
        );
        break;
      }
      case "/agents": {
        if (input.text) {
          await switchTo(input.text === "root" ? undefined : input.text);
          break;
        }
        await refreshWorkers();
        view.openAgents(agentRows(), selected ?? "", (name) => {
          inputs = inputs.then(() => switchTo(name || undefined)).catch(fail);
        });
        break;
      }
      case "/goals":
        view.openGoals(
          await backend.goals(),
          () => statuses,
          (goal) => {
            inputs = inputs.then(() => backend.seeGoal(goal.id, goal.updatedAt)).catch(fail);
          },
        );
        break;
      case "/model":
      case "/thinking": {
        // First what to change, the shown conversation first, then the model or thinking level for it.
        await refreshWorkers();
        const targets = new Map<string, PickTarget>([
          [selected === undefined ? "root" : selected, { kind: "conversation", name: selected }],
          ...[undefined, ...workers.keys()]
            .filter((name) => name !== selected)
            .map((name): [string, PickTarget] => [name ?? "root", { kind: "conversation", name }]),
          ["front default", { kind: "default", role: "front" }],
          ["worker default", { kind: "default", role: "worker" }],
        ]);
        const command = input.command;
        const search = "text" in input ? input.text || undefined : undefined;
        view.choose(
          command === "/model" ? "Pick the model of" : "Pick the thinking level of",
          [...targets].map(([label, target]) => ({
            value: label,
            label,
            description:
              target.kind === "default"
                ? target.role === "front"
                  ? "saved; the root follows it unless picked for the root"
                  : "saved; new workers start with it"
                : "this conversation; Ctrl+S also saves its role default",
          })),
          (label) => {
            const target = targets.get(label);
            if (target !== undefined)
              inputs = inputs.then(() => pickFor(command, target, search)).catch(fail);
          },
        );
        break;
      }
      case "/queue":
        view.openQueue();
        break;
      case "/stop":
        await backend.stopWorker(input.text);
        view.notice(`stopped worker · ${input.text}`);
        await refreshWorkers();
        break;
      case "/new":
        await backend.reset(input.text);
        view.notice(input.text ? "new context · handoff carried" : "new context");
        break;
      case "/compact":
        await backend.compact(input.text);
        view.notice("compaction started");
        break;
      case "/cd":
        view.notice(`directory · ${await backend.changeDirectory(input.text)}`);
        break;
      case "/cd-worker":
        view.notice(
          `${input.name} directory · ${await backend.changeDirectory(input.text, input.name)}`,
        );
        await refreshWorkers();
        break;
      case "/work":
        await backend.startWorker(input.name, input.text, randomUUID());
        view.notice(`${input.name} · creation committed`, "start");
        await refreshWorkers();
        break;
      case "/tell":
        await backend.messageWorker(input.name, input.text, randomUUID(), whenBusy);
        view.notice(`${input.name} · message committed`, "message");
        await refreshWorkers();
        break;
      case "message": {
        // Capture focus now: a later view switch must not redirect an already submitted input.
        const name = selected;
        if (name === undefined) await backend.submit(input.text, randomUUID(), whenBusy);
        else await backend.messageWorker(name, input.text, randomUUID(), whenBusy);
        if (name === undefined) view.notice("received · root");
        else view.notice(`${name} · received`, "message");
        if (name !== undefined) await refreshWorkers();
        break;
      }
    }
  }

  process.on("SIGTERM", exit);
  process.on("SIGINT", interrupt);
  try {
    root = await backend.viewState();
    stopRoot = root.subscribe((value) => {
      try {
        const newest = value.entries.at(-1)?.id;
        if (newest !== lastRootEntry) {
          lastRootEntry = newest;
          void refreshWorkers().catch(fail);
        }
        show();
      } catch (error) {
        fail(error);
        process.exitCode = 1;
        exit();
      }
    });
    stopReload = backend.onReload(() => {
      applyTheme();
      show(true);
    });
    stopReports = backend.onReport((message) => view.notice(`warning · ${message}`));
    const shown = new Set<number>();
    let hydrated = false;
    stopAssessments = await backend.watchAssessments((items) => {
      for (const item of items) {
        if (item.result === null || shown.has(item.taskId)) continue;
        shown.add(item.taskId);
        if (!hydrated) continue;
        const result = item.result;
        view.notice(`clef · ${describeAssessment(result)}`);
      }
      hydrated = true;
    });
    await refreshWorkers();
    view.start();
    stopScheme = view.ui.onTerminalColorSchemeChange((next) => {
      scheme = next;
      applyTheme();
      show(true);
    });
    view.ui.setTerminalColorSchemeNotifications(true);
    const colors = await view.ui.queryTerminalColors({ timeoutMs: 500 });
    if (colors.background) {
      const bg = colors.background;
      scheme = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 128 ? "light" : "dark";
      applyTheme();
    }
    show(true);
    view.intro(backend.home);
    await exited;
  } finally {
    closing = true;
    process.off("SIGTERM", exit);
    process.off("SIGINT", interrupt);
    // Let an in-flight admission settle before main closes storage. Queued inputs see closing and stop.
    login?.abort();
    await inputs;
    stopReload?.();
    stopScheme?.();
    stopReports?.();
    stopAssessments?.();
    stopRoot?.();
    await refreshing?.catch(() => {});
    for (const worker of workers.values()) {
      worker.stop();
      worker.state.dispose();
    }
    root?.dispose();
    view.stop();
    await herdr?.release();
  }
  // Never wait for restart inside handle(): cleanup waits for that input promise to settle.
  if (restarting) await backend.restart();
}
