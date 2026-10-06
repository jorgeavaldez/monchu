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

Run policy (stream timeout, retries, compaction, steering and follow-up modes) comes from Pi's `settings.json`, read at each use.

Chat history and task checkpoints live in `~/.monchu/monchu.sqlite`.
`owner.sqlite` holds a process-lifetime exclusive lock so only one runtime owns that home.
Crashes release the lock automatically.
Do not sync a live database or open it from multiple devices.

## Terminal

Just type a message. Receipt means the input was committed, not that the model has answered.
Replies stream from committed Durable events.
Live input and restored history use `you>`; answers use `monchu · response`.
Receipts, routing, loading/thinking, and tool activity use `system ·`; background results use `worker · <name>`.
Thinking content stays hidden; the terminal shows an indicator when the provider emits thinking events.
Indicators are event-driven text, not animations or a new TUI framework.

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
All roles receive the installed tools: read, write, edit, bash, worker management, and `codemode`.
`codemode` runs model-written JavaScript in Pi's QuickJS sandbox; scripts call the other tools as `await tools.<name>(args)`, and `store()`/`load()` values persist per conversation.
Nested calls run inside the one codemode tool call, so a crash does not replay the script.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

`/abort` (or interactive Ctrl-C) stops the front only.
`/stop` explicitly cancels a worker, its pending deliveries, and nested work; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
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
- `src/classifier.ts`: Clef Flash classification as a Durable child task before front model requests. Typed reply/background/clarify and light/deep advice includes confidence, probabilities, and reported usage; it never grants permission or creates topic threads.
- `src/terminal.ts`: stdin, commands, and rendering only.
- `src/main.ts`: lifecycle wiring.

The backend imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
Events use Durable's serializable event protocol; a future interface can consume the same backend.
This slice has no HTTP server, daemon transport, phone UI, scheduling, or memory backend.

Submission and worker delivery IDs prevent duplicate admission.
Receipt does not wait for Clef or the chat model.
Classification tasks are cached per accepted input; classifier output and task completion share one Durable commit, so continuations/recovery reuse a committed result.
Routing advice stays with the front; substantial authorized work still uses workers.
Provider failures are visible and carry uncertainty into the front request, with no fallback classifier.
Result append and reporter completion share one Durable commit, made only while the parent is idle.
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
The npm lockfile pins Pi/Durable **1.0.2**, including Clef's direct-response support; inspect installed declarations before adapting it.
Local Pi source is at `~/proj/pi`.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
