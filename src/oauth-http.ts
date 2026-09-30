import type http from "node:http";
import { sendJson } from "./admin.js";
import type { AppConfig } from "./config.js";
import { OAuthError, resourceCoversProject, type OAuthClientRecord, type OAuthStore, type TokenResponse } from "./oauth.js";
import type { Project, ProjectsStore } from "./projects.js";
import type { AuditLog } from "./util/audit.js";
import { tokenMatches } from "./util/token.js";

/**
 * OAuth 2.1 authorization server for the MCP endpoints:
 *   GET  /.well-known/oauth-protected-resource[/mcp/<slug>]   (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server              (RFC 8414)
 *   POST /oauth/register                                      (RFC 7591)
 *   GET  /oauth/authorize   POST /oauth/authorize             (consent page)
 *   POST /oauth/token
 *   POST /oauth/revoke                                        (RFC 7009)
 *
 * The consent page is the only interactive step: the operator logs in with the
 * admin token and picks which project sandbox the client may reach. The issued
 * access token is bound to that single project slug.
 *
 * Tunnel note: clients reach these paths directly, so a public tunnel must
 * expose /.well-known/* and /oauth/* in addition to /mcp*.
 */

export interface OAuthHttpContext {
  config: AppConfig;
  store: ProjectsStore;
  oauth: OAuthStore;
  audit: AuditLog;
}

const MAX_FORM_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 10;
/** Failed admin-token attempts per client IP before the consent page locks out. */
const MAX_AUTH_FAILURES = 8;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";
const WELL_KNOWN_AS = "/.well-known/oauth-authorization-server";

/* ---------- helpers ---------- */

export function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

/** Public origin of this server, honoring reverse-proxy headers. */
export function publicBaseUrl(req: http.IncomingMessage, config: AppConfig): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "http";
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? firstHeader(req.headers.host) ?? `127.0.0.1:${config.port}`;
  return `${proto.toLowerCase()}://${host}`;
}

/** Metadata URL advertised in the WWW-Authenticate challenge for one project. */
export function protectedResourceMetadataUrl(req: http.IncomingMessage, config: AppConfig, slug: string): string {
  return `${publicBaseUrl(req, config)}${WELL_KNOWN_PRM}/mcp/${slug}`;
}

export function authorizationServerUrl(req: http.IncomingMessage, config: AppConfig): string {
  return publicBaseUrl(req, config);
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = firstHeader(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req: http.IncomingMessage, maxBytes = MAX_FORM_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new OAuthError(413, "invalid_request", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OAuthError(400, "invalid_client_metadata", "request body must be a JSON object");
  }
}

/** Token/revoke requests are form-encoded by MCP clients; JSON is tolerated. */
async function readParamBody(req: http.IncomingMessage): Promise<Map<string, string>> {
  const raw = await readBody(req);
  const ctype = (firstHeader(req.headers["content-type"]) ?? "").toLowerCase();
  const out = new Map<string, string>();
  if (ctype.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      throw new OAuthError(400, "invalid_request", "request body must be valid JSON");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out.set(k, v);
      }
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out.set(k, v);
  return out;
}

/** http/https only; plain http is limited to loopback callbacks. */
function validateRedirectUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash) return null;
  if (url.protocol === "https:") return value;
  if (url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return value;
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function plainText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function sendOAuthError(res: http.ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

/* ---------- consent page ---------- */

const PAGE_CSS = `
:root{color-scheme:dark;--bg:#0b0e14;--panel:#141b29;--panel-2:#1a2333;--panel-3:#212c3f;--border:#26324a;
--border-soft:#1e2839;--text:#e8edf6;--text-dim:#b6c0d0;--muted:#8794a9;--accent:#4f8cff;--accent-hover:#6b9dff;
--accent-soft:rgba(79,140,255,.14);--accent-line:rgba(79,140,255,.3);--accent-ring:rgba(79,140,255,.4);
--danger:#ef6060;--warn:#f0b429;--ok:#3fbf7f;
--font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
--mono:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;font-size:15px}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:8vh 18px 48px;
background-color:var(--bg);background-image:radial-gradient(900px 420px at 50% -160px,rgba(79,140,255,.12),transparent 70%);
color:var(--text);font-family:var(--font);line-height:1.55;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:620px;padding:28px;background:var(--panel);border:1px solid var(--border);border-radius:12px;
box-shadow:0 1px 2px rgba(0,0,0,.28),0 10px 30px -18px rgba(0,0,0,.7)}
.brand-mark{position:relative;width:27px;height:27px;border-radius:8px;background:linear-gradient(140deg,#6b9dff,#8b5cf6);
box-shadow:0 4px 14px -6px rgba(79,140,255,.85);margin-bottom:16px}
.brand-mark::after{content:"";position:absolute;inset:8px;border-radius:3px;background:rgba(255,255,255,.94)}
h1{margin:0 0 8px;font-size:1.12rem;font-weight:600}
h2{margin:22px 0 10px;font-size:.9rem;font-weight:600;color:var(--text-dim)}
p{margin:0 0 14px}
.muted{color:var(--muted);font-size:.84rem}
.mono{font-family:var(--mono);font-size:.78rem;word-break:break-all}
dl.meta{margin:0 0 4px;padding:12px 14px;border-radius:8px;background:var(--bg);border:1px solid var(--border-soft)}
dl.meta div{display:flex;gap:12px;margin-bottom:6px}
dl.meta div:last-child{margin-bottom:0}
dt{flex:none;width:82px;color:var(--muted);font-size:.76rem}
dd{margin:0;color:var(--text-dim);font-family:var(--mono);font-size:.78rem;word-break:break-all}
.projects{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto}
.proj{display:flex;gap:11px;align-items:flex-start;padding:11px 13px;border-radius:8px;cursor:pointer;
background:var(--bg);border:1px solid var(--border-soft);transition:border-color .15s,background-color .15s}
.proj:hover{border-color:var(--border)}
.proj input{margin:3px 0 0;width:16px;height:16px;flex:none;accent-color:var(--accent);cursor:pointer}
.proj-body{min-width:0}
.proj-name{font-weight:600;font-size:.9rem}
.proj-line{color:var(--muted);font-size:.75rem;word-break:break-all}
.proj:has(input:checked){border-color:var(--accent-line);background:var(--accent-soft)}
.tag{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;font-size:.7rem;border:1px solid var(--border);
background:var(--panel-3);color:var(--text-dim)}
.tag.ro{border-color:rgba(240,180,41,.32);color:#ffd479}
.tag.exec{border-color:rgba(63,191,127,.32);color:#7ee2ae}
input[type=password]{width:100%;height:38px;padding:0 12px;background:var(--bg);color:var(--text);
border:1px solid var(--border);border-radius:8px;font:inherit;font-size:.9rem}
input[type=password]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)}
.actions{display:flex;gap:10px;margin-top:22px}
button{display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 18px;border-radius:8px;
font:inherit;font-size:.9rem;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--panel-2);color:var(--text)}
button:hover{background:var(--panel-3)}
button.primary{background:linear-gradient(180deg,var(--accent-hover),var(--accent));border-color:var(--accent);color:#fff;flex:1}
button.primary:hover{background:linear-gradient(180deg,#86b0ff,var(--accent-hover))}
.alert{margin:16px 0 0;padding:11px 13px;border-radius:8px;font-size:.83rem;line-height:1.7;
background:rgba(46,20,24,.72);border:1px solid rgba(239,96,96,.45);color:#ffc4c4}
.warn{margin:14px 0 0;padding:11px 13px;border-radius:8px;font-size:.83rem;line-height:1.7;
background:rgba(240,180,41,.12);border:1px solid rgba(240,180,41,.28);color:#ffd479}
.hint{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--border-soft);color:var(--muted);font-size:.78rem;line-height:1.8}
code{padding:1px 6px;border-radius:5px;background:var(--panel-3);border:1px solid var(--border);color:#a9c6ff;font-size:.76rem}
@media(max-width:620px){.card{padding:22px 18px}dl.meta div{flex-direction:column;gap:2px}dt{width:auto}}
`;

function pageShell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="card">
<span class="brand-mark" aria-hidden="true"></span>
${inner}
</main>
</body>
</html>
`;
}

function errorPage(res: http.ServerResponse, status: number, title: string, message: string): void {
  htmlPage(
    res,
    status,
    pageShell(
      title,
      `<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(message)}</p>
<p class="hint">这是 remote-sandbox-mcp 的 OAuth 授权端点。若你不是在配置 MCP 连接器，可以关闭此页面。</p>`,
    ),
  );
}

function projectTags(p: Project): string {
  const tags: string[] = [];
  if (p.readOnly) tags.push('<span class="tag ro">只读</span>');
  else tags.push('<span class="tag exec">读写</span>');
  if (!p.execEnabled) tags.push('<span class="tag">exec 关</span>');
  return tags.join("");
}

interface ConsentInput {
  client: OAuthClientRecord;
  redirectUri: string;
  params: URLSearchParams;
  projects: Project[];
  selected: string | null;
  resource: string | null;
  error?: string | null;
}

function consentPage(res: http.ServerResponse, status: number, input: ConsentInput): void {
  const hidden = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .map((name) => {
      const value = name === "redirect_uri" ? input.redirectUri : input.params.get(name);
      return value === null || value === undefined || value === ""
        ? ""
        : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    })
    .join("\n");

  const projects = input.projects
    .map((p) => {
      const checked = input.selected === p.slug ? " checked" : "";
      return `<label class="proj">
<input type="radio" name="project" value="${escapeHtml(p.slug)}"${checked} required>
<span class="proj-body">
<span class="proj-name">${escapeHtml(p.name)}${projectTags(p)}</span>
<span class="proj-line mono">/mcp/${escapeHtml(p.slug)} · ${escapeHtml(p.root)}</span>
</span>
</label>`;
    })
    .join("\n");

  const mismatch =
    input.resource && input.selected && !input.resource.endsWith(`/mcp/${input.selected}`)
      ? `<p class="warn">客户端请求的资源是 <span class="mono">${escapeHtml(input.resource)}</span>，
你当前选中的是另一个项目。授权后客户端用该令牌访问原资源会被拒绝，除非你把连接器地址改成对应的 <code>/mcp/&lt;slug&gt;</code>。</p>`
      : "";

  const inner = `<h1>授权 MCP 访问</h1>
<p class="muted">客户端请求访问本机的 remote-sandbox-mcp 服务。选择要开放的项目，并用 Admin Token 确认。</p>
<dl class="meta">
<div><dt>客户端</dt><dd>${escapeHtml(input.client.clientName ?? "(未命名客户端)")}</dd></div>
<div><dt>client_id</dt><dd>${escapeHtml(input.client.clientId)}</dd></div>
<div><dt>回调地址</dt><dd>${escapeHtml(input.redirectUri)}</dd></div>
<div><dt>请求资源</dt><dd>${escapeHtml(input.resource ?? "(未指定)")}</dd></div>
</dl>
${input.error ? `<p class="alert">${escapeHtml(input.error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden}
<h2>1. 选择要授权的项目</h2>
<div class="projects">${projects || '<p class="muted">尚未登记任何项目，请先在管理台创建。</p>'}</div>
${mismatch}
<h2>2. 输入 Admin Token</h2>
<input type="password" name="admin_token" placeholder="admin token" autocomplete="off" required>
<div class="actions">
<button type="submit" name="decision" value="allow" class="primary">授权</button>
<button type="submit" name="decision" value="deny">拒绝</button>
</div>
</form>
<p class="hint">令牌只对该项目有效（<code>/mcp/&lt;slug&gt;</code>），1 小时后过期并自动刷新；可在管理台的「OAuth 授权」中随时撤销。请确认回调地址是你信任的客户端。</p>`;

  htmlPage(res, status, pageShell("授权 · remote-sandbox-mcp", inner));
}

/* ---------- admin-token throttle ---------- */

interface ThrottleState {
  failures: number;
  resetAt: number;
}

const throttle = new Map<string, ThrottleState>();

/** Test/ops helper: forget all recorded consent-page failures. */
export function resetAuthThrottle(): void {
  throttle.clear();
}

function clientIp(req: http.IncomingMessage): string {
  return firstHeader(req.headers["x-forwarded-for"]) ?? req.socket.remoteAddress ?? "unknown";
}

function throttleBlocked(key: string): boolean {
  const state = throttle.get(key);
  if (!state) return false;
  if (Date.now() > state.resetAt) {
    throttle.delete(key);
    return false;
  }
  return state.failures >= MAX_AUTH_FAILURES;
}

function recordAuthFailure(key: string): void {
  const now = Date.now();
  const state = throttle.get(key);
  if (!state || now > state.resetAt) {
    throttle.set(key, { failures: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
    return;
  }
  state.failures += 1;
}

/* ---------- authorize ---------- */

interface AuthorizeRequest {
  client: OAuthClientRecord;
  redirectUri: string;
  params: URLSearchParams;
  resource: string | null;
  scope: string | null;
  requestedSlug: string | null;
}

function slugFromResource(resource: string | null): string | null {
  if (!resource) return null;
  let pathname: string;
  try {
    pathname = new URL(resource).pathname;
  } catch {
    return null;
  }
  const m = /^\/mcp\/([a-z0-9-]{2,32})\/?$/.exec(pathname);
  return m ? m[1] : null;
}

/** Validate the client-facing half of an authorization request. */
function readAuthorizeRequest(
  ctx: OAuthHttpContext,
  params: Map<string, string> | URLSearchParams,
  res: http.ServerResponse,
): AuthorizeRequest | null {
  const get = (k: string): string | null => (params instanceof URLSearchParams ? params.get(k) : params.get(k) ?? null);
  const clientId = get("client_id") ?? "";
  const client = ctx.oauth.getClient(clientId);
  if (!client) {
    errorPage(res, 400, "未知的客户端", `client_id「${clientId || "(空)"}」没有在本服务注册。请让 AI 客户端重新发起授权。`);
    return null;
  }
  let redirectUri = get("redirect_uri") ?? "";
  if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
  if (!redirectUri) {
    errorPage(res, 400, "缺少 redirect_uri", "请求没有携带 redirect_uri，且该客户端注册了多个回调地址。");
    return null;
  }
  if (!client.redirectUris.includes(redirectUri)) {
    // Never redirect to an unregistered URI.
    errorPage(res, 400, "回调地址未注册", `redirect_uri「${redirectUri}」不在该客户端的注册列表中，已拒绝跳转。`);
    return null;
  }

  const state = get("state");
  const redirectError = (error: string, description: string): null => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
    return null;
  };

  if ((get("response_type") ?? "code") !== "code") {
    return redirectError("unsupported_response_type", "only response_type=code is supported");
  }
  const challenge = get("code_challenge");
  const method = get("code_challenge_method") ?? "S256";
  if (!challenge) {
    return redirectError("invalid_request", "code_challenge is required (PKCE)");
  }
  if (method !== "S256") {
    return redirectError("invalid_request", "only code_challenge_method=S256 is supported");
  }

  const resource = get("resource");
  return {
    client,
    redirectUri,
    params: params instanceof URLSearchParams ? params : new URLSearchParams(params),
    resource,
    scope: get("scope"),
    requestedSlug: slugFromResource(resource),
  };
}

function redirectWithCode(
  res: http.ServerResponse,
  req: AuthorizeRequest,
  code: string,
): void {
  const target = new URL(req.redirectUri);
  target.searchParams.set("code", code);
  const state = req.params.get("state");
  if (state) target.searchParams.set("state", state);
  res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function handleAuthorizeGet(
  ctx: OAuthHttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const parsed = readAuthorizeRequest(ctx, url.searchParams, res);
  if (!parsed) return;
  const projects = ctx.store.list().sort((a, b) => a.name.localeCompare(b.name));
  const selected = parsed.requestedSlug && projects.some((p) => p.slug === parsed.requestedSlug) ? parsed.requestedSlug : null;
  consentPage(res, 200, {
    client: parsed.client,
    redirectUri: parsed.redirectUri,
    params: parsed.params,
    projects,
    selected,
    resource: parsed.resource,
  });
}

async function handleAuthorizePost(
  ctx: OAuthHttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const parsed = readAuthorizeRequest(ctx, form, res);
  if (!parsed) return;

  if (form.get("decision") === "deny") {
    const target = new URL(parsed.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "the resource owner denied the request");
    const state = parsed.params.get("state");
    if (state) target.searchParams.set("state", state);
    ctx.audit.write({
      ts: new Date().toISOString(),
      tool: "oauth.authorize",
      target: parsed.client.clientId,
      ok: false,
      ms: 0,
      detail: "denied by operator",
    });
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const ip = clientIp(req);
  const rerender = (error: string, status = 401): void => {
    consentPage(res, status, {
      client: parsed.client,
      redirectUri: parsed.redirectUri,
      params: parsed.params,
      projects: ctx.store.list().sort((a, b) => a.name.localeCompare(b.name)),
      selected: form.get("project"),
      resource: parsed.resource,
      error,
    });
  };

  if (throttleBlocked(ip)) {
    ctx.audit.write({
      ts: new Date().toISOString(),
      tool: "oauth.authorize",
      target: parsed.client.clientId,
      ok: false,
      ms: 0,
      detail: `rate limited (${ip})`,
    });
    errorPage(res, 429, "尝试次数过多", "Admin Token 连续输错太多次，请 5 分钟后再试。");
    return;
  }

  if (!tokenMatches(form.get("admin_token"), ctx.config.adminToken ?? "")) {
    recordAuthFailure(ip);
    ctx.audit.write({
      ts: new Date().toISOString(),
      tool: "oauth.authorize",
      target: parsed.client.clientId,
      ok: false,
      ms: 0,
      detail: `invalid admin token from ${ip}`,
    });
    rerender("Admin Token 不正确，请重新输入。");
    return;
  }

  const slug = form.get("project") ?? "";
  const project = ctx.store.getBySlug(slug);
  if (!project) {
    rerender("请选择一个要授权的项目。", 400);
    return;
  }

  const code = ctx.oauth.createAuthorizationCode({
    clientId: parsed.client.clientId,
    redirectUri: parsed.redirectUri,
    projectSlug: project.slug,
    codeChallenge: parsed.params.get("code_challenge") ?? "",
    // Canonical indicator for the granted project; whatever the client asked for
    // is re-checked against it at the token endpoint (see resourceCoversProject).
    resource: `${publicBaseUrl(req, ctx.config)}/mcp/${project.slug}`,
    scope: parsed.scope,
  });
  ctx.audit.write({
    ts: new Date().toISOString(),
    project: project.slug,
    tool: "oauth.authorize",
    target: parsed.client.clientId,
    ok: true,
    ms: 0,
    detail: `granted ${project.slug}`,
  });
  redirectWithCode(res, parsed, code);
}

/* ---------- token / revoke / register ---------- */

/** client_id[:client_secret] from an HTTP Basic Authorization header. */
function basicAuthCredentials(req: http.IncomingMessage): { clientId: string; secret: string | null } | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { clientId: decodeURIComponent(decoded.slice(0, sep)), secret: decodeURIComponent(decoded.slice(sep + 1)) };
}

/** Client authentication: public clients use client_id alone; confidential ones need the secret. */
function authenticateClient(
  ctx: OAuthHttpContext,
  req: http.IncomingMessage,
  body: Map<string, string>,
  res: http.ServerResponse,
): OAuthClientRecord | null {
  const basic = basicAuthCredentials(req);
  const clientId = body.get("client_id") ?? basic?.clientId ?? "";
  const secret = body.get("client_secret") ?? basic?.secret ?? null;
  const client = clientId ? ctx.oauth.getClient(clientId) : undefined;
  if (!client) {
    sendOAuthError(res, 401, "invalid_client", "unknown client_id");
    return null;
  }
  if (!ctx.oauth.verifyClientSecret(client, secret)) {
    sendOAuthError(res, 401, "invalid_client", "invalid client_secret");
    return null;
  }
  return client;
}

function tokenResponse(res: http.ServerResponse, tokens: TokenResponse): void {
  const body: Record<string, unknown> = {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    refresh_token: tokens.refresh_token,
  };
  if (tokens.scope) body.scope = tokens.scope;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Pragma: "no-cache" });
  res.end(JSON.stringify(body));
}

async function handleToken(ctx: OAuthHttpContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readParamBody(req);
  const client = authenticateClient(ctx, req, body, res);
  if (!client) return;

  const grantType = body.get("grant_type") ?? "";
  const resource = body.get("resource") ?? null;
  const audit = (project: string | undefined, detail: string, ok: boolean): void => {
    ctx.audit.write({
      ts: new Date().toISOString(),
      project,
      tool: "oauth.token",
      target: client.clientId,
      ok,
      ms: 0,
      detail,
    });
  };

  if (grantType === "authorization_code") {
    const rec = ctx.oauth.consumeAuthorizationCode({
      code: body.get("code") ?? "",
      clientId: client.clientId,
      redirectUri: body.get("redirect_uri") ?? null,
      codeVerifier: body.get("code_verifier") ?? null,
    });
    if (!resourceCoversProject(resource, rec.projectSlug)) {
      audit(rec.projectSlug, "resource mismatch", false);
      throw new OAuthError(400, "invalid_target", "resource does not match the authorized project");
    }
    const tokens = ctx.oauth.issueTokens({
      clientId: client.clientId,
      projectSlug: rec.projectSlug,
      resource: rec.resource,
      scope: rec.scope,
    });
    audit(rec.projectSlug, "access token issued", true);
    tokenResponse(res, tokens);
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.get("refresh_token") ?? "";
    if (!refreshToken) throw new OAuthError(400, "invalid_request", "refresh_token is required");
    const tokens = ctx.oauth.refresh({ refreshToken, clientId: client.clientId, resource });
    audit(undefined, "refresh token rotated", true);
    tokenResponse(res, tokens);
    return;
  }

  throw new OAuthError(400, "unsupported_grant_type", `unsupported grant_type: ${grantType || "(missing)"}`);
}

async function handleRevoke(ctx: OAuthHttpContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readParamBody(req);
  // RFC 7009 client authentication, but revocation is a denial, not an
  // escalation: a caller that omits client_id may still drop the token it holds.
  const clientId = body.get("client_id") ?? basicAuthCredentials(req)?.clientId ?? "";
  if (clientId) {
    const client = authenticateClient(ctx, req, body, res);
    if (!client) return;
  }
  const token = body.get("token") ?? "";
  const revoked = token ? ctx.oauth.revoke(token) : false;
  ctx.audit.write({
    ts: new Date().toISOString(),
    tool: "oauth.revoke",
    target: clientId || "(anonymous)",
    ok: true,
    ms: 0,
    detail: revoked ? "token revoked" : "token not found",
  });
  // RFC 7009: always 200, even for unknown tokens.
  sendJson(res, 200, {});
}

async function handleRegister(ctx: OAuthHttpContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const raw = body.redirect_uris;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECT_URIS) {
    sendOAuthError(res, 400, "invalid_redirect_uri", `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} absolute URIs`);
    return;
  }
  const redirectUris: string[] = [];
  for (const candidate of raw) {
    const uri = validateRedirectUri(candidate);
    if (!uri) {
      sendOAuthError(
        res,
        400,
        "invalid_redirect_uri",
        `unsupported redirect_uri: ${String(candidate)} (https, or http on localhost, no fragment)`,
      );
      return;
    }
    redirectUris.push(uri);
  }
  const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (authMethod !== "none" && authMethod !== "client_secret_post" && authMethod !== "client_secret_basic") {
    sendOAuthError(res, 400, "invalid_client_metadata", `unsupported token_endpoint_auth_method: ${authMethod}`);
    return;
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;
  const { client, clientSecret } = ctx.oauth.registerClient({
    clientName,
    redirectUris,
    confidential: authMethod !== "none",
  });
  ctx.audit.write({
    ts: new Date().toISOString(),
    tool: "oauth.register",
    target: client.clientId,
    ok: true,
    ms: 0,
    detail: `${clientName ?? "unnamed"} -> ${redirectUris.join(", ")}`,
  });
  const info: Record<string, unknown> = {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: client.clientName ?? undefined,
  };
  if (clientSecret) info.client_secret = clientSecret;
  sendJson(res, 201, info);
}

/* ---------- discovery ---------- */

function protectedResourceMetadata(ctx: OAuthHttpContext, req: http.IncomingMessage, slug: string | null): Record<string, unknown> | null {
  const base = publicBaseUrl(req, ctx.config);
  if (slug) {
    const project = ctx.store.getBySlug(slug);
    if (!project) return null;
    return {
      resource: `${base}/mcp/${project.slug}`,
      authorization_servers: [base],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: project.name,
    };
  }
  // Root variant (path-aware probe missed): the collection of project endpoints.
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "remote-sandbox-mcp projects",
  };
}

function authorizationServerMetadata(ctx: OAuthHttpContext, req: http.IncomingMessage): Record<string, unknown> {
  const base = publicBaseUrl(req, ctx.config);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  };
}

/* ---------- entry point ---------- */

/**
 * Handle OAuth/discovery requests. Returns true when the request was handled
 * (a response has been sent), false when the caller should keep routing.
 */
export async function handleOAuthRequest(
  ctx: OAuthHttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  const isMetadata = pathname.startsWith(WELL_KNOWN_PRM) || pathname.startsWith(WELL_KNOWN_AS);
  const isOAuth = pathname === "/oauth" || pathname.startsWith("/oauth/");
  if (!isMetadata && !isOAuth) return false;

  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Max-Age": "86400" });
    res.end();
    return true;
  }

  try {
    if (isMetadata) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      if (pathname.startsWith(WELL_KNOWN_PRM)) {
        const suffix = pathname.slice(WELL_KNOWN_PRM.length).replace(/^\/+/, "");
        let slug: string | null = null;
        if (suffix) {
          const m = /^mcp\/([a-z0-9-]{2,32})$/.exec(suffix);
          if (!m) {
            sendJson(res, 404, { error: "not found" });
            return true;
          }
          slug = m[1];
        }
        const metadata = protectedResourceMetadata(ctx, req, slug);
        if (!metadata) {
          sendJson(res, 404, { error: `unknown project: ${slug}` });
          return true;
        }
        sendJson(res, 200, metadata);
        return true;
      }
      sendJson(res, 200, authorizationServerMetadata(ctx, req));
      return true;
    }

    if (pathname === "/oauth/register" && req.method === "POST") {
      await handleRegister(ctx, req, res);
      return true;
    }
    if (pathname === "/oauth/authorize") {
      if (req.method === "GET") {
        await handleAuthorizeGet(ctx, req, res, url);
        return true;
      }
      if (req.method === "POST") {
        await handleAuthorizePost(ctx, req, res);
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (pathname === "/oauth/token" && req.method === "POST") {
      await handleToken(ctx, req, res);
      return true;
    }
    if (pathname === "/oauth/revoke" && req.method === "POST") {
      await handleRevoke(ctx, req, res);
      return true;
    }
    if (pathname === "/oauth/authorize" || pathname === "/oauth/token" || pathname === "/oauth/register" || pathname === "/oauth/revoke") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    plainText(res, 404, "not found");
    return true;
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof OAuthError) {
        sendOAuthError(res, e.status, e.code, e.message);
      } else {
        sendOAuthError(res, 500, "server_error", (e as Error).message);
      }
    } else {
      res.end();
    }
    return true;
  }
}