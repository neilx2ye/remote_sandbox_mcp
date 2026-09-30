import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolScope } from "../config.js";
import { resolveWithinRoot, toRelPosix } from "../sandbox.js";
import { looksBinary } from "../util/text.js";
import type { RegisterTool } from "../server.js";

const MAX_MATCHES = 500;
const MAX_FILES_SCANNED = 5000;

/** Convert a simple glob (`*`, `?`, `**`) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  const hasSlash = glob.includes("/");
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any leading directories; bare `**` matches everything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  // Basename globs (no slash) may match at any depth.
  return new RegExp(hasSlash ? `^${out}$` : `(?:^|/)${out}$`, process.platform === "win32" ? "i" : "");
}

export function registerSearchTools(server: McpServer, config: ToolScope, wrap: RegisterTool): void {
  const root = config.root;

  server.registerTool(
    "fs_search",
    {
      description:
        "Search file contents with a regular expression inside the sandbox. Returns file:line: matching-line. Optionally filter file names with a glob (e.g. '*.ts' or 'src/**/*.ts'). Symlinks are skipped. Limits: 500 matches, 5000 files scanned.",
      inputSchema: {
        pattern: z.string().min(1).describe("Regular expression to search for (matches per line)."),
        path: z.string().optional().describe("Directory (or file) to search in, relative to sandbox root (default: whole sandbox)."),
        fileGlob: z.string().optional().describe("Only search files whose name/path matches this glob."),
      },
    },
    wrap("fs_search", (a) => `${a.pattern} in ${a.path ?? "."}`, async (args) => {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern);
      } catch (e) {
        throw new Error(`Invalid regular expression: ${(e as Error).message}`);
      }
      const globRe = args.fileGlob ? globToRegExp(args.fileGlob) : null;
      const startAbs = resolveWithinRoot(root, args.path ?? ".");
      if (!fs.existsSync(startAbs)) throw new Error(`Path does not exist: ${args.path ?? "."}`);

      const matches: string[] = [];
      let filesScanned = 0;
      let matchTruncated = false;
      let fileLimitHit = false;

      const considerFile = (abs: string): boolean => {
        // returns false when the global match limit has been reached
        if (matches.length >= MAX_MATCHES) {
          matchTruncated = true;
          return false;
        }
        if (filesScanned >= MAX_FILES_SCANNED) {
          fileLimitHit = true;
          return false;
        }
        const rel = toRelPosix(root, abs);
        if (globRe && !globRe.test(rel)) return true;
        filesScanned++;
        let buf: Buffer;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile() || st.size > config.maxFileBytes) return true;
          buf = fs.readFileSync(abs);
        } catch {
          return true;
        }
        if (looksBinary(buf)) return true;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const line = lines[i].length > 500 ? lines[i].slice(0, 500) + "…" : lines[i];
            matches.push(`${rel}:${i + 1}: ${line}`);
            if (matches.length >= MAX_MATCHES) {
              matchTruncated = true;
              return false;
            }
          }
        }
        return true;
      };

      const startStat = fs.lstatSync(startAbs);
      if (startStat.isFile()) {
        considerFile(startAbs);
      } else if (startStat.isDirectory()) {
        const stack: string[] = [startAbs];
        let stop = false;
        while (stack.length > 0 && !stop) {
          const dir = stack.pop()!;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const ent of entries) {
            if (ent.isSymbolicLink()) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              stack.push(full);
            } else if (ent.isFile()) {
              if (!considerFile(full)) {
                stop = true;
                break;
              }
            }
          }
        }
      } else {
        throw new Error(`Not a file or directory: ${args.path ?? "."}`);
      }

      const notes: string[] = [];
      if (matchTruncated) notes.push(`match limit ${MAX_MATCHES} reached (truncated)`);
      if (fileLimitHit) notes.push(`file scan limit ${MAX_FILES_SCANNED} reached (truncated)`);
      const header = `# ${matches.length} match(es) in ${filesScanned} file(s) scanned${notes.length ? ` — ${notes.join("; ")}` : ""}`;
      return { content: [{ type: "text" as const, text: [header, ...matches].join("\n") }] };
    }),
  );
}
