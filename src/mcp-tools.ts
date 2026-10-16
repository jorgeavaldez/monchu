import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { toolExposure, type McpServerConfig } from "./mcp-config.ts";
import type { McpClients, McpListing, McpTool } from "./mcp.ts";
import type { ToolGroup } from "./tool-search.ts";

/**
 * Claude Code declares Monchu's tools as `mcp__monchu__<name>` and the API caps tool names at 64 characters, so MCP
 * tool names stay within the remaining 51.
 */
const MAX_TOOL_NAME_LENGTH = 51;

/**
 * Pi's MCP tool name, `mcp__<server>__<tool>`, with everything but `[A-Za-z0-9_]` as `_` so it is also the codemode
 * identifier. A name that is too long, or taken by another tool after sanitizing, gets a hash suffix.
 */
function mcpToolName(server: string, tool: string, isTaken: (name: string) => boolean) {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function tool(
  name: string,
  server: string,
  config: McpServerConfig,
  listed: McpTool,
  clients: McpClients,
): ToolRegistration {
  return defineTool({
    name,
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
 * Tools of the MCP servers in `<home>/mcp.json`, from each server's cached listing, exposed as Pi exposes them: `direct`
 * tools in every conversation, `deferred` ones in an `mcp-<server>` group that `tool_search` loads, `codemode` ones (the
 * default) in a group only codemode scripts reach, and `hidden` ones not at all. A server that cannot be listed on this
 * device is left out with a warning.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export async function createMcpTools(
  servers: Readonly<Record<string, McpServerConfig>>,
  clients: McpClients,
) {
  const direct: ToolRegistration[] = [];
  const groups: ToolGroup[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  const enabled = Object.entries(servers).filter(([, config]) => config.enabled !== false);
  const listings = await Promise.allSettled(
    enabled.map(([name, config]) => clients.listing(name, config)),
  );
  enabled.forEach(([server, config], index) => {
    const settled = listings[index];
    if (settled?.status !== "fulfilled") {
      warnings.push(
        settled?.status === "rejected"
          ? settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason)
          : `MCP server ${server} was not listed`,
      );
      return;
    }
    const listed: McpListing = settled.value;
    const deferred: ToolRegistration[] = [];
    const scripted: ToolRegistration[] = [];
    for (const item of listed.tools) {
      const exposure = toolExposure(config, item.name);
      if (exposure === "hidden") continue;
      const name = mcpToolName(server, item.name, (candidate) => names.has(candidate));
      names.add(name);
      const registration = tool(name, server, config, item, clients);
      if (exposure === "direct") direct.push(registration);
      else if (exposure === "deferred") deferred.push(registration);
      else scripted.push(registration);
    }
    const summary = config.description ?? `tools of the ${server} MCP server`;
    const details =
      listed.instructions === undefined ? {} : { details: async () => listed.instructions };
    if (deferred.length)
      groups.push({
        name: `mcp-${server}`,
        summary,
        tools: deferred,
        ...(config.preload === true ? { preload: true } : {}),
        ...details,
      });
    if (scripted.length)
      groups.push({ name: `mcp-${server}`, summary, tools: scripted, codemode: true, ...details });
  });
  return {
    extension: defineExtension({ name: "monchu.mcp-tools", tools: direct }),
    groups,
    warnings,
  };
}
