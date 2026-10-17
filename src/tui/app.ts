import { initTheme } from "./theme/theme.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ProcessTerminal, setCapabilityOverrides, type Terminal } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import type { Client, ModelPick, RootClient, RootSummary } from "../api/client.ts";
import type { Watched } from "../api/rpc.ts";
import type { WhenBusy } from "../api/notices.ts";
import { assessmentNotice, formatReports, routingText } from "../api/reports.ts";
import type { HerdrAgent } from "./herdr-agent.ts";
import { releaseNotices } from "../api/release.ts";
import { commands, help, LOGIN_PROVIDERS, parseInput } from "../ui/commands.ts";
import { formatJobEvent, jobEventRoot } from "../ui/jobs.ts";
import { activeRoots, parseRootsCommand, rootIds, rootLabel } from "../ui/roots.ts";
import { formatRecord, logQuery } from "../ui/logs.ts";
import { LOGIN_FAILED, loginHints, pickTargets, type PickTarget } from "../ui/login.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import type { AgentRow, AgentStatus } from "./components/agents-panel.ts";
import type { Meter } from "./components/footer.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { contextUsage, lastActive, presentation } from "../ui/state.ts";
import { browserHere } from "./system.ts";
import { MonchuTui } from "./view.ts";

/** What /model and /thinking change: a conversation, the root when unnamed, or a role default. */

/**
 * Terminal client of the core contract. Input admission and all side effects remain core-owned; resolves with whether
 * the user asked for a restart, after the core closed for it. Inside Herdr, `herdr` reports what
 * Monchu is doing in its pane: working while the root or any worker runs.
 */
export async function runTerminal(
  backend: Client,
  /** The root this terminal opens, by full id; `/roots` switches it. */
  rootId: string,
  terminal: Terminal = new ProcessTerminal(),
  herdr?: HerdrAgent,
  /** Notes of this terminal only, shown below the header after the core's own. */
  notes: readonly string[] = [],
): Promise<"quit" | "restart"> {
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
  let front = backend.root(rootId);
  let roots: readonly RootSummary[] = [];
  // Each switch of root starts a generation; work for an earlier root stops when it sees a newer one.
  let generation = 0;
  let exit = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  let closing = false;
  let restarting = false;
  let selected: string | undefined;
  let root: Watched<ConversationView> | undefined;
  let stopRoot: (() => void) | undefined;
  let stopReports: (() => void) | undefined;
  let stopRoots: (() => void) | undefined;
  let stopAssessments: (() => void) | undefined;
  let stopJobs: (() => void) | undefined;
  let stopScheme: (() => void) | undefined;
  let stopReload: (() => void) | undefined;
  let stopRestarts: (() => void) | undefined;
  let stopRelease: (() => void) | undefined;
  let login: AbortController | undefined;
  type Worker = Awaited<ReturnType<RootClient["workers"]>>[number];
  const workers = new Map<
    string,
    { summary: Worker; state: Watched<ConversationView>; stop(): void }
  >();
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let lastRootEntry: number | undefined;

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
    view.setWorkers(rows.filter((row) => row.value !== ""));
    view.updateAgents(rows);
    if (state) {
      const shown = presentation(state.value);
      const model =
        shown.provider === undefined
          ? undefined
          : backend.model({ provider: shown.provider, modelId: shown.model });
      const split = rootIds(roots);
      view.setFooter({
        rootId: split(rootId),
        rootLabel: roots.find((each) => each.id === rootId)?.label ?? "",
        roots: activeRoots(roots).map((each) => ({ ...each, shown: each.id === rootId })),
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
    view.restoreQueued(await front.abort());
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
      const target = front;
      inputs = inputs
        .then(async () => {
          if (await target.editQueued(name, id, change)) return;
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
    const current = generation;
    const stale = () => closing || current !== generation;
    refreshing = (async () => {
      while (refreshAgain && !stale()) {
        refreshAgain = false;
        const summaries = await front.workers();
        if (stale()) return;
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
          if (stale()) return;
          const existing = workers.get(summary.name);
          if (existing) {
            existing.summary = summary;
            continue;
          }
          const state = await front.viewState(summary.name);
          if (stale()) {
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

  const seen: { failure?: string } = {};
  /**
   * Shows a root: attaches its front, workers and routing advice, then lets go of the root shown before, which marks
   * that one seen. Notices stay with the root they were posted in.
   */
  async function openRoot(id: string): Promise<void> {
    const next = backend.root(id);
    const state = await next.viewState();
    if (closing) {
      state.dispose();
      return;
    }
    generation++;
    await refreshing?.catch(() => {});
    stopRoot?.();
    stopAssessments?.();
    for (const worker of workers.values()) {
      worker.stop();
      worker.state.dispose();
    }
    workers.clear();
    root?.dispose();
    front = next;
    rootId = id;
    root = state;
    selected = undefined;
    lastRootEntry = undefined;
    stopRoot = state.subscribe((value) => {
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
    const shown = new Set<number>();
    let hydrated = false;
    stopAssessments = await next.watchAssessments((items) => {
      for (const item of items) {
        if (item.result === null || shown.has(item.taskId)) continue;
        shown.add(item.taskId);
        if (!hydrated) continue;
        const text = assessmentNotice(item.result, seen);
        if (text !== undefined) view.notice(text);
      }
      hydrated = true;
    });
    const routing = await next.routing();
    if (routing.paused) view.notice(routingText(routing));
    await refreshWorkers();
    show(true);
  }

  /** Opens another root and says which, with its label. */
  async function switchRoot(id: string): Promise<void> {
    if (id !== rootId) await openRoot(id);
    const summary = roots.find((each) => each.id === id);
    view.notice(`root · ${id}${summary === undefined ? "" : ` · ${rootLabel(summary)}`}`);
  }

  async function newRoot(): Promise<void> {
    await switchRoot(await backend.createRoot(randomUUID()));
  }

  async function archive(id: string, archived: boolean): Promise<void> {
    await backend.archiveRoot(id, archived);
    // An archived root leaves the list: this terminal moves on to the current root.
    if (archived && id === rootId) await switchRoot(await backend.currentRoot());
  }

  /** Runs a menu's action in turn with typed input; rejects with its failure, which the menu shows. */
  async function queued(task: () => Promise<void>): Promise<void> {
    const run = inputs.then(task);
    inputs = run.catch(() => {});
    await run;
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
        : await front.modelChoice(target.name);
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
            await front.pickModel(change, save, target.name);
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

  /** First-run guidance: which providers still need /login, and whether Clef is off for lack of one. */
  async function loginHint(
    startup: boolean,
    needs?: Awaited<ReturnType<Client["loginNeeds"]>>,
  ): Promise<void> {
    for (const line of loginHints(needs ?? (await backend.loginNeeds()), startup))
      view.notice(line);
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
      case "/mcp": {
        const [action, name, ...extra] = input.text.split(/\s+/).filter(Boolean);
        if (
          extra.length ||
          (action !== undefined && !["login", "logout", "reconnect"].includes(action))
        ) {
          view.notice(`Usage: /mcp ${commands["/mcp"].usage}`);
          break;
        }
        try {
          if (action === undefined || action === "reconnect") {
            view.notice("mcp · connecting to every server…");
            const report =
              action === "reconnect" ? await backend.mcpReconnect() : await backend.mcpServers();
            view.notice(formatReports(report, (server) => `/mcp login ${server}`).join("\n"));
            break;
          }
          let server = name;
          if (server === undefined) {
            const { servers } = await backend.mcpServers();
            const candidates = servers.filter((each) =>
              action === "login" ? each.state === "needs-auth" : each.auth === "oauth",
            );
            if (candidates.length === 0) {
              view.notice(
                action === "login" ? "mcp · no server needs sign-in" : "mcp · no OAuth servers",
              );
              break;
            }
            if (candidates.length === 1) server = candidates[0]?.name;
          }
          if (action === "logout") {
            if (server === undefined) {
              view.notice(`Usage: /mcp ${commands["/mcp"].usage}`);
              break;
            }
            view.notice(`mcp · ${await backend.mcpLogout(server)}`);
            break;
          }
          const controller = new AbortController();
          login = controller;
          show();
          view.beginLogin(() => controller.abort());
          try {
            if (server === undefined) {
              const { servers } = await backend.mcpServers();
              server = await view.promptLogin(
                {
                  type: "select",
                  message: "Sign in to:",
                  options: servers
                    .filter((each) => each.state === "needs-auth")
                    .map((each) => ({ id: each.name, label: `${each.name} (${each.transport})` })),
                },
                controller.signal,
              );
            }
            const message = await backend.mcpLogin(
              server,
              {
                showAuthorizationUrl: (url) =>
                  view.loginMessage("Waiting for the browser · Esc to cancel", url, browserHere()),
                promptForRedirectUrl: (signal) =>
                  view
                    .promptLogin(
                      {
                        type: "text",
                        message:
                          "If the browser cannot reach this machine, paste the URL it was redirected to:",
                        signal,
                      },
                      controller.signal,
                    )
                    .catch(() => undefined),
              },
              controller.signal,
            );
            view.notice(`mcp · ${message}`);
          } catch (error) {
            // MCP sign-in takes nothing secret typed, so its errors carry no credentials.
            view.notice(
              controller.signal.aborted
                ? "mcp · sign-in cancelled"
                : `mcp · ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            login = undefined;
            view.endLogin();
            show();
          }
        } catch (error) {
          view.notice(`mcp · ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "/login": {
        const controller = new AbortController();
        let loggedIn = false;
        login = controller;
        show();
        view.beginLogin(() => controller.abort());
        try {
          const provider = await view.promptLogin(
            { type: "select", message: "Choose provider:", options: LOGIN_PROVIDERS },
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
                      `Code: ${event.userCode}\nWaiting for approval · Esc to cancel`,
                      event.verificationUri,
                    );
                    break;
                  case "auth_url":
                    // As in Pi: a sign-in page opens by itself; a device code is read first, so its page waits.
                    view.loginMessage("", event.url, browserHere());
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
          loggedIn = true;
        } catch {
          // Provider failures can include entered credentials. Never echo raw login errors.
          view.notice(controller.signal.aborted ? "login cancelled" : LOGIN_FAILED);
        } finally {
          login = undefined;
          view.endLogin();
          show();
        }
        // After the editor is back, so typing never races the check.
        if (loggedIn) await loginHint(false);
        break;
      }
      case "/clef":
        view.notice(
          routingText(await front.routing(input.text === "" ? undefined : input.text === "off")),
        );
        return;
      case "/reload": {
        view.notice(`reloaded · ${(await backend.reload()).join(", ")}`);
        break;
      }
      case "/update":
        // As for /restart: only editor input gets here. The core checks the release, then closes for the install.
        await backend.update(input.text);
        view.notice(
          `installing ${input.text} · Monchu restarts on it, or on this version if npm fails`,
        );
        break;
      case "/restart":
        // Only editor input reaches this handler; model output never authorizes a restart.
        if (!backend.restartsProcess) {
          // Attached to a core elsewhere: it restarts, and this terminal reconnects when it is back.
          await backend.restart();
          view.notice("restart requested · reconnects when Monchu is back");
          break;
        }
        restarting = true;
        closing = true;
        exit();
        break;
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
      case "/roots": {
        const command = parseRootsCommand(input.text);
        switch (command.kind) {
          case "list":
            view.openRoots(roots, rootId, {
              open: (id) => {
                inputs = inputs.then(() => switchRoot(id)).catch(fail);
              },
              // Through the input chain, so a root change never races a message being sent; the panel shows failures.
              create: () =>
                queued(async () => {
                  await newRoot();
                  view.closeSelector();
                }),
              rename: (id, label) => queued(() => backend.renameRoot(id, label)),
              archive: (id, archived) =>
                queued(async () => {
                  const shown = rootId;
                  await archive(id, archived);
                  if (rootId !== shown) view.closeSelector();
                }),
            });
            break;
          case "switch":
            await switchRoot(await backend.findRoot(command.prefix));
            break;
          case "new":
            await newRoot();
            break;
          case "rename":
            await backend.renameRoot(rootId, command.label);
            view.notice(
              command.label ? `root renamed · ${command.label}` : "root named by its next message",
            );
            break;
          case "archive": {
            const id =
              command.prefix === undefined ? rootId : await backend.findRoot(command.prefix);
            await archive(id, command.archived);
            view.notice(
              `${command.archived ? "archived" : "unarchived"} · ${id}${command.archived ? " · nothing deleted; /roots h shows it" : ""}`,
            );
            break;
          }
        }
        break;
      }
      case "/logs": {
        const records = await backend.logs(logQuery(input.text));
        view.notice(
          records.length === 0
            ? "logs · nothing yet"
            : [`logs · ${records.length}`, ...records.map(formatRecord)].join("\n"),
        );
        break;
      }
      case "/jobs": {
        const { jobs, events, listing } = await backend.jobs();
        view.notice(
          [
            `jobs · ${jobs.length}`,
            listing,
            ...(events.length === 0 ? [] : ["recent:", ...events.slice(-8).map(formatJobEvent)]),
          ].join("\n"),
        );
        break;
      }
      case "/goals":
        view.openGoals(await front.goals(), (goal) => {
          inputs = inputs.then(() => front.seeGoal(goal.id, goal.updatedAt)).catch(fail);
        });
        break;
      case "/model":
      case "/thinking": {
        // First what to change, the shown conversation first, then the model or thinking level for it.
        await refreshWorkers();
        const options = pickTargets(selected, [...workers.keys()]);
        const targets = new Map(options.map(({ label, target }) => [label, target]));
        const command = input.command;
        const search = "text" in input ? input.text || undefined : undefined;
        view.choose(
          command === "/model" ? "Pick the model of" : "Pick the thinking level of",
          options.map(({ label, description }) => ({ value: label, label, description })),
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
      case "/stop": {
        // The named worker, else the shown conversation: the root's front stops as Esc stops it.
        const name = input.text || selected;
        if (name === undefined) {
          await abort();
          break;
        }
        await front.stopWorker(name);
        view.notice(`stopped worker · ${name}`);
        await refreshWorkers();
        break;
      }
      case "/new":
        await front.reset(input.text);
        view.notice(input.text ? "new context · handoff carried" : "new context");
        break;
      case "/compact":
        await front.compact(input.text);
        view.notice("compaction started");
        break;
      case "/cd": {
        const name = selected;
        const directory = await front.changeDirectory(input.text, name);
        view.notice(`${name ?? "root"} directory · ${directory}`);
        if (name !== undefined) await refreshWorkers();
        break;
      }
      case "skill":
      case "message": {
        // Capture focus now: a later view switch must not redirect an already submitted input.
        const name = selected;
        const text =
          input.command === "skill" ? await backend.skillInput(input.name, input.text) : input.text;
        if (name === undefined) await front.submit(text, randomUUID(), whenBusy);
        else await front.messageWorker(name, text, randomUUID(), whenBusy);
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
    await openRoot(rootId);
    stopRoots = await backend.watchRoots((next) => {
      roots = next;
      view.updateRoots(next);
      show();
    });
    view.setSkills(backend.skills());
    stopReload = backend.onReload(() => {
      view.setSkills(backend.skills());
      applyTheme();
      show(true);
    });
    stopReports = backend.onReport((message) => view.notice(`warning · ${message}`));
    // Another client's user approved a restart: this terminal lets go of the screen first, as for its own /restart.
    stopRestarts = backend.onRestartRequest(() => {
      if (closing) return;
      restarting = true;
      closing = true;
      exit();
    });
    // The TUI is one client of the job event stream: events from now on show as notices.
    stopJobs = await backend.watchJobEvents((await backend.jobs()).nextEvent - 1, (events) => {
      // Each terminal hears its shown root's jobs; `/jobs` lists them all.
      for (const event of events)
        if (jobEventRoot(event, roots) === rootId) view.notice(formatJobEvent(event));
    });
    // Read before input starts, so the startup hint never lands mid-command.
    const needs = await backend.loginNeeds();
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
    view.intro(backend.home, backend.release.version);
    for (const note of [...backend.notes, ...notes]) view.notice(note);
    let release = backend.release;
    for (const line of releaseNotices(undefined, release)) view.notice(line);
    stopRelease = backend.onRelease((next) => {
      for (const line of releaseNotices(release, next)) view.notice(line);
      // An attached terminal keeps running the code it started with, which the update replaced on disk.
      if (!backend.restartsProcess && next.version !== release.version)
        view.notice(
          "warning · this terminal still runs the old version; quit and start monchu again",
        );
      release = next;
    });
    // Process start to an interactive terminal, the number restart parity is measured by.
    backend.record("tui", "ready", { ms: Math.round(performance.now()) });
    await loginHint(true, needs);
    await exited;
  } finally {
    closing = true;
    process.off("SIGTERM", exit);
    process.off("SIGINT", interrupt);
    // Let an in-flight admission settle before main closes storage. Queued inputs see closing and stop.
    login?.abort();
    await inputs;
    stopReload?.();
    stopRestarts?.();
    stopRelease?.();
    stopScheme?.();
    stopReports?.();
    stopRoots?.();
    stopAssessments?.();
    stopJobs?.();
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
  // Never wait for restart inside handle(): cleanup waits for that input promise to settle. The entry point re-executes.
  if (!restarting) return "quit";
  await backend.restart();
  return "restart";
}
