/**
 * Secrets as agents see them: names only. The `secret` tool asks the user for one and lists them; shells get the
 * secrets a command names as environment variables; tools take `{{secret:NAME}}` placeholders resolved when they run;
 * and every tool result, with shells' live output, has stored values replaced by `[secret NAME]`.
 */
import type { Context } from "@earendil-works/chord";
import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { BashPrepare } from "@earendil-works/pi-durable/tools";
import type { TSchema } from "typebox";
import { shortId } from "../../api/ids.ts";
import { parentOf, rootOf, WorkersDoc } from "../agents/workers.ts";
import { SecretsDoc, usage } from "./requests.ts";
import {
  redact,
  SECRET_NAME,
  secretKeys,
  siteOrigin,
  StreamRedactor,
  type SecretInfo,
  type Vault,
} from "./vault.ts";

/** `$NAME` and `${NAME}` in a shell command. */
const SHELL_REFERENCE = /\$\{?([A-Z][A-Z0-9_]*)\}?/g;
/** `$env:NAME` in a PowerShell command. */
const POWERSHELL_REFERENCE = /\$env:([A-Za-z][A-Za-z0-9_]*)/g;
/** `{{secret:NAME}}` in another tool's arguments. */
const PLACEHOLDER = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every name a pattern captures in some text. */
function captured(pattern: RegExp, source: string): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1].toUpperCase()],
  );
}

/**
 * A shell tool's `prepare`: each stored secret the command names (`$NAME` in bash, `$env:NAME` in PowerShell) joins
 * that command's environment only, never its text.
 */
export function injectSecrets(vault: Vault, tool: "bash" | "powershell"): BashPrepare {
  return async (execution, api) => {
    const keys = captured(
      tool === "bash" ? SHELL_REFERENCE : POWERSHELL_REFERENCE,
      execution.command,
    );
    Object.assign(
      execution.env,
      await vault.resolve(keys, { tool, conversation: shortId(api.conversationId) }),
    );
  };
}

/**
 * The stored secrets a shell command names as `$NAME`, for a command Monchu runs outside a tool call (a job), with what
 * its output must be redacted of.
 */
export async function commandSecrets(
  vault: Vault,
  command: string,
  use: { tool: string; conversation: string },
): Promise<{ env: Record<string, string>; redactor: StreamRedactor }> {
  const env = await vault.resolve(captured(SHELL_REFERENCE, command), use);
  return { env, redactor: new StreamRedactor(await vault.known()) };
}

/**
 * A tool whose live output is redacted as it streams, so a stored value never reaches the live view either. The
 * output window goes, since an environment skipping text would bypass the redactor; the Harness still keeps the tail.
 */
export function redacting<P extends TSchema>(
  tool: ToolRegistration<P>,
  vault: Vault,
): ToolRegistration<P> {
  return {
    ...tool,
    execute: async (args, api, context) => {
      let known: Awaited<ReturnType<Vault["known"]>>;
      try {
        known = await vault.known();
      } catch (error) {
        api.diagnostic({
          severity: "warn",
          code: "secrets_unavailable",
          message: `Secrets could not be read, so this output is not redacted: ${message(error)}`,
        });
        return tool.execute(args, api, context);
      }
      if (known.length === 0) return tool.execute(args, api, context);
      const stream = new StreamRedactor(known);
      const decoder = new TextDecoder();
      const wrapped: ToolExecutionApi = {
        ...api,
        outputWindow: undefined,
        output: (chunk, skipped) => {
          const safe = stream.push(
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          );
          if (safe !== "" || skipped !== undefined) api.output(safe, skipped);
        },
      };
      try {
        return await tool.execute(args, wrapped, context);
      } finally {
        const rest = stream.end();
        if (rest !== "") api.output(rest);
      }
    },
  };
}

/**
 * Replaces `{{secret:NAME}}` in a tool's arguments with the values, for a call about to run. A key with no stored
 * secret is refused; a login with a site is refused unless `origin` (the page the tool acts on) matches it.
 */
export async function fillPlaceholders(
  vault: Vault,
  args: readonly string[],
  use: { tool: string; conversation: string; origin?: () => Promise<string | undefined> },
): Promise<string[]> {
  const keys = [...new Set(args.flatMap((arg) => captured(PLACEHOLDER, arg)))];
  if (keys.length === 0) return [...args];
  const owners: SecretInfo[] = [];
  for (const key of keys) {
    const owner = await vault.owner(key);
    if (owner === undefined)
      throw new Error(
        `No secret ${key}: import it from a file or ask the user for it with the secret tool`,
      );
    owners.push(owner);
  }
  const sited = owners.filter((owner) => owner.site !== undefined);
  if (sited.length > 0) {
    const origin = await use.origin?.();
    for (const owner of sited)
      if (origin !== owner.site)
        throw new Error(
          `${owner.name} is only for ${owner.site ?? ""}; the page is ${origin === undefined ? "unknown" : `on ${origin}`}. Open the site first`,
        );
  }
  const values = await vault.resolve(keys, use);
  return args.map((arg) => arg.replace(PLACEHOLDER, (_whole, key: string) => values[key] ?? ""));
}

function redactJson(value: JsonValue, known: Parameters<typeof redact>[1]): JsonValue {
  if (typeof value === "string") return redact(value, known);
  if (Array.isArray(value)) return value.map((each) => redactJson(each, known));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, each] of Object.entries(value))
      if (isJsonValue(each)) out[key] = redactJson(each, known);
    return out;
  }
  return value;
}

/** A result with every stored value replaced: its text, diagnostics, details and structured output. */
function redactResult(
  result: ToolExecutionResult,
  known: Parameters<typeof redact>[1],
): ToolExecutionResult {
  return {
    ...result,
    ...(result.output === undefined
      ? {}
      : {
          output: result.output.map((part) =>
            part.type === "text" ? { ...part, text: redact(part.text, known) } : part,
          ),
        }),
    ...(result.diagnostics === undefined
      ? {}
      : {
          diagnostics: result.diagnostics.map((each) => ({
            ...each,
            message: redact(each.message, known),
          })),
        }),
    ...(result.details === undefined ? {} : { details: redactJson(result.details, known) }),
    ...(result.structuredOutput === undefined
      ? {}
      : { structuredOutput: redactJson(result.structuredOutput, known) }),
  };
}

/** Who asks, as the user sees it: the root's short id, and the worker's name. */
async function asker(api: ToolExecutionApi, context: Context): Promise<string> {
  return api.commit(async (tx) => {
    const id = api.conversationId;
    const root = shortId(await rootOf(tx, id));
    const parent = await parentOf(tx, id);
    if (parent === undefined) return `${root} front`;
    const worker = (await tx.doc(WorkersDoc, parent)).workers.find(
      (each) => each.conversationId === id,
    );
    return `${root} ${worker?.name ?? "worker"}`;
  }, context);
}

/** Largest file `import` reads: a token or key file, or a `.env`, not a document. */
const IMPORT_MAX_BYTES = 65_536;

/** `KEY=value` in a dotenv-style file, optionally after `export`; quotes around the value are dropped. */
function dotenvValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== key) continue;
    const raw = (match[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    return quoted?.[2] ?? raw;
  }
  return undefined;
}

/**
 * The value `import` stores: the whole file without its trailing newline, or one `key` of a dotenv-style file. Errors
 * name the path and key, never the file's contents.
 */
async function importedValue(path: string, key: string | undefined): Promise<string> {
  const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(resolved)) throw new Error("import needs an absolute path (or one under ~/)");
  const size = (await stat(resolved)).size;
  if (size > IMPORT_MAX_BYTES)
    throw new Error(`${path} is ${size} bytes; import reads at most ${IMPORT_MAX_BYTES}`);
  const text = await readFile(resolved, "utf8");
  if (key === undefined) return text.replace(/\r?\n$/, "");
  const value = dotenvValue(text, key);
  if (value === undefined) throw new Error(`${path} has no ${key}= line`);
  return value;
}

const DESCRIPTION =
  "Credentials by name, never by value. `import` stores a value that is already in a local file without you or the user seeing it: the whole file, or with `key` one KEY=value line of a .env-style file; use it before asking the user for anything you can find on disk. `request` asks the user for a secret (an API key or token: kind value; a site's username and password: kind login) in their signed-in Monchu client and returns at once: you get a notice when it is set or declined, so carry on with other work or end your turn meanwhile. `list` shows stored names, pending requests and last use. To use a secret, write `$NAME` in a bash command (`$env:NAME` in powershell): Monchu puts that secret in the command's environment only. A login NAME gives NAME_USERNAME and NAME_PASSWORD. In agent_browser arguments write `{{secret:NAME}}`; a login with a site fills only on that site. Values never reach you: output containing one shows [secret NAME]. Never ask the user to paste a secret into chat.";

/** The `secret` tool and the redaction of every tool result. */
export function createSecrets(vault: Vault) {
  return defineExtension({
    name: "monchu.secrets",
    tools: [
      defineTool({
        name: "secret",
        description: DESCRIPTION,
        parameters: Type.Object(
          {
            action: Type.Union([
              Type.Literal("request"),
              Type.Literal("import"),
              Type.Literal("list"),
            ]),
            name: Type.Optional(
              Type.String({
                description: "For request and import: env-var shaped, such as GITHUB_TOKEN",
              }),
            ),
            reason: Type.Optional(
              Type.String({
                description:
                  "For request: what it is for, as the user will read it. For import: an optional description",
              }),
            ),
            path: Type.Optional(
              Type.String({
                description: "For import: the file holding the value, absolute or ~/",
              }),
            ),
            key: Type.Optional(
              Type.String({
                description: "For import: read only this KEY=value line of a .env-style file",
              }),
            ),
            kind: Type.Optional(Type.Union([Type.Literal("value"), Type.Literal("login")])),
            site: Type.Optional(
              Type.String({
                description: "For a login: the site's URL; the browser fills it only there",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        replay: "safe",
        execute: async (args, api, context) => {
          if (args.action === "list") {
            const secrets = await vault.list();
            const requests = (await api.snapshot(SecretsDoc, context))?.requests ?? [];
            return text(
              JSON.stringify({
                secrets: secrets.map((info) => ({
                  name: info.name,
                  kind: info.kind,
                  ...(info.site === undefined ? {} : { site: info.site }),
                  ...(info.description === undefined ? {} : { description: info.description }),
                  use: usage(info),
                  set: new Date(info.setAt).toISOString(),
                  ...(info.usedAt === undefined
                    ? {}
                    : { used: new Date(info.usedAt).toISOString() }),
                })),
                pending: requests.map((request) => ({
                  name: request.name,
                  kind: request.kind,
                  reason: request.reason,
                  by: request.by,
                })),
              }),
            );
          }
          const name = args.name ?? "";
          if (!SECRET_NAME.test(name))
            throw new Error(
              `${args.action} needs a name: A-Z, 0-9 and _, starting with a letter, at most 64`,
            );
          if (args.action === "import") {
            if (args.path === undefined || args.path === "")
              throw new Error("import needs the path of the file holding the value");
            if ((args.kind ?? "value") !== "value")
              throw new Error("import stores a value; a login comes in with request");
            const value = await importedValue(args.path, args.key);
            const description = args.reason?.trim();
            await vault.set({
              name,
              kind: "value",
              value,
              ...(description === undefined || description === "" ? {} : { description }),
            });
            return text(
              `Stored ${name} from ${args.path}${args.key === undefined ? "" : ` (${args.key})`}. Use it as $${name}. The file still holds the value: delete it only if you made it or the user says so.`,
            );
          }
          const reason = args.reason?.trim() ?? "";
          if (reason === "") throw new Error("request needs a reason the user will read");
          const kind = args.kind ?? "value";
          const site =
            args.site === undefined || args.site === "" ? undefined : siteOrigin(args.site);
          const taken = (await vault.list()).find(
            (info) =>
              info.name !== name &&
              secretKeys(info).some((key) => secretKeys({ name, kind }).includes(key)),
          );
          if (taken !== undefined)
            throw new Error(`${name} clashes with the stored secret ${taken.name}`);
          const existing = await vault.info(name);
          const by = await asker(api, context);
          const outcome = await api.commit(async (tx) => {
            const state = await tx.doc(SecretsDoc);
            const pending = state.requests.find((request) => request.name === name);
            if (pending !== undefined) {
              if (!pending.waiting.includes(api.conversationId))
                pending.waiting.push(api.conversationId);
              return `already asked by ${pending.by}`;
            }
            state.requests.push({
              id: state.next++,
              name,
              kind,
              reason,
              ...(site === undefined ? {} : { site }),
              by,
              at: Date.now(),
              waiting: [api.conversationId],
            });
            return "asked";
          }, context);
          const replacing =
            existing === undefined
              ? ""
              : ` ${name} is already set; this asks the user to replace it.`;
          return text(
            `${outcome === "asked" ? "Asked" : `Waiting: ${outcome}`}. The user answers in their Monchu client; a notice tells you when ${name} is set or declined.${replacing}`,
          );
        },
      }),
    ],
    hooks: [
      hook(ToolTask, {
        afterTool: async (_call, result) => {
          let known: Awaited<ReturnType<Vault["known"]>>;
          try {
            known = await vault.known();
          } catch (error) {
            return {
              ...result,
              diagnostics: [
                ...(result.diagnostics ?? []),
                {
                  severity: "warn",
                  code: "secrets_unavailable",
                  message: `Secrets could not be read, so this result is not redacted: ${message(error)}`,
                },
              ],
            };
          }
          return known.length === 0 ? undefined : redactResult(result, known);
        },
      }),
    ],
  });
}
