import crypto from "node:crypto";

function sha256(s: string): Buffer {
  return crypto.createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time secret comparison (hashed first so length never leaks). */
export function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}