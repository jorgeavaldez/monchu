import { Type, type Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { MonchuConfig } from "./config.ts";

/** A module and its extension builder. Static imports of that module stay cached. */
export type ExtensionManifest = readonly {
  module: string;
  build: (version: string) => Promise<Extension>;
}[];

/** Build and validate the entire replacement registry before publishing any definitions. */
export async function reloadExtensions(registry: Registry, manifest: ExtensionManifest) {
  const version = randomUUID();
  const candidates: Extension[] = [];
  for (const item of manifest) candidates.push(await item.build(version));
  const validation = createRegistry();
  const names = new Set(candidates.map((extension) => extension.name));
  if (names.size !== candidates.length)
    throw new Error("Duplicate extension names in reload manifest");
  // Validate the same publication order: old task names must not collide with an earlier replacement.
  for (const extension of registry.snapshot().installed()) validation.install(extension);
  for (const extension of candidates) validation.install(extension);
  // install is synchronous; no scheduler phase can run between these publications.
  for (const extension of candidates) registry.install(extension);
  return { reloaded: manifest.map((item) => item.module) };
}

/** The supported reload seam; the backend, config, and loader itself need /restart. */
export function extensionManifest(models: Models, config: MonchuConfig, agentDir: string) {
  let pi: Awaited<ReturnType<typeof import("./context.ts").loadPiConfiguration>> | undefined;
  let assessment: ReturnType<typeof import("./classifier.ts").effortAssessment> | undefined;
  const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const url = (name: string, version: string) =>
    new URL(`./${name}.${suffix}?v=${version}`, import.meta.url).href;
  const classifier = config.classifier;
  const manifest: ExtensionManifest = [
    {
      module: "context",
      build: async (version) => {
        const module: typeof import("./context.ts") = await import(url("context", version));
        pi = await module.loadPiConfiguration(agentDir);
        return pi.extension;
      },
    },
    {
      module: "pi-tools",
      build: async (version) => {
        const module: typeof import("./pi-tools.ts") = await import(url("pi-tools", version));
        if (pi === undefined) throw new Error("Pi configuration must load before tools");
        const tools = module.createPiTools(pi.settings, process.platform);
        warnings.push(...tools.warnings);
        return tools.extension;
      },
    },
    {
      module: "workers",
      build: async (version) => {
        const module: typeof import("./workers.ts") = await import(url("workers", version));
        return module.createWorkerTools(config.worker);
      },
    },
    {
      module: "codemode",
      build: async (version) => {
        const module: typeof import("./codemode.ts") = await import(url("codemode", version));
        return module.Codemode;
      },
    },
    {
      module: "goals",
      build: async (version) => {
        const module: typeof import("./goals.ts") = await import(url("goals", version));
        return module.Goals;
      },
    },
    {
      module: "identity",
      build: async (version) => {
        const module: typeof import("./identity.ts") = await import(url("identity", version));
        return module.Identity;
      },
    },
    ...(classifier === null
      ? []
      : [
          {
            module: "classifier",
            build: async (version: string) => {
              const module: typeof import("./classifier.ts") = await import(
                url("classifier", version)
              );
              assessment = module.effortAssessment(models, classifier, config.cloudflareAccountId);
              return assessment.extension;
            },
          },
        ]),
  ];
  const warnings: string[] = [];
  return {
    manifest,
    get configuration() {
      if (pi === undefined) throw new Error("Extension manifest has not loaded");
      return { pi, assessment, warnings };
    },
  };
}

/** Compiled mode needs fresh JS; source mode uses Node's native type stripping. */
export async function buildForReload(): Promise<void> {
  if (import.meta.url.endsWith(".ts")) return;
  await new Promise<void>((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "npm run build"], {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("npm", ["run", "build"], {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            stdio: ["ignore", "pipe", "pipe"],
          });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    });
    child.stderr.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Reload build failed (${code}):\n${output}`)),
    );
  });
}

/** Stored on the root; requesting a restart never executes one. */
export const RestartRequest = defineDoc<{
  request: { reason: string; requestedAt: number } | null;
}>({
  kind: "monchu.restart-request",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ request: null }),
});

export function reloadControls(
  rootId: ConversationId,
  reload: () => Promise<{ reloaded: string[] }>,
) {
  return defineExtension({
    name: "monchu.reload",
    sections: [
      section("restart_request", async (input, context) => {
        const request = (await input.read.snapshot(RestartRequest, rootId, context))?.request;
        return request === undefined || request === null
          ? undefined
          : `Restart requested: ${request.reason}. Only Jorge can approve it with /restart.`;
      }),
    ],
    tools: [
      defineTool({
        name: "reload_extensions",
        description:
          "Reload Monchu extensions, Pi skills, instructions and settings in process. Running calls finish on old code. Host changes require request_restart and Jorge's /restart.",
        parameters: Type.Object({}),
        replay: "unsafe",
        execute: async () => ({
          content: [{ type: "text", text: `Reloaded: ${(await reload()).reloaded.join(", ")}` }],
        }),
      }),
      defineTool({
        name: "request_restart",
        description:
          "Record a reason to ask Jorge for /restart. This never restarts Monchu or approves its own request.",
        parameters: Type.Object(
          { reason: Type.String({ pattern: "\\S", maxLength: 2000 }) },
          { additionalProperties: false },
        ),
        replay: "safe",
        execute: async ({ reason }, api, context) => {
          await api.commit(async (tx) => {
            (await tx.doc(RestartRequest, rootId)).request = {
              reason: reason.trim(),
              requestedAt: Date.now(),
            };
          }, context);
          return {
            content: [
              {
                type: "text",
                text: "Restart requested. Jorge must use /restart; nothing was restarted.",
              },
            ],
          };
        },
      }),
    ],
  });
}
