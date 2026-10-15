// Ported from the `herdr` tool and its SSH transport in the user's Pi extensions (herdr-tool.ts, shared/transport.ts).
import { isJsonValue } from "@earendil-works/chord";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { Check, Clean } from "typebox/value";

const strict = { additionalProperties: false };
const workspaceId = Type.String({ pattern: "^w[A-Za-z0-9]+$" });
const paneId = Type.String({ pattern: "^w[A-Za-z0-9]+:p[A-Za-z0-9]+$" });
const sessionRef = Type.Object(
  {
    source: Type.String(),
    agent: Type.String(),
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    value: Type.String({ minLength: 1 }),
  },
  strict,
);
const status = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);
const nullableText = Type.Union([Type.String(), Type.Null()]);
const paneFields = {
  pane_id: paneId,
  terminal_id: Type.String(),
  workspace_id: workspaceId,
  tab_id: Type.String(),
  focused: Type.Boolean(),
  agent_status: status,
  revision: Type.Integer({ minimum: 0 }),
  agent: Type.Optional(nullableText),
  cwd: Type.Optional(nullableText),
  foreground_cwd: Type.Optional(nullableText),
  agent_session: Type.Optional(Type.Union([sessionRef, Type.Null()])),
};
const pane = Type.Object(paneFields, strict);
const agent = Type.Object(
  {
    ...paneFields,
    name: Type.Optional(nullableText),
    interactive_ready: Type.Optional(Type.Boolean()),
    launch_pending: Type.Optional(Type.Boolean()),
    state_change_seq: Type.Optional(Type.Integer({ minimum: 0 })),
    completion_seq: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  },
  strict,
);
const workspace = Type.Object(
  {
    workspace_id: workspaceId,
    number: Type.Integer({ minimum: 0 }),
    label: Type.String(),
    focused: Type.Boolean(),
    pane_count: Type.Integer({ minimum: 0 }),
    tab_count: Type.Integer({ minimum: 0 }),
    active_tab_id: Type.String(),
    agent_status: status,
  },
  strict,
);
const tab = Type.Object(
  {
    tab_id: Type.String(),
    workspace_id: workspaceId,
    number: Type.Integer({ minimum: 0 }),
    label: Type.String(),
    focused: Type.Boolean(),
    pane_count: Type.Integer({ minimum: 0 }),
    agent_status: status,
  },
  strict,
);
// Never option-shaped: the host follows `--` on the ssh command line.
const hostSchema = Type.String({
  pattern: "^[A-Za-z0-9_][A-Za-z0-9_.@:\\[\\]-]*$",
  maxLength: 255,
});
const routeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, strict),
  Type.Object(
    {
      kind: Type.Literal("ssh"),
      host: hostSchema,
      session: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 128 }),
    },
    strict,
  ),
]);
const readSource = Type.Union([
  Type.Literal("visible"),
  Type.Literal("recent"),
  Type.Literal("recent-unwrapped"),
]);
const shortDefaultMs = 15000;
const waitDefaultMs = 600000;
// agent_launch takes no timeout_ms: layout, a harness startup capped at launchStartupMs, and the verify
// read share this budget, leaving 30s for the create/verify round trips and SSH connections.
const launchBudgetMs = 90000;
const launchStartupMs = 60000;
const shortDeadline = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 30000,
    description: `Overall deadline in milliseconds, including route verification. Default ${shortDefaultMs}.`,
  }),
);
const waitDeadline = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 600000,
    description: `Overall deadline in milliseconds; allow transport overhead in the caller. Default ${waitDefaultMs}.`,
  }),
);
const readFields = {
  pane_id: paneId,
  source: readSource,
  lines: Type.Integer({ minimum: 1, maximum: 500 }),
  timeout_ms: shortDeadline,
};
const promptText = Type.String({ minLength: 1, maxLength: 65536, pattern: "^[^\\u0000]+$" });
// Follows --label: never option-shaped, never control characters.
const label = Type.String({ maxLength: 64, pattern: "^[^-\\u0000-\\u001f][^\\u0000-\\u001f]*$" });
const model = Type.String({ maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@\\[\\]-]*$" });
// The durable identity agent_prompt rechecks; agent_launch returns it ready to pass back.
const expectedSchema = Type.Object(
  {
    workspace_id: workspaceId,
    terminal_id: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
    agent_session: sessionRef,
  },
  strict,
);
// Ownership handle: the scope to close and every terminal the task owns inside it, each with the
// conversation occupying it (null only for a terminal with no agent).
const retireFields = {
  target: Type.Union([
    Type.Object({ kind: Type.Literal("workspace"), workspace_id: workspaceId }, strict),
    Type.Object(
      {
        kind: Type.Literal("tab"),
        workspace_id: workspaceId,
        tab_id: Type.String({ pattern: "^w[A-Za-z0-9]+:t[A-Za-z0-9]+$" }),
      },
      strict,
    ),
  ]),
  panes: Type.Array(
    Type.Object(
      {
        pane_id: paneId,
        terminal_id: Type.String({ minLength: 1 }),
        agent_session: Type.Union([sessionRef, Type.Null()]),
      },
      strict,
    ),
    { minItems: 1, maxItems: 64 },
  ),
};
const agentName = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" });
const requestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("workspace_list"), timeout_ms: shortDeadline }, strict),
  Type.Object(
    { operation: Type.Literal("tab_list"), workspace_id: workspaceId, timeout_ms: shortDeadline },
    strict,
  ),
  Type.Object(
    { operation: Type.Literal("pane_list"), workspace_id: workspaceId, timeout_ms: shortDeadline },
    strict,
  ),
  Type.Object(
    { operation: Type.Literal("pane_get"), pane_id: paneId, timeout_ms: shortDeadline },
    strict,
  ),
  Type.Object({ operation: Type.Literal("pane_read"), ...readFields }, strict),
  Type.Object(
    { operation: Type.Literal("agent_get"), pane_id: paneId, timeout_ms: shortDeadline },
    strict,
  ),
  Type.Object({ operation: Type.Literal("agent_read"), ...readFields }, strict),
  Type.Object(
    { operation: Type.Literal("agent_wait"), pane_id: paneId, timeout_ms: waitDeadline },
    strict,
  ),
  Type.Object(
    {
      operation: Type.Literal("agent_prompt"),
      pane_id: paneId,
      timeout_ms: waitDeadline,
      text: promptText,
      expected: expectedSchema,
    },
    strict,
  ),
  Type.Object(
    {
      operation: Type.Literal("agent_launch"),
      location: Type.Union(
        [
          Type.Object({ kind: Type.Literal("workspace"), label }, strict),
          Type.Object({ kind: Type.Literal("tab"), workspace_id: workspaceId, label }, strict),
        ],
        {
          description:
            "Isolation choice: a new task workspace, or a new tab in the existing workspace that owns the task.",
        },
      ),
      cwd: Type.String({
        maxLength: 1024,
        pattern: "^(/|[A-Za-z]:[\\\\/])[^\\u0000-\\u001f]*$",
        description: "Absolute path on the routed host.",
      }),
      name: agentName,
      harness: Type.Union([
        Type.Object({ kind: Type.Literal("pi"), model }, strict),
        Type.Object(
          {
            kind: Type.Literal("claude"),
            model,
            intent: Type.Optional(
              Type.Union([Type.Literal("implementation"), Type.Literal("planning")], {
                description:
                  "implementation (default) starts Claude with --permission-mode auto; planning with --permission-mode plan.",
              }),
            ),
          },
          strict,
        ),
      ]),
      task: Type.Optional(Type.Object({ text: promptText, timeout_ms: waitDeadline }, strict)),
    },
    strict,
  ),
  Type.Object(
    { operation: Type.Literal("task_retire"), ...retireFields, timeout_ms: shortDeadline },
    strict,
  ),
]);
const parameters = Type.Object({ route: routeSchema, request: requestSchema }, strict);
type Route = Static<typeof routeSchema>;
type Stage =
  | "routing"
  | "session_check"
  | "preflight"
  | "request"
  | "layout"
  | "startup"
  | "verify";
type Agent = Static<typeof agent>;
type Session = Static<typeof sessionRef>;
type Retire = {
  target: Static<(typeof retireFields)["target"]>;
  panes: Static<(typeof retireFields)["panes"]>;
};
type CommandRecord = {
  stage: Stage;
  exit_code: number | null;
  signal: string | null;
  stderr: string;
};
// Every state-changing command the call may send. uncertain: sent, outcome not confirmed.
type Effect = "not_attempted" | "uncertain" | "applied";
type Mutations = { layout: Effect; agent_start: Effect; submission: Effect; close: Effect };
type Transport = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  output_limited: boolean;
  spawn_error: string | null;
};

const envelope = <T extends TSchema>(result: T) =>
  Type.Object({ id: Type.String(), result }, strict);
const errorEnvelope = Type.Object(
  {
    id: Type.String(),
    error: Type.Object({ code: Type.String(), message: Type.String() }, strict),
  },
  strict,
);
const sessionsSchema = Type.Object(
  {
    sessions: Type.Array(Type.Object({ name: Type.String(), running: Type.Boolean() }, strict)),
  },
  strict,
);
const workspacesEnvelope = envelope(
  Type.Object({ type: Type.Literal("workspace_list"), workspaces: Type.Array(workspace) }, strict),
);
const tabsEnvelope = envelope(
  Type.Object({ type: Type.Literal("tab_list"), tabs: Type.Array(tab) }, strict),
);
const panesEnvelope = envelope(
  Type.Object({ type: Type.Literal("pane_list"), panes: Type.Array(pane) }, strict),
);
const paneEnvelope = envelope(Type.Object({ type: Type.Literal("pane_info"), pane }, strict));
const agentEnvelope = envelope(Type.Object({ type: Type.Literal("agent_info"), agent }, strict));
const promptedEnvelope = envelope(
  Type.Object({ type: Type.Literal("agent_prompted"), agent }, strict),
);
const createdEnvelope = envelope(
  Type.Object(
    {
      type: Type.Union([Type.Literal("workspace_created"), Type.Literal("tab_created")]),
      root_pane: pane,
    },
    strict,
  ),
);
const startedEnvelope = envelope(
  Type.Object({ type: Type.Literal("agent_started"), agent }, strict),
);
const closedEnvelope = envelope(Type.Object({ type: Type.Literal("ok") }, strict));

// A failure keeps command evidence; in particular, cancellation cannot be mistaken for exit zero.
class HerdrFailure extends Error {
  readonly code: string;
  readonly transport: Transport | null;
  constructor(code: string, message: string, transport: Transport | null = null) {
    super(message);
    this.code = code;
    this.transport = transport;
  }
}

function decode<T extends TSchema>(schema: T, text: string, transport: Transport): Static<T> {
  let value: unknown;
  try {
    value = Clean(schema, JSON.parse(text));
  } catch {
    throw new HerdrFailure("invalid_response", "Herdr did not return valid JSON.", transport);
  }
  if (!Check(schema, value))
    throw new HerdrFailure(
      "invalid_response",
      "Herdr JSON did not match the installed response contract.",
      transport,
    );
  return value;
}

function sameSession(expected: Session, current: Session | null | undefined): boolean {
  return (
    current != null &&
    current.value === expected.value &&
    current.kind === expected.kind &&
    current.agent === expected.agent &&
    current.source === expected.source
  );
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Timeout and cancellation kill only this client process.
function execute(
  executable: string,
  argv: string[],
  input: string,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<Transport> {
  const result: Transport = {
    stdout: "",
    stderr: "",
    exit_code: null,
    signal: null,
    timed_out: false,
    cancelled: false,
    output_limited: false,
    spawn_error: null,
  };
  if (signal?.aborted) return Promise.resolve({ ...result, cancelled: true });
  return new Promise((resolve) => {
    const child = spawn(executable, argv, { stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => {
      result.cancelled = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      result.timed_out = true;
      child.kill("SIGKILL");
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const capture = (key: "stdout" | "stderr", chunk: string) => {
      // Bound both diagnostics and reads, including a single unusually long terminal line.
      const room = 262144 - result[key].length;
      result[key] += chunk.slice(0, Math.max(0, room));
      if (chunk.length > room) {
        result.output_limited = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => capture("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => capture("stderr", chunk));
    child.on("error", (error) => {
      result.spawn_error = error.message;
    });
    // An early exit can close stdin before the input is written (EPIPE).
    child.stdin.on("error", (error) => {
      result.spawn_error ??= error.message;
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      result.exit_code = code;
      result.signal = exitSignal;
      resolve(result);
    });
    child.stdin.end(input);
  });
}

// The remote login shell is zsh; -lic gives the script the host's interactive PATH.
function ssh(windowsDirectory: string | undefined, host: string, script: string) {
  let executable = "ssh";
  // On Windows only the system OpenSSH client reaches the Windows ssh-agent; Git Bash's ssh earlier on PATH does not.
  if (process.platform === "win32") {
    if (windowsDirectory === undefined)
      throw new HerdrFailure(
        "transport_error",
        "windir is not set, so the Windows OpenSSH client cannot be located.",
      );
    executable = `${windowsDirectory}\\System32\\OpenSSH\\ssh.exe`;
  }
  return {
    executable,
    argv: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      host,
      `zsh -lic ${quote(script)}`,
    ],
  };
}

type Argument = string | { prompt: string };

const instructions = `Call with {route, request}. route is {kind:"local"} (needs Monchu started inside Herdr, with HERDR_ENV=1 and HERDR_SOCKET_PATH) or {kind:"ssh", host, session} for the exact host and running named session the user authorized. timeout_ms is optional; the schema states each default.
Operations:
- agent_launch {location, cwd, name, harness, task?:{text}}: only for authorized new layout. location is {kind:"workspace", label} or {kind:"tab", workspace_id, label} in the workspace that owns the task; cwd is absolute on that host. harness is {kind:"pi", model} or {kind:"claude", model, intent?}; set intent "planning" only when a plan is all that is wanted. Creates the unfocused location, starts and verifies the agent, then submits task if given. Returns agent, expected (pass to agent_prompt), retire (pass to task_retire) and task; "not_requested" means nothing was delegated.
- agent_prompt {pane_id, text, expected}: first agent_get/agent_read the target and consume its previous result. Submits only to the verified idle/done agent, then waits until it settles.
- agent_wait {pane_id}: only after a submission whose activity was confirmed; it returns at once for an idle agent.
- agent_get/pane_get {pane_id}; agent_read/pane_read {pane_id, source, lines 1-500}, preferring source "recent-unwrapped"; workspace_list; tab_list/pane_list {workspace_id}. pane_id is a live id such as "w1:p2", never focus, an agent name or a session UUID.
- task_retire {target, panes}: closes one task-owned workspace or tab. Pass the launch's retire; when several launches share the scope, concatenate their retire.panes. It closes only when those are exactly the live terminals, all idle/done, each holding its declared conversation.
Success means the agent settled, not that the task succeeded: read the result; "blocked" needs a decision.
On any error, inspect with agent_get/pane_list (workspace_list/tab_list by label when error.recovery is null after an uncertain layout) before acting. Never retry a mutation that error.mutations reports as "uncertain" or "applied". After a failed launch, error.recovery.retire is the handle for what it created. Never rebuild or edit a retire handle to force a close. A task_retire refusal is a decision for the user, not an unsupported operation: never close that scope with CLI workspace close/tab close.
agent_session_unreported (or expected: null from agent_launch) means the harness's Herdr integration on that host reports no conversation, so this tool will not prompt or retire that agent: report it to the user.
This tool is never replayed after a crash; after an interrupted call, inspect before acting.
Use the Herdr CLI only for what this tool lacks: pane splits, other harnesses or native options, session resume, closing a single pane.`;

/** The local Herdr client and the Herdr environment Monchu was started in. */
export type HerdrHost = {
  /** The local Herdr client: the executable and any leading arguments. */
  command: { executable: string; args: readonly string[] };
  env: {
    HERDR_ENV?: string | undefined;
    HERDR_SOCKET_PATH?: string | undefined;
    HERDR_PANE_ID?: string | undefined;
    windir?: string | undefined;
  };
};

/**
 * Herdr workspace, pane and agent control for every role. Launch, prompt and retire change Herdr, so calls are never
 * replayed.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createHerdr(host: HerdrHost) {
  const { env } = host;
  // A prompt argument is argv locally, stdin remotely, never shell source.
  const transport = (
    route: Route,
    args: Argument[],
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<Transport> => {
    if (route.kind === "local")
      return execute(
        host.command.executable,
        [...host.command.args, ...args.map((arg) => (typeof arg === "string" ? arg : arg.prompt))],
        "",
        timeout,
        signal,
      );
    const prompt = args.find((arg) => typeof arg !== "string");
    const inner = ["herdr", ...args]
      .map((arg) => (typeof arg === "string" ? quote(arg) : '"$prompt"'))
      .join(" ");
    // read preserves quotes, substitutions, multiline text and trailing newlines; EOF is expected.
    const { executable, argv } = ssh(
      env.windir,
      route.host,
      prompt === undefined
        ? `exec ${inner}`
        : `IFS= read -r -d '' prompt || [[ -n "$prompt" ]] || exit 2; exec ${inner}`,
    );
    return execute(executable, argv, prompt?.prompt ?? "", timeout, signal);
  };

  return defineExtension({
    name: "monchu.herdr",
    tools: [
      defineTool({
        name: "herdr",
        description: `Launch a task agent in a new Herdr workspace or tab, prompt/wait for/read verified agents, inspect workspaces/tabs/panes and retire task-owned layout, locally or in an exact SSH session.\n${instructions}`,
        parameters,
        replay: "unsafe",
        execute: async ({ route, request }, api, context) => {
          const signal = context.abortSignal;
          const commands: CommandRecord[] = [];
          let stage: Stage = "routing";
          const mutations: Mutations = {
            layout: "not_attempted",
            agent_start: "not_attempted",
            submission: "not_attempted",
            close: "not_attempted",
          };
          let recovery: { retire: Retire; agent_name: string } | null = null;
          // Launch owns its layout/startup budget; the optional task then gets its own wait deadline.
          let deadline =
            Date.now() +
            (request.operation === "agent_launch"
              ? launchBudgetMs
              : (request.timeout_ms ??
                (request.operation === "agent_wait" || request.operation === "agent_prompt"
                  ? waitDefaultMs
                  : shortDefaultMs)));
          const run = async (args: Argument[], mutation?: keyof Mutations): Promise<Transport> => {
            const remaining = deadline - Date.now();
            if (signal?.aborted)
              throw new HerdrFailure(
                "cancelled",
                "Herdr call was cancelled before this command started.",
              );
            if (remaining <= 0)
              throw new HerdrFailure(
                "timeout",
                "Herdr call deadline expired before this command started.",
              );
            const scoped =
              route.kind === "ssh" && stage !== "session_check"
                ? ["--session", route.session, ...args]
                : args;
            if (mutation) mutations[mutation] = "uncertain";
            const result = await transport(route, scoped, remaining + 1000, signal);
            commands.push({
              stage,
              exit_code: result.exit_code,
              signal: result.signal,
              stderr: result.stderr,
            });
            if (result.cancelled)
              throw new HerdrFailure(
                "cancelled",
                "Herdr command was cancelled; any submitted prompt may still be running.",
                result,
              );
            if (result.timed_out)
              throw new HerdrFailure(
                "timeout",
                "Herdr transport deadline expired; this is not completion.",
                result,
              );
            if (result.output_limited)
              throw new HerdrFailure(
                "output_limit",
                "Herdr output exceeded the bounded transport limit.",
                result,
              );
            if (result.exit_code !== 0 || result.signal !== null || result.spawn_error !== null) {
              if (result.exit_code === 1 && result.stderr.trim().startsWith("{")) {
                const failure = decode(errorEnvelope, result.stderr, result);
                throw new HerdrFailure(failure.error.code, failure.error.message, result);
              }
              throw new HerdrFailure(
                "transport_error",
                result.spawn_error ??
                  `Herdr transport failed (exit ${result.exit_code}, signal ${result.signal}).`,
                result,
              );
            }
            if (Date.now() > deadline)
              throw new HerdrFailure(
                "timeout",
                "Herdr command returned after the requested deadline; this is not completion.",
                result,
              );
            return result;
          };
          const json = async <T extends TSchema>(
            args: Argument[],
            schema: T,
            mutation?: keyof Mutations,
          ): Promise<Static<T>> => {
            const result = await run(args, mutation);
            const value = decode(schema, result.stdout, result);
            if (mutation) mutations[mutation] = "applied";
            return value;
          };
          const submit = async (current: Agent, session: Session, text: string) => {
            stage = "request";
            const response = await json(
              [
                "agent",
                "prompt",
                current.pane_id,
                { prompt: text },
                "--wait",
                "--timeout",
                String(Math.max(1, deadline - Date.now())),
              ],
              promptedEnvelope,
              "submission",
            );
            const settled = response.result.agent;
            if (
              settled.pane_id !== current.pane_id ||
              settled.terminal_id !== current.terminal_id ||
              !sameSession(session, settled.agent_session) ||
              !["idle", "done", "blocked"].includes(settled.agent_status)
            )
              throw new HerdrFailure(
                "identity_or_state_changed",
                "Prompt wait returned another identity or a non-settled state.",
              );
            return settled;
          };
          const report = (output: { ok: boolean } & Record<string, unknown>) => {
            const text = JSON.stringify(output, null, 2);
            api.output(text);
            const details: unknown = JSON.parse(text);
            return { isError: !output.ok, ...(isJsonValue(details) ? { details } : {}) };
          };
          try {
            if (route.kind === "local") {
              if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH)
                throw new HerdrFailure(
                  "local_route_unavailable",
                  "Local control requires Monchu running inside Herdr (HERDR_ENV=1 and HERDR_SOCKET_PATH); no focused/default session fallback.",
                );
            } else {
              stage = "session_check";
              const sessions = await json(["session", "list", "--json"], sessionsSchema);
              const matches = sessions.sessions.filter((session) => session.name === route.session);
              if (matches.length !== 1 || matches[0]?.running !== true)
                throw new HerdrFailure(
                  "session_unavailable",
                  "The exact named SSH session must already exist and be running.",
                );
            }
            stage = "request";
            let data: { operation: string } & Record<string, unknown>;
            switch (request.operation) {
              case "workspace_list": {
                const response = await json(["workspace", "list"], workspacesEnvelope);
                data = { operation: request.operation, workspaces: response.result.workspaces };
                break;
              }
              case "tab_list": {
                const response = await json(
                  ["tab", "list", "--workspace", request.workspace_id],
                  tabsEnvelope,
                );
                if (response.result.tabs.some((item) => item.workspace_id !== request.workspace_id))
                  throw new HerdrFailure("target_mismatch", "Tab list returned another workspace.");
                data = { operation: request.operation, tabs: response.result.tabs };
                break;
              }
              case "pane_list": {
                const response = await json(
                  ["pane", "list", "--workspace", request.workspace_id],
                  panesEnvelope,
                );
                if (
                  response.result.panes.some((item) => item.workspace_id !== request.workspace_id)
                )
                  throw new HerdrFailure(
                    "target_mismatch",
                    "Pane list returned another workspace.",
                  );
                data = { operation: request.operation, panes: response.result.panes };
                break;
              }
              case "pane_get": {
                const response = await json(["pane", "get", request.pane_id], paneEnvelope);
                if (response.result.pane.pane_id !== request.pane_id)
                  throw new HerdrFailure("target_mismatch", "Pane get returned another pane.");
                data = { operation: request.operation, pane: response.result.pane };
                break;
              }
              case "pane_read":
              case "agent_read": {
                const group = request.operation === "pane_read" ? "pane" : "agent";
                const response = await run([
                  group,
                  "read",
                  request.pane_id,
                  "--source",
                  request.source,
                  "--lines",
                  String(request.lines),
                  "--format",
                  "text",
                ]);
                data = {
                  operation: request.operation,
                  pane_id: request.pane_id,
                  source: request.source,
                  lines: request.lines,
                  text: response.stdout,
                };
                break;
              }
              case "agent_get":
              case "agent_wait": {
                const args =
                  request.operation === "agent_get"
                    ? ["agent", "get", request.pane_id]
                    : [
                        "agent",
                        "wait",
                        request.pane_id,
                        "--timeout",
                        String(Math.max(1, deadline - Date.now())),
                      ];
                const response = await json(args, agentEnvelope);
                if (response.result.agent.pane_id !== request.pane_id)
                  throw new HerdrFailure(
                    "target_mismatch",
                    "Agent operation returned another pane.",
                  );
                if (request.operation === "agent_wait") {
                  if (!["idle", "done", "blocked"].includes(response.result.agent.agent_status))
                    throw new HerdrFailure(
                      "invalid_response",
                      "Agent wait returned a non-settled state.",
                    );
                  data = {
                    operation: request.operation,
                    agent: response.result.agent,
                    observation: "current_settled_state",
                  };
                } else data = { operation: request.operation, agent: response.result.agent };
                break;
              }
              case "agent_prompt": {
                stage = "preflight";
                if (route.kind === "local" && request.pane_id === env.HERDR_PANE_ID)
                  throw new HerdrFailure(
                    "self_prompt",
                    "Cannot prompt the local coordinating pane.",
                  );
                const {
                  result: { agent: current },
                } = await json(["agent", "get", request.pane_id], agentEnvelope);
                const expected = request.expected;
                if (current.pane_id === request.pane_id && !current.agent_session)
                  throw new HerdrFailure(
                    "agent_session_unreported",
                    "Herdr reports no agent session for this pane, so the conversation cannot be verified. The harness's Herdr integration must report it; this tool does not install integrations.",
                  );
                if (
                  current.pane_id !== request.pane_id ||
                  current.workspace_id !== expected.workspace_id ||
                  current.terminal_id !== expected.terminal_id ||
                  current.cwd !== expected.cwd ||
                  current.agent !== expected.agent_session.agent ||
                  !sameSession(expected.agent_session, current.agent_session)
                )
                  throw new HerdrFailure(
                    "identity_changed",
                    "Target pane, cwd or agent session differs from the verified target.",
                  );
                if (
                  !["idle", "done"].includes(current.agent_status) ||
                  current.interactive_ready !== true ||
                  current.launch_pending === true
                )
                  throw new HerdrFailure(
                    "agent_not_ready",
                    "Target must be interactive-ready and idle/done before prompting.",
                  );
                data = {
                  operation: request.operation,
                  agent: await submit(current, expected.agent_session, request.text),
                  observation: "activity_observed_and_settled",
                };
                break;
              }
              case "agent_launch": {
                stage = "layout";
                const { location, harness } = request;
                const place = ["--cwd", request.cwd, "--label", location.label, "--no-focus"];
                const {
                  result: { root_pane: root },
                } = await json(
                  location.kind === "workspace"
                    ? ["workspace", "create", ...place]
                    : ["tab", "create", "--workspace", location.workspace_id, ...place],
                  createdEnvelope,
                  "layout",
                );
                const target: Retire["target"] =
                  location.kind === "workspace"
                    ? { kind: location.kind, workspace_id: root.workspace_id }
                    : { kind: location.kind, workspace_id: root.workspace_id, tab_id: root.tab_id };
                // Until the started agent's identity is verified, the handle describes the bare terminal.
                recovery = {
                  retire: {
                    target,
                    panes: [
                      { pane_id: root.pane_id, terminal_id: root.terminal_id, agent_session: null },
                    ],
                  },
                  agent_name: request.name,
                };
                if (location.kind === "tab" && root.workspace_id !== location.workspace_id)
                  throw new HerdrFailure(
                    "target_mismatch",
                    "Tab was created in another workspace.",
                  );
                stage = "startup";
                const native =
                  harness.kind === "claude"
                    ? ["--permission-mode", harness.intent === "planning" ? "plan" : "auto"]
                    : [];
                // A new pane rejects agent start with agent_pane_busy until its shell reaches the prompt. That
                // rejection starts nothing, so it is retried within the launch budget.
                let started: Agent;
                for (;;) {
                  try {
                    ({
                      result: { agent: started },
                    } = await json(
                      [
                        "agent",
                        "start",
                        request.name,
                        "--kind",
                        harness.kind,
                        "--pane",
                        root.pane_id,
                        "--timeout",
                        String(Math.min(launchStartupMs, Math.max(1, deadline - Date.now()))),
                        "--",
                        "--model",
                        harness.model,
                        ...native,
                      ],
                      startedEnvelope,
                      "agent_start",
                    ));
                    break;
                  } catch (error) {
                    if (!(error instanceof HerdrFailure) || error.code !== "agent_pane_busy")
                      throw error;
                    mutations.agent_start = "not_attempted";
                    if (deadline - Date.now() < 1000) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 500));
                  }
                }
                stage = "verify";
                const {
                  result: { agent: current },
                } = await json(["agent", "get", root.pane_id], agentEnvelope);
                const session = current.agent_session ?? null;
                if (
                  started.pane_id !== root.pane_id ||
                  started.terminal_id !== root.terminal_id ||
                  current.pane_id !== root.pane_id ||
                  current.terminal_id !== root.terminal_id ||
                  current.workspace_id !== root.workspace_id ||
                  current.tab_id !== root.tab_id ||
                  current.agent !== harness.kind ||
                  (session !== null && session.agent !== harness.kind)
                )
                  throw new HerdrFailure(
                    "identity_changed",
                    "The started agent is not the requested harness in the created terminal and location.",
                  );
                const retire: Retire = {
                  target,
                  panes: [
                    {
                      pane_id: current.pane_id,
                      terminal_id: current.terminal_id,
                      agent_session: session,
                    },
                  ],
                };
                recovery = { retire, agent_name: request.name };
                // Separator and drive-letter spelling may differ; anything else is another directory.
                const canonical = (value: string) =>
                  (/^[A-Za-z]:/.test(value)
                    ? value.toLowerCase().replaceAll("/", "\\")
                    : value
                  ).replace(/(?<=.)[\\/]+$/, "");
                if (!current.cwd || canonical(current.cwd) !== canonical(request.cwd))
                  throw new HerdrFailure(
                    "cwd_mismatch",
                    `The started agent reports cwd ${current.cwd ?? "(none)"}, not the requested ${request.cwd}. Pass the path as the host resolves it.`,
                  );
                if (
                  !["idle", "done"].includes(current.agent_status) ||
                  current.interactive_ready !== true ||
                  current.launch_pending === true
                )
                  throw new HerdrFailure(
                    "agent_not_ready",
                    "The started agent is not interactive-ready and idle/done.",
                  );
                const expected = session
                  ? {
                      workspace_id: current.workspace_id,
                      terminal_id: current.terminal_id,
                      cwd: current.cwd,
                      agent_session: session,
                    }
                  : null;
                if (!request.task) {
                  data = {
                    operation: request.operation,
                    agent: current,
                    expected,
                    retire,
                    task: "not_requested",
                  };
                  break;
                }
                if (!expected)
                  throw new HerdrFailure(
                    "agent_session_unreported",
                    "The agent started, but Herdr reports no agent session for it, so the task was not submitted. The harness's Herdr integration must report it; this tool does not install integrations.",
                  );
                deadline = Date.now() + (request.task.timeout_ms ?? waitDefaultMs);
                data = {
                  operation: request.operation,
                  agent: await submit(current, expected.agent_session, request.task.text),
                  expected,
                  retire,
                  task: "activity_observed_and_settled",
                };
                break;
              }
              case "task_retire": {
                stage = "preflight";
                const { target, panes } = request;
                const {
                  result: { panes: live },
                } = await json(["pane", "list", "--workspace", target.workspace_id], panesEnvelope);
                if (live.some((item) => item.workspace_id !== target.workspace_id))
                  throw new HerdrFailure(
                    "target_mismatch",
                    "Pane list returned another workspace.",
                  );
                const scoped =
                  target.kind === "workspace"
                    ? live
                    : live.filter((item) => item.tab_id === target.tab_id);
                if (
                  route.kind === "local" &&
                  scoped.some((item) => item.pane_id === env.HERDR_PANE_ID)
                )
                  throw new HerdrFailure(
                    "self_retire",
                    "Cannot retire the scope containing the local coordinating pane.",
                  );
                if (
                  scoped.length !== panes.length ||
                  !scoped.every((item) =>
                    panes.some(
                      (owned) =>
                        owned.pane_id === item.pane_id && owned.terminal_id === item.terminal_id,
                    ),
                  )
                )
                  throw new HerdrFailure(
                    "ownership_mismatch",
                    "The live terminals in this scope are not exactly the declared task-owned panes; nothing was closed.",
                  );
                if (
                  scoped.some(
                    (item) => item.agent_status !== "idle" && item.agent_status !== "done",
                  )
                )
                  throw new HerdrFailure(
                    "agent_not_settled",
                    "A pane in this scope is working, blocked or in an unknown state; nothing was closed.",
                  );
                if (scoped.some((item) => item.agent != null && !item.agent_session))
                  throw new HerdrFailure(
                    "agent_session_unreported",
                    "An agent in this scope reports no agent session, so its conversation cannot be verified as the task's; nothing was closed. The harness's Herdr integration must report it; this tool does not install integrations.",
                  );
                for (const item of scoped) {
                  const declared =
                    panes.find((owned) => owned.pane_id === item.pane_id)?.agent_session ?? null;
                  if (
                    declared === null
                      ? item.agent_session != null
                      : !sameSession(declared, item.agent_session)
                  )
                    throw new HerdrFailure(
                      "conversation_changed",
                      "A terminal in this scope is occupied by another conversation than the declared one; nothing was closed.",
                    );
                }
                stage = "request";
                await json(
                  target.kind === "workspace"
                    ? ["workspace", "close", target.workspace_id]
                    : ["tab", "close", target.tab_id],
                  closedEnvelope,
                  "close",
                );
                data = { operation: request.operation, target, panes };
                break;
              }
            }
            return report({ ok: true, route, data, commands });
          } catch (error) {
            return report({
              ok: false,
              route,
              operation: request.operation,
              error: {
                code: error instanceof HerdrFailure ? error.code : "internal_error",
                message: error instanceof Error ? error.message : String(error),
                stage,
                mutations,
                transport: error instanceof HerdrFailure ? error.transport : null,
                recovery,
              },
              commands,
            });
          }
        },
      }),
    ],
  });
}
