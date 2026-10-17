/**
 * The running backend as the core's host serves it to the facets. Apart from `session.ts`, so the server, which only
 * relays to the core, never loads the facet's code.
 */
import { local, opaque } from "@earendil-works/chord";
import { Type } from "typebox";
import type { Monchu } from "../core/backend.ts";

/** The running backend, for the facets: the host that serves it owns and closes it. */
export const Core = local("monchu.core", {
  version: 1,
  input: Type.Object({}),
  members: { monchu: opaque<Monchu>("monchu.core@1") },
});
