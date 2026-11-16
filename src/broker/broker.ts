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
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, persistChannel, type Config } from '../config.js';
import { encodeFrame, FrameDecoder } from './protocol.js';

const APP_VERSION = (globalThis as Record<string, unknown>).__APP_VERSION__ as string ?? '0.0.0-dev';

/** 本文件路径：broker 以 `--fe-child=server|socket` spawn 自身，子进程在 bundle 内路由到对应入口 */
const selfPath = fileURLToPath(import.meta.url);
const VERSION = APP_VERSION;

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** 日志单文件轮转：超过 5MB 改名 .1（MCP 场景日志量小，单备份足够） */
function rotateLogIfNeeded(file: string): void {
    try {
        if (statSync(file).size < LOG_ROTATE_BYTES) return;
        const bak = `${file}.1`;
        try { unlinkSync(bak); } catch { /* 不存在则忽略 */ }
        renameSync(file, bak);
    } catch { /* 文件不存在等，忽略 */ }
}

function log(config: Config, line: string): void {
    const stamp = new Date().toISOString();
    try {
        mkdirSync(dirname(config.brokerLogFile), { recursive: true });
        rotateLogIfNeeded(config.brokerLogFile);
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
        log(this.config, `figma-mcp-broker v${VERSION} 启动（state: ${this.config.stateDir}）`);

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
        this.checkForUpdates();
    }

    /** 异步探测 GitHub 新版本（3s 超时，失败静默，不阻塞启动） */
    private checkForUpdates(): void {
        void (async () => {
            try {
                const res = await fetch('https://api.github.com/repos/HW-public/figma-mcp-server/releases/latest', {
                    signal: AbortSignal.timeout(3000),
                    headers: { 'User-Agent': 'figma-mcp-server' },
                });
                if (!res.ok) return;
                const rel = await res.json() as { tag_name?: string; html_url?: string; published_at?: string };
                const latest = String(rel.tag_name ?? '').replace(/^v/, '');
                if (!latest || latest === VERSION) return;
                writeFileSync(join(this.config.stateDir, 'update-available.json'), JSON.stringify({
                    current: VERSION,
                    latest,
                    url: rel.html_url ?? '',
                    publishedAt: rel.published_at ?? '',
                }, null, 2));
                log(this.config, `新版本可用: v${latest}（当前 v${VERSION}）→ 重跑 install.ps1 升级`);
            } catch { /* 离线/超时静默跳过 */ }
        })();
    }

    // ---- Figma 链路（socket + figma-edit-mcp child） ----

    private spawnSocket(): void {
        try {
            // 子进程代码已 bundle 进本文件，spawn 自身 + argv 路由到 socket 桥入口
            this.socketProc = spawn(process.execPath, [selfPath, '--fe-child=socket'], {
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
        // socket 桥就绪需要一两秒，子进程连接可能撞上未就绪 → 重试至成功
        for (let attempt = 1; attempt <= 10; attempt++) {
            try {
                this.mcpClient = new Client({ name: 'figma-mcp-broker', version: VERSION });
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    // 子进程代码已 bundle 进本文件，spawn 自身 + argv 路由到 MCP server 入口
                    args: [selfPath, '--fe-child=server'],
                    env: {
                        ...process.env,
                        FIGMA_MCP_CHANNEL_VERSION: VERSION,
                        // server 子进程按此 env 找 socket 桥；不显式传会默认 3055 撞到现场桥
                        FIGMA_EDIT_MCP_SOCKET_PORT: String(this.config.bridgePort),
                    },
                });
                await this.mcpClient.connect(transport);
                const listed = await this.mcpClient.listTools();
                this.childTools = listed.tools;
                this.bridgeState = 'connected';
                this.broadcastTools(); // 桥晚于客户端就绪时，主动补推工具表，避免瘦客户端停在空表
                log(this.config, `figma-edit-mcp 已连接，工具 ${listed.tools.length} 个`);
                if (this.config.channel) {
                    await this.joinChannel(this.config.channel);
                }
                return;
            } catch (e) {
                log(this.config, `figma-edit-mcp 连接失败（第 ${attempt}/10 次）: ${(e as Error).message}`);
                try { await this.mcpClient?.close(); } catch { /* ignore */ }
                this.mcpClient = null;
                await new Promise((r) => setTimeout(r, 1500));
            }
        }
        log(this.config, 'figma-edit-mcp 重试 10 次仍失败，live 通道不可用');
    }

    private lastJoinPayload: unknown = null;

    private async joinChannel(channel: string): Promise<boolean> {
        if (!this.mcpClient) return false;
        try {
            const result = await this.mcpClient.callTool({ name: 'channel_join', arguments: { channel } });
            if (!(result as { isError?: boolean }).isError) {
                this.lastJoinPayload = result;
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

    /** image.filePath → 读取本地文件转 bytesBase64（插件无法访问 localhost/本地文件，由 broker 代劳）。
     *  容错：filePath 误放在 args 顶层时自动归位到 image.filePath。 */
    private async materializeImageArgs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        let image = (args as { image?: { filePath?: string } }).image;
        if (!image && typeof (args as { filePath?: unknown }).filePath === 'string') {
            const { filePath: topPath, ...restArgs } = args;
            args = { ...restArgs, image: { filePath: topPath } };
            image = args.image as { filePath?: string };
        }
        if (!image || typeof image.filePath !== 'string') return args;
        const { readFileSync } = await import('node:fs');
        const bytes = readFileSync(image.filePath);
        if (bytes.length > 20 * 1024 * 1024) {
            throw new Error(`图片文件过大（${Math.round(bytes.length / 1024 / 1024)}MB > 20MB）: ${image.filePath}`);
        }
        const rest = { ...image };
        delete rest.filePath;
        return { ...args, image: { ...rest, bytesBase64: bytes.toString('base64') } };
    }

    /** node_info 属性过滤：filter.property=[点路径]，filter.equals/contains=[值列表]；剪枝结果树（保留命中节点及祖先），大幅减少客户端上下文 */
    private pruneByPropertyFilter(result: Record<string, unknown>, filter: Record<string, string[]>): unknown {
        const env = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? result;
        const nodes = (env as { nodes?: unknown[] }).nodes;
        if (!Array.isArray(nodes)) return result;
        const prop = filter.property?.[0] ?? filter['#property']?.[0];
        const allowed = (filter.equals ?? filter['#equals'] ?? []).map((v) => String(v).toLowerCase());
        const contains = (filter.contains ?? filter['#contains'] ?? []).map((v) => String(v).toLowerCase());
        if (!prop || (allowed.length === 0 && contains.length === 0)) return result;
        const lookup = (obj: unknown, path: string): unknown => {
            let cur = obj;
            for (const key of path.split('.')) {
                if (cur === null || typeof cur !== 'object') return undefined;
                cur = (cur as Record<string, unknown>)[key];
            }
            return cur;
        };
        const hit = (node: unknown): boolean => {
            const props = (node as { properties?: unknown })?.properties;
            const haystacks = [node, props].map((t) => JSON.stringify(lookup(t, prop) ?? null).toLowerCase());
            return (allowed.length > 0 && allowed.some((a) => haystacks.some((h) => h.includes('"' + a + '"') || h === a)))
                || (contains.length > 0 && contains.some((c) => haystacks.some((h) => h.includes(c))));
        };
        const prune = (node: unknown): Record<string, unknown> | null => {
            const n = node as Record<string, unknown>;
            const childList = n.children as unknown[];
            const children = Array.isArray(childList) ? childList.map(prune).filter(Boolean) : [];
            const selfHit = hit(n);
            if (!selfHit && children.length === 0) return null;
            return selfHit ? { ...n, children, matched: true } : { ...n, children };
        };
        (env as Record<string, unknown>).nodes = nodes.map(prune).filter(Boolean);
        return result;
    }

    /** 常见英文错误 → 中文提示（在原文前附加，不替换以保留排障信息） */
    private translateError(msg: string): string {
        const dict: Array<[RegExp, string]> = [
            [/PARENT_OUTSIDE_SCOPE|SCOPE_DELETED|outside.*scope/i, '[中文] 目标在可编辑范围之外：请在插件里扩大 Link to Selection 范围'],
            [/NAME_MISMATCH|name.*mismatch|currentVariableName/i, '[中文] 名称不匹配：先用 node_info/variable_list 读当前名称，原样传回'],
            [/instance/i, '[中文] 组件实例内部禁止修改：请改主组件或在实例上设置 override'],
            [/locked/i, '[中文] 图层已锁定：先在 Figma 里解锁'],
            [/CHANNEL_NOT_BOUND/i, '[中文] 频道未绑定：Figma 插件未连接，打开插件点 Connect'],
            [/remote library|read-only in this file/i, '[中文] 远程库资源只读：请到源库文件修改'],
            [/not found|NOT_FOUND|no longer exists/i, '[中文] 节点/资源不存在：id 可能已变化，重新 node_info 获取'],
            [/Unrecognized key|invalid_argument/i, '[中文] 参数被 schema 拒绝：核对工具描述里的字段名与类型'],
        ];
        for (const [re, zh] of dict) {
            if (re.test(msg) && !msg.includes('[中文]')) return zh + ' | 原始: ' + msg;
        }
        return msg;
    }

    private async execToolWrapped(name: string, args: Record<string, unknown>): Promise<unknown> {
        try {
            const result = await this.execTool(name, args);
            if ((result as { isError?: boolean }).isError) {
                const text = JSON.stringify(result);
                return { isError: true, content: [{ type: 'text', text: this.translateError(text) }] };
            }
            return result;
        } catch (e) {
            throw new Error(this.translateError((e as Error).message));
        }
    }

    private async execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.mcpClient) throw new Error('LIVE_NOT_CONNECTED: figma-edit-mcp 子进程未连接');
        args = await this.materializeImageArgs(args);
        if (name === 'channel_join') {
            const channel = (args as { channel?: string }).channel;
            if (!channel) throw new Error('channel_join 需要 channel 参数');
            const ok = await this.joinChannel(channel);
            const payload = (this.lastJoinPayload ?? {}) as Record<string, unknown>;
            return { ...payload, status: ok ? 'success' : 'failed', channel };
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

    /** 按点路径在对象中查找，未命中返回 undefined */
    private lookupPath(obj: unknown, path: string): unknown {
        let cur = obj;
        for (const key of path.split('.')) {
            if (cur === null || typeof cur !== 'object') return undefined;
            cur = (cur as Record<string, unknown>)[key];
        }
        return cur;
    }

    /** 深度解析 args 中的 @opN.path 引用（N=同批 op 序号，path=该 op 返回结果的字段路径） */
    private resolveRefs(value: unknown, prior: unknown[]): unknown {
        if (typeof value === 'string') {
            const m = /^@op(\d+)\.(.+)$/.exec(value);
            if (!m) return value;
            const idx = parseInt(m[1], 10);
            let cur = this.lookupPath(prior[idx], m[2]);
            // MCP 工具返回是信封 {content, structuredContent}：顶层取不到时回退 structuredContent
            if (cur === undefined) {
                const env = prior[idx];
                if (env !== null && typeof env === 'object' && 'structuredContent' in (env as Record<string, unknown>)) {
                    cur = this.lookupPath((env as Record<string, unknown>).structuredContent, m[2]);
                }
            }
            if (cur === undefined) {
                throw new Error(`batch 引用未解析: "${value}"（op${idx} 的结果中没有路径 ${m[2]}；提示: create_* 的 id 在 structuredContent.id，可直接用 @op${idx}.id）`);
            }
            return cur;
        }
        if (Array.isArray(value)) return value.map((v) => this.resolveRefs(v, prior));
        if (value !== null && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) out[k] = this.resolveRefs(v, prior);
            return out;
        }
        return value;
    }

    /** 批量执行：作为一个队列单元串行执行，默认遇错继续并汇总结果 */
    private async execBatch(
        ops: Array<{ name: string; args?: Record<string, unknown> }>,
        abortOnError: boolean,
        verbose: boolean,
    ): Promise<unknown> {
        const MAX_OPS = 200;
        const trimmed = ops.slice(0, MAX_OPS);
        const results: Array<Record<string, unknown>> = [];
        const rawByIndex: unknown[] = [];
        const failures: Array<{ index: number; name: string; error: string }> = [];
        for (let i = 0; i < trimmed.length; i++) {
            const op = trimmed[i];
            try {
                const resolvedArgs = this.resolveRefs(op.args ?? {}, rawByIndex) as Record<string, unknown>;
                const result = await this.execToolWrapped(op.name, resolvedArgs);
                if ((result as { isError?: boolean }).isError) {
                    const error = JSON.stringify(result).slice(0, 500);
                    failures.push({ index: i, name: op.name, error });
                    results.push({ index: i, ok: false, error });
                    if (abortOnError) break;
                } else {
                    rawByIndex[i] = result;
                    results.push({ index: i, ok: true, result });
                }
            } catch (e) {
                const error = (e as Error).message;
                failures.push({ index: i, name: op.name, error });
                results.push({ index: i, ok: false, error });
                if (abortOnError) break;
            }
        }
        const summary = {
            total: ops.length,
            executed: results.length,
            failed: failures.length,
            allOk: failures.length === 0,
        };
        return verbose === false
            ? { ...summary, failures }
            : { ...summary, results };
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
                this.broadcastTools(); // 认证即推当前工具表（可能为空，桥就绪后还会再推）
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
            case 'tools/call': {
                const callArgs = (msg.args ?? {}) as Record<string, unknown>;
                this.enqueue(getId(), async () => {
                    const filter = (callArgs as { filter?: Record<string, string[]> }).filter;
                    if (msg.name === 'node_info' && filter && (filter.property || filter['#property'])) {
                        const result = await this.execToolWrapped(String(msg.name), callArgs) as Record<string, unknown>;
                        return this.pruneByPropertyFilter(result, filter);
                    }
                    return this.execToolWrapped(String(msg.name), callArgs);
                }).then(
                    (result) => send({ type: 'result', id: msg.id, result }),
                    (e: Error) => send({ type: 'error', id: msg.id, message: e.message }),
                );
                break;
            }
            case 'tools/batch':
                this.enqueue(getId(), () =>
                    this.execBatch(
                        (msg.ops ?? []) as Array<{ name: string; args?: Record<string, unknown> }>,
                        Boolean(msg.abortOnError),
                        msg.verbose !== false,
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

    /** 向全部已认证客户端推送当前 live 工具表（认证时 + 桥就绪/变化时） */
    private broadcastTools(): void {
        const frame = encodeFrame({ type: 'tools', tools: this.childTools ?? [] });
        for (const [, socket] of this.clients) {
            if (!socket.destroyed) socket.write(frame);
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
// bundle 内包含 figma-edit-mcp 子进程代码；以 --fe-child=server|socket 被 spawn 时路由到对应入口，
// 否则正常启动 broker。figma-child-* 为 ambient 声明（src/broker/child-entries.d.ts），
// bundle 时由 scripts/bundle.mjs 别名到 src/figma-edit-mcp 的真实模块。

const childArg = process.argv.find((a) => a.startsWith('--fe-child='));

if (childArg) {
    const mode = childArg.split('=')[1];
    const run = mode === 'server'
        ? import('figma-child-server').then((m) => m.runFigmaMcpServer())
        : mode === 'socket'
            ? import('figma-child-socket').then((m) => { m.runSocketBridge(); })
            : Promise.reject(new Error(`未知 --fe-child 模式: ${mode}`));
    run.catch((e) => {
        console.error(`[fe-child:${mode}] 启动失败: ${(e as Error).message}`);
        process.exit(1);
    });
} else {
    const config = loadConfig();
    const broker = new Broker(config);
    process.on('SIGINT', () => broker.shutdown(130));
    process.on('SIGTERM', () => broker.shutdown(143));
    broker.start().catch((e) => {
        console.error(`[broker] 启动失败: ${(e as Error).message}`);
        process.exit(1);
    });
}
