/**
 * Monchu's structured log: JSON Lines in the OpenTelemetry log data model, one file per day under `<home>/logs/`,
 * rolled at 10 MB and kept 14 days. Records carry ids, sizes and timings, never prompts, outputs or secrets. Writes are
 * appended in order and never throw: a broken log never stops Monchu.
 */
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogAttributes, LogQuery, LogRecord, LogScope, Severity } from "../api/logs.ts";

const ROLL_BYTES = 10 * 1024 * 1024;
const KEEP_DAYS = 14;
const FILE = /^monchu-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

function severityOf(value: unknown): Severity {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function attributesOf(value: unknown): LogAttributes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const attributes: LogAttributes = {};
  for (const [key, entry] of Object.entries(value)) {
    const item: unknown = entry;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      attributes[key] = item;
  }
  return attributes;
}

/** One line of a log file, or `undefined` for anything that isn't a record. */
function parseRecord(line: string): LogRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = Object.fromEntries(Object.entries(value));
  if (typeof fields.time !== "string" || typeof fields.body !== "string") return undefined;
  const attributes = attributesOf(fields.attributes);
  return {
    time: fields.time,
    severity: severityOf(fields.severity),
    scope: typeof fields.scope === "string" ? fields.scope : "core",
    body: fields.body,
    ...(attributes === undefined ? {} : { attributes }),
  };
}

export class Log {
  readonly directory: string;
  private writing: Promise<void> = Promise.resolve();
  private part = 0;
  private day = "";

  constructor(home: string) {
    this.directory = join(home, "logs");
  }

  /** Append one record, in order with the others. Never throws. */
  write(severity: Severity, scope: LogScope, body: string, attributes?: LogAttributes): void {
    const now = new Date();
    const record: LogRecord = {
      time: now.toISOString(),
      severity,
      scope,
      body,
      ...(attributes === undefined ? {} : { attributes }),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.writing = this.writing
      .then(async () => {
        const day = record.time.slice(0, 10);
        if (day !== this.day) {
          this.day = day;
          this.part = 0;
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await this.prune(now);
        }
        const size = (await stat(this.file()).catch(() => undefined))?.size ?? 0;
        if (size > ROLL_BYTES) this.part += 1;
        await appendFile(this.file(), line, { mode: 0o600 });
      })
      .catch(() => {});
  }

  /** Resolves once every record written so far is on disk. */
  flushed(): Promise<void> {
    return this.writing;
  }

  /** The newest records, oldest first, optionally only at or above a severity and under a scope prefix. */
  async tail(options: LogQuery): Promise<LogRecord[]> {
    await this.flushed();
    const ranks: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const least = ranks[options.severity ?? "debug"];
    const files = (await readdir(this.directory).catch(() => []))
      .filter((name) => FILE.test(name))
      .sort(byAge)
      .reverse();
    const found: LogRecord[] = [];
    for (const name of files) {
      const lines = (await readFile(join(this.directory, name), "utf8").catch(() => "")).split(
        "\n",
      );
      for (const line of lines.toReversed()) {
        const record = line ? parseRecord(line) : undefined;
        if (record === undefined || ranks[record.severity] < least) continue;
        if (options.scope !== undefined && !record.scope.startsWith(options.scope)) continue;
        found.push(record);
        if (found.length >= options.limit) return found.toReversed();
      }
    }
    return found.toReversed();
  }

  private file(): string {
    return join(
      this.directory,
      `monchu-${this.day}${this.part === 0 ? "" : `.${this.part}`}.jsonl`,
    );
  }

  /** Drop files older than the kept days, and resume today's newest part. */
  private async prune(now: Date): Promise<void> {
    const oldest = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const name of await readdir(this.directory).catch(() => [])) {
      const match = FILE.exec(name);
      if (match === null) continue;
      const [, day = "", part = "0"] = match;
      if (day < oldest) await rm(join(this.directory, name), { force: true });
      else if (day === this.day) this.part = Math.max(this.part, Number(part));
    }
  }
}

/** Files in write order: by day, then part. */
function byAge(a: string, b: string): number {
  const [, dayA = "", partA = "0"] = FILE.exec(a) ?? [];
  const [, dayB = "", partB = "0"] = FILE.exec(b) ?? [];
  return dayA === dayB ? Number(partA) - Number(partB) : dayA < dayB ? -1 : 1;
}
