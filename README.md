# Monchu

A personal everything agent built around [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
The first goal: fast conversation that can start background work without making you wait to keep talking.

## Canonical project context

The roadmap, primer, open decisions, and tasks live in Jorge's Obsidian vault, not this repo:

- Project home: `projects/monchu.md`
- Primer and PoC/MVP handoff: `projects/monchu/foundation.md`
- Active task: `projects/tasks.md`, tag `#monchu`

Resolve the vault through `OBSIDIAN_VAULT_PATH` and read its `AGENTS.md` before editing notes.
The repo contains code-specific documentation; it should not grow a second roadmap.

## Current scaffold

`src/main.ts` creates Pi's `ModelRuntime` from the existing agent configuration directory, opens a Durable Harness, submits a hard-coded question, prints JSON diagnostics, and closes.
It uses **in-memory storage**, an empty extension registry, and a hard-coded Sol model.
It is not yet an interactive assistant, background-worker service, or phone client.

The declared Durable dependency is `^1.0.0`; the inspected installed version is `1.0.0`.
Its API is experimental, so implement against the installed declarations and lockfile.
Pi source is available locally at `~/proj/pi`.

## Run the existing demo

Use the toolchain pinned in `mise.toml` and the package manager declared in `package.json`.
Dependencies can be installed with `pnpm install --frozen-lockfile`.

```sh
pnpm dev       # watch mode; executes the hard-coded model request
pnpm start     # executes dist/main.js after a build
```

These commands make a live model request using Pi's existing credentials.
They are not a smoke check for the planned app.
Do not copy credentials into this repository or create a new provider setup just for Monchu.

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm check
```

`pnpm check` runs typechecking, lint, and a formatting check.

## Intended first slice

Persist conversations under `~/.monchu`, stream a fast model's response, install basic tools with an explicit environment, and start a restart-safe background worker that reports back while chat stays available.
The phone surface, model choices, and initial classifier path remain discussion decisions in the vault handoff.
No implementation or deployment is implied by these docs.

## SDK starting points

- [Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Persistent background subagents](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)
- [Reload and restart](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/31-reload-and-restart.ts)
- [Codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md), which needs an integration seam rather than assuming coding-agent extensions are Durable extensions
