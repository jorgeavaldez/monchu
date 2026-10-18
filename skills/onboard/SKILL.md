---
name: onboard
description: Get to know a new user or device by replaying what already exists on the machine (Claude Code, Codex and Pi sessions and instructions, dotfiles, shell and tool config, notes) and seed Monchu's home from it - memories/USER.md, memories/MEMORY.md, DEVICES.md, device skills, and a proposed SOUL.md. Use on a fresh home, a new device, or when the user asks Monchu to onboard, learn about them, or catch up from their other agents.
---

# Onboard

Seed Monchu's home from what the machine already knows about the user, so Monchu starts with context instead of as a stranger.
Everything here is discovered or asked, never assumed: paths differ per person and per machine.

## 1. Ask first, in one message

- What to read. Offer what you found in step 2 and let the user narrow it (for example "skip work sessions", "only the last month").
- Where their notes live (an Obsidian vault, a notes repo), if they want Monchu to use them.
- Anything off limits on this machine (work context, other people's data).

## 2. Discover sources

Look, don't guess. Check each candidate exists and how big it is before reading it.

- Agent instructions: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, Pi's `~/.pi/agent/AGENTS.md`, and project `AGENTS.md`/`CLAUDE.md` files in the repositories they work in.
- Agent sessions (JSONL): Claude Code `~/.claude/projects/*/` (or `$CLAUDE_CONFIG_DIR/projects`), Codex `~/.codex/sessions/`, Pi `~/.pi/agent/sessions/`. Newest first; the user's own messages carry the most signal.
- Agent memories and souls from other assistants, if the user points at them (use the `soul-absorb` skill for those).
- Dotfiles and shell: find the dotfiles repository from where config symlinks point or from the user's answer, plus the login and interactive shells, the tool manager (mise, asdf, brew, ...), and source control (`git config`, jj config).
- Repositories: where they keep code (common parents of recent session `cwd`s), and their remotes.
- Notes: the vault or notes repository from step 1.

## 3. Read in parallel, privately

- Large sources go to background workers, one per source, each returning a short digest of facts, not transcripts.
- Read only. Never read or copy credential files (`auth.json`, `.credentials.json`, keychains, `.env`, secret stores); never put a secret, token or key in any output. Note that you skipped them.
- Respect the user's limits from step 1.

## 4. Sort what you learned

- Who the user is, how they like to work, their preferences, tools, people, and corrections they repeat to agents: `memories/USER.md`.
- Lessons and standing decisions about working with them, and pitfalls their past agents hit: `memories/MEMORY.md`.
- This machine (OS, shells, paths, quirks, what is allowed): its section in `DEVICES.md`, keyed by hostname.
- A procedure that only matters on this machine or for one tool: a skill in the home's `skills/` (`skills/local/` when it must not leave the device).
- Voice and character they expect from an assistant: a proposed `SOUL.md` rewrite. Show it; edit `SOUL.md` only after they say yes.
- Durable knowledge they would want to read later (a setup guide, a project overview): their notes, if they keep any, following the notes' own conventions.
- Merge with what the home already holds; dedupe, keep entries short, and stay within the memory limits.

## 5. Check what Monchu needs here

- Secrets: the bundled `fnox` plugin keeps secret values in [fnox](https://fnox.jdx.dev), which must be on PATH (`fnox --version`). If it is missing, tell the user that agents can't store or use secrets until it is installed (`mise use -g fnox`, or fnox's installer), or until another store plugin replaces `fnox`. Monchu makes its own fnox config and key in the home's `secrets/`; never read or change the user's own fnox setup.

## 6. Finish

- If the home is a repository, commit the changes. Push only to a remote the user set up.
- Tell the user in a few bullets: what you read, what you saved where, what you skipped and why, and the open questions. Ask for corrections; their word beats any session.
