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

export const RESERVED_SLUGS = ["admin", "api", "health", "mcp"];
const SLUG_RE = /^[a-z0-9-]{2,32}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && !RESERVED_SLUGS.includes(s);
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
  return isValidSlug(s) ? s : "project";
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
  projects: Project[];
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  root: string;
  readOnly?: boolean;
  execEnabled?: boolean;
  /** Internal use (seeding): explicit token instead of a generated one. */
  token?: string;
}

export interface UpdateProjectInput {
  name?: string;
  root?: string;
  readOnly?: boolean;
  execEnabled?: boolean;
}

export class ProjectsStore {
  private filePath: string;
  private projects: Project[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.projects = [];
      return;
    }
    let data: PersistedData;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedData;
    } catch (e) {
      throw new Error(`Cannot parse projects file ${this.filePath}: ${(e as Error).message}`);
    }
    this.projects = Array.isArray(data.projects) ? data.projects : [];
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: PersistedData = { version: 1, projects: this.projects };
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

  private uniqueSlug(base: string): string {
    const stem = isValidSlug(base) ? base : "project";
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
    let slug: string;
    if (input.slug !== undefined && input.slug !== "") {
      if (!SLUG_RE.test(input.slug)) {
        throw new StoreError(400, `invalid slug "${input.slug}": must match [a-z0-9-], 2-32 chars`);
      }
      if (RESERVED_SLUGS.includes(input.slug)) {
        throw new StoreError(400, `slug "${input.slug}" is reserved`);
      }
      if (this.getBySlug(input.slug)) {
        throw new StoreError(409, `slug "${input.slug}" already exists`);
      }
      slug = input.slug;
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
    this.save();
    return { ...project };
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const idx = this.projects.findIndex((x) => x.id === id);
    if (idx === -1) throw new StoreError(404, `project not found: ${id}`);
    const p = { ...this.projects[idx] };
    if (patch.name !== undefined) p.name = validateName(patch.name);
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
    this.projects.splice(idx, 1);
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
 * the legacy single-sandbox configuration so existing connector configs keep
 * working. Returns null when the store already has projects.
 */
export function seedDefaultProject(
  store: ProjectsStore,
  seed: { root: string; token: string | null; readOnly: boolean; execEnabled: boolean },
): SeedResult | null {
  if (store.list().length > 0) return null;
  const tokenGenerated = !seed.token;
  const project = store.create({
    name: "Default",
    slug: "default",
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
