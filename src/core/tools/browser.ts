import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { rootOf } from "../agents/workers.ts";
import type { ToolGroup } from "./tool-search.ts";

/** Durable's default tool output limits, which its shell tools also spill at. */
const SPILL = { afterBytes: 50 * 1024, afterLines: 2000 };

/** Run `agent-browser` directly, without a shell, streaming its output into the call. */
async function run(
  api: ToolExecutionApi,
  args: readonly string[],
  context: Context,
  timeout?: number,
): Promise<void> {
  const env = api.env;
  if (env === undefined) throw new Error("agent_browser needs an execution environment");
  const result = await env.exec(
    ["agent-browser", ...args],
    {
      ...(timeout === undefined ? {} : { timeout }),
      onOutput: (text, _context, info) => api.output(text, info.skipped),
      spill: SPILL,
      ...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
    },
    context,
  );
  const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
  if (spillPath !== undefined)
    api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spillPath}` });
  if (!result.ok) {
    if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
    if (result.error.code === "spawn_error")
      throw new Error(
        `agent-browser is not installed or not on PATH (${result.error.message}); install it with npm install -g agent-browser`,
      );
    if (result.error.code === "timeout")
      throw new Error(`agent-browser timed out after ${timeout} seconds`);
    throw result.error;
  }
  if (result.value.exitCode !== 0)
    throw new Error(`agent-browser exited with code ${result.value.exitCode}`);
}

/** Capture one command's whole output, for the guide. */
async function capture(api: ToolExecutionApi, args: readonly string[], context: Context) {
  const env = api.env;
  if (env === undefined) return undefined;
  let text = "";
  const result = await env.exec(
    ["agent-browser", ...args],
    { timeout: 30, onOutput: (chunk) => (text += chunk) },
    context,
  );
  if (!result.ok || result.value.exitCode !== 0)
    throw new Error(
      result.ok
        ? `agent-browser ${args.join(" ")} exited ${result.value.exitCode}`
        : result.error.message,
    );
  return text;
}

/**
 * `agent_browser`: the agent-browser CLI as a deferred group. Every conversation under one root shares a named browser
 * session, so workers see the pages their root opened. Loading the group returns the CLI's own version-matched guide.
 */
export const Browser: ToolGroup = {
  name: "browser",
  preload: true,
  summary:
    "drive a real browser with agent-browser: open pages, snapshot, click, fill, screenshot. For pages that need interaction or JavaScript; use web search and scrape for reading. Stop at explicit boundaries; ask before purchases, account or security changes and destructive actions; never bypass CAPTCHAs or drive public search-engine forms",
  tools: [
    defineTool({
      name: "agent_browser",
      description:
        'Run one agent-browser command in this conversation tree\'s shared browser session, for example `{ "args": ["open", "https://example.com"] }`, `["snapshot", "-i"]`, `["click", "@e3"]`, or `["batch", "--bail", "open https://example.com", "snapshot -i"]`. Arguments go to the CLI unparsed, without a shell. Refresh snapshot refs after every navigation, and check the page after acting. `["close"]` closes the session when you are done. `["skills", "get", "core"]` shows the guide again.',
      parameters: Type.Object(
        {
          args: Type.Array(Type.String(), {
            minItems: 1,
            description: "agent-browser arguments after the program name",
          }),
          timeout: Type.Optional(
            Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" }),
          ),
        },
        { additionalProperties: false },
      ),
      outputLimits: { retain: "head" },
      execute: async ({ args, timeout }, api, context) => {
        if (args.some((arg) => arg === "--session" || arg.startsWith("--session=")))
          throw new Error("agent_browser chooses the session itself; drop --session");
        const guide = args[0] === "skills";
        await run(
          api,
          guide
            ? args
            : [
                "--session",
                `monchu-${await api.commit((tx) => rootOf(tx, api.conversationId), context)}`,
                ...args,
              ],
          context,
          timeout,
        );
        return {};
      },
    }),
  ],
  details: (api, context) => capture(api, ["skills", "get", "core"], context),
};
