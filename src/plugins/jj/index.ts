// The bundled jj plugin. Ported from the `jj` tool in the user's Pi extensions (jj-tool.ts) and extended with writes.
import { isJsonValue } from "@earendil-works/chord";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Check } from "typebox/value";
import { definePlugin, defineTool } from "../../plugin.ts";

const strict = { additionalProperties: false };
const text = (description?: string) =>
  Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: "^[^\\u0000]+$",
    ...(description === undefined ? {} : { description }),
  });
const cwd = text(
  "Absolute repository or workspace directory. Every call names it; the conversation cwd is never used.",
);
const limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 100, description: "Maximum returned records (default 20)." }),
);
const revision = text("jj revset; must resolve to exactly one revision where one is required.");
const path = text("Literal workspace-relative path, not a fileset expression.");
const paths = Type.Optional(Type.Array(path, { minItems: 1, maxItems: 100 }));
const names = Type.Array(text("Literal bookmark name, never a pattern."), {
  minItems: 1,
  maxItems: 100,
});
const message = Type.String({ minLength: 1, maxLength: 65536, pattern: "^[^\\u0000]+$" });
const comparison = Type.Union([
  Type.Object({ kind: Type.Literal("revisions"), revset: revision }, strict),
  Type.Object({ kind: Type.Literal("range"), from: revision, to: revision }, strict),
]);

const ReadParameters = Type.Object(
  {
    cwd,
    max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50_000,
        description: "Maximum captured stdout bytes per command (default 32768).",
      }),
    ),
    request: Type.Union([
      Type.Object({ operation: Type.Literal("status") }, strict),
      Type.Object({ operation: Type.Literal("log"), revset: revision, paths, limit }, strict),
      Type.Object(
        { operation: Type.Literal("diff"), comparison, format: Type.Literal("patch"), paths },
        strict,
      ),
      Type.Object(
        {
          operation: Type.Literal("diff"),
          comparison,
          format: Type.Literal("files"),
          paths,
          limit,
        },
        strict,
      ),
      Type.Object({ operation: Type.Literal("show"), revision }, strict),
      Type.Object({ operation: Type.Literal("file_show"), revision, path }, strict),
      Type.Object(
        {
          operation: Type.Literal("bookmark_list"),
          revset: Type.Optional(revision),
          names: Type.Optional(names),
          limit,
        },
        strict,
      ),
      Type.Object({ operation: Type.Literal("op_log"), limit }, strict),
    ]),
  },
  strict,
);

const bookmarkWrite = {
  names,
  revision,
  allow_backwards: Type.Optional(
    Type.Boolean({ description: "Allow moving a bookmark backwards or sideways (default false)." }),
  ),
  allow_empty: Type.Optional(
    Type.Boolean({
      description:
        "Allow targeting an empty revision without a description, such as the fresh @ after commit or new (default false).",
    }),
  ),
};
const remote = Type.Optional(text("Literal remote name; jj's default remote when omitted."));
const WriteParameters = Type.Object(
  {
    cwd,
    request: Type.Union([
      Type.Object({ operation: Type.Literal("describe"), revision, message }, strict),
      Type.Object({ operation: Type.Literal("commit"), message, paths }, strict),
      Type.Object(
        {
          operation: Type.Literal("new"),
          parents: Type.Array(revision, { minItems: 1, maxItems: 20 }),
          message: Type.Optional(message),
        },
        strict,
      ),
      Type.Object({ operation: Type.Literal("bookmark_set"), ...bookmarkWrite }, strict),
      Type.Object({ operation: Type.Literal("bookmark_move"), ...bookmarkWrite }, strict),
      Type.Object({ operation: Type.Literal("git_fetch"), remote }, strict),
      Type.Object(
        {
          operation: Type.Literal("git_push"),
          bookmarks: names,
          remote,
          dry_run: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    ]),
  },
  strict,
);

const Signature = Type.Object({
  name: Type.String(),
  email: Type.String(),
  timestamp: Type.String(),
});
const Commit = Type.Object({
  commit_id: Type.String(),
  change_id: Type.String(),
  parents: Type.Array(Type.String()),
  description: Type.String(),
  author: Signature,
  committer: Signature,
});
const Bookmark = Type.Object({
  name: Type.String(),
  remote: Type.Union([Type.String(), Type.Null()]),
  present: Type.Boolean(),
  conflict: Type.Boolean(),
  added_targets: Type.Array(Type.String()),
  removed_targets: Type.Array(Type.String()),
  tracked: Type.Boolean(),
  tracking_present: Type.Boolean(),
  synced: Type.Boolean(),
});
const ChangedFile = Type.Object({
  path: Type.String(),
  status: Type.String(),
  source_path: Type.String(),
  source_type: Type.String(),
  target_type: Type.String(),
  source_conflict: Type.Boolean(),
  target_conflict: Type.Boolean(),
});
const Revision = Type.Object({
  revision: Commit,
  parents: Type.Array(Commit),
  current_working_copy: Type.Boolean(),
  conflict: Type.Boolean(),
  empty: Type.Boolean(),
  divergent: Type.Boolean(),
  immutable: Type.Boolean(),
  local_bookmarks: Type.Array(Bookmark),
  remote_bookmarks: Type.Array(Bookmark),
  changed_files: Type.Array(ChangedFile),
  conflicted_files: Type.Array(
    Type.Object({ path: Type.String(), conflict_side_count: Type.Integer() }),
  ),
});
const Operation = Type.Object({
  id: Type.String(),
  parents: Type.Array(Type.String()),
  time: Type.Object({ start: Type.String(), end: Type.String() }),
  description: Type.String(),
  hostname: Type.String(),
  username: Type.String(),
  is_snapshot: Type.Boolean(),
  workspace_name: Type.Union([Type.String(), Type.Null()]),
  attributes: Type.Record(Type.String(), Type.String()),
});

type BoundedText = {
  text: string;
  bytes_observed: number;
  truncated: boolean;
  complete: boolean;
};
type Command = {
  argv: string[];
  exit_code: number | null;
  signal: string | null;
  stdout?: BoundedText;
  stderr: BoundedText;
};
type Failure =
  | "invalid_request"
  | "cancelled"
  | "timeout"
  | "spawn"
  | "exit"
  | "invalid_output"
  | "unchanged";
type ProcessResult = {
  command: Command;
  stdout: BoundedText;
  failure: "cancelled" | "timeout" | "spawn" | "exit" | null;
  message: string;
};

// jj's machine-data templates: documented template methods and json() escaping, not display templates.
// Commit's native JSON supplies full IDs, description, signatures and parent IDs.
const bookmarkTemplate = String.raw`"{\"name\":" ++ json(self.name()) ++ ",\"remote\":" ++ json(self.remote()) ++ ",\"present\":" ++ json(self.present()) ++ ",\"conflict\":" ++ json(self.conflict()) ++ ",\"added_targets\":" ++ json(self.added_targets().map(|c| c.commit_id())) ++ ",\"removed_targets\":" ++ json(self.removed_targets().map(|c| c.commit_id())) ++ ",\"tracked\":" ++ json(self.tracked()) ++ ",\"tracking_present\":" ++ json(self.tracking_present()) ++ ",\"synced\":" ++ json(self.synced()) ++ "}"`;
const changedFileTemplate = String.raw`"{\"path\":" ++ json(self.path()) ++ ",\"status\":" ++ json(self.status()) ++ ",\"source_path\":" ++ json(self.source().path()) ++ ",\"source_type\":" ++ json(self.source().file_type()) ++ ",\"target_type\":" ++ json(self.target().file_type()) ++ ",\"source_conflict\":" ++ json(self.source().conflict()) ++ ",\"target_conflict\":" ++ json(self.target().conflict()) ++ "}"`;
const revisionTemplate = String.raw`"{\"revision\":" ++ json(self) ++ ",\"parents\":" ++ json(parents) ++ ",\"current_working_copy\":" ++ json(current_working_copy) ++ ",\"conflict\":" ++ json(conflict) ++ ",\"empty\":" ++ json(empty) ++ ",\"divergent\":" ++ json(divergent) ++ ",\"immutable\":" ++ json(immutable) ++ ",\"local_bookmarks\":[" ++ local_bookmarks.map(|b| ${bookmarkTemplate.replaceAll("self.", "b.")}).join(",") ++ "],\"remote_bookmarks\":[" ++ remote_bookmarks.map(|b| ${bookmarkTemplate.replaceAll("self.", "b.")}).join(",") ++ "],\"changed_files\":[" ++ self.diff().files().map(|f| ${changedFileTemplate.replaceAll("self.", "f.")}).join(",") ++ "],\"conflicted_files\":[" ++ conflicted_files.map(|f| "{\"path\":" ++ json(f.path()) ++ ",\"conflict_side_count\":" ++ json(f.conflict_side_count()) ++ "}").join(",") ++ "]}\n"`;

const READ_TIMEOUT_MS = 15_000;
const LOCAL_WRITE_TIMEOUT_MS = 30_000;
const REMOTE_WRITE_TIMEOUT_MS = 120_000;
const STDERR_BYTES = 8192;
const WRITE_STDOUT_BYTES = 16384;

const emptyText = (complete: boolean): BoundedText => ({
  text: "",
  bytes_observed: 0,
  truncated: false,
  complete,
});

function bounded(chunks: Buffer[], observed: number, limit: number, completed: boolean) {
  const truncated = observed > limit;
  // Streaming decode omits a split final UTF-8 character instead of adding a spurious replacement.
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated }),
    bytes_observed: observed,
    truncated,
    complete: completed && !truncated,
  };
}

// Stream into capped buffers while draining the pipes: truncation does not invent an exit code.
function runJj(
  directory: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProcessResult> {
  const argv = ["--repository=" + directory, "--no-pager", "--color=never", ...args];
  if (signal?.aborted)
    return Promise.resolve({
      command: { argv, exit_code: null, signal: null, stderr: emptyText(false) },
      stdout: emptyText(false),
      failure: "cancelled",
      message: "Cancelled before starting jj.",
    });
  return new Promise((resolve) => {
    const child = spawn("jj", argv, {
      cwd: directory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProcessResult["failure"] = null;
    let message = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: "cancelled" | "timeout") => {
      if (failure) return;
      failure = reason;
      message =
        reason === "cancelled"
          ? "Cancelled."
          : `jj exceeded its ${timeoutMs / 1000} second deadline.`;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    };
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) stdout.push(chunk.subarray(0, maxBytes - stdoutBytes));
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < STDERR_BYTES) stderr.push(chunk.subarray(0, STDERR_BYTES - stderrBytes));
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      failure ??= "spawn";
      message ||= error.message;
    });
    child.on("close", (code, processSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      const completed = failure === null && processSignal === null;
      if (!failure && (code !== 0 || processSignal)) {
        failure = "exit";
        message = processSignal
          ? `jj terminated by ${processSignal}.`
          : `jj exited with code ${code}.`;
      }
      resolve({
        command: {
          argv,
          exit_code: code,
          signal: processSignal,
          stderr: bounded(stderr, stderrBytes, STDERR_BYTES, completed),
        },
        stdout: bounded(stdout, stdoutBytes, maxBytes, completed),
        failure,
        message,
      });
    });
  });
}

// NDJSON templates delimit records even when descriptions or paths contain newlines.
function parseRows<T extends TSchema>(
  schema: T,
  stdout: BoundedText,
  max: number,
): { rows: Static<T>[]; complete: boolean } {
  const lines = stdout.text.split("\n");
  const tail = lines.pop();
  if (!stdout.truncated && tail !== "")
    throw new Error("jj template output was missing its final record delimiter.");
  const rows: Static<T>[] = [];
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    if (!Check(schema, value))
      throw new Error("jj template output did not match the installed machine-data contract.");
    rows.push(value);
  }
  return { rows: rows.slice(0, max), complete: !stdout.truncated && rows.length <= max };
}

// jj literals support neither JSON's \b/\f nor \u escapes. Escape only the delimiter and backslash.
function literal(kind: "root" | "root-file" | "exact", value: string): string {
  return `${kind}:"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

class JjFailure extends Error {
  readonly kind: Failure;
  constructor(kind: Failure, message: string) {
    super(message);
    this.kind = kind;
  }
}

type JsonResult = { ok: boolean } & Record<string, unknown>;

/** Model-facing JSON goes through `output()`, which the Harness bounds; details keep the structured result. */
function respond(api: ToolExecutionApi, result: JsonResult) {
  const text = JSON.stringify(result);
  api.output(text);
  const details: unknown = JSON.parse(text);
  return { isError: !result.ok, ...(isJsonValue(details) ? { details } : {}) };
}

/** Commands of one call, with their stdout kept only where it is not already in the result. */
function session(directory: string, signal: AbortSignal | undefined) {
  const commands: Command[] = [];
  let lastStdout = emptyText(true);
  return {
    commands,
    get stdout() {
      return lastStdout;
    },
    async run(args: string[], maxBytes: number, timeoutMs: number, keepStdout = false) {
      const result = await runJj(directory, args, maxBytes, timeoutMs, signal);
      commands.push(keepStdout ? { ...result.command, stdout: result.stdout } : result.command);
      lastStdout = result.stdout;
      if (result.failure) throw new JjFailure(result.failure, result.message);
      return result.stdout;
    },
  };
}

async function resolveOne(
  jj: ReturnType<typeof session>,
  revset: string,
  maxBytes: number,
): Promise<Static<typeof Revision>> {
  const output = await jj.run(
    ["log", "--no-graph", "--revisions=" + revset, "--limit=2", "--template", revisionTemplate],
    maxBytes,
    READ_TIMEOUT_MS,
  );
  const parsed = parseRows(Revision, output, 2);
  if (!parsed.complete)
    throw new JjFailure(
      "invalid_output",
      "No complete revision metadata record was available within the output bound.",
    );
  const [only, extra] = parsed.rows;
  if (only === undefined || extra !== undefined)
    throw new JjFailure(
      "invalid_request",
      `${revset} must resolve to exactly one revision; it resolved to ${parsed.rows.length === 0 ? "none" : "several"}.`,
    );
  return only;
}

const READ_DESCRIPTION =
  "Read-only Jujutsu inspection of an explicit repository: status (@), log, diff, show, file contents, local/remote bookmarks and the operation log. Pass an absolute cwd and an operation-specific request; never cd or rely on the conversation cwd. Revisions/revsets are jj expressions; paths and bookmark names are literal, never argv or fileset expressions, and paths are relative to the workspace root. log requires a revset; show requires exactly one revision; diff takes a revisions revset or an explicit from/to range and returns a patch or changed files; bookmark_list includes all remotes; op_log lists the newest operations, which is how to inspect what a jj_write call did. Uses ordinary jj behavior, including working-copy snapshotting. Returns JSON; complete=false means a byte/record limit or interrupted output. Stdout defaults to 32768 bytes per command (max 50000); record limits default to 20 (max 100). Commands have a 15 second deadline. Errors return ok=false with the jj stderr, exit code and signal.";

const WRITE_DESCRIPTION =
  'Change a Jujutsu repository at an explicit absolute cwd: describe, commit, new, bookmark_set (create or move), bookmark_move (existing only), git_fetch, git_push. Only act on what the user authorized; never push, move bookmarks or commit unasked. Revisions are jj revsets that must resolve to exactly one revision where one is named; bookmark and remote names and commit paths are literal. describe sets one revision\'s message. commit describes @ (or only the given paths) and starts a new empty @ on top; the committed change is then @-, so after commit a bookmark normally goes on @-, not @. new starts an empty change on the given parents. bookmark_set/bookmark_move always take an explicit revision and refuse an empty revision without a description unless allow_empty; moving backwards or sideways needs allow_backwards. git_push pushes only the named bookmarks; dry_run shows what would change. Results include the resulting revisions or bookmarks. These calls are never replayed after a crash. write="uncertain" means the jj command started but did not finish cleanly: inspect with the jj tool (status, bookmark_list, op_log) before trying again; never retry blindly.';

/** `jj` reads and is replay-safe. */
const read = defineTool({
  name: "jj",
  description: READ_DESCRIPTION,
  exposure: "direct",
  parameters: ReadParameters,
  replay: "safe",
  execute: async (_id, args, signal, _update, { durable: { api } }) => {
    const directory = args.cwd;
    const jj = session(directory, signal);
    const fail = (kind: Failure, failure: string) =>
      respond(api, {
        ok: false,
        error: { kind, message: failure },
        commands: jj.commands,
        stdout: jj.stdout,
      });
    if (!isAbsolute(directory))
      return fail("invalid_request", "cwd must be an absolute repository or workspace path.");
    const { request } = args;
    const maxBytes = args.max_bytes ?? 32768;
    const base = {
      ok: true,
      cwd: directory,
      operation: request.operation,
      commands: jj.commands,
    };
    const read = (command: string[]) => jj.run(command, maxBytes, READ_TIMEOUT_MS);
    try {
      switch (request.operation) {
        case "status": {
          const status = await resolveOne(jj, "@", maxBytes);
          return respond(api, { ...base, status, complete: true });
        }
        case "show": {
          const current = await resolveOne(jj, request.revision, maxBytes);
          const patch = await read(["diff", "--git", "--revisions=" + current.revision.commit_id]);
          return respond(api, { ...base, revision: current, patch, complete: patch.complete });
        }
        case "log": {
          const max = request.limit ?? 20;
          const output = await read([
            "log",
            "--no-graph",
            "--revisions=" + request.revset,
            "--limit=" + (max + 1),
            "--template",
            revisionTemplate,
            "--",
            ...(request.paths ?? []).map((value) => literal("root", value)),
          ]);
          const parsed = parseRows(Revision, output, max);
          return respond(api, { ...base, revisions: parsed.rows, complete: parsed.complete });
        }
        case "diff": {
          const output = await read([
            "diff",
            ...(request.comparison.kind === "revisions"
              ? ["--revisions=" + request.comparison.revset]
              : ["--from=" + request.comparison.from, "--to=" + request.comparison.to]),
            ...(request.format === "patch"
              ? ["--git"]
              : ["--template", changedFileTemplate + ' ++ "\\n"']),
            "--",
            ...(request.paths ?? []).map((value) => literal("root", value)),
          ]);
          if (request.format === "patch")
            return respond(api, {
              ...base,
              format: "patch",
              patch: output,
              complete: output.complete,
            });
          const parsed = parseRows(ChangedFile, output, request.limit ?? 20);
          return respond(api, {
            ...base,
            format: "files",
            files: parsed.rows,
            complete: parsed.complete,
          });
        }
        case "file_show": {
          const body = await read([
            "file",
            "show",
            "--revision=" + request.revision,
            "--",
            literal("root-file", request.path),
          ]);
          return respond(api, {
            ...base,
            revision: request.revision,
            path: request.path,
            body,
            complete: body.complete,
          });
        }
        case "bookmark_list": {
          const output = await read([
            "bookmark",
            "list",
            "--all-remotes",
            "--sort=name",
            "--template",
            bookmarkTemplate + ' ++ "\\n"',
            ...(request.revset === undefined ? [] : ["--revision=" + request.revset]),
            "--",
            ...(request.names ?? []).map((name) => literal("exact", name)),
          ]);
          const parsed = parseRows(Bookmark, output, request.limit ?? 20);
          return respond(api, { ...base, bookmarks: parsed.rows, complete: parsed.complete });
        }
        case "op_log": {
          const max = request.limit ?? 20;
          const output = await read([
            "operation",
            "log",
            "--no-graph",
            "--limit=" + (max + 1),
            "--template",
            'json(self) ++ "\\n"',
          ]);
          const parsed = parseRows(Operation, output, max);
          return respond(api, { ...base, operations: parsed.rows, complete: parsed.complete });
        }
      }
    } catch (error) {
      if (error instanceof JjFailure) return fail(error.kind, error.message);
      return fail("invalid_output", error instanceof Error ? error.message : String(error));
    }
  },
});

/** `jj_write` changes repositories and is never replayed. */
const write = defineTool({
  name: "jj_write",
  description: WRITE_DESCRIPTION,
  exposure: "direct",
  parameters: WriteParameters,
  replay: "unsafe",
  executionMode: "sequential",
  execute: async (_id, args, signal, _update, { durable: { api } }) => {
    const directory = args.cwd;
    const jj = session(directory, signal);
    // Whether the state-changing command ran: uncertain until it exits zero.
    let write: "not_attempted" | "uncertain" | "applied" = "not_attempted";
    const fail = (kind: Failure, failure: string) =>
      respond(api, {
        ok: false,
        write,
        error: { kind, message: failure },
        commands: jj.commands,
      });
    if (!isAbsolute(directory))
      return fail("invalid_request", "cwd must be an absolute repository or workspace path.");
    const { request } = args;
    const maxBytes = 32768;
    const base = { ok: true, cwd: directory, operation: request.operation, write: "applied" };
    const change = async (command: string[], timeoutMs = LOCAL_WRITE_TIMEOUT_MS) => {
      write = "uncertain";
      await jj.run(command, WRITE_STDOUT_BYTES, timeoutMs, true);
      write = "applied";
    };
    const bookmarks = async (list: readonly string[]) => {
      const output = await jj.run(
        [
          "bookmark",
          "list",
          "--all-remotes",
          "--sort=name",
          "--template",
          bookmarkTemplate + ' ++ "\\n"',
          "--",
          ...list.map((name) => literal("exact", name)),
        ],
        maxBytes,
        READ_TIMEOUT_MS,
      );
      return parseRows(Bookmark, output, 100).rows;
    };
    try {
      switch (request.operation) {
        case "describe": {
          const target = await resolveOne(jj, request.revision, maxBytes);
          await change([
            "describe",
            "--message=" + request.message,
            "--",
            target.revision.commit_id,
          ]);
          const revision = await resolveOne(jj, target.revision.change_id, maxBytes);
          return respond(api, { ...base, revision, commands: jj.commands });
        }
        case "commit": {
          await change([
            "commit",
            "--message=" + request.message,
            "--",
            ...(request.paths ?? []).map((value) => literal("root", value)),
          ]);
          const working_copy = await resolveOne(jj, "@", maxBytes);
          const committed = await resolveOne(jj, "@-", maxBytes);
          return respond(api, { ...base, committed, working_copy, commands: jj.commands });
        }
        case "new": {
          await change([
            "new",
            ...(request.message === undefined ? [] : ["--message=" + request.message]),
            "--",
            ...request.parents,
          ]);
          const working_copy = await resolveOne(jj, "@", maxBytes);
          return respond(api, { ...base, working_copy, commands: jj.commands });
        }
        case "bookmark_set":
        case "bookmark_move": {
          const target = await resolveOne(jj, request.revision, maxBytes);
          if (target.empty && target.revision.description.trim() === "" && !request.allow_empty)
            return fail(
              "invalid_request",
              `${request.revision} is an empty revision without a description (${target.revision.change_id.slice(0, 12)}${target.current_working_copy ? ", the working copy @" : ""}); after commit the change is usually @-. Pass allow_empty only if this target is intended.`,
            );
          const backwards = request.allow_backwards ? ["--allow-backwards"] : [];
          await change(
            request.operation === "bookmark_set"
              ? [
                  "bookmark",
                  "set",
                  "--revision=" + target.revision.commit_id,
                  ...backwards,
                  "--",
                  ...request.names,
                ]
              : [
                  "bookmark",
                  "move",
                  "--to=" + target.revision.commit_id,
                  ...backwards,
                  "--",
                  ...request.names.map((name) => literal("exact", name)),
                ],
          );
          const after = await bookmarks(request.names);
          // jj exits zero when a move matches nothing, so check where each named bookmark ended up.
          const missed = request.names.filter(
            (name) =>
              !after.some(
                (bookmark) =>
                  bookmark.name === name &&
                  bookmark.remote === null &&
                  bookmark.added_targets.length === 1 &&
                  bookmark.added_targets[0] === target.revision.commit_id,
              ),
          );
          if (missed.length)
            return fail(
              "unchanged",
              `jj finished, but ${missed.join(", ")} ${missed.length === 1 ? "does" : "do"} not point at ${target.revision.commit_id}; bookmark_move cannot create bookmarks.`,
            );
          return respond(api, { ...base, target, bookmarks: after, commands: jj.commands });
        }
        case "git_fetch": {
          await change(
            [
              "git",
              "fetch",
              ...(request.remote === undefined
                ? []
                : ["--remote=" + literal("exact", request.remote)]),
            ],
            REMOTE_WRITE_TIMEOUT_MS,
          );
          return respond(api, { ...base, commands: jj.commands });
        }
        case "git_push": {
          const command = [
            "git",
            "push",
            ...(request.remote === undefined
              ? []
              : ["--remote=" + literal("exact", request.remote)]),
            ...request.bookmarks.map((name) => "--bookmark=" + literal("exact", name)),
            ...(request.dry_run ? ["--dry-run"] : []),
          ];
          if (request.dry_run) {
            await jj.run(command, WRITE_STDOUT_BYTES, REMOTE_WRITE_TIMEOUT_MS, true);
            return respond(api, {
              ...base,
              write: "not_attempted",
              dry_run: true,
              commands: jj.commands,
            });
          }
          await change(command, REMOTE_WRITE_TIMEOUT_MS);
          return respond(api, {
            ...base,
            bookmarks: await bookmarks(request.bookmarks),
            commands: jj.commands,
          });
        }
      }
    } catch (error) {
      if (error instanceof JjFailure) return fail(error.kind, error.message);
      return fail("invalid_output", error instanceof Error ? error.message : String(error));
    }
  },
});

export const tools = [read, write];

/** A bundled plugin, offered to every role in every conversation: agents use jj on most turns. */
export default definePlugin((monchu) => {
  monchu.registerTool(read);
  monchu.registerTool(write);
});
