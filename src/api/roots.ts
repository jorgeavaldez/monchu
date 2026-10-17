/** Which root a client opens: browser-safe, so the terminal and the web pick roots the same way. */
import type { Client } from "./client.ts";

/** `monchu` opens the current root, `monchu resume <id>` the root a prefix names, `monchu new` a new one. */
export type RootChoice =
  | { kind: "current" }
  | { kind: "resume"; prefix: string }
  | { kind: "new"; requestId: string };

/** The full id of the root a choice names; unknown and ambiguous prefixes throw with the candidates. */
export function chooseRoot(client: Client, choice: RootChoice): Promise<string> {
  switch (choice.kind) {
    case "current":
      return client.currentRoot();
    case "resume":
      return client.findRoot(choice.prefix);
    case "new":
      return client.createRoot(choice.requestId);
  }
}
