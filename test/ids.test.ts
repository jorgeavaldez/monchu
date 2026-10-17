import { describe, expect, it } from "vitest";
import { parseShortId, shortId } from "../src/api/ids.ts";
import { ShortIds } from "../src/ui/ids.ts";

describe("short ids", () => {
  it("pins the encoding, since every client and stored reference depends on it", () => {
    expect([2, 3, 12002, 65535, 65536, 1_000_000, 2 ** 32 - 1].map(shortId)).toEqual([
      "srpx",
      "oukx",
      "ontz",
      "qwqw",
      "nyrvt",
      "npqsp",
      "nwqwnwqw",
    ]);
  });

  it("gives every id one short id and reads it back, 4 letters below 65,536 ids, then 5", () => {
    const seen = new Set<string>();
    const wrong: number[] = [];
    for (let id = 0; id < 70_000; id++) {
      const code = shortId(id);
      if (!(id < 65_536 ? /^[k-z]{4}$/ : /^[k-z]{5}$/).test(code) || parseShortId(code) !== id)
        wrong.push(id);
      seen.add(code);
    }
    expect(wrong).toEqual([]);
    expect(seen.size).toBe(70_000);
    for (const id of [2 ** 20, 2 ** 24 + 7, 2 ** 31, 2 ** 32 - 1])
      expect(parseShortId(shortId(id))).toBe(id);
  });

  it("rejects text that is no short id, and ids it cannot write", () => {
    for (const text of ["", "kkk", "abcd", "KXYZ", "kxyz1", "zzzzzzzzz"])
      expect(parseShortId(text)).toBeUndefined();
    // A 5-letter code for an id that fits in 4 letters would be a second name for it.
    expect(
      Array.from({ length: 65_536 }, (_, id) => id).some(
        (id) => parseShortId(`k${shortId(id)}`) === id,
      ),
    ).toBe(false);
    for (const id of [-1, 1.5, 16 ** 8]) expect(() => shortId(id)).toThrow("No short id");
  });

  it("finds each shown id's shortest unique prefix, as jj does, and names the ids a new one lengthened", () => {
    const ids = new ShortIds();
    const codes: string[] = [];
    // The shortest prefix no other shown id starts with.
    const expected = (code: string) => {
      let length = 1;
      while (codes.some((other) => other !== code && other.startsWith(code.slice(0, length))))
        length++;
      return length;
    };
    for (const id of [5, 77, 300, 301, 4096, 9000, 12002, 40000, 65535, 70000, 70001]) {
      const before = new Map(codes.map((code) => [code, ids.prefix(code)]));
      const lengthened = ids.add(id);
      codes.push(shortId(id));
      expect(ids.add(id)).toEqual([]);
      for (const code of codes) expect(ids.prefix(code)).toBe(expected(code));
      expect(lengthened.toSorted()).toEqual(
        codes.filter((code) => before.get(code) !== ids.prefix(code)).toSorted(),
      );
      const { code, unique, rest } = ids.split(id);
      expect([unique + rest, unique.length]).toEqual([code, expected(code)]);
    }
  });
});
