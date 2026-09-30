import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinRoot, resolveWithinRoot, toRelPosix, SandboxError } from "../src/sandbox.js";
import { cleanup, makeTempDir } from "./helpers.js";

const isWin = process.platform === "win32";

describe("resolveWithinRoot", () => {
  it("resolves plain relative paths inside root", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      const p = resolveWithinRoot(root, "a/b/c.txt");
      expect(p).toBe(path.join(root, "a", "b", "c.txt"));
      expect(toRelPosix(root, p)).toBe("a/b/c.txt");
    } finally {
      cleanup(root);
    }
  });

  it("resolves '.' to the root itself", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      expect(resolveWithinRoot(root, ".")).toBe(root);
    } finally {
      cleanup(root);
    }
  });

  it("rejects ../ escapes", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      expect(() => resolveWithinRoot(root, "../evil.txt")).toThrow(SandboxError);
      expect(() => resolveWithinRoot(root, "sub/../../evil.txt")).toThrow(SandboxError);
      expect(() => resolveWithinRoot(root, "..")).toThrow(SandboxError);
    } finally {
      cleanup(root);
    }
  });

  it("rejects absolute paths outside root", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      const outside = isWin ? "C:\\Windows\\win.ini" : "/etc/passwd";
      expect(() => resolveWithinRoot(root, outside)).toThrow(SandboxError);
    } finally {
      cleanup(root);
    }
  });

  it("rejects absolute paths that are a sibling sharing the root prefix", () => {
    const base = makeTempDir();
    const root = path.join(base, "root");
    fs.mkdirSync(root);
    const realRoot = fs.realpathSync(root);
    try {
      expect(() => resolveWithinRoot(realRoot, path.join(base, "rootEvil", "x.txt"))).toThrow(SandboxError);
      expect(isWithinRoot(realRoot, path.join(base, "rootEvil"))).toBe(false);
      expect(isWithinRoot(realRoot, path.join(realRoot, "ok"))).toBe(true);
    } finally {
      cleanup(base);
    }
  });

  it("accepts absolute paths inside root", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      const inside = path.join(root, "sub", "f.txt");
      expect(resolveWithinRoot(root, inside)).toBe(inside);
    } finally {
      cleanup(root);
    }
  });

  it("rejects symlinked directories escaping root (existing file)", () => {
    const root = fs.realpathSync(makeTempDir());
    const outside = fs.realpathSync(makeTempDir());
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
      const linkType = isWin ? "junction" : "dir";
      fs.symlinkSync(outside, path.join(root, "link"), linkType);
      expect(() => resolveWithinRoot(root, "link/secret.txt")).toThrow(SandboxError);
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  });

  it("rejects symlinked directories escaping root (new file under link)", () => {
    const root = fs.realpathSync(makeTempDir());
    const outside = fs.realpathSync(makeTempDir());
    try {
      const linkType = isWin ? "junction" : "dir";
      fs.symlinkSync(outside, path.join(root, "link"), linkType);
      // 'newfile.txt' does not exist yet: nearest-existing-ancestor check must catch it.
      expect(() => resolveWithinRoot(root, "link/newfile.txt")).toThrow(SandboxError);
      expect(() => resolveWithinRoot(root, "link/deeper/and/deeper.txt")).toThrow(SandboxError);
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  });

  it("rejects symlinked files escaping root", () => {
    if (isWin) {
      // File symlinks on Windows need elevated privileges; junctions cover dirs.
      return;
    }
    const root = fs.realpathSync(makeTempDir());
    const outside = fs.realpathSync(makeTempDir());
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "x");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "f.txt"));
      expect(() => resolveWithinRoot(root, "f.txt")).toThrow(SandboxError);
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  });

  it("allows symlinks that stay inside root", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      fs.mkdirSync(path.join(root, "real"));
      fs.writeFileSync(path.join(root, "real", "f.txt"), "data");
      const linkType = isWin ? "junction" : "dir";
      fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"), linkType);
      const p = resolveWithinRoot(root, "alias/f.txt");
      expect(fs.readFileSync(p, "utf8")).toBe("data");
    } finally {
      cleanup(root);
    }
  });

  if (isWin) {
    it("compares case-insensitively on win32", () => {
      const root = fs.realpathSync(makeTempDir());
      try {
        fs.mkdirSync(path.join(root, "Foo"));
        fs.writeFileSync(path.join(root, "Foo", "Bar.txt"), "x");
        const p = resolveWithinRoot(root, "fOO/bAR.txt");
        expect(fs.readFileSync(p, "utf8")).toBe("x");
        expect(isWithinRoot(root.toUpperCase(), path.join(root, "x").toUpperCase())).toBe(true);
      } finally {
        cleanup(root);
      }
    });

    it("rejects cross-drive absolute paths", () => {
      const root = fs.realpathSync(makeTempDir());
      try {
        // Even a non-existent drive must be rejected lexically.
        expect(() => resolveWithinRoot(root, "Z:\\evil\\x.txt")).toThrow(SandboxError);
      } finally {
        cleanup(root);
      }
    });
  }

  it("rejects NUL bytes and empty paths", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      expect(() => resolveWithinRoot(root, "")).toThrow(SandboxError);
      expect(() => resolveWithinRoot(root, "a\0b")).toThrow(SandboxError);
    } finally {
      cleanup(root);
    }
  });

  it("keeps relative posix output stable", () => {
    const root = fs.realpathSync(makeTempDir());
    try {
      expect(toRelPosix(root, path.join(root, "a", "b"))).toBe("a/b");
      expect(toRelPosix(root, root)).toBe(".");
    } finally {
      cleanup(root);
    }
  });
});
