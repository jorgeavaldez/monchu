import { describe, expect, it } from "vitest";
import { argumentRows } from "../src/web/completions.ts";
import { score, search, snippet } from "../src/web/fuzzy.ts";

const rows = (...texts: string[]) => texts.map((text) => ({ text, lower: text.toLowerCase() }));
const found = (texts: string[], query: string) =>
  search(rows(...texts), query).map((hit) => hit.item.text);

describe("feed search", () => {
  it("needs every term, in any order, and ranks an exact word above letters spread out", () => {
    expect(
      found(["deploy the web app", "web keys plan", "keys for the deploy"], "deploy web"),
    ).toEqual(["deploy the web app"]);
    // "kys" spread inside "keys" matches; an exact "kys" would rank above it.
    expect(found(["web keys plan", "the kys typo"], "kys")).toEqual([
      "the kys typo",
      "web keys plan",
    ]);
  });

  it("never matches letters scattered across a long text", () => {
    expect(score("a" + " filler".repeat(40) + " b", "ab")).toBeUndefined();
    expect(score("abc", "ab")?.score).toBeGreaterThan(0);
  });

  it("is smart-case: lowercase ignores case, a capital matches exactly", () => {
    expect(found(["Monchu web", "monchu cli"], "monchu")).toHaveLength(2);
    expect(found(["Monchu web", "monchu cli"], "Monchu")).toEqual(["Monchu web"]);
  });

  it("keeps newer messages first among equal scores, and stops at the limit", () => {
    const texts = ["old ask", "new ask"];
    expect(found(texts, "ask")).toEqual(["new ask", "old ask"]);
    expect(
      search(rows(...Array.from({ length: 80 }, (_, index) => `ask ${index}`)), "ask"),
    ).toHaveLength(50);
  });

  it("finds nothing for an empty query", () => {
    expect(found(["anything"], "  ")).toEqual([]);
  });

  it("cuts a one-line snippet around the match, marking cuts", () => {
    const text = `${"x ".repeat(100)}needle\n\nhere ${"y ".repeat(100)}`;
    const at = text.indexOf("needle");
    const cut = snippet(text, at, at + 5, 40);
    expect(cut).toContain("needle here");
    expect(cut.startsWith("…") && cut.endsWith("…")).toBe(true);
    expect(snippet("short", 0, 4)).toBe("short");
  });

  it("stays fast on a big feed", () => {
    const big = rows(
      ...Array.from(
        { length: 3000 },
        (_, index) => `message ${index} ${"lorem ipsum dolor sit amet ".repeat(20)}`,
      ),
    );
    // Keystrokes over 3000 messages of ~550 characters take a few ms each on the dev box (the page budget is 16 ms).
    // A tripwire for a scan gone unbounded, with room for slow CI runners: the page's telemetry holds the real budget.
    for (const query of ["d", "dolr", "zzz", "lrm ip"]) {
      const started = performance.now();
      search(big, query);
      expect(performance.now() - started).toBeLessThan(60);
    }
  });
});

describe("slash argument completion", () => {
  const from = {
    workers: ["vault", "monchu-web-keys"],
    roots: [{ id: "kqzt", label: "groceries" }],
    asks: [{ code: "mnop", text: "sign off the plan?" }],
  };

  it("offers a command's first argument once its name and a space are typed", () => {
    expect(argumentRows("/agents ", from)?.items.map((item) => item.label)).toEqual([
      "root",
      "vault",
      "monchu-web-keys",
    ]);
    expect(argumentRows("/agents va", from)?.query).toBe("va");
    expect(
      argumentRows("/roots ", from)?.items.find((item) => item.label === "kqzt"),
    ).toMatchObject({
      id: "/roots kqzt",
      detail: "groceries",
    });
  });

  it("leaves a reply's text after the id, and stops completing past the first argument", () => {
    expect(argumentRows("/reply ", from)?.items[0]).toMatchObject({
      id: "/reply mnop ",
      detail: "sign off the plan?",
    });
    expect(argumentRows("/roots ", from)?.items.find((item) => item.label === "rename")?.id).toBe(
      "/roots rename ",
    );
    expect(argumentRows("/reply mnop some text", from)).toBeUndefined();
    expect(argumentRows("/agents", from)).toBeUndefined();
    expect(argumentRows("/goals ", from)).toBeUndefined();
  });
});
