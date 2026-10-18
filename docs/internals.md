# Monchu internals

How Monchu works under the hood. [Setup](setup.md) covers the first run and configuration.

## Configuration details

`front` and `worker` left out of `config.json` follow the first chat provider with credentials (Codex, then Claude Code; Codex when neither has), and a `/login` reloads to apply them. A role naming an unknown provider/model never stops Monchu: startup uses that default and `/reload` keeps the running role, both with a warning naming the valid providers or models. `config.json` never keeps Monchu from opening: at startup an invalid field keeps its default and the rest of the file applies, and a file that isn't JSON means the defaults, each with a warning; `/reload` rejects an invalid field and keeps what is running. A key this version doesn't know (another version's, a moved setting, a typo) is ignored with a warning, at startup and on reload alike. `plugins.<name>` holds each plugin's shared settings and `plugins.local.json`'s `settings.<name>` this device's (see [plugins](plugins.md#settings)). The bundled Clef plugin reads `plugins.clef`: its classifier (`{ "provider", "modelId", "waitMs"? }`, default Cloudflare Workers AI's Clef), or `null` to turn it off. It runs only while that provider has credentials, checked on each message. An old top-level `classifier` is read as `plugins.clef`, with a warning to move it.
The front role is applied at startup and on `/reload`, from its next model request, except for a model or thinking level picked for the root with `/model` or `/thinking`; new workers use the current worker role. Existing workers keep their stored role.

`settings` is validated by Monchu, not a Pi settings-file pass-through. Omitted fields use Monchu's defaults (see [Setup](setup.md#configuration)).
It also accepts `shellPath`, `shellCommandPrefix`, `steeringMode` and `followUpMode` (`all` or `one-at-a-time`), and `retry.provider` (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`). Provider retry-delay defaults to 60000 ms; timeout defaults to `httpIdleTimeoutMs` (0 disables the idle timeout).
Themes are built-in `light`, `dark`, `system`, or a `light/dark` pair. Shell path/prefix are unset by default.
`defaultTools` accepts exact built-in names, or only `+name`/`-name` modifiers. Monchu's own tools are separate from this selection.
`terminal` accepts `hyperlinks` and `trueColor` (boolean or `auto`), and `images` (`false`, `auto`, `kitty`, `iterm2`); omitted values use SDK capability detection.
One settings snapshot feeds Durable run policy, tool selection/shells, and the TUI. No Pi `settings.json` is loaded or written.

## Claude Code bridge

`claude.executable` accepts a Claude Code executable/wrapper path; relative paths are resolved under the Monchu home. If omitted, Monchu resolves `claude` on PATH.
It always passes the resolved path as the Agent SDK's `pathToClaudeCodeExecutable`, never using the SDK's platform-package lookup. Missing/startup errors name the attempted path. Windows paths must be directly launchable, not shell-only command shims.
Changes to `claude` host settings require `/restart`; a reload rejects them without applying a partial settings snapshot.

Claude Code uses `<home>/claude` as `CLAUDE_CONFIG_DIR`, an isolated execution directory, no setting sources, no hooks/plugins/skills, no native tools, and only Monchu's MCP bridge, with Durable owning tool execution.
The child environment is copied, stripping inherited `ANTHROPIC_*` and `CLAUDE_*` values before installing Monchu's token and isolation settings. Provider switches, fast mode, cloud MCP and automatic compaction are disabled.
Session/query behavior follows pi-claude-bridge 0.9.2: each Durable conversation's stable provider `sessionId` owns its Claude session and live query, independently of concurrent front/worker conversations.
A new user turn resumes that persisted session without rebuilding its history when the cursor matches, including an assistant already written by Claude. Missed or rewritten history is rebuilt from Durable via `cc-session-io`; a shorter synthetic context starts clean without replacing the conversation's mirror. Compaction summaries use an isolated, non-persisted query.
The system prompt is the transcript's first system message, which Durable only replaces at compaction or reset (Claude Code records a session's prompt once and replays it on resume); every later prompt change is folded into the next input as a `<system-reminder>`.
Each clean turn end records a checkpoint in `<home>/claude/checkpoints`: the session file's length and the hashed history it holds. When a session must be rebuilt (restart, abort, error, a discarded parked query) and Durable's history still starts with the checkpoint's, the session file is cut back to that length and only the history since is appended, so Claude Code's own records, and their cached request bytes, survive; otherwise it is rebuilt in full.
One SDK query stays parked across the whole turn's tool rounds. MCP handlers never execute tools or invent results: Durable commits the calls and runs every tool, then its next provider request delivers the real results to the parked handlers by `claudecode/toolUseId`, even when calls/results arrive out of order. No synthetic user prompt is added between live tool rounds. A steer is written before releasing results.
The final SDK result closes the input/query. Abort and explicit worker cancellation close/kill owned queries and invalidate their mirrors; the next request restores from the checkpoint, or rebuilds with a rotated UUID to avoid an orphan writer. Restart or a discarded parked query restores or rebuilds from Durable's current transcript; only a tool-result continuation without a live query uses the bridge's continuation prompt. Internal retry/fallback/compaction events and unsupported content fail explicitly rather than returning an empty final answer. Durable retains its own configured retry policy.

**Android (Termux):** the Agent SDK has no Android binary package, but this provider does not need one: point `claude.executable` (or PATH) at a working `claude` launcher such as a glibc-runner wrapper.
See [the SDK lookup issue](https://github.com/anthropics/claude-code/issues/50270), [pybe's wrapper](https://github.com/pybe/claude-code-termux), and [d3ffen's workaround](https://github.com/d3ffen/claude-code-termux).

## Context, skills, and the home

Every model request rereads the home files. `AGENTS.md` is the shared manual every agent gets, with `DEVICES.md`, `memories/USER.md`, and `memories/MEMORY.md`; only the front also reads `SOUL.md` and its front-only manual `FRONT.md`. Workers also get the context files of their execution directory and its ancestors like Pi: in each directory the first of `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`, outermost first, skipping the home `AGENTS.md`. Claude Code workers receive the same sections through the bridge's system prompt; Claude Code's own `CLAUDE.md` loading stays off. Each file is labelled with its editable path; missing files are skipped with one warning per path for the runtime's lifetime, including reloads. All roles receive device facts (hostname, OS/release, user, user home, Monchu home, execution directory).

Each home file has a character budget (SOUL 3000, AGENTS 10000, FRONT 12000, DEVICES 6000, USER and MEMORY 4000 each, 36000 in total). Nothing is truncated: a file over budget still loads in full. Every render measures them, and when a budget rises to near (90%) or full (at or over), the front gets one follow-up input (`system · ...`) naming it, its size and what is left, and a warning is logged. The level told is kept in the root's `monchu.home-budget` document, so a crossing is told once across restarts; a budget that falls back under 90% re-arms. The memory tool refuses to grow USER or MEMORY past 4000 characters; no other edit is stopped.

Skills load in place at startup and on reload from `<home>/skills`, the loaded plugins' `skills/` folders and this checkout's bundled `skills/`, in that order, the first of a name winning. Only metadata is advertised; bodies are read on demand. Pi instructions, skills, packages, and cwd/ancestor resources are not loaded; no skills are copied.

Home paths owned by Monchu (all relative to `<home>`: `MONCHU_HOME`, default `~/.monchu`). A missing home, or missing starter files, are seeded from `home-template/` at startup without overwriting anything; a brand-new home also gets `jj git init` when jj is installed.

- `config.json`: optional model roles and validated run settings; no secrets. Only Ctrl+S in `/model` or `/thinking` writes it: the whole result passes the startup validator, then replaces the file atomically.
- `auth.json`: Monchu-owned credential storage, including OAuth refresh tokens and Cloudflare keys/account IDs. Locked read-modify-write operations publish atomically with mode 0600 (Windows uses its filesystem ACLs).
- `fff/`: frecency and query-history databases for native file/content search; no Pi or editor databases are reused.
- `claude/`: isolated Claude Code config/execution directory and persisted Claude session mirrors; not the durable conversation store.
- `monchu.sqlite`, `owner.sqlite` and their SQLite sidecars: runtime state and the ownership lock.
- `logs/`: the structured log, one JSON Lines file per day (`monchu-<date>.jsonl`, rolled at 10 MB, kept 14 days), in the OpenTelemetry log data model: `time`, `severity`, `scope` (`core…`, `server…`, `tui`, `web`), `body` and `attributes`. It holds warnings, the core's open phases, reload and close times, one record per model reply (model, tokens, time, stop reason), client attaches, and clients' own timings such as the terminal's `ready`; ids, sizes and timings only, never prompts, outputs or secrets. `/logs [severity|scope]` shows the newest; in Nushell, `open --raw <file> | from json --objects | where severity == warn`.
- `run/`: the core's local socket.
- `attachments/`: files the user attached to messages, one folder per upload; kept until removed by hand.
- `web.json`: this device's web server settings (see [Web](#web)).
- `web-client.json`: this device's web client settings, such as the installed app's name (`/client`).
- `web-sessions.json`: web sign-in sessions, by token hash.
- `secrets/`: secrets the user gave Monchu on this device (see [Secrets](#secrets)): fnox's config, its age key and the names index.
- `plugins/` (synced), `plugins/local/` (this device) and `plugins.local.json` (this device's deny list): plugins, see [plugins.md](plugins.md).
- Home context files, `memories/`, `skills/`, and `souls/`: editable human/agent content, separate from runtime state.

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
Clef, the bundled `clef` plugin (`src/plugins/clef/`), assesses each message to a front beside that reply: whether it needs a worker, whose line of context it continues, whether it holds several lines of work. Its answer shows as `clef · …` and joins the front's transcript as the `clef_advice` prompt section, once, where it first applies: the front's first request for a message waits up to 2.5 s for it, and an answer that comes later joins at the next request. A section, not a per-request message, so every later request extends the same prefix (on the Claude Code bridge, the parked query keeps running).
When Clef is sure (75%+) a worker is needed and the front works itself, one tool result carries a nudge; when the front finishes without routing, one follow-up input (a system notice, `routing advice (Clef): …`) asks it to.
Assessments follow the queue: editing a queued message assesses the new text instead, and a message withdrawn by Esc or deleted from `/queue` neither advises nor escalates.
Thinking content stays hidden; the terminal shows an indicator when the provider emits thinking events.
Pi TUI's editor and scrolling viewport provide the terminal UI. Monchu owns its Pi-derived message components, built-in themes, and renderer-only tool cards; rendering never loads coding-agent tool definitions or reads live files to preview edits.
The status indicator shows working, thinking, tool execution, compaction, and retry activity.
The TUI follows terminal light/dark reports with its copied built-in themes.

`/help` lists the commands; `src/ui/commands.ts` defines them.

`/agents` opens a live panel of the root and every worker: status (working, or idle with how long ago it last did something), context fill, and directory where it fits.
Selecting a worker shows its conversation; plain messages go to that worker through the existing worker-delivery path.
The root is shown by default; `/agents root` returns to it.
Plain messages, `/model`, `/thinking`, `/stop` and `/cd` go to the conversation shown; `/new` and `/compact` always target the shown root's front. The editor's typeahead lists every command with its help, then each home or bundled skill as `/skill:<name>`, which sends that skill's instructions with your text, as Pi does.
`/reload` applies config, skill and extension edits in process: running work keeps going. `/restart` replaces the core process for changes to its own code: accepted work pauses and resumes after, so a step in flight (a model request or a running tool) is cut and runs again or is reported interrupted.
Esc interrupts a running front only and does nothing while it is idle; your own messages still queued for the front come back into the editor, oldest first, ahead of anything typed. Ctrl-C clears the editor and a second Ctrl-C within half a second exits; Ctrl-D exits with an empty editor, and Ctrl-O expands tool output. Tools without their own renderer (goals, memory, workers, jj, herdr, codemode, search) collapse to a `▸` header row and a one-row result summary with its line count; Ctrl-O or a click shows every argument and the whole output. A sign-in URL in `/login` shows unpadded on rows of its own and opens in the browser by itself, as in Pi, except over SSH or without a screen to open on (a device code page waits for you to read the code); a tap or Alt+O opens it in the browser (`termux-open-url`, `open`, `xdg-open` or Windows' URL handler, never a shell) and Ctrl+X copies it exactly (the platform clipboard command, else OSC 52). A tap on any link in a reply opens it too.
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
`/reload` re-reads config, extensions and home/bundled skills, showing the reloaded facets or an error in the TUI. Model roles and stream options apply from subsequent model-request boundaries; already prepared requests keep those values. Retry/compaction policy resolves at later scheduler boundaries, following Durable's runtime contract. TUI settings refresh on success; already running shell calls keep their environment. Home-file edits need no reload.
`/restart` is your explicit restart approval, even while a worker is shown. The terminal stays: the server replaces the core, and the terminal picks its views up again from the new one. Model output and `request_restart` cannot execute this command.

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the same installed tools: read, write, edit, bash, `fffind`, `ffgrep`, `jj`, `jj_write`, `herdr`, worker management, and `codemode`. File/shell tools come from Durable, including optional `powershell`. The search tools port @ff-labs/pi-fff 0.11.0's tool logic (MIT) on @ff-labs/fff-node 0.11.0: git-aware fuzzy/glob path search and smart-case content search, with filters, context, fuzzy fallback, and pagination. Native indexes follow each conversation's execution directory and support paths outside it; Monchu owns and closes their handles across reloads. fff ships android-arm64, so searches are not skipped on Termux. Tool selection comes from `config.json` settings; `grep`, `find`, and `ls` are no longer built-ins.
`read` returns images (PNG, JPEG, GIF, WebP, BMP) as image blocks, oriented and shrunk to the conversation model's limits by Durable's Photon processor in a worker thread that exits when idle. A conversation holds at most 20 MB of image base64 (Anthropic rejects requests over 32 MB, and tool results stay for good): past that, a tool result's images are refused with an error that says so, and its text is kept. The count comes from each request's context, so images compaction dropped stop counting.

The user attaches files to a message: in the terminal by Ctrl+V (Alt+V on Windows: copied files or an image, through Pi's native clipboard helper or `wl-paste`), by pasting an image's path (as dropping a file on a terminal does), or by `/attach <path>`; in the web by the attach button, paste or drop. A client uploads each file through `RootClient.attach`; remotely that is the `upload` method in 1 MB chunks, under the socket's 4 MB message limit. The core stores it as `attachments/<upload>/<name>` in the home (gitignored, per device). A message names its attachments by path in an `<attachments>` note, so the front can read them or hand a path to a worker. Images the front's model can take (PNG, JPEG, GIF, WebP, BMP) go inline after the note, prepared like `read`'s, and the whole message is refused when they would take the conversation past its 20 MB image budget. pi-ai content has no document blocks, so PDFs and other files go by path only. A message to a worker carries the note alone.
`codemode` runs model-written JavaScript in Pi's QuickJS sandbox; scripts call the other tools as `await tools.<name>(args)`, and `store()`/`load()` values persist per conversation.
Nested calls run inside the one codemode tool call, so a crash does not replay the script.
`jj` and `jj_write` are the bundled `jj` plugin (`src/plugins/jj/`), offered directly in every conversation. `jj` (replay-safe reads: status, log, diff, show, file contents, bookmarks, operation log) and `jj_write` (describe, commit, new, bookmark set/move, git fetch/push; never replayed) take a required absolute `cwd` and return structured JSON. Bookmark writes need an explicit revision and refuse an empty, undescribed target unless allowed. `herdr` launches, prompts, reads, and retires Herdr agents locally (when Monchu runs inside Herdr) or in a named session over SSH; it is never replayed and reports which mutations are uncertain. Both port the user's Pi tools.
A worker starts with a fresh transcript and an explicit goal/context bundle, not the entire front history.

The root conversation keeps ongoing endeavors and Monchu's own commitments in the `monchu.goals` document (version 2).
A goal is an ongoing project or workstream, never a single request.
Each goal has an id, kind (`endeavor` or `commitment`), title, status (`active`, `waiting`, `done`, `dropped`), optional project (directory or repository) and vault note (for example `projects/monchu`), current workstream, next step, linked worker names, and an update time.
When a request touches a project, update its existing goal's workstream, next step, and workers.
The front keeps them current with `update_goal` (create, or patch one goal by id) and reads them with `list_goals`. Workers have both tools too: they inherit the root's extension selection when created. Each conversation's goal tools and section use that conversation's own document, so a worker's goals are not the root's.
Active and waiting goals render as the `goals` prompt section in stored order; Durable resends a section only when its text changes.
Open goals are always kept; done and dropped goals are kept for the 20 most recently changed.
`/goals` lists open goals one row each, with a colored status and age, a `•` on goals changed since you last opened them, and waiting goals in yellow with `wait`; Enter opens the goal itself (now, then next), Esc goes back, Tab adds the recently closed goals.
The document is not transcript, so `/new`, compaction, and restarts keep it, and the section returns in the next request.
`/compact` always asks the summary to keep open goal ids, kinds, titles, project/vault links, workstreams, next steps, and workers, ahead of any focus you add.
Durable's automatic compaction takes no instructions; its summary may drop goal history, but the section still restores the open goals.

Background jobs run inside Monchu while it is open; there is no daemon, so nothing runs while it is closed. Every role has one `job` tool (create, list, pause, resume, run now, output, kill, delete), and `/jobs` lists every job and the recent job events. A job has one of three types:

- `agent`: on a cron schedule, wake a worker with the job's prompt.
- `command`: on a cron schedule, run a read-only shell command with no model call. The first run, at once, takes a baseline; after that the worker is woken only when the output changes or the command fails anew. Output is capped at 8000 characters and each run at 300 seconds.
- `bg`: run a command once in the background now, tmux-like, while its creator keeps working. When it ends, its worker gets one message with the exit code, duration, output tail (8000 characters) and the full log path (`<home>/jobs/<name>-<created>/output.log`). `output` reads the log while it runs, and `kill` or an optional `timeout` in minutes stops it. Delete kills a running command and removes its log; finished `bg` jobs and their logs are pruned a week after they end.
  Cron is five fields (or `@hourly`, `@daily`, `@weekly`, `@monthly`) in the device's local time. A slot removed by a DST gap is skipped, and one repeated by a fall-back runs once. A slot missed while Monchu was closed runs once at startup, then the schedule continues from now.
  The worker a job wakes is named by `worker`; it defaults to the creating worker, or a new `job-<name>` when the front creates it. A worker that doesn't exist when the job fires is started under the root, on the job's `profile`, or `model` and `thinking`, if given. A worker keeps its model and thinking level for life (its prompt cache), so creating a job for an existing worker with a model choice is an error. Job deliveries are quiet: the worker's answer reaches its parent only when it starts with `NEEDS USER`, while failures are always reported.
  Jobs live in the store-wide `monchu.jobs` session document, so the front, every worker and every client see the same list whoever created them. Each job is one background runner task on the root conversation, so stopping a worker never stops its jobs: `monchu.job` for `agent` and `command`, `monchu.job-bg` for `bg`. A schedule runner sleeps until its slot, and also wakes on a pause, a delete or a run-now. A pause or delete ends the runner; a resume starts a new one, and a runner whose task id is no longer the job's stops itself.
  Runs are replay-safe. A `command` runs in its own phase, and a crash there reruns it. What a run changes (the cursor, its event, and the worker delivery it starts) commits atomically with the runner's next checkpoint, under request id `job:<name>:<created>:<slot>`, so a restart never wakes anyone twice for one slot or change. A `bg` command runs as Durable runs a tool: inside its runner's invocation, so quitting or restarting Monchu kills it with its process group, and it is never started again. A durable `launched` memo marks the start, so the replay after a restart reports the command `interrupted`, with the output it wrote. The end, its event (`exited`, `killed`, `interrupted`, or `failed` when it could not start) and the ping commit together under `job:<name>:<created>:end`, so the worker hears once. A create replayed after its commit returns the job it made.
  Delivery to people is a stream of events with growing ids (`created`, `fired`, `changed`, `failed`, `paused`, `resumed`, `deleted`, `started`, `exited`, `killed`, `interrupted`; the newest 200 are kept). `Monchu.watchJobEvents(after, listener)` gives any client the events after the last id it saw. The TUI is the only client today; it shows new events as `job · <name> · <kind> · <text>` notices.

The `memory` tool, available to the root and workers alike, edits entries in `memories/USER.md` (about the user) and `memories/MEMORY.md` (Monchu's notes) under the explicit Monchu home, regardless of execution cwd.
Use `add`, or `replace`/`remove` with a unique substring match; exact duplicate adds do nothing.
Entries are separated by a line containing only `§`; each file is limited to 4000 characters including separators and newlines.
The tool reports usage, rejects overflow without writing, and replaces files atomically. It makes no source-control calls.

`/stop` on the root (or interactive Esc while it runs) stops the front only.
`/stop <name>`, or `/stop` while a worker is shown, explicitly cancels a worker, its pending deliveries, and nested work, and withdraws its reports and updates still queued for the front; its conversation remains reusable.
`/quit` or SIGTERM closes storage without cancelling accepted work.
It then stops running tool processes, closes provider connections pi-ai keeps cached (Codex websockets), and exits; if anything else still holds the process, it exits after one second anyway.
Unfinished work resumes when the backend opens, whether or not a terminal is attached; the terminal starts from a snapshot.
A worker's result reaches the parent as a labelled follow-up input, so the front gets a turn: it tells you in a line or two and continues with the next step.
While the front is busy, the report queues until its current answer, then starts one turn; it never lands between a tool call and its result.
Workers can call `post_update` for progress worth hearing before they finish; it reaches the parent the same way, and a newer update withdraws one still queued (at most one queued update per worker).
Stopping the front withdraws queued input: your messages return to the editor, a withdrawn report is posted again, a withdrawn update is dropped.
Non-fatal runtime failures appear as `system · warning` and are logged under `logs/`.

### Home check

What Monchu loads from its home (`config.json`, `mcp.json`, `plugins.local.json`, `skills/`, `plugins/`) is checked as a build would meet it, so a broken home is seen when it breaks, not at the next start (`src/core/home-check.ts`). The check runs the real loaders, plugins included (imported and run, then retired; the running build's keep going), without installing anything, and only when a fingerprint of those files (sizes and times) changed. What a plugin reports while the check runs it (such as bad settings) is one of the check's problems, never told to clients, and code the check ran never becomes the plugin's last good code. Checks and reloads run one at a time.

- **At open:** problems reach the current root's front as a `system ·` notice.
- **After a tool call** (not a nested one) that changed the home: what it added is measured against the home as that call found it, so a problem that was already there is never blamed on it. When no other call ran beside it, or a problem names the file its `path` wrote, its result gets an `error` diagnostic listing them; any other new problem may be another call's, so the result gets a `warn` one and the front is told. A call that only fixed problems gets an `info` one.
- **At that agent's final answer**, while what it added stays broken, it is sent back once with the list. If it still finishes with the home broken, the front gets a notice naming the worker. A front that broke the home was already told.
- **A change outside any tool call** (another device's sync, an editor) is found at the next tool call anywhere and told to the front; so is the home passing again.
- `/reload` and `reload_extensions` list every warning of the reload in their result.
  Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## Server, core, clients

Each home has one server process and, while anything needs it, one core process. Every terminal and web page is a client of the server; none of them opens the store.

- The server (`src/server/server.ts`) serves `<home>/run/monchu.sock` (0600 in a 0700 directory; a per-home named pipe on Windows) and, with `--web`, the web client. It holds no store: it is a Chord host that relays each client's references to the core through a route that starts the core when one is needed, and serves `monchu.server` (its state, and `stop` for a person). A kernel lock keeps it to one per home.
- The core is the server's child, forked by Chord's host manager (`src/server/process.ts`; on Windows, which has no process groups, a hidden attached fork). It takes the home's kernel lock before it opens the store, so a second core never runs beside it, says it is ready, and closes through Monchu's normal close (Durable's `close`) when the server asks, after which the manager kills anything left after a 15 second grace. It also closes itself when the IPC channel to its server disconnects (the server was killed or crashed), so it never runs on as an orphan. Their link has no ping timeout, since the channel says when either side goes: a phone that froze both processes past Chord's 45 seconds would otherwise close it on waking, leaving a running core no client reaches. A core whose link closed anyway is replaced when a client next needs it (`core link lost` in the log).
- The server supervises its core (`forkedCore`), so nothing in the home can keep Monchu down. A core that fails to start (it throws, exits, or isn't ready within 60 seconds) is started again at once in safe mode, without home plugins (`plugins/`, `plugins/local/`): the only code the home adds. A core that crashes once it ran is started again at once, logged as `core crashed` with the end of its standard error; a second crash within 10 minutes starts it in safe mode, and after five quick crashes in a row only a client that needs it starts it. Safe mode lasts until a person's `/restart`. A core started again hears why (`MONCHU_RECOVERY`), shows it in every client, and tells the current front with a system notice under a request id fixed per failure; Durable resumes the work the last core had accepted. `test/unbreakable.test.ts` runs the real entry point on homes that break the core in each of these ways, and on one where every file Monchu reads is broken.
- A plain `monchu` attaches to the home's server, or starts one detached (`monchu server`, its output in `run/server.log`) and attaches; only a client ever starts a server or a core. A server started this way exits 30 seconds after its last client left, closing the core first, unless it serves the web client: a phone drops a page's socket whenever it puts the page away, and a page can't start a server again. The log records each server's `started` (mode, pid, version, web URL) and `stopping` with its reason (a signal, `idle`, `monchu stop`, a failed update); a server gone without one was killed, and a crash's stack is in `run/server.log`, which each start appends to. `monchu serve` runs the server in the foreground with the core started at once and kept, and stops on SIGINT, SIGTERM or SIGHUP; `monchu stop` asks the home's server to close normally.
- Clients use the same `Client` contract over Chord (`@earendil-works/chord`): a terminal is a Chord client host whose upstream is the server, over a WebSocket on that socket. Views stream as a snapshot, then delta ops of Durable's conversation watch, calls carry the client's request IDs, and a login's prompts reach only the client that started it.
- `/restart` from any client asks the core, which asks the server to replace it: the core closes, a new one opens the store, and every client keeps its socket. Its references to the old core go `gone`; `src/api/lasting.ts` gets each again from the new core, keeping the last value until the fresh snapshot, so views and footers carry on. A client whose own connection drops redials for 30 seconds (two minutes while an update installs). Clients say the connection was lost and reconnected; when the server is gone for good they say so, and `/quit` closes them.

## Web

`monchu --web` or `monchu serve --web` also serves the web client, from the server (a `monchu --web` that attaches to a running server asks it to serve the web client from then on), configured by the home's `web.json`. That file is per device and gitignored, since each device has its own host, port and login client; a `web` section in `config.json` is refused. It listens on `127.0.0.1` only; a tunnel on the same host (such as `cloudflared` behind an identity-aware proxy) publishes it. Any local process could reach that port, so nothing is trusted for being local:

- Every request, and the WebSocket at `/api`, needs an identity on `web.allow`. Without `web.access` or `web.oidc`, or with nobody allowed, the web stays off and says why.
- The `Host` must be `web.host` or this port's localhost (421 otherwise); the WebSocket's and sign-out's `Origin` must be `https://<web.host>` or the local one.
- Responses carry a strict content security policy, `nosniff`, no referrer and no framing.

Identities come from either source:

- `web.access`: an identity-aware proxy signs every request (`Cf-Access-Jwt-Assertion`). The server checks the RS256 signature against `<teamDomain>/cdn-cgi/access/certs`, the issuer, the audience and expiry, and refuses tokens without a key id. A service token's identity is `service:<common_name>`; a user's is `sub:<subjectClaim>` (a dotted path, such as `custom.sub` for the upstream provider's subject) and `email:<email>`. A bad token is refused, never ignored.
- `web.oidc`: the server's own login, OpenID Connect authorization code with PKCE (S256), state and nonce, configured from the issuer's discovery document. The ID token's signature, issuer, audience and nonce are checked; `sub:` and a verified `email:` are the identities. A session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 7 days) follows; `web-sessions.json` (0600, never synced) keeps only token hashes. A client secret, when the provider needs one, comes from the environment variable `clientSecretEnv` names.

```json
{
  "port": 7420,
  "host": "monchu.example.com",
  "access": {
    "teamDomain": "https://<team>.cloudflareaccess.com",
    "audience": "<aud tag>",
    "subjectClaim": "custom.sub"
  },
  "oidc": { "issuer": "https://id.example.com", "clientId": "<client id>" },
  "allow": ["sub:<subject>", "email:<address>", "service:<client id>"]
}
```

URLs must be https, except a provider on this machine. The server serves the built client from `dist/web`, with hashed assets cached for good and the shell and service worker revalidated. The WebSocket carries the same Chord link as the local socket, with the same per-connection objects. It is authenticated at the HTTP upgrade, so a refused page gets a status instead of a dropped socket; only then is its link handed to the core's host.

The client (`src/web`) is Preact with signals, bundled by esbuild into one hashed script and stylesheet (`mise run build` runs `scripts/build-web.ts`; the script fails over 121 KB gzipped, most of it Chord and TypeBox). It is a `Client` like the terminal, over `RemoteClient`, with the same command table, typeahead (commands with their help, then `/skill:<name>`), worker reports and updates with their short ids, tool calls folded to one line (name, arguments, the output's first line) and worker reports to a header and a few lines (a tap, Ctrl-O or the expand key opens them), the agents strip, the queue, Alt+S steer mode, Esc to stop the front, `/login` and `/mcp login` prompts answered in the page (secrets in password fields), `/model` and `/thinking` with Ctrl+S to save a default, `/goals`, `/jobs`, `/logs` and plugins' commands. Committed entries render once and are reused while their Durable record is unchanged; only the live reply re-renders.
A touch keyboard has no Esc, Alt or Ctrl, so every editor key is also a tap: a key bar under the editor (stop or leave an edit, the busy mode, expand, `/`, attach, send or save), queued messages that open in the editor on a tap with buttons to switch their mode or delete them (the terminal's Alt+Q panel, in place), and a ✕ on every picker, prompt and the roots panel, whose rows tap to enter. On a coarse pointer Enter adds a line and send sends; the desktop keys work as before. The root menu sits right of the agent tabs as an icon: a dot per working or unseen root (a hollow one when all are idle) and ▾, with the shown root's name as its label. The status bar holds only what the page shows nowhere else: the working directory, context use (its top border fills as a meter), provider/model, thinking level, and the link to the core as a dot: green while it answers, hollow while it redials (a phone drops the socket whenever the page goes to the background), red with a tap to reload once the redials gave up. Drops and redials never write to the transcript; a terminal still prints them as warnings (`onReport` takes `{ connection: false }` to leave them out).

It is a PWA: a manifest fetched with credentials (so a proxy's cookie reaches it), which the server writes with this device's app name from `web-client.json` and the shell never caches, and a service worker that keeps the shell and hashed assets, while navigation goes to the network first so an expired sign-in reaches the login. After a restart the page probes with a plain request before reopening its WebSocket, since browsers delay a WebSocket to an endpoint that just refused one, then rehydrates. `/client` is the page's own command, never sent to the core: a menu for the app's name (`GET`/`PUT /client.json`; only a person's login may change it, from the page's origin), the install offer and this browser's theme. Chromium's `beforeinstallprompt` is held for a one-line offer over the editor, shown until it's taken or dismissed (remembered per browser), and for the menu's install row, which otherwise says why it can't install. An installed app takes a new name when the browser next checks its manifest, after the person confirms it. It records its ready time, reconnect time, long tasks, update-to-paint latency, typing (each keystroke to the frame after it: p50, p95, max, and the slowest one's split into waiting, handlers and rendering from the browser's event timing) and errors (by kind and place, never their messages) through `Client.record`, every minute and when the page goes to the background.

### Web design

The rules every web surface follows; the tokens live at the top of `src/web/style.css`.

- **Brutalist and compact.** System monospace, black and white with the terminal's status colors, 1 px borders, no radius, no shadows, no motion. The message text (14 px, line height 1.4) sets the rhythm: one type size, with hierarchy from weight and `--muted`, never from extra sizes.
- **Spacing** is the 8 px scale with a 4 px half step: `--s0` 4, `--s1` 8, `--s2` 16. Nothing else.
- **Sizes.** `--row` (one line plus a half step each side) for tabs, menu rows and the status bar; `--tap` (32 px) for the key bar and icon buttons. Both clear WCAG 2.2's 24 px target minimum without growing the page.
- **Show, don't tell.** State is drawn, not explained: a toggle shows the mode it is in, a pressed key is inverted, steer is yellow, a meter fills, a dot marks a working root. Help text and key hints go in `title`s, not on the page, and desktop-only hints hide on a coarse pointer.
- **One icon set:** text glyphs at one size (`.icon`), never emoji. ✕ closes, leaves or removes, › enters, ▾ opens a menu, ■ stops, ↯ steer, ⇢ follow-up, ⊞/⊟ expand and collapse, / commands, + attach, ➤ send, ✓ save, ⚠ warns, ●/○ busy and idle. An icon-only button always has an `aria-label`, and its `title` names its desktop key.
- **Menus:** a header with the title and a ✕, rows that tap anywhere to enter with a › at the end, actions as `--tap` cells with a left border at the header's or row's end: a glyph when one is clear, else a short word.
- **Transcript:** messages, tool calls and notices share the text's left edge and line height; a 3 px left rule marks who spoke (yellow the user, muted a tool, red an error, accent a running tool). Folded things are one line with ▸ and a muted count or summary; boxes are only for worker reports and skills. Replies, reports and skills render as markdown (`src/web/markdown.tsx`, in-house: Preact nodes, never HTML, links only http(s) and mailto) at the text's one size and line height, blocks `--s1` apart, headings bold, code in a 1 px box that scrolls sideways; typed text stays as written unless it has a fence, and tool output and notices stay plain. Arrow keys and Enter still work on a desktop; on a touch screen the keyboard selection isn't drawn.
- **Focus and contrast:** `:focus-visible` draws a 2 px accent outline; text keeps WCAG AA contrast on both schemes, inverted rows included. Buttons in the key bar keep the editor's focus so the on-screen keyboard stays up.
- **Checks:** `mise run web:check` at 412 px and on an emulated touch screen; read its screenshots before calling a visual change done.

## Secrets

Agents use credentials by name and never see their values. Each device keeps its own in `<home>/secrets/` (0700, gitignored): `fnox.toml`, an age identity `age.txt` that Monchu makes on first use (X25519 in Node, so no `age-keygen` is needed), and `index.json`, which holds what may be shown: names, kinds, a login's site, descriptions, and when each was set and last used. Values live in [fnox](https://fnox.jdx.dev), which must be on PATH. Monchu runs it with `FNOX_CONFIG_DIR` set to that folder and its working directory there, so fnox never reads the user's own config, and Monchu's secrets never reach the user's shells. Another provider in `fnox.toml` (1Password, a keychain) works too: Monchu stores with the provider named `monchu`. Values are read with one `fnox export` and kept in the core's memory until the next set or delete.

- Names are environment-variable shaped (`GITHUB_TOKEN`), one namespace per device. A login `NAME` is one entry with two keys, `NAME_USERNAME` and `NAME_PASSWORD`, and an optional site (an origin).
- `secret` (every role, replay-safe): `request {name, reason, kind, site?}` records a request in the store-wide `monchu.secrets` document and returns at once; `list` shows names, kinds, sites, last use and pending requests, never values. Asking adds nothing to the system prompt or the tool list.
- When the user sets or declines it, every conversation that asked gets a system notice as follow-up input: a front directly, a worker as a message from its parent, so its answer is reported as usual.
- `bash` and `powershell`: each stored key a command names (`$NAME` or `${NAME}`; `$env:NAME` in PowerShell) joins that command's environment only, never its text. `agent_browser`: `{{secret:NAME}}` in an argument becomes the value when the command runs; a login with a site is filled only when the session's page is on that origin, and not inside `batch`, which may navigate first. The value then sits in agent-browser's argv while it runs.
- Redaction: every tool result (its text, diagnostics, details and structured output) has each stored value of four characters or more replaced with `[secret KEY]`, and the shells' and the browser's live output is redacted as it streams, holding back text that might start a value until the next chunk. A store that can't be read leaves the output as it is with a warning on the call.
- Each use is audited in the log (`core.secrets`, `secret used`: name, tool, conversation), as are sets and deletes; never a value.
- The user enters values in the web client: a line over the editor per pending request opens a masked form in the editor's place (a value, or a username and password), and `/secrets` lists them with replace and delete. The value goes once, in `Session.setSecret`, which returns nothing; it is not conversation input, so it never enters Durable or a prompt. Only a person's login has `setSecret`, `deleteSecret` and `declineSecret`: a service login's session lacks them, and the core checks again. A malformed entry is refused by its schema without quoting the value. The terminal has no secret form yet.
- The offline smoke home keeps secrets in memory, so `web:check` needs no fnox.

## Offline TUI smoke mode

Start the real source entry point in an interactive terminal with scripted faux models:

```nu
mise run smoke
```

This explicit dev mode creates a fresh `monchu-smoke-*` home in the OS temp directory, including isolated Monchu config/auth/skills; it never opens `~/.monchu` or uses live providers.
Normal startup is unchanged.
The inherited `MONCHU_DEV_HOME` preserves that temporary home through `/restart`; paths outside the temp directory are rejected.
The home is printed at startup and kept for inspection; delete it after exiting.

Smoke steps: send `hello`, then `read` (a real read tool call on a missing file), then `work reader inspect` (the faux front starts a worker).
Expect a streaming faux reply, a tool error, labelled worker progress/result lines, and the front's acknowledgement.
Use `/agents`, Down to `reader`, Enter, and send `more`; `/agents root` returns to the front.
Run `/reload` and expect `reloaded · extensions, session`.
Run `/restart`: the core is replaced, the terminal keeps the conversation and workers on screen, and accepts another message.
Finish with `/quit` and check the shell's exit code is 0.
This checks lifecycle/rendering with deterministic models, not live models or Android/Termux.

## Web check

```nu
mise run web:check -- --baseline <an earlier out dir>
```

`scripts/web-check.ts` builds the web client, starts a loopback OpenID provider that approves every sign-in, and runs `serve --web` from source on a fresh `monchu-smoke-*` home with the faux models, so the server's real login path runs and no auth code is special to it.
It drives journeys in a real browser through `agent-browser` (on PATH, in its own session) at `--viewport` (default 412x915): sign in and reload from the service worker, send a message until the reply settles, a markdown reply drawn while it streams and once settled (every block kind, safe links, raw HTML as text, one size and line height), notices and messages in the order they happened with the view at the end, reading back while a reply streams (the view holds, a pill returns to the end), the editor growing to its cap, `/mod` typeahead into the `/model` picker and out with Esc, start, switch and archive roots, the install offer and `/client` (rename, theme), and on an emulated touch screen (coarse pointer, over the DevTools socket) reach every key by tapping: the key bar, the picker's ✕, and queue edit, mode, delete and stop.
Last, typing: it seeds a few hundred items with the faux `tools <n>` command, slows the CPU 4x over the DevTools socket, and types real keystrokes, idle and while a long reply streams. A probe in the page times each key from its event to the task after the next frame and counts the virtual nodes it rendered (`monchuPerf.vnodes`, kept by `src/web/telemetry.ts`). It gates the medians (50 ms idle, 60 ms streaming) and 60 vnodes a key, an editor's worth: a keystroke that re-renders the transcript fails it. p95 and long tasks are tracked metrics.
Each screen gets an accessibility snapshot, a screenshot and an axe audit; clock times read `hh:mm` and the temp home and port are replaced, so two runs of the same code match.
The out dir (`--out`, default `web-check/`) holds `report.json`, `summary.md`, and `<screen>.snapshot.txt` and `<screen>.png`.
Hard gates (exit 1): the journeys' assertions, no page or console errors, no horizontal overflow, the build's size budget, and with a baseline no a11y violation its screen didn't have.
Metrics (bundle bytes, load, reply and picker times, vitals, the page's own ready times, typing) are compared with the baseline and marked `WORSE` past noise: times by 25% and 50 ms, keystrokes by 50% and 10 ms, bytes by 2%. A baseline also gives each screen its changed snapshot lines and changed pixel percentage. Compare runs from the same machine; fonts and speed differ between devices, and a phone short on memory makes the timings noisy. `--only <journey>` runs the load journey and the ones whose name starts with it.
CI's `web` job runs it on Linux with the newest successful `main` run's `web-check` artifact as the baseline and puts the summary on the run's page.

## Self reload

`reload_extensions` is available to all roles, as is your `/reload` command. The core exposes `reload()` and `restart()`; only your `/restart` command calls the latter, and the core then asks its server for a new core process.

Reload reads the running checkout, never a conversation's cwd or another jj workspace. Source mode imports edited `.ts` modules through Node's type stripping; compiled mode (including a checkout `npm link`ed as the global command) builds that checkout first, when a file under `src/` is newer than `dist/main.js`, by spawning the installed `typescript/bin/tsc` with the running Node executable and `-p tsconfig.build.json`, without a shell, npm, or mise. An installed package (`npm install -g` of a release tarball) ships no sources or `tsconfig.build.json`, so it skips the build and re-imports its fixed modules; only home skills and config change there.

Reload is a Chord hot reload of the core host's facets: `src/core/extensions.ts` (every Durable extension, built by a host-lifetime object) and `src/server/session.ts` (the wire's factories, which build each root's front from their own copy of `front.ts`). Chord's loader imports a fresh copy of each facet module and of every module under a facet's directory that a fresh copy imports: all of `src/core/` that the extensions and the fronts use (tools, agents, skills, config, MCP tools, `front.ts`, attachments), so those edits reload too. The backend (`backend.ts`, `reload.ts`, models, MCP clients and sign-in), `src/api/` and dependencies stay cached and need `/restart`. Under its server the core asks the server to run the reload (`monchu.reloads`), so both move to the next code version together; a core that starts later is brought to the server's code version before anything reaches it. Old module copies are never unloaded, as with any ESM re-import: about 3 MB per reload on the phone, cleared by `/restart`.

The extensions build while the reload prepares (a resource that opens anew for each copy of the module), reading config, skills and MCP listings, and validate against the installed registry; the commit publishes the build through the `monchu.builds` registry and the core installs it into Durable's registry. A build, import (a parse error names its file and line), config, validation or prepare error in any facet leaves the running code, installed definitions, model roles and settings unchanged. Clients keep their sockets and views: their objects take the new factories and keep their cells and resources. Running calls finish on old code; later phases/calls/requests use the replacements. Reload also refreshes the skill metadata snapshot; existing tool environments remain alive. Doc kinds and task names/versions preserve existing state and pending tasks; schema/checkpoint changes still require explicit versioning and migration.

`request_restart({ reason })` only records a durable request on the root and advertises it as a section. It never restarts. Your `/restart` approval clears the request, pauses accepted work, closes the Harness/storage and tool/provider resources, and the server starts a new core. No agent tool restarts anything.

`/update [release]` is the same approval with an install in between, and likewise user-only: no model tool calls `update()`, and a web connection whose identity is a service token (`service:`) is refused. The core first checks the release's tarball answers (a typo never takes Monchu down), marks its release state `updating` so clients wait two minutes instead of 30 seconds, and asks for a restart. The server then stops the core and downloads the tarball once. It installs it into a scratch prefix and starts it there in smoke mode until its core is ready (`bootCheck`, the same check CI runs on every packed build before it publishes one); only a release that starts is installed with `npm install -g --prefix <prefix>`, the prefix derived from the running package's own path, so a broken build never replaces a working one. It then re-executes itself (`src/reexec.ts`) on the installed release; the outcome reaches the new core in `MONCHU_UPDATE_OUTCOME` and every client as a notice. Web pages load the new release by themselves; an attached terminal keeps running the code it started with and says to restart it. The release state also carries the version and, for edge builds, the `edge` tag's commit from GitHub's API when it differs (checked at open and daily; a hint only).

`skills/monchu/SKILL.md` is read from this checkout in place, without a startup copy. It tells Monchu to edit source in a jj workspace, check and build it, apply authorized changes to the running checkout, and reload; host changes need the user's restart approval.

## Roots

A home can hold several roots: independent fronts, each with its own transcript, workers, goals, model picks, Clef pause and cwd. Jobs, config, credentials, logs and the restart request stay home-wide; each job records its root. A root is an ownerless Durable conversation listed in the session document `monchu.roots` (label, created, last input, last seen, archived); Durable's reserved root is the first and is added at open. Its id is the short id of its conversation (`src/api/ids.ts`); any unique prefix names it, and unknown or ambiguous prefixes fail listing the candidates.

- `monchu` opens the current root: the open root with the newest input from the user (a new root counts from its creation). `monchu new` starts a root and opens it; `monchu resume <id>` opens one by prefix. They attach to the home's server like a plain `monchu`, and a terminal keeps showing its root across `/restart`.
- A root's label is the first line of its first message until renamed (`Client.renameRoot`). `/new` resets the shown root's model context and drops its parked provider session; workers, goals, jobs, picks, cwd, tool groups and the queue stay, and a label taken from a message goes so the next message names the root again.
- Archive (`Client.archiveRoot`) hides a root from plain `monchu` and the lists: its history, workers, goals and jobs stay, its id still opens it, and typing in it unarchives it. It is refused while that root's front, a worker or a `bg` command is working, and for the last open root. Nothing deletes a root.
- `Client.watchRoots` gives every root with its counts and an indicator status: `working` while its front, a worker or a `bg` command runs; `done` when its front finished a reply after it was last shown in any client; `idle` otherwise. A root shown in a client counts as seen.
- Fronts see each other through a `roots` prompt section (ids and labels, only when there are other open roots) and the tools `list_roots` (each root's front state, workers and open goals), `message_root` (a labelled follow-up notice into another front, like a worker report, never an instruction) and `hand_off_worker`. Workers inherit the tools but are refused.
- A hand-off (`hand_off_worker`, or `RootClient.handOff`) moves an idle worker's record to the other root with its jobs, and records its new parent in the session document `monchu.handoffs`, since Durable's owner edge is immutable. Reports, updates, `user_messages`, the job tool and the browser session follow that logical parent. A busy worker or sub-worker, or a name taken there, refuses; the receiving front gets a notice with the worker's brief.

## Code layout

Folders follow systems. Lint enforces the arrows: only `src/main.ts` imports `src/server`; clients (`src/tui`) reach the core only through `src/api`, never importing it, not even its types; `src/api` takes core types but no core code and no Node module; `src/ui` imports only `src/api`, and no Node module; the core imports `src/api` but no client and no `src/ui`; only `src/main.ts` composes a client and re-executes the process (`src/reexec.ts`, for an update's new server).

- `src/main.ts`: entry and lifecycle wiring; the only module that touches process state.
- `src/core/`: the store owner, with no terminal, transport, or rendering dependencies.
  - `backend.ts`: store ownership, admission, observation, worker controls, and execution directories.
  - `config.ts`: validated host config: model roles, plugins' shared settings, and the resolved Monchu settings type/defaults.
  - `home.ts`: home resolution before SDK imports, including isolated smoke homes.
  - `context.ts`: home/bundled skill metadata as a prompt section, the config-backed in-memory settings snapshot, and Durable run policy.
  - `identity.ts`: per-request home-file and device sections, and the front's instructions.
  - `home-check.ts`: the home check: the real loaders dry-run on each home change, problems in the tool result that made them, the agent sent back at its final answer, the front told the rest.
  - `reload.ts`: the core's Chord host and the extension registry: loading facets, the reload (alone or through the server), installing each committed build, the reload tool, and durable restart requests. `extensions.ts` is the facet that builds every extension, and `build.ts` what the two share.
  - `jobs.ts`: background jobs: the store-wide jobs document and event stream, cron, the replay-safe runner tasks, and the `job` tool.
  - `update.ts`: `/update` and `monchu update`: checking a release, starting it aside (`bootCheck`), installing it with npm into the running package's prefix, and the daily newer-edge hint.
  - `workdir.ts`, `dev-faux.ts`: directory resolution, and the offline smoke backend.
  - `front.ts`: one root's front and crew in process (`Front implements RootClient`): admission, queue edits, goals, picks, `/new`, hand-off.
  - `agents/`: `roots.ts` (the roots registry, prefixes, summaries, hand-off and the tools between fronts), `workers.ts` (durable worker ownership/delivery state machines, logical parents, lookup/stop/pending checks, and model tools), `goals.ts` (the root's goals document, `update_goal`/`list_goals`, and the `goals` section), `memory.ts` (bounded, atomic home-memory edits for every role).
  - `models/`: Monchu credential store, pi-ai provider modules/catalogs, private login flows, and configured model roles.
  - `secrets/`: `vault.ts` (fnox under the home's own config, the names index, redaction; host code), `requests.ts` (the `monchu.secrets` requests document and the notices that answer them), `tool.ts` (the `secret` tool, shell injection, placeholders and the redaction hook).
  - `tools/`: `pi-tools.ts` (built-in selection and shell configuration inside Durable tool invocations), `herdr.ts` (local Herdr CLI or SSH), `fff.ts` (Pi-fff tool logic, native search indexes, pagination, and Monchu-local search databases), `codemode.ts` (over `@earendil-works/pi-codemode`, with its per-conversation store), `tool-search.ts`, `browser.ts`.
  - `plugins.ts`: the plugin loader (see [plugins.md](plugins.md)): finds bundled (`src/plugins/`), home and device plugins, honours `plugins.local.json`, imports each on its own through a resolve hook that maps `monchu/plugin` (`src/plugin.ts`) and the host packages to Monchu's copies, re-imports one only when its files changed, keeps the last good code of one that fails, and guards its handlers. The extensions facet builds them with everything else: bundled plugins take a fixed place in the default selection, home plugins are appended to each conversation's selection (`attachPlugins`) so their tools never land between ones it already has, and every plugin section renders inside one `plugins` section. Plugin tasks join the plugin's extension, so the registry installs them before pending ones resume; plugin commands reach clients in `Hello.commands` and run through `Root.command` with the shown root, conversation and caller, and any `/name` that isn't built in parses as one. `plugin-shapes.ts` maps Pi's shapes onto Durable: tool definitions, `(event, ctx)` handlers (guards fail closed), and `ctx.ui`, whose lines and statuses live in the root's `monchu.client-notices` document. Plugin providers join the home's models only when their build runs (`settle`), so a failed reload or the home check's copy changes nothing. Front input events run in `Front.submit` (each `input` handler bounded to 5 s) and in queue edits.
  - `mcp/`: MCP config, clients, OAuth sign-in, tools, and the `monchu mcp` command.
  - `skills/`: Pi-derived skill discovery, YAML front matter, diagnostics, and prompt formatting for explicit home/bundled paths only.
- `src/api/`: the client contract, safe for a browser: `client.ts` is the `Client` interface every client uses and the core implements in process (`Monchu implements Client`), with `RootClient` for each root's calls and the core types it carries; `roots.ts` picks the root a client opens; `notices.ts` (worker, root, escalation and system notice labels) and `reports.ts` (routing assessment and MCP report formatting) are helpers the core and clients share. `ids.ts` writes short ids, jj style: a Durable record's store-wide integer id, bit-mixed and spelled in `k`-`z` (4 letters below 65,536 ids, then 5), unique and stable with no index, so every client derives the same id; worker reports and updates show theirs after the name.
- `src/ui/`: presentation shared by clients and safe for a browser: the command table and input parsing, and the Durable presentation mapping with context meters, and job event lines.
- `src/api/` also holds the remote side of the contract: `contract.ts` (Chord contracts placed on the host `core`: `monchu.session {}` with the home-wide methods and state (hello, release, reports, roots, jobs, the connection's own logins), `monchu.root {root}` with a root's methods and its assessments, and `monchu.conversation {root, worker?}` with a front's or worker's view; the `Principal` type and its key), `remote.ts` (`RemoteClient implements Client` over references to them) and `connect.ts` (a client host that redials and re-holds). TypeBox schemas check every argument at the core; results and state are typed with `Type.Unsafe`, trusted from the core.
- Principals: the core's own code, or one client connection (`{ kind: "client", connection, person }`), stamped where the connection comes in. Objects are per connection, so a client's views and logins are its own. A service login (`person: false`) gets the session's `service` variant, which has no `update`, and the method checks again. Adding a method, an optional argument or a field keeps a contract's version; a breaking change bumps it, with an `accepts` adapter where attached terminals must keep working. Chord's link protocol is announced in its hello: another version closes the link, the web page reloads itself, and an attached terminal says to restart (`OUTDATED_CORE`).
- `@earendil-works/chord` is pinned to the exact version `pi-durable` depends on, so npm keeps one copy, and it moves in lockstep with every `pi-durable` bump. The web bundle carries its client host and TypeBox (about 80 KB gzip of the script's budget in `scripts/build-web.ts`).
- `src/server/`: the processes and transports, composed only by `src/main.ts`: `server.ts` (the server process), `process.ts` (the core child through Chord's host manager, and the per-home locks), `child.ts` (the core child's side), `host.ts` (the backend as the core host's host-lifetime `Core` object, declared in `core.ts` so the server never loads the facet, and the session facet loaded by URL; the server's host with its route to the core, `monchu.server`, and `monchu.reloads`, the core's reloads run across both), `session.ts` (the facet: the contracts' factories, with backend subscriptions as resources feeding cells, each root's front built from the facet's own code, and each connection's private logins), `socket.ts` (the local socket, serving and attaching), `web.ts` (the web client's HTTP and WebSocket server) and `auth.ts` (proxy JWTs, OIDC with PKCE, sessions).
- `src/web/`: the web client (Preact, browser-only; its own tsconfigs for the page and the service worker), built by `scripts/build-web.ts`.
- `src/tui/`: the terminal client: lifecycle, command dispatch and read-only view attachments (`app.ts`), copied themes, message components and tool renderers, Pi-style viewport rendering, and Monchu's own agent state in its Herdr pane (`herdr-agent.ts`).

The core imports no terminal code and writes nothing to stdout.
Its public methods admit messages/work using caller-supplied retry IDs, attach a snapshot plus committed events, change directories, cancel work, and close.
The TUI uses the read-only `root(id).viewState(workerName?)` attachment and disposes it on exit; input still goes through `Client` methods.
This slice has no HTTP server, phone UI, or memory retrieval backend; scheduled jobs run only while the core is open.

Submission IDs prevent duplicate admission.
Worker delivery bookkeeping retains all active requests and the latest 200 completed request IDs for retries; older completed IDs may be admitted again.
Reported answer bookkeeping keeps 200 recent IDs per worker plus any answers still needed by active deliveries.
These windows bound the materialized worker bookkeeping, not Durable's stored tasks or transcript.
The latest-history worker document checkpoints every 32 changed commits, retaining one base and at most 31 deltas rather than an ever-growing revision tail.
This bounds worker revision count, not total SQLite-file size; active work and the worker registry can still grow.
Neither receipt nor the front's reply waits for Clef.
Each admitted message gets one assessment task (keyed by submission) in `monchu.assessments`; recovery reuses its committed result.
An escalation is skipped when the front started or messaged a worker for that message, when a newer message arrived, or when Clef is unsure.
Classifier failures are visible and never escalate; there is no fallback classifier. `/clef` shows, pauses (per root) or resumes it, `/clef models` lists the classifier models with a login, and `/clef use <provider>/<model>` saves one.
`/new [handoff]` starts a fresh model context for a root (Durable `reset`); storage keeps every entry and the worker registry.
Reports are submitted with stable request IDs (`worker-report:<task>`, then `:<n>` for re-posts after the front is stopped), so recovery submits each report once; the reporter finishes once the parent's transcript holds it.
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
- `mise run lint`: oxlint with type information. It rejects `any` leaks, casts and non-null assertions, TypeScript suppression comments, values that would print as `[object Object]`, import cycles, imports across the `src/core`, `src/ui` and `src/tui` boundaries, and `vi` in tests.
- `mise run check` also runs knip for unused files, exports, and dependencies. Facets load by URL, so their modules are knip entries.
- `mise run test`: vitest against real Durable Harnesses on SQLite, with Pi's faux chat provider and a scripted classifier provider registered in real pi-ai `Models`, following Pi Durable's own tests. `vitest.config.ts` points `HOME` and `USERPROFILE` at a temp sandbox, and each test's `setup()` narrows them to its own directory, so no test reads or writes `~/.monchu`, `~/.pi`, or `~/.agents`.
  TUI tests use a Pi-derived `VirtualTerminal` backed by `@xterm/headless` to check the visible screen at 40/60 columns in light/dark.
  Tests do not prove live provider behavior or the interactive phone flow.

Durable is experimental.
The npm lockfile pins the Pi/Durable version; inspect the installed declarations before adapting it.
Read Pi's source before adapting it.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
