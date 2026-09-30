import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolScope } from "../config.js";
import { resolveWithinRoot, toRelPosix, isWithinRoot } from "../sandbox.js";
import { truncateUtf8 } from "../util/text.js";
import type { RegisterTool } from "../server.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 300_000;

/** Best-effort static blocking of obviously destructive commands. */
const BUILTIN_DENY: RegExp[] = [
  /\brm\b[^|&;]*\s-?[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+\/+(?:\s|$)/, // rm -rf / (and -fr, -r variants)
  /\brm\b[^|&;]*\s-?[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/+(?:\s|$)/,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bwipefs\b/i,
  /\bformat\b\s+[a-zA-Z]:/i, // format C:
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bdd\b[^|&;]*\bof=\/dev\//,
  /\b(mkpart|fdisk|diskpart)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
  /\b(bcdedit|bootrec)\b/i,
];

const ALLOWED_ENV_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "OS",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

function minimalEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface ExecVerdict {
  ok: boolean;
  reason?: string;
}

export function checkCommand(command: string, config: ToolScope, cwdAbs: string): ExecVerdict {
  for (const re of BUILTIN_DENY) {
    if (re.test(command)) {
      return { ok: false, reason: `blocked by built-in safety rule (${re.source})` };
    }
  }
  for (const pattern of config.exec.deny) {
    if (new RegExp(pattern).test(command)) {
      return { ok: false, reason: `blocked by exec.deny rule: ${pattern}` };
    }
  }
  if (config.exec.allow.length > 0) {
    const matched = config.exec.allow.some((p) => new RegExp(p).test(command));
    if (!matched) {
      return { ok: false, reason: "not matched by any exec.allow whitelist rule" };
    }
  }
  // Redirects to absolute paths must stay inside the sandbox.
  const redirectRe = />>?\s*("[^"]+"|'[^']+'|[^\s|&;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(command)) !== null) {
    const target = m[1].replace(/^["']|["']$/g, "");
    if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("/")) {
      const resolved = path.resolve(cwdAbs, target);
      if (!isWithinRoot(config.root, resolved)) {
        return { ok: false, reason: `redirect target escapes sandbox: ${target}` };
      }
    }
  }
  return { ok: true };
}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Collect at most this many bytes per stream; output is truncated to 64KB on return. */
const COLLECT_CAP = 1024 * 1024;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill /T kills the whole process tree of the shell.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => {});
  } else {
    // Child was spawned detached, so it leads its own process group.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd,
        env: minimalEnv(),
        windowsHide: true,
        detached: !isWin,
      });
    } catch (e) {
      rejectPromise(e);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout?.on("data", (c: Buffer) => {
      if (stdoutSize < COLLECT_CAP) stdoutChunks.push(c);
      stdoutSize += c.length;
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderrSize < COLLECT_CAP) stderrChunks.push(c);
      stderrSize += c.length;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Failed to start shell ${shell}: ${e.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = truncateUtf8(Buffer.concat(stdoutChunks).toString("utf8"), MAX_OUTPUT_BYTES);
      const stderr = truncateUtf8(Buffer.concat(stderrChunks).toString("utf8"), MAX_OUTPUT_BYTES);
      resolvePromise({
        code,
        timedOut,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

export function registerExecTools(server: McpServer, config: ToolScope, wrap: RegisterTool): void {
  server.registerTool(
    "exec_run",
    {
      description:
        "Run a shell command inside the sandbox (cmd.exe on Windows, sh elsewhere). cwd is confined to the sandbox. Timeout default 30s (max 300s); stdout/stderr truncated to 64KB each. Destructive commands are blocked; the environment is a minimal variable set without secrets.",
      inputSchema: {
        command: z.string().min(1).describe("Command line to execute."),
        cwd: z.string().optional().describe("Working directory inside the sandbox (default: sandbox root)."),
        timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default 30000, max 300000)."),
      },
    },
    wrap("exec_run", (a) => a.command.slice(0, 200), async (args) => {
      const cwdAbs = resolveWithinRoot(config.root, args.cwd ?? ".");
      const st = (await import("node:fs")).statSync(cwdAbs);
      if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${args.cwd ?? "."}`);

      const verdict = checkCommand(args.command, config, cwdAbs);
      if (!verdict.ok) {
        throw new Error(`Command rejected: ${verdict.reason}`);
      }

      const timeoutMs = Math.min(args.timeoutMs ?? config.exec.timeoutMs, MAX_TIMEOUT_MS);
      const result = await runShell(args.command, cwdAbs, timeoutMs);

      const parts: string[] = [];
      parts.push(`cwd: ${toRelPosix(config.root, cwdAbs)}`);
      parts.push(result.timedOut ? `status: TIMEOUT after ${timeoutMs}ms` : `exit code: ${result.code ?? "(terminated by signal)"}`);
      parts.push(`--- stdout${result.stdoutTruncated ? " (truncated to 64KB)" : ""} ---`);
      parts.push(result.stdout || "(empty)");
      parts.push(`--- stderr${result.stderrTruncated ? " (truncated to 64KB)" : ""} ---`);
      parts.push(result.stderr || "(empty)");
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    }),
  );
}
