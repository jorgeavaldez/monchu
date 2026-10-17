# Setup

Installing is in the [README](../README.md). This page covers the first run, configuration, and running on several devices.

## First run

1. **Home.** Monchu keeps everything in its home, `~/.monchu` by default. Set `MONCHU_HOME` to use another one, for example a scratch home to try things out. A missing home is created with starter files (manuals, an empty memory, a `.gitignore` for runtime state and credentials) and becomes a jj repository when jj is installed. Existing files are never overwritten.
2. **Log in.** Startup says which providers still need a login. Run `/login` and pick one:
   - **OpenAI Codex:** device code. Open the URL on any device and enter the code.
   - **Claude Code:** run `claude setup-token` in another terminal (Anthropic's own sign-in) and paste the token it prints. Monchu runs the official Claude Code CLI with that token and never sees an API key. **Before first use, check your Claude account's [extra usage](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) setting**: Monchu can't stop paid overflow if you have it enabled.
   - **Cloudflare Workers AI:** optional. See routing advice below.

   Credentials go in `<home>/auth.json`, and MCP sign-ins in `<home>/mcp-auth.json` (both mode 0600). They stay on that device and are never synced or logged. Monchu never reads other tools' credentials.

3. **Models.** Until you choose models, they follow the provider you logged in to. With Codex, the front uses `gpt-6-luna` and workers use `gpt-6.1-sol`. With Claude Code, the front uses `claude-sonnet-5-5` and workers use `claude-opus-5-5`. To choose your own, use `/model` (Ctrl+S saves the pick to `config.json`) or edit `<home>/config.json`. A bad model name never stops Monchu: startup and `/reload` warn, list the valid names, and keep a working model until you fix it.
4. **Get acquainted.** Ask Monchu to use the `onboard` skill. It reads what is already on the machine (Claude Code, Codex, and Pi sessions and instructions, dotfiles, notes), asks before reading, and seeds your memories, device notes, and a proposed soul. The `soul-absorb` skill digests another assistant's persona or memories.

## Configuration

`<home>/config.json` is optional, and every field has a default:

```json
{
  "front": { "provider": "openai-codex", "modelId": "gpt-6-luna", "thinkingLevel": "low" },
  "worker": { "provider": "openai-codex", "modelId": "gpt-6.1-sol", "thinkingLevel": "high" },
  "classifier": { "provider": "cloudflare-workers-ai", "modelId": "@cf/cloudflare/clef" },
  "claude": { "plan": "pro", "longContextExtraUsage": false },
  "settings": { "theme": "system" }
}
```

- Providers are `openai-codex` and `claude-code`, the latter with `claude-opus-5-5`, `claude-sonnet-5-5`, or `claude-haiku-5-5`, for example. Set `claude.plan` to `max` on a Max plan. Leave `longContextExtraUsage` off for subscription-only use.
- **Routing advice** (Clef, a small Cloudflare classifier) is optional. It nudges the front to delegate. It turns on once Cloudflare credentials exist, from `/login` or from `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`. `"classifier": null` turns it off.
- **MCP servers** go in `<home>/mcp.json`, in Pi's format, so Pi entries copy over unchanged. Manage them like `pi mcp`: `monchu mcp add <name> --url <url>` or `monchu mcp add <name> -- <command> [args...]`, then `monchu mcp list`, `login`, `logout` and `remove` (`monchu mcp --help` has every option). An HTTP server without an `Authorization` header or `auth.provider` signs in with OAuth when it asks for it: `/mcp login <name>` or `monchu mcp login <name>`. In Monchu, `/mcp` shows each server's state and tools, and `/mcp reconnect` picks up changes. Tools are named `mcp__<server>__<tool>`; `exposure` is `codemode` (the default: scripts only), `deferred` (loaded by `tool_search`), `direct`, or `hidden`. Monchu adds one field: `"preload": true` loads a deferred server's tools from the start in Claude Code conversations, whose prompt cache a later load would miss.
- Every setting is documented in [internals](internals.md#configuration-details).

## Several devices

Each device runs its own Monchu with its own logins and database. To share the home's editable files (manuals, memories, skills, and `config.json`), push the home repository to a **private** remote and clone it as the home on the other devices. The seeded `.gitignore` keeps credentials and runtime state out. Add each device to `DEVICES.md`.

## Updating

The `monchu` command runs either an installed release or a checkout linked with `npm link`; `npm ls -g monchu` shows a link as `monchu@<version> -> <checkout>`.

- **Release.** Type `/update` in Monchu (terminal or web page) for the newest build of `main`, or `/update 1.2.0` for a tagged release. Monchu checks the release exists, closes, installs it with npm into the prefix it was installed in, and restarts on it in the same process, so a service manager needs nothing. If npm fails it restarts on the old version and says so. Open pages wait up to two minutes and reload when the version changed; an attached terminal keeps its old code, so start it again. The header shows the version, and an edge build checks daily for a newer edge and says so; it never installs one by itself. `/update` is refused from a service-token login and on Windows, where a running Monchu's files are locked: there, quit and run `monchu update` (or `monchu update 1.2.0`), which refuses while a Monchu has the home open. Rolling back is `/update <older version>`.
- **Your checkout.** In a clone, run `mise run install`, `mise run build`, then `npm link`; `monchu` now runs that checkout's `dist`. To update, pull, then `mise run build` and `/reload` (extensions and skills) or `/restart` (everything else). `/reload` builds first when a source is newer than `dist`, so a build you made yourself is reused. Quit Monchu before `mise run install` or `npm ci` in it, since those replace `node_modules` under it. `monchu update` refuses to replace a link; to go back to releases, run the `npm install -g` command it prints.
- `/restart` starts whatever `monchu` points to now, so after a rebuild it runs the new code. A release installed while Monchu runs is only safe to pick up by quitting first.

## Using it

Type a message. The front answers or starts a worker, and reports and progress show up in the chat as `worker · <name>`.

- `/help` lists the commands. The common ones are `/agents` (view and talk to workers), `/goals`, `/jobs`, `/model`, `/thinking`, `/login`, `/reload`, `/restart` and `/quit`.
- Esc interrupts the front. Alt+S switches between steering and queuing a message. Alt+Q edits the queue.
- The home's Markdown files are Monchu's manual, soul, and memory. Monchu rereads them on every request, so edit them freely.
