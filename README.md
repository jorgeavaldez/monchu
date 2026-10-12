# Monchu

A personal everything agent built around [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
Luna handles conversation; named Sol workers can run in the background while chat stays available.

## Canonical project context

Product intent, decisions, roadmap, and tasks live in Jorge's Obsidian vault:

- `projects/monchu.md`
- `projects/monchu/foundation.md`
- `projects/tasks.md`, tag `#monchu`

Resolve the vault through `OBSIDIAN_VAULT_PATH` and read its live `AGENTS.md` before editing notes.
This repo owns implementation documentation, not a second roadmap.

## Run

Use npm **12.2.0 or newer** and Node **22.19 or newer**.
`mise.toml` pins the preferred toolchain.
Development tooling (TypeScript 7, oxlint, knip, vitest) runs on Windows, macOS, and Linux.
Android (Termux) is a runtime target only: the phone runs a build made elsewhere, so runtime code must work there, but checks and builds need not.

```sh
npm ci
npm run build
npm start
# or, with source watching:
npm run dev
```

The runtime reuses Pi's agent configuration directory through `getAgentDir()` and `ModelRuntime`.
Configure/login to `openai-codex` through Pi; do not copy credentials into this repo.
There is no silent model/provider fallback.

`~/.monchu/config.json` is optional; every field has a default:

```json
{
  "front": { "provider": "openai-codex", "modelId": "gpt-6-luna", "thinkingLevel": "low" },
  "worker": { "provider": "openai-codex", "modelId": "gpt-6.1-sol", "thinkingLevel": "high" },
  "classifier": { "provider": "cloudflare-workers-ai", "modelId": "@cf/cloudflare/clef-flash" },
  "cloudflareAccountId": "optional 32-character account ID override"
}
```

Unknown fields or unknown models fail startup. `"classifier": null` turns classification off.
The front role is applied to the root conversation at every start, from its next request; new workers use the worker role.

Clef Flash uses Pi's native `cloudflare-workers-ai` provider, so Pi's Cloudflare credentials apply: its stored login (key and account ID) or `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`.
`MONCHU_CF_WORKERS_AI_TOKEN` and `cloudflareAccountId` are optional overrides.
Never put the token in the config file or source code.

The front reads `SOUL.md`, `AGENTS.md`, `DEVICES.md`, `memories/USER.md`, and `memories/MEMORY.md` from its home on every model request. Workers read only the two memory files and `DEVICES.md`. Each file is labelled with its editable path; missing files are skipped with one warning per path for the runtime's lifetime, including reloads. All roles receive device facts (hostname, OS/release, user, user home, Monchu home, execution directory).

Skills load in place at startup and on reload from `<home>/skills` and this checkout's bundled `skills/`, with home skills winning name collisions. Only metadata is advertised; bodies are read on demand. Pi instructions, skills, packages, and cwd/ancestor resources are not loaded, and no skill is copied into Pi's agent directory.

Run policy, theme, built-in tool selection, and shell configuration currently use Pi SDK in-memory defaults, with no settings-file reads or filesystem locks. Own validated `config.json` settings and credentials are a separate follow-up; model authentication still uses Pi as described above.

Chat history and task checkpoints live in `~/.monchu/monchu.sqlite`.
`owner.sqlite` holds a process-lifetime exclusive lock so only one runtime owns that home.
Crashes release the lock automatically.
Do not sync a live database or open it from multiple devices.

## Terminal

Just type a message. Receipt means the input was committed, not that the model has answered.
The Pi-style alternate-screen TUI renders committed Durable conversation views, including streaming replies, tool cards, retries, and queued input.
It needs an interactive terminal; piped stdin/stdout is not supported.
The multiline editor stays available below the transcript while replies and workers run.
Receipts, effort assessments, and warnings use `system ·`; worker reports and updates use `worker · <name> · <status>`.
The front replies immediately: a direct answer, or a one-line acknowledgement while it starts the work.
Clef Flash assesses each message's effort (single turn or sustained) and scope (contained or expanding) beside that reply, never in front of it.
Its result joins the front's later requests as advice and shows as `system · effort`.
When Clef is sure (70%+) the work outgrows a fast reply and the front finished without delegating, one follow-up input (`system · escalation`) asks the front to hand it to a worker.
Thinking content stays hidden; the terminal shows an indicator when the provider emits thinking events.
Pi's editor, message components, tool renderers, and scrolling viewport provide the terminal UI.
The status indicator shows working, thinking, tool execution, compaction, and retry activity.
The TUI follows terminal light/dark reports with Pi's built-in themes.

`/help` lists the commands; `src/tui/commands.ts` defines them.

`/agents` opens a filterable worker selector with current status and directory.
Selecting a worker shows its conversation; plain messages go to that worker through the existing worker-delivery path.
The root is shown by default; `/agents root` returns to it.
Root commands such as `/abort`, `/new`, `/compact`, and `/cd` still target the root while a worker is shown.
Esc or Ctrl-C aborts the front only, Ctrl-D exits with an empty editor, and Ctrl-O expands tool output.
Shift-Enter or backslash-Enter adds a newline.
`/reload` reloads extensions and home/bundled skills, showing the reloaded modules or an error in the TUI. Home-file edits need no reload.
`/restart` is Jorge's explicit restart approval, even while a worker is shown. It stops input/rendering, disposes view attachments, and restores the terminal before the backend closes storage/resources and re-executes Monchu. Model output and `request_restart` cannot execute this command.

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the same installed tools: read, write, edit, bash, worker management, and `codemode`. The tool adapter also supports Pi's grep, find, ls, and powershell built-ins when selected; on Android (Termux) grep and find are skipped with a warning, so use bash with `rg`/`fd` on PATH. Tool selection currently uses the defaults; own configurable selection is a follow-up.
`codemode` runs model-written JavaScript in Pi's QuickJS sandbox; scripts call the other tools as `await tools.<name>(args)`, and `store()`/`load()` values persist per conversation.
Nested calls run inside the one codemode tool call, so a crash does not replay the script.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

The root conversation keeps Jorge's goals and its own commitments in the `monchu.goals` document.
Each goal has an id, title, owner (`jorge` or `monchu`), status (`active`, `waiting`, `done`, `dropped`), optional project (absolute directory or repository), linked worker names, the next step, and an update time.
The front keeps them current with `update_goal` (create, or patch one goal by id) and reads them with `list_goals`; both are root-only, so workers do not get them.
Active and waiting goals render as the `goals` prompt section in stored order; Durable resends a section only when its text changes.
Open goals are always kept; done and dropped goals are kept for the 20 most recently changed.
`/goals` lists the open goals.
The document is not transcript, so `/new`, compaction, and restarts keep it, and the section returns in the next request.
`/compact` always asks the summary to keep goal ids and open commitments, ahead of any focus you add.
Durable's automatic compaction takes no instructions; its summary may drop goal history, but the section still restores the open goals.

`/abort` (or interactive Ctrl-C) stops the front only.
`/stop` explicitly cancels a worker, its pending deliveries, and nested work, and withdraws its reports and updates still queued for the front; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
It then stops running tool processes, closes provider connections pi-ai keeps cached (Codex websockets), and exits; if anything else still holds the process, it exits after one second anyway.
Unfinished work resumes when the backend opens, whether or not a terminal is attached; the terminal starts from a snapshot.
A worker's result reaches the parent as a labelled follow-up input, so the front gets a turn: it tells Jorge in a line or two and continues with the next step.
While the front is busy, the report queues until its current answer, then starts one turn; it never lands between a tool call and its result.
Workers can call `post_update` for progress worth hearing before they finish; it reaches the parent the same way, and a newer update withdraws one still queued (at most one queued update per worker).
`/abort` withdraws queued input: a withdrawn report is posted again, a withdrawn update is dropped.
Non-fatal runtime failures appear as `system · warning` and are appended to `~/.monchu/monchu.log`.
Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## Offline TUI smoke mode

Build, then start the real entry point in an interactive terminal with scripted faux models (Nushell):

```nu
npm run build
with-env { MONCHU_DEV_FAUX: "1" } { node dist/main.js }
```

This explicit dev mode creates a fresh `monchu-smoke-*` home in the OS temp directory, including isolated Pi settings/auth/skills; it never opens `~/.monchu` or uses live providers.
Normal startup is unchanged.
The inherited `MONCHU_DEV_HOME` preserves that temporary home through `/restart`; paths outside the temp directory are rejected.
The home is printed at startup and kept for inspection; delete it after exiting.

Smoke steps: send `hello`, then `read` (a real read tool call on a missing file), then `/work reader inspect`.
Expect a streaming faux reply, a tool error, labelled worker progress/result lines, and the front's acknowledgement.
Use `/agents`, filter `reader`, Enter, and send `more`; `/agents root` returns to the front.
Run `/reload` and expect `reloaded · context, ...`.
Run `/restart`: the app re-executes in the same terminal, restores the conversation and workers, and accepts another message.
Finish with `/quit` and check the shell's exit code is 0.
This checks lifecycle/rendering with deterministic models, not live models or Android/Termux.

## Self reload

`reload_extensions` is available to all roles, as is Jorge's `/reload` command. The backend exposes `reload()` and `restart()`; only Jorge's `/restart` command calls the latter after restoring the terminal.

Reload reads the running checkout, never a conversation's cwd or another jj workspace. Source mode imports edited `.ts` modules through Node's type stripping; compiled mode runs `npm run build` in that checkout first. Each module in the manifest (`Reloadable` in `src/reload.ts`) is imported with a fresh query string. Static imports remain cached, so dependency and host changes require a restart.

All modules are built and the complete registry and installation order validated before installing anything. A build/import/validation error leaves installed code and settings unchanged. Running calls finish on old code; later phases/calls/requests use the replacements. Reload also refreshes the skill metadata snapshot; existing tool environments remain alive. Doc kinds and task names/versions preserve existing state and pending tasks; schema/checkpoint changes still require explicit versioning and migration.

`request_restart({ reason })` only records a durable request on the root and advertises it as a section. It never restarts. Jorge's backend `restart()` approval clears the request, pauses accepted work, closes the Harness/storage and tool/provider resources, re-executes the same Node entry/arguments with inherited stdio, and exits with the child. There is no daemon, supervisor, or agent restart tool.

`skills/monchu/SKILL.md` is read from this checkout in place, without a startup copy. It tells Monchu to edit source in a jj workspace, check and build it, apply authorized changes to the running checkout, and reload; host changes need the user's restart approval.

## Backend boundary

- `src/backend.ts`: store ownership, Pi model runtime, admission, observation, worker controls, and execution directories.
- `src/config.ts`: optional host config: model roles and classifier overrides.
- `src/workers.ts`: durable worker ownership/delivery state machines, worker lookup/stop/pending checks, and model tools.
- `src/goals.ts`: the root's goals document, `update_goal`/`list_goals`, and the `goals` section.
- `src/codemode.ts`: the `codemode` tool over `@earendil-works/pi-codemode` and its per-conversation store.
- `src/classifier.ts`: non-blocking Clef Flash effort/scope assessment as a background Durable task per front input, advice for later requests, and the escalation follow-up. It never grants permission.
- `src/context.ts`: home/bundled skill metadata as a prompt section, in-memory SDK settings defaults, and Durable run settings.
- `src/reload.ts`: the extension registry, the reloadable-module manifest, validated in-process replacement, once-only missing-file warnings, the reload tool, and durable restart requests.
- `src/identity.ts`: per-request home-file and device sections, and the front's instructions.
- `src/pi-tools.ts`: built-in selection and shell configuration inside Durable tool invocations.
- `src/tui/app.ts`: terminal lifecycle, command dispatch, and read-only view attachments.
- `src/tui/`: the command table and input parsing, Durable presentation mapping, and Pi-style viewport rendering.
- `src/main.ts`: lifecycle wiring.

The backend imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
The TUI uses the read-only `viewState(workerName?)` attachment and disposes it on exit; input still goes through backend methods.
This slice has no HTTP server, daemon transport, phone UI, scheduling, or memory backend.

Submission IDs prevent duplicate admission.
Worker delivery bookkeeping retains all active requests and the latest 200 completed request IDs for retries; older completed IDs may be admitted again.
Reported answer bookkeeping keeps 200 recent IDs per worker plus any answers still needed by active deliveries.
These windows bound the materialized worker bookkeeping, not Durable's stored tasks or transcript.
The latest-history worker document checkpoints every 32 changed commits, retaining one base and at most 31 deltas rather than an ever-growing revision tail.
This bounds worker revision count, not total SQLite-file size; active work and the worker registry can still grow.
Neither receipt nor the front's reply waits for Clef.
Each admitted message gets one assessment task (keyed by submission) in `monchu.assessments`; recovery reuses its committed result.
An escalation is skipped when the front started or messaged a worker for that message, when a newer message arrived, or when Clef is unsure.
Classifier failures are visible and never escalate; there is no fallback classifier.
`/new [handoff]` starts a fresh model context (Durable `reset`); storage keeps every entry and the worker registry.
Reports are submitted with stable request IDs (`worker-report:<task>`, then `:<n>` for re-posts after `/abort`), so recovery submits each report once; the reporter finishes once the parent's transcript holds it.
Interrupted external side effects are not exactly-once: unsafe tools are not blindly replayed.
SQLite uses Durable's WAL/NORMAL policy; process-crash recovery does not promise that newest commits survive power loss.

A home written before the 2026-10 refactor needs a fresh `monchu.sqlite`; there is no compatibility code for older stored data.

## Checks

```sh
npm run check   # typecheck, type-aware lint, format, knip, tests
npm run build
```

- `npm run typecheck`: `tsc` over `src`, `test`, and `vitest.config.ts` (`tsconfig.json`); `npm run build` emits `src` only (`tsconfig.build.json`).
- `npm run lint`: oxlint with type information. It rejects `any` leaks, casts and non-null assertions, TypeScript suppression comments, values that would print as `[object Object]`, import cycles, any import of `src/tui` outside `src/main.ts` and the TUI itself, and `vi` in tests.
- `npm run knip`: unused files, exports, and dependencies. The reload manifest imports its modules through computed URLs, so the exports it reads are tagged `@public`.
- `npm test`: vitest against real Durable Harnesses on SQLite, with Pi's faux chat provider and a scripted classifier provider registered in real pi-ai `Models`, following Pi Durable's own tests. `vitest.config.ts` points `HOME`, `USERPROFILE`, and `PI_CODING_AGENT_DIR` at a temp sandbox, and each test's `setup()` narrows them to its own directory, so no test reads or writes `~/.monchu`, `~/.pi`, or `~/.agents`.
  TUI tests use a Pi-derived `VirtualTerminal` backed by `@xterm/headless` to check the visible screen at 40/60 columns in light/dark.
  Tests do not prove live provider behavior or the interactive phone flow.

Durable is experimental.
The npm lockfile pins the Pi/Durable version; inspect the installed declarations before adapting it.
Local Pi source is at `~/proj/pi`.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
