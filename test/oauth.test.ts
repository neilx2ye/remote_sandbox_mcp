import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ProjectsStore } from "../src/projects.js";
import { OAuthStore, pkceChallenge } from "../src/oauth.js";
import { resetAuthThrottle } from "../src/oauth-http.js";
import { startHttpServer } from "../src/http.js";
import { AuditLog } from "../src/util/audit.js";
import { cleanup, makeTempDir } from "./helpers.js";

const ADMIN_TOKEN = "admin-oauth-token";
const REDIRECT_URI = "https://client.example.com/callback";

let tmp: string;
let config: AppConfig;
let store: ProjectsStore;
let oauth: OAuthStore;
let server: http.Server;
let base: string;
let staticTokenA: string;

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

async function registerClient(clientName = "Test MCP Client", redirectUris: string[] = [REDIRECT_URI]): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id;
}

interface AuthorizeQuery {
  clientId: string;
  codeChallenge: string;
  redirectUri?: string;
  state?: string;
  resource?: string | null;
  responseType?: string;
  omitChallenge?: boolean;
}

function authorizeQuery(q: AuthorizeQuery): URLSearchParams {
  const params = new URLSearchParams({
    response_type: q.responseType ?? "code",
    client_id: q.clientId,
    redirect_uri: q.redirectUri ?? REDIRECT_URI,
    code_challenge_method: "S256",
  });
  if (!q.omitChallenge) params.set("code_challenge", q.codeChallenge);
  if (q.state) params.set("state", q.state);
  if (q.resource) params.set("resource", q.resource);
  return params;
}

async function postConsent(
  q: AuthorizeQuery,
  body: Record<string, string>,
): Promise<Response> {
  const form = authorizeQuery(q);
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
}

interface TokenExchange {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri?: string;
  resource?: string | null;
}

async function exchangeCode(input: TokenExchange): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    code_verifier: input.verifier,
  });
  if (input.resource) body.set("resource", input.resource);
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/** Full consent -> code -> token run for one project. */
async function authorizeProject(project: string, opts: { resource?: string | null } = {}): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const q: AuthorizeQuery = { clientId, codeChallenge: challenge, state: "st-1", resource: opts.resource ?? null };
  const consent = await postConsent(q, { admin_token: ADMIN_TOKEN, project, decision: "allow" });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get("location")!);
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  const res = await exchangeCode({ code: code!, verifier, clientId, resource: opts.resource ?? null });
  expect(res.status).toBe(200);
  const tokens = await res.json();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId };
}

async function mcpInitialize(slugPath: string, token: string): Promise<Response> {
  return fetch(`${base}${slugPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest", version: "1.0" } },
    }),
  });
}

beforeAll(async () => {
  tmp = makeTempDir("rsb-oauth-");
  const rootA = path.join(tmp, "root-a");
  const rootB = path.join(tmp, "root-b");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);

  config = {
    host: "127.0.0.1",
    port: 0,
    adminToken: ADMIN_TOKEN,
    adminTokenProvided: true,
    maxFileBytes: 1024 * 1024,
    readOnly: false,
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
  staticTokenA = store.create({ name: "Project A", slug: "slug-a", root: rootA }).token;
  store.create({ name: "Project B", slug: "slug-b", root: rootB });

  oauth = new OAuthStore(config.oauthFile);
  server = startHttpServer({ config, store, oauth, audit: new AuditLog(config.auditLogPath) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetAuthThrottle();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(tmp);
});

describe("OAuth discovery", () => {
  it("serves path-aware protected resource metadata for a project", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/slug-a`);
    expect(res.status).toBe(200);
    const md = await res.json();
    expect(md.resource).toBe(`${base}/mcp/slug-a`);
    expect(md.authorization_servers).toEqual([base]);
    expect(md.resource_name).toBe("Project A");
    expect(md.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves the root variant as the project collection and 404s unknown projects", async () => {
    const root = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(root.status).toBe(200);
    expect((await root.json()).resource).toBe(`${base}/mcp`);

    const missing = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/nope`);
    expect(missing.status).toBe(404);
  });

  it("advertises authorization server metadata with PKCE S256 and registration", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const md = await res.json();
    expect(md.issuer).toBe(base);
    expect(md.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(md.token_endpoint).toBe(`${base}/oauth/token`);
    expect(md.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(md.response_types_supported).toContain("code");
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.grant_types_supported).toContain("refresh_token");
  });

  it("sends a WWW-Authenticate challenge on unauthenticated MCP requests", async () => {
    const res = await mcpInitialize("/mcp/slug-a", "wrong-token");
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain("Bearer");
    expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/slug-a"`);
  });
});

describe("dynamic client registration", () => {
  it("rejects non-loopback http redirect URIs", async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });

  it("accepts https and loopback http redirect URIs", async () => {
    const httpsRes = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "HTTPS", redirect_uris: ["https://a.example.com/cb"] }),
    });
    expect(httpsRes.status).toBe(201);
    expect((await httpsRes.json()).client_id).toMatch(/^rsb_cid_/);

    const loopback = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:7777/cb", "http://localhost:8888/cb"] }),
    });
    expect(loopback.status).toBe(201);
  });
});

describe("authorize consent page", () => {
  it("rejects unknown clients and unregistered redirect URIs without redirecting", async () => {
    const unknown = await fetch(`${base}/oauth/authorize?client_id=rsb_cid_deadbeef&response_type=code`);
    expect(unknown.status).toBe(400);

    const clientId = await registerClient();
    const bad = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://attacker.example.com/cb")}&code_challenge=${pkce().challenge}&code_challenge_method=S256`,
    );
    expect(bad.status).toBe(400);
  });

  it("renders the project picker and redirects errors back to the client", async () => {
    const clientId = await registerClient("Claude Desktop");
    const { challenge } = pkce();
    const page = await fetch(`${base}/oauth/authorize?${authorizeQuery({ clientId, codeChallenge: challenge })}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Claude Desktop");
    expect(html).toContain("Project A");
    expect(html).toContain("slug-b");
    expect(html).toContain("admin_token");

    const badType = await fetch(
      `${base}/oauth/authorize?${authorizeQuery({ clientId, codeChallenge: challenge, responseType: "token" })}`,
      { redirect: "manual" },
    );
    expect(badType.status).toBe(302);
    expect(new URL(badType.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");

    const noPkce = await fetch(`${base}/oauth/authorize?${authorizeQuery({ clientId, codeChallenge: challenge, omitChallenge: true })}`, {
      redirect: "manual",
    });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("requires the admin token and an existing project", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const q = { clientId, codeChallenge: challenge, state: "s1" };

    const wrong = await postConsent(q, { admin_token: "nope", project: "slug-a", decision: "allow" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("location")).toBeNull();
    expect(await wrong.text()).toContain("Admin Token 不正确");

    const badProject = await postConsent(q, { admin_token: ADMIN_TOKEN, project: "ghost", decision: "allow" });
    expect(badProject.status).toBe(400);

    resetAuthThrottle();
  });

  it("redirects access_denied back to the client when the operator refuses", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await postConsent({ clientId, codeChallenge: challenge, state: "s2" }, { admin_token: ADMIN_TOKEN, decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("s2");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("issues a code bound to the selected project", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await postConsent(
      { clientId, codeChallenge: challenge, state: "xyz" },
      { admin_token: ADMIN_TOKEN, project: "slug-b", decision: "allow" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("code")).toMatch(/^rsb_ac_/);
  });
});

describe("token endpoint", () => {
  it("exchanges a code with PKCE and rejects replay or a bad verifier", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await postConsent({ clientId, codeChallenge: challenge }, { admin_token: ADMIN_TOKEN, project: "slug-a", decision: "allow" });
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    const bad = await exchangeCode({ code, verifier: crypto.randomBytes(32).toString("base64url"), clientId });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");

    const ok = await exchangeCode({ code, verifier, clientId });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const tokens = await ok.json();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toMatch(/^rsb_at_/);
    expect(tokens.refresh_token).toMatch(/^rsb_rt_/);
    expect(tokens.expires_in).toBeGreaterThan(0);

    const replay = await exchangeCode({ code, verifier, clientId });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  it("rejects unknown clients and mismatched redirect URIs", async () => {
    const unknown = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "x", client_id: "nope" }).toString(),
    });
    expect(unknown.status).toBe(401);

    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await postConsent({ clientId, codeChallenge: challenge }, { admin_token: ADMIN_TOKEN, project: "slug-a", decision: "allow" });
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const res = await exchangeCode({ code, verifier, clientId, redirectUri: "https://client.example.com/other" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a resource indicator that names a different project", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await postConsent(
      { clientId, codeChallenge: challenge, resource: `${base}/mcp/slug-a` },
      { admin_token: ADMIN_TOKEN, project: "slug-b", decision: "allow" },
    );
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const res = await exchangeCode({ code, verifier, clientId, resource: `${base}/mcp/slug-a` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_target");
  });

  it("accepts the collection resource indicator from root metadata", async () => {
    const { accessToken } = await authorizeProject("slug-a", { resource: `${base}/mcp` });
    expect(accessToken).toMatch(/^rsb_at_/);
  });

  it("rotates refresh tokens and rejects the old one", async () => {
    const { refreshToken, clientId } = await authorizeProject("slug-a");
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
    });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.access_token).not.toBe(refreshToken);

    const reuse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
    });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");
  });
});

describe("MCP access with OAuth tokens", () => {
  it("accepts an access token on the authorized project only", async () => {
    const { accessToken } = await authorizeProject("slug-a");

    const ok = await mcpInitialize("/mcp/slug-a", accessToken);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
    expect(await ok.text()).toContain("remote-sandbox-mcp");

    const cross = await mcpInitialize("/mcp/slug-b", accessToken);
    expect(cross.status).toBe(403);
    expect(await cross.text()).toContain("authorized for project");
  });

  it("still accepts the project's static token", async () => {
    const res = await mcpInitialize("/mcp/slug-a", staticTokenA);
    expect(res.status).toBe(200);
  });

  it("rejects a revoked access token", async () => {
    const { accessToken } = await authorizeProject("slug-a");
    const revoke = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    expect(revoke.status).toBe(200);
    expect((await mcpInitialize("/mcp/slug-a", accessToken)).status).toBe(401);
  });

  it("keeps discovery/CORS usable from a browser origin", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { Origin: "https://claude.ai" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");

    const preflight = await fetch(`${base}/oauth/token`, {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
  });
});

describe("admin console view", () => {
  it("lists and revokes OAuth clients", async () => {
    const clientId = await registerClient("Console Client");

    const list = await fetch(`${base}/api/oauth/clients`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(list.status).toBe(200);
    const data = await list.json();
    const found = data.clients.find((c: { clientId: string }) => c.clientId === clientId);
    expect(found).toBeTruthy();
    expect(found.clientName).toBe("Console Client");
    expect(found.confidential).toBe(false);
    expect(data.stats.clients).toBeGreaterThan(0);

    const unauthorized = await fetch(`${base}/api/oauth/clients`);
    expect(unauthorized.status).toBe(401);

    const { accessToken: liveToken } = await authorizeProject("slug-a");
    const del = await fetch(`${base}/api/oauth/clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(del.status).toBe(200);

    const again = await fetch(`${base}/api/oauth/clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(again.status).toBe(404);

    // A token from an unrelated client keeps working after that revocation.
    expect((await mcpInitialize("/mcp/slug-a", liveToken)).status).toBe(200);
  });
});

describe("consent page throttling", () => {
  it("locks out repeated admin-token failures", async () => {
    resetAuthThrottle();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const q = { clientId, codeChallenge: challenge };

    for (let i = 0; i < 8; i++) {
      const res = await postConsent(q, { admin_token: `bad-${i}`, project: "slug-a", decision: "allow" });
      expect(res.status).toBe(401);
    }
    const blocked = await postConsent(q, { admin_token: ADMIN_TOKEN, project: "slug-a", decision: "allow" });
    expect(blocked.status).toBe(429);
    resetAuthThrottle();
  });
});