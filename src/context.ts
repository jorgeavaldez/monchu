import {
  DefaultPackageManager,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  SettingsManager,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { dirname, join, parse, resolve } from "node:path";

/** User resources are loaded once at startup, never from a conversation's execution directory. */
export async function loadPiConfiguration(agentDir: string) {
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
      message: `Pi package unavailable; not installed: ${source}`,
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
      name: "monchu.pi-context",
      sections: [
        section("pi_user_instructions", () => imported, { tag: false }),
        section("skills", () => skillPrompt || undefined, { tag: false }),
      ],
    }),
    diagnostics: [...diagnostics, ...loader.getSkills().diagnostics],
  };
}
