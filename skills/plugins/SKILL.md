---
name: plugins
description: Write, test, reload or turn off a Monchu plugin (in-process tools, prompt sections and event hooks in the home's plugins/ folder). Use when the user wants a custom tool, guard or integration that skills and MCP servers can't give, or a plugin fails to load.
---

# Monchu plugins

The full reference is `../../docs/plugins.md` (relative to this skill's folder): read it before writing one.

## Pick the right surface first

- Instructions or a script the agent runs: a skill. No code in Monchu's process.
- A service with its own process, any language, or anything heavy or flaky: an MCP server in `mcp.json`.
- An in-process tool, a guard on other tools (`tool_call`), result rewriting (`tool_result`), or prompt context: a plugin. Context the model should keep goes in a section (`registerSection`), which joins the transcript once; a `context` handler changes every request and costs the prompt cache.

## Writing one

1. Ask where it runs: `plugins/<name>/` syncs to every device; `plugins/local/<name>/` stays on this one (work-only or device-specific plugins go there). Check the device rules before syncing one that reaches a machine or service.
2. Write `index.ts` (erasable TypeScript only) or `index.js`, default-exporting `function (monchu: PluginApi)`. The API has Pi's extension shapes: tool definitions, `(event, ctx)` handlers, commands with `handler(args, ctx)` and `ctx.ui.notify`. Import only from `monchu/plugin` and Monchu's host packages as bare names; other dependencies go in its `package.json`, pure JS, `npm install` in its folder. Put `"monchu": { "api": <apiVersion> }` there too.
3. Settings never go in its code: shared ones in `config.json` `plugins.<name>`, this device's in `plugins.local.json` `settings.<name>`; the plugin reads `monchu.config`.
4. Keep tools `deferred` (the default) unless most turns need them. A `direct` tool, or any edit to its description or schema, re-caches every conversation. Keep descriptions stable.
5. Set `replay: "safe"` only on tools that can safely run twice.
6. Don't start timers or processes in the plugin function; release what tools start in `session_shutdown`.

## Testing and shipping

1. Run `reload_extensions`. Its result names each plugin as loaded, kept on last good code, not loaded (with the error and file) or disabled. Fix and reload until it loads.
2. Exercise it: `tool_search` the group, call the tool, or trigger the hook, and read the result.
3. Commit and push the home like any home edit, and name the plugin in the report: a synced plugin runs on every device.

## Turning one off on a device

Add its name to `<home>/plugins.local.json` (`{ "disabled": ["name"] }`, gitignored), then reload. Bundled plugins (`jj`, `clef`, `fnox`) can be turned off the same way. `fnox` keeps the secret values: turn it off only for a plugin that registers another store (`registerSecretStore`).
