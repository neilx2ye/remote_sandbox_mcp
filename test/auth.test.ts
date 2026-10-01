import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { isLoopbackHost, parseMcpAuthMode, type AppConfig, type McpAuthMode } from "../src/config.js";
import { ProjectsStore } from "../src/projects.js";
import { OAuthStore } from "../src/oauth.js";
import { startHttpServer } from "../src/http.js";
import { AuditLog } from "../src/util/audit.js";
import { cleanup, makeTempDir } from "./helpers.js";

const ADMIN_TOKEN = "admin-test-token";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest", version: "1.0" } },
});

function mcpHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface Harness {
  base: string;
  token: string;
  close: () => Promise<void>;
  dispose: () => void;
}

const harnesses: Harness[] = [];

async function startServer(mode: McpAuthMode): Promise<Harness> {
  const tmp = makeTempDir(`rsb-auth-${mode}-`);
  const root = path.join(tmp, "root");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "note.txt"), "hi\n");

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    adminToken: ADMIN_TOKEN,
    adminTokenProvided: true,
    maxFileBytes: 1024 * 1024,
    readOnly: false,
    auth: mode,
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
  const store = new ProjectsStore(config.projectsFile);
  const project = store.create({ name: "Project A", slug: "slug-a", root });

  const server = startHttpServer({
    config,
    store,
    oauth: new OAuthStore(config.oauthFile),
    audit: new AuditLog(config.auditLogPath),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const harness: Harness = {
    base,
    token: project.token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    dispose: () => cleanup(tmp),
  };
  harnesses.push(harness);
  return harness;
}

afterAll(async () => {
  for (const h of harnesses) {
    await h.close();
    h.dispose();
  }
});

describe("auth mode parsing", () => {
  it("accepts the three modes and normalizes case/whitespace", () => {
    expect(parseMcpAuthMode("any")).toBe("any");
    expect(parseMcpAuthMode(" token ")).toBe("token");
    expect(parseMcpAuthMode("NONE")).toBe("none");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "oauth", "open", null, undefined, 42]) {
      expect(() => parseMcpAuthMode(bad)).toThrow(/Invalid MCP auth mode/);
    }
  });

  it("recognizes only loopback binds", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", "128.0.0.1", ""]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('auth mode "none"', () => {
  it("accepts MCP requests without any credentials", async () => {
    const h = await startServer("none");
    const res = await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders(), body: INIT_BODY });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.text()).toContain("remote-sandbox-mcp");
  });

  it("serves a full tool session for an anonymous caller", async () => {
    const h = await startServer("none");
    const init = await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders(), body: INIT_BODY });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const call = await fetch(`${h.base}/slug-a`, {
      method: "POST",
      headers: { ...mcpHeaders(), "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fs_read", arguments: { path: "note.txt" } } }),
    });
    expect(call.status).toBe(200);
    expect(await call.text()).toContain("hi");
  });

  it("does not serve the OAuth endpoints", async () => {
    const h = await startServer("none");
    expect((await fetch(`${h.base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await fetch(`${h.base}/.well-known/oauth-protected-resource/slug-a`)).status).toBe(404);
    expect(
      (await fetch(`${h.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
    ).toBe(404);
    expect((await fetch(`${h.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("keeps the admin API behind the admin token", async () => {
    const h = await startServer("none");
    expect((await fetch(`${h.base}/api/projects`)).status).toBe(401);
    const status = await fetch(`${h.base}/api/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ auth: "none", oauthEnabled: false });
  });
});

describe('auth mode "token"', () => {
  it("still requires the project token", async () => {
    const h = await startServer("token");
    expect((await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders(), body: INIT_BODY })).status).toBe(401);
    // A cross-project token is not a project token either.
    expect((await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders("wrong"), body: INIT_BODY })).status).toBe(401);
    expect((await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders(h.token), body: INIT_BODY })).status).toBe(200);
  });

  it("does not serve the OAuth endpoints", async () => {
    const h = await startServer("token");
    expect((await fetch(`${h.base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect(
      (await fetch(`${h.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
    ).toBe(404);
  });
});

describe('auth mode "any" (default)', () => {
  it("serves OAuth discovery and reports the mode", async () => {
    const h = await startServer("any");
    const discovery = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).issuer).toBe(h.base);
    const status = await fetch(`${h.base}/api/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(await status.json()).toEqual({ auth: "any", oauthEnabled: true });
  });

  it("challenges unauthenticated MCP requests with a metadata pointer", async () => {
    const h = await startServer("any");
    const res = await fetch(`${h.base}/slug-a`, { method: "POST", headers: mcpHeaders(), body: INIT_BODY });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/slug-a");
  });

  it("lists no OAuth clients when the console asks in a non-any mode", async () => {
    const h = await startServer("token");
    const res = await fetch(`${h.base}/api/oauth/clients`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clients: [],
      stats: { clients: 0, accessTokens: 0, refreshTokens: 0 },
    });
    const del = await fetch(`${h.base}/api/oauth/clients/whatever`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(del.status).toBe(404);
  });
});