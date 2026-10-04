import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectScope } from "./projects.js";
import { AuditLog, audited } from "./util/audit.js";
import { registerFileTools, registerReadFileTools } from "./tools/files.js";
import { registerSearchTools } from "./tools/search.js";
import { registerExecTools } from "./tools/exec.js";
import { registerUploadTools } from "./tools/upload.js";

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

/** Registers a tool handler wrapped with auditing and uniform error conversion. */
export type RegisterTool = <A>(
  toolName: string,
  getTarget: (args: A) => string | undefined,
  fn: (args: A) => Promise<ToolResult>,
) => (args: A) => Promise<ToolResult>;

export interface SessionRef {
  id: string | null;
}

/**
 * Factory that builds a fully-configured McpServer for one project with all
 * tools registered. HTTP mode calls this once per session; stdio mode once.
 */
export function createServer(scope: ProjectScope, audit: AuditLog, sessionRef: SessionRef = { id: null }): McpServer {
  const server = new McpServer({
    name: "remote-sandbox-mcp",
    version: "0.2.0",
  });

  const wrap: RegisterTool = (toolName, getTarget, fn) => {
    return async (args) => {
      let target: string | undefined;
      try {
        target = getTarget(args);
      } catch {
        target = undefined;
      }
      try {
        return await audited(audit, toolName, target, sessionRef.id, scope.projectSlug, () => fn(args));
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
      }
    };
  };

  server.registerTool(
    "sys_info",
    {
      description: "Return runtime info: project name/slug, platform, arch, Node version, sandbox root, and which capability modes are active (readOnly, exec).",
      inputSchema: {},
    },
    wrap("sys_info", () => undefined, async () => {
      const info = {
        project: { name: scope.projectName, slug: scope.projectSlug },
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        osRelease: os.release(),
        sandboxRoot: scope.root,
        readOnly: scope.readOnly,
        execEnabled: scope.exec.enabled && !scope.readOnly,
        maxFileBytes: scope.maxFileBytes,
        fileUploadEnabled: !scope.readOnly,
        fileUploadTool: scope.readOnly ? null : "fs_upload",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
    }),
  );

  if (!scope.readOnly) {
    registerFileTools(server, scope, wrap);
    registerUploadTools(server, scope, wrap);
    registerSearchTools(server, scope, wrap);
    if (scope.exec.enabled) {
      registerExecTools(server, scope, wrap);
    }
  } else {
    // Read-only mode: only read-class tools are exposed.
    registerReadFileTools(server, scope, wrap);
    registerSearchTools(server, scope, wrap);
  }

  return server;
}
