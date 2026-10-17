---
name: monchu
description: Edit and reload Monchu's own extensions, skills, and instructions; ask the user before restarting for host changes.
---

# Changing Monchu

- Work in a separate jj workspace when changing Monchu source. Never edit a sibling lane or mutate history without authorization.
- Run `mise run check` and `mise run build` in that workspace before shipping. Do not claim workspace edits are live: `reload_extensions` reads the code Monchu runs, not the tool's cwd.
- Find what runs: the `monchu` command is either an installed release or a checkout linked with `npm link` (`npm ls -g monchu` shows a link as `-> <checkout>`; a source run is a checkout too).
  - Release: changes go live only through a new release (pushed to the branch that builds it). The user quits, runs `monchu update`, and starts again; never run `npm install -g` or `monchu update` while Monchu runs.
  - Linked or source checkout: that checkout is the running checkout. Apply approved changes there; never run `npm ci` or `mise run install` in it while Monchu runs (dependency changes need a quit first).
- Once approved source changes are in the running checkout, call `reload_extensions` to reload extensions and home/bundled skills without a restart; it builds first when sources are newer than the build. Read skills on demand; preserve the user's edits.
- Home files are read on every request; their edits need no reload.
- Imports inside a reloaded module stay cached. Host and dependency changes require a restart.
- For host changes, call `request_restart` with a concise reason and ask the user to use `/restart`. The tool only records a request. Never execute a restart yourself or treat your own request as approval.
- Reload failures leave installed definitions and settings unchanged. Report the error and stop rather than claiming the new code is running.
