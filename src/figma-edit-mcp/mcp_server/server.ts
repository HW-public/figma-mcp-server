import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./logger.js";
import {
  connectToFigma,
  setFigmaServerUrl
} from "./figma-client.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources.js";
import { parseCliArgs } from "../cli.js";
import { SERVER_NAME, SERVER_VERSION } from "../shared/version.js";

// Create MCP server
const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
}, {
  instructions: "Edits a **live** Figma file under hard, plugin-enforced constraints (scope, name verification, batch validation) that return structured error codes. Before writing, and on any error, load the guidance: read the MCP resources under `figma-edit://guide/*` (constraints, error-playbook, workflows, tool-selection) or use the `figma-edit` skill. Always discover before acting (`page.info` → `node.info`) and pass node names back verbatim."
});

// Add command line argument parsing
const { port } = parseCliArgs("figma-edit-mcp");
const WS_URL = `ws://localhost:${port}`;
setFigmaServerUrl(WS_URL);

// Register all tools and resources
registerAllTools(server);
registerAllResources(server);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit when the host disconnects (closes our stdin) or on a termination
  // signal. Without this the process lingers after the host quits — the
  // figma-client reconnect timer and any open socket keep the event loop
  // alive — so orphaned MCP servers pile up across host restarts and spin
  // forever against the socket on :3055. The stdin EOF path is the reliable
  // signal (the host talks to us over the stdin pipe); transport.onclose and
  // the signal handlers are belt-and-suspenders. Set onclose AFTER connect so
  // the SDK's own handler isn't clobbered.
  const shutdown = () => process.exit(0);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    try { sdkOnClose?.(); } finally { shutdown(); }
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info('FigmaMCP server running on stdio');
}

// figma-mcp-server 定制：供 broker 以 --fe-child=server spawn 自身时路由调用
export async function runFigmaMcpServer(): Promise<void> {
  await main();
}

// Run the server —— 仅当本文件是直接进程入口（node server.js）时自启。
// 被 bundle 进 broker.mjs 后：父进程不会加载本模块（esbuild 对 import() 惰性求值）；
// 子进程 argv[1] 就是 broker.mjs（路径判定恒真），必须靠 --fe-child 判定交给 broker 路由，否则双重启动。
function isDirectEntry(): boolean {
  const entry: string | undefined = process.argv[1];
  if (!entry) return false;
  if (process.argv.some((a) => a.startsWith('--fe-child='))) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  main().catch(error => {
    logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
