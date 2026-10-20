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
import { Goals } from "./agents/goals.ts";
import { createMemory } from "./agents/memory.ts";
import { Roots } from "./agents/roots.ts";
import { createWorkerTools } from "./agents/workers.ts";
import { BUILD, BuildHost, Builds, RELOAD_TOOLS, type Build, type BuildInputs } from "./build.ts";
import { createContext } from "./context.ts";
import { createHomeCheck } from "./home-check.ts";
import { createIdentity } from "./identity.ts";
import { Inbox } from "./inbox.ts";
import { createJobs } from "./jobs.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { createMcpTools } from "./mcp/tools.ts";
import { Codemode } from "./tools/codemode.ts";
import { createPiTools } from "./tools/pi-tools.ts";
import { createSecrets } from "./secrets/tool.ts";
import { createPluginSections, reservedTasks } from "./plugins.ts";
import { createToolSearch, groupExtensionName } from "./tools/tool-search.ts";

/** Build every extension from this copy of the code, reading config, skills and MCP listings anew. */
async function build(inputs: BuildInputs): Promise<Build> {
  const config = inputs.config();
  const loaded = await inputs.plugins.load(config);
  const context = createContext(inputs.home, config.settings, loaded.skills);
  const tools = createPiTools(context.settings, inputs.finders, inputs.vault);
  const memory = createMemory(inputs.home);
  const identity = createIdentity(inputs.home, inputs.reportSkipped, inputs.observeBudget);
  // An mcp.json or mcp.local.json that isn't JSON must not keep the device from opening: no server loads.
  const mcpConfig = await loadMcpConfig(inputs.home).catch((error: unknown) => {
    if (!inputs.startup()) throw error;
    return {
      servers: {},
      errors: [
        `${error instanceof Error ? error.message : String(error)}. No MCP server loads until it is fixed`,
      ],
    };
  });
  const mcp = await createMcpTools(mcpConfig.servers, inputs.clients);
  const secrets = createSecrets(inputs.vault);
  const workers = (preload: readonly string[]) =>
    createWorkerTools(inputs.workerRole, config.profiles, preload);
  const jobs = (preload: readonly string[]) =>
    createJobs(inputs.workerRole, inputs.home, inputs.vault, config.profiles, preload);
  // Tool and task names the plugins may not take: every core one, whatever the preload, and the reload controls.
  const core = [
    context.extension,
    tools.extension,
    workers([]),
    jobs([]),
    Roots,
    Codemode,
    Goals,
    Inbox,
  ];
  const own = [...core, memory, identity, mcp.extension, secrets];
  const plugins = loaded.use({
    tools: new Set([
      ...own.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
      ...mcp.groups.flatMap((group) => group.tools.map((tool) => tool.name)),
      ...RELOAD_TOOLS,
      "tool_search",
    ]),
    tasks: reservedTasks(own),
  });
  const search = createToolSearch([...mcp.groups, ...plugins.groups]);
  const extensions = [
    context.extension,
    tools.extension,
    workers(search.preload),
    jobs(search.preload),
    Roots,
    Codemode,
    Goals,
    memory,
    identity,
    createHomeCheck(inputs.homeCheck),
    // Bundled plugins keep the place jj and herdr had before they became plugins, so every conversation's tools stay in
    // order (see BUNDLED_ORDER in plugins.ts).
    ...plugins.bundled,
    mcp.extension,
    search.extension,
    // Last of the defaults: a tool new to a conversation joins the end of its list, not the middle.
    secrets,
    // After the secrets, so the inbox tool joins the end of each root's list.
    Inbox,
    ...search.groups,
    createPluginSections(plugins.sections),
    ...plugins.attached,
  ];
  inputs.validate(extensions);
  return {
    extensions,
    root: [Goals, memory, Roots, Inbox],
    groups: search.groups,
    preload: search.preload,
    claude: search.claude,
    settings: context.settings,
    skills: context.skills,
    config,
    plugins,
    owned: [
      ...[...plugins.bundled, ...plugins.attached].map((extension) => extension.name),
      ...plugins.groups.map(groupExtensionName),
    ],
    warnings: [
      ...context.warnings,
      ...tools.warnings,
      ...mcpConfig.errors,
      ...mcp.warnings,
      ...plugins.warnings,
    ],
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
