/*
Adapted from Pi packages/coding-agent/src/modes/interactive/theme/light.json and dark.json.

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
// Pi's built-in palettes, resolved from theme/light.json and theme/dark.json.
export const dark = {
  accent: "okhsl(295 50% 67%)",
  border: "okhsl(231 57% 65%)",
  borderAccent: "okhsl(295 53% 64%)",
  borderMuted: "okhsl(229 8% 53%)",
  success: "okhsl(159 59% 67%)",
  error: "okhsl(20 72% 67%)",
  warning: "okhsl(83 88% 67%)",
  muted: "okhsl(229 6% 67%)",
  dim: "okhsl(229 8% 56%)",
  text: "okhsl(234 3% 89%)",
  thinkingText: "okhsl(226 7% 65%)",
  selectedBg: "okhsl(233 41% 24%)",
  scrollbarTrack: "okhsl(237 7% 33%)",
  scrollbarThumb: "okhsl(232 7% 65%)",
  searchMatchBg: "okhsl(53 51% 24%)",
  searchMatchText: "okhsl(229 6% 67%)",
  userMessageBg: "okhsl(233 41% 24%)",
  userMessageText: "okhsl(234 3% 89%)",
  customMessageBg: "okhsl(295 42% 24%)",
  customMessageText: "okhsl(229 6% 67%)",
  customMessageLabel: "okhsl(295 50% 67%)",
  toolPendingBg: "okhsl(229 5% 24%)",
  toolSuccessBg: "okhsl(158 46% 25%)",
  toolErrorBg: "okhsl(19 54% 25%)",
  toolTitle: "okhsl(234 3% 89%)",
  toolOutput: "okhsl(229 6% 67%)",
  mdHeading: "okhsl(83 88% 67%)",
  mdLink: "okhsl(232 54% 67%)",
  mdLinkUrl: "okhsl(229 6% 67%)",
  mdCode: "okhsl(295 50% 67%)",
  mdCodeBlock: "okhsl(159 59% 67%)",
  mdCodeBlockBorder: "okhsl(229 6% 67%)",
  mdQuote: "okhsl(229 6% 67%)",
  mdQuoteBorder: "okhsl(229 6% 67%)",
  mdHr: "okhsl(229 6% 67%)",
  mdListBullet: "okhsl(295 50% 67%)",
  toolDiffAdded: "okhsl(159 59% 67%)",
  toolDiffRemoved: "okhsl(20 72% 67%)",
  toolDiffContext: "okhsl(229 6% 67%)",
  syntaxComment: "okhsl(229 6% 67%)",
  syntaxKeyword: "okhsl(232 54% 67%)",
  syntaxFunction: "okhsl(83 88% 67%)",
  syntaxVariable: "okhsl(202 58% 67%)",
  syntaxString: "okhsl(52 67% 67%)",
  syntaxNumber: "okhsl(159 59% 67%)",
  syntaxType: "okhsl(295 50% 67%)",
  syntaxOperator: "okhsl(229 6% 67%)",
  syntaxPunctuation: "okhsl(229 6% 67%)",
  thinkingOff: "okhsl(229 8% 49%)",
  thinkingMinimal: "okhsl(232 20% 52%)",
  thinkingLow: "okhsl(232 45% 54%)",
  thinkingMedium: "okhsl(263 59% 56%)",
  thinkingHigh: "okhsl(295 73% 59%)",
  thinkingXhigh: "okhsl(337 81% 61%)",
  thinkingMax: "okhsl(20 99% 63%)",
  bashMode: "okhsl(159 64% 65%)",
};
export const light = {
  accent: "okhsl(295 60% 46%)",
  border: "okhsl(231 67% 55%)",
  borderAccent: "okhsl(295 59% 55%)",
  borderMuted: "okhsl(235 7% 66%)",
  success: "okhsl(159 75% 46%)",
  error: "okhsl(20 91% 47%)",
  warning: "okhsl(83 99% 47%)",
  muted: "okhsl(229 8% 47%)",
  dim: "okhsl(229 7% 59%)",
  text: "okhsl(225 5% 27%)",
  thinkingText: "okhsl(234 8% 55%)",
  selectedBg: "okhsl(235 19% 91%)",
  scrollbarTrack: "okhsl(248 3% 90%)",
  scrollbarThumb: "okhsl(226 7% 65%)",
  searchMatchBg: "okhsl(56 22% 91%)",
  searchMatchText: "okhsl(229 8% 47%)",
  userMessageBg: "okhsl(235 19% 91%)",
  userMessageText: "okhsl(225 5% 27%)",
  customMessageBg: "okhsl(295 25% 91%)",
  customMessageText: "okhsl(229 8% 47%)",
  customMessageLabel: "okhsl(295 60% 46%)",
  toolPendingBg: "okhsl(248 3% 91%)",
  toolSuccessBg: "okhsl(156 21% 91%)",
  toolErrorBg: "okhsl(24 23% 91%)",
  toolTitle: "okhsl(225 5% 27%)",
  toolOutput: "okhsl(229 8% 47%)",
  mdHeading: "okhsl(83 99% 47%)",
  mdLink: "okhsl(231 68% 47%)",
  mdLinkUrl: "okhsl(229 8% 47%)",
  mdCode: "okhsl(295 60% 46%)",
  mdCodeBlock: "okhsl(159 75% 46%)",
  mdCodeBlockBorder: "okhsl(229 8% 47%)",
  mdQuote: "okhsl(229 8% 47%)",
  mdQuoteBorder: "okhsl(229 8% 47%)",
  mdHr: "okhsl(229 8% 47%)",
  mdListBullet: "okhsl(295 60% 46%)",
  toolDiffAdded: "okhsl(159 75% 46%)",
  toolDiffRemoved: "okhsl(20 91% 47%)",
  toolDiffContext: "okhsl(229 8% 47%)",
  syntaxComment: "okhsl(229 8% 47%)",
  syntaxKeyword: "okhsl(231 68% 47%)",
  syntaxFunction: "okhsl(83 99% 47%)",
  syntaxVariable: "okhsl(203 73% 46%)",
  syntaxString: "okhsl(52 84% 46%)",
  syntaxNumber: "okhsl(159 75% 46%)",
  syntaxType: "okhsl(295 60% 46%)",
  syntaxOperator: "okhsl(229 8% 47%)",
  syntaxPunctuation: "okhsl(229 8% 47%)",
  thinkingOff: "okhsl(223 5% 80%)",
  thinkingMinimal: "okhsl(229 14% 78%)",
  thinkingLow: "okhsl(232 33% 76%)",
  thinkingMedium: "okhsl(264 48% 74%)",
  thinkingHigh: "okhsl(295 62% 72%)",
  thinkingXhigh: "okhsl(337 74% 70%)",
  thinkingMax: "okhsl(20 98% 68%)",
  bashMode: "okhsl(159 74% 55%)",
};
