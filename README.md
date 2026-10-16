# Monchu

A personal everything agent built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
You chat with a fast front model; it hands real work to named background workers that keep their own context, while the chat stays free.
Conversations, workers, and goals are durable: they survive restarts and crashes.

## Requirements

- Node 22.19+ and npm 12.2+ (`mise.toml` pins the preferred versions; [mise](https://mise.jdx.dev) is the task runner).
- A subscription for at least one chat provider: ChatGPT (OpenAI Codex) or Claude Pro/Max (Claude Code).
- Optional: [jj](https://jj-vcs.github.io/jj/) to version Monchu's home, the [Claude Code CLI](https://code.claude.com) for Claude models, and a Cloudflare Workers AI key for routing advice.

Windows, macOS, and Linux run everything. Android (Termux) runs Monchu; its development tooling needs workarounds.

## Install and run

```sh
git clone <this repository> monchu && cd monchu
mise run install
mise run start   # builds when sources changed; `mise run dev` runs from source
```

Monchu needs an interactive terminal.

## First run

1. **Home.** Monchu keeps everything in its home, `~/.monchu` by default. Set `MONCHU_HOME` to use another one, for example a scratch home to try things out. A missing home is created with starter files (manuals, an empty memory, a `.gitignore` for runtime state and credentials) and becomes a jj repository when jj is installed. Existing files are never overwritten.
2. **Log in.** Startup says which providers still need a login. Run `/login` and pick one:
   - **OpenAI Codex:** device code. Open the URL on any device and enter the code.
   - **Claude Code:** run `claude setup-token` in another terminal (Anthropic's own sign-in) and paste the token it prints. Monchu runs the official Claude Code CLI with that token and never sees an API key. **Before first use, check your Claude account's [extra usage](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) setting**: Monchu can't stop paid overflow if you have it enabled.
   - **Cloudflare Workers AI:** optional. See routing advice below.

   Credentials go in `<home>/auth.json` (mode 0600). They stay on that device and are never synced or logged. Monchu never reads other tools' credentials.

3. **Models.** The defaults are Codex `gpt-6-luna` for the front and `gpt-6.1-sol` for workers. To change them, use `/model` (Ctrl+S saves the pick as the default) or edit `<home>/config.json`. A bad model name doesn't stop startup: Monchu warns, lists the valid names, and uses the default until you fix it.
4. **Get acquainted.** Ask Monchu to use the `onboard` skill. It reads what is already on the machine (Claude Code, Codex, and Pi sessions and instructions, dotfiles, notes), asks before reading, and seeds your memories, device notes, and a proposed soul. The `soul-absorb` skill digests another assistant's persona or memories.

### Configuration

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
- MCP servers go in `<home>/mcp.json`, in Pi's format.
- Every setting is documented in [docs/internals.md](docs/internals.md#configuration-details).

### Several devices

Each device runs its own Monchu with its own logins and database. To share the home's editable files (manuals, memories, skills, and `config.json`), push the home repository to a **private** remote and clone it as the home on the other devices. The seeded `.gitignore` keeps credentials and runtime state out. Add each device to `DEVICES.md`.

## Using it

Type a message. The front answers or starts a worker; reports and progress show up in the chat as `worker · <name>`.

- `/help` lists the commands. The common ones: `/agents` (view and talk to workers), `/goals`, `/model`, `/thinking`, `/login`, `/reload`, `/restart`, `/quit`.
- Esc interrupts the front. Alt+S switches between steering and queuing a message. Alt+Q edits the queue.
- The home's Markdown files are Monchu's manual, soul, and memory. They are reread on every request, so edit them freely.

## Development

```sh
mise run check   # typecheck, type-aware lint, format, knip, tests
mise run build
mise run smoke   # offline TUI with scripted models in a throwaway home
```

Contributor rules are in [AGENTS.md](AGENTS.md); architecture and runtime behavior are in [docs/internals.md](docs/internals.md).
