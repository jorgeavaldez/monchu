/**
 * The web client's feedback loop. Builds it, runs a throwaway core with faux models behind a loopback OpenID provider
 * that signs anyone in, drives scripted journeys in a real browser through agent-browser, and writes what it saw to an
 * out dir: `report.json`, `summary.md`, and per screen an accessibility snapshot and a screenshot. Hard gates fail the
 * run; with `--baseline <dir>` (an earlier run's out dir) it also compares metrics, snapshots and pixels.
 *
 *   node scripts/web-check.ts [--out web-check] [--baseline <dir>] [--viewport 412x915] [--runs 1] [--only <journey>]
 *
 * `--runs` repeats every journey on a fresh core and reports each metric's median; a gate fails if any run failed it.
 * `--only` runs the load journey and the ones whose name starts with it, for working on one.
 *
 * Needs `agent-browser` on PATH with a browser it can launch. Nothing here touches a real home or a model provider.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { cp, readdir, readFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SESSION = `monchu-web-check-${process.pid}`;
const SUBJECT = "web-check";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "web-check" },
    baseline: { type: "string" },
    viewport: { type: "string", default: "412x915" },
    only: { type: "string" },
    runs: { type: "string", default: "1" },
  },
});
const OUT = resolve(args.out);
const BASELINE = args.baseline === undefined ? undefined : resolve(args.baseline);
const [WIDTH = 0, HEIGHT = 0] = args.viewport.split("x").map(Number);
if (!(WIDTH > 0 && HEIGHT > 0)) throw new Error("--viewport is <width>x<height>, like 412x915");
const RUNS = Number(args.runs);
if (!(Number.isInteger(RUNS) && RUNS >= 1)) throw new Error("--runs is a whole number from 1");
/**
 * WCAG 2.5.8's minimum target: smaller ones pass when a circle this wide on their centre clears every other target. The
 * client is dense on purpose (32 px controls, one-line rows), so a finger-sized 44 px would flag nearly everything.
 */
const TARGET_PX = 24;

type Data = Record<string, unknown>;
const isData = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** One agent-browser command in this run's own session; resolves with its JSON `data`. */
function browser(...command: string[]): Promise<Data> {
  return new Promise((done, fail) => {
    execFile(
      "agent-browser",
      ["--session", SESSION, "--json", ...command],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        const what = `agent-browser ${command.join(" ").slice(0, 80)}`;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return fail(new Error(`${what}: ${error?.message ?? "no JSON output"}`));
        }
        if (!isData(parsed) || parsed.success !== true)
          return fail(new Error(`${what}: ${isData(parsed) ? text(parsed.error) : "bad output"}`));
        done(isData(parsed.data) ? parsed.data : {});
      },
    );
  });
}

/** Evaluate an expression in the page and return its value. */
async function page(expression: string): Promise<unknown> {
  return (await browser("eval", expression)).result;
}

/** The browser's DevTools socket, attached to the page: `send` runs one protocol method on it. Close it when done. */
async function devTools(): Promise<{
  socket: WebSocket;
  send: (method: string, params: Data) => Promise<Data>;
}> {
  const socket = new WebSocket(text((await browser("get", "cdp-url")).cdpUrl));
  let next = 0;
  const waiting = new Map<number, (reply: Data) => void>();
  socket.addEventListener("message", (event) => {
    const reply: unknown = JSON.parse(String(event.data));
    const id = isData(reply) ? number(reply.id) : undefined;
    if (id !== undefined && isData(reply)) waiting.get(id)?.(reply);
  });
  const call = (method: string, params: Data, sessionId?: string) =>
    new Promise<Data>((done, fail) => {
      next += 1;
      waiting.set(next, (reply) =>
        isData(reply.error)
          ? fail(new Error(`${method}: ${text(reply.error.message)}`))
          : done(isData(reply.result) ? reply.result : {}),
      );
      socket.send(
        JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("no DevTools socket")), { once: true });
  });
  // The page agent-browser drives, which needn't be the browser's only one.
  const url = text((await browser("get", "url")).url);
  const pages = list((await call("Target.getTargets", {})).targetInfos).filter(
    (item) => isData(item) && item.type === "page",
  );
  const target = pages.find((item) => isData(item) && item.url === url);
  if (!isData(target)) throw new Error(`no page target at ${url} among ${pages.length}`);
  const session = text(
    (await call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId,
  );
  return { socket, send: (method, params) => call(method, params, session) };
}

/**
 * Makes the page a touch screen (a coarse pointer, touch points) through the browser's DevTools socket, which
 * agent-browser's device presets don't. The emulation lasts while the returned socket stays open; close it to end it.
 */
async function touchScreen(): Promise<WebSocket> {
  const { socket, send } = await devTools();
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "any-pointer", value: "coarse" },
    ],
  });
  return socket;
}

/**
 * A real mouse wheel over a point of the page; agent-browser's own wheel always lands at the top-left corner. Resolves
 * once the scroll it starts has landed: the browser applies a wheel after the dispatch returns, later on a slower one.
 */
async function wheel(x: number, y: number, deltaY: number): Promise<void> {
  await page(`window.wheelLanded = new Promise((landed) => {
    const listening = new AbortController();
    const done = (value) => (listening.abort(), landed(value));
    let last = 0;
    const settle = () => (performance.now() - last > 100 ? done(true) : requestAnimationFrame(settle));
    addEventListener("scroll", () => (last || requestAnimationFrame(settle), (last = performance.now())), {
      capture: true,
      passive: true,
      signal: listening.signal,
    });
    setTimeout(() => done(false), 5000);
  }), true`);
  const { socket, send } = await devTools();
  try {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  } finally {
    socket.close();
  }
  check((await page("window.wheelLanded")) === true, "the wheel scrolled nothing");
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(isData(address) ? (number(address.port) ?? 0) : 0));
    });
  });
}

/**
 * An OpenID provider on loopback that approves every authorization at once: discovery, keys, and a token endpoint that
 * checks the PKCE verifier and signs an ID token for one fixed subject. The server's real login path runs unchanged.
 */
async function identityProvider(): Promise<{ issuer: string; server: Server }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "web-check", alg: "RS256", use: "sig" };
  const issuer = `http://127.0.0.1:${await freePort()}`;
  const codes = new Map<string, { challenge: string; nonce: string; client: string }>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("base64url");
      const query = url.searchParams;
      codes.set(code, {
        challenge: query.get("code_challenge") ?? "",
        nonce: query.get("nonce") ?? "",
        client: query.get("client_id") ?? "",
      });
      const back = new URL(query.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (code === undefined || code.challenge !== verifier) {
          response.writeHead(400);
          return response.end();
        }
        void new SignJWT({ nonce: code.nonce })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(issuer)
          .setSubject(SUBJECT)
          .setAudience(code.client)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey)
          .then((idToken) => json({ id_token: idToken, token_type: "Bearer", access_token: "-" }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((done) => server.listen(Number(new URL(issuer).port), "127.0.0.1", done));
  return { issuer, server };
}

/** `monchu serve --web` from source on a fresh smoke home with faux models; resolves once it serves. */
async function startCore(
  home: string,
  port: number,
  issuer: string,
  root: string = ROOT,
): Promise<ChildProcess> {
  await writeFile(
    join(home, "web.json"),
    JSON.stringify({ port, oidc: { issuer, clientId: "web-check" }, allow: [`sub:${SUBJECT}`] }),
  );
  // Compaction keeps only the newest reply, so `/compact` has something to summarize on a short transcript.
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ settings: { compaction: { keepRecentTokens: 1 } } }),
  );
  const core = spawn(process.execPath, [join(root, "src", "main.ts"), "serve", "--web"], {
    // None of the Monchu this runs under: an update's outcome or a home it names would show in the page.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("MONCHU_")),
      ),
      MONCHU_DEV_FAUX: "1",
      MONCHU_DEV_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the core didn't start:\n${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`web · http://127.0.0.1:${port}/`)) {
        clearTimeout(timer);
        done();
      }
    };
    core.stdout.on("data", read);
    core.stderr.on("data", read);
    core.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the core exited (${code}):\n${output}`));
    });
  });
  return core;
}

async function stopCore(core: ChildProcess): Promise<void> {
  if (core.exitCode !== null) return;
  const exited = new Promise((done) => core.once("exit", done));
  core.kill("SIGTERM");
  const timer = setTimeout(() => core.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

type Violation = { id: string; impact: string; nodes: number; targets: string[] };
/** What the layout probe found on one screen: each a few words naming the element, the first few kept. */
type Layout = { smallTargets: string[]; overlaps: string[] };
type Screen = {
  violations: Violation[];
  layout?: Layout;
  mismatchPct?: number;
  added?: string[];
  removed?: string[];
};
type Report = {
  version: 1;
  viewport: string;
  runs: number;
  gates: { name: string; ok: boolean; detail: string }[];
  metrics: Record<string, number>;
  screens: Record<string, Screen>;
};

const report: Report = {
  version: 1,
  viewport: `${WIDTH}x${HEIGHT}`,
  runs: RUNS,
  gates: [],
  metrics: {},
  screens: {},
};

function gate(name: string, ok: boolean, detail: string): void {
  report.gates.push({ name, ok, detail });
}

async function readBaseline(): Promise<Report | undefined> {
  if (BASELINE === undefined) return undefined;
  const written = await readFile(join(BASELINE, "report.json"), "utf8").catch(() => undefined);
  if (written === undefined) return undefined;
  const parsed: unknown = JSON.parse(written);
  if (!isData(parsed) || parsed.version !== 1 || !isData(parsed.metrics) || !isData(parsed.screens))
    throw new Error(`${BASELINE}/report.json is not a web-check report`);
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.metrics)) {
    const found = number(value);
    if (found !== undefined) metrics[key] = found;
  }
  const screens: Record<string, Screen> = {};
  for (const [key, value] of Object.entries(parsed.screens))
    screens[key] = {
      violations: list(isData(value) ? value.violations : undefined).flatMap((item) =>
        isData(item) && typeof item.id === "string"
          ? [
              {
                id: item.id,
                impact: text(item.impact),
                nodes: number(item.nodes) ?? 0,
                targets: list(item.targets).map(text),
              },
            ]
          : [],
      ),
    };
  return {
    version: 1,
    viewport: text(parsed.viewport),
    runs: number(parsed.runs) ?? 1,
    gates: [],
    metrics,
    screens,
  };
}

/** Lines in one text and not the other, counted as multisets, so moved lines don't count. */
function lineChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const line of before.split("\n")) count.set(line, (count.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1);
    else added.push(line);
  }
  const removed = [...count].flatMap(([line, left]) => Array<string>(left).fill(line));
  return { added, removed };
}

/**
 * Freeze what differs between runs: clock times in the page's time and stamp elements read `hh:mm`, ages (`12m`) `n`, and the temp home
 * and port are spelled as placeholders. Short ids stay, since a fresh store gives the same ones every run.
 */
function normalize(home: string, origin: string): Promise<unknown> {
  return page(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let value = node.nodeValue.split(${JSON.stringify(home)}).join("<home>")
        .split(${JSON.stringify(origin)}).join("127.0.0.1:<port>");
      if (node.parentElement?.closest(".time, .stamp")) value = value.replace(/\\d{1,2}:\\d{2}/g, "hh:mm");
      if (node.parentElement?.closest(".age")) value = value.replace(/\\b\\d+[smhd]\\b/g, "n");
      if (value !== node.nodeValue) node.nodeValue = value;
    }
    return true;
  })()`);
}

/**
 * Layout faults axe doesn't see, on what is visible now (each box clipped to the scrolling boxes around it and the
 * viewport): targets under `TARGET_PX` that also crowd another target (WCAG 2.5.8 with its spacing exception; links
 * inside text are exempt), and controls whose visible boxes cover each other's.
 */
async function layoutProbe(): Promise<Layout> {
  const found = await page(`(() => {
    const name = (item) => item.tagName.toLowerCase() + (item.className && typeof item.className === "string" ? "." + item.className.trim().split(/\\s+/).join(".") : "") + (item.getAttribute("aria-label") ? "[" + item.getAttribute("aria-label") + "]" : item.textContent.trim() ? " " + JSON.stringify(item.textContent.trim().slice(0, 20)) : "");
    const visible = (item) => {
      const box = item.getBoundingClientRect();
      let [left, top, right, bottom] = [Math.max(box.left, 0), Math.max(box.top, 0), Math.min(box.right, innerWidth), Math.min(box.bottom, innerHeight)];
      for (let up = item.parentElement; up; up = up.parentElement) {
        if (getComputedStyle(up).overflow === "visible") continue;
        const clip = up.getBoundingClientRect();
        [left, top, right, bottom] = [Math.max(left, clip.left), Math.max(top, clip.top), Math.min(right, clip.right), Math.min(bottom, clip.bottom)];
      }
      return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom, width: box.width, height: box.height } : undefined;
    };
    const controls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=option], [tabindex]:not([tabindex='-1'])")]
      .filter((item) => getComputedStyle(item).visibility !== "hidden" && !item.closest("[inert], [aria-hidden=true]"))
      .filter((item) => !(item.matches("a") && item.closest(".md, .body, .help, p")) && !item.matches(".pick, .transcript, [role=listbox]"))
      .flatMap((item) => { const box = visible(item); return box ? [{ item, box }] : []; });
    const small = (box) => Math.min(box.width, box.height) < ${TARGET_PX} - 0.5;
    const centre = (box) => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
    const gap = ([x, y], box) => Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
    const related = (one, two) => one.item.contains(two.item) || two.item.contains(one.item);
    const smallTargets = controls.filter((one) => small(one.box) && controls.some((two) => two !== one && !related(one, two) && (gap(centre(one.box), two.box) < ${TARGET_PX} / 2 - 0.5 || (small(two.box) && Math.hypot(centre(one.box)[0] - centre(two.box)[0], centre(one.box)[1] - centre(two.box)[1]) < ${TARGET_PX} - 0.5)))).map((one) => name(one.item));
    const overlaps = [];
    for (let at = 0; at < controls.length; at++)
      for (let next = at + 1; next < controls.length; next++) {
        const one = controls[at], two = controls[next];
        if (related(one, two)) continue;
        const a = one.box, b = two.box;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(name(one.item) + " × " + name(two.item));
      }
    return { smallTargets, overlaps };
  })()`);
  const strings = (value: unknown) => list(value).map(text);
  return {
    smallTargets: strings(isData(found) ? found.smallTargets : undefined),
    overlaps: strings(isData(found) ? found.overlaps : undefined),
  };
}

/** Snapshot, screenshot, accessibility audit and layout check of what the page shows now. */
async function capture(name: string, home: string, origin: string): Promise<void> {
  await normalize(home, origin);
  const snapshot = text((await browser("snapshot", "-c")).snapshot).replace(
    / \[ref=e\d+\]|, ref=e\d+/g,
    "",
  );
  await writeFile(join(OUT, `${name}.snapshot.txt`), snapshot);
  await browser("screenshot", join(OUT, `${name}.png`));
  const audit = await browser("a11y");
  const screen: Screen = {
    violations: list(audit.violations).flatMap((item) =>
      isData(item) && typeof item.id === "string"
        ? [
            {
              id: item.id,
              impact: text(item.impact),
              nodes: number(item.nodeCount) ?? 0,
              // Where, for whoever fixes it: the first few elements' selectors.
              targets: list(item.nodes)
                .slice(0, 3)
                .map((node) => (isData(node) ? list(node.target).join(" ") : "")),
            },
          ]
        : [],
    ),
  };
  screen.layout = await layoutProbe();
  report.screens[name] = screen;
  const overflow = number(await page("document.documentElement.scrollWidth - innerWidth")) ?? 0;
  gate(`${name}: no horizontal overflow`, overflow <= 0, `${overflow} px wider than the viewport`);
  if (BASELINE === undefined) return;
  const before = await readFile(join(BASELINE, `${name}.snapshot.txt`), "utf8").catch(
    () => undefined,
  );
  if (before !== undefined) Object.assign(screen, lineChanges(before, snapshot));
  const image = join(BASELINE, `${name}.png`);
  if (
    await readFile(image).then(
      () => true,
      () => false,
    )
  ) {
    const diff = await browser(
      "diff",
      "screenshot",
      "--baseline",
      image,
      "--output",
      join(OUT, `${name}.diff.png`),
    ).catch(() => undefined);
    const mismatch = number(diff?.mismatchPercentage);
    if (mismatch !== undefined) screen.mismatchPct = Math.round(mismatch * 100) / 100;
  }
}

/** Run one journey as a gate: its assertions, or the error that stopped it. */
async function journey(name: string, steps: () => Promise<string>): Promise<void> {
  if (args.only !== undefined && !name.startsWith("load:") && !name.startsWith(args.only)) return;
  try {
    gate(`journey ${name}`, true, await steps());
  } catch (error) {
    gate(`journey ${name}`, false, error instanceof Error ? error.message : String(error));
  }
}

const ms = (since: number) => Math.round(performance.now() - since);

/** The core log's records of `scope` saying `body`, in order. */
async function logRecords(home: string, scope: string, body: string): Promise<Data[]> {
  const logs = join(home, "logs");
  const records: Data[] = [];
  for (const file of (await readdir(logs).catch(() => [])).toSorted((a, b) => a.localeCompare(b)))
    for (const line of (await readFile(join(logs, file), "utf8")).split("\n")) {
      if (!line) continue;
      const record: unknown = JSON.parse(line);
      if (isData(record) && record.scope === scope && record.body === body) records.push(record);
    }
  return records;
}

/** The page's own `ready` records in the core's log, in order. */
async function readyTimes(home: string): Promise<number[]> {
  return (await logRecords(home, "web", "ready")).flatMap((record) => {
    const value = number(isData(record.attributes) ? record.attributes.ms : undefined);
    return value === undefined ? [] : [value];
  });
}

async function bundle(): Promise<void> {
  const built = await new Promise<string>((done, fail) =>
    execFile(process.execPath, [join(ROOT, "scripts", "build-web.ts")], (error, stdout, stderr) =>
      error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
    ),
  );
  gate("web build within its budget", true, built.trim());
  const dist = join(ROOT, "dist", "web");
  for (const file of await readdir(dist)) {
    const kind = /^app\..+\.js$/.test(file) ? "js" : /^style\..+\.css$/.test(file) ? "css" : "";
    if (kind)
      report.metrics[`bundle.${kind}.gzipBytes`] = gzipSync(
        await readFile(join(dist, file)),
      ).length;
  }
}

/** A PNG of `width` by `height` with a gradient, for the attach journey. */
async function gradientPng(width: number, height: number): Promise<Uint8Array> {
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const pixels = new Uint8Array(width * height * 4).map((_, index) => {
    const pixel = Math.floor(index / 4);
    const channel = index % 4;
    if (channel === 3) return 255;
    return channel === 0
      ? (pixel % width) % 256
      : channel === 1
        ? Math.floor(pixel / width) % 256
        : 160;
  });
  const image = new PhotonImage(pixels, width, height);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

/**
 * What typing may cost with the CPU slowed down as on a mid-range phone, on a transcript of a few hundred items: each
 * key from its event to the task after the next frame, at the median (p95 is tracked, too noisy to gate), and the
 * virtual nodes a keystroke renders: an editor's worth, never the transcript's. The same while a reply streams in,
 * which re-renders the transcript.
 */
const TYPING = {
  cpuSlowdown: 4,
  keys: 32,
  gapMs: 90,
  idleP50Ms: 50,
  streamingP50Ms: 60,
  vnodesPerKey: 60,
};

/** In the page: each keystroke's latency and the vnodes it rendered (`monchuPerf`, from telemetry.ts). */
const PROBE = `(() => {
  const probe = { latency: [], vnodes: [], longTasks: 0 };
  addEventListener("keydown", (event) => {
    const at = event.timeStamp;
    const before = monchuPerf.vnodes;
    requestAnimationFrame(() => {
      const after = new MessageChannel();
      after.port1.onmessage = () => {
        probe.latency.push(performance.now() - at);
        probe.vnodes.push(monchuPerf.vnodes - before);
      };
      after.port2.postMessage(0);
    });
  }, true);
  new PerformanceObserver((list) => { probe.longTasks += list.getEntries().length; }).observe({ type: "longtask" });
  window.typingProbe = probe;
  return true;
})()`;

/** The value at `share` of the way up `values`, rounded. */
function percentile(values: number[], share: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0);
}

/** Real keystrokes into the focused editor, `gapMs` apart, as the probe measured them. */
async function typeKeys(
  send: (method: string, params: Data) => Promise<Data>,
): Promise<{ latency: number[]; vnodes: number[]; longTasks: number }> {
  await page(
    `Object.assign(window.typingProbe, { latency: [], vnodes: [], longTasks: 0 }) && true`,
  );
  for (let at = 0; at < TYPING.keys; at++) {
    const key = String.fromCharCode(97 + (at % 26));
    const code = `Key${key.toUpperCase()}`;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
    await new Promise((done) => setTimeout(done, TYPING.gapMs));
  }
  await browser("wait", "--fn", `window.typingProbe.latency.length >= ${TYPING.keys}`);
  const probe = await page("window.typingProbe");
  if (!isData(probe)) throw new Error("no typing probe in the page");
  const numbers = (value: unknown) =>
    list(value).flatMap((item) => (typeof item === "number" ? [item] : []));
  return {
    latency: numbers(probe.latency),
    vnodes: numbers(probe.vnodes),
    longTasks: number(probe.longTasks) ?? 0,
  };
}

/** Seeds a long transcript, then types on it, idle and while a reply streams, with the CPU slowed down. */
async function typing(): Promise<string> {
  const finished = `[...document.querySelectorAll(".assistant:not(.live)")].filter((item) => item.textContent.includes("Faux tool finished")).length`;
  const before = Number(await page(finished));
  for (let round = 1; round <= 3; round++) {
    await browser("fill", "textarea", "tools 40");
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `${finished} >= ${before + round} && !document.querySelector(".status")`,
    );
  }
  await browser("fill", "textarea", "");
  const nodes = number(await page(`document.querySelectorAll("*").length`)) ?? 0;
  check((await page(PROBE)) === true, "the typing probe didn't install");
  const { socket, send } = await devTools();
  try {
    await send("Emulation.setCPUThrottlingRate", { rate: TYPING.cpuSlowdown });
    await browser("focus", "textarea");
    const idle = await typeKeys(send);
    // The faux model echoes a message back, so a long one streams for several seconds; Esc stops it after the keys.
    await browser("fill", "textarea", `stream ${"z ".repeat(3000)}`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `!!document.querySelector(".live")`);
    await browser("fill", "textarea", "");
    const streaming = await typeKeys(send);
    const streamed = (await page(`!!document.querySelector(".live")`)) === true;
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector(".live")`);
    await browser("fill", "textarea", "");
    const metrics = {
      "typing.idleP50Ms": percentile(idle.latency, 0.5),
      "typing.idleP95Ms": percentile(idle.latency, 0.95),
      "typing.vnodesPerKey": percentile(idle.vnodes, 0.5),
      "typing.streamingP50Ms": percentile(streaming.latency, 0.5),
      "typing.streamingP95Ms": percentile(streaming.latency, 0.95),
      "typing.longTasks": idle.longTasks + streaming.longTasks,
    };
    Object.assign(report.metrics, metrics);
    check(streamed, "the reply was done before the keys were in");
    const over = [
      ["idle p50", metrics["typing.idleP50Ms"], TYPING.idleP50Ms, " ms"],
      ["streaming p50", metrics["typing.streamingP50Ms"], TYPING.streamingP50Ms, " ms"],
      ["vnodes a key", metrics["typing.vnodesPerKey"], TYPING.vnodesPerKey, ""],
    ] as const;
    for (const [what, value, budget, unit] of over)
      check(value <= budget, `${what} ${value}${unit}, over its ${budget}${unit} budget`);
    return `${nodes} DOM nodes at ${TYPING.cpuSlowdown}x CPU: idle p50/p95 ${metrics["typing.idleP50Ms"]}/${metrics["typing.idleP95Ms"]} ms, ${metrics["typing.vnodesPerKey"]} vnodes a key; streaming p50/p95 ${metrics["typing.streamingP50Ms"]}/${metrics["typing.streamingP95Ms"]} ms`;
  } finally {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
    socket.close();
  }
}

const SETTLED = `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes("DONE"))`;

/** The page's server, stopped and started again on the same home and port, as a crash or a restart does. */
type ServerControl = { stop(): Promise<void>; start(root?: string): Promise<void> };

/**
 * The next release, as `/update` would bring it: a copy of this checkout whose session contract is a version newer,
 * with its own web build. A page still holding the old contract is outdated against its core.
 */
async function nextRelease(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "monchu-next-"));
  const skip = new Set(["node_modules", ".jj", ".git", "dist", "web-check"]);
  for (const entry of await readdir(ROOT))
    if (!skip.has(entry)) await cp(join(ROOT, entry), join(root, entry), { recursive: true });
  await symlink(join(ROOT, "node_modules"), join(root, "node_modules"), "junction");
  const contract = join(root, "src", "api", "contract.ts");
  const source = await readFile(contract, "utf8");
  const bumped = source.replace(
    /(remote\("monchu\.session", \{\n  version: )(\d+)/,
    (_, head: string, version: string) => `${head}${Number(version) + 1}`,
  );
  if (bumped === source) throw new Error("no monchu.session version to bump in contract.ts");
  await writeFile(contract, bumped);
  await new Promise<void>((done, fail) =>
    execFile(process.execPath, [join(root, "scripts", "build-web.ts")], (error, _out, stderr) =>
      error ? fail(new Error(`${error.message}\n${stderr}`)) : done(),
    ),
  );
  return root;
}

async function journeys(
  url: string,
  home: string,
  origin: string,
  server: ServerControl,
): Promise<void> {
  await browser("set", "viewport", String(WIDTH), String(HEIGHT));
  await browser("set", "media", "light", "reduced-motion");

  await journey("load: sign in, then reload from the service worker", async () => {
    const cold = performance.now();
    await browser("open", url);
    await browser(
      "wait",
      "--fn",
      `document.querySelector("textarea") && document.querySelector(".transcript")?.textContent.includes("/help")`,
    );
    report.metrics["load.coldMs"] = ms(cold);
    const at = text((await browser("get", "url")).url);
    check(at.split("?")[0] === url, `ended on ${at}, not ${url}`);
    const vitals = await browser("vitals");
    const lcp = isData(vitals.lcp) ? number(vitals.lcp.startTime) : undefined;
    const cls = isData(vitals.cls) ? number(vitals.cls.score) : undefined;
    const measured = {
      "vitals.ttfbMs": number(vitals.ttfb),
      "vitals.fcpMs": number(vitals.fcp),
      "vitals.lcpMs": lcp,
      "vitals.cls": cls,
    };
    for (const [key, value] of Object.entries(measured))
      if (value !== undefined) report.metrics[key] = Math.round(value * 1000) / 1000;
    await capture("load", home, origin);
    const warm = performance.now();
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `document.querySelector(".transcript")?.textContent.includes("/help")`,
    );
    report.metrics["load.warmMs"] = ms(warm);
    check(
      (await page("navigator.serviceWorker.controller !== null")) === true,
      "the reload wasn't served by the service worker",
    );
    return "signed in through the OpenID login; the reload came from the service worker";
  });

  await journey(
    "client: /client names this device's app, picks a theme, offers the install once",
    async () => {
      const manifestName = () =>
        page(
          `fetch("/manifest.webmanifest").then((response) => response.json()).then((value) => value.name)`,
        );
      // Chromium offers to install the page; the offer shows once, and a dismissal outlives a reload.
      await browser("wait", ".offer");
      await capture("install-offer", home, origin);
      await page(`document.querySelector(".offer [aria-label=close]").click()`);
      await browser("reload");
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".transcript")?.textContent.includes("/help")`,
      );
      check(
        (await page(`document.querySelector(".offer") === null`)) === true,
        "a dismissed install offer came back",
      );
      await browser("fill", "textarea", "/client");
      await browser("press", "Enter");
      await browser("wait", ".clientPanel li");
      check(
        (await page(
          `document.querySelector(".clientPanel li:nth-child(2) .help")?.textContent.length > 0`,
        )) === true,
        "the install row doesn't say where installing stands",
      );
      await browser("fill", "#client-name", "Monchu check");
      await page(`document.querySelector(".clientPanel [aria-label='save the name']").click()`);
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".clientPanel [role=status]")?.textContent.startsWith("named Monchu check")`,
      );
      check((await manifestName()) === "Monchu check", "the manifest doesn't carry the new name");
      check(
        (await page("document.title")) === "Monchu check",
        "the tab title didn't follow the name",
      );
      await page(
        `[...document.querySelectorAll(".clientPanel button")].find((each) => each.textContent === "dark").click()`,
      );
      check(
        (await page("document.documentElement.dataset.theme")) === "dark",
        "the dark theme didn't apply",
      );
      await capture("client", home, origin);
      await browser("reload");
      await browser(
        "wait",
        "--fn",
        `document.title === "Monchu check" && document.documentElement.dataset.theme === "dark"`,
      );
      await browser("fill", "textarea", "/client");
      await browser("press", "Enter");
      await browser("wait", ".clientPanel li");
      await browser("fill", "#client-name", "");
      await page(`document.querySelector(".clientPanel [aria-label='save the name']").click()`);
      await page(
        `[...document.querySelectorAll(".clientPanel button")].find((each) => each.textContent === "system").click()`,
      );
      await browser(
        "wait",
        "--fn",
        `document.title === "Monchu" && !document.documentElement.dataset.theme`,
      );
      check((await manifestName()) === "Monchu", "an empty name didn't go back to Monchu");
      await browser("press", "Escape");
      await browser(
        "wait",
        "--fn",
        `!document.querySelector(".clientPanel") && document.querySelector("textarea")`,
      );
      return "offered the install once, renamed the app (manifest and title, kept over a reload), themed it dark, reset both";
    },
  );

  await journey("send: a message gets its streamed reply", async () => {
    await browser("fill", "textarea", "hello");
    const sent = performance.now();
    await browser("press", "Enter");
    await browser("wait", "--fn", SETTLED);
    report.metrics["send.replyMs"] = ms(sent);
    check(
      (await page(`document.querySelector("textarea").value`)) === "",
      "the editor kept the text",
    );
    check(
      (await page(
        `[...document.querySelectorAll(".user")].some((item) => item.textContent.includes("hello"))`,
      )) === true,
      "the sent message isn't in the transcript",
    );
    await capture("send", home, origin);
    return "reply settled";
  });

  await journey("status: the bar's toggle opens its details above it and closes them", async () => {
    await browser("click", ".footer .more");
    await browser("wait", ".status");
    const terms = text(
      await page(
        `[...document.querySelectorAll(".status dt")].map((term) => term.textContent).join(" ")`,
      ),
    );
    check(terms.startsWith("dir model context tokens"), `details read ${terms}`);
    await capture("status", home, origin);
    await browser("click", ".footer .more");
    check(
      (await page(`document.querySelector(".status") === null`)) === true,
      "details stayed open",
    );
    return terms;
  });

  await journey(
    "markdown: a reply renders as markdown while it streams and once settled, safely",
    async () => {
      const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
      const before = Number(await page(replies));
      await browser("fill", "textarea", "markdown");
      await browser("press", "Enter");
      // Part way through: the blocks streamed so far are already drawn, and nothing overflows.
      await browser("wait", "--fn", `!!document.querySelector(".live .md li")`);
      check(
        (await page(`!!document.querySelector(".live .md .h1 + p strong")`)) === true,
        "the streaming reply isn't drawn as markdown",
      );
      const streamingOverflow =
        number(await page("document.documentElement.scrollWidth - innerWidth")) ?? 0;
      check(streamingOverflow <= 0, `the streaming reply overflows by ${streamingOverflow} px`);
      await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
      const reply = `[...document.querySelectorAll(".assistant:not(.live)")].at(-1).querySelector(".md")`;
      const has = async (selector: string, what: string) =>
        check(
          (await page(`!!${reply}.querySelector(${JSON.stringify(selector)})`)) === true,
          `no ${what}`,
        );
      await has(".h1", "heading");
      await has("p strong", "bold");
      await has("p em", "italic");
      await has("p s", "strikethrough");
      await has("p code", "inline code");
      await has(
        `a[href="https://example.com/docs"][rel~="noopener"][target="_blank"]`,
        "safe link",
      );
      await has("ul > li > ul > li", "nested list");
      await has("ol > li + li", "ordered list");
      await has("blockquote", "quote");
      await has(".table th + th", "table");
      await has("hr", "rule");
      check(
        (await page(`${reply}.textContent.includes("snake_case_name")`)) === true,
        "underscores inside a word became emphasis",
      );
      check(
        (await page(
          `!${reply}.querySelector("b, a[href^='javascript']") && ${reply}.textContent.includes("<b>raw html</b>") && ${reply}.textContent.includes("unsafe")`,
        )) === true,
        "raw HTML or a javascript: link got through",
      );
      check(
        (await page(
          // Each line of code on one line, and a scrollbar for what is wider than the screen: at any width.
          `((pre) => { const code = pre.querySelector("code") ?? pre, style = getComputedStyle(pre); const lines = code.textContent.replace(/\\n$/, "").split("\\n").length; return code.getBoundingClientRect().height <= lines * parseFloat(style.lineHeight) + 1 && ["auto", "scroll"].includes(style.overflowX); })(${reply}.querySelector("pre.code"))`,
        )) === true,
        "a wide code block wraps instead of scrolling",
      );
      check(
        (await page(
          `(() => { const lh = parseFloat(getComputedStyle(${reply}).lineHeight); return [...${reply}.querySelectorAll("p, li, code, th, td")].every((item) => parseFloat(getComputedStyle(item).fontSize) === 14 && Math.abs(parseFloat(getComputedStyle(item).lineHeight) - lh) < 0.5); })()`,
        )) === true,
        "markdown text strays from the message's size or line height",
      );
      await capture("markdown", home, origin);
      // Typed text stays as written unless a fence says markdown is meant.
      const user = `[...document.querySelectorAll(".user")].at(-1)`;
      for (const [typed, markdown] of [
        ["a *plain* note", false],
        ["a *fenced* note\n```\nfenced\n```", true],
      ] as const) {
        const count = Number(await page(replies));
        await browser("fill", "textarea", typed);
        await browser("press", "Enter");
        await browser("wait", "--fn", `${replies} > ${count} && !document.querySelector(".live")`);
        check(
          (await page(`!!${user}.querySelector("pre.code") && !!${user}.querySelector("em")`)) ===
            markdown,
          markdown ? "a fenced message isn't drawn as markdown" : "a plain message got markdown",
        );
      }
      return "streamed and settled reply drawn as markdown, links safe, raw HTML as text";
    },
  );

  await journey(
    "attach: a picked image uploads, previews in the tray, and goes with the message",
    async () => {
      const file = join(home, "attach-check.png");
      await writeFile(file, await gradientPng(240, 140));
      await browser("upload", "input[type=file]", file);
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".attach-tray img")?.naturalWidth > 0 && !document.querySelector(".attach-tray").textContent.includes("uploading")`,
      );
      await capture("attach-tray", home, origin);
      await browser("fill", "textarea", "what is this?");
      const sent = performance.now();
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes("what is this?"))`,
      );
      report.metrics["attach.replyMs"] = ms(sent);
      check(
        (await page(`document.querySelector(".attach-tray") === null`)) === true,
        "the tray kept the sent file",
      );
      check(
        (await page(`document.querySelector(".user .attached img")?.naturalWidth > 0`)) === true,
        "the sent image isn't shown in the transcript",
      );
      await capture("attach", home, origin);
      return "picked, uploaded, previewed, sent, and shown under the message";
    },
  );

  await journey(
    "order: notices and messages in the order they happened, the end followed",
    async () => {
      const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
      const before = Number(await page(replies));
      await browser("fill", "textarea", "/help");
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".notice")].some((item) => item.textContent.includes("/model"))`,
      );
      await browser("fill", "textarea", "hello again");
      await browser("press", "Enter");
      await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
      // Each item's place in the transcript, by the first element matching what it is.
      const order = await page(`(() => {
      const items = [...document.querySelector(".transcript").children];
      const at = (match) => items.findIndex(match);
      const has = (selector, text) => (item) => item.matches(selector) && item.textContent.includes(text);
      return {
        header: at(has(".notice", "· /help ·")),
        hello: at(has(".user", "hello")),
        help: at(has(".notice", "/model")),
        again: at(has(".user", "hello again")),
        last: items.findLastIndex((item) => item.matches(".assistant")),
        notices: items.findLastIndex((item) => item.matches(".notice")),
        gap: (({ scrollHeight, scrollTop, clientHeight }) => scrollHeight - scrollTop - clientHeight)(document.querySelector(".transcript")),
      };
    })()`);
      if (!isData(order)) throw new Error("no order read");
      const index = (key: string) => number(order[key]) ?? -1;
      const sequence = ["header", "hello", "help", "again", "last"];
      check(
        sequence.every(
          (key, at) => index(key) >= 0 && (at === 0 || index(key) > index(sequence[at - 1] ?? "")),
        ),
        `out of order: ${JSON.stringify(order)}`,
      );
      check(index("notices") < index("last"), "a notice sits below the newest reply");
      check(index("gap") <= 2, `the view is ${index("gap")} px above the end`);
      await capture("order", home, origin);
      return "header, message, /help, message, reply in order; the view at the end";
    },
  );

  await journey(
    "scroll: reading back holds the view while a reply streams; the pill returns",
    async () => {
      const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
      const before = Number(await page(replies));
      const position = `(({ scrollHeight, scrollTop, clientHeight }) => ({ top: scrollTop, gap: scrollHeight - scrollTop - clientHeight }))(document.querySelector(".transcript"))`;
      const read = async () => {
        const value = await page(position);
        if (!isData(value)) throw new Error("no scroll position read");
        return { top: number(value.top) ?? 0, gap: number(value.gap) ?? 0 };
      };
      // Reading back needs more transcript than the view holds, whatever this browser's fonts make of the journeys
      // before; /help is answered here at once, with no model.
      const room = `(({ scrollHeight, clientHeight }) => scrollHeight - clientHeight)(document.querySelector(".transcript"))`;
      for (let tries = 0; (number(await page(room)) ?? 0) < 600; tries += 1) {
        check(tries < 5, `the transcript has only ${String(await page(room))} px to scroll back`);
        const notices = Number(await page(`document.querySelectorAll(".notice").length`));
        await browser("fill", "textarea", "/help");
        await browser("press", "Enter");
        await browser("wait", "--fn", `document.querySelectorAll(".notice").length > ${notices}`);
      }
      // The faux model echoes the message, so a long one streams for a few seconds.
      await browser("fill", "textarea", `read back ${"y".repeat(400)}`);
      await browser("press", "Enter");
      await browser("wait", ".live");
      await wheel(200, 300, -400);
      const held = await read();
      check(held.gap > 100, `the wheel left the view ${held.gap} px above the end`);
      await browser("fill", "textarea", "drafting while reading");
      await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
      const after = await read();
      check(Math.abs(after.top - held.top) <= 1, `the view moved from ${held.top} to ${after.top}`);
      check(
        (await page(
          `/^↓ \\d+ new$/.test(document.querySelector(".unread")?.textContent ?? "")`,
        )) === true,
        "no new-output pill",
      );
      await capture("unread", home, origin);
      await browser("click", ".unread");
      await browser("wait", "--fn", `!document.querySelector(".unread")`);
      const end = await read();
      check(end.gap <= 2, `the pill left the view ${end.gap} px above the end`);
      await browser("fill", "textarea", "");
      return `held at ${held.top} px through the reply and typing; the pill went back to the end`;
    },
  );

  await journey("skill: its instructions fold under its name, the typed text shows", async () => {
    const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
    const before = Number(await page(replies));
    await browser("fill", "textarea", "/skill:onboard check this");
    await browser("press", "Enter");
    await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
    const card = `[...document.querySelectorAll(".card.skill")].at(-1)`;
    check(
      (await page(`${card}?.querySelector("header").textContent.includes("/skill:onboard")`)) ===
        true,
      "no skill card",
    );
    check((await page(`${card}.querySelector(".body") === null`)) === true, "the skill shows open");
    check(
      (await page(
        `${card}.nextElementSibling?.matches(".user") && ${card}.nextElementSibling.textContent === "check this"`,
      )) === true,
      "the typed text isn't shown after the skill",
    );
    check(
      (await page(
        `[...document.querySelectorAll(".user")].some((item) => item.textContent.includes("<skill"))`,
      )) === false,
      "a message shows the raw skill block",
    );
    await capture("skill", home, origin);
    await page(`${card}.querySelector("header").click()`);
    check(
      (await page(`${card}.querySelector(".body .md") !== null`)) === true,
      "a tap doesn't open it",
    );
    await page(`${card}.querySelector("header").click()`);
    return "folded under /skill:onboard, the typed text below it, a tap opens it";
  });

  await journey("editor: grows with its text up to a cap, then scrolls", async () => {
    const box = `(({ clientHeight, scrollHeight }) => ({ height: clientHeight, scroll: scrollHeight, pad: parseFloat(getComputedStyle(document.querySelector("textarea")).paddingTop) }))(document.querySelector("textarea"))`;
    const measure = async () => {
      const value = await page(box);
      if (!isData(value)) throw new Error("no editor size read");
      return {
        height: number(value.height) ?? 0,
        scroll: number(value.scroll) ?? 0,
        pad: number(value.pad) ?? 0,
      };
    };
    await browser("fill", "textarea", "one line");
    const one = await measure();
    await browser("fill", "textarea", "one\ntwo\nthree");
    const three = await measure();
    await browser(
      "fill",
      "textarea",
      Array.from({ length: 40 }, (_, at) => `line ${at}`).join("\n"),
    );
    const many = await measure();
    await browser("fill", "textarea", "");
    const empty = await measure();
    check(one.pad >= 8, `${one.pad} px top padding`);
    check(three.height > one.height, `three lines are ${three.height} px, one is ${one.height} px`);
    check(
      many.height > three.height && many.height < HEIGHT / 2 + 1,
      `forty lines are ${many.height} px`,
    );
    check(many.scroll > many.height, "forty lines don't scroll inside the box");
    check(empty.height === one.height, `emptied it is ${empty.height} px, not ${one.height} px`);
    return `${one.height} px, ${three.height} px for three lines, capped at ${many.height} px`;
  });

  await journey(
    "tool: a call folds to one line at the text's rhythm, a tap opens it, a returned image shows",
    async () => {
      await browser("fill", "textarea", "read");
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes("Faux tool finished"))`,
      );
      const tool = `document.querySelector(".transcript .tool")`;
      check(
        (await page(
          `${tool}.querySelector(".row").getBoundingClientRect().height <= parseFloat(getComputedStyle(${tool}).lineHeight) + 1 && !${tool}.querySelector("pre")`,
        )) === true,
        "the tool call isn't folded to one line",
      );
      check(
        (await page(
          `(() => { const left = (item) => item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).borderLeftWidth) + parseFloat(getComputedStyle(item).paddingLeft); return left(${tool}) === left(document.querySelector(".transcript .user")); })()`,
        )) === true,
        "the tool row's text doesn't line up with a message's",
      );
      await capture("tool", home, origin);
      await page(`${tool}.querySelector(".row").click()`);
      check((await page(`!!${tool}.querySelector("pre")`)) === true, "a tap doesn't open the call");
      await page(`${tool}.querySelector(".row").click()`);
      check((await page(`!${tool}.querySelector("pre")`)) === true, "a second tap doesn't fold it");
      // An image a tool returns, a screenshot say, shows under its folded row.
      const image = join(home, "tool-check.png");
      await writeFile(image, await gradientPng(240, 140));
      await browser("fill", "textarea", `read ${image}`);
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".transcript .tool .attached img")].some((img) => img.complete && img.naturalWidth === 240)`,
      );
      check(
        (await page(`!document.querySelector(".transcript .tool:has(.attached) pre")`)) === true,
        "the image's call isn't folded",
      );
      await capture("tool-image", home, origin);
      return "folded to one line, aligned with the messages, opened and folded by tap; a returned image shows under its row";
    },
  );

  await journey("model: typeahead, then the /model picker opens and Esc closes it", async () => {
    await browser("fill", "textarea", "/mod");
    await browser("wait", "[role=listbox]");
    check(
      (await page(
        `document.querySelector("[role=option][aria-selected=true]")?.textContent.startsWith("/model")`,
      )) === true,
      "/model isn't the selected suggestion",
    );
    await capture("typeahead", home, origin);
    await browser("press", "Enter");
    check(
      (await page(`document.querySelector("textarea").value`)) === "/model ",
      "Enter didn't take the suggestion",
    );
    const box = `Math.round(document.querySelector("textarea").getBoundingClientRect().top)`;
    const top = await page(box);
    const opened = performance.now();
    await browser("press", "Enter");
    await browser("wait", ".pick li");
    report.metrics["model.pickerMs"] = ms(opened);
    check((await page(box)) === top, "the editor's box moved when the picker opened");
    check(
      (await page(`document.querySelector(".pick header").textContent.includes("Esc cancels")`)) ===
        true,
      "the picker has no header",
    );
    await capture("model", home, origin);
    // The editor's box filters the pick in place, and the draft waits under it.
    const rows = `document.querySelectorAll(".pick [role=option]").length`;
    const all = Number(await page(rows));
    await browser("fill", "textarea", "zzzz");
    await browser("wait", ".pick .empty");
    await browser("fill", "textarea", "");
    check(Number(await page(rows)) === all, "clearing the filter didn't bring every model back");
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector(".pick")`);
    check(
      (await page(`document.querySelector("textarea").value`)) === "",
      "the draft didn't come back after the picker",
    );
    return "picker opened over a still box, filtered, and closed";
  });

  await journey("roots: start one, the dots follow it, switch, reload, archive", async () => {
    const shownRoot = async () =>
      new URL(text((await browser("get", "url")).url)).searchParams.get("root") ?? "";
    const first = await shownRoot();
    check(first !== "", "the address doesn't name the shown root");
    await browser("fill", "textarea", "/roots");
    await browser("press", "Enter");
    await browser("wait", ".rootsPanel li");
    await capture("roots-one", home, origin);
    await page(`document.querySelector(".rootsPanel header button").click()`);
    await browser(
      "wait",
      "--fn",
      `!new URLSearchParams(location.search).get("root")?.startsWith(${JSON.stringify(first)})`,
    );
    const second = await shownRoot();
    await browser(
      "wait",
      "--fn",
      `!document.querySelector(".rootsPanel") && document.querySelector("textarea")`,
    );
    // A long message streams for a few seconds, long enough to leave the root while it works.
    await browser("fill", "textarea", `second root ${"x".repeat(240)}`);
    await browser("press", "Enter");
    await browser("wait", ".agents .roots .dot.working.here");
    await page("history.back()");
    await browser(
      "wait",
      "--fn",
      `new URLSearchParams(location.search).get("root") === ${JSON.stringify(first)}`,
    );
    await browser("wait", ".agents .roots .dot.done");
    await capture("roots-dots", home, origin);
    await page(`document.querySelector(".agents .roots").click()`);
    await browser("wait", ".rootsPanel li");
    check(
      (await page(`document.querySelectorAll(".rootsPanel li").length`)) === 2,
      "the panel doesn't list both roots",
    );
    await capture("roots", home, origin);
    await page(`document.querySelector(".rootsPanel li:not(.here) .open").click()`);
    await browser(
      "wait",
      "--fn",
      `new URLSearchParams(location.search).get("root") === ${JSON.stringify(second)}`,
    );
    await browser("wait", "--fn", `!document.querySelector(".agents .roots .dot.done")`);
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `document.querySelector(".transcript")?.textContent.includes("second root")`,
    );
    check((await shownRoot()) === second, "the reload didn't come back to the same root");
    await browser("fill", "textarea", "/roots");
    await browser("press", "Enter");
    await browser("wait", ".rootsPanel li");
    await page(
      `document.querySelector(".rootsPanel li:not(.here) .actions button:last-child").click()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector(".rootsPanel [role=status]")?.textContent.startsWith("archived") && document.querySelectorAll(".rootsPanel li").length === 1`,
    );
    await capture("roots-archived", home, origin);
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector(".rootsPanel")`);
    return "started a root, saw it working then done, switched, reloaded into it, archived the other";
  });

  await journey(
    "secrets: an agent asks, the masked form answers, /secrets lists it by name only",
    async () => {
      const value = "smoke-secret-value-42";
      const inPage = () =>
        page(`document.documentElement.outerHTML.includes(${JSON.stringify(value)})`);
      await browser("fill", "textarea", "secret SMOKE_TOKEN");
      await browser("press", "Enter");
      await browser("wait", ".secretRequest");
      check(
        (await page(
          `document.querySelector(".secretRequest").textContent.includes("SMOKE_TOKEN")`,
        )) === true,
        "the request line doesn't name the secret",
      );
      await capture("secret-request", home, origin);
      await page(`document.querySelector(".secretRequest button").click()`);
      await browser("wait", ".secretForm input[type=password]");
      check(
        (await page(`document.activeElement?.type === "password"`)) === true,
        "the form didn't focus its masked field",
      );
      await browser("fill", ".secretForm input[type=password]", value);
      await capture("secret-form", home, origin);
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `!document.querySelector(".secretForm") && !document.querySelector(".secretRequest")`,
      );
      check((await inPage()) === false, "the value stayed in the page after saving");
      // The agent that asked hears it is set, by name.
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".transcript")?.textContent.includes("SMOKE_TOKEN is set")`,
      );
      await browser("fill", "textarea", "/secrets");
      await browser("press", "Enter");
      if ((await page(`!!document.querySelector(".secretsPanel")`)) !== true)
        await browser("press", "Enter");
      await browser("wait", ".secretsPanel li");
      check(
        (await page(
          `document.querySelector(".secretsPanel ul").textContent.includes("SMOKE_TOKEN")`,
        )) === true,
        "/secrets doesn't list the secret",
      );
      await capture("secrets-panel", home, origin);
      check((await inPage()) === false, "the value is in the page");
      await page(`document.querySelector(".secretsPanel header [aria-label=close]").click()`);
      await browser("wait", "--fn", `!document.querySelector(".secretsPanel")`);
      return "a request line, its masked form, the notice to the asker, and /secrets by name; the value never stays in the page";
    },
  );

  await journey(
    "lists: /goals and /jobs open as panels, a row opens its fields; job events fold",
    async () => {
      for (const ask of ["goal", "job"]) {
        const before = await page(`document.querySelectorAll(".assistant:not(.live)").length`);
        await browser("fill", "textarea", ask);
        await browser("press", "Enter");
        await browser(
          "wait",
          "--fn",
          `document.querySelectorAll(".assistant:not(.live)").length > ${String(before)} && !document.querySelector(".tool.running")`,
        );
      }
      const open = async (command: string, selector: string) => {
        await browser("fill", "textarea", command);
        await browser("press", "Enter");
        // The first Enter may take the typeahead's suggestion.
        if ((await page(`!!document.querySelector("${selector}")`)) !== true)
          await browser("press", "Enter");
        await browser("wait", `${selector} li.row`);
      };
      await open("/goals", ".goalsPanel");
      const goal = `document.querySelector(".goalsPanel li.row")`;
      check(
        (await page(`${goal}.textContent.includes("Smoke goal")`)) === true,
        "/goals doesn't list the goal",
      );
      await page(`${goal}.querySelector("button.open").click()`);
      await browser("wait", ".goalsPanel dl");
      check(
        (await page(
          `${goal}.querySelector("dl").textContent.includes("second step") && !${goal}.querySelector(".fresh")`,
        )) === true,
        "an opened goal doesn't show its next steps, or still shows as changed",
      );
      await capture("goals", home, origin);
      await browser("press", "Escape");
      await browser("wait", "--fn", `!document.querySelector(".goalsPanel")`);
      await open("/jobs", ".jobsPanel");
      const job = `document.querySelector(".jobsPanel li.row")`;
      check(
        (await page(
          `${job}.textContent.includes("smoke-job") && ${job}.textContent.includes("@daily")`,
        )) === true,
        "/jobs doesn't list the job with its schedule",
      );
      await page(`${job}.querySelector("button.open").click()`);
      await browser("wait", ".jobsPanel dl");
      check(
        (await page(
          `${job}.querySelector("dl").textContent.includes("echo smoke") && document.querySelector(".jobsPanel .events").textContent.includes("smoke-job")`,
        )) === true,
        "an opened job doesn't show its command, or no recent events",
      );
      await capture("jobs", home, origin);
      await page(`document.querySelector(".jobsPanel header [aria-label=close]").click()`);
      await browser("wait", "--fn", `!document.querySelector(".jobsPanel")`);
      // Its events sit in the transcript as grey boxes folded to one line; a tap opens one.
      const box = `document.querySelector(".transcript .job")`;
      await browser("wait", ".transcript .job");
      check(
        (await page(
          `!${box}.querySelector("pre") && ${box}.textContent.includes("smoke-job") && ${box}.textContent.includes("▸")`,
        )) === true,
        "a job's event isn't a folded box",
      );
      await capture("job-events", home, origin);
      await page(`${box}.querySelector(".row").click()`);
      check(
        (await page(`!!${box}.querySelector("pre")`)) === true,
        "a tap doesn't open the job box",
      );
      await page(`${box}.querySelector(".row").click()`);
      return "listed the goal and the job, opened each, closed by Esc and ✕; its events fold in the transcript";
    },
  );

  await journey(
    "touch: a phone with no Esc, Alt or Ctrl reaches every key by tapping",
    async () => {
      const touch = await touchScreen();
      try {
        await browser("reload");
        // Connected, so the roots are in: the key bar shows before them.
        await browser("wait", ".keys");
        await browser("wait", ".link[data-state=live]");
        check(
          (await page(`matchMedia("(pointer: coarse)").matches`)) === true,
          `no coarse pointer (${String(await page("navigator.maxTouchPoints"))} touch points)`,
        );
        // A phone is offered push once; a dismissal outlives the page.
        await browser("wait", ".offer");
        check(
          (await page(
            `document.querySelector(".offer").textContent.includes("notify this phone")`,
          )) === true,
          "a phone isn't offered push",
        );
        await page(`document.querySelector(".offer [aria-label=close]").click()`);
        check(
          (await page(
            `document.querySelector(".offer") === null && localStorage.getItem("monchu.push")`,
          )) === "offered",
          "a dismissed push offer stayed",
        );

        const value = () => page(`document.querySelector("textarea").value`);
        const key = (label: string) =>
          `[...document.querySelectorAll(".keys button")].find((item) => item.getAttribute("aria-label") === ${JSON.stringify(label)})`;
        const tap = async (expression: string) => {
          check((await page(`!!(${expression})`)) === true, `nothing to tap at ${expression}`);
          await page(`(${expression}).click()`);
        };
        check(
          (await page(
            `(() => { const nav = document.querySelector(".agents"), tab = nav.lastElementChild; return tab.matches(".roots") && Math.abs(tab.getBoundingClientRect().right - nav.getBoundingClientRect().right) < 2 && tab.title.startsWith("second root") && tab.textContent.length < 12; })()`,
          )) === true,
          "the root menu isn't an icon on the right named for the root",
        );

        await browser("fill", "textarea", "a");
        await browser("press", "Enter");
        check((await value()) === "a\n", "Enter on a touch screen didn't add a line");
        await browser("fill", "textarea", "");
        await tap(key("commands"));
        check((await value()) === "/", "the / key didn't start a command");
        await browser("fill", "textarea", "/mod");
        await browser("click", "[role=option]");
        check((await value()) === "/model ", "tapping the suggestion didn't take it");
        await tap(key("send"));
        await browser("wait", ".pick li");
        check(
          (await page(`getComputedStyle(document.querySelector(".pick .hint")).display`)) ===
            "none",
          "the picker shows desktop key hints",
        );
        await capture("touch-pick", home, origin);
        await tap(`document.querySelector(".pick header .icon")`);
        await browser("wait", "--fn", `!document.querySelector(".pick")`);

        // The mode key shows the mode it's in, and a tap switches it.
        await tap(key("follow-up"));
        check(
          (await page(`!!(${key("steer")})`)) === true &&
            (await page(`document.querySelector("textarea").classList.contains("steer")`)) === true,
          "the mode key didn't switch to steer",
        );
        await tap(key("steer"));
        await tap(key("expand all"));
        check(
          (await page(`${key("expand all")}.getAttribute("aria-pressed")`)) === "true",
          "the expand key didn't expand",
        );
        await tap(key("expand all"));

        // A long reply keeps the root busy while the queue fills.
        await browser("fill", "textarea", `busy ${"x".repeat(1600)}`);
        await tap(key("send"));
        await browser("wait", "--fn", `!!(${key("stop")})`);
        await browser("fill", "textarea", "queued one");
        await tap(key("send"));
        await browser("wait", ".queue li .text");
        await tap(`document.querySelector(".queue li .text")`);
        check((await value()) === "queued one", "tapping the queued message didn't open it");
        check(
          (await page(`!!(${key("leave the edit")}) && !!(${key("save")})`)) === true,
          "no edit keys",
        );
        await capture("touch-edit", home, origin);
        await browser("fill", "textarea", "queued two");
        await tap(key("save"));
        await browser(
          "wait",
          "--fn",
          `document.querySelector(".queue li")?.textContent.includes("queued two")`,
        );
        check((await value()) === "", "saving the edit didn't bring the draft back");
        await tap(`document.querySelector(".queue li button[aria-label*='make it']")`);
        await browser("wait", ".queue li.steer");
        await tap(`document.querySelector(".queue li button[aria-label='delete it']")`);
        await browser("wait", "--fn", `!document.querySelector(".queue")`);
        await browser("fill", "textarea", "queued three");
        await tap(key("send"));
        await browser("wait", ".queue li");
        await tap(key("stop"));
        await browser("wait", "--fn", `!(${key("stop")}) && !document.querySelector(".queue")`);
        check((await value()) === "queued three", "stopping didn't put the queued message back");
        await browser("fill", "textarea", "");
        await capture("touch-keys", home, origin);
        return "Enter adds a line; / starts a command; send, the picker's close, steer, expand, queue edit, mode, delete and stop all by tap";
      } finally {
        touch.close();
      }
    },
  );

  await journey("compact: /compact ends with a line saying the context was compacted", async () => {
    for (const message of ["before compacting", "and once more"]) {
      await browser("fill", "textarea", message);
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes(${JSON.stringify(message)}))`,
      );
    }
    await browser("fill", "textarea", "/compact");
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `document.querySelector(".transcript")?.textContent.includes("context compacted")`,
    );
    check(
      (await page(
        `[...document.querySelectorAll(".transcript > *")].at(-1)?.textContent.includes("context compacted")`,
      )) === true,
      "the compaction line isn't the transcript's last",
    );
    await capture("compact", home, origin);
    return "the root's compaction showed as its last line";
  });

  await journey(
    "worker: a delegated worker gets a tab, its report a card, its view a tap",
    async () => {
      await browser("fill", "textarea", "work reader check the docs");
      await browser("press", "Enter");
      const card = `[...document.querySelectorAll(".card.report")].find((item) => item.querySelector("header b")?.textContent === "reader")`;
      await browser("wait", "--fn", `!!(${card}) && !document.querySelector(".live")`);
      check(
        (await page(`${card}.textContent.includes("Faux worker result")`)) === true,
        "the report card doesn't carry the worker's result",
      );
      check(
        (await page(`!!${card}.querySelector("header .stamp .prefix")`)) === true,
        "the report card has no short id",
      );
      const tab = `[...document.querySelectorAll(".agents .tabs button")].find((item) => item.textContent.includes("reader"))`;
      check((await page(`!!(${tab})`)) === true, "no tab for the worker");
      await capture("worker-report", home, origin);
      const opened = performance.now();
      await page(`(${tab}).click()`);
      await browser(
        "wait",
        "--fn",
        `(${tab}).classList.contains("on") && document.querySelector(".transcript")?.textContent.includes("check the docs")`,
      );
      report.metrics["worker.viewMs"] = ms(opened);
      await capture("worker-view", home, origin);
      await page(`document.querySelector(".agents .tabs button").click()`);
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".agents .tabs button").classList.contains("on") && !!(${card})`,
      );
      // /agents lists it with its state, idle time and context.
      await browser("fill", "textarea", "/agents");
      await browser("press", "Enter");
      const row = `[...document.querySelectorAll(".pick [role=option]")].find((item) => item.querySelector("b")?.textContent === "reader")`;
      await browser("wait", "--fn", `!!(${row})`);
      const tags = text(
        await page(`[...(${row}).querySelectorAll(".tag")].map((tag) => tag.textContent).join("")`),
      );
      check(
        /idle \d+[smhd]/.test(tags) && /\d+%/.test(tags),
        `/agents row lacks idle time or context: ${tags}`,
      );
      await capture("agents", home, origin);
      await browser("press", "Escape");
      await browser("wait", "--fn", `!document.querySelector(".pick")`);
      return "a tab for reader, its report folded into a card with its id, its own view and back; /agents shows it idle with its context";
    },
  );

  await journey(
    "login: /login lists the providers and Esc cancels without signing in",
    async () => {
      await browser("fill", "textarea", "/login");
      await browser("press", "Enter");
      if ((await page(`!!document.querySelector(".pick li")`)) !== true)
        await browser("press", "Enter");
      await browser("wait", ".pick li");
      check(
        (await page(`document.querySelector(".pick header").textContent.includes("provider")`)) ===
          true,
        "the picker doesn't ask for a provider",
      );
      const providers = Number(await page(`document.querySelectorAll(".pick li").length`));
      check(providers > 1, `only ${providers} provider to pick`);
      await capture("login", home, origin);
      await browser("press", "Escape");
      await browser(
        "wait",
        "--fn",
        `!document.querySelector(".pick") && !document.querySelector(".login") && document.querySelector("textarea")`,
      );
      return `${providers} providers offered; Esc left with no sign-in started`;
    },
  );

  await journey(
    "login: an API key typed in the masked box signs in and is saved, through a dropped connection",
    async () => {
      await browser("fill", "textarea", "/login");
      await browser("press", "Enter");
      if ((await page(`!!document.querySelector(".pick li")`)) !== true)
        await browser("press", "Enter");
      await browser("wait", ".pick li");
      const at = Number(
        await page(
          `[...document.querySelectorAll(".pick li")].findIndex((item) => item.textContent.includes("OpenCode Go")) + 1`,
        ),
      );
      check(at > 0, "OpenCode Go isn't offered");
      await browser("click", `.pick li:nth-child(${at}) .enter`);
      await browser("wait", "form.ask input[type=password]");
      await capture("login-key", home, origin);
      const key = `sk-web-check-${randomBytes(12).toString("hex")}`;
      await browser("type", "form.ask input", key);
      await capture("login-key-typed", home, origin);
      // A phone drops the page's socket when it leaves to fetch the key; the login waits for it to come back.
      await page(
        `(() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { window.dropMe = this; return send.call(this, data); }; return true; })()`,
      );
      await browser("wait", "--fn", "!!window.dropMe");
      const reconnects = async () => (await logRecords(home, "web", "reconnected")).length;
      const before = await reconnects();
      await page(`window.dropMe.close()`);
      for (let waited = 0; (await reconnects()) === before; waited += 100) {
        check(waited < 15_000, "the page didn't reconnect");
        await browser("wait", "100");
      }
      check(
        (await page(`!!document.querySelector("form.ask input[type=password]")`)) === true,
        "the key prompt closed with the connection",
      );
      await browser("focus", "form.ask input");
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `!document.querySelector("form.ask") && !document.querySelector(".login")`,
      );
      const notices = text(await page(`document.querySelector(".transcript").textContent`));
      check(
        notices.includes("logged in · opencode-go"),
        `no sign-in notice: ${notices.slice(-200)}`,
      );
      const saved: unknown = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      const entry = isData(saved) ? saved["opencode-go"] : undefined;
      check(isData(entry) && entry.key === key, "auth.json doesn't hold the typed key");
      return "the connection dropped under the prompt; OpenCode Go took the key after it and auth.json holds it";
    },
  );

  await journey(
    "inbox: an ask is boxed, filters by kind and goal with its briefer, a tapped id starts a reply, and #id links to it",
    async () => {
      const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
      const send = async (text: string) => {
        const before = Number(await page(replies));
        await browser("fill", "textarea", text);
        await browser("press", "Enter");
        await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
      };
      await send("goal");
      await send("ship the smoke check now");
      // The newest stamp is the reply's, below the message it answers.
      const id = text(
        await page(`[...document.querySelectorAll(".meta .stamp[id]")].at(-1)?.id.slice(2)`),
      );
      check(/^[k-z]{4,8}$/.test(id), `no message id: ${id}`);
      await send(`label ${id} ask smoke`);
      await browser("wait", "--fn", `!!document.querySelector(".askCard .reply")`);
      check(
        (await page(`document.querySelector(".filters .yellow")?.textContent`)) === "asks 1",
        "the filter bar doesn't count the open ask",
      );
      await capture("inbox-ask", home, origin);
      await browser("click", ".filters button:nth-child(2)");
      check(
        (await page(`document.querySelectorAll(".transcript .user").length`)) === 0 &&
          (await page(`document.querySelectorAll(".transcript .assistant").length`)) === 1,
        "the asks filter shows more than the ask",
      );
      // A filtered message's id is a tap away from a reply, as in every filter.
      await browser("click", ".askCard .stamp .code");
      check(
        (await page(`document.querySelector("textarea").value`)) === `/reply ${id} `,
        "tapping the id didn't draft /reply with it",
      );
      await browser("fill", "textarea", "");
      // A kind with nothing in it says so, and never shows the front's live status.
      await browser("click", ".filters button:nth-child(3)");
      check(
        (await page(
          `document.querySelector(".transcript .status")?.textContent.includes("nothing here yet")`,
        )) === true,
        "an empty filter doesn't say it is empty",
      );
      await browser("click", ".filters button:nth-child(3)");
      await browser("click", ".filters .goal");
      await browser("wait", "--fn", `!!document.querySelector(".pick")`);
      await browser("click", ".pick li:nth-child(2) .enter");
      await browser("wait", "--fn", `!!document.querySelector(".brief")`);
      check(
        (await page(`document.querySelector(".brief").textContent.includes("Smoke goal")`)) ===
          true,
        "the goal briefer is missing",
      );
      await capture("inbox-goal", home, origin);
      await browser("click", ".filters button:first-child");
      await browser("click", ".askCard .reply");
      check(
        (await page(`document.querySelector("textarea").value`)) === `/reply ${id} `,
        "reply didn't draft /reply with the id",
      );
      await browser("fill", "textarea", `/reply ${id} yes, ship it`);
      await browser("press", "Enter");
      await browser("wait", "--fn", `!!document.querySelector(".askCard.answered")`);
      await send(`see #${id}`);
      await browser("wait", "--fn", `!!document.querySelector(".assistant a.ref")`);
      await browser("click", ".assistant a.ref");
      await capture("inbox-replied", home, origin);
      return `ask ${id} boxed, filtered, replied to by its id and linked`;
    },
  );

  await journey(
    "restart: /restart brings the page back connected on the same transcript",
    async () => {
      const replies = `document.querySelectorAll(".assistant:not(.live)").length`;
      const sent = Number(await page(replies));
      await browser("fill", "textarea", "before restart");
      await browser("press", "Enter");
      await browser("wait", "--fn", `${replies} > ${sent} && !document.querySelector(".live")`);
      const asked = performance.now();
      await browser("fill", "textarea", "/restart");
      await browser("press", "Enter");
      if ((await page(`document.querySelector("textarea").value`)) !== "")
        await browser("press", "Enter");
      await browser("wait", "--fn", `document.querySelector(".link")?.dataset.state !== "live"`);
      await browser("wait", "--fn", `document.querySelector(".link")?.dataset.state === "live"`);
      report.metrics["restart.backMs"] = ms(asked);
      check(
        (await page(
          `document.querySelector(".transcript").textContent.includes("before restart")`,
        )) === true,
        "the transcript before the restart is gone",
      );
      const before = Number(await page(replies));
      await browser("fill", "textarea", "after restart");
      await browser("press", "Enter");
      await browser("wait", "--fn", `${replies} > ${before} && !document.querySelector(".live")`);
      await capture("restart", home, origin);
      return `back and answering in ${report.metrics["restart.backMs"]} ms`;
    },
  );

  await journey(
    "typing: keystrokes keep up on a long transcript, also while a reply streams",
    typing,
  );

  const errors = list((await browser("errors")).errors);
  const logged = list((await browser("console")).messages).filter(
    (item) => isData(item) && item.type === "error",
  );
  gate(
    "no page or console errors",
    errors.length + logged.length === 0,
    [...errors, ...logged]
      .map((item) => (isData(item) ? text(item.text).split("\n")[0] : ""))
      .join("; ") || "none",
  );
  const ready = await readyTimes(home);
  if (ready[0] !== undefined) report.metrics["page.readyColdMs"] = ready[0];
  if (ready[1] !== undefined) report.metrics["page.readyWarmMs"] = ready[1];

  // Last, since a server that goes away fills the console with failed connections.
  await journey(
    "link: the server goes away and comes back; the page redials in place, and after it gave up reloads once",
    async () => {
      const dot = (state: string) =>
        `document.querySelector('.link[data-state="${state}"]') !== null`;
      const mark = () => page("window.webCheckMark");
      // Past agent-browser's own 25 s wait: the redial window alone is 30 s.
      const until = async (expression: string, ms: number) => {
        const deadline = performance.now() + ms;
        while ((await page(expression).catch(() => false)) !== true) {
          if (performance.now() > deadline)
            throw new Error(`not within ${ms / 1000} s: ${expression}`);
          await new Promise((done) => setTimeout(done, 1000));
        }
      };
      await page("window.webCheckMark = 1");
      // A short outage: the page redials and carries on, the same page.
      await server.stop();
      await browser("wait", "--fn", `${dot("lost")} || ${dot("gone")}`);
      await new Promise((done) => setTimeout(done, 5000));
      await server.start();
      await browser("wait", "--fn", dot("live"));
      check((await mark()) === 1, "the page reloaded for a short outage");
      await browser("fill", "textarea", "after the outage");
      await browser("press", "Enter");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes("after the outage"))`,
      );
      // A long one: past the redial window the page gives up, says why and waits, never reloading while it's down.
      await server.stop();
      await until(dot("gone"), 90_000);
      await new Promise((done) => setTimeout(done, 15_000));
      check((await mark()) === 1, "the page reloaded while the server was down");
      check(
        text(await page(`document.querySelector(".link")?.textContent`)).includes("disconnected"),
        "the page doesn't say it's disconnected",
      );
      await server.start();
      // Back up: one fresh page, which connects.
      await until(`window.webCheckMark === undefined && ${dot("live")}`, 90_000);
      await browser(
        "wait",
        "--fn",
        `document.querySelector(".transcript")?.textContent.includes("after the outage")`,
      );
      await capture("link", home, origin);
      return "redialled a 5 s outage in place; past the redial window it said so, waited without reloading, and reloaded once the server answered";
    },
  );

  await journey(
    "outdated: a core on newer contracts makes the open page load the new release at once",
    async () => {
      const root = await nextRelease();
      try {
        const script = () => page(`document.querySelector("script[src]")?.getAttribute("src")`);
        const before = text(await script());
        await page("window.webCheckMark = 1");
        await browser(
          "wait",
          "--fn",
          `document.querySelector('.link[data-state="live"]') !== null`,
        );
        await server.stop();
        await server.start(root);
        const back = performance.now();
        // Told upgrade_required, the page reloads into the new bundle; redialling the old contract would take 30 s.
        const deadline = back + 10_000;
        while ((await page("window.webCheckMark").catch(() => 1)) === 1) {
          if (performance.now() > deadline)
            throw new Error("the page didn't reload within 10 s of a newer core answering");
          await new Promise((done) => setTimeout(done, 250));
        }
        const reloadMs = ms(back);
        await browser(
          "wait",
          "--fn",
          `document.querySelector('.link[data-state="live"]') !== null`,
        );
        const after = text(await script());
        check(after !== "" && after !== before, `the page kept its bundle (${before})`);
        await browser("fill", "textarea", "on the new release");
        await browser("press", "Enter");
        await browser(
          "wait",
          "--fn",
          `[...document.querySelectorAll(".assistant:not(.live)")].some((item) => item.textContent.includes("on the new release"))`,
        );
        return `reloaded ${reloadMs} ms after the newer core answered, from ${before} to ${after}, and answers`;
      } finally {
        await server.stop();
        await server.start();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

/** Lower is better for every metric; a regression is past noise for its kind. */
function worse(key: string, before: number, after: number): boolean {
  // Keystrokes take tens of milliseconds, so half again as long is past their noise.
  if (key.startsWith("typing.") && key.endsWith("Ms"))
    return after > before * 1.5 && after - before > 10;
  if (key.endsWith("Ms")) return after > before * 1.25 && after - before > 50;
  if (key.endsWith("Bytes")) return after > before * 1.02;
  return after > before + 0.01;
}

function summarize(baseline: Report | undefined, spread: Record<string, string>): string {
  const lines = [
    `# web-check · ${report.viewport}${report.runs > 1 ? ` · median of ${report.runs} runs` : ""}`,
    "",
  ];
  const failed = report.gates.filter((item) => !item.ok);
  lines.push(
    failed.length === 0
      ? `gates: all ${report.gates.length} pass`
      : `gates: ${failed.length} of ${report.gates.length} FAIL`,
  );
  for (const item of report.gates)
    lines.push(`- ${item.ok ? "ok" : "FAIL"} ${item.name}: ${item.detail}`);
  lines.push("", baseline === undefined ? "metrics:" : "metrics (baseline → now):");
  for (const [key, value] of Object.entries(report.metrics)) {
    const before = baseline?.metrics[key];
    const range = spread[key] === undefined ? "" : ` [${spread[key]}]`;
    if (before === undefined) lines.push(`- ${key} ${value}${range}`);
    else {
      const change =
        before === 0
          ? ""
          : ` (${value >= before ? "+" : ""}${Math.round(((value - before) / before) * 100)}%)`;
      lines.push(
        `- ${key} ${before} → ${value}${change}${range}${worse(key, before, value) ? " WORSE" : ""}`,
      );
    }
  }
  lines.push("", "screens:");
  for (const [name, screen] of Object.entries(report.screens)) {
    const violations = screen.violations
      .map(
        (item) =>
          `${item.id} (${item.impact}${item.impact === "moderate" || item.impact === "minor" ? "" : ` at ${item.targets.join(", ")}`})`,
      )
      .join(", ");
    const parts = [`a11y ${screen.violations.length}${violations ? `: ${violations}` : ""}`];
    if (screen.mismatchPct !== undefined) parts.push(`pixels ${screen.mismatchPct}% changed`);
    if (screen.added !== undefined && screen.removed !== undefined)
      parts.push(`snapshot +${screen.added.length} −${screen.removed.length}`);
    const layout = screen.layout;
    if (layout !== undefined) {
      const faults = [
        [layout.smallTargets, `under ${TARGET_PX} px and crowded`],
        [layout.overlaps, "overlapping"],
      ] as const;
      for (const [found, what] of faults)
        if (found.length > 0)
          parts.push(
            `${found.length} ${what}: ${found.slice(0, 4).join(", ")}${found.length > 4 ? ", …" : ""}`,
          );
    }
    lines.push(`- ${name}: ${parts.join(" · ")}`);
    for (const line of (screen.removed ?? []).slice(0, 12)) lines.push(`  - \`− ${line.trim()}\``);
    for (const line of (screen.added ?? []).slice(0, 12)) lines.push(`  - \`+ ${line.trim()}\``);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The accessibility gate is against the baseline: no violation its same screen didn't have. Existing ones are listed in
 * the summary for whoever fixes them, so the gate holds the line without failing on known debt.
 */
function auditGates(baseline: Report | undefined): void {
  for (const [name, screen] of Object.entries(report.screens)) {
    const known = baseline?.screens[name];
    if (known === undefined) continue;
    const fresh = screen.violations.filter(
      (item) => !known.violations.some((old) => old.id === item.id),
    );
    gate(
      `${name}: no new a11y violations`,
      fresh.length === 0,
      fresh.map((item) => `${item.id} at ${item.targets.join(", ")}`).join("; ") || "none",
    );
  }
}

if (OUT === BASELINE) throw new Error("--out and --baseline must be different directories");
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const baseline = await readBaseline();
if (BASELINE !== undefined && baseline === undefined)
  console.log(`web-check · no report in ${BASELINE}; running without a baseline`);

/** One pass of every journey on a fresh home and core, adding its gates and metrics to the report. */
async function run(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "monchu-smoke-"));
  const idp = await identityProvider();
  let core: ChildProcess | undefined;
  try {
    const port = await freePort();
    core = await startCore(home, port, idp.issuer);
    await journeys(`http://127.0.0.1:${port}/`, home, `127.0.0.1:${port}`, {
      stop: async () => {
        if (core !== undefined) await stopCore(core);
      },
      start: async (root?: string) => {
        core = await startCore(home, port, idp.issuer, root);
      },
    });
  } catch (error) {
    gate("run", false, error instanceof Error ? error.message : String(error));
  } finally {
    await browser("close").catch(() => undefined);
    if (core !== undefined) await stopCore(core);
    idp.server.close();
    await rm(home, { recursive: true, force: true });
  }
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

try {
  await bundle();
} catch (error) {
  gate(
    "web build within its budget",
    false,
    error instanceof Error ? error.message : String(error),
  );
}
// Every run's gates, merged by name: one fails if any run failed it. Screens keep the last run's captures.
const built = { gates: report.gates, metrics: report.metrics };
const gates = new Map(built.gates.map((item) => [item.name, item]));
const samples = new Map<string, number[]>();
if (built.gates.every((item) => item.ok))
  for (let at = 1; at <= RUNS; at++) {
    report.gates = [];
    report.metrics = {};
    await run();
    for (const item of report.gates) {
      const seen = gates.get(item.name);
      const where = RUNS > 1 ? ` (run ${at} of ${RUNS})` : "";
      if (seen === undefined)
        gates.set(item.name, { ...item, detail: item.detail + (item.ok ? "" : where) });
      else if (seen.ok && !item.ok) gates.set(item.name, { ...item, detail: item.detail + where });
    }
    for (const [key, value] of Object.entries(report.metrics))
      samples.set(key, [...(samples.get(key) ?? []), value]);
  }
report.gates = [...gates.values()];
report.metrics = { ...built.metrics };
const spread: Record<string, string> = {};
for (const [key, values] of samples) {
  report.metrics[key] = Math.round(median(values) * 1000) / 1000;
  if (values.length > 1) spread[key] = `${Math.min(...values)}–${Math.max(...values)}`;
}
// Layout faults over every screen, as tracked metrics: deterministic, so any rise counts.
const screens = Object.values(report.screens);
for (const key of ["smallTargets", "overlaps"] as const)
  report.metrics[`layout.${key}`] = screens.reduce(
    (sum, screen) => sum + (screen.layout?.[key].length ?? 0),
    0,
  );
auditGates(baseline);
const summary = summarize(baseline, spread);
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(OUT, "summary.md"), summary);
process.stdout.write(summary);
if (report.gates.some((item) => !item.ok)) process.exitCode = 1;
