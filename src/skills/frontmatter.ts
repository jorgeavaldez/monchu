/*
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
import { parse } from "yaml";

/** Pi's BOM/newline and YAML front matter handling, narrowed at the file boundary. */
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
} {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return {};
  const parsed: unknown = parse(normalized.slice(4, endIndex));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("skill front matter must be an object");
  return {
    ...("name" in parsed && typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...("description" in parsed && typeof parsed.description === "string"
      ? { description: parsed.description }
      : {}),
    ...("disable-model-invocation" in parsed &&
    typeof parsed["disable-model-invocation"] === "boolean"
      ? { "disable-model-invocation": parsed["disable-model-invocation"] }
      : {}),
  };
}
