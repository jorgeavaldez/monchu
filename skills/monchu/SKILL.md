---
name: monchu
description: Edit and reload Monchu's own extensions, skills, and instructions; ask the user before restarting for host changes.
---

# Changing Monchu

- Work in a separate jj workspace when changing Monchu source. Never edit a sibling lane or mutate history without authorization.
- Run `mise run check` and `mise run build` in that workspace before applying changes to the running checkout. Do not claim workspace edits are live: `reload_extensions` reads the running checkout, not the tool's cwd.
- Once approved source changes are in the running checkout, call `reload_extensions` to reload extensions and home/bundled skills without a restart. Read skills on demand; preserve the user's edits.
- Home files are read on every request; their edits need no reload.
- Imports inside a reloaded module stay cached. Host and dependency changes require a restart.
- For host changes, call `request_restart` with a concise reason and ask the user to use `/restart`. The tool only records a request. Never execute a restart yourself or treat your own request as approval.
- Reload failures leave installed definitions and settings unchanged. Report the error and stop rather than claiming the new code is running.
