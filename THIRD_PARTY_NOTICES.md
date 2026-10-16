# Third-party notices

Monchu includes code ported or adapted from the MIT-licensed projects below.
Each such file keeps its original copyright and license notice in its header.
Dependencies installed from npm carry their own licenses in `node_modules`.

| Project                                                                              | Copyright                            | Used in                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi) (coding agent, Durable TUI, skill loader) | Copyright (c) 2025 Mario Zechner     | `src/skills/`, `src/config.ts`, `src/mcp-cli.ts`, `src/mcp-config.ts`, `src/models/credentials.ts`, `src/tool-search.ts`, `src/tui/view.ts`, `src/tui/components/`, `src/tui/renderers/`, `src/tui/theme/` |
| [pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) 0.11.0      | Copyright (c) 2025 Dmitriy Kovalenko | `src/fff.ts`                                                                                                                                                                                               |
| [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.2           | Copyright (c) 2026 Eli Dickinson     | `src/models/claude-code.ts`, `src/models/claude-session.ts`                                                                                                                                                |
| [strip-ansi](https://github.com/chalk/strip-ansi)                                    | Copyright (c) Sindre Sorhus          | `src/tui/renderers/ansi.ts`                                                                                                                                                                                |

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
