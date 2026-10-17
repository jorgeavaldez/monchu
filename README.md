# Monchu

My heavily opinionated personal agent, built to route and delegate endeavors: one input stream of consciousness in, separate workstreams out.

**How it works:** you talk to one light front agent about anything. It routes each ask to a standing background worker that owns that line of work (a repository, a machine, your notes) and tracks your endeavors as goals, so the chat stays free.
Conversations, workers, and goals are durable: they are built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) and survive restarts and crashes.

It is shaped around one person's way of working: subscription models only (ChatGPT/Codex, and Claude via Claude Code), a terminal UI, and plain Markdown files as its manual, soul, and memory. It is shared as is and may change without notice.

## Quick start

You need Node 22.19+ and a ChatGPT or Claude Pro/Max subscription. Install the newest build of `main` as a global `monchu` command, the same way on macOS, Linux, Windows, and Android (Termux):

```sh
npm install -g --allow-remote=root https://github.com/jorgeavaldez/monchu/releases/download/edge/monchu.tgz
monchu
```

To update, type `/update` in Monchu (or `/update <version>` for a [tagged release](https://github.com/jorgeavaldez/monchu/releases)): it installs the release and restarts on it. With Monchu quit, `monchu update` does the same. `npm uninstall -g monchu` removes the command but keeps the home. [docs/setup.md](docs/setup.md#updating) also covers running your own checkout with `npm link`.

1. Monchu creates its home at `~/.monchu`. Set `MONCHU_HOME` to use a different directory.
2. Run `/login` and pick Codex or Claude Code. Monchu uses that provider's models.
3. Ask Monchu to use the `onboard` skill to learn about you from what's already on the machine.

[docs/setup.md](docs/setup.md) covers logins, configuration, MCP servers, and running on several devices. [docs/internals.md](docs/internals.md) covers how Monchu works. `/help` lists the commands.

## Development

You need npm 12.2+ and [mise](https://mise.jdx.dev).

```sh
mise run install
mise run check   # typecheck, lint, format, knip, tests
mise run build
npm link         # make `monchu` run this checkout's build
mise run smoke   # offline TUI with scripted models
mise run pack    # the installable tarball CI attaches to releases
```

Code rules are in [AGENTS.md](AGENTS.md).

## Contributing

This is my personal project. Fork it and make it yours. Pull requests are welcome to try, but they probably won't be read or merged. There is no issue tracker.

## License

MIT, see [LICENSE](LICENSE). Parts are ported from other MIT projects (Pi, pi-fff, pi-claude-bridge, strip-ansi); [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) credits them.
