import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { AppConfig } from "./config.js";
import { maskToken, StoreError, type Project, type ProjectsStore } from "./projects.js";
import type { OAuthStore } from "./oauth.js";
import { resolveWithinRoot, toRelPosix, SandboxError } from "./sandbox.js";
import { looksBinary, truncateUtf8 } from "./util/text.js";

const LIST_LIMIT = 2000;
const PREVIEW_MAX = 2 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function publicProject(p: Project, fullToken: boolean): Record<string, unknown> {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    root: p.root,
    readOnly: p.readOnly,
    execEnabled: p.execEnabled,
    createdAt: p.createdAt,
    token: fullToken ? p.token : maskToken(p.token),
    mcpPath: `/mcp/${p.slug}`,
  };
}

function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new StoreError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtime: string;
}

function listProjectDir(project: Project, relPath: string): { path: string; entries: FileEntry[]; truncated: boolean } {
  const abs = resolveWithinRoot(project.root, relPath || ".");
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new StoreError(400, `not a directory: ${relPath}`);
  const dirents = fs.readdirSync(abs, { withFileTypes: true });
  dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const entries: FileEntry[] = [];
  let truncated = false;
  for (const d of dirents) {
    if (entries.length >= LIST_LIMIT) {
      truncated = true;
      break;
    }
    let st2: fs.Stats | null = null;
    try {
      st2 = fs.statSync(path.join(abs, d.name));
    } catch {
      // entry vanished or unreadable; still list it with unknown metadata
    }
    entries.push({
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
      size: st2 && st2.isFile() ? st2.size : null,
      mtime: st2 ? st2.mtime.toISOString() : "",
    });
  }
  return { path: toRelPosix(project.root, abs), entries, truncated };
}

function previewProjectFile(
  project: Project,
  relPath: string,
  maxFileBytes: number,
  res: http.ServerResponse,
): void {
  if (!relPath) throw new StoreError(400, "path query parameter is required");
  const abs = resolveWithinRoot(project.root, relPath);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new StoreError(400, `not a regular file: ${relPath}`);

  const limit = Math.min(maxFileBytes, PREVIEW_MAX);
  const ext = path.extname(abs).toLowerCase();
  const imageType = IMAGE_TYPES[ext];

  if (imageType) {
    if (st.size > limit) {
      sendJson(res, 200, { kind: "binary", reason: "too_large", size: st.size, limit });
      return;
    }
    const buf = fs.readFileSync(abs);
    res.writeHead(200, { "Content-Type": imageType, "Cache-Control": "no-store", "X-Preview-Kind": "image" });
    res.end(buf);
    return;
  }

  // Read at most limit+1 bytes to detect truncation without loading huge files.
  const fd = fs.openSync(abs, "r");
  let buf: Buffer;
  try {
    const readLen = Math.min(st.size, limit + 1);
    buf = Buffer.alloc(readLen);
    let off = 0;
    while (off < readLen) {
      off += fs.readSync(fd, buf, off, readLen - off, off);
    }
  } finally {
    fs.closeSync(fd);
  }

  if (looksBinary(buf)) {
    sendJson(res, 200, { kind: "binary", size: st.size });
    return;
  }
  const truncated = st.size > limit;
  const sliced = truncated ? buf.subarray(0, limit) : buf;
  const t = truncateUtf8(sliced.toString("utf8"), limit);
  sendJson(res, 200, { kind: "text", content: t.text, truncated, size: st.size, path: toRelPosix(project.root, abs) });
}

/**
 * Handle /api/* admin requests. Caller has already authenticated the admin
 * token. Returns true if the route matched (response sent).
 */
export async function handleAdminApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  store: ProjectsStore,
  config: AppConfig,
  oauth: OAuthStore,
): Promise<void> {
  const seg = url.pathname.split("/").filter(Boolean); // ["api", "projects", id?, action?]
  const method = req.method ?? "GET";

  try {
    // /api/oauth/clients — list authorized OAuth clients (read-only, masked secrets).
    if (seg[1] === "oauth") {
      if (seg[2] === "clients" && seg.length === 3 && method === "GET") {
        sendJson(res, 200, { clients: oauth.listClients(), stats: oauth.stats() });
        return;
      }
      if (seg[2] === "clients" && seg.length === 4 && method === "DELETE") {
        const clientId = decodeURIComponent(seg[3]);
        if (!oauth.removeClient(clientId)) throw new StoreError(404, `oauth client not found: ${clientId}`);
        sendJson(res, 200, { ok: true, clients: oauth.listClients(), stats: oauth.stats() });
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (seg[1] !== "projects") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // /api/projects
    if (seg.length === 2) {
      if (method === "GET") {
        sendJson(res, 200, { projects: store.list().map((p) => publicProject(p, false)) });
        return;
      }
      if (method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          throw new StoreError(400, "request body must be valid JSON");
        }
        const project = store.create({
          name: body.name as string,
          slug: body.slug === undefined || body.slug === "" ? undefined : (body.slug as string),
          root: body.root as string,
          readOnly: body.readOnly === undefined ? undefined : Boolean(body.readOnly),
          execEnabled: body.execEnabled === undefined ? undefined : Boolean(body.execEnabled),
        });
        // The full token is returned only here (and via detail/regenerate).
        sendJson(res, 201, { project: publicProject(project, true) });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    const id = decodeURIComponent(seg[2]);

    // /api/projects/:id/files | /api/projects/:id/file
    if (seg.length === 4 && (seg[3] === "files" || seg[3] === "file") && method === "GET") {
      const project = store.get(id);
      if (!project) throw new StoreError(404, `project not found: ${id}`);
      const relPath = url.searchParams.get("path") ?? ".";
      if (seg[3] === "files") {
        sendJson(res, 200, listProjectDir(project, relPath));
      } else {
        previewProjectFile(project, relPath, config.maxFileBytes, res);
      }
      return;
    }

    // /api/projects/:id
    if (seg.length === 3) {
      if (method === "GET") {
        const project = store.get(id);
        if (!project) throw new StoreError(404, `project not found: ${id}`);
        sendJson(res, 200, { project: publicProject(project, true) });
        return;
      }
      if (method === "PATCH") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          throw new StoreError(400, "request body must be valid JSON");
        }
        const project = store.update(id, {
          name: body.name === undefined ? undefined : (body.name as string),
          root: body.root === undefined ? undefined : (body.root as string),
          readOnly: body.readOnly === undefined ? undefined : Boolean(body.readOnly),
          execEnabled: body.execEnabled === undefined ? undefined : Boolean(body.execEnabled),
        });
        sendJson(res, 200, { project: publicProject(project, false) });
        return;
      }
      if (method === "DELETE") {
        if (!store.remove(id)) throw new StoreError(404, `project not found: ${id}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // /api/projects/:id/regenerate-token
    if (seg.length === 4 && seg[3] === "regenerate-token" && method === "POST") {
      const project = store.regenerateToken(id);
      sendJson(res, 200, { project: publicProject(project, true) });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof StoreError) {
      sendJson(res, e.status, { error: e.message });
    } else if (e instanceof SandboxError) {
      sendJson(res, 400, { error: e.message });
    } else if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: `path not found: ${(e as Error).message}` });
    } else if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM") {
      sendJson(res, 403, { error: `permission denied: ${(e as Error).message}` });
    } else {
      sendJson(res, 500, { error: `internal error: ${(e as Error).message}` });
    }
  }
}
