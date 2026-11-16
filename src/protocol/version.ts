// figma-mcp-server 定制版（上游 readRootPackageMetadata 已删）：频道握手的 serverVersion 必须和
// 插件版本（= broker 版本）一致，否则插件拒连 VERSION_MISMATCH。broker spawn 本进程时经 env
// FIGMA_MCP_CHANNEL_VERSION 注入其构建版本（单一来源）；直接跑 server.js 的兜底为 0.0.0。
export const SERVER_NAME = "figma-edit-mcp";
export const SERVER_VERSION = process.env.FIGMA_MCP_CHANNEL_VERSION || "0.0.0";
