/**
 * The bundled fnox plugin: keeps the home's secret values in [fnox](https://fnox.jdx.dev) under Monchu's own config in
 * `<home>/secrets/` (an age provider with a key it makes for this device), so they never reach the user's shell
 * environment, and fnox never reads the user's own secrets. Monchu keeps the names; this plugin only stores values.
 * Another fnox provider in that `fnox.toml` (1Password, a keychain) works too; another store altogether is a plugin
 * of its own, with this one turned off in `plugins.local.json`.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, type SecretStore } from "../../plugin.ts";

/** Thrown messages never carry a value: a failing fnox's own words are kept only with every value removed. */
function quiet(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value !== "") out = out.split(value).join("[secret]");
  const line = out.split(/\r?\n/).find((each) => each.trim() !== "") ?? "";
  return line.trim().slice(0, 200);
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (const [bit, generator] of GENERATOR.entries()) if ((top >>> bit) & 1) check ^= generator;
  }
  return check >>> 0;
}

/** BIP 173 bech32, as age writes its keys. */
function bech32(prefix: string, data: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const expanded = Array.from(Buffer.from(prefix, "ascii"));
  const mod =
    polymod([
      ...expanded.map((code) => code >>> 5),
      0,
      ...expanded.map((code) => code & 31),
      ...words,
      0,
      0,
      0,
      0,
      0,
      0,
    ]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (mod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((word) => BECH32[word] ?? "").join("")}`;
}

/** A new age X25519 identity and its recipient, made with Node alone, so no `age-keygen` is needed. */
export function ageIdentity(): { identity: string; recipient: string } {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.d === undefined || jwk.x === undefined) throw new Error("Could not make an age key");
  return {
    identity: bech32("age-secret-key-", Buffer.from(jwk.d, "base64url")).toUpperCase(),
    recipient: bech32("age", Buffer.from(jwk.x, "base64url")),
  };
}

/** A TOML basic string: JSON's escapes are TOML's. */
const toml = (text: string) => JSON.stringify(text);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * fnox under Monchu's own config: `FNOX_CONFIG_DIR` points at the secrets folder, so fnox's global config is never the
 * user's, and the working directory is that folder, so no project's `fnox.toml` joins in. Values go in on stdin.
 */
export class FnoxStore implements SecretStore {
  private readonly dir: string;
  private readonly config: string;
  constructor(dir: string) {
    this.dir = dir;
    this.config = join(dir, "fnox.toml");
  }

  /** The folder, the device's age key and fnox's config, made on first use; an existing config is used as it is. */
  private async ready(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    if (await exists(this.config)) return;
    const key = join(this.dir, "age.txt");
    const { identity, recipient } = ageIdentity();
    await writeAtomic(
      key,
      `# Monchu's secrets key for this device. Never share or sync it.\n${identity}\n`,
    );
    await writeAtomic(
      this.config,
      [
        "# Monchu's secrets on this device: values are age-encrypted with age.txt beside this file.",
        "# Another fnox provider (1password, keychain, ...) works too: Monchu stores with provider `monchu`.",
        "[providers.monchu]",
        'type = "age"',
        `recipients = [${toml(recipient)}]`,
        `key_file = ${toml(key)}`,
        "",
        "[secrets]",
        "",
      ].join("\n"),
    );
  }

  private run(args: readonly string[], input = ""): Promise<string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && !name.startsWith("FNOX_")) env[name] = value;
    env.FNOX_CONFIG_DIR = this.dir;
    const argv = [
      "--config",
      this.config,
      "--profile",
      "default",
      "--no-daemon",
      "--non-interactive",
      ...args,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("fnox", argv, { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === "ENOENT"
              ? "fnox is not installed or not on PATH here; the fnox plugin keeps secrets with it (https://fnox.jdx.dev)"
              : `fnox could not start (${error.code ?? "error"})`,
          ),
        ),
      );
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `fnox ${args[0] ?? ""} failed (exit ${code ?? "signal"}): ${quiet(stderr, [input])}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  async write(key: string, value: string): Promise<void> {
    await this.ready();
    // fnox 1.39 stores no value when `set` also gets a description: descriptions live in Monchu's index.
    await this.run(["set", key, "--provider", "monchu"], value);
  }

  async remove(key: string): Promise<void> {
    if (!(await exists(this.config))) return;
    await this.run(["remove", key]).catch((error: unknown) => {
      // Already gone is what removing wants.
      if (!(error instanceof Error && /not[ _]found/i.test(error.message))) throw error;
    });
  }

  async readAll(): Promise<Record<string, string>> {
    if (!(await exists(this.config))) return {};
    const text = await this.run(["export", "--format", "json"]);
    const parsed: unknown = JSON.parse(text);
    const values: Record<string, string> = {};
    const secrets =
      typeof parsed === "object" && parsed !== null && "secrets" in parsed
        ? parsed.secrets
        : undefined;
    if (typeof secrets === "object" && secrets !== null)
      for (const [key, value] of Object.entries(secrets))
        if (typeof value === "string") values[key] = value;
    return values;
  }
}

export default definePlugin((monchu) => {
  monchu.registerSecretStore(new FnoxStore(join(monchu.home, "secrets")));
});
