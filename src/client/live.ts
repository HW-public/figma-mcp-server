import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { encodeFrame, FrameDecoder, type BrokerMsg } from '../broker/protocol.js';

export interface LiveStatus {
    broker: 'connecting' | 'connected' | 'disconnected';
    channel: string | null;
}

/**
 * Live 通道（瘦客户端）：不 spawn 任何 Figma 相关进程，
 * 通过 TCP 连接常驻 broker；broker 不在时按需 detached 拉起（首个客户端负责唤醒）。
 */
export class LiveChannel {
    private socket: Socket | null = null;
    private decoder = new FrameDecoder();
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private toolDefs: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    private triedSpawn = false;
    private connectAttempt = 0;
    public status: LiveStatus = { broker: 'disconnected', channel: null };

    constructor(
        private config: Config,
        private opts: { onChannelPersist: (channel: string) => void },
    ) {}

    get isBridgeConnected(): boolean {
        return this.status.broker === 'connected';
    }

    listToolDefs() {
        return this.toolDefs;
    }

    hasTool(name: string): boolean {
        return this.toolDefs.some((t) => t.name === name);
    }

    async start(): Promise<void> {
        this.status.broker = 'connecting';
        for (;;) {
            try {
                await this.connectOnce();
                return; // connectOnce 内部在 socket close 时递归重连，正常不会走到这
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === 'ECONNREFUSED' && !this.triedSpawn) {
                    this.triedSpawn = true;
                    this.spawnBroker();
                    await this.waitPort(this.config.brokerPort, 15_000);
                    continue;
                }
                this.connectAttempt++;
                const backoff = Math.min(2 ** this.connectAttempt * 1000, 10_000);
                console.error(`[live] broker 连接失败（${err.message}），${backoff / 1000}s 后重试`);
                this.status.broker = 'disconnected';
                await sleep(backoff);
            }
        }
    }

    private connectOnce(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let established = false;
            const socket = connect({ host: '127.0.0.1', port: this.config.brokerPort }, () => {
                this.socket = socket;
                socket.write(encodeFrame({
                    type: 'hello',
                    token: this.readToken(),
                    clientName: 'figma-mcp-server',
                }));
            });
            socket.on('data', (chunk) => {
                for (const raw of this.decoder.feed(chunk)) {
                    const msg = raw as BrokerMsg;
                    if (msg.type === 'welcome') {
                        established = true;
                        this.status = { broker: 'connected', channel: msg.channel };
                        this.connectAttempt = 0;
                        console.error(`[live] broker 已连接（bridge=${msg.bridge} channel=${msg.channel ?? '无'}）`);
                        void this.refreshTools();
                        resolve();
                    } else if (msg.type === 'tools') {
                        this.toolDefs = msg.tools;
                    } else if (msg.type === 'result' || msg.type === 'error') {
                        const p = this.pending.get(msg.id);
                        if (p) {
                            this.pending.delete(msg.id);
                            if (msg.type === 'result') p.resolve(msg.result);
                            else p.reject(new Error(msg.message));
                        }
                    } else if (msg.type === 'batch-result') {
                        const p = this.pending.get(msg.id);
                        if (p) {
                            this.pending.delete(msg.id);
                            p.resolve({
                                total: msg.total,
                                executed: msg.executed,
                                failed: msg.failed,
                                allOk: msg.allOk,
                                results: msg.results,
                                failures: msg.failures,
                            });
                        }
                    }
                }
            });
            socket.on('error', (e) => reject(e as NodeJS.ErrnoException));
            socket.on('close', () => {
                if (this.socket === socket) this.socket = null;
                // 仅已完成握手的连接断开才自愈重连；连接失败走 start() 循环，避免双循环
                if (!established) return;
                this.status.broker = 'disconnected';
                for (const [, p] of this.pending) p.reject(new Error('LIVE_NOT_CONNECTED: broker 连接断开'));
                this.pending.clear();
                setTimeout(() => {
                    this.start().catch(() => { /* 下一轮继续 */ });
                }, 3_000);
            });
        });
    }

    private readToken(): string {
        try {
            return readFileSync(this.config.brokerTokenFile, 'utf-8').trim();
        } catch {
            return '';
        }
    }

    private resolveBrokerPath(): string {
        const here = dirname(fileURLToPath(import.meta.url));
        // bundle 布局：<dir>/index.mjs + <dir>/broker.mjs
        const bundled = join(here, 'broker.mjs');
        if (existsSync(bundled)) return bundled;
        // tsc 布局：dist/client/live.js → dist/broker/broker.js
        return join(here, '..', 'broker', 'broker.js');
    }

    private spawnBroker(): void {
        try {
            const proc = spawn(process.execPath, [this.resolveBrokerPath()], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true, // Windows 下 detached 默认弹控制台窗口，必须隐藏
                env: { ...process.env },
            });
            proc.unref();
            console.error(`[live] broker 未运行，已按需拉起（pid=${proc.pid}）`);
        } catch (e) {
            console.error(`[live] broker 拉起失败: ${(e as Error).message}`);
        }
    }

    private async waitPort(port: number, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                await new Promise<void>((res, rej) => {
                    const s = connect({ host: '127.0.0.1', port, timeout: 1000 }, () => { s.destroy(); res(); });
                    s.on('error', rej);
                    s.on('timeout', () => { s.destroy(); rej(new Error('timeout')); });
                });
                return;
            } catch {
                await sleep(300);
            }
        }
        throw new Error(`broker 端口 ${port} 等待超时`);
    }

    private async refreshTools(): Promise<void> {
        try {
            const tools = (await this.request({ type: 'tools/list' })) as { tools: LiveChannel['toolDefs'] };
            this.toolDefs = tools.tools ?? [];
            console.error(`[live] live 工具已刷新：${this.toolDefs.length} 个`);
        } catch {
            /* 下次再说 */
        }
    }

    /** tools/list 发现空表时（broker 桥尚未就绪）主动同步一次，带短超时；之后桥就绪的推送会再补 */
    async ensureTools(timeoutMs = 3000): Promise<void> {
        if (this.toolDefs.length > 0 || this.status.broker !== 'connected') return;
        try {
            const tools = (await this.request({ type: 'tools/list' }, timeoutMs)) as { tools: LiveChannel['toolDefs'] };
            this.toolDefs = tools.tools ?? [];
        } catch { /* 保持空表，等桥就绪推送 */ }
    }

    private request(msg: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                reject(new Error('LIVE_NOT_CONNECTED: broker 未连接'));
                return;
            }
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.socket.write(encodeFrame({ ...msg, id }));
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`请求超时: ${String(msg.type)}`));
            }, timeoutMs);
        });
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (name === 'channel_join') {
            const channel = (args as { channel?: string }).channel;
            if (channel) this.opts.onChannelPersist(channel);
        }
        return this.request({ type: 'tools/call', name, args });
    }

    /** 批量执行 live 工具（一次往返，broker 内逐条串行 + 汇总结果；大批量放宽超时） */
    async callBatch(
        ops: Array<{ name: string; args?: Record<string, unknown> }>,
        abortOnError?: boolean,
        verbose?: boolean,
    ): Promise<unknown> {
        return this.request(
            { type: 'tools/batch', ops, abortOnError: Boolean(abortOnError), verbose: verbose !== false },
            150_000,
        );
    }

    async stop(): Promise<void> {
        this.socket?.destroy();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
