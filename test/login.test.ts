import { describe, expect, it } from "vitest";
import { loginHints, pickTargets } from "../src/ui/login.ts";

describe("first-run text every client shows", () => {
  it("says which logins are needed, with plugins' optional ones at startup or once chat is done", () => {
    const classifier = {
      provider: "cloudflare-workers-ai",
      purpose: "routing advice (classifier)",
    };
    const plugins = [
      { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI", auth: "api_key" as const },
    ];
    const fresh = { chat: ["openai-codex", "claude-code"], anyOf: true, optional: [classifier] };
    expect(loginHints(fresh, true, plugins)).toEqual([
      expect.stringMatching(
        /^login needed · OpenAI Codex .* or Claude Code .*Run \/login and pick one/,
      ),
      "routing advice (classifier) is off · optional: /login → Cloudflare Workers AI (API key) turns it on",
    ]);
    // After a login that left chat still missing, only the chat line repeats.
    expect(loginHints(fresh, false, plugins)).toHaveLength(1);
    expect(
      loginHints({ chat: ["claude-code"], anyOf: false, optional: [] }, true, plugins),
    ).toEqual([expect.stringMatching(/^login needed · Claude Code .*Run \/login and pick it/)]);
    expect(loginHints({ chat: [], anyOf: false, optional: [classifier] }, false, plugins)).toEqual([
      expect.stringMatching(/^routing advice/),
    ]);
    expect(loginHints({ chat: [], anyOf: false, optional: [] }, true, plugins)).toEqual([]);
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
