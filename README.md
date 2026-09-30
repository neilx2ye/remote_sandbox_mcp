# remote-sandbox-mcp

一个 **MCP（Model Context Protocol）服务器**：让网页版 AI（Claude.ai、ChatGPT、Kimi 网页版等支持自定义 MCP 连接器的客户端）通过 HTTPS 隧道远程连接你的电脑，在**指定项目目录**内完成文件读写、搜索和受控命令执行。

**多项目架构**：每个项目是一个独立沙盒（root 可指向整台设备任意目录），拥有独立 MCP 端点 `/mcp/<slug>` 和独立 token；另带一个 **Web 管理台**（`/admin`）用于管理项目、生成 token、浏览与预览项目文件。

同一套代码无需修改即可运行在 **Windows 和 Linux**（纯 Node.js 内置 API，无任何原生模块，管理台为原生 JS、无 CDN 依赖）。

```
                        ┌─────────────────────────────────────────────┐
 网页版 AI ──HTTPS──> 隧道 ──> 127.0.0.1:8787                          │
                        │   ├─ /mcp         → default 项目沙盒 (token A)│
                        │   ├─ /mcp/web-app → 项目 web-app 沙盒(token B)│
                        │   ├─ /mcp/<slug>  → ...每项目独立围栏+token   │
                        │   ├─ /api/*       → 管理 API (admin token)    │
                        │   └─ /admin       → Web 管理台 (静态文件)      │
                        └─────────────────────────────────────────────┘
              每个项目: 路径围栏(resolveWithinRoot) + 符号链接检测 + 审计 JSONL
```

⚠️ **安全第一原则**：隧道只应暴露 `/mcp*` 路径；`/admin` 和 `/api` 只通过本机或 SSH 端口转发访问（见下文「隧道与安全暴露」）。

## 功能一览

### MCP 工具（每个项目端点均提供）

| 工具 | 参数 | 说明 |
|---|---|---|
| `sys_info` | — | 返回项目名/slug、平台/arch/Node 版本/沙盒根/模式 |
| `fs_list` | `path`, `recursive?` | 列目录（类型/大小/修改时间），上限 2000 条 |
| `fs_read` | `path`, `offset?`, `limit?` | 读文本文件（带行号、分页），二进制拒绝 |
| `fs_write` | `path`, `content`, `createDirs?` | 新建或整体覆写 |
| `fs_edit` | `path`, `edits[]` | 精确替换，多处编辑按序应用，**全部成功才落盘** |
| `fs_delete` | `path`, `recursive?` | 删文件/目录 |
| `fs_move` | `from`, `to`, `overwrite?` | 移动/重命名 |
| `fs_mkdir` | `path` | 建目录 |
| `fs_search` | `pattern`, `path?`, `fileGlob?` | 内容正则 + 文件名 glob，返回 `文件:行号: 行` |
| `exec_run` | `command`, `cwd?`, `timeoutMs?` | 受控命令执行（危险命令拦截/超时树杀/输出截断） |

只读项目仅暴露 `sys_info`/`fs_list`/`fs_read`/`fs_search`；`execEnabled=false` 的项目不暴露 `exec_run`。

### Web 管理台（`/admin`）

- 项目 CRUD：新建（名称/root/slug 可选/只读/exec 开关）、编辑、删除（只删登记不动磁盘）
- token 管理：列表掩码显示、点击查看完整值、一键重新生成（旧 token 立即失效）
- 每个项目显示 MCP 端点路径 `/mcp/<slug>` + 复制按钮
- 文件浏览：面包屑导航、目录列表、文本（带行号）/图片预览，二进制提示不支持

## 快速开始

要求 Node.js ≥ 20（建议 22/24）。

```bash
npm install
npm run build
npm start                    # 默认 127.0.0.1:8787
```

首次启动会**自动播种一个 slug 为 `default` 的项目**（root 来自 `--root`/`MCP_ROOT`/配置文件 `root`，默认 `./sandbox`；token 来自 `--token`/`MCP_TOKEN`/配置文件 `token`，都没有则随机生成并醒目打印）。旧版单沙盒配置（`sandbox.config.json` 里的 root+token）会被原样继承，**已有连接器配置不会失效**——`/mcp` 始终映射到 `default` 项目。

同时，若未配置 admin token，会随机生成并醒目打印：

```
  NO ADMIN TOKEN WAS CONFIGURED - generated a random one:
    MCP_ADMIN_TOKEN = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

打开管理台：**http://127.0.0.1:8787/admin** ，输入上面的 admin token 登录，即可创建更多项目。

建议把两个 token 固定下来（任选其一）：

```bash
# 环境变量
export MCP_TOKEN="项目default的固定token"
export MCP_ADMIN_TOKEN="管理台固定token"
npm start

# 或 CLI
node dist/index.js --token "..." --admin-token "..."
```

健康检查（免鉴权）：`curl http://127.0.0.1:8787/health` → `{"ok":true}`

开发模式（免编译）：`npm run dev`；stdio 本地调试（使用 default 项目）：`node dist/index.js --stdio`。

## 配置说明

优先级：**CLI 参数 > 环境变量 > `sandbox.config.json` > 默认值**。

| CLI 参数 | 环境变量 | 配置文件键 | 默认 | 说明 |
|---|---|---|---|---|
| `--root <dir>` | `MCP_ROOT` | `root` | `./sandbox` | **播种用**：default 项目的根目录 |
| `--token <t>` | `MCP_TOKEN` | `token` | 随机生成 | **播种用**：default 项目的 token（持久化在 data/projects.json） |
| `--admin-token <t>` | `MCP_ADMIN_TOKEN` | `adminToken` | 随机生成 | 管理台 / 管理 API 的 token |
| `--port <n>` | `MCP_PORT` | `port` | `8787` | HTTP 端口 |
| `--host <addr>` | `MCP_HOST` | `host` | `127.0.0.1` | 监听地址（不要直接绑 0.0.0.0 公网暴露） |
| `--stdio` | — | — | off | stdio 传输（本地客户端，用 default 项目） |
| `--readonly` | — | `readOnly` | `false` | **总开关**：所有项目只读 |
| `--no-exec` | — | `exec.enabled` | `true` | **总开关**：所有项目禁用 exec_run |
| `--config <path>` | — | — | `./sandbox.config.json` | 指定配置文件 |

项目数据持久化在 `data/projects.json`（含各项目明文 token，威胁模型与旧版配置文件明文 token 一致；该文件已加入 `.gitignore`，请别提交）。`exec.timeoutMs`/`exec.allow`/`exec.deny`/`maxFileBytes` 为全局默认值，对所有项目生效；`readOnly`/`execEnabled` 可按项目单独设置。

> 注意：通过管理台修改项目 root 后，**已建立的 MCP 会话仍按旧围栏运行**（会话在 initialize 时按当时配置创建），让 AI 客户端重新连接即可生效。

## 隧道与安全暴露

服务只监听 `127.0.0.1`。网页版 AI 需要一条带 TLS 的隧道连进来，但**只应暴露 `/mcp` 路径**：

- ✅ 隧道/反代只转发 `/mcp*`（AI 连接器只需要这个）
- ❌ 不要把 `/admin`、`/api` 暴露到公网（管理台能创建指向**任意目录**的项目，权力远大于单个沙盒）
- 🔑 管理台日常访问：`ssh -L 8787:127.0.0.1:8787 user@你的服务器`，然后浏览器开 `http://127.0.0.1:8787/admin`

### cloudflared

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

trycloudflare 免费隧道无法做路径过滤，因此**更推荐用命名隧道 + ingress 规则**，或改走下面的 Caddy 方案。若临时使用 trycloudflare，请自知 `/admin` 页面本身无鉴权但所有数据接口都有 admin token 保护，且用完即关。

### Caddy 反代示例（只暴露 /mcp*）

在你自己的域名/VPS 上：

```caddyfile
mcp.example.com {
    @mcp path /mcp /mcp/*
    reverse_proxy @mcp 127.0.0.1:8787
    respond 404
}
```

这样 `https://mcp.example.com/mcp/<slug>` 可达，而 `/admin`、`/api` 在公网一律 404。

### ngrok

```bash
ngrok http 8787          # 免费档无路径过滤，注意事项同 cloudflared 临时隧道
```

### frp（自建 VPS）

同旧版：`type = "http"` 转发 8787 到你的域名，TLS 由前置 nginx/Caddy 终止；同样建议在前置层只放行 `/mcp`。

## 在网页版 AI 中添加连接器

**每个项目一个连接器**：URL 为 `https://<隧道域名>/mcp/<slug>`（default 项目也可以直接用 `/mcp`），token 用**该项目自己的 token**（管理台项目卡片上 👁 查看 + 复制）。

- **请求头**（推荐）：`Authorization: Bearer <项目token>`
- **URL 参数**（客户端不支持自定义头时）：`https://<隧道域名>/mcp/<slug>?token=<项目token>` ⚠️ token 会出现在 URL 里

### Claude.ai

设置 → 连接器（Connectors）→ 添加自定义连接器 → URL 填 `https://<隧道域名>/mcp/<slug>`，高级设置里加 `Authorization: Bearer <项目token>`（或拼 `?token=`）。每个项目重复添加一次即可。

### ChatGPT

设置 → Apps & Connectors → 高级设置 → 开 Developer mode → 新建 MCP 连接器，URL 同上，按需配置鉴权。

### Kimi 网页版

对话/设置中的 MCP 工具入口 → 添加自定义 MCP 服务器 → 类型 Streamable HTTP → URL 同上（需要时拼 `?token=`）。

> 各产品 UI 随版本调整，以官方文档为准；关键要素：Streamable HTTP + `/mcp/<slug>` 端点 + 该项目 token。

## 本地调试

```bash
npx @modelcontextprotocol/inspector node dist/index.js --stdio
```

或用 Inspector 的 Streamable HTTP 传输连 `http://127.0.0.1:8787/mcp/<slug>`（填项目 token）。

curl 手动验证（initialize 必须带 `Accept: application/json, text/event-stream`）：

```bash
curl -i http://127.0.0.1:8787/mcp/<slug> \
  -H "Authorization: Bearer <项目token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
# 响应头取 mcp-session-id，后续请求带上
```

## 管理 API 一览（全部要求 `Authorization: Bearer <adminToken>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表（token 掩码 `abcd****wxyz`） |
| POST | `/api/projects` | 创建 `{name, slug?, root, readOnly?, execEnabled?}`，响应含完整 token（仅此一次） |
| GET | `/api/projects/:id` | 详情（含完整 token） |
| PATCH | `/api/projects/:id` | 改 `{name?, root?, readOnly?, execEnabled?}` |
| POST | `/api/projects/:id/regenerate-token` | 重新生成 token（旧值立即失效） |
| DELETE | `/api/projects/:id` | 删除登记（不动磁盘文件） |
| GET | `/api/projects/:id/files?path=` | 目录列表（围栏内，上限 2000 条） |
| GET | `/api/projects/:id/file?path=` | 文件预览：文本/SVG → JSON；位图 → 字节流；其它二进制 → `{kind:"binary"}`；上限 min(maxFileBytes, 2MB) |

## 安全设计与注意事项

1. **两类 token 分开保密**：项目 token（AI 连接器用，泄露 = 该项目沙盒开放）和 admin token（管理台用，泄露 = 能创建指向**任意目录**的新项目，等同整机文件访问）。都别提交进 git。
2. **`/admin`、`/api` 不上公网**：见「隧道与安全暴露」。项目 token 鉴权保护不了管理接口，管理接口由 admin token 保护，但纵深防御要求它根本不该被公网到达。
3. **路径围栏**：每个项目的所有文件操作（MCP 工具和管理 API 的文件浏览）都经 `resolveWithinRoot` 强制限制在该项目 root 内——`../`、绝对路径、符号链接/junction 逃逸全部拒绝（Windows 下大小写不敏感比较）。项目 root 可指向设备任意位置是**特性**，请只把真正要让 AI 碰的目录登记为项目。
4. **会话隔离**：MCP 会话绑定创建时的 slug，跨 slug 复用会话 ID 返回 403。
5. **按需降级**：项目级只读/exec 开关 + 全局 `--readonly`/`--no-exec` 总开关；生产建议配 `exec.allow` 白名单。
6. **内置危险命令拦截**（`rm -rf /`、`mkfs`、`format`、`shutdown` 等）只是兜底，不能替代白名单。
7. **资源限制**：单文件 ≤ `maxFileBytes`（默认 5MB）、目录列举 ≤ 2000 条、搜索 ≤ 500 命中、命令超时默认 30s（上限 300s）、stdout/stderr 各截断 64KB、管理台预览 ≤ 2MB。
8. **子进程环境隔离**：`exec_run` 只继承最小环境变量集（PATH/HOME/USERPROFILE/SystemRoot/TEMP 等），不会泄露任何 token。
9. **审计**：每次工具调用追加一行 JSON 到 `logs/audit.jsonl`（项目目录下、沙盒之外），含时间戳、会话、**项目 slug**、工具名、目标、成败与耗时。

## 常驻运行

### Linux（systemd）

`/etc/systemd/system/remote-sandbox-mcp.service`：

```ini
[Unit]
Description=remote-sandbox-mcp
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/remote-sandbox-mcp
Environment=MCP_TOKEN=default项目token
Environment=MCP_ADMIN_TOKEN=管理台token
ExecStart=/usr/bin/node dist/index.js --port 8787
Restart=on-failure
User=你的低权限用户

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now remote-sandbox-mcp
```

### Windows

开机计划任务，触发器"登录时"，操作：

```
程序: C:\Program Files\nodejs\node.exe
参数: dist\index.js --port 8787
起始位置: C:\path\to\remote_sandbox_mcp
```

或用 [nssm](https://nssm.cc/) 注册为服务：

```powershell
nssm install remote-sandbox-mcp "C:\Program Files\nodejs\node.exe" "dist\index.js --port 8787"
nssm set remote-sandbox-mcp AppDirectory "C:\path\to\remote_sandbox_mcp"
nssm set remote-sandbox-mcp AppEnvironmentExtra MCP_TOKEN=default项目token MCP_ADMIN_TOKEN=管理台token
nssm start remote-sandbox-mcp
```

## Linux 验证清单（跨平台确认）

```bash
node --version          # >= 20
npm install && npm run build && npm test
node dist/index.js --port 8787 &
curl http://127.0.0.1:8787/health
# 管理台创建项目 → /mcp/<slug> 走 initialize → tools/call
# 确认：symlink 逃逸被拒、跨项目 token 401、会话跨 slug 403、rm -rf / 被拦截
```

## 项目结构

```
src/
├── index.ts        # CLI 入口：装配 store、播种迁移、打印端点清单与 token
├── config.ts       # 全局配置（CLI > env > 配置文件 > 默认），含 adminToken 与播种源
├── projects.ts     # Project 模型 + ProjectsStore（data/projects.json）+ 播种 + scope 组装
├── http.ts         # 路由：/health、/mcp/<slug>（会话绑定 slug）、/admin 静态白名单、/api
├── admin.ts        # 管理 API：项目 CRUD、token 重置、文件浏览与预览（复用路径围栏）
├── server.ts       # 每会话 McpServer 工厂（项目级 scope）
├── sandbox.ts      # 路径围栏核心：resolveWithinRoot / realpath / 链接逃逸检测
├── tools/
│   ├── files.ts    # fs_list/fs_read/fs_write/fs_edit/fs_delete/fs_move/fs_mkdir
│   ├── search.ts   # fs_search
│   └── exec.ts     # exec_run：平台 shell、树杀超时、输出截断、危险命令拦截
└── util/
    ├── text.ts     # UTF-8/二进制探测/行号分页/截断
    └── audit.ts    # logs/audit.jsonl（含 project slug）
public/             # Web 管理台（admin.html/admin.css/admin.js，原生 JS 无框架）
data/projects.json  # 项目登记（运行时生成，勿提交）
test/               # vitest：路径围栏、CRUD、exec、ProjectsStore、HTTP 集成
```
