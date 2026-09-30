import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  session?: string | null;
  project?: string;
  tool: string;
  target?: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

/**
 * Append-only JSONL audit log stored in the project directory (outside the
 * sandbox), one JSON object per tool call.
 */
export class AuditLog {
  private filePath: string;
  private ready = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureDir(): void {
    if (this.ready) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.ready = true;
  }

  write(entry: AuditEntry): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Auditing must never break tool execution.
    }
  }
}

/** Wrap a tool handler with timing + audit. */
export async function audited<T extends { isError?: boolean }>(
  log: AuditLog,
  tool: string,
  target: string | undefined,
  session: string | null,
  project: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    log.write({
      ts: new Date().toISOString(),
      session,
      project,
      tool,
      target,
      ok: !result?.isError,
      ms: Date.now() - t0,
    });
    return result;
  } catch (e) {
    log.write({
      ts: new Date().toISOString(),
      session,
      project,
      tool,
      target,
      ok: false,
      ms: Date.now() - t0,
      detail: (e as Error).message?.slice(0, 300),
    });
    throw e;
  }
}
