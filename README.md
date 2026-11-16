# figma-mcp-server

统一 Figma MCP server：**REST 无头读** + **插件桥实时读写** 双通道，工具自动路由、互为降级。

## 架构设计

### 全景图

```
┌─ 会话侧（每个 Claude 会话各一个进程，Claude Code 正常 spawn） ─────────────┐
│                                                                            │
│  index.ts ──▶ server.ts ──▶ 工具路由                                        │
│    initialize/tools-list/call               ├─ live 写/读 ──┐              │
│         ▲                                   └─ REST 无头读 ─┤              │
│         │  stdio (MCP 协议)                                 ▼              │
│  Claude Code ◀──────────────────────  client/（会话通道）                    │
│                                        ├─ live.ts   瘦客户端（TCP 分帧）    │
│                                        └─ rest-*.ts HTTPS → Figma REST API │
└────────────────────────────────────────────────────────────────────────────┘
                      │ client/live.ts 按需拉起 + TCP 127.0.0.1:3056
                      ▼
┌─ broker/（进程编排，全机唯一守护进程） ──────────────────────────────────────┐
│  端口抢占 → spawn 子进程对 → FIFO 串行队列 → 闲置自退 / 被杀自愈              │
│      │ spawn 自身 + --fe-child 路由（子进程代码已打进 broker.mjs）           │
      ▼
┌─ bridge/（插件桥进程对，全机唯一） ─────────────────────────────────────────┐
│  server.ts（MCP child，stdio）──注册──▶ tools/（45 个 live 工具 schema）     │
│  socket.ts（WS 桥 :3055）──频道握手──▶ Figma 插件（plugin/，Figma 沙箱）     │
│  client.ts / logger.ts / resources.ts / utils.ts / imageResize.ts / cli.ts │
└────────────────────────────────────────────────────────────────────────────┘
        protocol/ = 频道协议 + 错误码 + 节点类型 + 版本（bridge/tools 共用）
```

### 分层职责

| 层 | 目录 | 职责 | 实例数 |
|---|---|---|---|
| 入口 | `index.ts` `server.ts` `config.ts` | 每会话 MCP server 组装、双通道路由、env 配置 | 每会话 1 |
| 会话通道 | `client/` | live 瘦客户端（broker 通信）+ REST 读通道（Figma API） | 每会话 1 |
| 进程编排 | `broker/` | 守护进程：端口抢占、子进程生命周期、FIFO 互斥队列、频道持久化、工具表推送、更新探测 | 全机 1 |
| 插件桥 | `bridge/` | 连接 Figma 插件的子进程对（MCP child + WS 桥）及其支撑模块 | 全机 1 对 |
| 工具层 | `tools/` | 45 个 live 工具的 zod schema 定义（bridge/server.ts 注册） | — |
| 协议层 | `protocol/` | 频道握手协议、错误码、节点类型、版本常量（多方共用，无依赖） | — |
| 插件端 | `plugin/` | Figma 沙箱内运行的插件（UI/频道卡/handler），独立运行时 | Figma 内 1 |

依赖单向无环：`入口 → client → broker`；`bridge → tools/protocol`；`protocol` 不依赖任何层。

### 关键机制

- **多会话并发安全（画布单写者）**：broker 内 FIFO 互斥队列串行执行所有工具调用，顺序一致；客户端断开自动清理其未执行的调用
- **broker 生命周期**：首个会话按需 detached 拉起（无需 hook/开机自启）→ 无客户端闲置 30 分钟自退 → 被杀后任意会话下次调用自愈；启动先抢 3056 端口再拉子进程，并发唤醒的败者空手退出，杜绝孤儿抢占频道
- **单文件进程模型**：bridge 两套代码由 `scripts/bundle.mjs` 一并打进 broker.mjs，broker 以 `--fe-child=server|socket` spawn 自身完成路由——分发物只有 `index.mjs` + `broker.mjs`
- **版本握手**：broker spawn 子进程时经 env 注入构建版本，频道握手 serverVersion 与插件同源比对，不一致即 VERSION_MISMATCH 拒连
- **工具表推送**：broker 在客户端认证时和桥就绪时主动推送工具表，瘦客户端不会停留在空表（消除启动竞态）
- **插件桥双进程**：socket.ts 持有 WS 桥（:3055，插件唯一接入点），server.ts 是 MCP child（stdio），两者经 WS 中继命令/回执，崩溃由 broker 重拉

### 状态与配置

- 运行状态集中 `%LOCALAPPDATA%\figma-mcp-server\`（log 5MB 轮转 / pid / token / channel.json / update-available.json），与安装目录解耦
- 全部端口与路径 env 可覆盖（`FIGMA_MCP_BROKER_PORT` / `FIGMA_EDIT_BRIDGE_PORT` / `FIGMA_MCP_STATE_DIR` / `FIGMA_MCP_BROKER_IDLE_EXIT_MS`），测试与多实例友好

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

安装脚本自动完成：拷贝/下载 `index.mjs` + `broker.mjs` → 拷贝内置（vendored，自维护）figma-edit-mcp server 端 → 拷贝插件 → 生成 .env → 注册进 **`~/.claude.json`**（用户级，天然免启用）→ 自动清理旧版 `~/.mcp.json` 残留。幂等可重跑，改配置前自动 `.bak` 备份。

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
- `channel_join` / `channel_leave` — 一般无需手动，broker 自动管理持久化频道
- `page_info` / `node_info` — 读当前打开的文件（写操作前先 discover）
- `create_frame` / `create_shape` / `create_text` / `create_component` 等 — 画布写入
- `node_set_fill` / `node_set_corner_radius` / `text_set_content` 等 — 修改
- `batch_execute` — **批量执行**：一次调用传 ops 数组（≤200 项），broker 内串行执行并逐项返回结果；写大量节点时优先用它替代循环单调
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
  ├─ 自动 spawn socket 桥 (broker.mjs --fe-child=socket, :3055)
  ├─ 自动 spawn figma-edit-mcp server 子进程 → WS 连 socket → 枚举 45 个工具
  └─ 若已有持久化频道码 (~/.figma-mcp-server.json) → 自动 channel_join
        ├─ 成功 → 全程无感
        └─ 失败（码已轮换）→ 等人工 join 一次，成功后重新持久化
```

首次配对只需一次：Figma 插件状态栏的频道码 → `channel_join` → 之后永久自动。

## 故障排查

| 现象 | 原因与解法 |
|---|---|
| `CHANNEL_NOT_BOUND` | 插件未连：Figma 里打开插件点 Connect；频道 join 由 broker 自动管理，一般无需再手动 join |
| `LIVE_NOT_CONNECTED` | broker 未起来：任意会话再调一次 live 工具会自动按需拉起；看 `%LOCALAPPDATA%\figma-mcp-server\broker.log` |
| 工具只剩 2 个（REST） | 到 broker 的连接断了：3 秒自动重连，稍等再试；持续不行就 `taskkill` broker 进程让它重生 |
| 多会话都想写 Figma | 直接都用 —— broker FIFO 串行处理，天然不冲突 |
| `EADDRINUSE :3055/:3056` | 残留进程：`netstat -ano \| findstr "3055 3056"` 找到 PID 杀掉，下次调用自愈 |
| broker 一直不退 | 有客户端连着属正常；全部会话关闭后最多 30 分钟自退（`FIGMA_MCP_BROKER_IDLE_EXIT_MS` 可调） |
| 插件窗口关了 | WS 即断：重开插件 + 重新 Connect |
| 电脑睡眠后断了 | 唤醒后插件里重新 Connect；broker 若被杀会自动重拉 |
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

**版本与兼容**：语义化版本——工具 schema 新增 = minor，删除/重命名 = major，修复 = patch。
插件与 server 的频道握手在同 minor 内允许混跑（VERSION_MISMATCH 守卫在 channel 层）。
发版：`pnpm run release:check` 全绿（工作区干净/全门禁/定制清单一致）→ 打 `v*` tag 推远端触发
Release 工作流（Release 说明由 `--generate-notes` 基于提交自动生成）。上游升级流程见
定制清单 `pnpm run customizations`（升级 runbook 见本地 .omc/UPSTREAM-UPGRADE.md）。

**自维护组件**：figma-edit-mcp server 端源码已并入主工程，按职责分布在 `src/bridge/`（插件桥进程对）、
`src/tools/`（45 工具 schema）、`src/protocol/`（频道协议）（上游基线 2.3.3，MIT，LICENSE 在仓库根；
定制以 `// figma-mcp-server 定制` 标记，清单 `pnpm run customizations` 生成
`scripts/CUSTOMIZATIONS.md` 并受 CI 护栏保护；升级 runbook 见本地 `.omc/UPSTREAM-UPGRADE.md`）。
子进程代码由 `scripts/bundle.mjs` 一并打进 broker.mjs，broker 以 `--fe-child=server|socket` spawn
自身完成路由——无任何独立产物，分发物只有 `index.mjs` + `broker.mjs` 两个文件。
Figma 插件端定制在 `plugin/`（Figma 必须从文件导入，无法内嵌）。

## 已知限制

- live 写入受 figma-edit-mcp 安全模型约束（scope 锁定/批量校验/频道配对码），错误码结构化透传
- 插件频道码已持久化（clientStorage），如需换码：Figma 控制台执行 `figma.clientStorage.deleteAsync('settings')` 后重开插件
- REST 通道为只读（Figma REST API 不支持写）
