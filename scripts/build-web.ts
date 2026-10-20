/**
 * Build the web client into dist/web: one hashed script and stylesheet, the shell, the icon and the service worker
 * that keeps them. The script's gzipped size has a budget; going over it fails the build.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = join(ROOT, "src", "web");
const OUT = join(ROOT, "dist", "web");
/**
 * Chord's client host brings its whole runtime and TypeBox (about 80 KB gzip of the ~110); the rest is the app. The
 * service worker keeps the script, so it is fetched once per release.
 */
const BUDGET_GZIP_BYTES = 132 * 1024;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const result = await build({
  entryPoints: { app: join(SOURCE, "main.tsx"), style: join(SOURCE, "style.css") },
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  entryNames: "[name].[hash]",
  outdir: OUT,
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});
const outputs = Object.keys(result.metafile.outputs).map((path) => basename(path));
const js = outputs.find((name) => /^app\..+\.js$/.test(name));
const css = outputs.find((name) => /^style\..+\.css$/.test(name));
if (js === undefined || css === undefined)
  throw new Error("The web build produced no script or stylesheet");
const html = (await readFile(join(SOURCE, "index.html"), "utf8"))
  .replace("{{js}}", js)
  .replace("{{css}}", css);
await writeFile(join(OUT, "index.html"), html);
await copyFile(join(SOURCE, "icon.svg"), join(OUT, "icon.svg"));
// The manifest is the server's, named per device, so the offline shell never keeps a stale one.
const shell = ["/", `/${js}`, `/${css}`, "/icon.svg"];
const version = createHash("sha256").update(shell.join("\n")).digest("hex").slice(0, 12);
await build({
  entryPoints: [join(SOURCE, "worker", "sw.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(OUT, "sw.js"),
  define: {
    MONCHU_VERSION: JSON.stringify(`monchu-${version}`),
    MONCHU_SHELL: JSON.stringify(shell),
  },
  logLevel: "warning",
});
const gzip = gzipSync(await readFile(join(OUT, js))).length;
const cssGzip = gzipSync(await readFile(join(OUT, css))).length;
console.log(
  `web · ${js} ${(gzip / 1024).toFixed(1)} KB gzip · ${css} ${(cssGzip / 1024).toFixed(1)} KB gzip`,
);
if (gzip > BUDGET_GZIP_BYTES)
  throw new Error(`The web client is ${gzip} bytes gzipped, over its ${BUDGET_GZIP_BYTES} budget`);
