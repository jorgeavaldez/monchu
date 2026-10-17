# Monchu internals

How Monchu works under the hood. [Setup](setup.md) covers the first run and configuration.

## Configuration details

`front` and `worker` left out of `config.json` follow the first chat provider with credentials (Codex, then Claude Code; Codex when neither has), and a `/login` reloads to apply them. A role naming an unknown provider/model never stops Monchu: startup uses that default and `/reload` keeps the running role, both with a warning naming the valid providers or models. An invalid `config.json` opens on the built-in defaults at startup; `/reload` rejects it and keeps what is running. `"classifier": null` turns classification off; otherwise Clef runs only while its provider has credentials (`/login` → Cloudflare, or `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`), checked on each message.
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

Skills load in place at startup and on reload from `<home>/skills` and this checkout's bundled `skills/`, with home skills winning name collisions. Only metadata is advertised; bodies are read on demand. Pi instructions, skills, packages, and cwd/ancestor resources are not loaded; no skills are copied.

Home paths owned by Monchu (all relative to `<home>`: `MONCHU_HOME`, default `~/.monchu`). A missing home, or missing starter files, are seeded from `home-template/` at startup without overwriting anything; a brand-new home also gets `jj git init` when jj is installed.

- `config.json`: optional model roles and validated run settings; no secrets. Only Ctrl+S in `/model` or `/thinking` writes it: the whole result passes the startup validator, then replaces the file atomically.
- `auth.json`: Monchu-owned credential storage, including OAuth refresh tokens and Cloudflare keys/account IDs. Locked read-modify-write operations publish atomically with mode 0600 (Windows uses its filesystem ACLs).
- `fff/`: frecency and query-history databases for native file/content search; no Pi or editor databases are reused.
- `claude/`: isolated Claude Code config/execution directory and persisted Claude session mirrors; not the durable conversation store.
- `monchu.sqlite`, `owner.sqlite` and their SQLite sidecars: runtime state and the ownership lock.
- `logs/`: the structured log, one JSON Lines file per day (`monchu-<date>.jsonl`, rolled at 10 MB, kept 14 days), in the OpenTelemetry log data model: `time`, `severity`, `scope` (`core…`, `server…`, `tui`, `web`), `body` and `attributes`. It holds warnings, the core's open phases, reload and close times, one record per model reply (model, tokens, time, stop reason), client attaches, and clients' own timings such as the terminal's `ready`; ids, sizes and timings only, never prompts, outputs or secrets. `/logs [severity|scope]` shows the newest; in Nushell, `open --raw <file> | from json --objects | where severity == warn`.
- `run/`: the core's local socket.
- `web-sessions.json`: web sign-in sessions, by token hash.
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
Clef Flash assesses each message's effort (single turn or sustained) and scope (contained or expanding) beside that reply, never in front of it.
Its result joins the front's later requests as advice and shows as `system · effort`.
When Clef is sure (70%+) the work outgrows a fast reply and the front finished without delegating, one follow-up input (`system · escalation`) asks the front to hand it to a worker.
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
`/reload` applies config, skill and extension edits in process: running work keeps going. `/restart` re-executes Monchu for changes to its own code: accepted work pauses and resumes after, so a step in flight (a model request or a running tool) is cut and runs again or is reported interrupted.
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
`/reload` re-reads config, extensions and home/bundled skills, showing the reloaded modules or an error in the TUI. Model roles and stream options apply from subsequent model-request boundaries; already prepared requests keep those values. Retry/compaction policy resolves at later scheduler boundaries, following Durable's runtime contract. TUI settings refresh on success; already running shell calls keep their environment. Home-file edits need no reload.
`/restart` is your explicit restart approval, even while a worker is shown. It stops input/rendering, disposes view attachments, and restores the terminal before the core closes storage/resources; then the entry point re-executes Monchu. Model output and `request_restart` cannot execute this command.

Workers can also be started, messaged, inspected, and stopped through model tools.
All roles receive the same installed tools: read, write, edit, bash, `fffind`, `ffgrep`, `jj`, `jj_write`, `herdr`, worker management, and `codemode`. File/shell tools come from Durable, including optional `powershell`. The search tools port @ff-labs/pi-fff 0.11.0's tool logic (MIT) on @ff-labs/fff-node 0.11.0: git-aware fuzzy/glob path search and smart-case content search, with filters, context, fuzzy fallback, and pagination. Native indexes follow each conversation's execution directory and support paths outside it; Monchu owns and closes their handles across reloads. fff ships android-arm64, so searches are not skipped on Termux. Tool selection comes from `config.json` settings; `grep`, `find`, and `ls` are no longer built-ins.
`read` returns images (PNG, JPEG, GIF, WebP, BMP) as image blocks, oriented and shrunk to the conversation model's limits by Durable's Photon processor in a worker thread that exits when idle. A conversation holds at most 20 MB of image base64 (Anthropic rejects requests over 32 MB, and tool results stay for good): past that, a tool result's images are refused with an error that says so, and its text is kept. The count comes from each request's context, so images compaction dropped stop counting.
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
Reports do not authorize new actions.

`~/.monchu` is the default home and execution directory, independent of launch cwd.
Each conversation stores its own cwd.
Persistent directory changes require an idle conversation with no pending worker deliveries, so running calls do not silently change environments.
Tools can use explicit paths or shell `cd` for work elsewhere during a run.

## One core, many terminals

One process owns a home's store: the core. It serves its own local socket, `<home>/run/monchu.sock` (0600 in a 0700 directory; a per-home named pipe on Windows), and a plain `monchu` that finds one answering attaches its terminal there instead of opening the store. So the phone keeps one process with its terminal, and a server can run the core headless with `monchu serve` and attach terminals over ssh with plain `monchu`.
Attached terminals use the same `Client` contract over Chord (`@earendil-works/chord`): each terminal is a Chord client host whose upstream is the core, over a WebSocket on that socket. Views stream as a snapshot, then delta ops of Durable's conversation watch, calls carry the client's request IDs, and a login's prompts reach only the terminal that started it. `/restart` from an attached terminal asks the core to restart (its own terminal lets go of the screen first, or `serve` re-executes); attached terminals say the connection was lost, reconnect within 30 seconds, and every reference picks up again from a fresh snapshot. When the core quits for good they say so, and `/quit` closes them. `serve` stops on SIGINT, SIGTERM or SIGHUP.

## Web

`monchu --web` or `monchu serve --web` also serves the web client, from the process that becomes the core. It listens on `127.0.0.1` only; a tunnel on the same host (such as `cloudflared` behind an identity-aware proxy) publishes it. Any local process could reach that port, so nothing is trusted for being local:

- Every request, and the WebSocket at `/api`, needs an identity on `web.allow`. Without `web.access` or `web.oidc`, or with nobody allowed, the web stays off and says why.
- The `Host` must be `web.host` or this port's localhost (421 otherwise); the WebSocket's and sign-out's `Origin` must be `https://<web.host>` or the local one.
- Responses carry a strict content security policy, `nosniff`, no referrer and no framing.

Identities come from either source:

- `web.access`: an identity-aware proxy signs every request (`Cf-Access-Jwt-Assertion`). The server checks the RS256 signature against `<teamDomain>/cdn-cgi/access/certs`, the issuer, the audience and expiry, and refuses tokens without a key id. A service token's identity is `service:<common_name>`; a user's is `sub:<subjectClaim>` (a dotted path, such as `custom.sub` for the upstream provider's subject) and `email:<email>`. A bad token is refused, never ignored.
- `web.oidc`: the server's own login, OpenID Connect authorization code with PKCE (S256), state and nonce, configured from the issuer's discovery document. The ID token's signature, issuer, audience and nonce are checked; `sub:` and a verified `email:` are the identities. A session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 7 days) follows; `web-sessions.json` (0600, never synced) keeps only token hashes. A client secret, when the provider needs one, comes from the environment variable `clientSecretEnv` names.

```json
"web": {
  "port": 7420,
  "host": "monchu.example.com",
  "access": { "teamDomain": "https://<team>.cloudflareaccess.com", "audience": "<aud tag>", "subjectClaim": "custom.sub" },
  "oidc": { "issuer": "https://id.example.com", "clientId": "<client id>" },
  "allow": ["sub:<subject>", "email:<address>", "service:<client id>"]
}
```

URLs must be https, except a provider on this machine. The server serves the built client from `dist/web`, with hashed assets cached for good and the shell and service worker revalidated. The WebSocket carries the same Chord link as the local socket, with the same per-connection objects. It is authenticated at the HTTP upgrade, so a refused page gets a status instead of a dropped socket; only then is its link handed to the core's host.

The client (`src/web`) is Preact with signals, bundled by esbuild into one hashed script and stylesheet (`mise run build` runs `scripts/build-web.ts`; the script fails over 120 KB gzipped, most of it Chord and TypeBox). It is a `Client` like the terminal, over `RemoteClient`, with the same command table, typeahead (commands with their help, then `/skill:<name>`), worker reports and updates with their short ids, tool cards collapsed to a header and a few lines (a click or Ctrl-O opens them), the agents strip, the queue, Alt+S steer mode, Esc to stop the front, `/login` and `/mcp login` prompts answered in the page (secrets in password fields), `/model` and `/thinking` with Ctrl+S to save a default, `/goals`, `/jobs` and `/logs`. Committed entries render once and are reused while their Durable record is unchanged; only the live reply re-renders.
It is a PWA: a manifest fetched with credentials (so a proxy's cookie reaches it) and a service worker that keeps the shell and hashed assets, while navigation goes to the network first so an expired sign-in reaches the login. After a restart the page probes with a plain request before reopening its WebSocket, since browsers delay a WebSocket to an endpoint that just refused one, then rehydrates. It records its ready time, reconnect time, long tasks, update-to-paint latency and errors (by kind and place, never their messages) through `Client.record`.

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
Run `/reload` and expect `reloaded · context, ...`.
Run `/restart`: the app re-executes in the same terminal, restores the conversation and workers, and accepts another message.
Finish with `/quit` and check the shell's exit code is 0.
This checks lifecycle/rendering with deterministic models, not live models or Android/Termux.

## Web check

```nu
mise run web:check -- --baseline <an earlier out dir>
```

`scripts/web-check.ts` builds the web client, starts a loopback OpenID provider that approves every sign-in, and runs `serve --web` from source on a fresh `monchu-smoke-*` home with the faux models, so the server's real login path runs and no auth code is special to it.
It drives journeys in a real browser through `agent-browser` (on PATH, in its own session) at `--viewport` (default 412x915): sign in and reload from the service worker, send a message until the reply settles, and `/mod` typeahead into the `/model` picker and out with Esc.
Each screen gets an accessibility snapshot, a screenshot and an axe audit; clock times read `hh:mm` and the temp home and port are replaced, so two runs of the same code match.
The out dir (`--out`, default `web-check/`) holds `report.json`, `summary.md`, and `<screen>.snapshot.txt` and `<screen>.png`.
Hard gates (exit 1): the journeys' assertions, no page or console errors, no horizontal overflow, the build's size budget, and with a baseline no a11y violation its screen didn't have.
Metrics (bundle bytes, load, reply and picker times, vitals, the page's own ready times) are compared with the baseline and marked `WORSE` past noise: times by 25% and 50 ms, bytes by 2%. A baseline also gives each screen its changed snapshot lines and changed pixel percentage. Compare runs from the same machine; fonts and speed differ between devices.
CI's `web` job runs it on Linux with the newest successful `main` run's `web-check` artifact as the baseline and puts the summary on the run's page.

## Self reload

`reload_extensions` is available to all roles, as is your `/reload` command. The core exposes `reload()` and `restart()`; only your `/restart` command calls the latter, after restoring the terminal, and `restart()` only closes the core: the entry point re-executes the process.

Reload reads the running checkout, never a conversation's cwd or another jj workspace. Source mode imports edited `.ts` modules through Node's type stripping; compiled mode (including a checkout `npm link`ed as the global command) builds that checkout first, when a file under `src/` is newer than `dist/main.js`, by spawning the installed `typescript/bin/tsc` with the running Node executable and `-p tsconfig.build.json`, without a shell, npm, or mise. An installed package (`npm install -g` of a release tarball) ships no sources or `tsconfig.build.json`, so it skips the build and re-imports its fixed modules; only home skills and config change there. Each module in the manifest (`Reloadable` in `src/core/reload.ts`) is imported with a fresh query string. Static imports remain cached, so dependency and host changes require a restart.

Config and all modules are prepared, and the complete registry and installation order validated before applying anything. A build/import/config/validation error leaves installed code, model roles and settings unchanged. Running calls finish on old code; later phases/calls/requests use the replacements. Reload also refreshes the skill metadata snapshot; existing tool environments remain alive. Doc kinds and task names/versions preserve existing state and pending tasks; schema/checkpoint changes still require explicit versioning and migration.

`request_restart({ reason })` only records a durable request on the root and advertises it as a section. It never restarts. Your `/restart` approval clears the request, pauses accepted work, closes the Harness/storage and tool/provider resources; the entry point (`src/reexec.ts`) then re-executes the same Node entry/arguments with inherited stdio, and exits with the child. There is no daemon, supervisor, or agent restart tool.

`/update [release]` is the same approval with an install in between, and likewise user-only: no model tool calls `update()`, and a web connection whose identity is a service token (`service:`) is refused. The core first checks the release's tarball answers (a typo never takes Monchu down), marks its release state `updating` so clients wait two minutes instead of 30 seconds, and asks for a restart. After it closes, the entry point runs `npm install -g --prefix <prefix>` with the prefix derived from the running package's own path, then re-executes; the outcome reaches the new process in `MONCHU_UPDATE_OUTCOME` and every client as a notice. The release state also carries the version and, for edge builds, the `edge` tag's commit from GitHub's API when it differs (checked at open and daily; a hint only).

`skills/monchu/SKILL.md` is read from this checkout in place, without a startup copy. It tells Monchu to edit source in a jj workspace, check and build it, apply authorized changes to the running checkout, and reload; host changes need the user's restart approval.

## Roots

A home can hold several roots: independent fronts, each with its own transcript, workers, goals, model picks, Clef pause and cwd. Jobs, config, credentials, logs and the restart request stay home-wide; each job records its root. A root is an ownerless Durable conversation listed in the session document `monchu.roots` (label, created, last input, last seen, archived); Durable's reserved root is the first and is added at open. Its id is the short id of its conversation (`src/api/ids.ts`); any unique prefix names it, and unknown or ambiguous prefixes fail listing the candidates.

- `monchu` opens the current root: the open root with the newest input from the user (a new root counts from its creation). `monchu new` starts a root and opens it; `monchu resume <id>` opens one by prefix. They attach to a running core like a plain `monchu`, and `/restart` reopens the root its terminal showed.
- A root's label is the first line of its first message until renamed (`Client.renameRoot`). `/new` resets the shown root's model context and drops its parked provider session; workers, goals, jobs, picks, cwd, tool groups and the queue stay, and a label taken from a message goes so the next message names the root again.
- Archive (`Client.archiveRoot`) hides a root from plain `monchu` and the lists: its history, workers, goals and jobs stay, its id still opens it, and typing in it unarchives it. It is refused while that root's front, a worker or a `bg` command is working, and for the last open root. Nothing deletes a root.
- `Client.watchRoots` gives every root with its counts and an indicator status: `working` while its front, a worker or a `bg` command runs; `done` when its front finished a reply after it was last shown in any client; `idle` otherwise. A root shown in a client counts as seen.
- Fronts see each other through a `roots` prompt section (ids and labels, only when there are other open roots) and the tools `list_roots` (each root's front state, workers and open goals), `message_root` (a labelled follow-up notice into another front, like a worker report, never an instruction) and `hand_off_worker`. Workers inherit the tools but are refused.
- A hand-off (`hand_off_worker`, or `RootClient.handOff`) moves an idle worker's record to the other root with its jobs, and records its new parent in the session document `monchu.handoffs`, since Durable's owner edge is immutable. Reports, updates, `user_messages`, the job tool and the browser session follow that logical parent. A busy worker or sub-worker, or a name taken there, refuses; the receiving front gets a notice with the worker's brief.

## Code layout

Folders follow systems. Lint enforces the arrows: only `src/main.ts` imports `src/server`; clients (`src/tui`) reach the core only through `src/api`, never importing it, not even its types; `src/api` takes core types but no core code and no Node module; `src/ui` imports only `src/api`, and no Node module; the core imports `src/api` but no client and no `src/ui`; only `src/main.ts` composes a client and re-executes the process (`src/reexec.ts`).

- `src/main.ts`: entry and lifecycle wiring; the only module that touches process state.
- `src/core/`: the store owner, with no terminal, transport, or rendering dependencies.
  - `backend.ts`: store ownership, admission, observation, worker controls, and execution directories.
  - `config.ts`: validated host config: model roles, classifier overrides, and the resolved Monchu settings type/defaults.
  - `home.ts`: home resolution before SDK imports, including isolated smoke homes.
  - `context.ts`: home/bundled skill metadata as a prompt section, the config-backed in-memory settings snapshot, and Durable run policy.
  - `identity.ts`: per-request home-file and device sections, and the front's instructions.
  - `reload.ts`: the extension registry, the reloadable-module manifest, validated in-process replacement, once-only missing-file warnings, the reload tool, and durable restart requests.
  - `jobs.ts`: background jobs: the store-wide jobs document and event stream, cron, the replay-safe runner tasks, and the `job` tool.
  - `update.ts`: `/update` and `monchu update`: checking a release, installing it with npm into the running package's prefix, and the daily newer-edge hint.
  - `workdir.ts`, `dev-faux.ts`: directory resolution, and the offline smoke backend.
  - `front.ts`: one root's front and crew in process (`Front implements RootClient`): admission, queue edits, goals, picks, `/new`, hand-off.
  - `agents/`: `roots.ts` (the roots registry, prefixes, summaries, hand-off and the tools between fronts), `workers.ts` (durable worker ownership/delivery state machines, logical parents, lookup/stop/pending checks, and model tools), `goals.ts` (the root's goals document, `update_goal`/`list_goals`, and the `goals` section), `memory.ts` (bounded, atomic home-memory edits for every role), `classifier.ts` (non-blocking Clef Flash effort/scope assessment as a background Durable task per front input, advice for later requests, and the escalation follow-up; it never grants permission).
  - `models/`: Monchu credential store, pi-ai provider modules/catalogs, private login flows, and configured model roles.
  - `tools/`: `pi-tools.ts` (built-in selection and shell configuration inside Durable tool invocations), `jj.ts`, `herdr.ts` (local Herdr CLI or SSH), `fff.ts` (Pi-fff tool logic, native search indexes, pagination, and Monchu-local search databases), `codemode.ts` (over `@earendil-works/pi-codemode`, with its per-conversation store), `tool-search.ts`, `browser.ts`.
  - `mcp/`: MCP config, clients, OAuth sign-in, tools, and the `monchu mcp` command.
  - `skills/`: Pi-derived skill discovery, YAML front matter, diagnostics, and prompt formatting for explicit home/bundled paths only.
- `src/api/`: the client contract, safe for a browser: `client.ts` is the `Client` interface every client uses and the core implements in process (`Monchu implements Client`), with `RootClient` for each root's calls and the core types it carries; `roots.ts` picks the root a client opens; `notices.ts` (worker, root, escalation and system notice labels) and `reports.ts` (routing assessment and MCP report formatting) are helpers the core and clients share. `ids.ts` writes short ids, jj style: a Durable record's store-wide integer id, bit-mixed and spelled in `k`-`z` (4 letters below 65,536 ids, then 5), unique and stable with no index, so every client derives the same id; worker reports and updates show theirs after the name.
- `src/ui/`: presentation shared by clients and safe for a browser: the command table and input parsing, and the Durable presentation mapping with context meters, and job event lines.
- `src/api/` also holds the remote side of the contract: `contract.ts` (Chord contracts placed on the host `core`: `monchu.session {}` with the home-wide methods and state (hello, release, reports, roots, jobs, the connection's own logins), `monchu.root {root}` with a root's methods and its assessments, and `monchu.conversation {root, worker?}` with a front's or worker's view; the `Principal` type and its key), `remote.ts` (`RemoteClient implements Client` over references to them) and `connect.ts` (a client host that redials and re-holds). TypeBox schemas check every argument at the core; results and state are typed with `Type.Unsafe`, trusted from the core.
- Principals: the core's own code, or one client connection (`{ kind: "client", connection, person }`), stamped where the connection comes in. Objects are per connection, so a client's views and logins are its own. A service login (`person: false`) gets the session's `service` variant, which has no `update`, and the method checks again. Adding a method, an optional argument or a field keeps a contract's version; a breaking change bumps it, with an `accepts` adapter where attached terminals must keep working. Chord's link protocol is announced in its hello: another version closes the link, the web page reloads itself, and an attached terminal says to restart (`OUTDATED_CORE`).
- `@earendil-works/chord` is pinned to the exact version `pi-durable` depends on, so npm keeps one copy, and it moves in lockstep with every `pi-durable` bump. The web bundle carries its client host and TypeBox (about 80 KB gzip of the script's budget in `scripts/build-web.ts`).
- `src/server/`: the core's transports, composed only by `src/main.ts`: `host.ts` (the core's Chord host: the backend as the host-lifetime `Core` object, the facets loaded, `acceptClient` for an authenticated socket), `session.ts` (the facet: the contracts' factories, with backend subscriptions as resources feeding cells, and each connection's private logins), `socket.ts` (the local socket, serving and attaching), `web.ts` (the web client's HTTP and WebSocket server) and `auth.ts` (proxy JWTs, OIDC with PKCE, sessions).
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
Classifier failures are visible and never escalate; there is no fallback classifier.
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
- `mise run check` also runs knip for unused files, exports, and dependencies. The reload manifest imports its modules through computed URLs, so the exports it reads are tagged `@public`.
- `mise run test`: vitest against real Durable Harnesses on SQLite, with Pi's faux chat provider and a scripted classifier provider registered in real pi-ai `Models`, following Pi Durable's own tests. `vitest.config.ts` points `HOME` and `USERPROFILE` at a temp sandbox, and each test's `setup()` narrows them to its own directory, so no test reads or writes `~/.monchu`, `~/.pi`, or `~/.agents`.
  TUI tests use a Pi-derived `VirtualTerminal` backed by `@xterm/headless` to check the visible screen at 40/60 columns in light/dark.
  Tests do not prove live provider behavior or the interactive phone flow.

Durable is experimental.
The npm lockfile pins the Pi/Durable version; inspect the installed declarations before adapting it.
Read Pi's source before adapting it.
The persistent background subagent example (23) is the ownership reference.
Coding-agent extensions, skills, and MCP require a deliberate Durable integration.
