import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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
      expect(slugify("中文 项目")).toBe("project"); // non-ASCII falls back
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
      expect(isValidSlug("admin")).toBe(false);
      expect(isValidSlug("api")).toBe(false);
      expect(isValidSlug("health")).toBe(false);
      expect(isValidSlug("mcp")).toBe(false);

      expect(() => store.create({ name: "x", slug: "admin", root: dir })).toThrow(StoreError);
      expect(() => store.create({ name: "x", slug: "Bad_Slug", root: dir })).toThrow(StoreError);
      expect(() => store.create({ name: "x", slug: "a", root: dir })).toThrow(StoreError);

      store.create({ name: "x", slug: "taken", root: dir });
      expect(() => store.create({ name: "y", slug: "taken", root: dir })).toThrowError(/already exists/);
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
