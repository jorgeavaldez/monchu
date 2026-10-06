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
  CodingTools,
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

/** Pi resolves defaultTools additions/removals; Monchu's own tools are not coding-agent built-ins. */
export function createPiTools(settings: SettingsManager) {
  const commandPrefix = settings.getShellCommandPrefix();
  const codingTools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(commandPrefix === undefined ? {} : { commandPrefix }),
  ];
  const defaults = settings.getDefaultTools() ?? codingTools.map(({ name }) => name);
  return defineExtension({
    name: CodingTools.name,
    tools: [
      ...codingTools,
      sdkTool(createGrepTool, "safe"),
      sdkTool(createFindTool, "safe"),
      sdkTool(createLsTool, "safe"),
      sdkTool(createPowerShellTool, "unsafe"),
    ].filter(({ name }) => defaults.includes(name)),
  });
}
