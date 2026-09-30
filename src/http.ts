import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { scopeForProject, type ProjectsStore } from "./projects.js";
import { createServer } from "./server.js";
import { handleAdminApi, sendJson } from "./admin.js";
import type { AuditLog } from "./util/audit.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpContext {
  config: AppConfig;
  store: ProjectsStore;
  audit: AuditLog;
}

function sha256(s: string): Buffer {
  return crypto.createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time token comparison (hashed first so length never leaks). */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = sha256(provided);
  const b = sha256(expected);
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const q = url.searchParams.get("token");
  if (q) return q;
  return null;
}

function extractBearer(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Static admin assets: exact whitelist, everything else 404. */
const ADMIN_ASSETS: Record<string, { file: string; type: string }> = {
  "/admin": { file: "admin.html", type: "text/html; charset=utf-8" },
  "/admin/": { file: "admin.html", type: "text/html; charset=utf-8" },
  "/admin/admin.html": { file: "admin.html", type: "text/html; charset=utf-8" },
  "/admin/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" },
  "/admin/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
};

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  slug: string;
}

export function startHttpServer(ctx: HttpContext): http.Server {
  const { config, store, audit } = ctx;
  const sessions = new Map<string, SessionEntry>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // Health probe for tunnels / uptime checks. No auth required.
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Admin static assets (no auth: they contain no data; all data flows
      // through the admin-token-protected API).
      if (req.method === "GET" && (pathname === "/admin" || pathname.startsWith("/admin/"))) {
        const asset = ADMIN_ASSETS[pathname];
        if (!asset) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        try {
          const content = fs.readFileSync(path.join(config.publicDir, asset.file));
          res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
          res.end(content);
        } catch {
          sendJson(res, 404, { error: "admin asset missing (public/ directory not found)" });
        }
        return;
      }

      // Admin API: always requires the admin token.
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        if (!tokenMatches(extractBearer(req), config.adminToken ?? "")) {
          sendJson(res, 401, { error: "Unauthorized: invalid or missing admin token" });
          return;
        }
        await handleAdminApi(req, res, url, store, config);
        return;
      }

      // MCP endpoints: /mcp (default project) and /mcp/<slug>.
      const mcpMatch = /^\/mcp(?:\/([a-z0-9-]{2,32}))?$/.exec(pathname);
      if (!mcpMatch) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const slug = mcpMatch[1] ?? "default";
      const project = store.getBySlug(slug);
      if (!project) {
        jsonRpcError(res, 404, -32004, `Unknown project: ${slug}`);
        return;
      }

      // Per-project token auth.
      if (!tokenMatches(extractToken(req, url), project.token)) {
        jsonRpcError(res, 401, -32001, "Unauthorized: invalid or missing token");
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const sess = sessions.get(sessionId)!;
        if (sess.slug !== slug) {
          jsonRpcError(res, 403, -32003, `Forbidden: session belongs to project "${sess.slug}", not "${slug}"`);
          return;
        }
        transport = sess.transport;
      }

      if (req.method === "POST") {
        const rawBody = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          jsonRpcError(res, 400, -32700, "Parse error: body must be valid JSON");
          return;
        }

        if (!transport) {
          if (sessionId || !isInitializeRequest(body)) {
            jsonRpcError(res, 400, -32000, "Bad Request: missing or unknown mcp-session-id");
            return;
          }
          // New session: one McpServer + one transport per session, fenced to
          // this project's sandbox.
          const sessionRef = { id: null as string | null };
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              sessionRef.id = sid;
              sessions.set(sid, { transport: newTransport, slug });
            },
          });
          newTransport.onclose = () => {
            if (newTransport.sessionId) sessions.delete(newTransport.sessionId);
          };
          const scope = scopeForProject(project, {
            maxFileBytes: config.maxFileBytes,
            exec: config.exec,
            readOnly: config.readOnly,
          });
          const server = createServer(scope, audit, sessionRef);
          await server.connect(newTransport);
          transport = newTransport;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) {
          jsonRpcError(res, 400, -32000, "Bad Request: missing or unknown mcp-session-id");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, `Internal error: ${(e as Error).message}`);
      } else {
        res.end();
      }
    }
  });

  httpServer.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  return httpServer;
}
