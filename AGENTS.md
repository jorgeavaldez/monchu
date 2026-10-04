# Working on Monchu

## Context and scope

Monchu is Jorge's personal everything agent, built around Pi Durable.
Read `README.md`, then resolve `OBSIDIAN_VAULT_PATH` and read the vault's live `AGENTS.md`, `projects/monchu.md`, and `projects/monchu/foundation.md`.
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
- Reuse Pi's existing provider configuration and credential storage through its runtime APIs.
  Do not copy secrets, reimplement authentication, or silently inherit Sol/xhigh as the fast-front default.
- Classification chooses effort/context/thread disposition; it does not authorize side effects.
  Keep uncertainty and provider failures explicit.
- All agent roles may discover and use installed tools.
  Optimize upfront loadouts without creating arbitrary role-based capability bans.
- The vault is a curated human second brain, not an append-only runtime log.
  Follow its domain, linking, publication, and concurrent-edit rules.

## Durable integration

- Inspect the installed declarations and lockfile first.
  Durable is experimental; local Pi source is at `~/proj/pi`.
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
- Prefer direct local code and precise types.
  No trivial one-use wrappers, speculative layers, compatibility shims, `any`, unchecked casts, or unjustified suppressions.
- Validate untrusted inputs at the boundary.
  Keep credentials out of docs, prompts, source control, and logs.
- Use jj for source-control operations and prefer jj workspaces for separate coding tasks.
  Publish source changes only when explicitly authorized; vault delivery follows its own standing authorization.
- Use native `agent_browser` when browser automation is needed.
  Existing homelab browser ownership/takeover rules remain authoritative; never blindly replay uncertain submissions.
- After code changes run the relevant tests, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run check`.
  Report what actually ran and any pre-existing failures; do not claim an interactive, restart, or phone flow works from static checks alone.
- Update the canonical vault handoff when approved work changes the project state.
  Keep shared filenames portable across Windows, macOS, Linux, and Android.
