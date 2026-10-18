/**
 * Locking adapted from Pi's auth-storage.ts.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** auth.json is an untrusted boundary. OAuth's additional provider fields are part of pi-ai's contract. */
function parseCredentials(raw: string): Map<string, Credential> {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // JSON parse errors can include credential text. Do not propagate them or attach them as causes.
    throw new Error("Invalid Monchu auth.json");
  }
  if (!isObject(value)) throw new Error("Invalid Monchu auth.json");
  const data = new Map<string, Credential>();
  for (const [id, entry] of Object.entries(value)) {
    if (!isObject(entry)) throw new Error("Invalid Monchu auth.json credential");
    if (entry.type === "oauth") {
      const { access, refresh, expires } = entry;
      if (
        typeof access !== "string" ||
        typeof refresh !== "string" ||
        typeof expires !== "number" ||
        !Number.isFinite(expires)
      )
        throw new Error("Invalid Monchu auth.json OAuth credential");
      data.set(id, { ...entry, type: "oauth", access, refresh, expires });
    } else if (entry.type === "api_key") {
      if (entry.key !== undefined && typeof entry.key !== "string")
        throw new Error("Invalid Monchu auth.json API key");
      const env = new Map<string, string>();
      if (entry.env !== undefined) {
        if (!isObject(entry.env)) throw new Error("Invalid Monchu auth.json environment");
        for (const [name, text] of Object.entries(entry.env)) {
          if (typeof text !== "string") throw new Error("Invalid Monchu auth.json environment");
          env.set(name, text);
        }
      }
      data.set(id, {
        type: "api_key",
        ...(entry.key === undefined ? {} : { key: entry.key }),
        ...(entry.env === undefined ? {} : { env: Object.fromEntries(env) }),
      });
    } else throw new Error("Invalid Monchu auth.json credential type");
  }
  return data;
}

/** One locked read-modify-write path, including OAuth refresh. No cached credentials or ambient Pi files. */
export class FileCredentials implements CredentialStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.withLock(async (data) => data.get(id), options);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.withLock(
      async (data) =>
        [...data].map(([providerId, credential]) => ({ providerId, type: credential.type })),
      options,
    );
  }

  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.withLock(async (data, checkLock) => {
      const next = await fn(data.get(id));
      checkLock();
      if (next !== undefined) {
        data.set(id, next);
        await this.persist(data, checkLock);
      }
      return data.get(id);
    }, options);
  }

  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    await this.withLock(async (data, checkLock) => {
      if (data.delete(id)) await this.persist(data, checkLock);
    }, options);
  }

  private async persist(
    data: ReadonlyMap<string, Credential>,
    checkLock: () => void,
  ): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(Object.fromEntries(data), null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // Windows readers/antivirus can briefly deny replacement. Retry the same complete file;
      // never unlink auth.json or expose a partially written credential store.
      const deadline = Date.now() + 5000;
      let retry = 0;
      for (;;) {
        checkLock();
        try {
          await rename(temporary, this.path);
          break;
        } catch (error) {
          const remaining = deadline - Date.now();
          if (
            process.platform !== "win32" ||
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
            ) ||
            remaining <= 0
          )
            throw error;
          await sleep(Math.min(10 * 2 ** retry++, 100, remaining));
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withLock<T>(
    fn: (data: Map<string, Credential>, checkLock: () => void) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30_000;
    let retry = 0;
    let compromised: Error | undefined;
    const checkLock = () => {
      if (compromised !== undefined) throw compromised;
    };
    let release: () => Promise<void>;
    while (true) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, {
          realpath: false,
          retries: 0,
          stale: 30_000,
          onCompromised: (error) => {
            compromised = error;
          },
        });
        break;
      } catch (error) {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        // On Windows, creating the lock directory while another caller removes it fails with EPERM: also contention.
        const busy =
          error instanceof Error &&
          "code" in error &&
          (error.code === "ELOCKED" || (process.platform === "win32" && error.code === "EPERM"));
        if (!busy || remaining <= 0) throw error;
        await sleep(Math.min(10 * 2 ** retry++, 1000, remaining), undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      checkLock();
      let data: Map<string, Credential>;
      try {
        data = parseCredentials(await readFile(this.path, "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        data = new Map();
        checkLock();
        await this.persist(data, checkLock);
      }
      signal?.throwIfAborted();
      checkLock();
      await chmod(this.path, 0o600);
      signal?.throwIfAborted();
      checkLock();
      // Once fn starts, finish its write even if the caller cancels: refresh may already have rotated a token.
      const result = await fn(data, checkLock);
      checkLock();
      return result;
    } finally {
      await release();
    }
  }
}
