/**
 * figma-mcp-broker：全机唯一的 Figma 链路守护进程
 *
 * 独占 socket 桥 (:3055) + figma-edit-mcp 子进程 + 频道；
 * 多个 MCP server（瘦客户端）通过 TCP 127.0.0.1:3056 连接本进程。
 * 工具调用经 FIFO 互斥队列串行执行（画布单写者语义）。
 * 客户端数归零且闲置超过配置时长后自退。
 *
 * 启动方式：一般由首个瘦客户端按需 detached 拉起，也可手动 node dist/broker/broker.js。
 */
import { createServer, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire as nodeCreateRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, persistChannel, type Config } from '../config.js';
import { encodeFrame, FrameDecoder } from './protocol.js';

const nodeRequire = nodeCreateRequire(import.meta.url);
const VERSION = '1.0.7';

function resolveFigmaEditDist(...segments: string[]): string {
    const pkgJson = nodeRequire.resolve('figma-edit-mcp/package.json');
    return join(dirname(pkgJson), 'dist', ...segments);
}

function log(config: Config, line: string): void {
    const stamp = new Date().toISOString();
    try {
        mkdirSync(dirname(config.brokerLogFile), { recursive: true });
        appendFileSync(config.brokerLogFile, `[${stamp}] ${line}\n`);
    } catch { /* 日志失败不影响运行 */ }
    console.error(`[broker] ${line}`);
}

function ensureToken(config: Config): string {
    try {
        if (existsSync(config.brokerTokenFile)) {
            return readFileSync(config.brokerTokenFile, 'utf-8').trim();
        }
        const token = randomBytes(16).toString('hex');
        writeFileSync(config.brokerTokenFile, token);
        return token;
    } catch (e) {
        throw new Error(`token 初始化失败: ${(e as Error).message}`);
    }
}

interface QueueEntry {
    owner: number; // socket id，断开时清理其未执行项
    run: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

class Broker {
    private token: string;
    private clients = new Map<number, Socket>();
    private nextClientId = 1;
    private socketProc: ChildProcess | null = null;
    private mcpClient: Client | null = null;
    private childTools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    private bridgeState: 'connected' | 'disconnected' = 'disconnected';
    private currentChannel: string | null = null;
    private queue: QueueEntry[] = [];
    private draining = false;
    private lastEmptyAt = Date.now();
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(private config: Config) {
        this.token = ensureToken(config);
    }

    async start(): Promise<void> {
        writeFileSync(this.config.brokerPidFile, String(process.pid));

        // 先抢端口再拉子进程：并发唤醒场景下，抢不到 3056 的实例必须空手退出，
        // 否则会产生孤儿 socket/child 抢占频道
        const server = createServer((socket) => this.handleSocket(socket));
        await new Promise<void>((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen(this.config.brokerPort, '127.0.0.1', () => {
                server.removeListener('error', rejectListen);
                resolveListen();
            });
        });
        log(this.config, `监听 127.0.0.1:${this.config.brokerPort}，token=${this.token.slice(0, 6)}…`);

        await this.spawnSocket();
        await this.connectBridge();
        this.startIdleTimer();
    }

    // ---- Figma 链路（socket + figma-edit-mcp child） ----

    private spawnSocket(): void {
        try {
            const socketPath = resolveFigmaEditDist('socket.js');
            this.socketProc = spawn(process.execPath, [socketPath], {
                env: {
                    ...process.env,
                    FIGMA_EDIT_MCP_SOCKET_HOST: 'localhost',
                    FIGMA_EDIT_MCP_SOCKET_PORT: String(this.config.bridgePort),
                },
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
            this.socketProc.stderr?.on('data', (d) => log(this.config, `[socket] ${String(d).trim()}`));
            this.socketProc.on('exit', (code) => {
                log(this.config, `socket 桥退出 code=${code}`);
                this.bridgeState = 'disconnected';
            });
            log(this.config, `socket 桥已拉起 :${this.config.bridgePort}`);
        } catch (e) {
            log(this.config, `socket 拉起失败: ${(e as Error).message}`);
        }
    }

    private async connectBridge(): Promise<void> {
        try {
            const serverPath = resolveFigmaEditDist('server.js');
            this.mcpClient = new Client({ name: 'figma-mcp-broker', version: VERSION });
            const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
            await this.mcpClient.connect(transport);
            const listed = await this.mcpClient.listTools();
            this.childTools = listed.tools;
            this.bridgeState = 'connected';
            log(this.config, `figma-edit-mcp 已连接，工具 ${listed.tools.length} 个`);
            if (this.config.channel) {
                await this.joinChannel(this.config.channel);
            }
        } catch (e) {
            log(this.config, `figma-edit-mcp 连接失败: ${(e as Error).message}`);
        }
    }

    private async joinChannel(channel: string): Promise<boolean> {
        if (!this.mcpClient) return false;
        try {
            const result = await this.mcpClient.callTool({ name: 'channel_join', arguments: { channel } });
            if (!(result as { isError?: boolean }).isError) {
                this.currentChannel = channel;
                persistChannel(this.config.channelFile, channel);
                log(this.config, `频道 '${channel}' 已加入`);
                return true;
            }
            log(this.config, `频道 '${channel}' 加入失败`);
        } catch (e) {
            log(this.config, `join 异常: ${(e as Error).message}`);
        }
        return false;
    }

    /** FIFO 互斥队列：所有工具调用串行执行，保证画布操作顺序一致性 */
    private enqueue<T>(owner: number, run: () => Promise<T>): Promise<T> {
        this.lastEmptyAt = Date.now();
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                owner,
                run: run as () => Promise<unknown>,
                resolve: resolve as (v: unknown) => void,
                reject,
            });
            void this.drain();
        });
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        while (this.queue.length > 0) {
            const entry = this.queue.shift()!;
            try {
                entry.resolve(await entry.run());
            } catch (e) {
                entry.reject(e as Error);
            }
        }
        this.draining = false;
    }

    private async execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.mcpClient) throw new Error('LIVE_NOT_CONNECTED: figma-edit-mcp 子进程未连接');
        if (name === 'channel_join') {
            const channel = (args as { channel?: string }).channel;
            if (!channel) throw new Error('channel_join 需要 channel 参数');
            const ok = await this.joinChannel(channel);
            return { status: ok ? 'success' : 'failed', channel };
        }
        let result = await this.mcpClient.callTool({ name, arguments: args });
        // 频道未绑定时自动重 join（用持久化码）并重试一次
        if ((result as { isError?: boolean }).isError && JSON.stringify(result).includes('CHANNEL_NOT_BOUND')) {
            if (this.config.channel && await this.joinChannel(this.config.channel)) {
                result = await this.mcpClient.callTool({ name, arguments: args });
            }
        }
        return result;
    }

    /** 批量执行：作为一个队列单元串行执行，默认遇错继续并汇总结果 */
    private async execBatch(
        ops: Array<{ name: string; args?: Record<string, unknown> }>,
        abortOnError: boolean,
    ): Promise<unknown> {
        const MAX_OPS = 200;
        const trimmed = ops.slice(0, MAX_OPS);
        const results: Array<{ ok: true; result: unknown } | { ok: false; error: string }> = [];
        for (const op of trimmed) {
            try {
                const result = await this.execTool(op.name, op.args ?? {});
                if ((result as { isError?: boolean }).isError) {
                    results.push({ ok: false, error: JSON.stringify(result).slice(0, 500) });
                    if (abortOnError) break;
                } else {
                    results.push({ ok: true, result });
                }
            } catch (e) {
                results.push({ ok: false, error: (e as Error).message });
                if (abortOnError) break;
            }
        }
        return {
            total: ops.length,
            executed: results.length,
            allOk: results.every((r) => r.ok),
            results,
        };
    }

    // ---- 客户端连接 ----

    private handleSocket(socket: Socket): void {
        const decoder = new FrameDecoder();
        let clientId = 0;
        let authed = false;

        socket.on('data', (chunk) => {
            for (const msg of decoder.feed(chunk)) {
                this.handleMsg(socket, msg, () => clientId, () => authed, () => { authed = true; },
                    (id) => { clientId = id; });
            }
        });
        socket.on('close', () => {
            if (clientId > 0) {
                this.clients.delete(clientId);
                // 清理该客户端未执行的队列项，避免死客户端卡队列
                this.queue = this.queue.filter((q) => q.owner !== clientId);
                log(this.config, `客户端 #${clientId} 断开，剩余 ${this.clients.size} 个`);
                if (this.clients.size === 0) this.lastEmptyAt = Date.now();
            }
        });
        socket.on('error', () => { /* close 事件兜底 */ });
    }

    private handleMsg(
        socket: Socket,
        raw: unknown,
        getId: () => number,
        isAuthed: () => boolean,
        setAuthed: () => void,
        setId: (id: number) => void,
    ): void {
        const msg = raw as Record<string, unknown>;
        const send = (obj: unknown) => {
            if (!socket.destroyed) socket.write(encodeFrame(obj));
        };

        if (!isAuthed()) {
            if (msg?.type === 'hello' && msg.token === this.token) {
                const id = this.nextClientId++;
                this.clients.set(id, socket);
                setId(id);
                setAuthed();
                log(this.config, `客户端 #${id}（${String(msg.clientName ?? 'unknown')}）已认证`);
                send({
                    type: 'welcome',
                    serverVersion: VERSION,
                    bridge: this.bridgeState,
                    channel: this.currentChannel,
                });
            } else {
                send({ type: 'invalid', message: 'auth failed' });
                socket.destroy();
            }
            return;
        }

        switch (msg?.type) {
            case 'tools/list':
                send({ type: 'tools', tools: this.childTools });
                break;
            case 'tools/call':
                this.enqueue(getId(), () =>
                    this.execTool(String(msg.name), (msg.args ?? {}) as Record<string, unknown>),
                ).then(
                    (result) => send({ type: 'result', id: msg.id, result }),
                    (e: Error) => send({ type: 'error', id: msg.id, message: e.message }),
                );
                break;
            case 'tools/batch':
                this.enqueue(getId(), () =>
                    this.execBatch(
                        (msg.ops ?? []) as Array<{ name: string; args?: Record<string, unknown> }>,
                        Boolean(msg.abortOnError),
                    ),
                ).then(
                    (result) => send({ type: 'batch-result', id: msg.id, ...(result as object) }),
                    (e: Error) => send({ type: 'error', id: msg.id, message: e.message }),
                );
                break;
            case 'status':
                send({
                    type: 'status-report',
                    clients: this.clients.size,
                    bridge: this.bridgeState,
                    channel: this.currentChannel,
                    queued: this.queue.length,
                });
                break;
            default:
                send({ type: 'invalid', message: `unknown type: ${String(msg?.type)}` });
        }
    }

    private startIdleTimer(): void {
        this.idleTimer = setInterval(() => {
            if (this.clients.size === 0 && Date.now() - this.lastEmptyAt > this.config.brokerIdleExitMs) {
                log(this.config, '闲置超时，自退');
                this.shutdown(0);
            }
        }, 30_000);
    }

    shutdown(code: number): void {
        if (this.idleTimer) clearInterval(this.idleTimer);
        try { this.mcpClient?.close(); } catch { /* ignore */ }
        this.socketProc?.kill();
        try { unlinkSync(this.config.brokerPidFile); } catch { /* ignore */ }
        process.exit(code);
    }
}

// ---- 入口 ----

const config = loadConfig();
const broker = new Broker(config);
process.on('SIGINT', () => broker.shutdown(130));
process.on('SIGTERM', () => broker.shutdown(143));
broker.start().catch((e) => {
    console.error(`[broker] 启动失败: ${(e as Error).message}`);
    process.exit(1);
});
