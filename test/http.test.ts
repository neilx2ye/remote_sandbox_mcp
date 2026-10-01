import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ProjectsStore } from "../src/projects.js";
import { OAuthStore } from "../src/oauth.js";
import { startHttpServer } from "../src/http.js";
import { AuditLog } from "../src/util/audit.js";
import { cleanup, makeTempDir } from "./helpers.js";

const ADMIN_TOKEN = "admin-test-token";

let tmp: string;
let rootA: string;
let rootB: string;
let config: AppConfig;
let store: ProjectsStore;
let server: http.Server;
let base: string;
let tokenA: string;
let tokenB: string;
let idA: string;

function mcpHeaders(token: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest", version: "1.0" } },
});

async function mcpInitialize(slugPath: string, token: string): Promise<Response> {
  return fetch(`${base}${slugPath}`, { method: "POST", headers: mcpHeaders(token), body: INIT_BODY });
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

beforeAll(async () => {
  tmp = makeTempDir("rsb-http-");
  rootA = path.join(tmp, "root-a");
  rootB = path.join(tmp, "root-b");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  fs.writeFileSync(path.join(rootA, "a.txt"), "hello from A\n");

  config = {
    host: "127.0.0.1",
    port: 0,
    adminToken: ADMIN_TOKEN,
    adminTokenProvided: true,
    maxFileBytes: 1024 * 1024,
    readOnly: false,
    auth: "any",
    stdio: false,
    exec: { enabled: true, timeoutMs: 5000, allow: [], deny: [] },
    publicUrl: null,
    projectDir: tmp,
    auditLogPath: path.join(tmp, "logs", "audit.jsonl"),
    dataDir: path.join(tmp, "data"),
    projectsFile: path.join(tmp, "data", "projects.json"),
    oauthFile: path.join(tmp, "data", "oauth.json"),
    publicDir: fileURLToPath(new URL("../public", import.meta.url)),
    seedRoot: tmp,
    seedToken: null,
  };
  store = new ProjectsStore(config.projectsFile);
  const pa = store.create({ name: "Project A", slug: "slug-a", root: rootA });
  const pb = store.create({ name: "Project B", slug: "slug-b", root: rootB, readOnly: true });
  tokenA = pa.token;
  tokenB = pb.token;
  idA = pa.id;

  server = startHttpServer({
    config,
    store,
    oauth: new OAuthStore(config.oauthFile),
    audit: new AuditLog(config.auditLogPath),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(tmp);
});

describe("MCP multi-project endpoints", () => {
  it("initializes with the project's own token", async () => {
    const res = await mcpInitialize("/slug-a", tokenA);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("remote-sandbox-mcp");
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects cross-project tokens with 401", async () => {
    const res = await mcpInitialize("/slug-a", tokenB);
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown slugs", async () => {
    const res = await mcpInitialize("/no-such-slug", tokenA);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32004);
    expect(body.error.message).toBe("Unknown project: no-such-slug");
  });

  it("returns 403 when a session is reused across slugs", async () => {
    const res = await mcpInitialize("/slug-a", tokenA);
    const sid = res.headers.get("mcp-session-id")!;
    await res.text();
    // Same session id against slug-b (even with slug-b's own token) must fail.
    const cross = await fetch(`${base}/slug-b`, {
      method: "POST",
      headers: mcpHeaders(tokenB, sid),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(cross.status).toBe(403);
    // And the session still works on its own slug.
    const ok = await fetch(`${base}/slug-a`, {
      method: "POST",
      headers: mcpHeaders(tokenA, sid),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(ok.status).toBe(200);
  });

  it("readOnly project hides write tools", async () => {
    const res = await mcpInitialize("/slug-b", tokenB);
    const sid = res.headers.get("mcp-session-id")!;
    await res.text();
    const list = await fetch(`${base}/slug-b`, {
      method: "POST",
      headers: mcpHeaders(tokenB, sid),
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    const text = await list.text();
    expect(text).toContain("fs_read");
    expect(text).not.toContain("fs_write");
    expect(text).not.toContain("exec_run");
  });
});

describe("admin API", () => {
  it("rejects requests without the admin token", async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${base}/api/projects`, { headers: { Authorization: "Bearer wrong" } });
    expect(bad.status).toBe(401);
  });

  it("lists projects with masked tokens", async () => {
    const res = await fetch(`${base}/api/projects`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toHaveLength(2);
    const a = data.projects.find((p: { slug: string }) => p.slug === "slug-a");
    expect(a.token).toMatch(/^.{4}\*{4}.{4}$/);
    expect(a.token).not.toBe(tokenA);
    expect(a.mcpPath).toBe("/slug-a");
  });

  it("creates a project and returns the full token once", async () => {
    const rootC = path.join(tmp, "root-c");
    fs.mkdirSync(rootC);
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "Project C", root: rootC, readOnly: true }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project.slug).toBe("project-c");
    expect(data.project.token.length).toBeGreaterThan(20);
    expect(data.project.readOnly).toBe(true);
    // cleanup registration
    await fetch(`${base}/api/projects/${data.project.id}`, { method: "DELETE", headers: adminHeaders() });
  });

  it("rejects creating a project with a bad root", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "bad", root: path.join(tmp, "nope") }),
    });
    expect(res.status).toBe(400);
  });

  it("gets full detail, patches, and regenerates tokens", async () => {
    const detail = await (await fetch(`${base}/api/projects/${idA}`, { headers: adminHeaders() })).json();
    expect(detail.project.token).toBe(tokenA);

    const patch = await fetch(`${base}/api/projects/${idA}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "Project A renamed" }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.project.name).toBe("Project A renamed");
    expect(patched.project.token).not.toBe(tokenA); // masked in PATCH response

    const regen = await fetch(`${base}/api/projects/${idA}/regenerate-token`, { method: "POST", headers: adminHeaders() });
    expect(regen.status).toBe(200);
    const regenData = await regen.json();
    expect(regenData.project.token).not.toBe(tokenA);
    expect(regenData.project.token.length).toBeGreaterThan(20);
    tokenA = regenData.project.token; // keep later tests consistent
  });
});

describe("admin file browsing & preview", () => {
  it("lists directory contents inside the project root", async () => {
    const res = await fetch(`${base}/api/projects/${idA}/files?path=.`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries.some((e: { name: string }) => e.name === "a.txt")).toBe(true);
    const a = data.entries.find((e: { name: string }) => e.name === "a.txt");
    expect(a.type).toBe("file");
    expect(a.size).toBe(13);
  });

  it("rejects path escapes in the files API", async () => {
    const res = await fetch(`${base}/api/projects/${idA}/files?path=${encodeURIComponent("..")}`, { headers: adminHeaders() });
    expect(res.status).toBe(400);
    const res2 = await fetch(`${base}/api/projects/${idA}/file?path=${encodeURIComponent("../secret.txt")}`, { headers: adminHeaders() });
    expect(res2.status).toBe(400);
  });

  it("previews text files as JSON with line content", async () => {
    const res = await fetch(`${base}/api/projects/${idA}/file?path=a.txt`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.kind).toBe("text");
    expect(data.content).toBe("hello from A\n");
    expect(data.truncated).toBe(false);
  });

  it("serves bitmap previews as image bytes", async () => {
    // minimal PNG magic bytes
    fs.writeFileSync(path.join(rootA, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const res = await fetch(`${base}/api/projects/${idA}/file?path=img.png`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it("reports non-image binaries as kind=binary", async () => {
    fs.writeFileSync(path.join(rootA, "data.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
    const res = await fetch(`${base}/api/projects/${idA}/file?path=data.bin`, { headers: adminHeaders() });
    const data = await res.json();
    expect(data.kind).toBe("binary");
  });

  it("truncates oversized text previews", async () => {
    // maxFileBytes is 1MB here; preview limit is min(1MB, 2MB) = 1MB
    fs.writeFileSync(path.join(rootA, "big.txt"), "x".repeat(1024 * 1024 + 100));
    const res = await fetch(`${base}/api/projects/${idA}/file?path=big.txt`, { headers: adminHeaders() });
    const data = await res.json();
    expect(data.kind).toBe("text");
    expect(data.truncated).toBe(true);
    expect(data.content.length).toBeLessThanOrEqual(1024 * 1024 + 200);
  });
});

describe("admin static assets", () => {
  it("serves /admin without auth", async () => {
    const res = await fetch(`${base}/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("管理台");
  });

  it("serves the whitelisted css/js and 404s everything else", async () => {
    expect((await fetch(`${base}/admin/admin.css`)).status).toBe(200);
    expect((await fetch(`${base}/admin/admin.js`)).status).toBe(200);
    expect((await fetch(`${base}/admin/../sandbox.config.json`)).status).toBe(404);
    expect((await fetch(`${base}/admin/evil.js`)).status).toBe(404);
    expect((await fetch(`${base}/admin/%2e%2e/package.json`)).status).toBe(404);
  });

  it("health endpoint stays public", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("bare /mcp endpoint (designated project)", () => {
  it("404s while no project is designated and no 'default' project exists", async () => {
    const res = await mcpInitialize("/mcp", tokenA);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32004);
    expect(body.error.message).toContain("No project is assigned to /mcp");
  });

  it("serves the designated project and reports it in the admin API", async () => {
    const set = await fetch(`${base}/api/projects/${idA}/set-default`, { method: "POST", headers: adminHeaders() });
    expect(set.status).toBe(200);
    const setData = await set.json();
    expect(setData.project.isDefault).toBe(true);
    // mcpPath is the project's own endpoint; isDefault marks the /mcp alias.
    expect(setData.project.mcpPath).toBe("/slug-a");

    const list = await (await fetch(`${base}/api/projects`, { headers: adminHeaders() })).json();
    const a = list.projects.find((p: { slug: string }) => p.slug === "slug-a");
    const b = list.projects.find((p: { slug: string }) => p.slug === "slug-b");
    expect(a.isDefault).toBe(true);
    expect(a.mcpPath).toBe("/slug-a");
    expect(b.isDefault).toBe(false);
    expect(b.mcpPath).toBe("/slug-b");

    // /mcp now serves slug-a: its token works, another project's does not...
    expect((await mcpInitialize("/mcp", tokenA)).status).toBe(200);
    expect((await mcpInitialize("/mcp", tokenB)).status).toBe(401);
    // ...and the canonical /slug-a path keeps working.
    expect((await mcpInitialize("/slug-a", tokenA)).status).toBe(200);
  });

  it("treats /mcp and /<slug> as the same session", async () => {
    const init = await mcpInitialize("/mcp", tokenA);
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const res = await fetch(`${base}/slug-a`, {
      method: "POST",
      headers: mcpHeaders(tokenA, sid),
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects set-default for an unknown project", async () => {
    const res = await fetch(`${base}/api/projects/no-such-id/set-default`, { method: "POST", headers: adminHeaders() });
    expect(res.status).toBe(404);
  });

  it("moves /mcp to another project and back to none when that project is deleted", async () => {
    const rootC = path.join(tmp, "root-designated");
    fs.mkdirSync(rootC, { recursive: true });
    const created = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: "Designated", root: rootC }),
      })
    ).json();
    const { id, token } = created.project as { id: string; token: string };

    const set = await fetch(`${base}/api/projects/${id}/set-default`, { method: "POST", headers: adminHeaders() });
    expect(set.status).toBe(200);
    expect((await mcpInitialize("/mcp", token)).status).toBe(200);
    expect((await mcpInitialize("/mcp", tokenA)).status).toBe(401);

    const del = await fetch(`${base}/api/projects/${id}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(200);
    // No 'default' project exists here, so bare /mcp goes back to 404.
    expect((await mcpInitialize("/mcp", tokenA)).status).toBe(404);
  });

  it("binds a project created with slug '/mcp' to the bare endpoint", async () => {
    const rootD = path.join(tmp, "root-slug-mcp");
    fs.mkdirSync(rootD, { recursive: true });
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "Bound", root: rootD, slug: "/mcp" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.project.slug).toBe("bound");
    expect(created.project.isDefault).toBe(true);
    // Every project's mcpPath is its own /<slug>; isDefault records the /mcp alias.
    expect(created.project.mcpPath).toBe("/bound");

    expect((await mcpInitialize("/mcp", created.project.token)).status).toBe(200);
    expect((await mcpInitialize("/bound", created.project.token)).status).toBe(200);
    expect((await mcpInitialize("/mcp", tokenA)).status).toBe(401);
  });
});

describe("project endpoint rename (PATCH slug)", () => {
  it("moves the endpoint and keeps serving the live session", async () => {
    const rootE = path.join(tmp, "root-rename");
    fs.mkdirSync(rootE, { recursive: true });
    const created = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: "Rename Me", root: rootE }),
      })
    ).json();
    const { id, token } = created.project as { id: string; token: string };
    expect(created.project.slug).toBe("rename-me");
    expect(created.project.mcpPath).toBe("/rename-me");

    // The project's own path serves it, and a session is fenced by project id.
    const init = await mcpInitialize("/rename-me", token);
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();

    const patch = await fetch(`${base}/api/projects/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ slug: "renamed-x" }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.project.slug).toBe("renamed-x");
    expect(patched.project.mcpPath).toBe("/renamed-x");

    // The old path is gone; the new one serves the same token.
    expect((await mcpInitialize("/rename-me", token)).status).toBe(404);
    expect((await mcpInitialize("/renamed-x", token)).status).toBe(200);
    // The live session follows the rename instead of being invalidated.
    const carried = await fetch(`${base}/renamed-x`, {
      method: "POST",
      headers: mcpHeaders(token, sid),
      body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} }),
    });
    expect(carried.status).toBe(200);
    await carried.text();

    await fetch(`${base}/api/projects/${id}`, { method: "DELETE", headers: adminHeaders() });
  });

  it("404s the legacy /mcp/<slug> shape with a hint at the new path", async () => {
    const res = await mcpInitialize("/mcp/slug-a", tokenA);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32004);
    expect(body.error.message).toContain("endpoints now live at /<slug>");
    expect(body.error.message).toContain("/slug-a");
    expect(body.error.message).toContain("the shared, assignable path is /mcp");
  });

  it("rejects a reserved or colliding slug on PATCH", async () => {
    const rootF = path.join(tmp, "root-patch-bad");
    fs.mkdirSync(rootF, { recursive: true });
    const created = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: "Patch Bad", root: rootF }),
      })
    ).json();
    const id = created.project.id as string;

    for (const reserved of ["admin", "oauth"]) {
      const res = await fetch(`${base}/api/projects/${id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ slug: reserved }),
      });
      expect(res.status).toBe(400);
    }
    const colliding = await fetch(`${base}/api/projects/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ slug: "slug-a" }),
    });
    expect(colliding.status).toBe(409);

    // slug "mcp" is an assignment request, not a rename: the endpoint stays.
    const assign = await fetch(`${base}/api/projects/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ slug: "mcp" }),
    });
    expect(assign.status).toBe(200);
    const assigned = await assign.json();
    expect(assigned.project.slug).toBe("patch-bad");
    expect(assigned.project.mcpPath).toBe("/patch-bad");
    expect(assigned.project.isDefault).toBe(true);
    expect((await mcpInitialize("/mcp", created.project.token)).status).toBe(200);

    await fetch(`${base}/api/projects/${id}`, { method: "DELETE", headers: adminHeaders() });
  });
});
