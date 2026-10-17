/*
The BM25 ranker and tool documents are ported from Pi's coding-agent tool search
(packages/coding-agent/src/extensions/tool-search/tool.ts):
https://github.com/earendil-works/pi
Copyright (c) 2025 Mario Zechner
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";

/** Extensions named with this prefix are tool groups: installed, but offered only once `tool_search` loads them. */
const GROUP_PREFIX = "monchu.group.";
/** Groups whose tools only codemode scripts reach (Pi's `codemode` exposure); `tool_search` never loads them. */
const CODEMODE_PREFIX = "monchu.codemode.";

/**
 * Tools kept out of the prompt until a conversation needs them. A group loads as a whole and never unloads: providers
 * keep the prompt cache only while a conversation's tools are added, never removed or redeclared.
 */
export type ToolGroup = {
  /** Lowercase id, such as `browser` or `mcp-ketch`. */
  readonly name: string;
  /** One line in the deferred-tools section, so the model knows what to search for. */
  readonly summary: string;
  readonly tools: readonly ToolRegistration[];
  /**
   * Loaded from the start in conversations on the Claude Code bridge, whose prompt cache does not survive a tool change.
   * Codex loads tools in place without a cache miss, so its conversations still search for every group.
   */
  readonly preload?: boolean;
  /** Reached only from codemode scripts through `searchTools()`, never declared to the model. */
  readonly codemode?: boolean;
  /** Guide or instructions returned once when the group loads, instead of sitting in every prompt. */
  details?(api: ToolExecutionApi, context: Context): Promise<string | undefined>;
};

function isGroupExtension(name: string): boolean {
  return name.startsWith(GROUP_PREFIX);
}

/** Whether codemode scripts may call the tools of this installed but unselected extension. */
export function isScriptExtension(name: string): boolean {
  return name.startsWith(GROUP_PREFIX) || name.startsWith(CODEMODE_PREFIX);
}

/**
 * Drop loaded groups from a conversation's stored agent, so it starts from the base tool set. A new worker copies its
 * parent's agent, and searches for what its own domain needs.
 */
export async function unloadGroups(tx: Tx, conversationId: ConversationId): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const selected = agent.extensions;
  if (Array.isArray(selected))
    agent.extensions = selected.filter((name) => !isGroupExtension(name));
  else if (selected?.add !== undefined)
    agent.extensions = {
      ...selected,
      add: selected.add.filter((name) => !isGroupExtension(name)),
    };
}

/** The provider whose conversations load preloaded groups from the start. */
const PRELOAD_PROVIDER = "claude-code";

/**
 * Load the preloaded groups into a conversation on the Claude Code bridge. Groups are only ever added: removing a tool
 * would cost the cache the preload is there to keep.
 */
export async function preloadGroups(
  tx: Tx,
  conversationId: ConversationId,
  preload: readonly string[],
): Promise<void> {
  if (preload.length === 0) return;
  const agent = await tx.doc(AgentDoc, conversationId);
  if (agent.model?.provider === PRELOAD_PROVIDER) await loadExtensions(tx, conversationId, preload);
}

/** Select extensions for a conversation from its next request, keeping its other choices. */
async function loadExtensions(
  tx: Tx,
  conversationId: ConversationId,
  names: readonly string[],
): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const selected = agent.extensions;
  if (Array.isArray(selected)) {
    agent.extensions = [...selected, ...names.filter((name) => !selected.includes(name))];
    return;
  }
  const add = selected?.add ?? [];
  agent.extensions = {
    ...selected,
    add: [...add, ...names.filter((name) => !add.includes(name))],
    ...(selected?.remove === undefined
      ? {}
      : { remove: selected.remove.filter((name) => !names.includes(name)) }),
  };
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
  if (!isObject(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

/** A ranked document: a key the caller resolves, and its search text. */
type SearchDocument = { key: string; text: string };

/** Search text of a tool: its name, the name with `_` as spaces, its description and schema, and its group. */
export function toolDocument(
  key: string,
  tool: Pick<ToolRegistration, "name" | "description" | "parameters">,
  group?: Pick<ToolGroup, "name" | "summary">,
): SearchDocument {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  if (group !== undefined) parts.push(group.name, group.name.replaceAll("-", " "), group.summary);
  return { key, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 (k1 1.2, b 0.75): the keys of matching documents, best first. Ties keep document order. */
export function rankDocuments(
  query: string,
  documents: readonly SearchDocument[],
  limit: number,
): string[] {
  const k1 = 1.2;
  const b = 0.75;
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
  const termCounts = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const lengths = termCounts.map((counts) =>
    [...counts.values()].reduce((sum, count) => sum + count, 0),
  );
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
  const idf = new Map(
    queryTerms.map((term) => {
      const frequency = termCounts.filter((counts) => counts.has(term)).length;
      return [
        term,
        Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)),
      ] as const;
    }),
  );
  const matches: { key: string; score: number }[] = [];
  documents.forEach((document, index) => {
    const counts = termCounts[index];
    const length = lengths[index];
    if (counts === undefined || length === undefined) return;
    let score = 0;
    for (const term of queryTerms) {
      const count = counts.get(term);
      if (!count) continue;
      const norm = k1 * (1 - b + (b * length) / averageLength);
      score += (idf.get(term) ?? 0) * ((count * (k1 + 1)) / (count + norm));
    }
    if (score > 0) matches.push({ key: document.key, score });
  });
  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((match) => match.key);
}

const DEFAULT_LIMIT = 8;

/**
 * `tool_search` and the deferred-tools section over `groups`, and one extension per group. The groups are installed but
 * left out of the host default selection; `tool_search` adds the matching ones to the calling conversation's agent.
 * The section and the tool description list only what is configured, never what one conversation loaded, so the
 * prompt stays the same while groups load.
 */
export function createToolSearch(all: readonly ToolGroup[]) {
  const groups = all.filter((group) => group.codemode !== true);
  const scripted = all.filter((group) => group.codemode === true);
  const scriptExtensions = scripted.map((group) =>
    defineExtension({ name: `${CODEMODE_PREFIX}${group.name}`, tools: group.tools }),
  );
  const extensions = new Map(
    groups.map((group) => [
      group.name,
      defineExtension({ name: `${GROUP_PREFIX}${group.name}`, tools: group.tools }),
    ]),
  );
  const prompt = [
    ...(groups.length
      ? [
          "Deferred tools: these groups are not in your tools until you load them (on some models a few are loaded from the start). Call tool_search with what you need; it loads the matching groups, with any guide they carry, from your next call on. Codemode scripts can call deferred tools without loading them: find them with searchTools(query).",
          ...groups.map(
            (group) =>
              `- ${group.name}: ${group.summary} (${group.tools.map((tool) => tool.name).join(", ")})`,
          ),
        ]
      : []),
    ...(scripted.length
      ? [
          "Codemode tools: only codemode scripts call these; find them with searchTools(query) and describeTool(name).",
          ...scripted.map((group) => `- ${group.name}: ${group.summary}`),
        ]
      : []),
  ].join("\n");
  const toolSearch = defineTool({
    name: "tool_search",
    description:
      "Load deferred tools (see Deferred tools in your instructions) by searching their names, descriptions and groups. Matching groups join your tools from your next call and stay for the rest of this conversation; the result lists them and includes any guide they carry, so read it before using them.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, description: "What you need, or a group name" }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            description: `Most tools to match (default ${DEFAULT_LIMIT})`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    // Loading only adds names to the agent, so a rerun loads the same groups.
    replay: "safe",
    execute: async ({ query, limit }, api, context) => {
      const agent = await api.agent(context);
      const selected = new Set(agent.extensions.map((extension) => extension.name));
      const candidates = groups.filter((group) => {
        const extension = extensions.get(group.name);
        return (
          extension !== undefined &&
          !selected.has(extension.name) &&
          api.registry.extension(extension.name) !== undefined
        );
      });
      const loaded = groups.filter((group) => selected.has(extensions.get(group.name)?.name ?? ""));
      const named = candidates.filter((group) => group.name === query.trim().toLowerCase());
      const keys = rankDocuments(
        query,
        candidates.flatMap((group) =>
          group.tools.map((tool) => toolDocument(`${group.name}\0${tool.name}`, tool, group)),
        ),
        limit ?? DEFAULT_LIMIT,
      );
      const matched = [
        ...named,
        ...candidates.filter(
          (group) =>
            !named.includes(group) && keys.some((key) => key.startsWith(`${group.name}\0`)),
        ),
      ];
      if (matched.length === 0) {
        const lines = ["No deferred tools matched."];
        if (candidates.length)
          lines.push(`Not loaded: ${candidates.map((group) => group.name).join(", ")}.`);
        if (loaded.length)
          lines.push(
            `Already in your tools: ${loaded.map((group) => `${group.name} (${group.tools.map((tool) => tool.name).join(", ")})`).join("; ")}.`,
          );
        return { output: [{ type: "text", text: lines.join("\n") }], details: { loaded: [] } };
      }
      await api.commit(
        (tx) =>
          loadExtensions(
            tx,
            api.conversationId,
            matched.flatMap((group) => extensions.get(group.name)?.name ?? []),
          ),
        context,
      );
      const sections: string[] = [];
      for (const group of matched) {
        const lines = [`Loaded ${group.name}. Its tools are available from your next call:`];
        for (const tool of group.tools)
          lines.push(`- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0] ?? ""}`);
        let details: string | undefined;
        try {
          details = (await group.details?.(api, context))?.trim();
        } catch (error) {
          details = `Its guide failed to load: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (details) lines.push("", `<${group.name}_guide>`, details, `</${group.name}_guide>`);
        sections.push(lines.join("\n"));
      }
      return {
        output: [{ type: "text", text: sections.join("\n\n") }],
        details: { loaded: matched.map((group) => group.name) },
      };
    },
  });
  return {
    extension: defineExtension({
      name: "monchu.tool-search",
      tools: groups.length ? [toolSearch] : [],
      sections: [section("deferred_tools", () => prompt || undefined, { tag: false })],
    }),
    groups: [...extensions.values(), ...scriptExtensions] satisfies Extension[],
    /** Extension names of the groups conversations on the Claude Code bridge load from the start. */
    preload: groups.flatMap((group) =>
      group.preload === true ? (extensions.get(group.name)?.name ?? []) : [],
    ),
  };
}
