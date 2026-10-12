import {
  formatSkillsForPrompt,
  loadSkills,
  SettingsManager,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  section,
  type Extension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Durable's run policy, resolving the latest loaded settings and default extensions on every read. */
export function harnessSettings(current: {
  readonly settings: SettingsManager;
  defaults(): readonly Extension[];
}): HarnessSettings {
  return {
    get extensions() {
      return current.defaults();
    },
    get stream() {
      const provider = current.settings.getProviderRetrySettings();
      const idle = current.settings.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return current.settings.getCompactionSettings();
    },
    get retry() {
      return current.settings.getRetrySettings();
    },
    get steeringMode() {
      return current.settings.getSteeringMode();
    },
    get followUpMode() {
      return current.settings.getFollowUpMode();
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
export function createContext(home: string) {
  home = resolve(home);
  const { skills, diagnostics } = loadSkills({
    cwd: home,
    agentDir: home,
    skillPaths: [join(home, "skills"), fileURLToPath(new URL("../skills/", import.meta.url))],
    includeDefaults: false,
  });
  // No file-backed Pi settings: even reads acquire filesystem locks. Own config settings follow separately.
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const skillPrompt = formatSkillsForPrompt(skills, "read").trim();
  return {
    settings,
    extension: defineExtension({
      name: "monchu.context",
      sections: [section("skills", () => skillPrompt || undefined, { tag: false })],
    }),
    warnings: diagnostics.map(warning),
  };
}
