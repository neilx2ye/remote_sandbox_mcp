import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isMcpEndpointSlug,
  isValidSlug,
  maskToken,
  ProjectsStore,
  scopeForProject,
  seedDefaultProject,
  slugify,
  StoreError,
} from "../src/projects.js";
import { cleanup, makeTempDir } from "./helpers.js";

function newStore(): { dir: string; store: ProjectsStore; file: string } {
  const dir = makeTempDir();
  const file = path.join(dir, "data", "projects.json");
  return { dir, store: new ProjectsStore(file), file };
}

/** Run `fn` and return the StoreError it threw; fail if it threw nothing. */
function storeError(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error("expected a StoreError, but the call succeeded");
}

describe("ProjectsStore", () => {
  it("creates, lists, gets, updates and deletes projects", () => {
    const { dir, store } = newStore();
    try {
      const p = store.create({ name: "Alpha", root: dir });
      expect(p.id).toBeTruthy();
      expect(p.slug).toBe("alpha");
      expect(p.token.length).toBeGreaterThan(20);
      expect(p.readOnly).toBe(false);
      expect(p.execEnabled).toBe(true);
      expect(fs.realpathSync(dir)).toBe(p.root);

      expect(store.list()).toHaveLength(1);
      expect(store.get(p.id)?.name).toBe("Alpha");
      expect(store.getBySlug("alpha")?.id).toBe(p.id);

      const updated = store.update(p.id, { name: "Alpha 2", readOnly: true, execEnabled: false });
      expect(updated.name).toBe("Alpha 2");
      expect(updated.readOnly).toBe(true);
      expect(updated.execEnabled).toBe(false);

      expect(store.remove(p.id)).toBe(true);
      expect(store.list()).toHaveLength(0);
      expect(store.remove(p.id)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("derives slugs from names and keeps them unique", () => {
    const { dir, store } = newStore();
    try {
      expect(slugify("My Cool Project!")).toBe("my-cool-project");
      // Names with no usable ASCII fall back to a random "proj-<4 hex>" stem.
      expect(slugify("中文 项目")).toMatch(/^proj-[0-9a-f]{4}$/);
      const a = store.create({ name: "Dup", root: dir });
      const b = store.create({ name: "Dup", root: dir });
      const c = store.create({ name: "Dup", root: dir });
      expect([a.slug, b.slug, c.slug]).toEqual(["dup", "dup-2", "dup-3"]);
    } finally {
      cleanup(dir);
    }
  });

  it("validates explicit slugs", () => {
    const { dir, store } = newStore();
    try {
      expect(isValidSlug("ok-slug-1")).toBe(true);
      expect(isValidSlug("a")).toBe(false);
      expect(isValidSlug("Upper")).toBe(false);
      for (const reserved of ["admin", "api", "health", "mcp", "oauth"]) {
        expect(isValidSlug(reserved)).toBe(false);
      }

      for (const reserved of ["admin", "oauth"]) {
        const err = storeError(() => store.create({ name: "x", slug: reserved, root: dir }));
        expect(err.status).toBe(400);
        expect(err.message).toMatch(/reserved/);
      }

      const badCharset = storeError(() => store.create({ name: "x", slug: "Bad_Slug", root: dir }));
      expect(badCharset.status).toBe(400);
      expect(badCharset.message).toMatch(/must match/);
      expect(() => store.create({ name: "x", slug: "a", root: dir })).toThrow(StoreError);

      store.create({ name: "x", slug: "taken", root: dir });
      const dup = storeError(() => store.create({ name: "y", slug: "taken", root: dir }));
      expect(dup.status).toBe(409);
      expect(dup.message).toMatch(/already used by/);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects invalid roots", () => {
    const { dir, store } = newStore();
    try {
      expect(() => store.create({ name: "x", root: path.join(dir, "does-not-exist") })).toThrowError(/does not exist/);
      const filePath = path.join(dir, "a-file.txt");
      fs.writeFileSync(filePath, "x");
      expect(() => store.create({ name: "x", root: filePath })).toThrowError(/not a directory/);
      expect(() => store.create({ name: "x", root: "" })).toThrow(StoreError);
    } finally {
      cleanup(dir);
    }
  });

  it("regenerates tokens", () => {
    const { dir, store } = newStore();
    try {
      const p = store.create({ name: "tok", root: dir });
      const regenerated = store.regenerateToken(p.id);
      expect(regenerated.token).not.toBe(p.token);
      expect(regenerated.token.length).toBeGreaterThan(20);
      expect(store.get(p.id)?.token).toBe(regenerated.token);
    } finally {
      cleanup(dir);
    }
  });

  it("persists to disk and reloads", () => {
    const { dir, store, file } = newStore();
    try {
      store.create({ name: "persisted", root: dir, readOnly: true });
      expect(fs.existsSync(file)).toBe(true);
      const fresh = new ProjectsStore(file);
      expect(fresh.list()).toHaveLength(1);
      expect(fresh.getBySlug("persisted")?.readOnly).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("masks tokens for list responses", () => {
    expect(maskToken("abcdefghijklmnopqrstuvwxyz")).toBe("abcd****wxyz");
    expect(maskToken("short")).toBe("****");
  });
});

describe("seedDefaultProject (migration)", () => {
  it("seeds the default project with the legacy token", () => {
    const { dir, store } = newStore();
    try {
      const seedRoot = path.join(dir, "legacy-sandbox");
      fs.mkdirSync(seedRoot);
      const result = seedDefaultProject(store, {
        root: seedRoot,
        token: "legacy-token-123",
        readOnly: false,
        execEnabled: true,
      });
      expect(result).not.toBeNull();
      expect(result!.tokenGenerated).toBe(false);
      expect(result!.project.slug).toBe("default");
      expect(result!.project.token).toBe("legacy-token-123");
      expect(result!.project.root).toBe(fs.realpathSync(seedRoot));
      // ...and /mcp is assigned to it, so both /default and /mcp serve this project.
      expect(store.getDefault()?.id).toBe(result!.project.id);
    } finally {
      cleanup(dir);
    }
  });

  it("generates a token when the legacy config had none", () => {
    const { dir, store } = newStore();
    try {
      const result = seedDefaultProject(store, { root: dir, token: null, readOnly: false, execEnabled: true });
      expect(result!.tokenGenerated).toBe(true);
      expect(result!.project.token.length).toBeGreaterThan(20);
    } finally {
      cleanup(dir);
    }
  });

  it("does nothing when projects already exist", () => {
    const { dir, store } = newStore();
    try {
      store.create({ name: "existing", root: dir });
      const result = seedDefaultProject(store, { root: dir, token: "x".repeat(32), readOnly: false, execEnabled: true });
      expect(result).toBeNull();
      expect(store.list()).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });
});

describe("projects store: bare /mcp designation", () => {
  it("falls back to the legacy 'default' slug when nothing is designated", () => {
    const { dir, store } = newStore();
    try {
      const d = store.create({ name: "Default", slug: "default", root: dir });
      store.create({ name: "Other", root: dir });
      expect(store.getDefault()?.id).toBe(d.id);
    } finally {
      cleanup(dir);
    }
  });

  it("has no default when neither a designation nor a 'default' project exists", () => {
    const { dir, store } = newStore();
    try {
      store.create({ name: "Only", root: dir });
      expect(store.getDefault()).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("designates any project and persists the choice", () => {
    const { dir, store, file } = newStore();
    try {
      store.create({ name: "Default", slug: "default", root: dir });
      const ops = store.create({ name: "Ops", slug: "ops", root: dir });
      expect(store.setDefault(ops.id).slug).toBe("ops");
      expect(store.getDefault()?.id).toBe(ops.id);

      const fresh = new ProjectsStore(file);
      expect(fresh.getDefault()?.slug).toBe("ops");
      expect(fresh.getBySlug("ops")?.id).toBe(ops.id); // own slug keeps working
    } finally {
      cleanup(dir);
    }
  });

  it("reads slug '/mcp' as a request to bind the new project to the bare endpoint", () => {
    const { dir, store } = newStore();
    try {
      expect(isMcpEndpointSlug("/mcp")).toBe(true);
      expect(isMcpEndpointSlug(" mcp ")).toBe(true);
      expect(isMcpEndpointSlug("my-project")).toBe(false);

      const p = store.create({ name: "Ops", slug: "/mcp", root: dir });
      expect(p.slug).toBe("ops"); // the slug is still derived from the name
      expect(store.getDefault()?.id).toBe(p.id);
      expect(store.getBySlug("ops")?.id).toBe(p.id); // /ops keeps working

      // "mcp" alone works too, and moves the binding.
      const q = store.create({ name: "Second", slug: "mcp", root: dir });
      expect(q.slug).toBe("second");
      expect(store.getDefault()?.id).toBe(q.id);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects unknown ids and drops the designation when that project is deleted", () => {
    const { dir, store } = newStore();
    try {
      expect(() => store.setDefault("no-such-id")).toThrow(StoreError);
      const ops = store.create({ name: "Ops", slug: "ops", root: dir });
      store.setDefault(ops.id);
      store.remove(ops.id);
      expect(store.getDefault()).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });
});

describe("projects store: endpoint renames", () => {
  it("renames a project's endpoint and follows it with the /mcp assignment", () => {
    const { dir, store, file } = newStore();
    try {
      const p = store.create({ name: "Default", slug: "default", root: dir });
      store.setDefault(p.id);
      expect(store.getDefault()?.id).toBe(p.id);

      const renamed = store.update(p.id, { slug: "renamed-x" });
      expect(renamed.slug).toBe("renamed-x");
      expect(store.getBySlug("default")).toBeUndefined();
      expect(store.getBySlug("renamed-x")?.id).toBe(p.id);
      // /mcp now points at the renamed slug.
      expect(store.getDefault()?.slug).toBe("renamed-x");

      const fresh = new ProjectsStore(file);
      expect(fresh.getBySlug("renamed-x")?.id).toBe(p.id);
      expect(fresh.getDefault()?.slug).toBe("renamed-x");
    } finally {
      cleanup(dir);
    }
  });

  it("leaves the /mcp assignment alone when a different project is renamed", () => {
    const { dir, store } = newStore();
    try {
      const d = store.create({ name: "Default", slug: "default", root: dir });
      const other = store.create({ name: "Other", slug: "other", root: dir });
      store.setDefault(d.id);

      store.update(other.id, { slug: "other-2" });
      expect(store.getDefault()?.id).toBe(d.id);
      expect(store.getDefault()?.slug).toBe("default");
      expect(store.getBySlug("other")).toBeUndefined();
      expect(store.getBySlug("other-2")?.id).toBe(other.id);
    } finally {
      cleanup(dir);
    }
  });

  it("reads slug 'mcp' on update as 'assign /mcp' without renaming the endpoint", () => {
    const { dir, store } = newStore();
    try {
      const a = store.create({ name: "Alpha", slug: "alpha", root: dir });
      const b = store.create({ name: "Beta", slug: "beta", root: dir });
      store.setDefault(a.id);

      const updated = store.update(b.id, { slug: "mcp" });
      expect(updated.slug).toBe("beta"); // endpoint untouched
      expect(store.getBySlug("beta")?.id).toBe(b.id);
      expect(store.getDefault()?.id).toBe(b.id);
      expect(store.getDefault()?.slug).toBe("beta");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects reserved, colliding, empty and unknown renames", () => {
    const { dir, store } = newStore();
    try {
      const a = store.create({ name: "Alpha", slug: "alpha", root: dir });
      const b = store.create({ name: "Beta", slug: "beta", root: dir });

      // Each of these is either reserved, too short, or outside the slug charset.
      for (const reserved of ["admin", "oauth", "api", "health", "a", "Bad Slug"]) {
        const err = storeError(() => store.update(b.id, { slug: reserved }));
        expect(err.status).toBe(400);
        expect(store.get(b.id)?.slug).toBe("beta");
      }

      expect(storeError(() => store.update(b.id, { slug: "" })).status).toBe(400);

      const dup = storeError(() => store.update(b.id, { slug: a.slug }));
      expect(dup.status).toBe(409);
      expect(dup.message).toMatch(/already used by/);
      expect(store.get(b.id)?.slug).toBe("beta");

      // Renaming to the project's own current slug is a no-op, not a collision.
      expect(store.update(b.id, { slug: "beta" }).slug).toBe("beta");

      expect(() => store.update("no-such-id", { slug: "wherever" })).toThrow(StoreError);
    } finally {
      cleanup(dir);
    }
  });
});

describe("scopeForProject", () => {
  it("combines project settings with global defaults and master switches", () => {
    const { dir, store } = newStore();
    try {
      const p = store.create({ name: "scope-proj", root: dir, readOnly: false, execEnabled: true });
      const scope = scopeForProject(p, {
        maxFileBytes: 1234,
        exec: { enabled: true, timeoutMs: 999, allow: ["^node"], deny: [] },
        readOnly: false,
      });
      expect(scope.root).toBe(p.root);
      expect(scope.maxFileBytes).toBe(1234);
      expect(scope.exec.timeoutMs).toBe(999);
      expect(scope.exec.allow).toEqual(["^node"]);
      expect(scope.readOnly).toBe(false);
      expect(scope.exec.enabled).toBe(true);
      expect(scope.projectSlug).toBe("scope-proj");
      expect(scope.projectName).toBe("scope-proj");

      // master readOnly wins
      const scopeRo = scopeForProject(p, { maxFileBytes: 1, exec: { enabled: true, timeoutMs: 1, allow: [], deny: [] }, readOnly: true });
      expect(scopeRo.readOnly).toBe(true);

      // master exec off wins
      const scopeNoExec = scopeForProject(p, { maxFileBytes: 1, exec: { enabled: false, timeoutMs: 1, allow: [], deny: [] }, readOnly: false });
      expect(scopeNoExec.exec.enabled).toBe(false);

      // project execEnabled=false wins too
      const p2 = store.create({ name: "s2", root: dir, execEnabled: false });
      const scope2 = scopeForProject(p2, { maxFileBytes: 1, exec: { enabled: true, timeoutMs: 1, allow: [], deny: [] }, readOnly: false });
      expect(scope2.exec.enabled).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
