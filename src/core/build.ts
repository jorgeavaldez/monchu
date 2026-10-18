/**
 * What the extensions facet (`extensions.ts`) and the process that loads it share: the host object that hands the
 * facet what outlives a reload, and the registry its builds are published through. Only types and contracts, so the
 * facet's fresh copies and the core's own agree without pulling the facet's code into the core.
 */
import { defineRegistry, local, opaque, type Resource } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { MonchuConfig, ModelRole, Settings } from "./config.ts";
import type { HomeCheck } from "./home-check.ts";
import type { BudgetLevel } from "./identity.ts";
import type { McpClients } from "./mcp/index.ts";
import type { PluginBuild, Plugins } from "./plugins.ts";
import type { Skill } from "./skills/index.ts";
import type { Vault } from "./secrets/vault.ts";
import type { FffFinders } from "./tools/fff.ts";

/** What a build reads and keeps using: it lives as long as the core, across reloads. */
export type BuildInputs = {
  /** The home's models; plugins add their providers to them. */
  models: MutableModels;
  home: string;
  /** The config this build applies: the one a running reload read, else the current one. */
  config: () => MonchuConfig;
  /** The worker role new workers start on, read when they start. */
  workerRole: () => ModelRole;
  reportSkipped: (warning: string) => void;
  observeBudget: (levels: BudgetLevel[]) => void;
  finders: FffFinders;
  clients: McpClients;
  /** The home's secrets: shells, the browser and the `secret` tool use them by name. */
  vault: Vault;
  /** Bundled and home plugins, with the modules they last loaded. */
  plugins: Plugins;
  /** The home's last check, which every conversation's tool calls and final answers run. */
  homeCheck: HomeCheck;
  /** Throws when `extensions` could not replace the installed ones, so a failing build changes nothing. */
  validate: (extensions: readonly Extension[]) => void;
};

export type Build = {
  extensions: Extension[];
  /** Left out of the host default selection and added to the root; workers inherit them, since Durable copies the root's agent into each conversation it owns. */
  root: Extension[];
  /** Deferred tool groups: installed, left out of the host default selection, and loaded by `tool_search`. */
  groups: Extension[];
  /** Group extension names that conversations on the Claude Code bridge load from the start. */
  preload: string[];
  settings: Settings;
  /** Home and bundled skills, which the editor offers as `/skill:name`. */
  skills: Skill[];
  config: MonchuConfig;
  /** What the plugins added; their extensions and groups are also in `extensions`. */
  plugins: PluginBuild;
  /** Names of the installed extensions the plugins own, which a later build without them uninstalls. */
  owned: string[];
  warnings: string[];
};

/** Tools of the reload controls, installed by the backend outside the build: no plugin may take their names. */
export const RELOAD_TOOLS = ["reload_extensions", "request_restart"];

/** Served by the core for the facet: the build inputs. */
export const BuildHost = local("monchu.build-host", {
  version: 1,
  input: Type.Object({}),
  members: { inputs: opaque<BuildInputs>("monchu.build-inputs@1") },
});

/** The build of each code version, under `BUILD`; a reload's commit swaps it in with the code that made it. */
export const Builds = defineRegistry<Resource<Build>>("monchu.builds", { conflict: "error" });

export const BUILD = "extensions";
