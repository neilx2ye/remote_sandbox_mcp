import fs from "node:fs";
import path from "node:path";

/**
 * Sandbox path fencing. All user-supplied paths must resolve inside `root`.
 *
 * - `path.resolve(root, input)` handles relative paths, absolute paths and
 *   drive-letter paths; anything that escapes root after resolution is rejected.
 * - Existing paths are canonicalized with fs.realpath (resolves symlinks and
 *   Windows junctions) so a symlink inside root pointing outside is caught.
 * - For paths that do not exist yet, the nearest existing ancestor directory
 *   is canonicalized and the remaining segments appended, so a new file placed
 *   under a symlinked directory is still caught.
 * - Final check: canonical path must equal root or start with root + path.sep.
 *   On win32 both sides are compared lower-cased (case-insensitive FS).
 */

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const isWin = process.platform === "win32";

function normalizeForCompare(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const r = normalizeForCompare(root);
  const c = normalizeForCompare(candidate);
  return c === r || c.startsWith(r + path.sep);
}

function nearestExistingAncestor(abs: string): { ancestor: string; rest: string[] } {
  let current = abs;
  const rest: string[] = [];
  // Walk up until an existing path is found (at worst the filesystem root).
  for (;;) {
    try {
      fs.lstatSync(current);
      return { ancestor: current, rest };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without anything existing (should not happen).
        return { ancestor: current, rest };
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve `input` (relative to root or absolute) to a canonical absolute path
 * guaranteed to be inside `root`. Throws SandboxError otherwise.
 */
export function resolveWithinRoot(root: string, input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SandboxError("Path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new SandboxError("Path contains NUL byte");
  }

  const abs = path.resolve(root, input);

  // Cheap lexical check first (catches plain ../ escapes before any IO).
  if (!isWithinRoot(root, abs)) {
    throw new SandboxError(`Path escapes sandbox root: ${input}`);
  }

  // Canonicalize: realpath the path itself if it exists, else its nearest
  // existing ancestor, then re-append the non-existent tail.
  let canonical: string;
  try {
    fs.lstatSync(abs);
    canonical = realpathOrSelf(abs);
  } catch {
    const { ancestor, rest } = nearestExistingAncestor(abs);
    const realAncestor = realpathOrSelf(ancestor);
    canonical = path.join(realAncestor, ...rest);
  }

  if (!isWithinRoot(root, canonical)) {
    throw new SandboxError(`Path escapes sandbox root (via link): ${input}`);
  }
  return canonical;
}

/** Convert an absolute path inside root to a POSIX-style relative path. */
export function toRelPosix(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (rel === "") return ".";
  return rel.split(path.sep).join("/");
}
