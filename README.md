# figma-mcp-server

统一 Figma MCP server：**REST 无头读** + **插件桥实时读写** 双通道，工具自动路由、互为降级。

## 架构

```
Claude Code ──stdio──▶ figma-mcp-server (本工程)
                            ├── REST 通道: FIGMA_API_KEY → api.figma.com（无头读任何文件/批量导出切图）
                            └── Live 通道: 自动 node 直启 figma-edit-mcp
                                 ├── socket 桥 (:3055) 自动拉起
                                 ├── figma-edit-mcp server 子进程代理（45 个读写工具动态枚举透传）
                                 └── 频道码持久化，启动自动 channel_join

Figma 插件: 本工程 plugin/ 目录自带（含最小化按钮补丁），一次性导入后点两下即可
```

## Figma 插件（随本项目自带，单文件分发）

插件构建产物 `plugin/code.js` 是**自包含单文件**（UI 已内联，`plugin/build.mjs` 构建时注入 `__html__` 并自检），分发只需 `code.js` + `manifest.json` 两个文件。

**一次性导入**（install.ps1 已自动把这两个文件放到安装目录）：

1. Figma 桌面版 → `Plugins → Development → Import plugin from manifest…`
2. 选择 `<安装目录>\plugin\manifest.json`（一键安装模式脚本输出会打印完整路径）
3. 以后使用：`Plugins → Development → Figma Edit MCP` → 点 **Connect** → 插件窗口别关（可点"–"缩成小条）

插件改动后用 `pnpm plugin:build` 重新打包（Figma 里重开插件生效）。

**频道码固定持久化**：首次连接后频道码永久不变（存 Figma clientStorage），插件界面顶部频道卡大字显示 + 一键复制；server 端持久化 + 自动 join，全套体验 = 开 Figma → 点一下插件，从此无需再看码。

日常动作只有两个：**开 Figma → 点一下插件**。其余全自动。

## 快速开始

**方式一：一键安装（推荐）**

```powershell
# 仓库模式（本地 dist/bundle 直装）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 独立模式（不克隆仓库，从 GitHub Release 下载 bundle）
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://cdn.jsdelivr.net/gh/HW-public/figma-mcp-server@master/install.ps1'))"
```

安装脚本自动完成：拷贝/下载单文件 bundle → 安装运行时依赖（figma-edit-mcp）→ 生成 .env → 注册进 `~/.mcp.json` → 在 `settings.local.json` 启用。幂等可重跑，改配置前自动 `.bak` 备份。

**方式二：手动**

```bash
pnpm install
cp .env.example .env        # 填入 FIGMA_API_KEY（REST 通道需要；live 通道不需要）
pnpm build
claude mcp add figma-mcp-server -- node <仓库路径>\dist\index.js
```

## CI/CD

- **CI**（push/PR 到 main）：Windows 跑 `lint → typecheck → build → bundle → plugin:build → smoke` 全门禁
- **Release**（推 `v*` tag）：全门禁通过后 `gh release create` 发布三个资产：`index.mjs`（MCP server 单文件）+ `code.js`（插件单文件）+ `manifest.json`（插件清单）
- 发版流程：改 `package.json` version → commit → `git tag vX.Y.Z` → push tag（与 ssh-mcp-server 一致）

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `FIGMA_API_KEY` | 空 | Figma REST token（Settings → Security），不配置则 REST 工具返回结构化错误 |
| `FIGMA_BASE_URL` | `https://api.figma.com/v1` | REST base url |
| `FIGMA_EDIT_BRIDGE_PORT` | `3055` | socket 桥端口 |
| `FIGMA_MCP_CHANNEL` | 空 | 固定频道码；留空则读 `~/.figma-mcp-server.json`（人工 join 成功后自动写入） |
| `FIGMA_ASSETS_DIR` | `./figma-assets` | 图片导出默认目录 |

## 工具

**REST 通道（自实现）**
- `get_design_context` — 传 Figma URL 或 fileKey，返回裁剪后的结构/尺寸/颜色/文本/自动布局（面向代码生成）
- `download_images` — 批量导出节点图片（png/jpg/svg/pdf，支持 scale）

**Live 通道（figma-edit-mcp 代理，45 个）**
- `channel_join` / `channel_leave` — 首次人工 join 成功自动持久化，之后启动自动连接
- `page_info` / `node_info` — 读当前打开的文件（写操作前先 discover）
- `create_frame` / `create_shape` / `create_text` / `create_component` 等 — 画布写入
- `node_set_fill` / `node_set_corner_radius` / `text_set_content` 等 — 修改
- 完整清单启动日志可见，或用 MCP 客户端 `tools/list`

## 路由与降级

- 给了 URL/fileKey → 走 REST（无头，不打扰当前打开的画布）；没给定位参数 → 走 live（当前文件）
- 写操作仅 live 通道（Figma REST API 本身不支持写）；REST 收到写需求时请改用 live 工具
- live 未连接 → 读操作自动落 REST；写操作返回 `LIVE_NOT_CONNECTED` 及修复提示
- 未配 `FIGMA_API_KEY` → REST 工具返回 `REST_NOT_CONFIGURED`，live 不受影响
- 两通道都不可用 → 工具返回结构化错误 + 修复提示，互不拖累

## 连接生命周期

```
server 启动
  ├─ 自动 spawn socket 桥 (node figma-edit-mcp/dist/socket.js, :3055)
  ├─ 自动 spawn figma-edit-mcp server 子进程 → WS 连 socket → 枚举 45 个工具
  └─ 若已有持久化频道码 (~/.figma-mcp-server.json) → 自动 channel_join
        ├─ 成功 → 全程无感
        └─ 失败（码已轮换）→ 等人工 join 一次，成功后重新持久化
```

首次配对只需一次：Figma 插件状态栏的频道码 → `channel_join` → 之后永久自动。

## 故障排查

| 现象 | 原因与解法 |
|---|---|
| `CHANNEL_NOT_BOUND` | 插件未连：Figma 里打开插件点 Connect；或本会话还没 join，把状态栏频道码发出来 join 一次 |
| 自动 join 失败日志 | 频道码已被重置（罕见）：看插件频道卡，人工 join 一次即可（会重新持久化） |
| `claude mcp list` 健康检查超时 | spawn 链（socket+子进程）冷启动慢，重跑一次即可，不影响实际使用 |
| `EADDRINUSE :3055` | 有残留 socket 进程：`netstat -ano \| findstr 3055` 找到 PID 杀掉 |
| 插件窗口关了 | WS 即断：重开插件 + 重新 join |
| 电脑睡眠后断了 | 唤醒后重新 `channel_join` 一次 |
| IDEA 里 SDK 类型一片红 | IDEA 的 TS 版本切到 Project（WebStorm 2023.3 内置 TS 5.3 解析不了 MCP SDK ≥1.32 的类型） |

## 开发

```bash
pnpm dev        # tsx 直跑 src
pnpm lint       # eslint（CI 门禁之一）
pnpm lint:fix
pnpm typecheck
pnpm smoke      # 冒烟：MCP 握手 + 工具枚举 + 错误路径
pnpm release    # build + esbuild 单文件 bundle（dist/bundle/index.mjs）
```

工程约定同 ssh-mcp-server：pnpm、ESM、strict TS、esbuild bundle、发版走 version + git tag。

## 已知限制

- live 写入受 figma-edit-mcp 安全模型约束（scope 锁定/批量校验/频道配对码），错误码结构化透传
- 插件频道码已持久化（clientStorage），如需换码：Figma 控制台执行 `figma.clientStorage.deleteAsync('settings')` 后重开插件
- REST 通道为只读（Figma REST API 不支持写）
