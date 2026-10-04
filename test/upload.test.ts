import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveUploadedFile, chatGptFileSchema, type UploadArgs } from "../src/tools/upload.js";
import { downloadFile } from "../src/util/file-download.js";
import { makeTempDir, makeConfig, cleanup, withClient, callTool, toolText } from "./helpers.js";

vi.mock("../src/util/file-download.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/file-download.js")>();
  return { ...actual, downloadFile: vi.fn() };
});

// Includes a PNG signature, NUL and high-bit bytes: must NOT pass through UTF-8.
const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,255,128,1,2,3]);
const sha = createHash("sha256").update(bytes).digest("hex");
const file = { download_url: "https://example.com/image.png?private=not-for-logs", file_id: "file-test", file_name: "source.png", mime_type: "image/png" };
let root: string;
const fakeLoad = vi.mocked(downloadFile);

beforeEach(() => {
  root = makeTempDir("rsb-upload-");
  fakeLoad.mockReset();
  fakeLoad.mockResolvedValue({ data: bytes, mimeType: "image/png" });
});
afterEach(() => cleanup(root));

function args(overrides: Partial<UploadArgs> = {}): UploadArgs {
  return { file, path: "photo.png", ...overrides };
}

describe("binary file upload", () => {
  it("preserves original bytes and returns their SHA-256", async () => {
    const result = await saveUploadedFile(makeConfig(root), args({ path: "assets/photo.png", createDirs: true, expectedSha256: sha }));
    expect(result).toEqual({ path: "assets/photo.png", bytes: bytes.length, sha256: sha, mimeType: "image/png" });
    expect(fs.readFileSync(path.join(root, "assets/photo.png"))).toEqual(bytes);
    expect(fs.readdirSync(path.join(root, "assets"))).toEqual(["photo.png"]);
  });
  it("refuses overwrite by default before downloading", async () => {
    fs.writeFileSync(path.join(root, "photo.png"), "original");
    await expect(saveUploadedFile(makeConfig(root), args())).rejects.toThrow("already exists");
    expect(fakeLoad).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "photo.png"), "utf8")).toBe("original");
  });
  it("supports explicit overwrite without changing source bytes", async () => {
    fs.writeFileSync(path.join(root, "photo.png"), "original");
    await saveUploadedFile(makeConfig(root), args({ overwrite: true }));
    expect(fs.readFileSync(path.join(root, "photo.png"))).toEqual(bytes);
    expect(fs.readdirSync(root)).toEqual(["photo.png"]);
  });
  it("does not replace a file on a digest mismatch", async () => {
    fs.writeFileSync(path.join(root, "photo.png"), "original");
    await expect(saveUploadedFile(makeConfig(root), args({ overwrite: true, expectedSha256: "0".repeat(64) }))).rejects.toThrow("SHA-256 mismatch");
    expect(fs.readFileSync(path.join(root, "photo.png"), "utf8")).toBe("original");
  });
  it("checks size even if an injected loader fails to enforce it", async () => {
    await expect(saveUploadedFile(makeConfig(root, { maxFileBytes: bytes.length - 1 }), args())).rejects.toThrow("limit");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("requires createDirs for missing directories", async () => {
    await expect(saveUploadedFile(makeConfig(root), args({ path: "missing/photo.png" }))).rejects.toThrow("createDirs");
    expect(fakeLoad).not.toHaveBeenCalled();
  });
  it("does not leave files or directories after a failed download", async () => {
    fakeLoad.mockRejectedValueOnce(new Error("File download timed out"));
    await expect(saveUploadedFile(makeConfig(root), args({ path: "new/photo.png", createDirs: true }))).rejects.toThrow("timed out");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("refuses readonly projects before network access", async () => {
    await expect(saveUploadedFile(makeConfig(root, { readOnly: true }), args())).rejects.toThrow("read-only");
    expect(fakeLoad).not.toHaveBeenCalled();
  });
  it("rejects directories as a destination", async () => {
    fs.mkdirSync(path.join(root, "photo.png"));
    await expect(saveUploadedFile(makeConfig(root), args({ overwrite: true }))).rejects.toThrow("regular file");
  });
  it.each(["../escape.png", "nested/../../escape.png", "/tmp/file.png", "C:\\file.png", "\\\\server\\share\\file.png", ".", "..", "", "file.png:stream", "NUL", "aux.png", "COM1.txt", "file.png.", "file.png ", "a//b.png", "a/./b.png", "bad\0name"])("rejects unsafe destination %j", async (target) => {
    await expect(saveUploadedFile(makeConfig(root), args({ path: target, createDirs: true }))).rejects.toThrow();
    expect(fakeLoad).not.toHaveBeenCalled();
  });
  it("rejects a symlink/junction that escapes the project", async () => {
    const outside = makeTempDir("rsb-upload-outside-");
    try {
      fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      await expect(saveUploadedFile(makeConfig(root), args({ path: "escape/photo.png" }))).rejects.toThrow("escapes sandbox");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally { cleanup(outside); }
  });
  it("only permits one competing non-overwrite publication", async () => {
    const results = await Promise.allSettled([
      saveUploadedFile(makeConfig(root), args()),
      saveUploadedFile(makeConfig(root), args()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "photo.png"))).toEqual(bytes);
    expect(fs.readdirSync(root)).toEqual(["photo.png"]);
  });
});

describe("MCP and ChatGPT file-input integration", () => {
  it("accepts host file inputs with or without optional metadata", () => {
    expect(chatGptFileSchema.parse({ file_id: "f", download_url: "https://example.com/f" })).toBeDefined();
    expect(chatGptFileSchema.safeParse({ file_id: "f" }).success).toBe(false);
    expect(chatGptFileSchema.safeParse("/mnt/data/f.png").success).toBe(false);
  });
  it("advertises valid fileParams metadata and exact required file fields", async () => {
    await withClient(makeConfig(root), async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "fs_upload")!;
      expect(tool).toBeDefined();
      expect(tool._meta?.["openai/fileParams"]).toEqual(["file"]);
      const schema = (tool.inputSchema.properties as any).file;
      expect(Object.keys(schema.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
      expect([...schema.required].sort()).toEqual(["download_url", "file_id"]);
      expect(tool.outputSchema).toBeDefined();
    });
  });
  it("uploads via tools/call and returns a verifiable receipt", async () => {
    await withClient(makeConfig(root), async (client) => {
      const result = await callTool(client, "fs_upload", { file, path: "photo.png", expectedSha256: sha });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(toolText(result))).toMatchObject({ sha256: sha, bytes: bytes.length, path: "photo.png" });
      expect(toolText(result)).not.toContain("download_url");
      expect(toolText(result)).not.toContain("private=not-for-logs");
      expect(fs.readFileSync(path.join(root, "photo.png"))).toEqual(bytes);
    });
  });
  it("converts upload errors to normal MCP error results", async () => {
    await withClient(makeConfig(root), async (client) => {
      const result = await callTool(client, "fs_upload", { file, path: "../escape.png" });
      expect(result.isError).toBe(true);
      expect(fakeLoad).not.toHaveBeenCalled();
    });
  });
  it("does not expose fs_upload in readonly projects", async () => {
    await withClient(makeConfig(root, { readOnly: true }), async (client) => {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "fs_upload")).toBe(false);
    });
  });
});
