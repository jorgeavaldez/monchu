/*
Adapted from Pi packages/coding-agent/src/core/tools/renderers/bash.ts.

MIT License

Copyright (c) 2025 Mario Zechner

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
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { VisualLinePreview } from "../components/visual-truncate.ts";
import { theme } from "../theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions, RenderArgs, RenderResult } from "./types.ts";
import { getTextOutput, invalidArgText } from "./utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

const BASH_PREVIEW_LINES = 5;
function formatShellCall(args: RenderArgs, prompt: string): string {
  const command = args.command;
  const timeout = args.timeout;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const commandDisplay =
    command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
  return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
  component: Container,
  result: RenderResult,
  options: ToolRenderResultOptions,
  showImages: boolean,
): void {
  component.clear();

  let output = getTextOutput(result, showImages).trim();
  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild(new Spacer(1));
      component.addChild(
        new VisualLinePreview({
          text: styledOutput,
          maxVisualLines: BASH_PREVIEW_LINES,
          keep: "end",
          formatHint: (hidden) =>
            theme.fg("muted", `... (${hidden} earlier lines,`) +
            ` ${theme.fg("muted", "ctrl+o to expand")}${theme.fg("muted", ")")}`,
        }),
      );
    }
  }

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) {
      warnings.push(`Full output: ${fullOutputPath}`);
    }
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(
          `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
        );
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): ToolRenderers {
  return {
    renderCall(args, _theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(formatShellCall(args, prompt));
      return text;
    },
    renderResult(result, options, _theme, context) {
      const component =
        context.lastComponent instanceof Container ? context.lastComponent : new Container();
      rebuildBashResultRenderComponent(component, result, options, context.showImages);
      component.invalidate();
      return component;
    },
  };
}
