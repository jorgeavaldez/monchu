/**
 * The keys plugin's bindings and the machine that reads them, pure so a replay of key sequences checks it against the
 * signed-off table. Outside the prompt plain keys act, vim-style; inside it only the leader (Ctrl+/) does, followed by
 * the same keys as Space. Nothing acts while a menu, pick, question, login or panel is open, or in another field.
 */

/** A key as the machine reads it: `spc`, `esc`, `enter`, `C-/` (the leader), or the key's character. */
export type Token = string;

/** Who has the keys and what is open, as the page reports it. */
export type KeyContext = {
  owner: "prompt" | "page" | "button" | "other";
  overlay: "none" | "menu" | "pick" | "ask" | "login" | "panel";
};

/** A sequence under way: after Space, after the leader, or after the first `g`. */
export type KeyState = { pending: "" | "spc" | "leader" | "g" };

export const IDLE: KeyState = { pending: "" };

/** One key in the page: an action id, or a sequence to go on with. */
const KEYS: Readonly<Record<string, string>> = {
  i: "prompt",
  enter: "prompt",
  ":": "slash",
  "?": "keys",
  "/": "search",
  n: "search.next",
  N: "search.previous",
  "[": "feed.previous",
  "]": "feed.next",
  H: "root.previous",
  L: "root.next",
  j: "scroll.down",
  k: "scroll.up",
  d: "scroll.halfDown",
  u: "scroll.halfUp",
  G: "scroll.end",
  o: "expand",
  s: "mode",
  X: "stop",
};

/** After Space outside the prompt, or the leader anywhere. */
const GROUP: Readonly<Record<string, string>> = {
  r: "roots",
  d: "drafts",
  a: "agents",
  g: "feed.goal",
  m: "model",
  j: "jobs",
  q: "queue",
};

/** The hint shown while a Space or leader sequence waits. */
export const GROUP_HINT = `${Object.entries(GROUP)
  .map(([key, id]) => `${key} ${id}`)
  .join(" · ")} · spc palette`;

/** Keys that may repeat while held: scrolling. */
export const REPEATS: ReadonlySet<string> = new Set(["j", "k", "d", "u"]);

/** What a key does: the next state, the action to run, and whether the key is taken (kept from the page). */
export type Step = { state: KeyState; run?: string; take: boolean };

const done = (run?: string): Step => ({
  state: IDLE,
  take: true,
  ...(run === undefined ? {} : { run }),
});

export function step(state: KeyState, token: Token, context: KeyContext): Step {
  // Whatever is open owns its keys; another field types; a sequence never survives either.
  if (context.overlay !== "none" || context.owner === "other") return { state: IDLE, take: false };
  // A Space or `g` sequence began on the page; once focus is in the prompt, the key types instead.
  if (state.pending !== "leader" && state.pending !== "" && context.owner === "prompt")
    return { state: IDLE, take: false };
  if (state.pending === "spc" || state.pending === "leader") {
    if (token === "spc" || token === "C-/") return done("palette");
    // Anything else ends the sequence; it is taken, so a stray key after the leader never types.
    return done(GROUP[token]);
  }
  if (state.pending === "g") return done(token === "g" ? "scroll.top" : undefined);
  if (token === "C-/") return { state: { pending: "leader" }, take: true };
  if (context.owner === "prompt") return { state: IDLE, take: false };
  if (token === "esc") return { state: IDLE, take: false };
  // A focused button keeps Enter and Space for itself.
  if (context.owner === "button" && (token === "enter" || token === "spc"))
    return { state: IDLE, take: false };
  if (token === "spc") return { state: { pending: "spc" }, take: true };
  if (token === "g") return { state: { pending: "g" }, take: true };
  const run = KEYS[token];
  return run === undefined ? { state: IDLE, take: false } : done(run);
}

/** The keys for `/keys`, from the same tables. */
export function keyRows(): { keys: string; label: string }[] {
  return [
    ...Object.entries(KEYS).map(([keys, label]) => ({ keys, label })),
    { keys: "g g", label: "scroll.top" },
    { keys: "spc spc · Ctrl+/ Ctrl+/", label: "palette" },
    ...Object.entries(GROUP).map(([key, label]) => ({
      keys: `spc ${key} · Ctrl+/ ${key}`,
      label,
    })),
    { keys: "Esc (in the prompt)", label: "leave the prompt" },
  ];
}
