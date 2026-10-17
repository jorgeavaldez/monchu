import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { herdrAgent } from "../src/tui/herdr-agent.ts";
import { waitFor } from "./support.ts";

type Request = { method: string; params: Record<string, unknown> };

let server: Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  await new Promise((resolve) =>
    server === undefined ? resolve(undefined) : server.close(resolve),
  );
  server = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A Herdr socket that answers each request line, as Herdr's API does, and records it. */
async function herdr(): Promise<{ env: NodeJS.ProcessEnv; requests: Request[] }> {
  directory = await mkdtemp(join(tmpdir(), "monchu-herdr-"));
  const name = `monchu-herdr-${process.pid}-${Date.now()}`;
  const socket = process.platform === "win32" ? name : join(directory, "herdr.sock");
  const requests: Request[] = [];
  const listening = createServer((connection) => {
    let buffer = "";
    connection.on("data", (data) => {
      buffer += data.toString();
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const parsed: unknown = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("method" in parsed) ||
          typeof parsed.method !== "string" ||
          !("params" in parsed) ||
          typeof parsed.params !== "object" ||
          parsed.params === null
        )
          throw new Error("Unexpected Herdr request");
        requests.push({ method: parsed.method, params: { ...parsed.params } });
        connection.write(`${JSON.stringify({ result: {} })}\n`);
      }
    });
  });
  server = listening;
  await new Promise<void>((resolve) =>
    listening.listen(process.platform === "win32" ? `\\\\.\\pipe\\${name}` : socket, resolve),
  );
  return {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p1" },
    requests,
  };
}

it("reports Monchu's state changes to its Herdr pane in order, and releases the pane", async () => {
  const { env, requests } = await herdr();
  const agent = herdrAgent(env);
  if (agent === undefined) throw new Error("Expected a Herdr reporter");
  agent.report("working");
  agent.report("working");
  agent.report("blocked", "login");
  agent.report("idle");
  await waitFor(() => requests.at(-1)?.params.state === "idle");
  await agent.release();
  const reports = requests.filter((request) => request.method === "pane.report_agent");
  // An unchanged state is not sent again; a burst may skip to its newest state, never reorder.
  expect(reports.map((request) => request.params.state).join(" ")).toMatch(
    /^working (blocked )?idle$/,
  );
  for (const report of reports)
    expect(report.params).toMatchObject({ pane_id: "w1:p1", source: "monchu", agent: "monchu" });
  const seqs = requests.map((request) => Number(request.params.seq));
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(requests.at(-1)).toMatchObject({
    method: "pane.release_agent",
    params: { pane_id: "w1:p1", source: "monchu", agent: "monchu" },
  });
});

it("stays off outside Herdr and settles when Herdr is gone", async () => {
  expect(herdrAgent({})).toBeUndefined();
  expect(herdrAgent({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })).toBeUndefined();
  const gone = herdrAgent({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: join(tmpdir(), "monchu-no-herdr.sock"),
    HERDR_PANE_ID: "w1:p1",
  });
  gone?.report("working");
  await gone?.release();
});
