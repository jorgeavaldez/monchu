import type { Static, Tool, ToolResultMessage, TSchema } from "@earendil-works/pi-ai";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

/** Keep SDK-only built-ins inside one Durable invocation, with its cancellation and replay policy. */
function sdkTool<TParameters extends TSchema>(
  factory: (cwd: string) => Tool<TParameters> & {
    execute(
      callId: string,
      args: Static<TParameters>,
      signal?: AbortSignal,
    ): Promise<{ content: ToolResultMessage["content"] }>;
  },
  replay: "safe" | "unsafe",
) {
  const definition = factory("");
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    replay,
    execute: async (args, api, context) => {
      if (api.env === undefined)
        throw new Error("Pi built-ins require a local execution environment");
      const result = await factory(api.env.cwd).execute(api.callId, args, context.abortSignal);
      return { content: result.content };
    },
  });
}

/**
 * Pi resolves defaultTools additions/removals; Monchu's own tools are not coding-agent built-ins.
 * Returns warnings for selections that would silently leave Monchu without built-ins.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createPiTools(settings: SettingsManager, platform: NodeJS.Platform) {
  const commandPrefix = settings.getShellCommandPrefix();
  const codingTools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(commandPrefix === undefined ? {} : { commandPrefix }),
  ];
  const tools = [
    ...codingTools,
    sdkTool(createGrepTool, "safe"),
    sdkTool(createFindTool, "safe"),
    sdkTool(createLsTool, "safe"),
    sdkTool(createPowerShellTool, "unsafe"),
  ];
  const defaults = settings.getDefaultTools() ?? codingTools.map(({ name }) => name);
  const warnings: string[] = [];
  const unknown = defaults.filter((name) => !tools.some((tool) => tool.name === name));
  if (unknown.length)
    warnings.push(`Pi defaultTools has unknown built-ins (ignored): ${unknown.join(", ")}`);
  if (!codingTools.some(({ name }) => defaults.includes(name)))
    warnings.push(
      "Pi defaultTools selects none of read, write, edit, bash; Monchu has no file or shell built-ins",
    );
  // Pi's grep/find need rg/fd; on Termux its tool manager cannot provide them, so the calls would fail.
  const unavailable = platform === "android" ? ["grep", "find"] : [];
  const skipped = unavailable.filter((name) => defaults.includes(name));
  if (skipped.length)
    warnings.push(
      `Pi ${skipped.join("/")} unavailable on Android; use bash with rg/fd on PATH instead`,
    );
  return {
    extension: defineExtension({
      name: "monchu.pi-tools",
      tools: tools.filter(({ name }) => defaults.includes(name) && !unavailable.includes(name)),
    }),
    warnings,
  };
}
