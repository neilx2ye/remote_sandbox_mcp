import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolScope } from "../config.js";
import { resolveWithinRoot, toRelPosix } from "../sandbox.js";
import { looksBinary, pageLines } from "../util/text.js";
import type { RegisterTool } from "../server.js";

const LIST_LIMIT = 2000;

function formatEntry(root: string, abs: string, st: fs.Stats): string {
  const type = st.isDirectory() ? "d" : st.isFile() ? "f" : "o";
  const size = st.isFile() ? String(st.size) : "-";
  const mtime = st.mtime.toISOString();
  return `${type}\t${size}\t${mtime}\t${toRelPosix(root, abs)}`;
}

function listDir(root: string, abs: string, recursive: boolean): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const stack: string[] = [abs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot list ${toRelPosix(root, dir)}: ${(e as Error).message}`);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (lines.length >= LIST_LIMIT) {
        truncated = true;
        break;
      }
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        lines.push(`l\t-\t-\t${toRelPosix(root, full)}`);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      lines.push(formatEntry(root, full, st));
      if (recursive && ent.isDirectory()) stack.push(full);
    }
    if (truncated) break;
  }
  return { lines, truncated };
}

export function registerFileTools(server: McpServer, config: ToolScope, wrap: RegisterTool): void {
  registerReadFileTools(server, config, wrap);
  registerWriteFileTools(server, config, wrap);
}

/** Read-only file tools: fs_list, fs_read. */
export function registerReadFileTools(server: McpServer, config: ToolScope, wrap: RegisterTool): void {
  const root = config.root;

  server.registerTool(
    "fs_list",
    {
      description:
        "List directory contents inside the sandbox. Output lines: type(d/f/l/o), size, mtime(ISO), relative POSIX path. Directories first.",
      inputSchema: {
        path: z.string().describe("Directory path, relative to sandbox root or absolute inside sandbox. Use '.' for root."),
        recursive: z.boolean().optional().describe("Recurse into subdirectories (default false). Max 2000 entries."),
      },
    },
    wrap("fs_list", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      const st = fs.statSync(abs);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${args.path}`);
      const { lines, truncated } = listDir(root, abs, args.recursive ?? false);
      const header = `# listing ${toRelPosix(root, abs)} (${lines.length} entries${truncated ? `, truncated at ${LIST_LIMIT}` : ""})`;
      return { content: [{ type: "text" as const, text: [header, ...lines].join("\n") || header }] };
    }),
  );

  server.registerTool(
    "fs_read",
    {
      description:
        "Read a UTF-8 text file inside the sandbox with line numbers. Supports paging via offset/limit (lines). Binary files and files over the size limit are rejected.",
      inputSchema: {
        path: z.string().describe("File path, relative to sandbox root or absolute inside sandbox."),
        offset: z.number().int().min(0).optional().describe("Skip this many lines (0-based, default 0)."),
        limit: z.number().int().min(1).optional().describe("Max lines to return (default: all)."),
      },
    },
    wrap("fs_read", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`Not a regular file: ${args.path}`);
      if (st.size > config.maxFileBytes) {
        throw new Error(`File too large: ${st.size} bytes (limit ${config.maxFileBytes})`);
      }
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) throw new Error(`Refusing to read binary file: ${args.path}`);
      const page = pageLines(buf.toString("utf8"), args.offset ?? 0, args.limit);
      const header = `# ${toRelPosix(root, abs)} lines ${page.startLine}-${page.endLine}/${page.totalLines}${page.truncated ? " (truncated, use offset/limit)" : ""}`;
      return { content: [{ type: "text" as const, text: `${header}\n${page.text}` }] };
    }),
  );
}

/** Write file tools: fs_write, fs_edit, fs_delete, fs_move, fs_mkdir. */
export function registerWriteFileTools(server: McpServer, config: ToolScope, wrap: RegisterTool): void {
  const root = config.root;

  server.registerTool(
    "fs_write",
    {
      description:
        "Create a new file or completely overwrite an existing one (UTF-8). Fails if the content exceeds the size limit. Set createDirs to auto-create parent directories.",
      inputSchema: {
        path: z.string().describe("Target file path inside the sandbox."),
        content: z.string().describe("Complete UTF-8 file content."),
        createDirs: z.boolean().optional().describe("Create missing parent directories (default false)."),
      },
    },
    wrap("fs_write", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      const bytes = Buffer.byteLength(args.content, "utf8");
      if (bytes > config.maxFileBytes) {
        throw new Error(`Content too large: ${bytes} bytes (limit ${config.maxFileBytes})`);
      }
      const parent = path.dirname(abs);
      if (!fs.existsSync(parent)) {
        if (!args.createDirs) throw new Error(`Parent directory does not exist: ${toRelPosix(root, parent)} (set createDirs to create it)`);
        fs.mkdirSync(parent, { recursive: true });
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        throw new Error(`Path is a directory: ${args.path}`);
      }
      fs.writeFileSync(abs, args.content, "utf8");
      return { content: [{ type: "text" as const, text: `Wrote ${bytes} bytes to ${toRelPosix(root, abs)}` }] };
    }),
  );

  server.registerTool(
    "fs_edit",
    {
      description:
        "Apply exact string replacements to a text file. All edits are applied in order in memory; the file is only written if every edit succeeds (atomic). oldText must occur exactly once unless replaceAll is set.",
      inputSchema: {
        path: z.string().describe("File path inside the sandbox."),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).describe("Exact text to find."),
              newText: z.string().describe("Replacement text."),
              replaceAll: z.boolean().optional().describe("Replace every occurrence (default false)."),
            }),
          )
          .min(1)
          .describe("Ordered list of edits."),
      },
    },
    wrap("fs_edit", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`Not a regular file: ${args.path}`);
      if (st.size > config.maxFileBytes) {
        throw new Error(`File too large: ${st.size} bytes (limit ${config.maxFileBytes})`);
      }
      const original = fs.readFileSync(abs, "utf8");
      let text = original;
      const summary: string[] = [];
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i];
        const occurrences = text.split(e.oldText).length - 1;
        if (occurrences === 0) {
          throw new Error(`Edit #${i + 1}: oldText not found; no changes were written`);
        }
        if (!e.replaceAll && occurrences > 1) {
          throw new Error(`Edit #${i + 1}: oldText occurs ${occurrences} times (set replaceAll or make it unique); no changes were written`);
        }
        text = text.split(e.oldText).join(e.newText);
        summary.push(`edit #${i + 1}: replaced ${e.replaceAll ? occurrences : 1} occurrence(s)`);
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > config.maxFileBytes) {
        throw new Error(`Edited content too large: ${bytes} bytes (limit ${config.maxFileBytes}); no changes were written`);
      }
      fs.writeFileSync(abs, text, "utf8");
      return { content: [{ type: "text" as const, text: `Updated ${toRelPosix(root, abs)} (${bytes} bytes)\n${summary.join("\n")}` }] };
    }),
  );

  server.registerTool(
    "fs_delete",
    {
      description: "Delete a file or directory inside the sandbox. Non-empty directories require recursive=true. The sandbox root itself cannot be deleted.",
      inputSchema: {
        path: z.string().describe("File or directory path inside the sandbox."),
        recursive: z.boolean().optional().describe("Delete directory contents recursively (required for non-empty directories)."),
      },
    },
    wrap("fs_delete", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      if (abs === root) throw new Error("Refusing to delete the sandbox root");
      const st = fs.lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const children = fs.readdirSync(abs);
        if (children.length > 0 && !args.recursive) {
          throw new Error(`Directory not empty (${children.length} entries); set recursive=true to delete`);
        }
        fs.rmSync(abs, { recursive: true, force: false });
        return { content: [{ type: "text" as const, text: `Deleted directory ${toRelPosix(root, abs)}` }] };
      }
      fs.rmSync(abs, { force: false });
      return { content: [{ type: "text" as const, text: `Deleted ${toRelPosix(root, abs)}` }] };
    }),
  );

  server.registerTool(
    "fs_move",
    {
      description: "Move or rename a file/directory inside the sandbox. Both paths must stay inside the sandbox.",
      inputSchema: {
        from: z.string().describe("Source path inside the sandbox."),
        to: z.string().describe("Destination path inside the sandbox."),
        overwrite: z.boolean().optional().describe("Overwrite destination if it exists (default false)."),
      },
    },
    wrap("fs_move", (a) => `${a.from} -> ${a.to}`, async (args) => {
      const absFrom = resolveWithinRoot(root, args.from);
      const absTo = resolveWithinRoot(root, args.to);
      if (absFrom === root) throw new Error("Refusing to move the sandbox root");
      if (!fs.existsSync(absFrom)) throw new Error(`Source does not exist: ${args.from}`);
      if (fs.existsSync(absTo)) {
        if (!args.overwrite) throw new Error(`Destination exists: ${args.to} (set overwrite to replace)`);
        if (absTo === root) throw new Error("Refusing to overwrite the sandbox root");
        fs.rmSync(absTo, { recursive: true, force: true });
      }
      const parent = path.dirname(absTo);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.renameSync(absFrom, absTo);
      return { content: [{ type: "text" as const, text: `Moved ${toRelPosix(root, absFrom)} -> ${toRelPosix(root, absTo)}` }] };
    }),
  );

  server.registerTool(
    "fs_mkdir",
    {
      description: "Create a directory inside the sandbox (parent directories are created as needed).",
      inputSchema: {
        path: z.string().describe("Directory path inside the sandbox."),
      },
    },
    wrap("fs_mkdir", (a) => a.path, async (args) => {
      const abs = resolveWithinRoot(root, args.path);
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        if (st.isDirectory()) return { content: [{ type: "text" as const, text: `Directory already exists: ${toRelPosix(root, abs)}` }] };
        throw new Error(`Path exists and is not a directory: ${args.path}`);
      }
      fs.mkdirSync(abs, { recursive: true });
      return { content: [{ type: "text" as const, text: `Created directory ${toRelPosix(root, abs)}` }] };
    }),
  );
}
