import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolScope } from "../config.js";
import { resolveWithinRoot, toRelPosix } from "../sandbox.js";
import { downloadFile, type DownloadedFile } from "../util/file-download.js";
import type { RegisterTool } from "../server.js";

// All four properties must be declared; only download_url and file_id required.
// https://developers.openai.com/plugins/reference#define-file-inputs
export const chatGptFileSchema = z.object({
  download_url: z.string().describe("Temporary download URL supplied by the ChatGPT file runtime."),
  file_id: z.string().describe("File identifier supplied by ChatGPT."),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

export const uploadInputSchema = {
  file: chatGptFileSchema.describe("Conversation upload or generated file to transfer. Pass a file reference, not its contents or base64."),
  path: z.string().min(1).max(2048).describe("Destination filename relative to the CURRENT project root, for example assets/photo.png."),
  createDirs: z.boolean().optional().describe("Create missing destination directories (default false)."),
  overwrite: z.boolean().optional().describe("Replace an existing file only when explicitly requested (default false)."),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Optional SHA-256 of the source bytes; reject a mismatch without changing the destination."),
};

export interface UploadArgs {
  file: z.infer<typeof chatGptFileSchema>;
  path: string;
  createDirs?: boolean;
  overwrite?: boolean;
  expectedSha256?: string;
}
export interface UploadReceipt { path: string; bytes: number; sha256: string; mimeType: string; }
export type FileLoader = (url: string, maxBytes: number) => Promise<DownloadedFile>;

function destination(scope: ToolScope, input: string): string {
  // Prevent Windows device names, alternate data streams, absolute/UNC paths,
  // and ambiguous trailing dots/spaces even when tests run on another OS.
  const parts = input.split(/[\\/]/);
  if (!input || path.isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith("\\") ||
      /[\x00-\x1f:<>"|?*]/.test(input) || parts.some((p) => !p || p === "." || p === ".." ||
        /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("Destination must be an unambiguous relative file path inside the current project");
  }
  return resolveWithinRoot(scope.root, input);
}

function checkExisting(abs: string, overwrite: boolean): void {
  if (!fs.existsSync(abs)) return;
  if (!fs.statSync(abs).isFile()) throw new Error("Destination is not a regular file");
  if (!overwrite) throw new Error("Destination already exists; set overwrite=true only to explicitly replace it");
}

/** Download, verify, then publish atomically. No partially downloaded final file. */
export async function saveUploadedFile(scope: ToolScope, args: UploadArgs, load: FileLoader = downloadFile): Promise<UploadReceipt> {
  if (scope.readOnly) throw new Error("File upload is disabled for read-only projects");
  const abs = destination(scope, args.path);
  checkExisting(abs, args.overwrite ?? false);
  const parent = path.dirname(abs);
  if (!fs.existsSync(parent) && !args.createDirs) throw new Error("Destination directory does not exist; set createDirs=true");
  if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) throw new Error("Destination parent is not a directory");

  const { data, mimeType } = await load(args.file.download_url, scope.maxFileBytes);
  if (data.length > scope.maxFileBytes) throw new Error(`File exceeds the ${scope.maxFileBytes}-byte limit`);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (args.expectedSha256 && args.expectedSha256.toLowerCase() !== sha256) {
    throw new Error("SHA-256 mismatch; no destination file was changed");
  }
  // Revalidate the sandbox after the network operation before creating/writing.
  if (destination(scope, args.path) !== abs) throw new Error("Destination changed during download; retry the upload");
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  if (resolveWithinRoot(scope.root, args.path) !== abs) throw new Error("Destination changed before writing");
  checkExisting(abs, args.overwrite ?? false);
  const tmp = path.join(parent, `.upload-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (args.overwrite) {
      fs.renameSync(tmp, abs);
    } else {
      // Hard-link publication fails atomically if another writer created abs.
      fs.linkSync(tmp, abs);
      fs.unlinkSync(tmp);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return { path: toRelPosix(scope.root, abs), bytes: data.length, sha256, mimeType };
}

export function registerUploadTools(server: McpServer, scope: ToolScope, wrap: RegisterTool): void {
  if (scope.readOnly) return;
  server.registerTool("fs_upload", {
    title: "Upload file to project",
    description: "Upload a conversation image, generated image, PDF, or other binary/text file into the CURRENT project's sandbox. Uses the host-provided file reference, preserves original bytes, checks the configured size limit and optional SHA-256, and refuses overwrites by default. No base64 and no public file-sharing service required.",
    inputSchema: uploadInputSchema,
    outputSchema: { path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string(), mimeType: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, wrap("fs_upload", (a: UploadArgs) => a.path, async (args: UploadArgs) => {
    const receipt = await saveUploadedFile(scope, args);
    return { content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }], structuredContent: receipt };
  }));
}
