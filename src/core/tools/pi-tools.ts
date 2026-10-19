import { defineExtension, section } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { Settings } from "../config.ts";
import { injectSecrets, redacting } from "../secrets/tool.ts";
import type { Vault } from "../secrets/vault.ts";
import { createFffTools, type FffFinders } from "./fff.ts";
import { imageBudget, images } from "./images.ts";

/**
 * pi-fff 0.11.0's promptSnippet and promptGuidelines (MIT, see src/fff.ts), which Pi puts in the system prompt.
 * Kept here, not in fff.ts: fff.ts is host code loaded once, and this module is reloaded.
 */
const FFF_PROMPT = {
  fffind: {
    snippet: "Find files by path or glob",
    guidelines: [
      "fffind: matches the WHOLE path, not just the filename — `profile` hits `chrome/browser/profiles/x.cc` too.",
      "fffind: keep queries to 1-2 terms; extra words narrow.",
      "fffind: use for paths, not content. Use ffgrep for content.",
      "fffind: for exact path matches use a glob in `path` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.",
      "fffind: to list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.",
      "fffind: use exclude: 'test/,*.min.js' to cut noise in large repos.",
    ],
  },
  ffgrep: {
    snippet: "Grep contents",
    guidelines: [
      "ffgrep: prefer bare identifiers as patterns. Literal queries are most efficient.",
      "ffgrep: use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
      "ffgrep: caseSensitive: true when you need exact case (smart-case otherwise).",
      "ffgrep: after 1-2 greps, read the top match instead of more greps.",
    ],
  },
} as const;

/**
 * A shell call without its own timeout stops after `seconds` (0: never), so a hung command can't hold a worker, and
 * the messages queued for it, until someone notices. The declaration stays Pi's, byte for byte, for the prompt cache;
 * the error says what happened and what to do instead.
 */
function bounded(tool: ReturnType<typeof createBashTool>, seconds: number) {
  if (seconds === 0) return tool;
  const limit = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
  const execute: typeof tool.execute = async (args, api, context) => {
    if (args.timeout !== undefined) return tool.execute(args, api, context);
    try {
      return await tool.execute({ ...args, timeout: seconds }, api, context);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== `Command timed out after ${seconds} seconds`
      )
        throw error;
      throw new Error(
        `Command stopped after ${limit}, the limit for a call without a timeout, so it never leaves you unreachable. If it may hang, fix the command. If it is long work, run it as a job of type bg (you stay free for messages and get its result when it ends), or pass a timeout to wait for it here.`,
        { cause: error },
      );
    }
  };
  return { ...tool, execute };
}

/**
 * Config resolves defaultTools additions/removals; Monchu's own tools are separate.
 * Returns warnings for selections that would silently leave Monchu without built-ins.
 */
export function createPiTools(settings: Settings, finders: FffFinders, vault: Vault) {
  const commandPrefix = settings.shellCommandPrefix;
  const prefix = commandPrefix === undefined ? {} : { commandPrefix };
  // Shells get the secrets a command names in its environment, and their live output is redacted.
  const limit = settings.shellTimeout;
  const codingTools = [
    createReadTool({ images }),
    createWriteTool(),
    createEditTool(),
    redacting(
      bounded(createBashTool({ ...prefix, prepare: injectSecrets(vault, "bash") }), limit),
      vault,
    ),
  ];
  const searchTools = createFffTools(finders);
  const tools = [
    ...codingTools,
    ...searchTools,
    redacting(
      bounded(createPowerShellTool({ prepare: injectSecrets(vault, "powershell") }), limit),
      vault,
    ),
  ];
  const defaults =
    settings.defaultTools ?? [...codingTools, ...searchTools].map(({ name }) => name);
  const warnings: string[] = [];
  const unknown = defaults.filter((name) => !tools.some((tool) => tool.name === name));
  if (unknown.length)
    warnings.push(`Monchu defaultTools has unknown built-ins (ignored): ${unknown.join(", ")}`);
  if (!codingTools.some(({ name }) => defaults.includes(name)))
    warnings.push(
      "Monchu defaultTools selects none of read, write, edit, bash; Monchu has no file or shell built-ins",
    );
  const search = Object.entries(FFF_PROMPT).filter(([name]) => defaults.includes(name));
  const searchPrompt = search.length
    ? [
        "Search tools:",
        ...search.map(([name, { snippet }]) => `- ${name}: ${snippet}`),
        "Use these instead of bash grep/find/rg for file and content search.",
        ...search.flatMap(([, { guidelines }]) => guidelines.map((line) => `- ${line}`)),
      ].join("\n")
    : undefined;
  return {
    extension: defineExtension({
      name: "monchu.pi-tools",
      tools: tools.filter(({ name }) => defaults.includes(name)),
      sections: [section("search_tools", () => searchPrompt, { tag: false })],
      hooks: imageBudget(),
    }),
    warnings,
  };
}
