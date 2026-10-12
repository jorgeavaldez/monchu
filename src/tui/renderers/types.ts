import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import { str } from "./utils.ts";

/** Only fields used by the built-in presentations, including incomplete model arguments. */
export type RenderArgs = {
  path: string | null;
  command: string | null;
  pattern: string | null;
  glob: string | null;
  content: string | null;
  offset: number | undefined;
  limit: number | undefined;
  timeout: number | undefined;
};

export function parseRenderArgs(value: unknown): RenderArgs {
  const args = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    path: str("path" in args ? args.path : undefined),
    command: str("command" in args ? args.command : undefined),
    pattern: str("pattern" in args ? args.pattern : undefined),
    glob: str("glob" in args ? args.glob : undefined),
    content: str("content" in args ? args.content : undefined),
    offset: "offset" in args && typeof args.offset === "number" ? args.offset : undefined,
    limit: "limit" in args && typeof args.limit === "number" ? args.limit : undefined,
    timeout: "timeout" in args && typeof args.timeout === "number" ? args.timeout : undefined,
  };
}

type ToolDetails = {
  diff?: string;
  fullOutputPath?: string;
  matchLimitReached?: number;
  resultLimitReached?: number;
  entryLimitReached?: number;
  linesTruncated?: boolean;
  truncation?: {
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    firstLineExceedsLimit: boolean;
    outputLines: number;
    totalLines: number;
    maxLines?: number;
    maxBytes?: number;
  };
};

/** Details are erased JSON in Durable's transcript and live output. Narrow them once. */
export function parseToolDetails(value: unknown): ToolDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const truncation =
    "truncation" in value &&
    value.truncation !== null &&
    typeof value.truncation === "object" &&
    !Array.isArray(value.truncation)
      ? value.truncation
      : undefined;
  return {
    ...("diff" in value && typeof value.diff === "string" ? { diff: value.diff } : {}),
    ...("fullOutputPath" in value && typeof value.fullOutputPath === "string"
      ? { fullOutputPath: value.fullOutputPath }
      : {}),
    ...("matchLimitReached" in value && typeof value.matchLimitReached === "number"
      ? { matchLimitReached: value.matchLimitReached }
      : {}),
    ...("resultLimitReached" in value && typeof value.resultLimitReached === "number"
      ? { resultLimitReached: value.resultLimitReached }
      : {}),
    ...("entryLimitReached" in value && typeof value.entryLimitReached === "number"
      ? { entryLimitReached: value.entryLimitReached }
      : {}),
    ...("linesTruncated" in value && typeof value.linesTruncated === "boolean"
      ? { linesTruncated: value.linesTruncated }
      : {}),
    ...(truncation === undefined
      ? {}
      : {
          truncation: {
            truncated: "truncated" in truncation && truncation.truncated === true,
            truncatedBy:
              "truncatedBy" in truncation &&
              (truncation.truncatedBy === "lines" || truncation.truncatedBy === "bytes")
                ? truncation.truncatedBy
                : null,
            firstLineExceedsLimit:
              "firstLineExceedsLimit" in truncation && truncation.firstLineExceedsLimit === true,
            outputLines:
              "outputLines" in truncation && typeof truncation.outputLines === "number"
                ? truncation.outputLines
                : 0,
            totalLines:
              "totalLines" in truncation && typeof truncation.totalLines === "number"
                ? truncation.totalLines
                : 0,
            ...("maxLines" in truncation && typeof truncation.maxLines === "number"
              ? { maxLines: truncation.maxLines }
              : {}),
            ...("maxBytes" in truncation && typeof truncation.maxBytes === "number"
              ? { maxBytes: truncation.maxBytes }
              : {}),
          },
        }),
  };
}

export type RenderResult = {
  content: ToolResultMessage["content"];
  details: ToolDetails;
  isError: boolean;
};
export type ToolRenderResultOptions = { expanded: boolean; isPartial: boolean };
export type ToolRenderContext = {
  args: RenderArgs;
  cwd: string;
  expanded: boolean;
  isPartial: boolean;
  showImages: boolean;
  isError: boolean;
  argsComplete: boolean;
  lastComponent: Component | undefined;
};

export type ToolRenderers = {
  renderCall(args: RenderArgs, theme: Theme, context: ToolRenderContext): Component;
  renderResult(
    result: RenderResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext,
  ): Component;
};
