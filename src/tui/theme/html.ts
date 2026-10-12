/*
Adapted from Pi packages/coding-agent/src/utils/html.ts.

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
interface DecodedHtmlEntity {
  text: string;
  length: number;
}

function decodeCodePoint(codePoint: number): string | undefined {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntity(entity: string): string | undefined {
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }

  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
  }

  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
  }

  return undefined;
}

export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
  const semicolonIndex = html.indexOf(";", index + 1);
  if (semicolonIndex === -1 || semicolonIndex - index > 16) {
    return undefined;
  }

  const entity = html.slice(index + 1, semicolonIndex);
  const decoded = decodeHtmlEntity(entity);
  if (decoded === undefined) {
    return undefined;
  }

  return { text: decoded, length: semicolonIndex - index + 1 };
}
