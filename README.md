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
TypeScript 6 is used because TypeScript 7's native compiler does not ship an Android binary.

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

User-level Pi configuration comes from `getAgentDir()`: global context-file precedence, `SYSTEM.md`, `APPEND_SYSTEM.md`, settings, and skills. Coding-agent instructions are labeled guidance; they do not replace Monchu's identity or front/worker workflow. Skills use Pi's user discovery (including `~/.agents/skills`), configured paths/filters, and installed package resources; only metadata is advertised, with instructions read on demand. Missing packages are not installed and executable extensions are not loaded.

Resources and settings load at startup, independently of execution cwd. Project `.pi` settings/resources and cwd/ancestor context are excluded. Run policy (stream timeout, retries, compaction, steering and follow-up modes), built-in tool defaults, shell path, and shell command prefix come from these user settings.

Chat history and task checkpoints live in `~/.monchu/monchu.sqlite`.
`owner.sqlite` holds a process-lifetime exclusive lock so only one runtime owns that home.
Crashes release the lock automatically.
Do not sync a live database or open it from multiple devices.

## Terminal

Just type a message. Receipt means the input was committed, not that the model has answered.
Replies stream from committed Durable events.
Live input and restored history use `you>`; answers use `monchu · response`.
Receipts, effort assessments, loading/thinking, and tool activity use `system ·`; background results use `worker · <name>`.
The front replies immediately: a direct answer, or a one-line acknowledgement while it starts the work.
Clef Flash assesses each message's effort (single turn or sustained) and scope (contained or expanding) beside that reply, never in front of it.
Its result joins the front's later requests as advice and shows as `system · effort`.
When Clef is sure (70%+) the work outgrows a fast reply and the front finished without delegating, one follow-up input (`system · escalation`) asks the front to hand it to a worker.
Thinking content stays hidden; the terminal shows an indicator when the provider emits thinking events.
Indicators are event-driven text, not animations or a new TUI framework.

```text
/work reader summarize a subject using the available local files
/tell reader focus on the unresolved questions
/workers
/stop reader
/abort
/new optional handoff note for the fresh context
/compact focus on the open decisions
/cd ~/proj/monchu
/cd-worker reader ~/proj/pi
/help
/quit
```

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the same installed tools: Pi's user-selected built-ins (read, write, edit, bash by default), worker management, and `codemode`. Pi's optional grep, find, ls, and powershell built-ins are also supported when selected. Built-in selection does not disable Monchu's worker management or `codemode`.
`codemode` runs model-written JavaScript in Pi's QuickJS sandbox; scripts call the other tools as `await tools.<name>(args)`, and `store()`/`load()` values persist per conversation.
Nested calls run inside the one codemode tool call, so a crash does not replay the script.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

`/abort` (or interactive Ctrl-C) stops the front only.
`/stop` explicitly cancels a worker, its pending deliveries, and nested work; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
It then stops running tool processes, closes provider connections pi-ai keeps cached (Codex websockets), and exits; if anything else still holds the process, it exits after one second anyway.
Unfinished work resumes when the backend opens, whether or not a terminal is attached; the terminal starts from a snapshot.
Worker results are committed directly into the parent transcript and displayed without an extra front-model turn.
A result waits until the parent has no active run, so it never lands between a tool call and its result.
Non-fatal runtime failures appear as `system · warning` and are appended to `~/.monchu/monchu.log`.
Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## Backend boundary

- `src/backend.ts`: store ownership, Pi model runtime, admission, observation, worker controls, and execution directories.
- `src/config.ts`: optional host config: model roles and classifier overrides.
- `src/workers.ts`: durable worker ownership/delivery state machines and model tools.
- `src/codemode.ts`: the `codemode` tool over `@earendil-works/pi-codemode` and its per-conversation store.
- `src/classifier.ts`: non-blocking Clef Flash effort/scope assessment as a background Durable task per front input, advice for later requests, and the escalation follow-up. It never grants permission.
- `src/context.ts`: user-only Pi settings and resources, loaded once at startup; imported instructions and skill metadata as prompt sections.
- `src/pi-tools.ts`: user-selected built-ins and shell configuration inside Durable tool invocations.
- `src/terminal.ts`: stdin, commands, and rendering only.
- `src/main.ts`: lifecycle wiring.

The backend imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
Events use Durable's serializable event protocol; a future interface can consume the same backend.
This slice has no HTTP server, daemon transport, phone UI, scheduling, or memory backend.

Submission IDs prevent duplicate admission.
Worker delivery bookkeeping retains all active requests and the latest 200 completed request IDs for retries; older completed IDs may be admitted again.
Reported answer bookkeeping keeps 200 recent IDs per worker plus any answers still needed by active deliveries.
These windows bound the materialized worker bookkeeping, not Durable's stored tasks or transcript.
The latest-history worker document checkpoints every 32 changed commits, retaining one base and at most 31 deltas rather than an ever-growing revision tail.
An existing v2 tail above that limit is reclaimed on its next changed commit.
This bounds worker revision count, not total SQLite-file size; active work and the worker registry can still grow.
Neither receipt nor the front's reply waits for Clef.
Each admitted message gets one assessment task (keyed by submission) in `monchu.assessments`; recovery reuses its committed result.
An escalation is skipped when the front started or messaged a worker for that message, when a newer message arrived, or when Clef is unsure.
Classifier failures are visible and never escalate; there is no fallback classifier.
`/new [handoff]` starts a fresh model context (Durable `reset`); storage keeps every entry and the worker registry.
Result append and reporter completion share one Durable commit, made only while the parent is idle.
Interrupted external side effects are not exactly-once: unsafe tools are not blindly replayed.
SQLite uses Durable's WAL/NORMAL policy; process-crash recovery does not promise that newest commits survive power loss.

### Worker bookkeeping upgrade and rollback

The worker document migrates one-way from v1 to v2 on its first committing access, even without an edit.
The migration preserves delivery and answer IDs and initializes the cumulative delegation count from v1 deliveries.
A v1 build cannot read the migrated document.
Before upgrading, stop Monchu and take a consistent backup of its home, including `monchu.sqlite` and any SQLite WAL sidecars together.
To roll back, stop Monchu and restore that complete pre-upgrade backup before starting the v1 build; do not mix an old database with newer sidecars.
Restoring loses work accepted since the backup. Merely switching builds does not undo migration.

## Checks

```sh
npm run typecheck
npm run lint
npm run build
npm run check
```

`npm test` runs vitest against real Durable Harnesses on SQLite in temp directories, following Pi Durable's own tests: Pi's faux chat provider and a scripted classifier provider registered in real pi-ai `Models`.
They cover worker report placement and restart, codemode nesting/store/errors, non-blocking assessment and escalation, config parsing, and Pi context loading.
They do not prove live provider behavior or the interactive phone flow.

Durable is experimental.
The npm lockfile pins Pi/Durable **1.0.2**, including Clef's direct-response support; inspect installed declarations before adapting it.
Local Pi source is at `~/proj/pi`.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
