import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { scopeForProject, type Project, type ProjectsStore } from "./projects.js";
import type { OAuthStore } from "./oauth.js";
import { handleOAuthRequest, firstHeader, protectedResourceMetadataUrl } from "./oauth-http.js";
import { createServer } from "./server.js";
import { handleAdminApi, sendJson } from "./admin.js";
import type { AuditLog } from "./util/audit.js";
import { tokenMatches } from "./util/token.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpContext {
  config: AppConfig;
  store: ProjectsStore;
  oauth: OAuthStore;
  audit: AuditLog;
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
  /** Owning project, by immutable id so renaming an endpoint never breaks a session. */
  projectId: string;
}

/** A project's own endpoint: exactly one path segment. */
const SLUG_PATH_RE = /^\/([a-z0-9-]{2,32})$/;

/**
 * CORS for browser-based MCP clients: the 401 challenge must be readable so the
 * client can discover where to authorize. Only reflected when an Origin is sent;
 * there are no cookies, so credential-less CORS adds no ambient authority.
 */
function applyMcpCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = firstHeader(req.headers.origin);
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
}

export function startHttpServer(ctx: HttpContext): http.Server {
  const { config, store, audit, oauth } = ctx;
  const sessions = new Map<string, SessionEntry>();
  // OAuth is only reachable in the default "any" mode: the other modes exist to
  // run the MCP endpoints on static tokens or with no authentication at all.
  const oauthEnabled = config.auth === "any";
  const authRequired = config.auth !== "none";

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

      // OAuth 2.1 authorization server + RFC 9728/8414 discovery (needed by
      // clients that authorize a connector instead of pasting a project token).
      // Disabled outside "any" mode: those paths fall through to 404.
      if (oauthEnabled && (await handleOAuthRequest({ config, store, oauth, audit }, req, res, url))) {
        return;
      }

      // Admin API: always requires the admin token.
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        if (!tokenMatches(extractBearer(req), config.adminToken ?? "")) {
          sendJson(res, 401, { error: "Unauthorized: invalid or missing admin token" });
          return;
        }
        await handleAdminApi(req, res, url, store, config, oauth);
        return;
      }

      // MCP endpoints: every project always answers on its own /<slug>, and the
      // shared /mcp path serves whichever project the console assigned to it.
      const legacy = /^\/mcp\/([a-z0-9-]{2,32})$/.exec(pathname);
      if (legacy) {
        jsonRpcError(
          res,
          404,
          -32004,
          `Project endpoints now live at /<slug>: use /${legacy[1]} (the shared, assignable path is /mcp)`,
        );
        return;
      }
      let project: Project | undefined;
      if (pathname === "/mcp") {
        project = store.getDefault();
        if (!project) {
          jsonRpcError(res, 404, -32004, "No project is assigned to /mcp (assign one in the admin console)");
          return;
        }
      } else {
        const slugMatch = SLUG_PATH_RE.exec(pathname);
        if (!slugMatch) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        project = store.getBySlug(slugMatch[1]);
        if (!project) {
          jsonRpcError(res, 404, -32004, `Unknown project: ${slugMatch[1]}`);
          return;
        }
      }
      // The session fence keys on the project, so /mcp and /<slug> are the same
      // project (and cross-project reuse stays exact even after a rename).
      const slug = project.slug;
      const projectId = project.id;

      applyMcpCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Per-project token auth: the project's static token, or an OAuth access
      // token that was authorized for exactly this project. Skipped entirely in
      // "none" mode.
      if (authRequired) {
        const provided = extractToken(req, url);
        if (!tokenMatches(provided, project.token)) {
          const grant = oauthEnabled && provided ? oauth.verifyAccessToken(provided) : null;
          if (grant && grant.projectSlug !== project.slug) {
            jsonRpcError(
              res,
              403,
              -32003,
              `Forbidden: this OAuth token is authorized for project "${grant.projectSlug}", not "${slug}"`,
            );
            return;
          }
          if (!grant) {
            // RFC 6750 challenge so MCP clients can start the OAuth flow.
            res.setHeader(
              "WWW-Authenticate",
              `Bearer realm="remote-sandbox-mcp", resource_metadata="${protectedResourceMetadataUrl(req, config, slug)}", error="invalid_token", error_description="a project token or an authorized OAuth access token is required"`,
            );
            jsonRpcError(
              res,
              401,
              -32001,
              "Unauthorized: invalid or missing token (use this project's token, or authorize via OAuth)",
            );
            return;
          }
        }
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const sess = sessions.get(sessionId)!;
        if (sess.projectId !== projectId) {
          jsonRpcError(res, 403, -32003, `Forbidden: this session belongs to another project, not "${slug}"`);
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
              sessions.set(sid, { transport: newTransport, projectId });
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
