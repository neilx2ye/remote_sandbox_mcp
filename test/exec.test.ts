import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/tools/exec.js";
import { callTool, cleanup, makeConfig, makeTempDir, toolText, withClient } from "./helpers.js";

const isWin = process.platform === "win32";

function setup(): { root: string; config: ReturnType<typeof makeConfig> } {
  const root = makeTempDir();
  return { root, config: makeConfig(root) };
}

describe("checkCommand built-in blocking", () => {
  const { root, config } = setup();
  const cwd = root;

  it("blocks destructive commands", () => {
    const blocked = [
      "rm -rf /",
      "rm -rf / ",
      "rm -fr /",
      "sudo rm -rf / --no-preserve-root",
      "mkfs /dev/sda1",
      "mkfs.ext4 /dev/sda",
      "format C: /q",
      "shutdown /s /t 0",
      "shutdown -h now",
      "reboot",
      "halt",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      ":(){:|:&};:",
    ];
    for (const cmd of blocked) {
      expect(checkCommand(cmd, config, cwd).ok, `should block: ${cmd}`).toBe(false);
    }
  });

  it("blocks redirects to absolute paths outside the sandbox", () => {
    const outside = isWin ? "C:/Windows/temp-evil.txt" : "/etc/evil.txt";
    expect(checkCommand(`echo x > ${outside}`, config, cwd).ok).toBe(false);
    expect(checkCommand(`echo x >> "${outside}"`, config, cwd).ok).toBe(false);
  });

  it("allows redirects inside the sandbox and relative redirects", () => {
    const inside = path.join(root, "out.txt").split(path.sep).join("/");
    expect(checkCommand(`echo x > ${inside}`, config, cwd).ok).toBe(true);
    expect(checkCommand("echo x > out.txt", config, cwd).ok).toBe(true);
    expect(checkCommand("echo x >> sub/out.txt", config, cwd).ok).toBe(true);
  });

  it("allows ordinary commands", () => {
    const allowed = ["node --version", "npm test", "dir", "ls -la", "echo hello", "git status", "rm -rf node_modules", "rm -rf ./build"];
    for (const cmd of allowed) {
      expect(checkCommand(cmd, config, cwd).ok, `should allow: ${cmd}`).toBe(true);
    }
  });

  it("exec.allow whitelist restricts to matching commands only", () => {
    const cfg = makeConfig(root, { exec: { enabled: true, timeoutMs: 5000, allow: ["^node ", "^npm "], deny: [] } });
    expect(checkCommand("node --version", cfg, cwd).ok).toBe(true);
    expect(checkCommand("npm test", cfg, cwd).ok).toBe(true);
    expect(checkCommand("git status", cfg, cwd).ok).toBe(false);
    expect(checkCommand("echo hi", cfg, cwd).ok).toBe(false);
  });

  it("exec.deny blocks additional patterns", () => {
    const cfg = makeConfig(root, { exec: { enabled: true, timeoutMs: 5000, allow: [], deny: ["\\bgit\\s+push\\b"] } });
    expect(checkCommand("git push origin main", cfg, cwd).ok).toBe(false);
    expect(checkCommand("git status", cfg, cwd).ok).toBe(true);
  });
});

describe("exec_run tool", () => {
  it("runs a simple command and captures stdout", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "exec_run", { command: "node --version" });
        expect(res.isError).toBeFalsy();
        const text = toolText(res);
        expect(text).toContain("exit code: 0");
        expect(text).toMatch(/v\d+\.\d+\.\d+/);
      });
    } finally {
      cleanup(root);
    }
  });

  it("reports non-zero exit codes without isError", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "exec_run", { command: "node --definitely-not-a-flag" });
        const text = toolText(res);
        expect(res.isError).toBeFalsy();
        expect(text).toMatch(/exit code: [1-9]/);
      });
    } finally {
      cleanup(root);
    }
  });

  it("kills commands that exceed the timeout", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const slow = isWin ? "ping -n 6 127.0.0.1" : "sleep 5";
        const res = await callTool(client, "exec_run", { command: slow, timeoutMs: 800 });
        expect(res.isError).toBeFalsy();
        expect(toolText(res)).toContain("TIMEOUT");
      });
    } finally {
      cleanup(root);
    }
  }, 20000);

  it("rejects dangerous commands through the tool", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "exec_run", { command: "rm -rf /" });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toContain("rejected");
      });
    } finally {
      cleanup(root);
    }
  });

  it("confines cwd to the sandbox", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "exec_run", { command: "echo hi", cwd: ".." });
        expect(res.isError).toBeTruthy();
      });
    } finally {
      cleanup(root);
    }
  });

  it("does not leak MCP_TOKEN to the child environment", async () => {
    const { root, config } = setup();
    process.env.MCP_TOKEN = "super-secret-token";
    try {
      await withClient(config, async (client) => {
        const cmd = isWin ? "echo %MCP_TOKEN%" : "echo \"${MCP_TOKEN:-unset}\"";
        const res = await callTool(client, "exec_run", { command: cmd });
        const text = toolText(res);
        expect(res.isError).toBeFalsy();
        expect(text).not.toContain("super-secret-token");
      });
    } finally {
      delete process.env.MCP_TOKEN;
      cleanup(root);
    }
  });
});
