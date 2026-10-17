/** One routing answer with the model's probability for it. */
type Answer<T extends string> = { choice: T; probability: number };

/** The routing helper's answers for one front input, or why it has none. */
export type AssessmentResult =
  | {
      status: "routed";
      route: Answer<"front" | "worker">;
      /** `new` when no listed worker fits; `null` when there were no workers to choose from. */
      worker: Answer<string> | null;
      split: Answer<"one" | "several">;
      /** The worker profile the work fits; `null` without two distinct profiles to choose from. */
      profile: Answer<string> | null;
      usage: { input: number; output: number; costUsd: number } | null;
    }
  | { status: "failed"; message: string };

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A short label of the answers, for escalations and clients. */
export function describeAssessment(result: AssessmentResult): string {
  if (result.status === "failed") return `unavailable (${result.message})`;
  const parts = [
    `${result.route.choice === "worker" ? "needs a worker" : "front can answer"} (${percent(result.route.probability)})`,
  ];
  if (result.worker !== null)
    parts.push(
      result.worker.choice === "new"
        ? `new line of work (${percent(result.worker.probability)})`
        : `continues ${result.worker.choice} (${percent(result.worker.probability)})`,
    );
  if (result.split.choice === "several")
    parts.push(`several lines of work (${percent(result.split.probability)})`);
  if (result.profile !== null)
    parts.push(`fits ${result.profile.choice} (${percent(result.profile.probability)})`);
  return parts.join(", ");
}

export type McpState = "connected" | "needs-auth" | "missing" | "failed";

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
