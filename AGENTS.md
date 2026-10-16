# Working on Monchu

## Context and scope

Monchu is a personal everything agent, built around Pi Durable.
Read `README.md` and `docs/internals.md`.
The maintainer's planning lives in their notes vault: when `OBSIDIAN_VAULT_PATH` is set and holds `projects/monchu.md`, read the vault's live `AGENTS.md`, `projects/monchu.md`, and `projects/monchu/foundation.md` first.
The vault owns product intent, roadmap, decisions, and task tracking.
This repository owns implementation and code-specific documentation.
Do not duplicate the plan here.

The initial handoff is discussion-only.
Do not treat its proposed changes or later roadmap as permission to implement, dispatch agents, install services, or deploy.
Ask when scope or a design decision materially changes the outcome.

## Product invariants

- Keep the conversational front lightweight and responsive while substantial work runs in the background.
  Show receipt immediately; do not pretend receipt is a model answer or that uncommitted work has started.
- Separate visible topic threads, hidden context conversations, and delegated workers.
  Promotion is visibility/interaction behavior; forking is independent continuation; ownership controls work lifetime.
- No user-facing project/cwd requirement.
  Default agent home is `~/.monchu`; execution uses an explicit host and directory when needed, not whichever cwd launched the app.
- Reuse Pi's model/auth runtime APIs with Monchu-owned configuration and credential storage.
  Never read or write `~/.pi`, copy secrets, reimplement authentication, or silently inherit Sol/xhigh as the fast-front default.
- Classification chooses effort/context/thread disposition; it does not authorize side effects.
  Keep uncertainty and provider failures explicit.
- All agent roles may discover and use installed tools.
  Optimize upfront loadouts without creating arbitrary role-based capability bans.
- The vault is a curated human second brain, not an append-only runtime log.
  Follow its domain, linking, publication, and concurrent-edit rules.
- The home's editable files (manuals, memories, skills, souls, `config.json`) may sync across devices through a private repository.
  Credentials, Durable stores, and other runtime state stay per-device; add any new runtime file to `home-template/.gitignore` (and tell existing homes to add it).
- Shipped code, skills, templates, and docs assume nothing about one person's layout (dotfiles, repo paths, notes, accounts): discover it or ask.

## Durable integration

- Inspect the installed declarations and lockfile first.
  Durable is experimental; read Pi's source (a local checkout or the published package) before adapting it.
- Use Durable for conversations, accepted input, task state, committed output, and application documents.
  Do not smuggle a separate non-durable agent loop behind a tool.
- Give each store one owning process.
  Do not open a shared SQLite file from multiple daemons or sync a live database as a device-federation strategy.
- Use stable request IDs for transport retries and worker result delivery.
  Only mark a tool replay-safe when its actual operation is safe to repeat.
  A committed tool intent does not prove an external side effect completed exactly once.
- Background work must not keep the front run busy.
  Preserve explicit worker cancellation and distinguish it from ordinary chat abort.
- Registry implementations and host settings are not persisted by Durable.
  Serialize host configuration; reinstall named definitions before resuming their pending tasks.
  Per-conversation choices belong to `pi.agent`.
- Apply structural config/reload changes at a clear turn boundary.
  In-flight requests/calls retain their documented semantics; changing cwd can affect later tool phases.
- Coding-agent extensions, skills, MCP, and codemode are not automatically Durable integrations.
  Reuse their implementation only through a deliberate seam that preserves ownership, persistence, output, and cancellation.

## Engineering and delivery

- Implement the smallest complete approved outcome, at most two bounded changes per implementation phase.
  Investigations can happen in parallel; never assign concurrent writers to the same checkout/files.
- Prefer direct local code and precise types; follow the code rules below.
- Validate untrusted inputs at the boundary.
  Keep credentials out of docs, prompts, source control, and logs.
- Use jj for source-control operations and prefer jj workspaces for separate coding tasks.
  Publish source changes only when explicitly authorized; vault delivery follows its own standing authorization.
- Use native `agent_browser` when browser automation is needed.
  Respect existing browser ownership and takeover rules; never blindly replay uncertain submissions.
- Use `mise run ...` as the task runner; `mise.toml` owns task definitions, not npm scripts.
- After code changes run `mise run check` and `mise run build`; both must pass.
  Report what actually ran and any pre-existing failures; do not claim an interactive, restart, or phone flow works from static checks alone.
- Update the canonical vault handoff when approved work changes the project state.
  Keep shared filenames portable across Windows, macOS, Linux, and Android.

## Code rules

`mise run check` enforces most of these; do not weaken a check to pass it.

- **Layering.** `src/main.ts` composes the backend (`src/backend.ts`) and the TUI (`src/tui/`).
  Nothing else imports `src/tui/`, and the backend writes nothing to stdout.
  `src/config.ts` validates Monchu's configuration; `src/context.ts` constructs the settings snapshot, and the backend owns model/auth setup. Monchu does not depend on the coding-agent runtime or configure an SDK agent directory. Durable owns read/write/edit/bash/powershell; `src/fff.ts` ports pi-fff 0.11.0 tool logic for default `fffind`/`ffgrep`, with databases under the explicit Monchu home.
- Process-level setup (environment, home, signals) belongs to the entry point; library code never mutates it. Shell-tool children inherit that environment unchanged, without an env file or startup override.
- **One way to define an extension.** A reloadable module exports one `defineExtension` named `monchu.<module>`: a constant, or a `create<Name>(inputs)` factory when it needs host inputs.
  A factory that has more to hand back returns `{ extension, ... }`, with configuration problems as `warnings: string[]`.
  Add the module to `Reloadable` and `build()` in `src/reload.ts`, and tag the export the manifest reads `@public`.
- **Types.** No `any`, casts, non-null assertions, or `@ts-` comments.
  A lint disable needs a reason on the same line and no alternative; the existing ones are for computed `import()`.
- **No compatibility shims.** Change an API and update every caller; delete the old shape and its tests.
  Do not keep code for old stored data, checkpoints, or call shapes.
  A change to a stored shape ships with a migration only when the maintainer wants existing data kept; otherwise they decide on a fresh database.
- **Tests.** Run real Durable Harnesses on SQLite in temp directories with Pi's faux providers, through Monchu's public seams.
  No `vi` (mocks, spies, stubs, fake timers) and no patching of Monchu code.
  Shared helpers live only in `test/support.ts`; call `setup()` and `cleanup()` so each test has its own home.
  Tests never touch `~/.monchu`, `~/.pi`, or `~/.agents`.
  The suite passes on Windows and Linux; skip a case only for genuinely POSIX-only behavior, and say why.
- **Check gates.** `mise run check` runs `tsc`, type-aware oxlint (types, layering, test imports), `oxfmt --check`, knip (unused files, exports, dependencies), and vitest.
  Development tooling need not run on Termux; runtime code must.
