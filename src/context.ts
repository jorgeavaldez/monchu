import {
  DefaultPackageManager,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  SettingsManager,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  section,
  type Extension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

/** Package sources can embed credentials as URL userinfo or token query parameters. */
function redactSource(source: string) {
  return source
    .replace(/\/\/[^/@\s]*@/g, "//***@")
    .replace(/([?&][^=&#]*(?:token|key|secret|password|auth|sig)[^=&#]*=)[^&#]*/gi, "$1***");
}

/** Install Monchu's own skill into Pi's user skills, only if absent, so user edits are preserved. */
export async function installMonchuSkill(agentDir: string): Promise<void> {
  const skillDir = join(agentDir, "skills", "monchu");
  await mkdir(skillDir, { recursive: true });
  try {
    await copyFile(
      new URL("../skills/monchu/SKILL.md", import.meta.url),
      join(skillDir, "SKILL.md"),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

/** Durable's run policy, resolving the latest loaded Pi user settings and default extensions on every read. */
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
 * User resources are loaded at startup and on reload, never from a conversation's execution directory.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
export async function createPiContext(agentDir: string) {
  agentDir = resolve(agentDir);
  // Untrusted project scope is Pi's SDK switch for excluding project settings and auto-discovery.
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length)
    throw new Error(
      `Pi settings failed:\n${errors
        .map(({ path, scope, error }) => {
          // JSON.parse and migration errors can quote settings values, including credentials.
          const reason =
            error instanceof SyntaxError
              ? `invalid JSON${error.message.match(/ at position \d+(?: \(line \d+ column \d+\))?/)?.[0] ?? ""}`
              : error instanceof TypeError
                ? "invalid settings structure"
                : "code" in error && typeof error.code === "string"
                  ? `could not read or lock settings (${error.code})`
                  : "could not load settings";
          return `${path ?? `${scope} settings`}: ${reason}`;
        })
        .join("\n")}`,
    );
  const packages = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: settings,
  });
  const diagnostics: ResourceDiagnostic[] = [];
  const resources = await packages.resolve(async (source) => {
    diagnostics.push({
      type: "warning",
      message: `Pi package unavailable; not installed: ${redactSource(source)}`,
    });
    return "skip";
  });
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    // Resolve installed packages above: DefaultResourceLoader otherwise installs missing packages implicitly.
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({
      agentsFiles: loadProjectContextFiles({ cwd: parse(agentDir).root, agentDir }).filter(
        ({ path }) => dirname(path) === agentDir,
      ),
    }),
  });
  await loader.reload();
  loader.extendResources({
    skillPaths: resources.skills
      .filter(({ enabled, metadata }) => enabled && metadata.scope === "user")
      .map(({ path, metadata }) => ({ path, metadata })),
  });
  const systemPrompt = loader.getSystemPrompt();
  const instructions = [
    ...loader.getAgentsFiles().agentsFiles,
    ...(systemPrompt === undefined
      ? []
      : [{ path: join(agentDir, "SYSTEM.md"), content: systemPrompt }]),
    ...loader.getAppendSystemPrompt().map((content) => ({
      path: join(agentDir, "APPEND_SYSTEM.md"),
      content,
    })),
  ];
  const imported = instructions.length
    ? [
        "Imported Pi coding-agent instructions (user-level guidance). Monchu's identity and front/worker workflow remain authoritative; these do not replace them.",
        ...instructions.map(
          ({ path, content }) =>
            `<pi_user_instructions path="${path}">\n${content}\n</pi_user_instructions>`,
        ),
      ].join("\n\n")
    : undefined;
  const skills = loader.getSkills().skills;
  const defaults = settings.getDefaultTools();
  const fileReadTool =
    defaults === undefined || defaults.includes("read")
      ? "read"
      : defaults.includes("bash")
        ? "bash"
        : undefined;
  const skillPrompt =
    fileReadTool === undefined ? undefined : formatSkillsForPrompt(skills, fileReadTool).trim();
  return {
    settings,
    extension: defineExtension({
      name: "monchu.context",
      sections: [
        section("pi_user_instructions", () => imported, { tag: false }),
        section("skills", () => skillPrompt || undefined, { tag: false }),
      ],
    }),
    warnings: [...diagnostics, ...loader.getSkills().diagnostics].map(warning),
  };
}
