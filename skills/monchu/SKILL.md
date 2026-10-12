---
name: monchu
description: Edit and reload Monchu's own extensions, skills, and instructions; ask Jorge before restarting for host changes.
---

# Changing Monchu

- Work in a separate jj workspace when changing Monchu source. Never edit a sibling lane or mutate history without authorization.
- Run `npm run check` in that workspace before applying changes to the running checkout. Do not claim workspace edits are live: `reload_extensions` reads the running checkout, not the tool's cwd.
- Once approved source changes are in the running checkout, call `reload_extensions`. It reloads worker tools, codemode, classifier hooks, goals, Pi tools/context, and identity sections without a restart.
- Pi user skills, instructions, and settings reload through the same tool. Read skills on demand; preserve Jorge's edits.
- Imports inside a reloaded module stay cached. Backend, loader, configuration, dependencies, and other host changes require a restart.
- For host changes, call `request_restart` with a concise reason and ask Jorge to use `/restart`. The tool only records a request. Never execute a restart yourself or treat your own request as approval.
- Reload failures leave installed definitions and settings unchanged. Report the error and stop rather than claiming the new code is running.
