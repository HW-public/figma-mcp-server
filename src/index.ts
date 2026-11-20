import { loadConfig } from './config.js';
import { LiveChannel } from './client/live.js';
import { createServer, startStdioServer } from './server.js';

async function main(): Promise<void> {
    const config = loadConfig();

    if (!config.figmaApiKey) {
        console.error('[figma-mcp-server] 提示: 未配置 FIGMA_API_KEY，REST 通道工具将返回 REST_NOT_CONFIGURED');
    }

    // 瘦客户端：连接常驻 broker（不在则按需拉起）。broker 是全机唯一 Figma 链路 owner，
    // 多会话并发安全由 broker 侧每频道 FIFO 保证；channel.json 也由 broker 统一维护（含频道池）
    const live = new LiveChannel(config, {});
    const liveReady = live.start().catch((e) => {
        console.error(`[live] 启动异常: ${(e as Error).message}`);
    });
    await Promise.race([
        liveReady,
        new Promise((r) => setTimeout(r, 30_000)),
    ]);

    const server = createServer(config, live);
    await startStdioServer(server);

    const shutdown = async () => {
        await live.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((e) => {
    console.error(`[figma-mcp-server] 启动失败: ${(e as Error).message}`);
    process.exit(1);
});
