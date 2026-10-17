# Working on Monchu

Monchu is a personal agent built on Pi Durable: a fast front conversation that routes work to durable background workers.
Read `README.md` and `docs/internals.md` before changing it. Product intent and the roadmap live in the maintainer's notes, not in this repo. If `OBSIDIAN_VAULT_PATH` holds `projects/monchu.md`, read it.

## Invariants

- The front stays responsive. Background work never keeps it busy. A receipt is not an answer.
- Monchu owns its home (`MONCHU_HOME`, default `~/.monchu`), config, and credentials. It reuses Pi's model and auth APIs, but never reads or writes another tool's config or credentials.
- Credentials, Durable stores, and other runtime state stay on their device. Add every new runtime file to `home-template/gitignore` (seeded as the home's `.gitignore`).
- Routing advice and classification never authorize side effects. Failures stay visible, and nothing silently falls back.
- Shipped code, skills, templates, and docs assume nothing about one person's setup (paths, dotfiles, accounts, devices). Discover it or ask.

## Durable

- Durable is experimental. Read the installed declarations and Pi's source before adapting it.
- Durable holds conversations, accepted input, tasks, and documents. Never hide a separate agent loop behind a tool.
- Each store has one owning process. Never share or sync a live database.
- Retries and worker deliveries use stable request IDs. Mark a tool replay-safe only if repeating it is safe; a committed call does not prove its side effect happened once.
- Durable doesn't persist registries or host settings. Reinstall definitions before resuming their tasks, and apply config changes at turn boundaries.

## Prompt cache

Providers cache each request's prefix (tools, system prompt, then messages). Anything that changes what was already sent re-bills the whole conversation, so:

- Nothing dynamic goes in the system prompt or the tool list: no clocks, counters, ids or per-request state. Dynamic context belongs in a Durable section, which sends a change as a later system message, or in the conversation itself.
- A prompt change is delivered in the stream, never by editing the prefix. Transports that can't send system messages mid-conversation (the Claude Code bridge) fold them into the next input, not into the system prompt.
- A section never toggles between text and `undefined`: one that appears later re-sends every section after it. Render a short stable placeholder instead.
- A conversation's tools only grow. Never drop, reorder or redeclare one (restarts included), and keep tool descriptions stable; on the Claude Code bridge any change re-caches the conversation.
- A restart, abort or retry resumes the provider's existing session; it never rebuilds one that renders differently.
- Touching prompt, section, tool or provider code: run `test/cache.test.ts` and the Claude Code tests, and check `cacheMiss` in the `core.model` reply log.

## Code rules

`mise run check` enforces most of these. Never weaken a check to pass it.

- **Layering.** `src/main.ts` composes the core (`src/core/`) and the TUI (`src/tui/`). Clients reach the core only through the `Client` contract in `src/api/` (browser-safe: core types only, no core code or Node). `src/ui/` (shared presentation) imports only `src/api/`. The core imports no client and no `src/ui/`, and never writes to stdout. Only the entry point touches process state (env, home, signals, re-exec).
- **Extensions.** A module under `src/core/` exports one `defineExtension` named `monchu.<module>`: a constant, or a `create<Name>(inputs)` factory returning the extension, or `{ extension, ..., warnings }`. Register it in `build()` in `src/core/extensions.ts`, the facet `/reload` swaps; what outlives a reload comes in through `BuildInputs` (`src/core/build.ts`).
- **Types.** No `any`, casts, non-null assertions, or `@ts-` comments. A lint disable needs a same-line reason.
- **No compatibility shims.** When you change an API, update every caller and delete the old shape. Stored-shape changes get a migration only when the maintainer asks for one.
- **Web UI.** Follow `docs/internals.md#Web design`: the tokens in `src/web/style.css`, one icon set, state shown rather than explained, and `mise run web:check` for every visible change.
- **Tests.** Use real Durable Harnesses on SQLite in temp dirs with Pi's faux providers, through public seams. No `vi` mocks, spies, or fake timers. Helpers live only in `test/support.ts`. Call `setup()` and `cleanup()`, and never touch the real home. Tests pass on Windows and Linux.

## Delivery

- Use jj, not git, and give each task its own jj workspace. Never let two writers share a checkout.
- `mise.toml` defines the tasks. `mise run check` and `mise run build` must pass. Report what ran and what failed, and don't claim an interactive or restart flow works from static checks alone.
- Keep changes small and complete. Validate untrusted input at the boundary. Keep secrets out of code, docs, prompts, and logs.
- Development tooling may skip Android. Runtime code must run there.
