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
The front uses `openai-codex/gpt-6-luna` with low thinking.
Workers use `openai-codex/gpt-6.1-sol` with high thinking.
There is no silent model/provider fallback.

Chat history and task checkpoints live in `~/.monchu/monchu.sqlite`.
`owner.sqlite` holds a process-lifetime exclusive lock so only one runtime owns that home.
Crashes release the lock automatically.
Do not sync a live database or open it from multiple devices.

## Terminal

Just type a message. Receipt means the input was committed, not that the model has answered.
Replies stream from committed Durable events.

```text
/work reader summarize a subject using the available local files
/tell reader focus on the unresolved questions
/workers
/stop reader
/abort
/cd ~/proj/monchu
/cd-worker reader ~/proj/pi
/help
/quit
```

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the installed tools: read, write, edit, bash, and worker management.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

`/abort` (or interactive Ctrl-C) stops the front only.
`/stop` explicitly cancels a worker, its pending deliveries, and nested work; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
On the next launch, attach the terminal first, then resume unfinished work.
Worker results are committed directly into the parent transcript and displayed without an extra front-model turn.
Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## Backend boundary

- `src/backend.ts`: store ownership, Pi model runtime, admission, observation, worker controls, and execution directories.
- `src/workers.ts`: durable worker ownership/delivery state machines and model tools.
- `src/classifier.ts`: explicit disabled placeholder called on front input admission. No classifier API calls, routing decisions, or fallback provider.
- `src/terminal.ts`: stdin, commands, and rendering only.
- `src/main.ts`: lifecycle wiring.

The backend imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
Events use Durable's serializable event protocol; a future interface can consume the same backend.
This slice has no HTTP server, daemon transport, phone UI, codemode adapter, scheduling, or memory backend.

Submission and worker delivery IDs prevent duplicate admission.
Result append and reporter completion share one Durable commit.
Interrupted external side effects are not exactly-once: unsafe tools are not blindly replayed.
SQLite uses Durable's WAL/NORMAL policy; process-crash recovery does not promise that newest commits survive power loss.

## Checks

```sh
npm run typecheck
npm run lint
npm run build
npm run check
```

No test suite or mocks are added for this slice.
These static checks do not prove live provider, interaction, background, or restart behavior.

Durable is experimental.
The npm lockfile pins Pi/Durable **1.0.0**; inspect installed declarations before adapting it.
Local Pi source is at `~/proj/pi`.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, MCP, and codemode require a deliberate Durable integration.
