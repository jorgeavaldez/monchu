import { cleanupSessionResources } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  defineExtension,
  hook,
  ProviderDoc,
  section,
  type Extension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSettings, type RunSettings, type Settings } from "./config.ts";
import { formatSkillsForPrompt, loadSkills, type ResourceDiagnostic } from "./skills/index.ts";

/** Durable's run policy, resolving the latest loaded settings and default extensions on every read. */
export function harnessSettings(current: {
  readonly settings: Settings;
  defaults(): readonly Extension[];
}): HarnessSettings {
  return {
    get extensions() {
      return current.defaults();
    },
    get stream() {
      const provider = current.settings.providerRetry;
      const idle = current.settings.httpIdleTimeoutMs;
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return current.settings.compaction;
    },
    get retry() {
      return current.settings.retry;
    },
    get steeringMode() {
      return current.settings.steeringMode;
    },
    get followUpMode() {
      return current.settings.followUpMode;
    },
  };
}

function warning(diagnostic: ResourceDiagnostic): string {
  const locations = [
    diagnostic.path,
    ...(diagnostic.collision
      ? [`winner: ${diagnostic.collision.winnerPath}`, `loser: ${diagnostic.collision.loserPath}`]
      : []),
  ]
    .filter((location) => location !== undefined)
    .join("; ");
  return `${diagnostic.message}${locations ? ` (${locations})` : ""}`;
}

/**
 * Skills are read in place from the home and bundled directories, never from Pi or execution cwd.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export function createContext(home: string, runSettings: RunSettings) {
  home = resolve(home);
  const { skills, diagnostics } = loadSkills([
    join(home, "skills"),
    fileURLToPath(new URL("../skills/", import.meta.url)),
  ]);
  const settings = resolveSettings(runSettings);
  const skillPrompt = formatSkillsForPrompt(skills).trim();
  return {
    settings,
    skills,
    extension: defineExtension({
      name: "monchu.context",
      hooks: [
        hook(CompactionTask, {
          beforeCompact: async (_compaction, api, context) => {
            const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
            if (provider !== undefined) cleanupSessionResources(provider.sessionId);
          },
        }),
      ],
      sections: [section("skills", () => skillPrompt || undefined, { tag: false })],
    }),
    warnings: diagnostics.map(warning),
  };
}
