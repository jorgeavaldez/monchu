/*
Adapted from Pi packages/coding-agent/src/core/tools/renderers/edit.ts.

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
import { renderDiff } from "../components/diff.ts";
import { renderToolPath, getTextOutput } from "./utils.ts";
import type { ToolRenderers } from "./types.ts";

/** Rendering never reads a live file to speculate about an uncommitted edit. */
export const editRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(
      `${theme.fg("toolTitle", theme.bold("edit"))} ${renderToolPath(args.path, theme, context.cwd)}`,
    );
    return text;
  },
  renderResult(result, _options, theme, context) {
    const component =
      context.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    const output = context.isError
      ? theme.fg("error", getTextOutput(result, context.showImages))
      : result.details.diff
        ? renderDiff(result.details.diff)
        : getTextOutput(result, context.showImages);
    if (output) {
      component.addChild(new Spacer(1));
      component.addChild(new Text(output, 0, 0));
    }
    return component;
  },
};
