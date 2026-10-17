/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/user-message.ts.

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
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { AttachedFile } from "../../api/attachments.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** One muted line per attached file: its name, size, and type when it isn't an image shown to the model. */
function attachedLines(files: readonly AttachedFile[]): string {
  return files
    .map((file) =>
      theme.fg(
        "muted",
        `attached · ${file.name} · ${file.size}${file.detail?.startsWith("shown") ? " · image" : ` · ${file.mimeType}`}`,
      ),
    )
    .join("\n");
}

/**
 * Component that renders a user message, and the files attached to it
 */
export class UserMessageComponent extends Container {
  constructor(text: string, files: readonly AttachedFile[] = []) {
    super();
    const background = (content: string) => theme.bg("userMessageBg", content);
    // A message of only attachments shows just their lines, padded as the text would be.
    if (!text.trim() && files.length > 0) {
      this.addChild(new Text(attachedLines(files), 1, 1, background));
      return;
    }
    // The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
    // line, with identical output.
    this.addChild(
      new Markdown(
        text,
        1,
        1,
        getMarkdownTheme(),
        {
          color: (content: string) => theme.fg("userMessageText", content),
          bgColor: (content: string) => theme.bg("userMessageBg", content),
        },
        {
          preserveOrderedListMarkers: true,
          preserveBackslashEscapes: true,
        },
      ),
    );
    if (files.length > 0) this.addChild(new Text(attachedLines(files), 1, 0, background));
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) {
      return lines;
    }

    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    return lines;
  }
}
