import { describe, expect, it } from "vitest";
import { loginHints, pickTargets } from "../src/ui/login.ts";

describe("first-run text every client shows", () => {
  it("says which logins are needed, with the routing hint at startup or once chat is done", () => {
    const fresh = {
      chat: ["openai-codex", "claude-code"],
      anyOf: true,
      classifier: "cloudflare-workers-ai",
    };
    expect(loginHints(fresh, true)).toEqual([
      expect.stringMatching(
        /^login needed · OpenAI Codex .* or Claude Code .*Run \/login and pick one/,
      ),
      expect.stringMatching(/^routing advice \(Clef\) is off/),
    ]);
    // After a login that left chat still missing, only the chat line repeats.
    expect(loginHints(fresh, false)).toHaveLength(1);
    expect(
      loginHints({ chat: ["claude-code"], anyOf: false, classifier: undefined }, true),
    ).toEqual([expect.stringMatching(/^login needed · Claude Code .*Run \/login and pick it/)]);
    expect(
      loginHints({ chat: [], anyOf: false, classifier: "cloudflare-workers-ai" }, false),
    ).toEqual([expect.stringMatching(/^routing advice/)]);
    expect(loginHints({ chat: [], anyOf: false, classifier: undefined }, true)).toEqual([]);
  });

  it("offers the shown conversation first, then the others, then both role defaults", () => {
    expect(pickTargets(undefined, []).map(({ label }) => label)).toEqual([
      "root",
      "front default",
      "worker default",
    ]);
    expect(pickTargets("reader", ["writer", "reader"]).map(({ label }) => label)).toEqual([
      "reader",
      "root",
      "writer",
      "front default",
      "worker default",
    ]);
  });
});
