import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// No test may reach the real ~/.monchu, ~/.pi, or ~/.agents: every default home resolves inside this sandbox.
const home = mkdtempSync(join(tmpdir(), "monchu-vitest-"));
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  test: {
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
  },
});
