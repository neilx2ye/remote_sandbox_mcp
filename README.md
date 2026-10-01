# remote-sandbox-mcp

一个 **MCP（Model Context Protocol）服务器**：让网页版 AI（Claude.ai、ChatGPT、Kimi 网页版等支持自定义 MCP 连接器的客户端）通过 HTTPS 隧道远程连接你的电脑，在**指定项目目录**内完成文件读写、搜索和受控命令执行。

**多项目架构**：每个项目是一个独立沙盒（root 可指向整台设备任意目录），拥有唯一 slug、独立的 MCP 端点 `/<slug>`（根路径下的一段，如 `/default`、`/web-app`）和独立 token；slug 需匹配 `^[a-z0-9-]{2,32}$`，其中 `admin`/`api`/`health`/`mcp`/`oauth` 为保留名，永远不会作为项目端点。此外还有一条**共享路径 `/mcp`**，可以指定给任意一个项目，也可以随时改指到别的项目（没有任何项目被指定时 `/mcp` 返回 404；首次启动会把它指定给播种的 `default` 项目）。另带一个 **Web 管理台**（`/admin`）用于管理项目、编辑 slug/端点、指定 `/mcp` 端点、生成 token、浏览与预览项目文件，以及查看/撤销 OAuth 授权。

连接器鉴权由 `--auth` 选择（`any` / `token` / `none`）：默认 `any` 下可粘贴项目 token 或走 **OAuth 2.1**（授权页里登录并**选择要开放的项目**）；`token` 只认项目 token；`none` 完全不做鉴权。**`none` 只适用于端口不经公网可达的部署（仅 127.0.0.1 + SSH 端口转发）**，详见「鉴权模式」。

同一套代码无需修改即可运行在 **Windows 和 Linux**（纯 Node.js 内置 API，无任何原生模块，管理台为原生 JS、无 CDN 依赖）。

```
                        ┌─────────────────────────────────────────────┐
 网页版 AI ──HTTPS──> 隧道 ──> 127.0.0.1:8787                          │
                        │   ├─ /<slug>      → 每项目独立端点(如 /default)│
                        │   │                 独立围栏+token           │
                        │   │                 (--auth none 时不做鉴权)  │
                        │   ├─ /mcp         → 共享路径，指向被指定的项目 │
                        │   │                 (未指定时 404)            │
                        │   ├─ /.well-known/* + /oauth/* → OAuth 授权   │
                        │   │                 (仅 --auth any；浏览器里选项目+admin token)│
                        │   ├─ /api/*       → 管理 API (admin token)    │
                        │   └─ /admin       → Web 管理台 (静态文件)      │
                        └─────────────────────────────────────────────┘
              每个项目: 路径围栏(resolveWithinRoot) + 符号链接检测 + 审计 JSONL
```

⚠️ **安全第一原则**：隧道只应暴露各项目端点 `/<slug>` 与共享路径 `/mcp`（用 OAuth 时再加 `/oauth*`、`/.well-known/*`）；`/admin` 和 `/api` 只通过本机或 SSH 端口转发访问（见下文「隧道与安全暴露」）。**`--auth none` 时端口绝不能公网可达**。

## 鉴权模式（`--auth`）

各项目端点 `/<slug>` 与共享路径 `/mcp` 如何鉴权由 `--auth` / `MCP_AUTH` / 配置文件 `auth` 决定，默认 `any`：

| 模式 | `/<slug>` 与 `/mcp` 鉴权 | OAuth 端点 | 适用场景 |
|---|---|---|---|
| `any`（默认） | 项目 token **或** OAuth access token | 提供 | 常规用法，网页版 AI 走隧道连进来 |
| `token` | 只认项目 token | **404** | 固定 token、不想开 OAuth 授权面 |
| `none` | **完全不鉴权** | **404** | 端口只有本机能到（127.0.0.1 + `ssh -L` 端口转发） |

`none` 模式下 `/<slug>` 与 `/mcp` 都不校验任何凭证：**谁能连上这个端口，谁就能读写项目目录里的所有文件并执行 `exec_run`**。它的前提是"这个端口从公网不可达"，也就是同时满足：

- 服务绑在 `127.0.0.1`（默认，且不要改成 `0.0.0.0`）；
- 没有把端口挂到公网隧道/反代上。

> ⚠️ 这条前提极易被破掉。`cloudflared`/`ngrok`/`frp`、以及 **`ssh -R` 反向隧道**（把本机端口发布到一台公网 VPS）都会让 `none` 模式的端口对全网开放——端口扫描器通常几分钟内就会找到它。`ssh -L`（本地转发）才是安全的那个方向。
>
> 判断方法：从**另一台**不在同一局域网的机器上执行 `curl https://<你的域名>:<端口>/health`。如果返回 `{"ok":true}`，说明该端口公网可达，此时**不能**用 `none`。

服务启动时会做一道兜底检查：`auth=none` 且监听地址不是回环地址（`127.x.x.x` / `::1` / `localhost`）时直接启动失败，不会静默地裸奔。注意这**挡不住反向隧道**——那种情况下服务看到的来源就是 `127.0.0.1`，仍需你自己确认隧道方向。

模式切换后需要重启服务生效；管理台会按当前模式隐藏 OAuth 卡片、并在 `none` 时给出醒目提示。

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
- **指定 `/mcp` 端点**：新建时在 slug 里填 `/mcp`（或 `mcp`），或在已有项目上点「设为 /mcp」——该项目即被绑定到共享路径 `/mcp`（同一时刻一个，可随时改指到别的项目；没有任何项目被指定时 `/mcp` 返回 404）。这**不影响**该项目自己的 `/<slug>`：它在两条路径上都可用
- slug / 端点随时可改：「编辑」表单里直接改 slug 即可（也可用 `PATCH /api/projects/:id`），**无需删除重建**；自动派生规则见「快速开始」
- token 管理：列表掩码显示、点击查看完整值、一键重新生成（旧 token 立即失效）
- 每个项目显示自己的 MCP 端点路径（`/<slug>`，如 `/web-app`）+ 复制按钮；被指定给 `/mcp` 的那个项目同时显示 `/mcp`
- 顶部提示当前鉴权模式；`--auth none` 时醒目警示、并隐藏 OAuth 卡片与 token 列
- OAuth 授权：列出已授权的客户端、各自被授权了哪些项目、最近使用时间，可一键撤销（仅 `--auth any`，详见下文「OAuth 认证」）
- 文件浏览：面包屑导航、目录列表、文本（带行号）/图片预览，二进制提示不支持

## OAuth 认证（连接器授权，推荐）

> 仅 `--auth any`（默认）时提供。`--auth token` / `none` 下 `/.well-known/*` 与 `/oauth/*` 一律 404，本节内容不适用。

除了给每个连接器粘贴项目 token，也可以让 AI 客户端走标准 **OAuth 2.1**：连接器只填 `https://<隧道域名>/<slug>`，
**不用复制任何 token**；授权时浏览器会打开本服务的授权页，你用 **Admin Token 登录并选择要开放的项目**，
之后客户端拿到的 access token 只对**那一个项目**有效。

```
AI 客户端（Claude.ai / ChatGPT / …）                       本服务
  ① POST /<slug>（还没 token）
  ← 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/<slug>"
  ② GET /.well-known/oauth-protected-resource/<slug>        资源元数据（resource=该项目端点 <base>/<slug>）
  ③ GET /.well-known/oauth-authorization-server            授权服务器元数据（端点+PKCE S256）
  ④ POST /oauth/register                                   动态注册 → client_id（RFC 7591）
  ⑤ 浏览器打开 /oauth/authorize?…                           授权页：★ 选择项目 + 输入 Admin Token
  ← 302 回调地址?code=…&state=…
  ⑥ POST /oauth/token（code + PKCE code_verifier）          → access_token + refresh_token
  ⑦ POST /<slug> + Authorization: Bearer <access_token>     正常调用工具
```

### 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | 共享路径 `/mcp` 的资源元数据（resource = `<base>/mcp`；授权页需手动选项目） |
| GET | `/.well-known/oauth-protected-resource/<slug>` | 该项目的资源元数据（resource = `<base>/<slug>`；授权页会预选这个项目） |
| GET | `/.well-known/oauth-authorization-server` | 授权服务器元数据（issuer/端点/`code_challenge_methods_supported: S256`） |
| POST | `/oauth/register` | 动态客户端注册，返回 `client_id`（可选 `client_secret`） |
| GET | `/oauth/authorize` | 授权页（HTML：项目单选 + Admin Token） |
| POST | `/oauth/authorize` | 提交授权/拒绝 → 302 回客户端回调地址 |
| POST | `/oauth/token` | `authorization_code` / `refresh_token` 换令牌 |
| POST | `/oauth/revoke` | 撤销 access/refresh token（RFC 7009） |

### 行为与安全细节

- **项目选择**：`resource` 参数带 `/<slug>` 时授权页会预选并提示该项目；用根路径元数据（resource=`<base>/mcp`）时由你在页面上选择。授权页把可选项目按 `/<slug>` 列出。所选项目决定令牌的作用范围，跨项目使用会得到 403。
- **令牌生命周期**：access token **1 小时**，refresh token **30 天**（每次刷新轮换，旧的立即失效）；授权码 **5 分钟**、单次使用；仅支持 PKCE `S256`。
- **持久化**：客户端、授权码、令牌都落在 `data/oauth.json`，且**只存 SHA-256 摘要**（明文 token 不落盘），服务重启后连接器无需重新授权。
- **撤销**：管理台「OAuth 授权」卡片可撤销某个客户端的全部授权；项目 token 的「重置 token」与之互不影响。授权/换 token/撤销都会写一行审计（`tool` 为 `oauth.*`）。
- **授权页的登录口令就是 Admin Token**，失败尝试按来源 IP 限流（8 次/5 分钟）；由于授权页需要公网可达，请务必使用高强度 `MCP_ADMIN_TOKEN`。
- 只想用固定 token、完全不开 OAuth：`--auth token`（不想动配置就隧道不放行 `/.well-known/*` 与 `/oauth/*` 也一样，OAuth 只在这些路径上响应）。

> 本地自测：先 `curl -X POST http://127.0.0.1:8787/oauth/register -H 'Content-Type: application/json' -d '{"client_name":"local","redirect_uris":["http://127.0.0.1:7777/cb"],"token_endpoint_auth_method":"none"}'` 拿到 `client_id`，再在浏览器打开 `/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256`。

## 快速开始

要求 Node.js ≥ 20（建议 22/24）。

```bash
npm install
npm run build
npm start                    # 默认 127.0.0.1:8787
```

首次启动会**自动播种一个 slug 为 `default` 的项目**（root 来自 `--root`/`MCP_ROOT`/配置文件 `root`，默认 `./sandbox`；token 来自 `--token`/`MCP_TOKEN`/配置文件 `token`，都没有则随机生成并醒目打印），并把这个项目指定给共享路径 `/mcp`——开箱即可用 `https://<隧道域名>/default` 或 `https://<隧道域名>/mcp` 连接。旧版单沙盒配置（`sandbox.config.json` 里的 root+token）会被原样继承，**已有连接器（用的是 `/mcp`）不会失效**。

新建项目时 slug 可以不填，会自动派生：名称转成 `slugify` 结果（如「Web App」→ `web-app`）；名称里没有可用 ASCII 字符时随机生成 `proj-xxxx`；重名则加 `-2`/`-3` 后缀。slug/端点可随时在管理台「编辑」表单或 `PATCH /api/projects/:id` 修改，**无需重建项目**（改 slug 会同步改写 OAuth 授权记录里的 slug，已授权令牌继续有效）。

同时，若未配置 admin token，会随机生成并醒目打印：

```
  NO ADMIN TOKEN WAS CONFIGURED - generated a random one:
    MCP_ADMIN_TOKEN = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

打开管理台：**http://127.0.0.1:8787/admin** ，输入上面的 admin token 登录，即可创建更多项目、编辑各项目的 slug/端点，并指定哪个项目绑定到共享路径 `/mcp`。

启动横幅里还会打印当前鉴权模式、各项目的 MCP 端点，以及（`--auth any` 时）OAuth 授权端点 `/oauth/*`、`/.well-known/*`——用 OAuth 的客户端需要隧道放行这些路径。`--auth none` 时横幅会打印醒目告警。

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
| `--host <addr>` | `MCP_HOST` | `host` | `127.0.0.1` | 监听地址（不要直接绑 0.0.0.0 公网暴露；`auth=none` 时绑非回环地址会直接启动失败） |
| `--stdio` | — | — | off | stdio 传输（本地客户端，用 default 项目） |
| `--readonly` | — | `readOnly` | `false` | **总开关**：所有项目只读 |
| `--no-exec` | — | `exec.enabled` | `true` | **总开关**：所有项目禁用 exec_run |
| `--public-url <url>` | `MCP_PUBLIC_URL` | `publicUrl` | 由请求头推导 | OAuth 元数据里对外公布的地址，如 `https://mcp.example.com`（隧道/CDN 改写 Host 时建议固定；仅 `--auth any` 用到） |
| `--auth <mode>` | `MCP_AUTH` | `auth` | `any` | 各项目端点 `/<slug>` 与共享路径 `/mcp` 的鉴权模式：`any`（项目 token 或 OAuth）/ `token`（只认项目 token）/ `none`（不鉴权，仅限端口不可公网可达时） |
| `--config <path>` | — | — | `./sandbox.config.json` | 指定配置文件 |

项目数据持久化在 `data/projects.json`（含各项目明文 token，威胁模型与旧版配置文件明文 token 一致；该文件已加入 `.gitignore`，请别提交）；OAuth 客户端与令牌持久化在 `data/oauth.json`（**只存 SHA-256 摘要**，同样已 gitignore）。`exec.timeoutMs`/`exec.allow`/`exec.deny`/`maxFileBytes` 为全局默认值，对所有项目生效；`readOnly`/`execEnabled` 可按项目单独设置。

> 注意：通过管理台修改项目 root 后，**已建立的 MCP 会话仍按旧围栏运行**（会话在 initialize 时按当时配置创建），让 AI 客户端重新连接即可生效。

## 隧道与安全暴露

服务只监听 `127.0.0.1`。网页版 AI 需要一条带 TLS 的隧道连进来，但只应暴露 AI 客户端真正需要的路径：

- ✅ 隧道/反代转发各项目端点 `/<slug>`（单段路径，如 `/default`、`/web-app`）与共享路径 `/mcp`（连接器端点）
- ✅ 用 OAuth 时还要放行 `/.well-known/*` 与 `/oauth/*`（发现元数据 + 授权页 + 换令牌）。不用 OAuth 就不必放行
- ❌ 不要把 `/admin`、`/api` 暴露到公网（管理台能创建指向**任意目录**的项目，权力远大于单个沙盒）
- ⛔ 用 `--auth none` 时**不要给这个端口配任何公网隧道**。`ssh -L`（本地转发）没问题，`ssh -R`（反向隧道，把本机端口发布到公网 VPS）等同于直接公网暴露
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
    # 用 route 固定执行顺序：先匹配转发，最后兜底 404（Caddy 默认把 respond 排在 reverse_proxy 之前）
    route {
        # 各项目端点 /<slug>（单段路径；排除保留名，确保 /admin、/api、/health、/oauth 不公开）
        @project {
            path_regexp ^/[a-z0-9-]{2,32}$
            not path /admin /api /health /mcp /oauth
        }
        reverse_proxy @project 127.0.0.1:8787

        # 共享路径 /mcp（绑定到它的那个项目）
        @shared path /mcp
        reverse_proxy @shared 127.0.0.1:8787

        # 仅 --auth any 用到的 OAuth 发现/授权端点
        @oauth path /.well-known/* /oauth /oauth/*
        reverse_proxy @oauth 127.0.0.1:8787

        # 其余（/admin、/api 等）一律 404
        respond 404
    }
}
```

这样 `https://mcp.example.com/web-app` 这类项目端点（以及被指定给 `/mcp` 的那个项目的 `https://mcp.example.com/mcp`）可达，OAuth 流程用到的 `/.well-known/*`、`/oauth/*` 也在放行之列，而 `/admin`、`/api` 在公网一律 404。想让 OAuth 元数据里的地址稳定（不依赖代理传的 `X-Forwarded-Host`），可加 `--public-url https://mcp.example.com`。

### ngrok

```bash
ngrok http 8787          # 免费档无路径过滤，注意事项同 cloudflared 临时隧道
```

### frp（自建 VPS）

同旧版：`type = "http"` 转发 8787 到你的域名，TLS 由前置 nginx/Caddy 终止；同样建议在前置层只放行各项目端点 `/<slug>` 与 `/mcp`（+ 用 OAuth 时的 `/.well-known`、`/oauth`）。

## 在网页版 AI 中添加连接器

**每个项目一个连接器**：URL 为 `https://<隧道域名>/<slug>`（如 `/default`、`/web-app`；被指定给共享路径的那个项目也可以直接用 `https://<隧道域名>/mcp`）。鉴权方式取决于 `--auth`：

> 迁移提示：旧连接器若填的是 `/mcp/<slug>`，该路径已不再受理（返回 404 并附带提示），请改成 `/<slug>`；一直用 `/mcp` 的连接器不受影响。

- **`any`（默认）** —— 二选一：
  - **OAuth（推荐，免粘贴 token）**：只填 URL，客户端会走 OAuth 并在浏览器弹出授权页（选项目 + 输 Admin Token）。前提是隧道放行了 `/.well-known/*` 与 `/oauth/*`。
  - **项目 token**：token 用**该项目自己的 token**（管理台项目卡片上 👁 查看 + 复制）。
    - **请求头**（推荐）：`Authorization: Bearer <项目token>`
    - **URL 参数**（客户端不支持自定义头时）：`https://<隧道域名>/<slug>?token=<项目token>` ⚠️ token 会出现在 URL 里
- **`token`** —— 与上面的「项目 token」完全一致，但没有 OAuth 那条路。
- **`none`** —— URL 只填 `http://127.0.0.1:<端口>/<slug>`（配合 `ssh -L`），**不要**填公网域名，任何凭证都不需要填。

### Claude.ai

设置 → 连接器（Connectors）→ 添加自定义连接器 → URL 填 `https://<隧道域名>/<slug>`；OAuth 可留空直接连接（授权时会打开本服务的授权页），或按旧方式在高级设置里加 `Authorization: Bearer <项目token>`（也可拼 `?token=`）。每个项目重复添加一次即可。

### ChatGPT

设置 → Apps & Connectors → 高级设置 → 开 Developer mode → 新建 MCP 连接器，URL 同上，鉴权同上（支持 OAuth 的版本会直接弹授权页）。

### Kimi 网页版

对话/设置中的 MCP 工具入口 → 添加自定义 MCP 服务器 → 类型 Streamable HTTP → URL 同上（需要时拼 `?token=`）。

> 各产品 UI 随版本调整，以官方文档为准；关键要素：Streamable HTTP + `/<slug>` 端点（或共享路径 `/mcp`）+ （OAuth 授权或该项目 token）。

## 本地调试

```bash
npx @modelcontextprotocol/inspector node dist/index.js --stdio
```

或用 Inspector 的 Streamable HTTP 传输连 `http://127.0.0.1:8787/<slug>`（填项目 token；也可以连共享路径 `http://127.0.0.1:8787/mcp`）。

curl 手动验证（initialize 必须带 `Accept: application/json, text/event-stream`）：

```bash
curl -i http://127.0.0.1:8787/<slug> \
  -H "Authorization: Bearer <项目token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
# 响应头取 mcp-session-id，后续请求带上
```

## 管理 API 一览（全部要求 `Authorization: Bearer <adminToken>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表（token 掩码 `abcd****wxyz`；`mcpPath` 为该项目自己的端点 `/<slug>`，`isDefault` 标记当前 `/mcp` 指向的那个项目） |
| POST | `/api/projects` | 创建 `{name, slug?, root, readOnly?, execEnabled?}`，响应含完整 token（仅此一次）；`slug` 不填则按名称派生（非法/保留名 400、重名 409），填 `"/mcp"`（或 `"mcp"`）表示同时把该项目绑定到共享路径 `/mcp`，其自身 slug 仍按名称派生 |
| GET | `/api/projects/:id` | 详情（含完整 token） |
| PATCH | `/api/projects/:id` | 改 `{name?, slug?, root?, readOnly?, execEnabled?}`；改 `slug` 即改该项目端点（非法/保留名 400、重名 409）；`slug` 填 `"mcp"`/`"/mcp"` 表示把共享路径 `/mcp` 指定给该项目而不是改名 |
| POST | `/api/projects/:id/regenerate-token` | 重新生成 token（旧值立即失效） |
| POST | `/api/projects/:id/set-default` | 把该项目指定为共享路径 `/mcp` 的端点（同一时刻一个，可随时改指；该项目自己的 `/<slug>` 不受影响；删除该项目会自动解除） |
| DELETE | `/api/projects/:id` | 删除登记（不动磁盘文件） |
| GET | `/api/projects/:id/files?path=` | 目录列表（围栏内，上限 2000 条） |
| GET | `/api/projects/:id/file?path=` | 文件预览：文本/SVG → JSON；位图 → 字节流；其它二进制 → `{kind:"binary"}`；上限 min(maxFileBytes, 2MB) |
| GET | `/api/status` | 当前鉴权模式：`{auth: "any"\|"token"\|"none", oauthEnabled: boolean}`（管理台据此隐藏 OAuth 卡片） |
| GET | `/api/oauth/clients` | 已授权的 OAuth 客户端（client_id、名称、被授权的项目、有效令牌数、最近使用）+ 汇总 stats；非 `any` 模式恒为空 |
| DELETE | `/api/oauth/clients/:clientId` | 撤销该客户端：删登记并吊销其全部 access/refresh token |

## 安全设计与注意事项

1. **三类凭证分开保密**：项目 token（AI 连接器用，泄露 = 该项目沙盒开放）、admin token（管理台用，泄露 = 能创建指向**任意目录**的新项目，等同整机文件访问）、OAuth 客户端/令牌（只存在 `data/oauth.json`，且只存摘要）。都别提交进 git。
2. **`--auth none` 等于把整机交出去**：`none` 模式下各项目端点 `/<slug>` 与共享路径 `/mcp` 都不校验任何凭证，而项目 root 可以指向设备任意目录、`exec_run` 默认开启。因此 `none` **只有在端口对公网不可达时才可以接受**——见「鉴权模式」里的自查方法。特别注意 **`ssh -R` 反向隧道、`frp`、cloudflared、ngrok 都会把端口发布到公网**，`ssh -L` 本地转发才是安全的；若不确定就用 `token`。
3. **`/admin`、`/api` 不上公网**：见「隧道与安全暴露」。项目 token 鉴权保护不了管理接口，管理接口由 admin token 保护且**与 `--auth` 无关**（`none` 模式下管理 API 依然要求 admin token），但纵深防御要求它根本不该被公网到达。
4. **OAuth 授权页 = Admin Token 登录框**（仅 `--auth any`）：`/oauth/authorize` 必须公网可达才能完成授权，因此它是唯一在公网暴露的 admin token 输入口——已按来源 IP 限流（8 次失败/5 分钟），但仍务必使用高强度 `MCP_ADMIN_TOKEN`；不想承担这个面就改用 `--auth token`，或别放行 `/.well-known/*` 与 `/oauth/*`。
5. **OAuth 令牌绑定单个项目**：授权时选中的项目写进令牌，拿它去访问别的项目端点 `/<other-slug>`（或 `/mcp`，当 `/mcp` 指向别的项目时）返回 403；`redirect_uri` 必须是客户端注册过的地址（http 仅允许 loopback，防开放重定向），授权码单次使用 + PKCE S256，刷新时轮换 refresh token。改 slug 不会让已授权的令牌失效（服务端会同步改写授权记录里的 slug）。
6. **路径围栏**：每个项目的所有文件操作（MCP 工具和管理 API 的文件浏览）都经 `resolveWithinRoot` 强制限制在该项目 root 内——`../`、绝对路径、符号链接/junction 逃逸全部拒绝（Windows 下大小写不敏感比较）。项目 root 可指向设备任意位置是**特性**，请只把真正要让 AI 碰的目录登记为项目。
7. **会话隔离**：MCP 会话按项目身份加围栏——`/mcp` 与它当前指向项目的 `/<slug>` 是同一个项目、共用同一条会话；把同一会话 ID 用在另一个项目上返回 403（项目改名/改 slug 后围栏仍按项目身份生效）。
8. **按需降级**：项目级只读/exec 开关 + 全局 `--readonly`/`--no-exec` 总开关；生产建议配 `exec.allow` 白名单。
9. **内置危险命令拦截**（`rm -rf /`、`mkfs`、`format`、`shutdown` 等）只是兜底，不能替代白名单。
10. **资源限制**：单文件 ≤ `maxFileBytes`（默认 5MB）、目录列举 ≤ 2000 条、搜索 ≤ 500 命中、命令超时默认 30s（上限 300s）、stdout/stderr 各截断 64KB、管理台预览 ≤ 2MB。
11. **子进程环境隔离**：`exec_run` 只继承最小环境变量集（PATH/HOME/USERPROFILE/SystemRoot/TEMP 等），不会泄露任何 token。
12. **审计**：每次工具调用追加一行 JSON 到 `logs/audit.jsonl`（项目目录下、沙盒之外），含时间戳、会话、**项目 slug**、工具名、目标、成败与耗时；OAuth 的注册/授权/换令牌/撤销也各记一行（`tool` 为 `oauth.*`）。

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
# 管理台创建项目 → /<slug> 走 initialize → tools/call；
#   旧的 /mcp/<slug> 应 404，并在报错里提示改用 /<slug>
# 确认：symlink 逃逸被拒、跨项目 token 401、会话复用到别的项目 403、rm -rf / 被拦截
# OAuth（默认 --auth any）：无 token 请求 /<slug> 应返回 401 + WWW-Authenticate
#   （resource_metadata="…/.well-known/oauth-protected-resource/<slug>"）；
#   curl -s http://127.0.0.1:8787/.well-known/oauth-authorization-server 有 issuer/端点；
#   浏览器打开 /oauth/authorize?... 能选项目；授权后 access token 只对该项目生效（跨项目 403）
# --auth token：无 token 请求 /<slug> 仍是 401，但 /.well-known/* 与 /oauth/* 应 404
# --auth none ：无任何凭证的 /<slug> 直接 200；/.well-known/* 与 /oauth/* 应 404；
#   /api/projects 无 admin token 仍应 401（管理 API 不受 --auth 影响）
```

## 项目结构

```
src/
├── index.ts        # CLI 入口：装配 store、播种迁移、打印端点清单与 token
├── config.ts       # 全局配置（CLI > env > 配置文件 > 默认），含 adminToken/publicUrl/auth 与播种源
├── projects.ts     # Project 模型 + ProjectsStore（data/projects.json）+ slug 校验/派生（保留名）+ 共享 /mcp 指定 + 播种 + scope 组装
├── http.ts         # 路由：/health、各项目端点 /<slug> 与共享 /mcp（会话按项目身份加围栏；按 --auth 决定 token/OAuth/不鉴权）、旧 /mcp/<slug> 返回 404 提示、/admin 静态白名单、/api
├── admin.ts        # 管理 API：项目 CRUD、token 重置、/api/status、OAuth 客户端列表/撤销、文件浏览与预览
├── oauth.ts        # OAuth 授权服务器状态：客户端/授权码/令牌（只存 SHA-256）+ PKCE
├── oauth-http.ts   # OAuth 端点（仅 --auth any）：/.well-known/*、/oauth/register|authorize|token|revoke + 授权页
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
test/               # vitest：路径围栏、CRUD、exec、ProjectsStore、HTTP 集成、鉴权模式、OAuth 全流程
```
