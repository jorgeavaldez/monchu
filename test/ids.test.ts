import { describe, expect, it } from "vitest";
import { parseShortId, shortId } from "../src/api/ids.ts";
import type { RootSummary } from "../src/api/client.ts";
import { ShortIds } from "../src/ui/ids.ts";
import {
  activeRoots,
  ARCHIVE_HELP,
  listedRoots,
  parseRootsCommand,
  rootCounts,
  rootIds,
  rootLabel,
} from "../src/ui/roots.ts";

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

describe("roots in clients", () => {
  const root = (id: string, change: Partial<RootSummary> = {}): RootSummary => ({
    id,
    label: "",
    named: false,
    createdAt: 0,
    lastInputAt: null,
    archived: false,
    status: "idle",
    front: "idle",
    workers: { open: 0, busy: 0 },
    jobs: { running: 0, scheduled: 0 },
    ...change,
  });

  it("highlights each root's unique prefix among all roots, archived ones included", () => {
    const split = rootIds([root("kqxy"), root("kqzz", { archived: true }), root("mnop")]);
    expect(split("kqxy")).toEqual({ unique: "kqx", rest: "y" });
    expect(split("mnop")).toEqual({ unique: "m", rest: "nop" });
  });

  it("shows a dot only for open roots that work or finished unseen, and lists newest input first", () => {
    const roots = [
      root("kkkk", { status: "working", createdAt: 1 }),
      root("llll", { status: "done", createdAt: 2, lastInputAt: 9 }),
      root("mmmm", { status: "idle", createdAt: 3, lastInputAt: 5 }),
      root("nnnn", { status: "done", archived: true, createdAt: 4 }),
    ];
    expect(activeRoots(roots)).toEqual([
      { id: "kkkk", status: "working" },
      { id: "llll", status: "done" },
    ]);
    expect(listedRoots(roots, false).map((each) => each.id)).toEqual(["llll", "mmmm", "kkkk"]);
    expect(listedRoots(roots, true)).toHaveLength(4);
    expect(rootLabel(root("kkkk"))).toBe("new root");
    expect(
      rootCounts(
        root("kkkk", { workers: { open: 3, busy: 2 }, jobs: { running: 1, scheduled: 2 } }),
      ),
    ).toBe("2/3 workers busy · 1 bg");
    expect(rootCounts(root("kkkk", { workers: { open: 1, busy: 0 } }))).toBe("1 worker");
    expect(ARCHIVE_HELP).toContain("Nothing is deleted");
  });

  it("parses /roots without ever taking a subcommand for an id", () => {
    expect(parseRootsCommand("")).toEqual({ kind: "list" });
    expect(parseRootsCommand("kq")).toEqual({ kind: "switch", prefix: "kq" });
    expect(parseRootsCommand("new")).toEqual({ kind: "new" });
    expect(parseRootsCommand("rename the  garden")).toEqual({
      kind: "rename",
      label: "the  garden",
    });
    expect(parseRootsCommand("archive")).toEqual({
      kind: "archive",
      prefix: undefined,
      archived: true,
    });
    expect(parseRootsCommand("unarchive kq")).toEqual({
      kind: "archive",
      prefix: "kq",
      archived: false,
    });
    for (const invalid of ["new x", "unarchive", "archive a b", "kq x", "abc"])
      expect(() => parseRootsCommand(invalid)).toThrow("Usage: /roots");
  });
});
