# 定制清单（自动生成，勿手改）

扫描标记：`figma-mcp-server 定制` ｜ 范围：`src/bridge、src/tools、src/protocol、plugin` ｜ 由 `scripts/list-customizations.mjs` 生成

共 11 处：

- `src/bridge/server.ts:68` — // figma-mcp-server 定制：供 broker 以 --fe-child=server spawn 自身时路由调用
- `src/bridge/socket.ts:800` — // figma-mcp-server 定制：供 broker 以 --fe-child=socket spawn 自身时路由调用
- `src/tools/create.ts:42` — // figma-mcp-server 定制：创建时即设圆角（RECTANGLE only，插件侧 handler 已支持）
- `src/tools/create.ts:98` — // figma-mcp-server 定制：创建时即设圆角（插件侧 handler 已支持）
- `src/tools/create.ts:142` — // figma-mcp-server 定制：固定宽自动换行 + 对齐/行高/字距（插件侧 handler 已支持）
- `src/tools/node.ts:476` — // figma-mcp-server 定制：渐变填充（插件侧 handler 精校）
- `src/tools/node.ts:536` — // figma-mcp-server 定制：渐变填充透传插件 handler
- `src/tools/variable.ts:219` — // figma-mcp-server 定制：ADD_MODE 分支（插件侧 handler 已支持）
- `src/protocol/version.ts:1` — // figma-mcp-server 定制版（上游 readRootPackageMetadata 已删）：频道握手的 serverVersion 必须和
- `plugin/handlers/prototypingHandlers.ts:189` — // figma-mcp-server 定制：Figma API 可能抛非 Error 值（undefined/字符串），必须安全序列化，否则错误链路断成 "undefined"
- `plugin/handlers/stylingHandlers.ts:43` — // figma-mcp-server 定制：gradient 计入模式计数，否则 gradient-only 会在此被误拦（gradient 分支变死代码）
