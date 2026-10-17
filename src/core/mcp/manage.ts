import type { McpSignInPrompt } from "./auth.ts";
import { loadMcpConfig, usesOAuth, type McpServerConfig } from "./config.ts";
import type { McpServerReport } from "../../api/reports.ts";
import type { McpClients } from "./index.ts";

function describeTransport(config: McpServerConfig): string {
  return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

function authOf(config: McpServerConfig): McpServerReport["auth"] {
  if (!("url" in config)) return "none";
  if (config.auth !== undefined) return "provider";
  return usesOAuth(config) ? "oauth" : "headers";
}

/** Connect to every configured server now and report its state and tools; config errors come separately. */
export async function mcpReports(
  home: string,
  clients: McpClients,
): Promise<{ servers: McpServerReport[]; errors: string[] }> {
  const { servers, errors } = await loadMcpConfig(home);
  const reports = await Promise.all(
    Object.entries(servers).map(async ([name, config]): Promise<McpServerReport> => {
      const report: McpServerReport = {
        name,
        enabled: config.enabled !== false,
        exposure: config.exposure ?? "codemode",
        transport: describeTransport(config),
        auth: authOf(config),
        state: "disabled",
        tools: [],
      };
      if (!report.enabled) return report;
      return { ...report, ...(await clients.status(name, config)) };
    }),
  );
  return { servers: reports, errors };
}

async function configured(home: string, name: string): Promise<McpServerConfig> {
  const { servers, errors } = await loadMcpConfig(home);
  const config = servers[name];
  if (config !== undefined) return config;
  const invalid = errors.find((error) => error.includes(`"${name}"`));
  throw new Error(
    invalid ??
      `No MCP server named "${name}". Configured: ${Object.keys(servers).join(", ") || "none"}.`,
  );
}

/** Sign in to a configured OAuth server, as Pi's `mcp login`: a server that already connects is only reported. */
export async function mcpLogin(
  home: string,
  clients: McpClients,
  name: string,
  prompt: McpSignInPrompt,
  signal: AbortSignal,
): Promise<string> {
  const result = await clients.login(name, await configured(home, name), prompt, signal);
  const tools = result.listing.tools.length;
  return result.signedIn
    ? `Signed in to MCP server "${name}" (${tools} tools).`
    : `Already signed in to MCP server "${name}" (${tools} tools).`;
}

export async function mcpLogout(home: string, clients: McpClients, name: string): Promise<string> {
  return (await clients.logout(name, await configured(home, name)))
    ? `Signed out of MCP server "${name}".`
    : `No stored credentials for MCP server "${name}".`;
}
