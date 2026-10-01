import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecConfig, ToolScope } from "./config.js";

export interface Project {
  id: string;
  slug: string;
  name: string;
  root: string;
  token: string;
  readOnly: boolean;
  execEnabled: boolean;
  createdAt: string;
}

/** Per-project scope handed to the MCP tool layer. */
export interface ProjectScope extends ToolScope {
  projectSlug: string;
  projectName: string;
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

/**
 * First path segment each project's endpoint lives at (`/<slug>`), so anything
 * that is already a route of this server can never be claimed by a project.
 * "mcp" stays reserved for the shared, movable `/mcp` alias.
 */
export const RESERVED_SLUGS = ["admin", "api", "health", "mcp", "oauth"];
const SLUG_RE = /^[a-z0-9-]{2,32}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && !RESERVED_SLUGS.includes(s);
}

/**
 * Endpoint input that means "also serve this project at the shared /mcp path"
 * instead of naming its own path. The project keeps (or derives) its own slug.
 */
export function isMcpEndpointSlug(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\/+/, "");
  return v === "mcp";
}

/** Accept the endpoint path as written in URLs ("/ops") as well as a bare slug. */
export function normalizeSlugInput(value: string | undefined): string {
  if (value === undefined) return "";
  return value.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/** Fallback stem for names that contain no usable ASCII (e.g. all-Chinese names). */
function randomSlugStem(): string {
  return `proj-${crypto.randomBytes(2).toString("hex")}`;
}

/** Derive a slug candidate from a display name. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isValidSlug(s) ? s : randomSlugStem();
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Mask a token for list responses: keep first/last 4 chars. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

function validateRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new StoreError(400, "root is required and must be a non-empty string");
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    throw new StoreError(400, `root directory does not exist: ${abs}`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new StoreError(400, `cannot stat root: ${(e as Error).message}`);
  }
  if (!st.isDirectory()) {
    throw new StoreError(400, `root is not a directory: ${abs}`);
  }
  return fs.realpathSync(abs);
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new StoreError(400, "name is required and must be a non-empty string");
  }
  const n = name.trim();
  if (n.length > 100) throw new StoreError(400, "name too long (max 100 chars)");
  return n;
}

interface PersistedData {
  version: number;
  /** Slug of the project also served at the shared /mcp path; null = /mcp is unassigned. */
  defaultSlug?: string | null;
  projects: Project[];
}

export interface CreateProjectInput {
  name: string;
  /** Endpoint path/slug; omitted or empty derives one from the name. "mcp" assigns /mcp. */
  slug?: string;
  root: string;
  readOnly?: boolean;
  execEnabled?: boolean;
  /** Internal use (seeding): explicit token instead of a generated one. */
  token?: string;
}

export interface UpdateProjectInput {
  name?: string;
  /** New endpoint path/slug; "mcp" assigns the shared /mcp path to this project. */
  slug?: string;
  root?: string;
  readOnly?: boolean;
  execEnabled?: boolean;
}

export class ProjectsStore {
  private filePath: string;
  private projects: Project[] = [];
  private defaultSlug: string | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.projects = [];
      this.defaultSlug = null;
      return;
    }
    let data: PersistedData;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedData;
    } catch (e) {
      throw new Error(`Cannot parse projects file ${this.filePath}: ${(e as Error).message}`);
    }
    this.projects = Array.isArray(data.projects) ? data.projects : [];
    this.defaultSlug = typeof data.defaultSlug === "string" && data.defaultSlug.length > 0 ? data.defaultSlug : null;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: PersistedData = { version: 2, defaultSlug: this.defaultSlug, projects: this.projects };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  list(): Project[] {
    return this.projects.map((p) => ({ ...p }));
  }

  get(id: string): Project | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  getBySlug(slug: string): Project | undefined {
    const p = this.projects.find((x) => x.slug === slug);
    return p ? { ...p } : undefined;
  }

  /**
   * The project also served at the shared /mcp path: the explicitly assigned
   * one when there is one, otherwise the legacy "default" slug (what older
   * deployments seeded). Undefined means /mcp is unassigned.
   */
  getDefault(): Project | undefined {
    if (this.defaultSlug) {
      const designated = this.getBySlug(this.defaultSlug);
      if (designated) return designated;
    }
    return this.getBySlug("default");
  }

  /** Assign the shared /mcp path to this project (it keeps its own slug too). */
  setDefault(id: string): Project {
    const project = this.get(id);
    if (!project) throw new StoreError(404, `project not found: ${id}`);
    this.defaultSlug = project.slug;
    this.save();
    return project;
  }

  /** Validate an explicitly requested endpoint path (leading slash already stripped). */
  private validateSlugInput(requested: string, selfId?: string): string {
    if (!SLUG_RE.test(requested)) {
      throw new StoreError(400, `invalid endpoint "/${requested}": must match [a-z0-9-], 2-32 chars`);
    }
    if (RESERVED_SLUGS.includes(requested)) {
      throw new StoreError(400, `endpoint "/${requested}" is reserved by the server`);
    }
    const existing = this.getBySlug(requested);
    if (existing && existing.id !== selfId) {
      throw new StoreError(409, `endpoint "/${requested}" is already used by project "${existing.name}"`);
    }
    return requested;
  }

  private uniqueSlug(base: string): string {
    const stem = isValidSlug(base) ? base : randomSlugStem();
    let candidate = stem;
    let n = 2;
    while (this.getBySlug(candidate)) {
      const suffix = `-${n++}`;
      candidate = stem.slice(0, 32 - suffix.length) + suffix;
    }
    return candidate;
  }

  create(input: CreateProjectInput): Project {
    const name = validateName(input.name);
    const root = validateRoot(input.root);
    const requested = normalizeSlugInput(input.slug);
    let slug: string;
    let bindToMcpEndpoint = false;
    if (isMcpEndpointSlug(requested)) {
      // "mcp" is not a slug but an assignment: the project still gets its own
      // derived endpoint and additionally answers on the shared /mcp path.
      bindToMcpEndpoint = true;
      slug = this.uniqueSlug(slugify(name));
    } else if (requested !== "") {
      slug = this.validateSlugInput(requested);
    } else {
      slug = this.uniqueSlug(slugify(name));
    }
    const project: Project = {
      id: crypto.randomUUID(),
      slug,
      name,
      root,
      token: input.token ?? generateToken(),
      readOnly: input.readOnly ?? false,
      execEnabled: input.execEnabled ?? true,
      createdAt: new Date().toISOString(),
    };
    this.projects.push(project);
    if (bindToMcpEndpoint) this.defaultSlug = project.slug;
    this.save();
    return { ...project };
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const idx = this.projects.findIndex((x) => x.id === id);
    if (idx === -1) throw new StoreError(404, `project not found: ${id}`);
    const p = { ...this.projects[idx] };
    if (patch.name !== undefined) p.name = validateName(patch.name);
    if (patch.slug !== undefined) {
      const requested = normalizeSlugInput(patch.slug);
      if (isMcpEndpointSlug(requested)) {
        // Assigning the shared /mcp path does not rename the project's own endpoint.
        this.defaultSlug = p.slug;
      } else if (requested === "") {
        throw new StoreError(400, "endpoint path must not be empty");
      } else {
        const next = this.validateSlugInput(requested, id);
        if (next !== p.slug) {
          // The /mcp assignment follows the project it points at.
          if (this.defaultSlug === p.slug) this.defaultSlug = next;
          p.slug = next;
        }
      }
    }
    if (patch.root !== undefined) p.root = validateRoot(patch.root);
    if (patch.readOnly !== undefined) p.readOnly = Boolean(patch.readOnly);
    if (patch.execEnabled !== undefined) p.execEnabled = Boolean(patch.execEnabled);
    this.projects[idx] = p;
    this.save();
    return { ...p };
  }

  regenerateToken(id: string): Project {
    const idx = this.projects.findIndex((x) => x.id === id);
    if (idx === -1) throw new StoreError(404, `project not found: ${id}`);
    this.projects[idx] = { ...this.projects[idx], token: generateToken() };
    this.save();
    return { ...this.projects[idx] };
  }

  remove(id: string): boolean {
    const idx = this.projects.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    const [removed] = this.projects.splice(idx, 1);
    // Deleting the /mcp project just leaves /mcp unassigned.
    if (removed.slug === this.defaultSlug) this.defaultSlug = null;
    this.save();
    return true;
  }
}

export interface SeedResult {
  project: Project;
  tokenGenerated: boolean;
}

/**
 * Migration seed: when the store is empty, create the "default" project from
 * the legacy single-sandbox configuration, served at both /default and the
 * shared /mcp path so existing connector configs keep working. Returns null
 * when the store already has projects.
 */
export function seedDefaultProject(
  store: ProjectsStore,
  seed: { root: string; token: string | null; readOnly: boolean; execEnabled: boolean },
): SeedResult | null {
  if (store.list().length > 0) return null;
  const tokenGenerated = !seed.token;
  const project = store.create({
    name: "Default",
    slug: "/mcp",
    root: seed.root,
    readOnly: seed.readOnly,
    execEnabled: seed.execEnabled,
    token: seed.token ?? generateToken(),
  });
  return { project, tokenGenerated };
}

/** Build the tool-layer scope for a project, applying global master switches. */
export function scopeForProject(
  project: Project,
  defaults: { maxFileBytes: number; exec: ExecConfig; readOnly: boolean },
): ProjectScope {
  return {
    root: project.root,
    maxFileBytes: defaults.maxFileBytes,
    readOnly: defaults.readOnly || project.readOnly,
    exec: {
      enabled: defaults.exec.enabled && project.execEnabled,
      timeoutMs: defaults.exec.timeoutMs,
      allow: defaults.exec.allow,
      deny: defaults.exec.deny,
    },
    projectSlug: project.slug,
    projectName: project.name,
  };
}
