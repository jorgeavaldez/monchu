# Plugins

A plugin is a folder of code that adds tools, prompt sections and event handlers to Monchu, in the shape of [Pi's extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). Monchu turns each one into a Durable extension. Plugins are trusted code: they run in Monchu's core process with your permissions, and nothing sandboxes them. Put anything heavy, flaky or untrusted in an [MCP server](setup.md) instead, which runs in its own process.

## Where they live

```
<home>/plugins/<name>/         synced with the home, so it runs on every device
<home>/plugins/local/<name>/   this device only (gitignored)
  index.ts or index.js         default export: a function that receives the plugin API
  package.json                 optional: "type": "module", a description, the plugin API versions it works with, pure-JS dependencies
  skills/                      optional: skills that ship with the plugin
<home>/plugins.local.json      optional, gitignored: this device's { "disabled": [...], "settings": { ... } }
```

- A name is lowercase letters, digits and dashes. A device's own plugin replaces a synced one of the same name, and both replace a bundled one.
- Monchu ships bundled plugins too (`src/plugins/`): `clef` (routing advice), `fnox` (keeps secret values in [fnox](https://fnox.jdx.dev)), `jj` (Jujutsu), `herdr` (Herdr agents) and `browser` (`agent_browser`, over the agent-browser CLI). They use the same API, load the same way, and `disabled` turns them off too. Each wraps one tool or service a user may not have; what belongs in the core and what in a plugin is in the repository's `AGENTS.md`.
- If `plugins.local.json` can't be read or parsed, no home plugin loads (bundled ones still do) and a warning says why.
- Plugins are only read from the home. Monchu never loads code from a conversation's directory or a project.

## Settings

A plugin's settings live in two places, read together as `monchu.config`:

- **Shared**, synced to every device: `"plugins": { "<name>": ... }` in the home's `config.json`.
- **This device**, gitignored: `"settings": { "<name>": ... }` in `plugins.local.json`; `null` there turns a shared setting off on this device. A local service's address, which secret holds its token, anything that differs per device. When both are objects, the device's fields win one by one; otherwise the device's value replaces the shared one.

Settings never go in a plugin's code, so a synced plugin can run everywhere while each device keeps its own. `monchu.saveConfig(value)` writes the shared ones and `saveConfig(value, { device: true })` this device's; the next reload runs the plugin with them.

## Versions

`monchu.apiVersion` is the plugin API this Monchu has (`PLUGIN_API_VERSION` in `monchu/plugin`, 2 now). A plugin synced to devices that update at different times says which versions it works with in `package.json`, `"monchu": { "api": 2 }` or `[1, 2]`, and a Monchu without one of them skips it with a warning instead of loading code that would fail. A plugin that supports several checks `apiVersion` itself; Monchus from before version 2 have none.

## Writing one

The API follows [Pi's extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): tools are Pi tool definitions, handlers get Pi's `(event, ctx)` and return Pi's results, commands take `description` and `handler(args, ctx)`, and `ctx.ui` has `notify` and `setStatus`. What is Monchu's own, with no Pi counterpart, says so.

```ts
import { defineTool, Type, type PluginApi } from "monchu/plugin";

export default function (monchu: PluginApi) {
  monchu.registerTool(
    defineTool({
      name: "homelab_status",
      label: "Homelab status",
      description: "Status of every homelab service",
      parameters: Type.Object({}),
      namespace: {
        description: "Homelab status and restarts",
        instructions: "Ask before restarting.",
      },
      replay: "safe",
      execute: async (_id, _params, _signal, _update, ctx) => {
        ctx.ui.notify("checking the homelab");
        return { content: [{ type: "text", text: "all green" }] };
      },
    }),
  );
  monchu.registerSection("hosts", () => "dev, proxmox, plex");
  monchu.on("tool_call", (event) =>
    event.toolName === "bash" && /rm -rf \//.test(String(event.input.command))
      ? { block: true, reason: "not that" }
      : undefined,
  );
  monchu.registerCommand("homelab", {
    description: "homelab status",
    handler: async (_args, ctx) => ctx.ui.notify("all green"),
  });
}
```

- Import `monchu/plugin`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` and `typebox` as bare names. Monchu resolves them to its own copies, so never install them into the plugin. Other dependencies go in the plugin's `package.json`, installed with `npm install` in its folder on each device (pure JavaScript only, so they work on Android and Windows).
- TypeScript runs through Node's type stripping: only erasable syntax (no `enum`, `namespace` or parameter properties). Import your own files with their extension (`./util.ts`).
- The module must finish loading, and the function running, within 10 seconds each; the function may be async. Register only while it runs. Don't start timers or processes there; start them from a tool, and stop them in `session_shutdown`.
- `monchu.name`, `dir`, `home`, `device` (hostname, platform, arch, user), `signal` (aborts when the instance retires) and `report(warning)` (a system notice) are there for the plugin's own use.

### Tools and the prompt cache

A tool is Pi's `ToolDefinition`: `name`, `label`, `description`, `parameters`, `exposure`, `namespace`, `outputSchema`, `executionMode` and `execute(toolCallId, params, signal, onUpdate, ctx)`, which returns `{ content, details, structuredContent, isError }` or throws for an error result. Monchu's own fields: `replay` (`safe` lets an interrupted call run again after a restart) and `outputLimits`; `ctx.durable` has Durable's tool API (`output()`, `commit()`, `executeTool()`, documents) and the call's context.

Every tool a conversation declares is part of its cached prompt prefix, so exposure matters. Monchu's default is `deferred`, not Pi's `direct`:

| `exposure`           | The model sees it                                             | Cost                                                                                 |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `deferred` (default) | after `tool_search` loads the plugin's group, `plugin-<name>` | nothing until a conversation loads it; one re-cache then                             |
| `direct`             | in every conversation, from the next request                  | one re-cache of every conversation when added, and again when its definition changes |
| `codemode`           | never; codemode scripts find it with `searchTools()`          | none                                                                                 |

A plugin's tools of one exposure form one group. Its `namespace`, from the first tool that has one, sets the group's line in the deferred-tools list (default: `package.json`'s `description`), a guide returned once when it loads (`instructions`: a text, or Monchu's own, a function that writes it then, such as a CLI's version-matched help), and with `preload` whether conversations on the Claude Code bridge load it from the start. Keep descriptions stable: each edit of a loaded or direct tool re-caches.

Tool names are global: a plugin whose tool or task name Monchu or an earlier plugin already uses is not loaded.

### Sections

`registerSection(key, render)` (Monchu's own) adds `<name>_<key>` to the system prompt, inside the shared `plugins` section. A change to its text joins the conversation's transcript once, where it changes, like a home edit, and stays there for every later request: the way to give the model per-message context without costing the prompt cache. Return nothing to leave it out. The first plugin section a conversation gets re-sends its prompt sections once.

### Events

`monchu.on(event, handler)` takes Pi's event names; handlers get `(event, ctx)` and run in plugin then registration order. `ctx` has the conversation's id, `ui` and `signal`, and `durable` (Durable's hook API and context) in model and tool events.

| Event                    | Result                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool_call`              | `{ block: true, reason }` refuses the call; mutate `event.input` to change it                                                                                      |
| `tool_result`            | `{ content, details, structuredContent, isError }` replace the result's                                                                                            |
| `context`                | `{ messages }` for that request only (a section is the cache-safe way to add context)                                                                              |
| `message_end`            | none                                                                                                                                                               |
| `turn_end`               | none                                                                                                                                                               |
| `agent_before_settle`    | `{ continue: true, message }` runs once more                                                                                                                       |
| `session_before_compact` | `{ cancel: true }`, or `{ compaction: { summary } }` replaces the summarizer                                                                                       |
| `session_shutdown`       | none (`reason`: `reload` or `quit`)                                                                                                                                |
| `input`                  | the user's message to a front: `{ action: "transform", text }` or `"handled"`; Monchu's own `admitted(tx, submission)` runs in a commit right after it is admitted |
| `input_change`           | Monchu's own: a front's queued message was edited or withdrawn, inside that commit                                                                                 |
| `front_reply`            | Monchu's own: a front's message joined the user's inbox, inside that commit (`entry`, `text`, `headline`); label it with `agents.labelReply`                       |

Guards fail closed, as in Pi: a `tool_call` handler that throws blocks the call, and a `tool_result` handler that throws withholds the result. The one exception is Monchu's way to fix a plugin, which a broken guard must never take away: `reload_extensions`, `request_restart`, and `read`, `write` or `edit` of a file under `plugins/` or of `plugins.local.json` by absolute path go ahead past a handler that throws (a guard that returns `block` still blocks them). Any other handler that throws counts as returning nothing. Each failure is reported once. `tool_call` and `tool_result` also see nested calls (codemode's), with `parentToolCallId` set, so a redaction or guard plugin covers both. `input` runs on every attempt, a client's retry of the same message included, so anything it does besides answering must be safe to repeat; a `transform` without text is ignored. `agent_before_settle` has no cap, as in Pi: guard its condition. `session_shutdown` reaches only a copy that ran: the home check's copy and a failed reload's share the running copy's module state and get no call.

### Commands

`registerCommand(name, { description, usage, handler })` adds `/<name>` to the terminal and the web: it shows in `/help` and the typeahead, and `handler(args, ctx)` runs in the core for the root and conversation the client shows. What it sends to `ctx.ui.notify` is the command's answer. `ctx.caller` is `person` for a person's login and `service` for a service token, so a command can keep a destructive action to people. A built-in command of the same name wins, and so does an earlier plugin's.

### UI

`ctx.ui.notify(message)` shows a line once in every client showing the conversation's root, and `ctx.ui.setStatus(key, text)` keeps a line per key that a client shows when it opens the root (`undefined` clears it). Neither reaches the model. Code outside a handler, such as a task, uses `monchu.ui(conversationId)`.

### Models and logins

`monchu.models` reads and calls the home's models, as Pi's `ctx.modelRegistry`: catalogs, `checkAuth`, `complete`, `classify`. `registerProvider(provider)` adds a pi-ai provider: `/login` offers it under its name and stores its credentials like any other's, and a role on it applies from the next reload. `wantsLogin(provider, purpose)` (Monchu's own) names an optional login the plugin works with, so startup and `/login` say what turning it on gives.

### Tasks

`registerTask(defineTask(...))` (Monchu's own) installs a Durable task a plugin's tools create with `tx.createTask`, such as a wait that outlives the turn (a task owned by a conversation stops with it). Name it after the plugin, and register it at every load: Durable resumes pending tasks only when their definition is installed.

### Secrets

`monchu.secrets` (Monchu's own) reaches the home's secrets by name: `info(name)` (never a value), `value(key, use)` for the plugin's own credentials, `fill(texts, use)` to replace `{{secret:KEY}}` in what a tool sends (a login with a site only when `origin` matches it), and `redacting(tool)` so a tool's streamed output hides stored values. Every use is audited with `use`'s tool and conversation.

`registerSecretStore(store)` (Monchu's own) keeps the values: `write(key, value)`, `remove(key)` (an absent key is no error) and `readAll()`, by environment-variable key (a login's are `NAME_USERNAME` and `NAME_PASSWORD`). Monchu has no store of its own; the bundled `fnox` plugin is the default one. Monchu keeps names, kinds, sites and use in `<home>/secrets/index.json` and reads values once, until the next change; a store's errors must never carry a value. One plugin keeps the secrets: a second that registers a store is not loaded, so turn `fnox` off in `plugins.local.json` to use your own. The store follows the running build, so the home check's copy or a failed reload never replaces it; with no store loaded, setting or using a secret fails and says so.

### Agents

`monchu.agents` (Monchu's own) reads and messages Monchu's crew inside a Durable transaction: `whois(tx, id)` says whether a conversation is a front or a worker, `workers(tx, front)` and `goals(tx, front)` list a front's crew and goals, `rootOf(tx, id)` the front a conversation's crew answers to, `messageWorker(tx, worker, text, requestId)` messages a worker as its parent would, `updateText`/`noticeText` format a worker update or a notice from Monchu itself, `labelReply(tx, front, entry, label)` labels a message in the user's inbox (its kind and goal; never over the front's own label), and `profiles` are the worker profiles. Reach a front with Durable's `conversation(id).submit`. `shortId(id)` is the id Monchu shows.

## Loading, reload and failures

- At startup each plugin loads on its own. One that fails to import, run or validate, whose module doesn't finish loading within 10 seconds, or that takes a tool or task name Monchu or an earlier plugin has, is skipped with a warning that names its file, and Monchu starts anyway.
- The home check (see `docs/internals.md`) runs the same loading after every tool call that changed the home, so a plugin that would fail shows up in that call's result, not at the next reload.
- `/reload` (or the `reload_extensions` tool) imports a fresh copy of a plugin only when one of its files changed. A plugin whose new code fails keeps its last good code; the rest of the reload goes ahead. The reload tool's result names each plugin's state.
- A removed or disabled plugin leaves every conversation at the next reload, which re-caches conversations that had its tools.
- Old module copies stay in memory until `/restart` (Node can't unload ES modules).
- A throw or rejection that nothing catches, whose stack names a plugin's files (its timer, a callback, a dropped promise), is told to every client and the front, and the core runs on. Only a plugin's first such failure is told until its code changes.
- Anything worse (`process.exit`, a failure whose stack names no plugin, a busy loop while the core starts) takes the core down, and the server brings it back: at once in safe mode, without home plugins, when it failed to start or crashed twice within 10 minutes. The front is told why; fix the plugin, then `/restart` loads the home's plugins again (see `docs/internals.md`, Server, core, clients). A busy loop once the core runs still hangs it: that is the trust a plugin runs with.

## What from Pi's extension API is here

Supported: tools in Pi's shape with `deferred`, `direct` and `codemode` exposure and namespaces, the events above, slash commands, `ctx.ui.notify` and `setStatus`, providers, nested model calls through `monchu.models`, plugin-shipped skills, async setup, shutdown. Monchu adds sections, Durable tasks, front input events, secrets and the crew.

Not supported, and why:

- **Shortcuts, flags, dialogs and custom UI** (`registerShortcut`, `registerFlag`, `ctx.ui.select`/`confirm`/`input`, renderers, widgets): Monchu's keys and pickers are client-side, shared by a terminal and a web page over a wire, and the web has a size budget.
- **`sendMessage`, `sendUserMessage`, `appendEntry`, session control** (`setActiveTools`, model and thinking changes): conversations are Durable's, written through commits. Use `ctx.durable.api.commit`, Durable documents (`defineDoc`) and a conversation's `submit`.
- **`registerVirtualModel`**: roles name real models.
- **`registerMcpServer`**: use the home's `mcp.json`.
- **Events Monchu has no moment for** (`session_before_switch`, `session_before_fork`, `session_tree`, `user_bash`, provider stream and header events, `model_select`, `before_agent_start`): there is no such moment, or it belongs to a client. `context_with_system` is `context` here.
- **Wraps of other tools or sections**: Durable has them, but they reach into Monchu's own definitions; not in the API yet.
- **Installing from npm or git**: plugins come only from the home, which you control.
