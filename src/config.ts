import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
    /** Figma REST API token；未配置时 REST 通道工具返回结构化错误 */
    figmaApiKey: string | null;
    figmaBaseUrl: string;
    /** figma-edit-mcp socket 桥端口 */
    bridgePort: number;
    /** 固定频道码（env 优先；未配置时读持久化文件） */
    channel: string | null;
    /** 频道持久化文件路径（join 成功后写入，供下次启动自动 join） */
    channelFile: string;
    assetsDir: string;
}

const channelFile = join(homedir(), '.figma-mcp-server.json');

function readPersistedChannel(): string | null {
    try {
        if (!existsSync(channelFile)) return null;
        const raw = JSON.parse(readFileSync(channelFile, 'utf-8')) as { channel?: string };
        return typeof raw.channel === 'string' && raw.channel.length > 0 ? raw.channel : null;
    } catch {
        return null;
    }
}

export function loadConfig(): Config {
    const env = process.env;
    return {
        figmaApiKey: env.FIGMA_API_KEY && env.FIGMA_API_KEY.length > 0 ? env.FIGMA_API_KEY : null,
        figmaBaseUrl: (env.FIGMA_BASE_URL ?? 'https://api.figma.com/v1').replace(/\/$/, ''),
        bridgePort: parseInt(env.FIGMA_EDIT_BRIDGE_PORT ?? '3055', 10),
        channel: (env.FIGMA_MCP_CHANNEL && env.FIGMA_MCP_CHANNEL.length > 0)
            ? env.FIGMA_MCP_CHANNEL
            : readPersistedChannel(),
        channelFile,
        assetsDir: env.FIGMA_ASSETS_DIR ?? './figma-assets',
    };
}

export function persistChannel(file: string, channel: string): void {
    try {
        writeFileSync(file, JSON.stringify({ channel }, null, 2));
    } catch (e) {
        console.error(`[config] 频道码持久化失败: ${(e as Error).message}`);
    }
}
