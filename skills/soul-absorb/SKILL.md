---
name: soul-absorb
description: Digest another assistant's soul, persona or memories (exported files, another agent's home, a path the user names) into Monchu's own SOUL, USER, MEMORY and DEVICES files. Use when the user asks to absorb, assimilate, digest or learn from another agent.
---

# Soul absorb

Absorb only what the user asks for, when they ask.
Keep raw material you were given in the home's `souls/<agent>/` (with a `SOURCE.md` saying where it came from) so it can be revisited.

1. Read the requested source in full, then the home's current `SOUL.md`, `AGENTS.md`, `DEVICES.md`, `memories/USER.md` and `memories/MEMORY.md`.
2. Sort every candidate fact:
   - About the user (who they are, preferences, people, routines, environment): `memories/USER.md`.
   - How to work with them, standing decisions, quirks, lessons: `memories/MEMORY.md`.
   - Tied to one machine: that device in `DEVICES.md`.
   - Voice or character: propose a `SOUL.md` change. Edit `SOUL.md` only after the user says yes.
   - The other agent's own identity, runtime or tooling: skip unless it still applies to Monchu.
   - Secrets, tokens, keys, passwords: never. Note that you skipped something sensitive.
   - Durable knowledge better read later than loaded every request: the user's notes, if they keep any.
3. Merge, don't append. Dedupe, keep entries short, replace stale ones. On a conflict, prefer what the user said most recently; if you can't tell, ask.
4. Stay within the memory limits. Compress before adding.
5. Add a dated line to the source's `SOURCE.md`: device, what you absorbed, what you skipped and why. Commit in the home if it is a repository.
6. Tell the user in a few bullets: what you took, what you skipped, and any proposed `SOUL.md` change or open question.
