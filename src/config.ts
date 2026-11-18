import 'dotenv/config';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
    /** Figma REST API token；未配置时 REST 通道工具返回结构化错误 */
    figmaApiKey: string | null;
    figmaBaseUrl: string;
    /** figma-edit-mcp socket 桥端口 */
    bridgePort: number;
    /** 本地 broker 端口（瘦客户端 ↔ broker） */
    brokerPort: number;
    /** 状态目录（token/pid/日志/频道持久化，默认 %LOCALAPPDATA%\figma-mcp-server） */
    stateDir: string;
    brokerTokenFile: string;
    brokerPidFile: string;
    brokerLogFile: string;
    /** broker 无客户端闲置自退毫秒数 */
    brokerIdleExitMs: number;
    /** 工具调用审计日志（env FIGMA_MCP_AUDIT_LOG=off 关闭，默认开） */
    auditLog: boolean;
    /** figma-mcp-server 定制: broker 风暴读缓存 TTL 毫秒数（env FIGMA_MCP_READ_CACHE_TTL_MS；≤0 完全禁用） */
    readOnlyCacheTtlMs: number;
    /** 固定频道码（env 优先；未配置时读持久化文件） */
    channel: string | null;
    /** 频道持久化文件路径（join 成功后写入，供下次启动自动 join） */
    channelFile: string;
    assetsDir: string;
}

const home = homedir();

function resolveStateDir(): string {
    const env = process.env;
    const dir = env.FIGMA_MCP_STATE_DIR
        ?? join(env.LOCALAPPDATA ?? home, 'figma-mcp-server');
    try {
        mkdirSync(dir, { recursive: true });
    } catch { /* 目录创建失败不阻塞，后续写文件时再报错 */ }
    return dir;
}

/** 旧版主目录点文件 → 状态目录 自动迁移（首次运行时执行一次） */
function migrateLegacy(stateFile: string, legacyFile: string): void {
    try {
        if (!existsSync(stateFile) && existsSync(legacyFile)) {
            copyFileSync(legacyFile, stateFile);
        }
    } catch { /* 迁移失败不阻塞 */ }
}

function readPersistedChannel(stateDir: string): string | null {
    const stateFile = join(stateDir, 'channel.json');
    const legacyFile = join(home, '.figma-mcp-server.json');
    migrateLegacy(stateFile, legacyFile);
    try {
        if (!existsSync(stateFile)) return null;
        const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as { channel?: string };
        return typeof raw.channel === 'string' && raw.channel.length > 0 ? raw.channel : null;
    } catch {
        return null;
    }
}

export function loadConfig(): Config {
    const env = process.env;
    const stateDir = resolveStateDir();
    const tokenFile = join(stateDir, 'broker.token');
    migrateLegacy(tokenFile, join(home, '.figma-mcp-server.token'));
    return {
        figmaApiKey: env.FIGMA_API_KEY && env.FIGMA_API_KEY.length > 0 ? env.FIGMA_API_KEY : null,
        figmaBaseUrl: (env.FIGMA_BASE_URL ?? 'https://api.figma.com/v1').replace(/\/$/, ''),
        bridgePort: parseInt(env.FIGMA_EDIT_BRIDGE_PORT ?? '3055', 10),
        brokerPort: parseInt(env.FIGMA_MCP_BROKER_PORT ?? '3056', 10),
        stateDir,
        brokerTokenFile: tokenFile,
        brokerPidFile: join(stateDir, 'broker.pid'),
        brokerLogFile: join(stateDir, 'broker.log'),
        brokerIdleExitMs: parseInt(env.FIGMA_MCP_BROKER_IDLE_EXIT_MS ?? String(30 * 60 * 1000), 10),
        auditLog: (env.FIGMA_MCP_AUDIT_LOG ?? 'on') !== 'off',
        readOnlyCacheTtlMs: parseInt(env.FIGMA_MCP_READ_CACHE_TTL_MS ?? '1500', 10),
        channel: (env.FIGMA_MCP_CHANNEL && env.FIGMA_MCP_CHANNEL.length > 0)
            ? env.FIGMA_MCP_CHANNEL
            : readPersistedChannel(stateDir),
        channelFile: join(stateDir, 'channel.json'),
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
