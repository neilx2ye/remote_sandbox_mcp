import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Minimal OAuth 2.1 authorization-server state for the MCP endpoints:
 * dynamically registered clients, one-shot authorization codes (PKCE S256),
 * and access/refresh tokens bound to a single project slug.
 *
 * Only SHA-256 digests are persisted; the plaintext token/code never touches
 * data/oauth.json.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000; // 5min

const ACCESS_TOKEN_PREFIX = "rsb_at_";
const REFRESH_TOKEN_PREFIX = "rsb_rt_";
const AUTH_CODE_PREFIX = "rsb_ac_";

/** RFC 7636 code_verifier: 43-128 chars of unreserved characters. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests (length is fixed by SHA-256). */
export function digestMatches(provided: string | null | undefined, expectedHex: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(sha256Hex(provided), "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Constant-time string comparison for non-secret but fixed-shape values. */
function stringEquals(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** PKCE S256: base64url(SHA-256(ascii(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * RFC 8707 resource-indicator check. Clients send either the exact project
 * endpoint (`/<slug>`) or the shared `mcp` path; both are satisfied by a grant
 * on the project. Only the path is compared, since a reverse proxy may shift
 * the origin.
 */
export function resourceCoversProject(resource: string | null | undefined, projectSlug: string): boolean {
  if (!resource) return true;
  let pathname: string;
  try {
    pathname = new URL(resource).pathname;
  } catch {
    return false;
  }
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  return normalized === "" || normalized === "/mcp" || normalized === `/${projectSlug}`;
}

function randomToken(prefix: string, bytes = 32): string {
  return prefix + crypto.randomBytes(bytes).toString("base64url");
}

export interface OAuthClientRecord {
  clientId: string;
  /** SHA-256 of the client secret; null for public clients (auth method "none"). */
  clientSecretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OAuthCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  projectSlug: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

export interface OAuthTokenRecord {
  tokenHash: string;
  kind: "access" | "refresh";
  clientId: string;
  projectSlug: string;
  resource: string | null;
  scope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string | null;
}

export interface ClientSummary {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  confidential: boolean;
  projects: string[];
  createdAt: string;
  lastUsedAt: string | null;
  activeAccessTokens: number;
  activeRefreshTokens: number;
}

interface PersistedOAuth {
  version: number;
  clients: OAuthClientRecord[];
  codes: OAuthCodeRecord[];
  tokens: OAuthTokenRecord[];
}

export class OAuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
    this.code = code;
  }
}

const TOUCH_INTERVAL_MS = 60 * 1000;

export class OAuthStore {
  private filePath: string;
  private clients: OAuthClientRecord[] = [];
  private codes: OAuthCodeRecord[] = [];
  private tokens: OAuthTokenRecord[] = [];
  /** Last persisted lastUsedAt per token hash, to avoid a write per request. */
  private touched = new Map<string, number>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let data: PersistedOAuth;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedOAuth;
    } catch (e) {
      throw new Error(`Cannot parse OAuth state file ${this.filePath}: ${(e as Error).message}`);
    }
    this.clients = Array.isArray(data.clients) ? data.clients : [];
    this.codes = Array.isArray(data.codes) ? data.codes : [];
    this.tokens = Array.isArray(data.tokens) ? data.tokens : [];
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    this.codes = this.codes.filter((c) => Date.parse(c.expiresAt) > now);
    this.tokens = this.tokens.filter((t) => Date.parse(t.expiresAt) > now);
  }

  private save(): void {
    this.prune();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: PersistedOAuth = {
      version: 1,
      clients: this.clients,
      codes: this.codes,
      tokens: this.tokens,
    };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  /* ---------- clients ---------- */

  registerClient(input: {
    clientName?: string | null;
    redirectUris: string[];
    confidential?: boolean;
  }): { client: OAuthClientRecord; clientSecret: string | null } {
    const secret = input.confidential ? randomToken("rsb_cs_", 32) : null;
    const client: OAuthClientRecord = {
      clientId: randomToken("rsb_cid_", 16),
      clientSecretHash: secret ? sha256Hex(secret) : null,
      clientName: input.clientName ?? null,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.clients.push(client);
    this.save();
    return { client: { ...client }, clientSecret: secret };
  }

  getClient(clientId: string): OAuthClientRecord | undefined {
    const c = this.clients.find((x) => x.clientId === clientId);
    return c ? { ...c } : undefined;
  }

  /** Public clients (no secret) authenticate by client_id alone. */
  verifyClientSecret(client: OAuthClientRecord, providedSecret: string | null): boolean {
    if (!client.clientSecretHash) return true;
    return digestMatches(providedSecret, client.clientSecretHash);
  }

  listClients(): ClientSummary[] {
    const now = Date.now();
    return this.clients.map((c) => {
      const live = this.tokens.filter((t) => t.clientId === c.clientId && Date.parse(t.expiresAt) > now);
      return {
        clientId: c.clientId,
        clientName: c.clientName,
        redirectUris: c.redirectUris,
        confidential: c.clientSecretHash !== null,
        projects: [...new Set(live.map((t) => t.projectSlug))].sort(),
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        activeAccessTokens: live.filter((t) => t.kind === "access").length,
        activeRefreshTokens: live.filter((t) => t.kind === "refresh").length,
      };
    });
  }

  /** Drop a client together with every code/token it obtained. */
  removeClient(clientId: string): boolean {
    const idx = this.clients.findIndex((c) => c.clientId === clientId);
    if (idx === -1) return false;
    this.clients.splice(idx, 1);
    this.codes = this.codes.filter((c) => c.clientId !== clientId);
    this.tokens = this.tokens.filter((t) => t.clientId !== clientId);
    this.save();
    return true;
  }

  /**
   * Follow a project endpoint rename: codes and tokens keep pointing at the
   * same project, so their stored slug is rewritten instead of being dropped.
   */
  renameProjectSlug(oldSlug: string, newSlug: string): void {
    if (oldSlug === newSlug) return;
    let changed = false;
    for (const rec of [...this.codes, ...this.tokens]) {
      if (rec.projectSlug === oldSlug) {
        rec.projectSlug = newSlug;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /* ---------- authorization codes ---------- */

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    projectSlug: string;
    codeChallenge: string;
    resource?: string | null;
    scope?: string | null;
  }): string {
    const code = randomToken(AUTH_CODE_PREFIX, 24);
    const now = Date.now();
    this.codes.push({
      codeHash: sha256Hex(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      projectSlug: input.projectSlug,
      codeChallenge: input.codeChallenge,
      resource: input.resource ?? null,
      scope: input.scope ?? null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      used: false,
    });
    this.save();
    return code;
  }

  /**
   * Validate and burn an authorization code. Throws OAuthError(invalid_grant)
   * for unknown, expired, already-used codes, redirect mismatch or PKCE failure.
   */
  consumeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string | null;
    codeVerifier: string | null;
  }): OAuthCodeRecord {
    const hash = sha256Hex(input.code);
    const idx = this.codes.findIndex((c) => c.codeHash === hash);
    if (idx === -1) throw new OAuthError(400, "invalid_grant", "unknown authorization code");
    const rec = this.codes[idx];
    if (rec.used) {
      // Code replay: drop every code and token already issued to this client.
      this.codes = this.codes.filter((c) => c.clientId !== rec.clientId);
      this.tokens = this.tokens.filter((t) => t.clientId !== rec.clientId);
      this.save();
      throw new OAuthError(400, "invalid_grant", "authorization code already used");
    }
    if (Date.parse(rec.expiresAt) <= Date.now()) {
      this.codes.splice(idx, 1);
      this.save();
      throw new OAuthError(400, "invalid_grant", "authorization code expired");
    }
    if (rec.clientId !== input.clientId) {
      throw new OAuthError(400, "invalid_grant", "authorization code was issued to another client");
    }
    if (input.redirectUri && input.redirectUri !== rec.redirectUri) {
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!input.codeVerifier || !CODE_VERIFIER_RE.test(input.codeVerifier)) {
      throw new OAuthError(400, "invalid_grant", "code_verifier is missing or malformed");
    }
    const expected = pkceChallenge(input.codeVerifier);
    if (!stringEquals(rec.codeChallenge, expected)) {
      throw new OAuthError(400, "invalid_grant", "code_verifier does not match code_challenge");
    }
    rec.used = true;
    this.save();
    return { ...rec };
  }

  /* ---------- tokens ---------- */

  issueTokens(input: {
    clientId: string;
    projectSlug: string;
    resource?: string | null;
    scope?: string | null;
  }): TokenResponse {
    const now = Date.now();
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
    const base = {
      clientId: input.clientId,
      projectSlug: input.projectSlug,
      resource: input.resource ?? null,
      scope: input.scope ?? null,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(
      { ...base, kind: "access", tokenHash: sha256Hex(accessToken), expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString() },
      { ...base, kind: "refresh", tokenHash: sha256Hex(refreshToken), expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString() },
    );
    this.touchClient(input.clientId, now);
    this.save();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: input.scope ?? null,
    };
  }

  /** Resolve an access token to its project grant, or null when unknown/expired. */
  verifyAccessToken(token: string): OAuthTokenRecord | null {
    const hash = sha256Hex(token);
    const rec = this.tokens.find((t) => t.kind === "access" && t.tokenHash === hash);
    if (!rec) return null;
    if (Date.parse(rec.expiresAt) <= Date.now()) return null;
    const now = Date.now();
    const last = this.touched.get(hash) ?? 0;
    if (now - last > TOUCH_INTERVAL_MS) {
      this.touched.set(hash, now);
      rec.lastUsedAt = new Date(now).toISOString();
      this.touchClient(rec.clientId, now);
      try {
        this.save();
      } catch {
        // Usage bookkeeping must never break a request.
      }
    }
    return { ...rec };
  }

  /** Rotate a refresh token: the presented token is invalidated on success. */
  refresh(input: { refreshToken: string; clientId: string; resource?: string | null }): TokenResponse {
    const hash = sha256Hex(input.refreshToken);
    const rec = this.tokens.find((t) => t.kind === "refresh" && t.tokenHash === hash);
    if (!rec) throw new OAuthError(400, "invalid_grant", "unknown refresh token");
    if (rec.clientId !== input.clientId) {
      throw new OAuthError(400, "invalid_grant", "refresh token was issued to another client");
    }
    if (Date.parse(rec.expiresAt) <= Date.now()) {
      this.tokens = this.tokens.filter((t) => t !== rec);
      this.save();
      throw new OAuthError(400, "invalid_grant", "refresh token expired");
    }
    if (!resourceCoversProject(input.resource, rec.projectSlug)) {
      throw new OAuthError(400, "invalid_target", "resource does not match the original grant");
    }
    this.tokens = this.tokens.filter((t) => t !== rec);
    return this.issueTokens({
      clientId: rec.clientId,
      projectSlug: rec.projectSlug,
      resource: rec.resource,
      scope: rec.scope,
    });
  }

  /** RFC 7009 revocation: drops the presented access or refresh token. */
  revoke(token: string): boolean {
    const hash = sha256Hex(token);
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.tokenHash !== hash);
    if (this.tokens.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  stats(): { clients: number; accessTokens: number; refreshTokens: number } {
    const now = Date.now();
    const live = this.tokens.filter((t) => Date.parse(t.expiresAt) > now);
    return {
      clients: this.clients.length,
      accessTokens: live.filter((t) => t.kind === "access").length,
      refreshTokens: live.filter((t) => t.kind === "refresh").length,
    };
  }

  private touchClient(clientId: string, now: number): void {
    const client = this.clients.find((c) => c.clientId === clientId);
    if (client) client.lastUsedAt = new Date(now).toISOString();
  }
}