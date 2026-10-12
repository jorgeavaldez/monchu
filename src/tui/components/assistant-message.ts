/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/assistant-message.ts.

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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
  private readonly contentContainer: Container;
  private readonly markdownTheme = getMarkdownTheme();
  private readonly message: AssistantMessage;
  private hasToolCalls = false;

  constructor(message: AssistantMessage) {
    super();
    this.message = message;

    // Container for visible text only
    this.contentContainer = new Container();
    this.addChild(this.contentContainer);

    this.updateContent();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateContent();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.hasToolCalls || lines.length === 0) {
      return lines;
    }

    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    return lines;
  }

  private updateContent(): void {
    const message = this.message;

    // Clear content container
    this.contentContainer.clear();

    const hasVisibleContent = message.content.some((c) => c.type === "text" && c.text.trim());

    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }

    // Render content in order
    for (const content of message.content) {
      if (content.type === "text" && content.text.trim()) {
        // Assistant text messages with no background - trim the text
        // Set paddingY=0 to avoid extra spacing before tool executions
        this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
      }
    }

    // Check if incomplete/failed - show after partial content.
    // For aborted/error tool calls, tool execution components show the error.
    // Length stops can happen before a tool call is complete, so surface them here too.
    const hasToolCalls = message.content.some((c) => c.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(
        new Text(theme.fg("error", "Response was truncated before completion."), 1, 0),
      );
    } else if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const abortMessage =
          message.errorMessage && message.errorMessage !== "Request was aborted"
            ? message.errorMessage
            : "Operation aborted";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
      } else if (message.stopReason === "error") {
        const errorMsg = message.errorMessage || "Unknown error";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
      }
    }
  }
}
