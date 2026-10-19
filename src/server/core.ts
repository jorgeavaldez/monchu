/**
 * The running backend as the core's host serves it to the facets. Apart from `session.ts`, so the server, which only
 * relays to the core, never loads the facet's code.
 */
import { local, opaque } from "@earendil-works/chord";
import { Type } from "typebox";
import type { LoginState } from "../api/contract.ts";
import type { Monchu } from "../core/backend.ts";

/** One login in progress: owned by the connection that started or resumed it, else parked until one resumes it. */
export type HeldLogin = {
  id: string;
  person: boolean;
  owner: LoginOwner | undefined;
  state: LoginState;
  controller: AbortController;
  answer(prompt: number, value: string | null): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** The connection holding a login: its state shows the login, and drops it a while after it finishes. */
export type LoginOwner = { show(run: HeldLogin): void; expire(run: HeldLogin): void };

/**
 * The running backend, for the facets: the host that serves it owns and closes it. With it, the logins whose connection
 * dropped, by id: a reload loads a fresh copy of the facets, and a client back on a new connection still resumes them.
 */
export const Core = local("monchu.core", {
  version: 1,
  input: Type.Object({}),
  members: {
    monchu: opaque<Monchu>("monchu.core@1"),
    parked: opaque<Map<string, HeldLogin>>("monchu.parked@1"),
  },
});
