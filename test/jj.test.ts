import { defineExtension, type JsonObject } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tools as jjTools } from "../src/plugins/jj/index.ts";
import {
  callTools,
  cleanup,
  context,
  open,
  route,
  setup,
  toolResults,
  type Setup,
} from "./support.ts";

afterEach(cleanup);

const Jj = defineExtension({ name: "monchu.jj", tools: jjTools });

const mentions = (text: string): unknown => expect.stringContaining(text);

const jj = (cwd: string, ...args: string[]) =>
  execFileSync("jj", ["--repository", cwd, "--no-pager", "--color=never", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A fresh colocated repository with its own identity, so no user jj config is needed. */
async function repository(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory);
  const identity = ["--config=user.name=Monchu Test", "--config=user.email=test@example.com"];
  execFileSync("jj", [...identity, "git", "init", "--colocate", directory], { stdio: "ignore" });
  jj(directory, "config", "set", "--repo", "user.name", "Monchu Test");
  jj(directory, "config", "set", "--repo", "user.email", "test@example.com");
  return directory;
}

function details(result: ToolResultMessage | undefined): Record<string, unknown> {
  const value: unknown = result?.details;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Tool result has no structured details");
  return Object.fromEntries(Object.entries(value));
}

/** Run each named call as its own turn and return the structured results in order. */
async function run(
  value: Setup,
  calls: Record<string, { tool: string; args: JsonObject }>,
  order: string[],
) {
  value.registry.install(Jj);
  route(value.faux, callTools(calls));
  const { harness, root } = await open(value);
  try {
    for (const message of order)
      await (await root.submit({ type: "input", content: message }, context)).wait(context);
    return (await toolResults(root)).map((result) => ({
      isError: result.isError,
      details: details(result),
    }));
  } finally {
    await harness.close(context);
  }
}

describe("jj", () => {
  it("declares object schemas, replay-safe reads and never-replayed writes", () => {
    const tools = Jj.tools ?? [];
    expect(tools.map((tool) => [tool.name, tool.parameters.type, tool.replay])).toEqual([
      ["jj", "object", "safe"],
      ["jj_write", "object", "unsafe"],
    ]);
  });

  it("commits, guards the empty working copy, sets a bookmark on @- and reads it all back", async () => {
    const home = await setup();
    const repo = await repository(home.directory, "repo");
    await writeFile(join(repo, "notes.md"), "first line\n");
    const results = await run(
      home,
      {
        relative: { tool: "jj", args: { cwd: "repo", request: { operation: "status" } } },
        commit: {
          tool: "jj_write",
          args: { cwd: repo, request: { operation: "commit", message: "Add notes" } },
        },
        emptyTarget: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "bookmark_set", names: ["main"], revision: "@" },
          },
        },
        bookmark: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "bookmark_set", names: ["main"], revision: "@-" },
          },
        },
        describe: {
          tool: "jj_write",
          args: { cwd: repo, request: { operation: "describe", revision: "@", message: "Next" } },
        },
        many: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "describe", revision: "all()", message: "Everything" },
          },
        },
        immutable: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "describe", revision: "root()", message: "No" },
          },
        },
        status: { tool: "jj", args: { cwd: repo, request: { operation: "status" } } },
        files: {
          tool: "jj",
          args: {
            cwd: repo,
            request: {
              operation: "diff",
              comparison: { kind: "revisions", revset: "main" },
              format: "files",
            },
          },
        },
        file: {
          tool: "jj",
          args: {
            cwd: repo,
            request: { operation: "file_show", revision: "main", path: "notes.md" },
          },
        },
        bookmarks: { tool: "jj", args: { cwd: repo, request: { operation: "bookmark_list" } } },
        ops: { tool: "jj", args: { cwd: repo, request: { operation: "op_log", limit: 2 } } },
      },
      [
        "relative",
        "commit",
        "emptyTarget",
        "bookmark",
        "describe",
        "many",
        "immutable",
        "status",
        "files",
        "file",
        "bookmarks",
        "ops",
      ],
    );
    const [
      relative,
      commit,
      emptyTarget,
      bookmark,
      describeResult,
      many,
      immutable,
      status,
      files,
      file,
      bookmarks,
      ops,
    ] = results;
    expect(relative).toMatchObject({
      isError: true,
      details: { ok: false, error: { kind: "invalid_request" }, commands: [] },
    });
    expect(commit).toMatchObject({
      isError: false,
      details: {
        ok: true,
        write: "applied",
        committed: { revision: { description: "Add notes\n" }, empty: false },
        working_copy: { current_working_copy: true, empty: true, revision: { description: "" } },
      },
    });
    // Refused before any write: the failure that put main on the fresh empty change.
    expect(emptyTarget).toMatchObject({
      isError: true,
      details: { ok: false, write: "not_attempted", error: { kind: "invalid_request" } },
    });
    expect(bookmark).toMatchObject({
      isError: false,
      details: {
        write: "applied",
        target: { revision: { description: "Add notes\n" } },
        // Colocated repositories also report the Git side's bookmark.
        bookmarks: [
          { name: "main", remote: null, present: true },
          { name: "main", remote: "git" },
        ],
      },
    });
    expect(describeResult).toMatchObject({
      details: { write: "applied", revision: { revision: { description: "Next\n" } } },
    });
    expect(many).toMatchObject({
      isError: true,
      details: { write: "not_attempted", error: { kind: "invalid_request" } },
    });
    // The write command ran and failed, so its result says so instead of pretending nothing happened.
    expect(immutable).toMatchObject({
      isError: true,
      details: {
        write: "uncertain",
        error: { kind: "exit" },
        commands: [{}, { exit_code: 1, stderr: { text: mentions("immutable") } }],
      },
    });
    expect(status).toMatchObject({
      details: {
        ok: true,
        status: {
          current_working_copy: true,
          revision: { description: "Next\n" },
          parents: [{ description: "Add notes\n" }],
        },
      },
    });
    expect(files).toMatchObject({
      details: { files: [{ path: "notes.md", status: "added" }], complete: true },
    });
    expect(file).toMatchObject({ details: { body: { text: "first line\n", complete: true } } });
    expect(bookmarks).toMatchObject({
      details: {
        bookmarks: [
          { name: "main", remote: null },
          { name: "main", remote: "git" },
        ],
      },
    });
    expect(ops).toMatchObject({
      details: { operations: [{ description: mentions("describe") }, {}] },
    });
    expect(jj(repo, "log", "--no-graph", "-r", "main", "-T", "description")).toBe("Add notes\n");
  }, 30_000);

  it("starts new changes, moves bookmarks and pushes and fetches named bookmarks", async () => {
    const home = await setup();
    const remote = join(home.directory, "remote.git");
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    const repo = await repository(home.directory, "repo");
    jj(repo, "git", "remote", "add", "origin", remote);
    await writeFile(join(repo, "a.txt"), "a\n");
    jj(repo, "commit", "-m", "First");
    jj(repo, "bookmark", "set", "main", "-r", "@-");
    await writeFile(join(repo, "b.txt"), "b\n");
    const results = await run(
      home,
      {
        push: {
          tool: "jj_write",
          args: { cwd: repo, request: { operation: "git_push", bookmarks: ["main"] } },
        },
        commit: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "commit", message: "Second", paths: ["b.txt"] },
          },
        },
        move: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "bookmark_move", names: ["main"], revision: "@-" },
          },
        },
        missing: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "bookmark_move", names: ["absent"], revision: "@-" },
          },
        },
        dry: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "git_push", bookmarks: ["main"], dry_run: true },
          },
        },
        pushAgain: {
          tool: "jj_write",
          args: {
            cwd: repo,
            request: { operation: "git_push", bookmarks: ["main"], remote: "origin" },
          },
        },
        fetch: { tool: "jj_write", args: { cwd: repo, request: { operation: "git_fetch" } } },
        fresh: {
          tool: "jj_write",
          args: { cwd: repo, request: { operation: "new", parents: ["main"], message: "Third" } },
        },
      },
      ["push", "commit", "move", "missing", "dry", "pushAgain", "fetch", "fresh"],
    );
    const [push, commit, move, missing, dry, pushAgain, fetch, fresh] = results;
    expect(push).toMatchObject({
      isError: false,
      details: {
        write: "applied",
        bookmarks: [
          { name: "main", remote: null },
          { name: "main", remote: "git" },
          { name: "main", remote: "origin", tracked: true, synced: true },
        ],
      },
    });
    expect(commit).toMatchObject({
      details: { committed: { revision: { description: "Second\n" } } },
    });
    expect(move).toMatchObject({ isError: false, details: { write: "applied" } });
    // jj exits zero when the move matches nothing; the result must not claim it moved.
    expect(missing).toMatchObject({
      isError: true,
      details: { write: "applied", error: { kind: "unchanged" } },
    });
    expect(dry).toMatchObject({
      isError: false,
      details: { write: "not_attempted", dry_run: true },
    });
    expect(pushAgain).toMatchObject({ isError: false, details: { write: "applied" } });
    expect(fetch).toMatchObject({ isError: false, details: { write: "applied" } });
    expect(fresh).toMatchObject({
      details: {
        working_copy: {
          current_working_copy: true,
          revision: { description: "Third\n" },
          parents: [{ description: "Second\n" }],
        },
      },
    });
    expect(
      execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "main"], {
        encoding: "utf8",
      }),
    ).toBe("Second\nFirst\n");
    expect(jj(repo, "diff", "--name-only", "-r", "@")).toBe("");
  }, 30_000);
});
