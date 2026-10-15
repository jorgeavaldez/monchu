import type { AttachedReplicatedState } from "@earendil-works/chord";
import { initTheme } from "./theme/theme.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ProcessTerminal, setCapabilityOverrides, type Terminal } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import type { Monchu } from "../backend.ts";
import { formatOpenGoals } from "../goals.ts";
import { help, parseInput } from "./commands.ts";
import { presentation } from "./state.ts";
import { MonchuTui } from "./view.ts";

/** Terminal adapter. Input admission and all side effects remain backend-owned. */
export async function runTerminal(
  backend: Monchu,
  terminal: Terminal = new ProcessTerminal(),
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

  function show(force = false): void {
    if (closing) return;
    const state = selected === undefined ? root : workers.get(selected)?.state;
    if (state) view.apply(state.value, selected, force);
    view.setWorkers(
      [...workers.values()].map((worker) => ({
        name: worker.summary.name,
        busy: presentation(worker.state.value).busy,
      })),
    );
  }

  function fail(error: unknown): void {
    view.notice(`error · ${error instanceof Error ? error.message : String(error)}`);
  }

  let inputs = Promise.resolve();
  const interrupt = () => {
    if (login !== undefined) {
      login.abort();
      return;
    }
    inputs = inputs.then(() => handle("/abort")).catch(fail);
  };
  const view = new MonchuTui(terminal, backend.home, {
    submit: (text) => {
      inputs = inputs.then(() => handle(text)).catch(fail);
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

  async function handle(raw: string): Promise<void> {
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
        await backend.abort();
        view.notice("front stopped; workers continue");
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
        view.selectAgents(
          [
            { value: "", label: "root", description: "Monchu front" },
            // Grouped by status, working first, from the same live views as the dock's counts.
            ...[...workers.values()]
              .map(({ summary, state }) => ({ summary, busy: presentation(state.value).busy }))
              .sort((a, b) => Number(b.busy) - Number(a.busy))
              .map(({ summary, busy }) => ({
                value: summary.name,
                // Status in the label: narrow terminals hide descriptions.
                label: `${summary.name} · ${busy ? "working" : "idle"}`,
                description: summary.cwd ?? "",
              })),
          ],
          (name) => {
            inputs = inputs.then(() => switchTo(name || undefined)).catch(fail);
          },
        );
        break;
      }
      case "/goals":
        view.showPanel("Goals", formatOpenGoals(await backend.goals()));
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
        await backend.messageWorker(input.name, input.text, randomUUID());
        view.notice(`${input.name} · message committed`, "message");
        await refreshWorkers();
        break;
      case "message": {
        // Capture focus now: a later view switch must not redirect an already submitted input.
        const name = selected;
        if (name === undefined) await backend.submit(input.text, randomUUID());
        else await backend.messageWorker(name, input.text, randomUUID());
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
        view.notice(
          result.status === "failed"
            ? `effort unavailable · ${result.message}`
            : `effort · ${result.effort} ${Math.round(result.effortConfidence * 100)}% · scope ${result.scope} ${Math.round(result.scopeConfidence * 100)}%`,
        );
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
    view.notice(`Monchu · /help · home ${backend.home}`);
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
  }
  // Never wait for restart inside handle(): cleanup waits for that input promise to settle.
  if (restarting) await backend.restart();
}
