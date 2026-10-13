import { defineExtension } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { Settings } from "./config.ts";
import { createFffTools, type FffFinders } from "./fff.ts";

/**
 * Config resolves defaultTools additions/removals; Monchu's own tools are separate.
 * Returns warnings for selections that would silently leave Monchu without built-ins.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createPiTools(settings: Settings, finders: FffFinders) {
  const commandPrefix = settings.shellCommandPrefix;
  const codingTools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(commandPrefix === undefined ? {} : { commandPrefix }),
  ];
  const searchTools = createFffTools(finders);
  const tools = [...codingTools, ...searchTools, createPowerShellTool()];
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
  return {
    extension: defineExtension({
      name: "monchu.pi-tools",
      tools: tools.filter(({ name }) => defaults.includes(name)),
    }),
    warnings,
  };
}
