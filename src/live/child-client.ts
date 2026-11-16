import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from '../config.js';

const require = createRequire(import.meta.url);

export interface LiveStatus {
    socket: 'running' | 'stopped';
    bridge: 'connected' | 'disconnected';
    channel: string | null;
}

/** 解析 figma-edit-mcp 包内的 dist 文件绝对路径（exports 可能限制子路径，故从 package.json 定位） */
function resolveFigmaEditDist(...segments: string[]): string {
    const pkgJson = require.resolve('figma-edit-mcp/package.json');
    return join(dirname(pkgJson), 'dist', ...segments);
}

/**
 * Live 通道：figma-edit-mcp 子进程代理
 * - socket 桥: node figma-edit-mcp/dist/socket.js（node 直启，自动拉起）
 * - MCP server: node figma-edit-mcp/dist/server.js（作为 stdio MCP child，动态枚举/透传其 48 个工具）
 */
export class LiveChannel {
    private socketProc: ChildProcess | null = null;
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private childTools: Map<string, { name: string; description?: string; inputSchema?: unknown }> = new Map();
    private currentChannel: string | null = null;
    private onChannelPersist: (channel: string) => void;
    public status: LiveStatus = { socket: 'stopped', bridge: 'disconnected', channel: null };

    constructor(
        private config: Config,
        opts: { onChannelPersist: (channel: string) => void },
    ) {
        this.onChannelPersist = opts.onChannelPersist;
    }

    async start(): Promise<void> {
        this.spawnSocket();
        await this.connectBridge();
        if (this.config.channel) {
            await this.tryAutoJoin(this.config.channel);
        }
    }

    private spawnSocket(): void {
        try {
            const socketPath = resolveFigmaEditDist('socket.js');
            this.socketProc = spawn(process.execPath, [socketPath], {
                env: {
                    ...process.env,
                    FIGMA_EDIT_MCP_SOCKET_HOST: 'localhost',
                    FIGMA_EDIT_MCP_SOCKET_PORT: String(this.config.bridgePort),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.socketProc.stdout?.on('data', () => { /* socket 日志静默 */ });
            this.socketProc.stderr?.on('data', (d) => console.error(`[socket] ${String(d).trim()}`));
            this.socketProc.on('exit', (code) => {
                console.error(`[socket] 桥进程退出 (code=${code})，live 写入不可用，直到重启`);
                this.status.socket = 'stopped';
            });
            this.status.socket = 'running';
            console.error(`[live] socket 桥已拉起: node .../socket.js (port=${this.config.bridgePort})`);
        } catch (e) {
            console.error(`[live] socket 拉起失败: ${(e as Error).message}`);
        }
    }

    private async connectBridge(): Promise<void> {
        try {
            const serverPath = resolveFigmaEditDist('server.js');
            this.client = new Client({ name: 'figma-mcp-server-live-proxy', version: '1.0.0' });
            this.transport = new StdioClientTransport({
                command: process.execPath,
                args: [serverPath],
            });
            await this.client.connect(this.transport);
            const listed = await this.client.listTools();
            this.childTools = new Map(listed.tools.map((t) => [t.name, t]));
            this.status.bridge = 'connected';
            console.error(`[live] figma-edit-mcp 已连接，代理工具 ${listed.tools.length} 个`);
        } catch (e) {
            console.error(`[live] figma-edit-mcp 子进程连接失败: ${(e as Error).message}`);
            this.status.bridge = 'disconnected';
        }
    }

    private async tryAutoJoin(channel: string): Promise<void> {
        try {
            const result = await this.callTool('channel_join', { channel });
            const isError = (result as { isError?: boolean }).isError;
            if (!isError) {
                this.currentChannel = channel;
                this.status.channel = channel;
                console.error(`[live] 频道 '${channel}' 自动加入成功`);
            } else {
                console.error(`[live] 频道 '${channel}' 自动加入失败（码可能已轮换），等待人工 channel_join`);
            }
        } catch (e) {
            console.error(`[live] 自动 join 异常: ${(e as Error).message}`);
        }
    }

    get isBridgeConnected(): boolean {
        return this.status.bridge === 'connected';
    }

    listToolDefs() {
        return [...this.childTools.values()];
    }

    hasTool(name: string): boolean {
        return this.childTools.has(name);
    }

    async callTool(name: string, args: Record<string, unknown>) {
        if (!this.client) throw new Error('LIVE_NOT_CONNECTED: figma-edit-mcp 子进程未连接');
        const result = await this.client.callTool({ name, arguments: args });
        // channel_join 成功 → 持久化，下次启动自动 join
        if (name === 'channel_join' && !(result as { isError?: boolean }).isError) {
            const channel = (args as { channel?: string }).channel;
            if (channel) {
                this.currentChannel = channel;
                this.status.channel = channel;
                this.onChannelPersist(channel);
            }
        }
        return result;
    }

    async stop(): Promise<void> {
        try { await this.client?.close(); } catch { /* ignore */ }
        this.socketProc?.kill();
    }
}
