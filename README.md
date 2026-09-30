# remote-sandbox-mcp

一个 **MCP（Model Context Protocol）服务器**：让网页版 AI（Claude.ai、ChatGPT、Kimi 网页版等支持自定义 MCP 连接器的客户端）通过 HTTPS 隧道远程连接你的电脑，在**指定项目目录**内完成文件读写、搜索和受控命令执行。

**多项目架构**：每个项目是一个独立沙盒（root 可指向整台设备任意目录），拥有独立 MCP 端点 `/mcp/<slug>` 和独立 token；另带一个 **Web 管理台**（`/admin`）用于管理项目、生成 token、浏览与预览项目文件，以及查看/撤销 OAuth 授权。连接器鉴权支持两条路：粘贴项目 token，或走 **OAuth 2.1**（授权页里登录并**选择要开放的项目**）。

同一套代码无需修改即可运行在 **Windows 和 Linux**（纯 Node.js 内置 API，无任何原生模块，管理台为原生 JS、无 CDN 依赖）。

```
                        ┌─────────────────────────────────────────────┐
 网页版 AI ──HTTPS──> 隧道 ──> 127.0.0.1:8787                          │
                        │   ├─ /mcp         → default 项目沙盒 (token A)│
                        │   ├─ /mcp/web-app → 项目 web-app 沙盒(token B)│
                        │   ├─ /mcp/<slug>  → ...每项目独立围栏+token   │
                        │   ├─ /.well-known/* + /oauth/* → OAuth 授权   │
                        │   │                 (浏览器里选项目+admin token)│
                        │   ├─ /api/*       → 管理 API (admin token)    │
                        │   └─ /admin       → Web 管理台 (静态文件)      │
                        └─────────────────────────────────────────────┘
              每个项目: 路径围栏(resolveWithinRoot) + 符号链接检测 + 审计 JSONL
```

⚠️ **安全第一原则**：隧道只应暴露 `/mcp*` 和 `/oauth*`、`/.well-known/*`（OAuth 授权用）；`/admin` 和 `/api` 只通过本机或 SSH 端口转发访问（见下文「隧道与安全暴露」）。

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
- OAuth 授权：列出已授权的客户端、各自被授权了哪些项目、最近使用时间，可一键撤销（详见下文「OAuth 认证」）
- 文件浏览：面包屑导航、目录列表、文本（带行号）/图片预览，二进制提示不支持

## OAuth 认证（连接器授权，推荐）

除了给每个连接器粘贴项目 token，也可以让 AI 客户端走标准 **OAuth 2.1**：连接器只填 `https://<隧道域名>/mcp/<slug>`，
**不用复制任何 token**；授权时浏览器会打开本服务的授权页，你用 **Admin Token 登录并选择要开放的项目**，
之后客户端拿到的 access token 只对**那一个项目**有效。

```
AI 客户端（Claude.ai / ChatGPT / …）                       本服务
  ① POST /mcp/<slug>（还没 token）
  ← 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp/<slug>"
  ② GET /.well-known/oauth-protected-resource/mcp/<slug>   资源元数据（resource=该项目端点）
  ③ GET /.well-known/oauth-authorization-server            授权服务器元数据（端点+PKCE S256）
  ④ POST /oauth/register                                   动态注册 → client_id（RFC 7591）
  ⑤ 浏览器打开 /oauth/authorize?…                           授权页：★ 选择项目 + 输入 Admin Token
  ← 302 回调地址?code=…&state=…
  ⑥ POST /oauth/token（code + PKCE code_verifier）          → access_token + refresh_token
  ⑦ POST /mcp/<slug> + Authorization: Bearer <access_token> 正常调用工具
```

### 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | 资源元数据（根路径变体：resource 为 `/mcp` 集合，授权页需手动选项目） |
| GET | `/.well-known/oauth-protected-resource/mcp/<slug>` | 该项目的资源元数据（授权页会预选这个项目） |
| GET | `/.well-known/oauth-authorization-server` | 授权服务器元数据（issuer/端点/`code_challenge_methods_supported: S256`） |
| POST | `/oauth/register` | 动态客户端注册，返回 `client_id`（可选 `client_secret`） |
| GET | `/oauth/authorize` | 授权页（HTML：项目单选 + Admin Token） |
| POST | `/oauth/authorize` | 提交授权/拒绝 → 302 回客户端回调地址 |
| POST | `/oauth/token` | `authorization_code` / `refresh_token` 换令牌 |
| POST | `/oauth/revoke` | 撤销 access/refresh token（RFC 7009） |

### 行为与安全细节

- **项目选择**：`resource` 参数带 `/mcp/<slug>` 时授权页会预选并提示该项目；用根路径元数据（resource=`/mcp`）时由你在页面上选择。所选项目决定令牌的作用范围，跨项目使用会得到 403。
- **令牌生命周期**：access token **1 小时**，refresh token **30 天**（每次刷新轮换，旧的立即失效）；授权码 **5 分钟**、单次使用；仅支持 PKCE `S256`。
- **持久化**：客户端、授权码、令牌都落在 `data/oauth.json`，且**只存 SHA-256 摘要**（明文 token 不落盘），服务重启后连接器无需重新授权。
- **撤销**：管理台「OAuth 授权」卡片可撤销某个客户端的全部授权；项目 token 的「重置 token」与之互不影响。授权/换 token/撤销都会写一行审计（`tool` 为 `oauth.*`）。
- **授权页的登录口令就是 Admin Token**，失败尝试按来源 IP 限流（8 次/5 分钟）；由于授权页需要公网可达，请务必使用高强度 `MCP_ADMIN_TOKEN`。
- 只想用固定 token、完全不开 OAuth：隧道不放行 `/.well-known/*` 与 `/oauth/*` 即可（OAuth 只在这些路径上响应）。

> 本地自测：先 `curl -X POST http://127.0.0.1:8787/oauth/register -H 'Content-Type: application/json' -d '{"client_name":"local","redirect_uris":["http://127.0.0.1:7777/cb"],"token_endpoint_auth_method":"none"}'` 拿到 `client_id`，再在浏览器打开 `/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256`。

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

启动横幅里还会打印各项目的 MCP 端点，以及 OAuth 授权端点（`/.well-known/*`、`/oauth/*`）——用 OAuth 的客户端需要隧道放行这些路径。

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
| `--public-url <url>` | `MCP_PUBLIC_URL` | `publicUrl` | 由请求头推导 | OAuth 元数据里对外公布的地址，如 `https://mcp.example.com`（隧道/CDN 改写 Host 时建议固定） |
| `--config <path>` | — | — | `./sandbox.config.json` | 指定配置文件 |

项目数据持久化在 `data/projects.json`（含各项目明文 token，威胁模型与旧版配置文件明文 token 一致；该文件已加入 `.gitignore`，请别提交）；OAuth 客户端与令牌持久化在 `data/oauth.json`（**只存 SHA-256 摘要**，同样已 gitignore）。`exec.timeoutMs`/`exec.allow`/`exec.deny`/`maxFileBytes` 为全局默认值，对所有项目生效；`readOnly`/`execEnabled` 可按项目单独设置。

> 注意：通过管理台修改项目 root 后，**已建立的 MCP 会话仍按旧围栏运行**（会话在 initialize 时按当时配置创建），让 AI 客户端重新连接即可生效。

## 隧道与安全暴露

服务只监听 `127.0.0.1`。网页版 AI 需要一条带 TLS 的隧道连进来，但只应暴露 AI 客户端真正需要的路径：

- ✅ 隧道/反代转发 `/mcp*`（连接器端点）
- ✅ 用 OAuth 时还要放行 `/.well-known/*` 与 `/oauth/*`（发现元数据 + 授权页 + 换令牌）。不用 OAuth 就不必放行
- ❌ 不要把 `/admin`、`/api` 暴露到公网（管理台能创建指向**任意目录**的项目，权力远大于单个沙盒）
- 🔑 管理台日常访问：`ssh -L 8787:127.0.0.1:8787 user@你的服务器`，然后浏览器开 `http://127.0.0.1:8787/admin`

### cloudflared

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

trycloudflare 免费隧道无法做路径过滤，因此**更推荐用命名隧道 + ingress 规则**，或改走下面的 Caddy 方案。若临时使用 trycloudflare，请自知 `/admin` 页面本身无鉴权但所有数据接口都有 admin token 保护，且用完即关。

### Caddy 反代示例（只暴露 MCP + OAuth）

在你自己的域名/VPS 上：

```caddyfile
mcp.example.com {
    # 连接器端点 + OAuth 发现/授权端点；/admin、/api 一律 404
    @mcp path /mcp /mcp/* /.well-known/* /oauth /oauth/*
    reverse_proxy @mcp 127.0.0.1:8787
    respond 404
}
```

这样 `https://mcp.example.com/mcp/<slug>`（以及 OAuth 授权流程用到的 `/.well-known/*`、`/oauth/*`）可达，而 `/admin`、`/api` 在公网一律 404。想让 OAuth 元数据里的地址稳定（不依赖代理传的 `X-Forwarded-Host`），可加 `--public-url https://mcp.example.com`。

### ngrok

```bash
ngrok http 8787          # 免费档无路径过滤，注意事项同 cloudflared 临时隧道
```

### frp（自建 VPS）

同旧版：`type = "http"` 转发 8787 到你的域名，TLS 由前置 nginx/Caddy 终止；同样建议在前置层只放行 `/mcp`（+ 用 OAuth 时的 `/.well-known`、`/oauth`）。

## 在网页版 AI 中添加连接器

**每个项目一个连接器**：URL 为 `https://<隧道域名>/mcp/<slug>`（default 项目也可以直接用 `/mcp`）。鉴权二选一：

- **OAuth（推荐，免粘贴 token）**：只填 URL，客户端会走 OAuth 并在浏览器弹出授权页（选项目 + 输 Admin Token）。前提是隧道放行了 `/.well-known/*` 与 `/oauth/*`。
- **项目 token**：token 用**该项目自己的 token**（管理台项目卡片上 👁 查看 + 复制）。
  - **请求头**（推荐）：`Authorization: Bearer <项目token>`
  - **URL 参数**（客户端不支持自定义头时）：`https://<隧道域名>/mcp/<slug>?token=<项目token>` ⚠️ token 会出现在 URL 里

### Claude.ai

设置 → 连接器（Connectors）→ 添加自定义连接器 → URL 填 `https://<隧道域名>/mcp/<slug>`；OAuth 可留空直接连接（授权时会打开本服务的授权页），或按旧方式在高级设置里加 `Authorization: Bearer <项目token>`（也可拼 `?token=`）。每个项目重复添加一次即可。

### ChatGPT

设置 → Apps & Connectors → 高级设置 → 开 Developer mode → 新建 MCP 连接器，URL 同上，鉴权同上（支持 OAuth 的版本会直接弹授权页）。

### Kimi 网页版

对话/设置中的 MCP 工具入口 → 添加自定义 MCP 服务器 → 类型 Streamable HTTP → URL 同上（需要时拼 `?token=`）。

> 各产品 UI 随版本调整，以官方文档为准；关键要素：Streamable HTTP + `/mcp/<slug>` 端点 + （OAuth 授权或该项目 token）。

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
| GET | `/api/oauth/clients` | 已授权的 OAuth 客户端（client_id、名称、被授权的项目、有效令牌数、最近使用）+ 汇总 stats |
| DELETE | `/api/oauth/clients/:clientId` | 撤销该客户端：删登记并吊销其全部 access/refresh token |

## 安全设计与注意事项

1. **三类凭证分开保密**：项目 token（AI 连接器用，泄露 = 该项目沙盒开放）、admin token（管理台用，泄露 = 能创建指向**任意目录**的新项目，等同整机文件访问）、OAuth 客户端/令牌（只存在 `data/oauth.json`，且只存摘要）。都别提交进 git。
2. **`/admin`、`/api` 不上公网**：见「隧道与安全暴露」。项目 token 鉴权保护不了管理接口，管理接口由 admin token 保护，但纵深防御要求它根本不该被公网到达。用 OAuth 时公网可达的只有 `/mcp*`、`/.well-known/*`、`/oauth/*`。
3. **OAuth 授权页 = Admin Token 登录框**：`/oauth/authorize` 必须公网可达才能完成授权，因此它是唯一在公网暴露的 admin token 输入口——已按来源 IP 限流（8 次失败/5 分钟），但仍务必使用高强度 `MCP_ADMIN_TOKEN`；不想承担这个面就别放行 `/.well-known/*` 与 `/oauth/*`，继续用固定 token。
4. **OAuth 令牌绑定单个项目**：授权时选中的项目写进令牌，跨项目访问 `/mcp/<other-slug>` 返回 403；`redirect_uri` 必须是客户端注册过的地址（http 仅允许 loopback，防开放重定向），授权码单次使用 + PKCE S256，刷新时轮换 refresh token。
5. **路径围栏**：每个项目的所有文件操作（MCP 工具和管理 API 的文件浏览）都经 `resolveWithinRoot` 强制限制在该项目 root 内——`../`、绝对路径、符号链接/junction 逃逸全部拒绝（Windows 下大小写不敏感比较）。项目 root 可指向设备任意位置是**特性**，请只把真正要让 AI 碰的目录登记为项目。
6. **会话隔离**：MCP 会话绑定创建时的 slug，跨 slug 复用会话 ID 返回 403。
7. **按需降级**：项目级只读/exec 开关 + 全局 `--readonly`/`--no-exec` 总开关；生产建议配 `exec.allow` 白名单。
8. **内置危险命令拦截**（`rm -rf /`、`mkfs`、`format`、`shutdown` 等）只是兜底，不能替代白名单。
9. **资源限制**：单文件 ≤ `maxFileBytes`（默认 5MB）、目录列举 ≤ 2000 条、搜索 ≤ 500 命中、命令超时默认 30s（上限 300s）、stdout/stderr 各截断 64KB、管理台预览 ≤ 2MB。
10. **子进程环境隔离**：`exec_run` 只继承最小环境变量集（PATH/HOME/USERPROFILE/SystemRoot/TEMP 等），不会泄露任何 token。
11. **审计**：每次工具调用追加一行 JSON 到 `logs/audit.jsonl`（项目目录下、沙盒之外），含时间戳、会话、**项目 slug**、工具名、目标、成败与耗时；OAuth 的注册/授权/换令牌/撤销也各记一行（`tool` 为 `oauth.*`）。

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
# OAuth：无 token 请求 /mcp/<slug> 应返回 401 + WWW-Authenticate；
#   curl -s http://127.0.0.1:8787/.well-known/oauth-authorization-server 有 issuer/端点；
#   浏览器打开 /oauth/authorize?... 能选项目；授权后 access token 只对该项目生效（跨项目 403）
```

## 项目结构

```
src/
├── index.ts        # CLI 入口：装配 store、播种迁移、打印端点清单与 token
├── config.ts       # 全局配置（CLI > env > 配置文件 > 默认），含 adminToken/publicUrl 与播种源
├── projects.ts     # Project 模型 + ProjectsStore（data/projects.json）+ 播种 + scope 组装
├── http.ts         # 路由：/health、/mcp/<slug>（会话绑定 slug、token 或 OAuth）、/admin 静态白名单、/api
├── admin.ts        # 管理 API：项目 CRUD、token 重置、OAuth 客户端列表/撤销、文件浏览与预览
├── oauth.ts        # OAuth 授权服务器状态：客户端/授权码/令牌（只存 SHA-256）+ PKCE
├── oauth-http.ts   # OAuth 端点：/.well-known/*、/oauth/register|authorize|token|revoke + 授权页
├── server.ts       # 每会话 McpServer 工厂（项目级 scope）
├── sandbox.ts      # 路径围栏核心：resolveWithinRoot / realpath / 链接逃逸检测
├── tools/
│   ├── files.ts    # fs_list/fs_read/fs_write/fs_edit/fs_delete/fs_move/fs_mkdir
│   ├── search.ts   # fs_search
│   └── exec.ts     # exec_run：平台 shell、树杀超时、输出截断、危险命令拦截
└── util/
    ├── text.ts     # UTF-8/二进制探测/行号分页/截断
    ├── token.ts    # 常量时间 token 比较（admin token / 项目 token）
    └── audit.ts    # logs/audit.jsonl（含 project slug）
public/             # Web 管理台（admin.html/admin.css/admin.js，原生 JS 无框架）
data/projects.json  # 项目登记（运行时生成，勿提交）
data/oauth.json     # OAuth 客户端与令牌摘要（运行时生成，勿提交）
test/               # vitest：路径围栏、CRUD、exec、ProjectsStore、HTTP 集成、OAuth 全流程
```
