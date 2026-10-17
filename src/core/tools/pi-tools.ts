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
 * Config resolves defaultTools additions/removals; Monchu's own tools are separate.
 * Returns warnings for selections that would silently leave Monchu without built-ins.
 */
export function createPiTools(settings: Settings, finders: FffFinders, vault: Vault) {
  const commandPrefix = settings.shellCommandPrefix;
  const prefix = commandPrefix === undefined ? {} : { commandPrefix };
  // Shells get the secrets a command names in its environment, and their live output is redacted.
  const codingTools = [
    createReadTool({ images }),
    createWriteTool(),
    createEditTool(),
    redacting(createBashTool({ ...prefix, prepare: injectSecrets(vault, "bash") }), vault),
  ];
  const searchTools = createFffTools(finders);
  const tools = [
    ...codingTools,
    ...searchTools,
    redacting(createPowerShellTool({ prepare: injectSecrets(vault, "powershell") }), vault),
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
