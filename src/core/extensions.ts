/**
 * Monchu's Durable extensions as a Chord facet, so `/reload` swaps them with Chord's reload: Chord's loader imports a
 * fresh copy of this module and of everything under `src/core/` it imports, the build runs while the reload prepares
 * (a failure there leaves the running build), and the commit publishes the new build through `Builds`, where the core
 * installs it into Durable's registry. Running Durable phases keep the definitions they started with.
 */
import { defineFacet, local } from "@earendil-works/chord";
import { randomInt } from "node:crypto";
import { Type } from "typebox";
import type { Principal } from "../api/contract.ts";
import { createEffortAssessment } from "./agents/classifier.ts";
import { Goals } from "./agents/goals.ts";
import { createMemory } from "./agents/memory.ts";
import { Roots } from "./agents/roots.ts";
import { createWorkerTools } from "./agents/workers.ts";
import { BUILD, BuildHost, Builds, type Build, type BuildInputs } from "./build.ts";
import { createContext } from "./context.ts";
import { createIdentity } from "./identity.ts";
import { createJobs } from "./jobs.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { createMcpTools } from "./mcp/tools.ts";
import { Browser } from "./tools/browser.ts";
import { Codemode } from "./tools/codemode.ts";
import { createHerdr } from "./tools/herdr.ts";
import { Jj } from "./tools/jj.ts";
import { createPiTools } from "./tools/pi-tools.ts";
import { createToolSearch } from "./tools/tool-search.ts";

/** Build every extension from this copy of the code, reading config, skills and MCP listings anew. */
async function build(inputs: BuildInputs): Promise<Build> {
  const config = inputs.config();
  const context = createContext(inputs.home, config.settings);
  const tools = createPiTools(context.settings, inputs.finders);
  const memory = createMemory(inputs.home);
  const identity = createIdentity(inputs.home, inputs.reportSkipped, inputs.observeBudget);
  const mcpConfig = await loadMcpConfig(inputs.home);
  const mcp = await createMcpTools(mcpConfig.servers, inputs.clients);
  const search = createToolSearch([...mcp.groups, Browser]);
  const workers = createWorkerTools(inputs.workerRole, config.profiles, search.preload);
  const jobs = createJobs(inputs.workerRole, inputs.home, config.profiles, search.preload);
  const herdr = createHerdr({ command: { executable: "herdr", args: [] }, env: process.env });
  const assessment =
    config.classifier === null
      ? undefined
      : createEffortAssessment(inputs.models, config.classifier, { profiles: config.profiles });
  const extensions = [
    context.extension,
    tools.extension,
    workers,
    jobs,
    Roots,
    Codemode,
    Goals,
    memory,
    identity,
    Jj,
    herdr,
    mcp.extension,
    search.extension,
    ...search.groups,
    ...(assessment === undefined ? [] : [assessment.extension]),
  ];
  inputs.validate(extensions);
  return {
    extensions,
    root: [Goals, memory, Roots],
    groups: search.groups,
    preload: search.preload,
    settings: context.settings,
    skills: context.skills,
    config,
    assessment,
    warnings: [...context.warnings, ...tools.warnings, ...mcpConfig.errors, ...mcp.warnings],
  };
}

/** The one object that holds the build. */
const Extensions = local("monchu.extensions", {
  version: 1,
  input: Type.Object({}),
  members: {},
});

/** Each copy of this module builds again: a resource whose version changed opens anew while the reload prepares. */
const COPY = randomInt(2 ** 47);

/** Loaded by URL on the core's host (see `reload.ts`). */
export default defineFacet<Principal>(
  (api) => {
    api.serve(
      Extensions,
      (_input, _principal, self) => {
        const host = self.get(BuildHost, {});
        const built = self.resource("build", {
          version: COPY,
          deps: [host],
          open: () => {
            const inputs = host.inputs;
            if (inputs === undefined) throw new Error("Monchu's build inputs are not open");
            return build(inputs);
          },
        });
        self.register(Builds, { [BUILD]: built });
        return {};
      },
      { lifetime: "host" },
    );
  },
  { uses: [BuildHost] },
);
