# Third-party notices

Monchu includes code ported or adapted from the MIT-licensed projects below.
Each such file keeps its original copyright and license notice in its header.
Dependencies installed from npm carry their own licenses in `node_modules`.
The web client in `dist/web` is bundled from MIT-licensed packages whose license comments the bundle drops: [Preact](https://github.com/preactjs/preact) (Copyright (c) 2015-present Jason Miller), [@preact/signals](https://github.com/preactjs/signals) (Copyright (c) 2022-present Preact Team) and [Chord](https://github.com/earendil-works/pi/tree/main/packages/chord) (Earendil Works); the license below applies to each.

| Project                                                                              | Copyright                            | Used in                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi) (coding agent, Durable TUI, skill loader) | Copyright (c) 2025 Mario Zechner     | `src/core/skills/`, `src/core/config.ts`, `src/core/mcp/cli.ts`, `src/core/mcp/config.ts`, `src/core/models/credentials.ts`, `src/core/tools/tool-search.ts`, `src/tui/view.ts`, `src/tui/components/`, `src/tui/renderers/`, `src/tui/theme/` |
| [pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) 0.11.0      | Copyright (c) 2025 Dmitriy Kovalenko | `src/core/tools/fff.ts`                                                                                                                                                                                                                        |
| [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.2           | Copyright (c) 2026 Eli Dickinson     | `src/core/models/claude-code.ts`, `src/core/models/claude-session.ts`                                                                                                                                                                          |
| [strip-ansi](https://github.com/chalk/strip-ansi)                                    | Copyright (c) Sindre Sorhus          | `src/tui/renderers/ansi.ts`                                                                                                                                                                                                                    |

All of them are under the MIT License:

```text
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
```
