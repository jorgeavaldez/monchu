import { LOGIN_PROVIDERS } from "./commands.ts";

/** What a client says after a failed login: provider errors can quote entered credentials, so never those. */
export const LOGIN_FAILED = "login failed; credentials may have been saved; retry /login";

/**
 * What still needs a login, as every client says it: at startup, and after each login until nothing does. The routing
 * hint shows at startup, and after a login only once the chat providers are done.
 */
export function loginHints(
  needs: { chat: readonly string[]; anyOf: boolean; classifier: string | undefined },
  startup: boolean,
): string[] {
  const label = (id: string) => LOGIN_PROVIDERS.find((entry) => entry.id === id)?.label ?? id;
  const lines: string[] = [];
  if (needs.chat.length > 0)
    lines.push(
      needs.anyOf
        ? `login needed · ${needs.chat.map(label).join(" or ")}. Run /login and pick one; Monchu uses that provider's models. /model changes them, and Ctrl+S there saves the pick.`
        : `login needed · ${needs.chat.map(label).join(", ")}. Run /login and pick it. To use another provider instead, log in to it, then pick its models with /model and press Ctrl+S to save them as the defaults.`,
    );
  if (needs.classifier !== undefined && (startup || needs.chat.length === 0))
    lines.push(
      `routing advice (Clef) is off · optional: /login → Cloudflare turns it on; "classifier": null in config.json hides this`,
    );
  return lines;
}

/** What a model or thinking pick can change, the shown conversation first, as `/model` and `/thinking` offer it. */
export type PickTarget =
  | { kind: "conversation"; name: string | undefined }
  | { kind: "default"; role: "front" | "worker" };

export function pickTargets(
  shown: string | undefined,
  workers: readonly string[],
): { label: string; target: PickTarget; description: string }[] {
  const conversation = (name: string | undefined) => ({
    label: name ?? "root",
    target: { kind: "conversation" as const, name },
    description: "this conversation; Ctrl+S also saves its role default",
  });
  return [
    conversation(shown),
    ...[undefined, ...workers].filter((name) => name !== shown).map(conversation),
    {
      label: "front default",
      target: { kind: "default", role: "front" },
      description: "saved; the root follows it unless picked for the root",
    },
    {
      label: "worker default",
      target: { kind: "default", role: "worker" },
      description: "saved; new workers start with it",
    },
  ];
}
