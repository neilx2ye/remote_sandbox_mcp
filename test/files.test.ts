import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { callTool, cleanup, makeConfig, makeTempDir, toolText, withClient } from "./helpers.js";

function setup(): { root: string; config: ReturnType<typeof makeConfig> } {
  const root = makeTempDir();
  return { root, config: makeConfig(root) };
}

describe("fs tools round-trip", () => {
  it("write -> read -> edit -> move -> list -> delete", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        // write
        let res = await callTool(client, "fs_write", { path: "notes/hello.txt", content: "hello world\nsecond line\n", createDirs: true });
        expect(res.isError).toBeFalsy();
        expect(fs.readFileSync(path.join(root, "notes", "hello.txt"), "utf8")).toBe("hello world\nsecond line\n");

        // read with line numbers
        res = await callTool(client, "fs_read", { path: "notes/hello.txt" });
        const text = toolText(res);
        expect(res.isError).toBeFalsy();
        expect(text).toContain("1\thello world");
        expect(text).toContain("2\tsecond line");

        // read paging
        res = await callTool(client, "fs_read", { path: "notes/hello.txt", offset: 1, limit: 1 });
        expect(toolText(res)).toContain("2\tsecond line");
        expect(toolText(res)).not.toContain("1\thello world");

        // edit
        res = await callTool(client, "fs_edit", {
          path: "notes/hello.txt",
          edits: [{ oldText: "hello world", newText: "hi there" }],
        });
        expect(res.isError).toBeFalsy();
        expect(fs.readFileSync(path.join(root, "notes", "hello.txt"), "utf8")).toContain("hi there");

        // move
        res = await callTool(client, "fs_move", { from: "notes/hello.txt", to: "greeting.txt" });
        expect(res.isError).toBeFalsy();
        expect(fs.existsSync(path.join(root, "greeting.txt"))).toBe(true);
        expect(fs.existsSync(path.join(root, "notes", "hello.txt"))).toBe(false);

        // mkdir
        res = await callTool(client, "fs_mkdir", { path: "deep/nested/dir" });
        expect(res.isError).toBeFalsy();
        expect(fs.statSync(path.join(root, "deep", "nested", "dir")).isDirectory()).toBe(true);

        // list
        res = await callTool(client, "fs_list", { path: "." });
        const listing = toolText(res);
        expect(res.isError).toBeFalsy();
        expect(listing).toContain("greeting.txt");
        expect(listing).toContain("notes");
        expect(listing).toContain("deep");

        // delete (file + non-empty dir requiring recursive)
        res = await callTool(client, "fs_delete", { path: "greeting.txt" });
        expect(res.isError).toBeFalsy();
        res = await callTool(client, "fs_delete", { path: "notes" });
        expect(res.isError).toBeFalsy(); // empty now
        res = await callTool(client, "fs_delete", { path: "deep" });
        expect(res.isError).toBeTruthy(); // non-empty without recursive
        res = await callTool(client, "fs_delete", { path: "deep", recursive: true });
        expect(res.isError).toBeFalsy();
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_write without createDirs fails when parent is missing", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "fs_write", { path: "no/such/dir/f.txt", content: "x" });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toContain("createDirs");
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_read rejects paths outside the sandbox", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        let res = await callTool(client, "fs_read", { path: "../outside.txt" });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toMatch(/escapes sandbox/);
        const outside = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";
        res = await callTool(client, "fs_read", { path: outside });
        expect(res.isError).toBeTruthy();
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_read rejects binary files", async () => {
    const { root, config } = setup();
    try {
      fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
      await withClient(config, async (client) => {
        const res = await callTool(client, "fs_read", { path: "bin.dat" });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toContain("binary");
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_edit is atomic: a failing second edit leaves the file unchanged", async () => {
    const { root, config } = setup();
    try {
      const original = "alpha beta gamma\n";
      fs.writeFileSync(path.join(root, "f.txt"), original);
      await withClient(config, async (client) => {
        const res = await callTool(client, "fs_edit", {
          path: "f.txt",
          edits: [
            { oldText: "alpha", newText: "ALPHA" },
            { oldText: "does-not-exist", newText: "x" },
          ],
        });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toContain("no changes were written");
        expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe(original);
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_edit requires unique oldText unless replaceAll", async () => {
    const { root, config } = setup();
    try {
      fs.writeFileSync(path.join(root, "f.txt"), "foo bar foo\n");
      await withClient(config, async (client) => {
        let res = await callTool(client, "fs_edit", {
          path: "f.txt",
          edits: [{ oldText: "foo", newText: "baz" }],
        });
        expect(res.isError).toBeTruthy();
        expect(toolText(res)).toContain("occurs 2 times");

        res = await callTool(client, "fs_edit", {
          path: "f.txt",
          edits: [{ oldText: "foo", newText: "baz", replaceAll: true }],
        });
        expect(res.isError).toBeFalsy();
        expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("baz bar baz\n");
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_delete refuses to delete the sandbox root", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "fs_delete", { path: ".", recursive: true });
        expect(res.isError).toBeTruthy();
        expect(fs.existsSync(root)).toBe(true);
      });
    } finally {
      cleanup(root);
    }
  });

  it("fs_search finds matching lines with file:line format", async () => {
    const { root, config } = setup();
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n");
      fs.writeFileSync(path.join(root, "src", "b.md"), "needle in markdown\n");
      fs.writeFileSync(path.join(root, "c.txt"), "nothing here\n");
      await withClient(config, async (client) => {
        let res = await callTool(client, "fs_search", { pattern: "needle" });
        const text = toolText(res);
        expect(res.isError).toBeFalsy();
        expect(text).toContain("src/a.ts:1:");
        expect(text).toContain("src/b.md:1:");
        expect(text).not.toContain("c.txt");

        // with glob filter
        res = await callTool(client, "fs_search", { pattern: "needle", fileGlob: "*.ts" });
        const filtered = toolText(res);
        expect(filtered).toContain("src/a.ts:1:");
        expect(filtered).not.toContain("b.md");

        // invalid regex -> error
        res = await callTool(client, "fs_search", { pattern: "([" });
        expect(res.isError).toBeTruthy();
      });
    } finally {
      cleanup(root);
    }
  });

  it("read-only mode only exposes read tools", async () => {
    const { root } = setup();
    const config = makeConfig(root, { readOnly: true });
    try {
      await withClient(config, async (client) => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(["fs_list", "fs_read", "fs_search", "sys_info"]);
      });
    } finally {
      cleanup(root);
    }
  });

  it("exec disabled mode hides exec_run", async () => {
    const { root } = setup();
    const config = makeConfig(root, { exec: { enabled: false, timeoutMs: 5000, allow: [], deny: [] } });
    try {
      await withClient(config, async (client) => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).not.toContain("exec_run");
        expect(names).toContain("fs_write");
      });
    } finally {
      cleanup(root);
    }
  });

  it("sys_info reports platform and modes", async () => {
    const { root, config } = setup();
    try {
      await withClient(config, async (client) => {
        const res = await callTool(client, "sys_info");
        const info = JSON.parse(toolText(res));
        expect(info.platform).toBe(process.platform);
        expect(info.sandboxRoot).toBe(config.root);
        expect(info.readOnly).toBe(false);
        expect(info.execEnabled).toBe(true);
      });
    } finally {
      cleanup(root);
    }
  });
});
