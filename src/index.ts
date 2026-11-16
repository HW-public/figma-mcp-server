import { loadConfig, persistChannel } from './config.js';
import { LiveChannel } from './live/child-client.js';
import { createServer, startStdioServer } from './server.js';

async function main(): Promise<void> {
    const config = loadConfig();

    if (!config.figmaApiKey) {
        console.error('[figma-mcp-server] 提示: 未配置 FIGMA_API_KEY，REST 通道工具将返回 REST_NOT_CONFIGURED');
    }

    const live = new LiveChannel(config, {
        onChannelPersist: (channel) => persistChannel(config.channelFile, channel),
    });
    // live 通道异步拉起，但给 stdio 启动设 30s 上限：
    // 慢机器/冷启动下不阻塞 MCP 握手，桥连上后工具自然出现
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
