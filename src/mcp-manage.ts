import type { McpSignInPrompt } from "./mcp-auth.ts";
import { loadMcpConfig, usesOAuth, type McpServerConfig } from "./mcp-config.ts";
import type { McpClients, McpState } from "./mcp.ts";

/** One server as `/mcp` and `monchu mcp list` show it. */
export type McpServerReport = {
  name: string;
  enabled: boolean;
  exposure: string;
  transport: string;
  /** How it signs in: `oauth` (a 401 asks for a browser sign-in), `provider`, `headers`, or `none`. */
  auth: "oauth" | "provider" | "headers" | "none";
  state: McpState | "disabled";
  tools: string[];
  error?: string;
};

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

/** Lines for a terminal: each server's state, transport, sign-in hint, tools, and error. */
export function formatReports(
  { servers, errors }: { servers: McpServerReport[]; errors: string[] },
  login: (name: string) => string,
): string[] {
  const lines: string[] = [];
  if (servers.length === 0 && errors.length === 0)
    lines.push("No MCP servers configured. Add one with monchu mcp add.");
  for (const server of servers) {
    const state =
      server.state === "connected"
        ? `connected, ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
        : server.state === "needs-auth"
          ? "needs sign-in"
          : server.state === "missing"
            ? "not installed here"
            : server.state;
    lines.push(`${server.name}: ${state} (${server.exposure}, sign-in: ${server.auth})`);
    lines.push(`  ${server.transport}`);
    if (server.state === "needs-auth") lines.push(`  sign in with: ${login(server.name)}`);
    if (server.tools.length) lines.push(`  tools: ${server.tools.join(", ")}`);
    if (server.error !== undefined && server.state !== "needs-auth")
      lines.push(`  ${server.error.split("\n").join("\n  ")}`);
  }
  for (const error of errors) lines.push(`config error: ${error}`);
  return lines;
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
