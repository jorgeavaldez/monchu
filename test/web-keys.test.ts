import { describe, expect, it } from "vitest";
import { IDLE, step, type KeyContext, type KeyState } from "../src/plugins/keys/keymap.ts";

/** Replay `keys` (space-separated tokens) from idle; the actions run and which keys were taken. */
function replay(keys: string, context: KeyContext) {
  let state: KeyState = IDLE;
  const runs: string[] = [];
  const taken: boolean[] = [];
  for (const key of keys.split(" ")) {
    const next = step(state, key, context);
    state = next.state;
    if (next.run !== undefined) runs.push(next.run);
    taken.push(next.take);
  }
  return { runs, taken, state };
}

const page: KeyContext = { owner: "page", overlay: "none" };
const prompt: KeyContext = { owner: "prompt", overlay: "none" };

// The intended key table, with the Ctrl+/ leader, written independently of the keymap: each sequence outside the prompt and the action it runs.
const BINDINGS: [string, string][] = [
  ["i", "prompt"],
  ["enter", "prompt"],
  [":", "slash"],
  ["spc spc", "palette"],
  ["?", "keys"],
  ["/", "search"],
  ["n", "search.next"],
  ["N", "search.previous"],
  ["[", "feed.previous"],
  ["]", "feed.next"],
  ["H", "root.previous"],
  ["L", "root.next"],
  ["spc r", "roots"],
  ["j", "scroll.down"],
  ["k", "scroll.up"],
  ["d", "scroll.halfDown"],
  ["u", "scroll.halfUp"],
  ["g g", "scroll.top"],
  ["G", "scroll.end"],
  ["o", "expand"],
  ["s", "mode"],
  ["spc d", "drafts"],
  ["spc w", "agents"],
  ["spc g", "feed.goal"],
  ["spc m", "model"],
  ["spc j", "jobs"],
  ["spc q", "queue"],
  ["spc p", "pins"],
  ["spc f a", "feed.all"],
  ["spc f ?", "feed.ask"],
  ["spc f d", "feed.milestone"],
  ["spc f u", "feed.update"],
  ["C-/ f ?", "feed.ask"],
  ["X", "stop"],
  ["C-/ C-/", "palette"],
  ["C-/ r", "roots"],
];

describe("keys plugin", () => {
  it("runs the bound action for every sequence outside the prompt, taking each key", () => {
    for (const [keys, action] of BINDINGS) {
      const { runs, taken, state } = replay(keys, page);
      expect({ keys, runs }).toEqual({ keys, runs: [action] });
      expect(taken.every(Boolean)).toBe(true);
      expect(state).toEqual(IDLE);
    }
  });

  it("leaves digits, unbound keys and Esc to the page", () => {
    for (const key of ["1", "9", "x", "z", "esc"]) {
      expect(replay(key, page)).toMatchObject({ runs: [], taken: [false] });
    }
  });

  it("types in the prompt, except the leader and what follows it", () => {
    for (const key of ["i", "j", "spc", "X", "/", "esc", "enter"])
      expect(replay(key, prompt)).toMatchObject({ runs: [], taken: [false] });
    expect(replay("C-/ m", prompt)).toMatchObject({ runs: ["model"], taken: [true, true] });
    expect(replay("C-/ C-/", prompt)).toMatchObject({ runs: ["palette"] });
    expect(replay("C-/ f d", prompt)).toMatchObject({
      runs: ["feed.milestone"],
      taken: [true, true, true],
    });
    // A stray key after the leader ends it without typing.
    expect(replay("C-/ z", prompt)).toMatchObject({ runs: [], taken: [true, true], state: IDLE });
  });

  it("does nothing while anything is open over the page, or in another field", () => {
    for (const overlay of ["menu", "pick", "ask", "login", "panel"] as const)
      for (const keys of ["j", "C-/ r", "spc spc", "X"])
        expect(replay(keys, { owner: "page", overlay }).runs).toEqual([]);
    for (const keys of ["j", "C-/ r", "X"])
      expect(replay(keys, { owner: "other", overlay: "none" }).runs).toEqual([]);
  });

  it("leaves Enter and Space to a focused button, and acts on its other keys", () => {
    const button: KeyContext = { owner: "button", overlay: "none" };
    expect(replay("enter", button)).toMatchObject({ runs: [], taken: [false] });
    expect(replay("spc", button)).toMatchObject({ runs: [], taken: [false] });
    expect(replay("j", button).runs).toEqual(["scroll.down"]);
  });

  it("lets the prompt type once focus moves there mid-sequence", () => {
    let state = step(IDLE, "spc", page).state;
    expect(step(state, "r", prompt)).toMatchObject({ take: false, state: IDLE });
    state = step(IDLE, "g", page).state;
    expect(step(state, "g", prompt)).toMatchObject({ take: false, state: IDLE });
  });

  it("ends a sequence on an unbound key or Esc, without running anything", () => {
    expect(replay("spc z j", page).runs).toEqual(["scroll.down"]);
    expect(replay("spc esc", page)).toMatchObject({ runs: [], state: IDLE });
    // In the prompt Esc after the leader only ends it: taken, so it never leaves the prompt or stops the run.
    expect(replay("C-/ esc", prompt)).toMatchObject({ runs: [], taken: [true, true], state: IDLE });
    expect(replay("g j", page).runs).toEqual([]);
  });
});
