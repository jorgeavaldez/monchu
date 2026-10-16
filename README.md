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

`mise.toml` is the task runner; task commands are not duplicated in npm scripts.

```nu
mise run install
mise run start  # builds first when sources changed
# or, directly from source without a build or restart watcher:
mise run dev
```

Monchu owns its configuration and credentials; it never reads or writes `~/.pi`.
No coding-agent runtime or agent-directory override is loaded.
Shell-tool subprocesses inherit Monchu's process environment unchanged; there is no env file or shell startup override.
`src/models/` owns `<home>/auth.json`, provider registration, login, and model-role resolution on pi-ai.
Providers are code modules: Codex and Cloudflare use their built-in catalogs; Claude Code uses the Opus/Sonnet/Haiku chat catalog; dev/test modes inject faux providers.
The front and workers use the same chat providers. The classifier stays on Cloudflare's dedicated classification API; Claude Code does not invent classification probabilities. There are no file-based catalog overrides or catalog cache files.
Use `/login` inside Monchu for fresh per-device credentials; do not copy Pi credentials or share refresh tokens.
There is no silent model/provider fallback.

`~/.monchu/config.json` is optional; every field has a default:

```json
{
  "front": { "provider": "openai-codex", "modelId": "gpt-6-luna", "thinkingLevel": "low" },
  "worker": { "provider": "openai-codex", "modelId": "gpt-6.1-sol", "thinkingLevel": "high" },
  "classifier": { "provider": "cloudflare-workers-ai", "modelId": "@cf/cloudflare/clef-flash" },
  "claude": { "plan": "pro", "longContextExtraUsage": false },
  "settings": {
    "theme": "system",
    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000, "maxAgentDelayMs": 60000 },
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
    "httpIdleTimeoutMs": 300000,
    "defaultTools": ["read", "write", "edit", "bash", "fffind", "ffgrep"]
  }
}
```

Unknown fields or unknown models fail startup. `"classifier": null` turns classification off.
The front role is applied at startup and on `/reload`, from its next model request, except for a model or thinking level picked for the root with `/model` or `/thinking`; new workers use the current worker role. Existing workers keep their stored role.

`settings` is validated by Monchu, not a Pi settings-file pass-through. Omitted fields use Monchu's defaults shown above.
It also accepts `shellPath`, `shellCommandPrefix`, `steeringMode` and `followUpMode` (`all` or `one-at-a-time`), and `retry.provider` (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`). Provider retry-delay defaults to 60000 ms; timeout defaults to `httpIdleTimeoutMs` (0 disables the idle timeout).
Themes are built-in `light`, `dark`, `system`, or a `light/dark` pair. Shell path/prefix are unset by default.
`defaultTools` accepts exact built-in names, or only `+name`/`-name` modifiers. Monchu's own tools are separate from this selection.
`terminal` accepts `hyperlinks` and `trueColor` (boolean or `auto`), and `images` (`false`, `auto`, `kitty`, `iterm2`); omitted values use SDK capability detection.
One settings snapshot feeds Durable run policy, tool selection/shells, and the TUI. No Pi `settings.json` is loaded or written.

Clef Flash uses Pi's native `cloudflare-workers-ai` provider with Monchu's stored login (key and account ID) or `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`.
`MONCHU_CF_WORKERS_AI_TOKEN` and `cloudflareAccountId` (a non-secret 32-character hex account ID) are optional overrides.
Never put the token in the config file or source code.

## Claude Code subscription provider

Use `/login`, choose Claude Code, and paste a token obtained from `claude setup-token` into Monchu's own credential store.
API-key login and ambient Claude credentials are not supported. Setup-tokens are not refreshable; log in again when the server rejects an expired token.
Choose `claude-code` with an Opus, Sonnet or Haiku catalog ID in `front` or `worker`, for example `claude-opus-5-5`.

**Before first live use, Jorge must check that usage credits/extra usage are disabled on his Claude account.**
A subscription token alone does not prevent [account-level paid overflow](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans). Monchu does not change this account setting.
Two guards adapted from pi-claude-bridge reduce additional billing exposure:

- `claude.plan` defaults to `pro`; `claude.longContextExtraUsage` defaults to `false`. Opus 4.6 gets `[1m]` only on `max` or with explicit extra-usage opt-in; Sonnet 4.6 only with that opt-in. Leave the opt-in off for subscription-only operation. The bridge's measured subscription-safe list (Opus 5.5/5/4.8/4.7 and Sonnet 5.5/5) gets 1M; other models stay at 200K. The catalog window matches the CLI model variant.
- Before launching, the provider refuses an effective system prompt with Pi's preamble at line start (`You are an expert coding assistant operating inside pi`), or both `docs/custom-provider.md` and `docs/packages.md`. Reword the source instructions before retrying; prompts are never dumped to logs.

`claude.executable` accepts a Claude Code executable/wrapper path; relative paths are resolved under the Monchu home. If omitted, Monchu resolves `claude` on PATH.
It always passes the resolved path as the Agent SDK's `pathToClaudeCodeExecutable`, never using the SDK's platform-package lookup. Missing/startup errors name the attempted path. Windows paths must be directly launchable, not shell-only command shims.
Changes to `claude` host settings require `/restart`; a reload rejects them without applying a partial settings snapshot.

Claude Code uses `<home>/claude` as `CLAUDE_CONFIG_DIR`, an isolated execution directory, no setting sources, no hooks/plugins/skills, no native tools, and only Monchu's MCP bridge, with Durable owning tool execution.
The child environment is copied, stripping inherited `ANTHROPIC_*` and `CLAUDE_*` values before installing Monchu's token and isolation settings. Provider switches, fast mode, cloud MCP and automatic compaction are disabled.
Session/query behavior follows pi-claude-bridge 0.9.2: each Durable conversation's stable provider `sessionId` owns its Claude session and live query, independently of concurrent front/worker conversations.
A new user turn resumes that persisted session without rebuilding its history when the cursor matches, including an assistant already written by Claude. Missed or rewritten history is rebuilt from Durable via `cc-session-io`; a shorter synthetic context starts clean without replacing the conversation's mirror. Compaction summaries use an isolated, non-persisted query.
One SDK query stays parked across the whole turn's tool rounds. MCP handlers never execute tools or invent results: Durable commits the calls and runs every tool, then its next provider request delivers the real results to the parked handlers by `claudecode/toolUseId`, even when calls/results arrive out of order. No synthetic user prompt is added between live tool rounds. A steer is written before releasing results.
The final SDK result closes the input/query. Abort and explicit worker cancellation close/kill owned queries and invalidate their mirrors; the next request rebuilds with a rotated UUID to avoid an orphan writer. Restart or a discarded parked query rebuilds from Durable's current transcript; only a tool-result continuation without a live query uses the bridge's continuation prompt. Internal retry/fallback/compaction events and unsupported content fail explicitly rather than returning an empty final answer. Durable retains its own configured retry policy.

**Termux:** the SDK has no Android binary package, but this provider does not need one.
Jorge's working `claude` on PATH can use his glibc-runner (`grun`) or binary-patch workaround; otherwise point `claude.executable` at that wrapper.
See [the SDK lookup issue](https://github.com/anthropics/claude-code/issues/50270), [pybe's wrapper](https://github.com/pybe/claude-code-termux), and [d3ffen's workaround](https://github.com/d3ffen/claude-code-termux).
The SDK accepts an explicit executable and does not eagerly import a platform package. No phone fallback is built; no phone run has been performed.

Every model request rereads the home files. `AGENTS.md` is the shared manual every agent gets, with `DEVICES.md`, `memories/USER.md`, and `memories/MEMORY.md`; only the front also reads `SOUL.md` and its front-only manual `FRONT.md`. Workers also get the context files of their execution directory and its ancestors like Pi: in each directory the first of `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`, outermost first, skipping the home `AGENTS.md`. Claude Code workers receive the same sections through the bridge's system prompt; Claude Code's own `CLAUDE.md` loading stays off. Each file is labelled with its editable path; missing files are skipped with one warning per path for the runtime's lifetime, including reloads. All roles receive device facts (hostname, OS/release, user, user home, Monchu home, execution directory).

Skills load in place at startup and on reload from `<home>/skills` and this checkout's bundled `skills/`, with home skills winning name collisions. Only metadata is advertised; bodies are read on demand. Pi instructions, skills, packages, and cwd/ancestor resources are not loaded; no skills are copied.

Home paths owned by Monchu (all relative to `<home>`, default `~/.monchu`):

- `config.json`: optional model roles and validated run settings; no secrets. Only Ctrl+S in `/model` or `/thinking` writes it: the whole result passes the startup validator, then replaces the file atomically.
- `auth.json`: Monchu-owned credential storage, including OAuth refresh tokens and Cloudflare keys/account IDs. Locked read-modify-write operations publish atomically with mode 0600 (Windows uses its filesystem ACLs).
- `fff/`: frecency and query-history databases for native file/content search; no Pi or editor databases are reused.
- `claude/`: isolated Claude Code config/execution directory and persisted Claude session mirrors; not the durable conversation store.
- `monchu.sqlite`, `owner.sqlite`, their SQLite sidecars, and `monchu.log`: runtime state, ownership lock, and warnings.
- Home context files, `memories/`, `skills/`, and `souls/`: editable human/agent content, separate from runtime state.

Jorge's home is a jj repository shared across devices through the private `jorgeavaldez/monchu-home`. Its `.gitignore` excludes `auth.json`, `fff/`, `claude/`, the SQLite stores and their sidecars, and `monchu.log`. Never sync credentials or a live database.

To run Monchu on another device, clone this repository and run `mise run install`, clone `monchu-home` as `~/.monchu`, use `/login` for that device's credentials, and add the device to `DEVICES.md`.
Chat history and workers stay on the device that created them.

Chat history and task checkpoints live in `<home>/monchu.sqlite`.
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
Assessments follow the queue: editing a queued message assesses the new text instead, and a message withdrawn by Esc or deleted from `/queue` neither advises nor escalates.
Thinking content stays hidden; the terminal shows an indicator when the provider emits thinking events.
Pi TUI's editor and scrolling viewport provide the terminal UI. Monchu owns its Pi-derived message components, built-in themes, and renderer-only tool cards; rendering never loads coding-agent tool definitions or reads live files to preview edits.
The status indicator shows working, thinking, tool execution, compaction, and retry activity.
The TUI follows terminal light/dark reports with its copied built-in themes.

`/help` lists the commands; `src/tui/commands.ts` defines them.

`/agents` opens a live panel of the root and every worker: status (working or idle), context fill, and directory where it fits.
Selecting a worker shows its conversation; plain messages go to that worker through the existing worker-delivery path.
The root is shown by default; `/agents root` returns to it.
Root commands such as `/abort`, `/new`, `/compact`, and `/cd` still target the root while a worker is shown.
Esc interrupts a running front only and does nothing while it is idle; your own messages still queued for the front come back into the editor, oldest first, ahead of anything typed. Ctrl-C clears the editor and a second Ctrl-C within half a second exits; Ctrl-D exits with an empty editor, and Ctrl-O expands tool output.
Shift-Enter or backslash-Enter adds a newline.
Alt+S toggles what a message sent to a busy conversation, the root or a worker, does: follow-up (the default) waits for the current reply to finish; steer joins it after its current tool round. Steer mode turns the editor border yellow, and the footer names the mode; otherwise the border takes the shown conversation's thinking-level color, as in Pi.
The footer is Pi's: the directory and shown conversation with the input mode, then token totals of the active context, context fill against the model's window (yellow past 70%, red past 90%, `?` until a reply measures it, `(auto)` with auto-compaction), and the model with its thinking level. While a worker is shown, the root's context stays beside the worker's. Narrow terminals drop the totals first.
Inside Herdr (`HERDR_ENV=1`), Monchu reports itself in its pane as agent `monchu`: working while the root or any worker runs, blocked during `/login`, idle otherwise; Herdr shows `done` until the pane is seen. It hands the pane back on exit.
The dock lists queued input by sender: yours behind a yellow `you · <mode>` rule, a worker's reply behind a purple rule and an update behind a gray one, as in the transcript.
`/model [search]` and `/thinking` first ask what to change: the conversation shown (listed first), the root or any worker, the `front` default, or the `worker` default. Then they open Pi's model and thinking-level selectors for it. The current model is listed first and the role default second, from providers with credentials. Picking a role default saves it to `config.json` on Enter, with no worker needed: new workers start with the worker default, and the root follows the front default in the fields not picked for it.
Enter changes only that conversation, from its next model request; `config.json` is untouched, and the notice says `this conversation only`. A root pick is stored with the root, separately for the model and the thinking level, so startup, `/reload` and `/new` keep it instead of the `front` default; edits to `front` in `config.json` apply only to the field not picked. To make the root follow `front` again, pick the value you want and press Ctrl+S: that saves it as the default and clears the root's pick for that field. Workers never re-read their default after they start.
Ctrl+S also saves the pick as its role's default (`front` for the root, `worker` for workers), which clears the root's pick; new workers use the saved worker default at once, and existing workers keep theirs. It refuses, changing nothing, a role whose default model doesn't support the saved thinking level (the picker lists the shown conversation's levels, which may be another model's). Saves and `/reload` never overlap.
Alt+Q (or `/queue`) lists the shown conversation's queue, root or worker, in the editor's place. Enter opens a queued message in the editor, Enter there saves it in place and Esc cancels, keeping your draft aside meanwhile; a worker report opens only its body, and an effort assessment is not editable. Alt+S toggles the selected message between steer and follow-up, and Delete removes it. Edits keep the message's place in the queue. A deleted worker report is dropped rather than posted again; deleting a message sent to a worker reports `failed · deleted` to the front. An edit that arrives after the message left the queue stays in the editor.
`/login` opens private provider selection even on a fresh home without model credentials. Codex always uses device-code OAuth: open the displayed URL on any browser and approve its code, with no local callback server. Cloudflare uses API-key and account-ID prompts. Esc/Ctrl-C cancels. Prompts, codes and keys stay outside chat/editor history and logs; keys are masked. Only completion/cancellation or a credential-free failure notice goes into the TUI transcript.
`/reload` re-reads config, extensions and home/bundled skills, showing the reloaded modules or an error in the TUI. Model roles and stream options apply from subsequent model-request boundaries; already prepared requests keep those values. Retry/compaction policy resolves at later scheduler boundaries, following Durable's runtime contract. TUI settings refresh on success; already running shell calls keep their environment. Home-file edits need no reload.
`/restart` is Jorge's explicit restart approval, even while a worker is shown. It stops input/rendering, disposes view attachments, and restores the terminal before the backend closes storage/resources and re-executes Monchu. Model output and `request_restart` cannot execute this command.

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the same installed tools: read, write, edit, bash, `fffind`, `ffgrep`, `jj`, `jj_write`, `herdr`, worker management, and `codemode`. File/shell tools come from Durable, including optional `powershell`. The search tools port @ff-labs/pi-fff 0.11.0's tool logic (MIT) on @ff-labs/fff-node 0.11.0: git-aware fuzzy/glob path search and smart-case content search, with filters, context, fuzzy fallback, and pagination. Native indexes follow each conversation's execution directory and support paths outside it; Monchu owns and closes their handles across reloads. fff ships android-arm64, so searches are not skipped on Termux. Tool selection comes from `config.json` settings; `grep`, `find`, and `ls` are no longer built-ins.
`codemode` runs model-written JavaScript in Pi's QuickJS sandbox; scripts call the other tools as `await tools.<name>(args)`, and `store()`/`load()` values persist per conversation.
Nested calls run inside the one codemode tool call, so a crash does not replay the script.
`jj` (replay-safe reads: status, log, diff, show, file contents, bookmarks, operation log) and `jj_write` (describe, commit, new, bookmark set/move, git fetch/push; never replayed) take a required absolute `cwd` and return structured JSON. Bookmark writes need an explicit revision and refuse an empty, undescribed target unless allowed. `herdr` launches, prompts, reads, and retires Herdr agents locally (when Monchu runs inside Herdr) or in a named session over SSH; it is never replayed and reports which mutations are uncertain. Both port the user's Pi tools.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

The root conversation keeps ongoing endeavors and Monchu's own commitments in the `monchu.goals` document (version 2).
A goal is an ongoing project or workstream, never a single request.
Each goal has an id, kind (`endeavor` or `commitment`), title, status (`active`, `waiting`, `done`, `dropped`), optional project (directory or repository) and vault note (for example `projects/monchu`), current workstream, next step, linked worker names, and an update time.
When a request touches a project, update its existing goal's workstream, next step, and workers.
The front keeps them current with `update_goal` (create, or patch one goal by id) and reads them with `list_goals`. Workers have both tools too: they inherit the root's extension selection when created. Each conversation's goal tools and section use that conversation's own document, so a worker's goals are not the root's.
Active and waiting goals render as the `goals` prompt section in stored order; Durable resends a section only when its text changes.
Open goals are always kept; done and dropped goals are kept for the 20 most recently changed.
`/goals` lists open goals one row each, with a colored status and age; Enter opens the goal (next, now, linked workers with live status, project, vault), Esc goes back, Tab adds the recently closed goals.
The document is not transcript, so `/new`, compaction, and restarts keep it, and the section returns in the next request.
`/compact` always asks the summary to keep open goal ids, kinds, titles, project/vault links, workstreams, next steps, and workers, ahead of any focus you add.
Durable's automatic compaction takes no instructions; its summary may drop goal history, but the section still restores the open goals.

The `memory` tool, available to the root and workers alike, edits entries in `memories/USER.md` (about the user) and `memories/MEMORY.md` (Monchu's notes) under the explicit Monchu home, regardless of execution cwd.
Use `add`, or `replace`/`remove` with a unique substring match; exact duplicate adds do nothing.
Entries are separated by a line containing only `§`; each file is limited to 4000 characters including separators and newlines.
The tool reports usage, rejects overflow without writing, and replaces files atomically. It makes no source-control calls.

`/abort` (or interactive Esc while it runs) stops the front only.
`/stop` explicitly cancels a worker, its pending deliveries, and nested work, and withdraws its reports and updates still queued for the front; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
It then stops running tool processes, closes provider connections pi-ai keeps cached (Codex websockets), and exits; if anything else still holds the process, it exits after one second anyway.
Unfinished work resumes when the backend opens, whether or not a terminal is attached; the terminal starts from a snapshot.
A worker's result reaches the parent as a labelled follow-up input, so the front gets a turn: it tells Jorge in a line or two and continues with the next step.
While the front is busy, the report queues until its current answer, then starts one turn; it never lands between a tool call and its result.
Workers can call `post_update` for progress worth hearing before they finish; it reaches the parent the same way, and a newer update withdraws one still queued (at most one queued update per worker).
`/abort` withdraws queued input: your messages return to the editor, a withdrawn report is posted again, a withdrawn update is dropped.
Non-fatal runtime failures appear as `system · warning` and are appended to `~/.monchu/monchu.log`.
Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## Offline TUI smoke mode

Start the real source entry point in an interactive terminal with scripted faux models:

```nu
mise run smoke
```

This explicit dev mode creates a fresh `monchu-smoke-*` home in the OS temp directory, including isolated Monchu config/auth/skills; it never opens `~/.monchu` or uses live providers.
Normal startup is unchanged.
The inherited `MONCHU_DEV_HOME` preserves that temporary home through `/restart`; paths outside the temp directory are rejected.
The home is printed at startup and kept for inspection; delete it after exiting.

Smoke steps: send `hello`, then `read` (a real read tool call on a missing file), then `/work reader inspect`.
Expect a streaming faux reply, a tool error, labelled worker progress/result lines, and the front's acknowledgement.
Use `/agents`, Down to `reader`, Enter, and send `more`; `/agents root` returns to the front.
Run `/reload` and expect `reloaded · context, ...`.
Run `/restart`: the app re-executes in the same terminal, restores the conversation and workers, and accepts another message.
Finish with `/quit` and check the shell's exit code is 0.
This checks lifecycle/rendering with deterministic models, not live models or Android/Termux.

## Self reload

`reload_extensions` is available to all roles, as is Jorge's `/reload` command. The backend exposes `reload()` and `restart()`; only Jorge's `/restart` command calls the latter after restoring the terminal.

Reload reads the running checkout, never a conversation's cwd or another jj workspace. Source mode imports edited `.ts` modules through Node's type stripping; compiled mode builds that checkout first by spawning the installed `typescript/bin/tsc` with the running Node executable and `-p tsconfig.build.json`, without a shell, npm, or mise. Each module in the manifest (`Reloadable` in `src/reload.ts`) is imported with a fresh query string. Static imports remain cached, so dependency and host changes require a restart.

Config and all modules are prepared, and the complete registry and installation order validated before applying anything. A build/import/config/validation error leaves installed code, model roles and settings unchanged. Running calls finish on old code; later phases/calls/requests use the replacements. Reload also refreshes the skill metadata snapshot; existing tool environments remain alive. Doc kinds and task names/versions preserve existing state and pending tasks; schema/checkpoint changes still require explicit versioning and migration.

`request_restart({ reason })` only records a durable request on the root and advertises it as a section. It never restarts. Jorge's backend `restart()` approval clears the request, pauses accepted work, closes the Harness/storage and tool/provider resources, re-executes the same Node entry/arguments with inherited stdio, and exits with the child. There is no daemon, supervisor, or agent restart tool.

`skills/monchu/SKILL.md` is read from this checkout in place, without a startup copy. It tells Monchu to edit source in a jj workspace, check and build it, apply authorized changes to the running checkout, and reload; host changes need the user's restart approval.

## Backend boundary

- `src/backend.ts`: store ownership, admission, observation, worker controls, and execution directories.
- `src/models/`: Monchu credential store, pi-ai provider modules/catalogs, private login flows, and configured model roles.
- `src/config.ts`: validated host config: model roles, classifier overrides, and the resolved Monchu settings type/defaults.
- `src/home.ts`: home resolution before SDK imports, including isolated smoke homes.
- `src/workers.ts`: durable worker ownership/delivery state machines, worker lookup/stop/pending checks, and model tools.
- `src/goals.ts`: the root's goals document, `update_goal`/`list_goals`, and the `goals` section.
- `src/memory.ts`: bounded, atomic home-memory edits for every role.
- `src/codemode.ts`: the `codemode` tool over `@earendil-works/pi-codemode` and its per-conversation store.
- `src/classifier.ts`: non-blocking Clef Flash effort/scope assessment as a background Durable task per front input, advice for later requests, and the escalation follow-up. It never grants permission.
- `src/context.ts`: home/bundled skill metadata as a prompt section, the config-backed in-memory settings snapshot, and Durable run policy.
- `src/reload.ts`: the extension registry, the reloadable-module manifest, validated in-process replacement, once-only missing-file warnings, the reload tool, and durable restart requests.
- `src/identity.ts`: per-request home-file and device sections, and the front's instructions.
- `src/pi-tools.ts`: built-in selection and shell configuration inside Durable tool invocations.
- `src/jj.ts`: the `jj` and `jj_write` tools over the jj CLI.
- `src/herdr.ts`: the `herdr` tool over the local Herdr CLI or SSH.
- `src/herdr-agent.ts`: Monchu's own agent state in its Herdr pane, over Herdr's socket API.
- `src/fff.ts`: Pi-fff tool logic, native search indexes, pagination, and Monchu-local search databases.
- `src/tui/app.ts`: terminal lifecycle, command dispatch, and read-only view attachments.
- `src/skills/`: Pi-derived skill discovery, YAML front matter, diagnostics, and prompt formatting for explicit home/bundled paths only.
- `src/tui/`: the command table and input parsing, Durable presentation mapping, copied themes/message components/tool renderers, and Pi-style viewport rendering.
- `src/main.ts`: lifecycle wiring.

The backend imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
The TUI uses the read-only `viewState(workerName?)` attachment and disposes it on exit; input still goes through backend methods.
This slice has no HTTP server, daemon transport, phone UI, scheduling, or memory retrieval backend.

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

A home written before the 2026-10 refactor or with version-1 goals needs a fresh `monchu.sqlite`; there is no compatibility code for older stored data.

## Checks

```nu
mise run check   # typecheck, type-aware lint, format check, knip, tests
mise run build
```

- `mise run install`: `npm ci`, skipped when the locked dependencies are current.
- `mise run typecheck`: `tsc` over `src`, `test`, and `vitest.config.ts` (`tsconfig.json`); `mise run build` runs `node node_modules/typescript/bin/tsc -p tsconfig.build.json` to emit `src` only, skipped when current.
- `mise run fmt`: format with oxfmt; `mise run check` checks formatting without rewriting.
- `mise run lint`: oxlint with type information. It rejects `any` leaks, casts and non-null assertions, TypeScript suppression comments, values that would print as `[object Object]`, import cycles, any import of `src/tui` outside `src/main.ts` and the TUI itself, and `vi` in tests.
- `mise run check` also runs knip for unused files, exports, and dependencies. The reload manifest imports its modules through computed URLs, so the exports it reads are tagged `@public`.
- `mise run test`: vitest against real Durable Harnesses on SQLite, with Pi's faux chat provider and a scripted classifier provider registered in real pi-ai `Models`, following Pi Durable's own tests. `vitest.config.ts` points `HOME` and `USERPROFILE` at a temp sandbox, and each test's `setup()` narrows them to its own directory, so no test reads or writes `~/.monchu`, `~/.pi`, or `~/.agents`.
  TUI tests use a Pi-derived `VirtualTerminal` backed by `@xterm/headless` to check the visible screen at 40/60 columns in light/dark.
  Tests do not prove live provider behavior or the interactive phone flow.

Durable is experimental.
The npm lockfile pins the Pi/Durable version; inspect the installed declarations before adapting it.
Local Pi source is at `~/proj/pi`.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
