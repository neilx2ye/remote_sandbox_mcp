import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProjectScope } from "../src/projects.js";
import { createServer } from "../src/server.js";
import { AuditLog } from "../src/util/audit.js";

export function makeTempDir(prefix = "rsb-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a project-level scope for tool tests (previously makeConfig). */
export function makeConfig(root: string, overrides: Partial<ProjectScope> = {}): ProjectScope {
  return {
    root: fs.realpathSync(root),
    maxFileBytes: 1024 * 1024,
    readOnly: false,
    exec: { enabled: true, timeoutMs: 5000, allow: [], deny: [] },
    projectSlug: "test-project",
    projectName: "Test Project",
    ...overrides,
  };
}

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export async function withClient<T>(scope: ProjectScope, fn: (client: Client) => Promise<T>): Promise<T> {
  const audit = new AuditLog(path.join(path.dirname(scope.root), "audit-test.jsonl"));
  const server = createServer(scope, audit);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

export function toolText(res: ToolCallResult): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
