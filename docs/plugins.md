# Plugins

A plugin is a folder of code that adds tools, prompt sections and event handlers to Monchu, in the shape of [Pi's extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). Monchu turns each one into a Durable extension. Plugins are trusted code: they run in Monchu's core process with your permissions, and nothing sandboxes them. Put anything heavy, flaky or untrusted in an [MCP server](setup.md) instead, which runs in its own process.

## Where they live

```
<home>/plugins/<name>/         synced with the home, so it runs on every device
<home>/plugins/local/<name>/   this device only (gitignored)
  index.ts or index.js         default export: a function that receives the plugin API
  package.json                 optional: a description, and pure-JS dependencies
  skills/                      optional: skills that ship with the plugin
<home>/plugins.local.json      optional, gitignored: { "disabled": ["name", ...] } turns plugins off on this device
```

- A name is lowercase letters, digits and dashes. A device's own plugin replaces a synced one of the same name, and both replace a bundled one.
- Monchu ships bundled plugins too (`src/plugins/`, such as `jj`). They load the same way, and the deny list turns them off too.
- If `plugins.local.json` can't be read or parsed, no home plugin loads (bundled ones still do) and a warning says why.
- Plugins are only read from the home. Monchu never loads code from a conversation's directory or a project.

## Writing one

```ts
import { defineTool, Type, type PluginApi } from "monchu/plugin";

export default function (monchu: PluginApi) {
  monchu.namespace({
    description: "Homelab status and restarts",
    instructions: "Ask before restarting.",
  });
  monchu.registerTool(
    defineTool({
      name: "homelab_status",
      description: "Status of every homelab service",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text", text: "all green" }] }),
    }),
  );
  monchu.registerSection("hosts", () => "dev, proxmox, plex");
  monchu.on("tool_call", (call) =>
    call.name === "bash" && /rm -rf \//.test(String(call.arguments.command))
      ? { block: "not that" }
      : undefined,
  );
}
```

- Import `monchu/plugin`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` and `typebox` as bare names. Monchu resolves them to its own copies, so never install them into the plugin. Other dependencies go in the plugin's `package.json`, installed with `npm install` in its folder on each device (pure JavaScript only, so they work on Android and Windows).
- TypeScript runs through Node's type stripping: only erasable syntax (no `enum`, `namespace` or parameter properties). Import your own files with their extension (`./util.ts`).
- The function may be async and must finish within 10 seconds. Register only while it runs. Don't start timers or processes there; start them from a tool, and stop them in `session_shutdown`.
- `monchu.name`, `dir`, `home`, `device` (hostname, platform, arch, user), `signal` (aborts when the instance retires) and `report(warning)` (a system notice) are there for the plugin's own use.
- A plugin's own settings (a service's URL, which secret holds its token) belong in a gitignored file in the home or in `plugins/local/`, never in a synced plugin's code, so the plugin can sync while each device keeps its own.

### Tools and the prompt cache

Every tool a conversation declares is part of its cached prompt prefix, so exposure matters:

| `exposure`           | The model sees it                                             | Cost                                                                                 |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `deferred` (default) | after `tool_search` loads the plugin's group, `plugin-<name>` | nothing until a conversation loads it; one re-cache then                             |
| `direct`             | in every conversation, from the next request                  | one re-cache of every conversation when added, and again when its definition changes |
| `codemode`           | never; codemode scripts find it with `searchTools()`          | none                                                                                 |

`namespace({ description, instructions, preload })` sets the group's line in the deferred-tools list (default: `package.json`'s `description`), a guide returned once when it loads, and whether conversations on the Claude Code bridge load it from the start. Keep descriptions stable: each edit of a loaded or direct tool re-caches.

Tool names are global: a plugin whose tool name Monchu or an earlier plugin already uses is not loaded.

### Sections

`registerSection(key, render)` adds `<name>_<key>` to the system prompt, inside the shared `plugins` section. A change to its text is patched into the conversation like a home edit. Return nothing to leave it out. The first plugin section a conversation gets re-sends its prompt sections once.

### Events

Handlers use Pi's event names with Durable's arguments, run in plugin then registration order, and a handler that throws is reported once and treated as returning nothing:

| Event                    | Durable hook           | Result                                                              |
| ------------------------ | ---------------------- | ------------------------------------------------------------------- |
| `tool_call`              | `beforeTool`           | `{ block: reason }` refuses the call; `{ arguments }` replaces them |
| `tool_result`            | `afterTool`            | a replacement result                                                |
| `context`                | `beforeRequest`        | `{ messages }` for that request only                                |
| `message_end`            | `afterResponse`        | none                                                                |
| `turn_end`               | `afterTools`           | none                                                                |
| `agent_before_settle`    | `onYield`              | `{ continue: input }` continues the run once                        |
| `session_before_compact` | `beforeCompact`        | `{ decline: true }` or `{ summary }`                                |
| `session_shutdown`       | (the instance retires) | none                                                                |

`tool_call` and `tool_result` also see nested calls (codemode's), with `call.parent` set. A redaction or guard plugin should handle both events.

### Commands

`registerCommand(name, { usage, help, run })` adds `/<name>` to the terminal and the web: it shows in `/help` and the typeahead, and `run(args)` runs in the core and returns the text the client shows. A built-in command of the same name wins, and so does an earlier plugin's.

### Tasks

`registerTask(defineTask(...))` installs a Durable task a plugin's tools create with `tx.createTask`, such as a wait that outlives the turn (a task owned by a conversation stops with it). Name it after the plugin, and register it at every load: Durable resumes pending tasks only when their definition is installed.

### Secrets

`monchu.secrets` reaches the home's secrets by name: `info(name)` (never a value), `value(key, use)` for the plugin's own credentials, `fill(texts, use)` to replace `{{secret:KEY}}` in what a tool sends (a login with a site only when `origin` matches it), and `redacting(tool)` so a tool's streamed output hides stored values. Every use is audited with `use`'s tool and conversation.

### Agents

`monchu.agents` reads and messages Monchu's crew inside a Durable transaction: `whois(tx, id)` says whether a conversation is a front or a worker (with its name, parent and whether it is closed), `messageWorker(tx, worker, text, requestId)` messages a worker as its parent would (reopening it, once per request id), and `updateText`/`noticeText` format a worker update for its front or a notice from Monchu itself. Reach a front with Durable's `conversation(id).submit`. `shortId(id)` is the id Monchu shows.

## Loading, reload and failures

- At startup each plugin loads on its own. One that fails to import, run or validate, whose module doesn't finish loading within 10 seconds, or that takes a tool or task name Monchu or an earlier plugin has, is skipped with a warning that names its file, and Monchu starts anyway.
- The home check (see `docs/internals.md`) runs the same loading after every tool call that changed the home, so a plugin that would fail shows up in that call's result, not at the next reload.
- `/reload` (or the `reload_extensions` tool) imports a fresh copy of a plugin only when one of its files changed. A plugin whose new code fails keeps its last good code; the rest of the reload goes ahead. The reload tool's result names each plugin's state.
- A removed or disabled plugin leaves every conversation at the next reload, which re-caches conversations that had its tools.
- Old module copies stay in memory until `/restart` (Node can't unload ES modules).
- A throw or rejection from a plugin's own code that nothing catches (its timer, a callback, a dropped promise) is told once to every client and the front, and the core runs on. A plugin can still hang the core (a busy loop); that is the trust it runs with.

## What from Pi's extension API is here

Supported: tools (`registerTool`) with `deferred`, `direct` and `codemode` exposure, namespaces with instructions, prompt sections, the events above, slash commands (`registerCommand`, text in and out), Durable tasks, plugin-shipped skills, async setup, shutdown.

Not supported, and why:

- **Shortcuts, flags, and commands with their own UI** (`registerShortcut`, `registerFlag`, `ctx.ui` in a command): Monchu's keys and pickers are client-side, shared by the terminal and the web; a plugin command returns text.
- **UI** (`ctx.ui`, renderers, widgets): Monchu has two clients over a wire, and the web has a size budget. Plugins show results through tool output and notices.
- **`sendMessage`, `sendUserMessage`, `appendEntry`, session control** (`setActiveTools`, model and thinking changes): conversations are Durable's, written through tools and commits. Use a tool's `api.commit` and Durable documents (`defineDoc`) for state.
- **`registerProvider`, `registerVirtualModel`**: models and logins belong to Monchu's `/login`, with its own credential store.
- **`registerMcpServer`**: use the home's `mcp.json`.
- **Session events Monchu has no equivalent for** (`session_before_switch`, `session_before_fork`, `session_tree`, `input`, `user_bash`, provider stream and header events, `model_select`): there is no such moment in Monchu, or it belongs to a client.
- **Wraps of other tools or sections**: Durable has them, but they reach into Monchu's own definitions; not in the API yet.
- **Installing from npm or git**: plugins come only from the home, which you control.
