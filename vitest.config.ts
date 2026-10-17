import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// No test may reach the real ~/.monchu, ~/.pi, or ~/.agents: every default home resolves inside this sandbox.
const home = mkdtempSync(join(tmpdir(), "monchu-vitest-"));
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  test: {
    // jj keeps `config set --repo` under XDG_CONFIG_HOME; keep it out of test repos and the real config.
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
    // Hosted Windows runners take several seconds to spawn processes and open stores.
    testTimeout: 20_000,
    // Plugins load through Node's own loader and resolve hooks, as in Monchu, not through Vite's transform.
    server: { deps: { external: [/[?&]monchu-plugin=/] } },
  },
});
