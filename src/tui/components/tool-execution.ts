/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/tool-execution.ts.

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
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  Box,
  type Component,
  Container,
  getCapabilities,
  Image,
  MouseRegion,
  Spacer,
  Text,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { toolRenderers } from "../renderers/index.ts";
import {
  parseRenderArgs,
  parseToolDetails,
  type RenderArgs,
  type RenderResult,
  type ToolRenderContext,
  type ToolRenderers,
} from "../renderers/types.ts";
import { formatToolCallWithArgs, getTextOutput } from "../renderers/utils.ts";
import { ensurePngTranscoder } from "./image-convert.ts";
import { theme } from "../theme/theme.ts";

const FALLBACK_PREVIEW_LINES = 10;

/** The first meaningful line of a tool's text output, the newest while it runs; never bare JSON punctuation. */
function summaryLine(output: string, newest: boolean): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[[\]{}(),]+$/.test(line));
  return newest ? lines.at(-1) : lines[0];
}

/** One row cut to the width, never wrapped: a compact card stays one row per line on a phone. */
class Row implements Component {
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(width: number): string[] {
    return [truncateToWidth(this.text, width, "…")];
  }
  invalidate(): void {}
}

/** Presentation only: a tool call plus Durable's partial or committed result. */
export class ToolExecutionComponent extends Container {
  private readonly box: Box;
  private readonly toolName: string;
  private readonly ui: TUI;
  private readonly cwd: string;
  private readonly changed: (card: ToolExecutionComponent) => void;
  private callComponent: Component | undefined;
  private resultComponent: Component | undefined;
  private rawArgs: unknown;
  private args: RenderArgs;
  private expanded = false;
  private argsComplete = false;
  private isPartial = true;
  private result: RenderResult | undefined;
  private partialOutput: { text: string; details: unknown } | undefined;
  private readonly renderer: ToolRenderers | undefined;
  private imageComponents: Image[] = [];
  private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
  private imageSpacers: Spacer[] = [];
  private readonly imageWidthCells = 60;
  private readonly showImages = true;

  /** `changed` hears every change to the card's lines, including clicks and late image conversion. */
  constructor(
    toolName: string,
    args: unknown,
    ui: TUI,
    cwd: string,
    changed: (card: ToolExecutionComponent) => void,
  ) {
    super();
    this.toolName = toolName;
    this.ui = ui;
    this.cwd = cwd;
    this.changed = changed;
    this.rawArgs = args;
    this.args = parseRenderArgs(args);
    this.renderer = toolRenderers.get(toolName);
    this.addChild(new Spacer(1));
    // A tool without its own renderer (goals, memory, workers, jj, herdr...) gets a compact card, without padding rows.
    this.box = new Box(1, this.renderer === undefined ? 0 : 1, (text) =>
      theme.bg("toolPendingBg", text),
    );
    this.addChild(this.box);
    this.updateDisplay();
  }

  /** Whether a committed result arrived; until then Durable revisions may still change the card. */
  get finished(): boolean {
    return this.result !== undefined && !this.isPartial;
  }

  updateArgs(args: unknown): void {
    if (args === this.rawArgs) return;
    this.rawArgs = args;
    this.args = parseRenderArgs(args);
    this.updateDisplay();
  }

  setArgsComplete(): void {
    if (this.argsComplete) return;
    this.argsComplete = true;
    this.updateDisplay();
  }

  /** Durable's running output so far. Revisions repeat it unchanged while other state moves. */
  updatePartialOutput(text: string, details: unknown): void {
    if (this.partialOutput?.text === text && this.partialOutput.details === details) return;
    this.partialOutput = { text, details };
    this.updateResult({ content: [{ type: "text", text }], details, isError: false }, true);
  }

  updateResult(
    result: { content: ToolResultMessage["content"]; details?: unknown; isError: boolean },
    isPartial = false,
  ): void {
    this.result = { ...result, details: parseToolDetails(result.details) };
    this.isPartial = isPartial;
    this.updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateDisplay();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  private context(lastComponent: Component | undefined): ToolRenderContext {
    return {
      args: this.args,
      cwd: this.cwd,
      lastComponent,
      argsComplete: this.argsComplete,
      expanded: this.expanded,
      isPartial: this.isPartial,
      showImages: this.showImages,
      isError: this.result?.isError ?? false,
    };
  }

  private resultRegion(component: Component): MouseRegion {
    return new MouseRegion(component, (event) => {
      if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
      this.setExpanded(!this.expanded);
      this.ui.requestRender();
      return { handled: true };
    });
  }

  private fallbackResult(): Component | undefined {
    const output = getTextOutput(this.result, this.showImages);
    if (!output) return undefined;
    const lines = output.split("\n");
    const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
    const remaining = lines.length - displayLines.length;
    let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
    if (remaining > 0)
      text += theme.fg("muted", `\n... (${remaining} more lines, ctrl+o to expand)`);
    return new Text(text, 0, 0);
  }

  /**
   * A tool without its own renderer, collapsed as worker updates are: a ▸ header row and one row summarizing the result
   * (the newest line while it runs) with its line count. Expanded (Ctrl+O or a click): every argument and the output.
   */
  private compact(): void {
    const marker = theme.fg("muted", this.expanded ? "▾ " : "▸ ");
    const call = formatToolCallWithArgs(this.toolName, this.rawArgs, theme, this.expanded);
    this.callComponent = this.expanded
      ? new Text(`${marker}${call}`, 0, 0)
      : new Row(`${marker}${call}`);
    this.box.addChild(this.resultRegion(this.callComponent));
    if (this.result === undefined) return;
    if (this.expanded) {
      this.resultComponent = this.fallbackResult();
    } else {
      const output = getTextOutput(this.result, this.showImages);
      const lines = output ? output.split("\n").length : 0;
      const summary = output ? summaryLine(output, this.isPartial) : undefined;
      const more = lines > 1 ? theme.fg("muted", ` · ${lines} lines`) : "";
      this.resultComponent =
        summary === undefined && !more
          ? undefined
          : new Row(
              `  ${theme.fg(this.result.isError ? "error" : "toolOutput", summary ?? "")}${more}`,
            );
    }
    if (this.resultComponent) this.box.addChild(this.resultRegion(this.resultComponent));
  }

  private updateDisplay(): void {
    this.box.setBgFn(
      this.isPartial
        ? (text) => theme.bg("toolPendingBg", text)
        : this.result?.isError
          ? (text) => theme.bg("toolErrorBg", text)
          : (text) => theme.bg("toolSuccessBg", text),
    );
    this.box.clear();
    if (this.renderer === undefined) this.compact();
    else {
      try {
        this.callComponent = this.renderer.renderCall(
          this.args,
          theme,
          this.context(this.callComponent),
        );
      } catch {
        this.callComponent = new Text(
          formatToolCallWithArgs(this.toolName, this.rawArgs, theme, this.expanded),
          0,
          0,
        );
      }
      this.box.addChild(this.resultRegion(this.callComponent));
      if (this.result) {
        try {
          this.resultComponent = this.renderer.renderResult(
            this.result,
            { expanded: this.expanded, isPartial: this.isPartial },
            theme,
            this.context(this.resultComponent),
          );
        } catch {
          this.resultComponent = this.fallbackResult();
        }
        if (this.resultComponent) this.box.addChild(this.resultRegion(this.resultComponent));
      }
    }
    const previousImages = this.imageComponents;
    const previousSources = this.imageSources;
    for (const img of this.imageComponents) {
      this.removeChild(img);
    }
    this.imageComponents = [];
    this.imageSources = [];
    for (const spacer of this.imageSpacers) {
      this.removeChild(spacer);
    }
    this.imageSpacers = [];

    if (this.result) {
      const imageBlocks = this.result.content.filter((c) => c.type === "image");
      const caps = getCapabilities();
      for (const img of imageBlocks) {
        if (caps.images && this.showImages && img.data && img.mimeType) {
          const spacer = new Spacer(1);
          this.addChild(spacer);
          this.imageSpacers.push(spacer);
          const source = {
            data: img.data,
            mimeType: img.mimeType,
            widthCells: this.imageWidthCells,
          };
          const index = this.imageComponents.length;
          const previous = previousSources[index];
          const previousImage = previousImages[index];
          const imageComponent =
            previousImage &&
            previous?.data === source.data &&
            previous.mimeType === source.mimeType &&
            previous.widthCells === source.widthCells
              ? previousImage
              : new Image(
                  source.data,
                  source.mimeType,
                  { fallbackColor: (s: string) => theme.fg("toolOutput", s) },
                  { maxWidthCells: source.widthCells },
                );
          if (source.mimeType !== "image/png") {
            ensurePngTranscoder(() => {
              this.invalidate();
              this.ui.requestRender();
            });
          }
          this.imageComponents.push(imageComponent);
          this.imageSources.push(source);
          this.addChild(imageComponent);
        }
      }
    }
    this.changed(this);
  }
}
