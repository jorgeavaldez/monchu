import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { McpServerConfig } from "./config.ts";
import type { McpClients, McpListing, McpTool } from "./mcp.ts";
import type { ToolGroup } from "./tool-search.ts";

/** Durable and the Claude Code bridge both accept these names; providers cap them at 64. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function tool(
  server: string,
  config: McpServerConfig,
  listed: McpTool,
  clients: McpClients,
): ToolRegistration {
  return defineTool({
    name: `${server}_${listed.name}`,
    description: listed.description ?? `${listed.name} from the ${server} MCP server`,
    // The server validates its own arguments; the declaration is its schema as listed.
    parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", ...listed.inputSchema }),
    // Only tools the server marks read-only may run again after a crash.
    replay: listed.readOnly ? "safe" : "unsafe",
    execute: async (args, _api, context) => {
      const result = await clients.call(server, config, listed.name, args, context.abortSignal);
      return {
        content: result.content.length ? result.content : [{ type: "text", text: "(no output)" }],
        isError: result.isError,
      };
    },
  });
}

/**
 * Tools of the MCP servers in `<home>/mcp.json`, from each server's cached listing. A server's tools are deferred into
 * one `mcp-<server>` group unless the server or the tool is `direct`, which puts it in every conversation. A server
 * that cannot be listed is left out with a warning.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export async function createMcpTools(
  servers: Readonly<Record<string, McpServerConfig>>,
  clients: McpClients,
) {
  const direct: ToolRegistration[] = [];
  const groups: ToolGroup[] = [];
  const warnings: string[] = [];
  const enabled = Object.entries(servers).filter(([, config]) => config.enabled !== false);
  const listings = await Promise.allSettled(
    enabled.map(([name, config]) => clients.listing(name, config)),
  );
  enabled.forEach(([name, config], index) => {
    const settled = listings[index];
    if (settled?.status !== "fulfilled") {
      warnings.push(
        settled?.status === "rejected"
          ? settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason)
          : `MCP server ${name} was not listed`,
      );
      return;
    }
    const listed: McpListing = settled.value;
    const deferred: ToolRegistration[] = [];
    for (const item of listed.tools) {
      if (!TOOL_NAME.test(`${name}_${item.name}`)) {
        warnings.push(`MCP tool ${name}/${item.name} has a name Monchu cannot declare; skipped`);
        continue;
      }
      const exposure = config.toolExposure?.[item.name] ?? config.exposure ?? "deferred";
      (exposure === "direct" ? direct : deferred).push(tool(name, config, item, clients));
    }
    const unknown = Object.keys(config.toolExposure ?? {}).filter(
      (item) => !listed.tools.some((listedTool) => listedTool.name === item),
    );
    if (unknown.length)
      warnings.push(`MCP server ${name} lists no tools named ${unknown.join(", ")}`);
    if (deferred.length)
      groups.push({
        name: `mcp-${name}`,
        summary: config.description ?? `tools of the ${name} MCP server`,
        tools: deferred,
        ...(listed.instructions === undefined ? {} : { details: async () => listed.instructions }),
      });
  });
  return {
    extension: defineExtension({ name: "monchu.mcp-tools", tools: direct }),
    groups,
    warnings,
  };
}
