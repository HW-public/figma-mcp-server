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

// figma-mcp-server 定制: 从错误文本提取错误码——优先 JSON 的 errorCode/code 字段，回退 [CODE] 方括号形式
function extractErrorCode(msg: string): string | undefined {
    return (/"(?:errorCode|code)"\s*:\s*"([A-Z][A-Z0-9_]*)"/.exec(msg)
        ?? /\[([A-Z][A-Z0-9_]{3,})\]/.exec(msg))?.[1];
}

// figma-mcp-server 定制: 从 MCP CallToolResult 提取 content 文本（isError 结果的错误信息载体）；
// 无 content 文本时回退整体序列化，保证错误码正则仍可命中
function extractContentText(result: unknown): string {
    const content = (result as { content?: Array<{ type?: string; text?: unknown }> }).content;
    if (Array.isArray(content)) {
        const text = content
            .map((c) => (typeof c?.text === 'string' ? c.text : ''))
            .filter(Boolean)
            .join('\n');
        if (text) return text;
    }
    return JSON.stringify(result) ?? '';
}

// figma-mcp-server 定制: 审计日志参数摘要——bytesBase64 脱敏为 <bytes:N>（N 为解码后约字节数），
// 长 filePath 截尾只留末段，整体序列化截 100 字符，防 base64/绝对路径刷屏
function summarizeForAudit(args: unknown): string {
    const sanitize = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sanitize);
        if (v !== null && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                if (k === 'bytesBase64' && typeof val === 'string') {
                    out[k] = `<bytes:${Math.round(val.length * 3 / 4)}>`;
                } else if (k === 'filePath' && typeof val === 'string' && val.length > 60) {
                    out[k] = `…${val.slice(-40)}`;
                } else {
                    out[k] = sanitize(val);
                }
            }
            return out;
        }
        return v;
    };
    let s: string;
    try {
        s = JSON.stringify(sanitize(args)) ?? '';
    } catch {
        s = String(args);
    }
    return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

// figma-mcp-server 定制: 解析图像字节流的像素尺寸（PNG 读 IHDR，JPEG 扫 SOF 段），
// 供 node_export_visual 落盘 maxDimension 保护用；格式不认识返回 undefined（不阻断）
function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) { // PNG: \x89PNG
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) { // JPEG: FFD8
        let off = 2;
        while (off + 9 < bytes.length) {
            if (bytes[off] !== 0xff) { off++; continue; }
            const marker = bytes[off + 1];
            // SOF0-SOF15（排除 DHT/JPG/DAC 非帧段）：段内高 2 字节 + 宽 2 字节
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
            }
            off += 2 + bytes.readUInt16BE(off + 2);
        }
    }
    return undefined;
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

// figma-mcp-server 定制: 正式错误码（protocol/errorCodes.ts 的 RATIFIED_CODES 及 join 流程码）
// → 中文提示。translateError 优先按 errorCode/code 精确查本表，查不到才回退全文正则，
// 避免宽泛正则误伤（旧 /instance/i 曾把 MISSING_SOURCE_INSTANCE_ID 误译）。
const TRANSLATE_CODE_DICT: Record<string, string> = {
    // —— socket 桥准入（D13）——
    PLUGIN_PEER_UNAVAILABLE: '[中文] 插件未连接：Figma 插件离线，打开插件点 Connect',
    PLUGIN_PEER_AMBIGUOUS: '[中文] 插件实例不唯一：同名插件开了多个，只保留一个并重新 Connect',
    CHANNEL_IN_USE: '[中文] 频道被占用：该频道码已绑定其他会话，请换一个频道码或等对方断开',
    VERSION_MISMATCH: '[中文] 版本不匹配：插件与 MCP server 版本不一致，重跑 install.ps1 升级安装',
    // —— MCP client 前置状态 ——
    CHANNEL_NOT_BOUND: '[中文] 频道未绑定：Figma 插件未连接，打开插件点 Connect',
    // —— join 流程 ——
    MISSING_CHANNEL: '[中文] 缺少频道名：请传插件状态栏显示的 4 位频道码',
    CHANNEL_JOIN_FAILED: '[中文] 加入频道失败：插件未在预期时间内确认，重连插件后重试',
    PLUGIN_DISCONNECTED: '[中文] 插件已断开：可编辑范围尚未读取完成插件就断了，重新打开插件再试',
    // —— 页面/文档操作（PAGE_LOAD_FAILED 族）——
    PAGE_LOAD_FAILED: '[中文] 页面加载失败：请重试；持续失败则重新打开插件',
    PAGE_SCAN_FAILED: '[中文] 页面读取失败：页面已加载但读取中断，重试或缩小读取范围',
    PAGE_NOT_FOUND: '[中文] 页面不存在：pageId 可能已变化，重新 page_info 获取',
    TARGET_NOT_PAGE: '[中文] 目标不是页面：该操作要求 page 级节点，请传 pageId',
    PAGE_LOAD_TIMEOUT: '[中文] 页面加载超时：文档过大或网络慢，稍后重试',
    DOCUMENT_SCAN_INCOMPLETE: '[中文] 文档扫描不完整：部分页面未读完，结果可能不全，重试',
    VARIABLE_IN_USE: '[中文] 变量正在被使用：请先删除/替换所有引用该变量的节点再操作',
    // —— D5 校验拒绝 ——
    VARIABLE_NAME_MISSING: '[中文] 缺少变量名：先用 variable_list 读当前名称，原样传回',
    VARIABLE_NAME_MISMATCH: '[中文] 变量名不匹配：先用 variable_list 读当前名称，原样传回',
    COLLECTION_NAME_MISSING: '[中文] 缺少集合名：先用 variable_list 读当前集合名，原样传回',
    COLLECTION_NAME_MISMATCH: '[中文] 集合名不匹配：先用 variable_list 读当前集合名，原样传回',
    STYLE_NAME_MISSING: '[中文] 缺少样式名：先用 style_list 读当前样式名，原样传回',
    STYLE_NAME_MISMATCH: '[中文] 样式名不匹配：先用 style_list 读当前样式名，原样传回',
    VARIABLE_SCOPES_MISSING: '[中文] 缺少变量作用域：请从 variable_list 读取 scopes 原样传回',
    // —— D6 父级校验 ——
    PARENT_NAME_MISSING: '[中文] 缺少父级名称：先用 node_info 读父级当前名称，原样传回',
    PARENT_NAME_MISMATCH: '[中文] 父级名称不匹配：先用 node_info 读父级当前名称，原样传回',
    // —— 注释/范围/实例 ——
    ANNOTATION_CATEGORY_NOT_FOUND: '[中文] 注释分类不存在：annotation_list 读取有效分类 id 后重试',
    SCOPE_INVALID: '[中文] 可编辑范围无效：请在插件里重新设置 Link to Selection 范围',
    MISSING_SOURCE_INSTANCE_ID: '[中文] 缺少源组件实例 ID：请先 instance_get_overrides 读取当前实例 id，原样传回',
};

// figma-mcp-server 定制: 风暴读缓存——只读工具名单（src/tools/ 里 annotations.readOnlyHint=true 的全部 9 个，
// 逐个核对）；不在名单内的一律视为写工具：成功返回后清空整个读缓存（失败不清，数据没变）
const READ_ONLY_TOOLS = new Set([
    'node_info',
    'page_info',
    'annotation_list',
    'component_list',
    'instance_get_overrides',
    'node_export_visual',
    'reaction_list',
    'style_list',
    'variable_list',
]);

// figma-mcp-server 定制: 缓存键规范化——递归排序对象 key 后 JSON.stringify，避免键序差异导致 miss
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

interface QueueEntry {
    owner: number; // socket id，断开时清理其未执行项
    enqueuedAt: number; // figma-mcp-server 定制: 入队时间，出队时算 waitMs 做拥塞可见
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
    // figma-mcp-server 定制: 风暴读缓存（TTL 见 config.readOnlyCacheTtlMs，≤0 完全禁用；
    // 键=tool+规范化args，值=深拷贝结果+timestamp；任何写工具成功即整表清空）
    private readCache = new Map<string, { value: unknown; timestamp: number }>();
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
    // figma-mcp-server 定制: 记录最近一次 join 失败的真实错误信封（子进程 structuredContent 里的
    // errorCode/errorMessage）。失败时由 execTool 透传给客户端，不再把子进程错误吞掉、
    // 也不再拿上次成功的旧 pages/node 数据冒充失败结果。
    private lastJoinError: { errorCode?: string; errorMessage?: string } | null = null;

    /** 从子进程 channel_join 结果中提取失败信封：子进程把失败写在 structuredContent.status='error'
     *  （isError 恒为 false，toolResult 从不置位），只认 isError 会把失败误判为成功 */
    private extractJoinFailure(result: unknown): { errorCode?: string; errorMessage?: string } | null {
        const env = (result as { structuredContent?: Record<string, unknown> } | null)?.structuredContent;
        if (env && env.status === 'error') {
            return {
                errorCode: typeof env.errorCode === 'string' ? env.errorCode : undefined,
                errorMessage: typeof env.errorMessage === 'string' ? env.errorMessage : undefined,
            };
        }
        return null;
    }

    private async joinChannel(channel: string): Promise<boolean> {
        if (!this.mcpClient) return false;
        this.lastJoinError = null;
        try {
            const result = await this.mcpClient.callTool({ name: 'channel_join', arguments: { channel } });
            const failure = this.extractJoinFailure(result);
            if (!(result as { isError?: boolean }).isError && !failure) {
                this.lastJoinPayload = result;
                this.currentChannel = channel;
                persistChannel(this.config.channelFile, channel);
                log(this.config, `频道 '${channel}' 已加入`);
                return true;
            }
            // figma-mcp-server 定制: 透传子进程返回的 error 信封（code/message），不再吞掉错误详情
            this.lastJoinError = failure ?? { errorMessage: 'channel_join 返回失败但未携带错误详情' };
            log(this.config, `频道 '${channel}' 加入失败: ${JSON.stringify(this.lastJoinError)}`);
        } catch (e) {
            this.lastJoinError = { errorMessage: (e as Error).message };
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
                enqueuedAt: Date.now(),
                run: run as () => Promise<unknown>,
                resolve: resolve as (v: unknown) => void,
                reject,
            });
            // figma-mcp-server 定制: 拥塞可见——队列积压超过 8 个调用即告警
            if (this.queue.length > 8) {
                log(this.config, `[拥堵] 队列积压 ${this.queue.length} 个调用`);
            }
            void this.drain();
        });
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        while (this.queue.length > 0) {
            const entry = this.queue.shift()!;
            // figma-mcp-server 定制: 拥塞可见——排队超 15s 的调用出队时记一行等待时长
            const waitMs = Date.now() - entry.enqueuedAt;
            if (waitMs > 15000) {
                log(this.config, `[拥堵] 调用排队等待 ${(waitMs / 1000).toFixed(1)}s，队列长度 ${this.queue.length}`);
            }
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
        if (msg.includes('[中文]')) return msg;
        // figma-mcp-server 定制: 优先解析错误对象/消息中的 errorCode/code 字段，按正式错误码
        // （protocol/errorCodes.ts 的 RATIFIED_CODES 等）精确查表给中文；查不到再回退全文正则兜底。
        // 旧版仅靠 8 条宽泛正则：/instance/i 会把 MISSING_SOURCE_INSTANCE_ID（参数缺失）误译成
        // "组件实例内部禁止修改"，故 instance 相关只保留下面的精确码映射，不再用宽泛正则。
        const code = extractErrorCode(msg);
        if (code) {
            const zh = TRANSLATE_CODE_DICT[code];
            // figma-mcp-server 定制: 译文保留原始错误码后缀，AI 可程序化匹配错误类型
            if (zh) return `${zh} (code: ${code}) | 原始: ${msg}`;
        }
        const dict: Array<[RegExp, string]> = [
            [/PARENT_OUTSIDE_SCOPE|SCOPE_DELETED|SCOPE_INVALID|outside.*scope/i, '[中文] 目标在可编辑范围之外：请在插件里扩大 Link to Selection 范围'],
            [/NAME_MISMATCH|name.*mismatch|currentVariableName/i, '[中文] 名称不匹配：先用 node_info/variable_list 读当前名称，原样传回'],
            [/locked/i, '[中文] 图层已锁定：先在 Figma 里解锁'],
            [/CHANNEL_NOT_BOUND/i, '[中文] 频道未绑定：Figma 插件未连接，打开插件点 Connect'],
            [/remote library|read-only in this file/i, '[中文] 远程库资源只读：请到源库文件修改'],
            [/READ_ONLY_MODE|STYLE_EDITS_DISABLED|VARIABLE_EDITS_DISABLED/i, '[中文] 只读/编辑受限：当前绑定不允许该类修改，请在插件里放开对应编辑权限'],
            [/not found|NOT_FOUND|no longer exists/i, '[中文] 节点/资源不存在：id 可能已变化，重新 node_info 获取'],
            [/Unrecognized key|invalid_argument/i, '[中文] 参数被 schema 拒绝：核对工具描述里的字段名与类型'],
        ];
        for (const [re, zh] of dict) {
            if (re.test(msg)) return zh + (code ? ` (code: ${code})` : '') + ' | 原始: ' + msg;
        }
        return msg;
    }

    // figma-mcp-server 定制: 给读工具结果注入 fromCache/snapshotAgeMs 元信息；优先注入 structuredContent
    // （各工具 outputSchema 均 loose catchall，附加键通过校验），无 structuredContent 时退到结果顶层
    private injectCacheMeta(result: unknown, fromCache: boolean, snapshotAgeMs: number): unknown {
        if (result !== null && typeof result === 'object') {
            const env = (result as { structuredContent?: unknown }).structuredContent;
            const target = env !== null && typeof env === 'object'
                ? env as Record<string, unknown>
                : result as Record<string, unknown>;
            target.fromCache = fromCache;
            target.snapshotAgeMs = snapshotAgeMs;
        }
        return result;
    }

    private async execToolWrapped(name: string, args: Record<string, unknown>): Promise<unknown> {
        // figma-mcp-server 定制: 工具调用审计（FIGMA_MCP_AUDIT_LOG=off 全关，默认开），出入口各一行
        const startedAt = Date.now();
        if (this.config.auditLog) log(this.config, `[call] ${name} ${summarizeForAudit(args)}`);
        // figma-mcp-server 定制: 风暴读缓存——只读工具先查缓存，命中直接返回深拷贝（防调用方串改缓存）
        const isReadOnly = READ_ONLY_TOOLS.has(name);
        const ttl = this.config.readOnlyCacheTtlMs;
        const cacheKey = isReadOnly && ttl > 0 ? `${name}|${stableStringify(args)}` : null;
        if (cacheKey) {
            const hit = this.readCache.get(cacheKey);
            if (hit) {
                const age = Date.now() - hit.timestamp;
                if (age <= ttl) {
                    const value = this.injectCacheMeta(structuredClone(hit.value), true, age);
                    if (this.config.auditLog) {
                        log(this.config, `[ok-cache] ${name} ${Date.now() - startedAt}ms cache=hit age=${age}ms`);
                    }
                    return value;
                }
                this.readCache.delete(cacheKey); // 过期即清，防内存滞留
            }
        }
        try {
            const result = await this.execTool(name, args);
            if ((result as { isError?: boolean }).isError) {
                // figma-mcp-server 定制: SDK 的 isError 结果提取 content 文本走与 catch 分支相同的
                // translateError 处理，保持 isError 语义返回给瘦客户端（result 对象自带 isError 字段，
                // client/live.ts 原样透传 → src/server.ts 原样返回 CallToolResult）
                const message = this.translateError(extractContentText(result));
                if (this.config.auditLog) {
                    log(this.config, `[fail] ${name} ${Date.now() - startedAt}ms ${extractErrorCode(message) ?? '-'}: ${message.slice(0, 150)}`);
                }
                return { isError: true, content: [{ type: 'text', text: message }] };
            }
            // join 失败时 result.status==='failed'（无 isError），审计不能记 ok
            const joinFailed = (result as { status?: string })?.status === 'failed';
            if (this.config.auditLog && !joinFailed) {
                // figma-mcp-server 定制：耗时分解——插件侧计时随 structuredContent.durationMs 回传
                const total = Date.now() - startedAt;
                const pluginMs = (result as { structuredContent?: { durationMs?: number } })?.structuredContent?.durationMs;
                const breakdown = typeof pluginMs === 'number' ? ` (plugin ${pluginMs}ms | 链路 ${Math.max(total - pluginMs, 0)}ms)` : '';
                log(this.config, `[ok] ${name} ${total}ms${breakdown}`);
            }
            if (isReadOnly) {
                // figma-mcp-server 定制: 只读成功结果存深拷贝（注入元信息前先存，缓存保持干净快照）
                if (cacheKey) this.readCache.set(cacheKey, { value: structuredClone(result), timestamp: Date.now() });
                return this.injectCacheMeta(result, false, 0);
            }
            // figma-mcp-server 定制: 写工具成功（含 batch 内每个写 op、channel_join 换频道）→ 清空整个
            // 读缓存；joinFailed 等失败语义不清（数据没变，旧快照仍有效）
            if (!joinFailed) this.readCache.clear();
            return result;
        } catch (e) {
            const message = this.translateError((e as Error).message);
            if (this.config.auditLog) {
                log(this.config, `[fail] ${name} ${Date.now() - startedAt}ms ${extractErrorCode(message) ?? '-'}: ${message.slice(0, 150)}`);
            }
            throw new Error(message);
        }
    }

    private async execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.mcpClient) throw new Error('LIVE_NOT_CONNECTED: figma-edit-mcp 子进程未连接');
        args = await this.materializeImageArgs(args);
        if (name === 'channel_join') {
            const channel = (args as { channel?: string }).channel;
            if (!channel) throw new Error('channel_join 需要 channel 参数');
            const ok = await this.joinChannel(channel);
            // figma-mcp-server 定制: 失败时返回真实错误信封（errorCode/errorMessage），
            // 不再把 lastJoinPayload（上次成功的旧 pages/node 数据）套上一层 status:'failed' 返回
            if (!ok) {
                const err = this.lastJoinError ?? {};
                return {
                    status: 'failed',
                    channel,
                    ...(err.errorCode ? { errorCode: err.errorCode } : {}),
                    ...(err.errorMessage ? { errorMessage: err.errorMessage } : {}),
                };
            }
            const payload = (this.lastJoinPayload ?? {}) as Record<string, unknown>;
            return { ...payload, status: 'success', channel };
        }
        let result = await this.mcpClient.callTool({ name, arguments: args });
        // 频道未绑定时自动重 join（用持久化码）并重试一次
        if ((result as { isError?: boolean }).isError && JSON.stringify(result).includes('CHANNEL_NOT_BOUND')) {
            if (this.config.channel && await this.joinChannel(this.config.channel)) {
                result = await this.mcpClient.callTool({ name, arguments: args });
            }
        }
        // figma-mcp-server 定制: node_export_visual + args.filePath → base64 图像落盘，
        // 大图不挤占 MCP 上下文；写文件失败不阻断，回退原样返回
        if (name === 'node_export_visual' && typeof (args as { filePath?: unknown }).filePath === 'string') {
            const maxDim = (args as { maxDimension?: unknown }).maxDimension;
            return this.persistExportedImage(
                result,
                (args as { filePath: string }).filePath,
                typeof maxDim === 'number' && maxDim > 0 ? maxDim : 4096,
            );
        }
        return result;
    }

    /** node_export_visual 落盘：structuredContent 里的 base64 字段（实测为顶层 imageData，SVG 时为 svg 无 base64）
     *  写入 filePath，原位替换为 {filePath, bytes}；写失败/无 base64 均回退原样返回并 log。
     *  maxDimension 保护（默认 4096）：解析 PNG IHDR / JPEG SOF 得到像素尺寸，超限拒绝落盘并说明（截断需重编码，broker 不做） */
    private persistExportedImage(result: unknown, filePath: string, maxDimension: number): unknown {
        const env = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;
        if (!env) return result;
        let key: 'imageData' | 'data' | undefined;
        if (typeof env.imageData === 'string') key = 'imageData';
        else if (typeof env.data === 'string') key = 'data';
        const nested = (env.image as Record<string, unknown> | undefined)?.base64;
        try {
            if (key) {
                const bytes = Buffer.from(env[key] as string, 'base64');
                const dims = imageDimensions(bytes);
                if (dims && Math.max(dims.width, dims.height) > maxDimension) {
                    // figma-mcp-server 定制: 超限拒绝——throw 走 execToolWrapped 的错误翻译，客户端拿到明确原因
                    throw new Error(`node_export_visual 导出图 ${dims.width}x${dims.height} 超过 maxDimension=${maxDimension}，已拒绝落盘：请降低 scale 或调大 maxDimension 重试`);
                }
                if (bytes.length > 5 * 1024 * 1024) {
                    log(this.config, `node_export_visual 落盘警告: ${Math.round(bytes.length / 1024 / 1024)}MB > 5MB（${filePath}）`);
                }
                writeFileSync(filePath, bytes);
                env[key] = { filePath, bytes: bytes.length };
            } else if (typeof nested === 'string') {
                const bytes = Buffer.from(nested, 'base64');
                const dims = imageDimensions(bytes);
                if (dims && Math.max(dims.width, dims.height) > maxDimension) {
                    throw new Error(`node_export_visual 导出图 ${dims.width}x${dims.height} 超过 maxDimension=${maxDimension}，已拒绝落盘：请降低 scale 或调大 maxDimension 重试`);
                }
                if (bytes.length > 5 * 1024 * 1024) {
                    log(this.config, `node_export_visual 落盘警告: ${Math.round(bytes.length / 1024 / 1024)}MB > 5MB（${filePath}）`);
                }
                writeFileSync(filePath, bytes);
                env.image = { filePath, bytes: bytes.length };
            } else {
                log(this.config, 'node_export_visual 落盘: structuredContent 无 base64 字段（SVG？），原样返回');
            }
        } catch (e) {
            // figma-mcp-server 定制: 超限拒绝要向上抛给客户端；仅写文件失败才回退原样返回
            if ((e as Error).message.includes('maxDimension')) throw e;
            log(this.config, `node_export_visual 落盘失败: ${(e as Error).message}，原样返回`);
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

    /** 深度解析 args 中的 @opN.path / @名字.path 引用（N=同批 op 序号；名字=op.clientRef，
     *  优先按 clientRef 匹配，未命中回退数字索引；path=该 op 返回结果的字段路径） */
    private resolveRefs(
        value: unknown,
        prior: unknown[],
        ops: Array<{ name: string; clientRef?: string }>,
    ): unknown {
        if (typeof value === 'string') {
            const m = /^@([\w-]+)\.(.+)$/.exec(value);
            if (!m) return value;
            // figma-mcp-server 定制: @名字.路径——先按 clientRef 匹配
            const refName = m[1];
            let idx = /^op\d+$/.test(refName) ? -1 : ops.findIndex((op) => op.clientRef === refName);
            if (idx < 0) {
                // figma-mcp-server 定制: 回退数字索引（兼容 "@opN" 与裸 "@N"）
                const digits = /^op(\d+)$/.exec(refName)?.[1] ?? (/^\d+$/.test(refName) ? refName : '');
                idx = digits === '' ? -1 : parseInt(digits, 10);
            }
            if (idx < 0 || idx >= prior.length) {
                const available = ops
                    .map((op, i) => (op.clientRef ? `${op.clientRef}(=#${i})` : null))
                    .filter(Boolean)
                    .join(', ');
                throw new Error(`batch 引用未解析: "${value}"（没有 clientRef 为 "${refName}" 的 op，索引 ${refName} 也无已完成结果；可用 clientRef: ${available || '无'}；可用索引: 0..${prior.length - 1}）`);
            }
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
        if (Array.isArray(value)) return value.map((v) => this.resolveRefs(v, prior, ops));
        if (value !== null && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) out[k] = this.resolveRefs(v, prior, ops);
            return out;
        }
        return value;
    }

    /** 批量执行：作为一个队列单元串行执行，默认遇错继续并汇总结果。
     *  verbose=true（显式）回全量结果；默认每个成功 op 只回 {index,name,clientRef?,id?,durationMs?} 摘要 */
    private async execBatch(
        ops: Array<{ name: string; args?: Record<string, unknown>; clientRef?: string }>,
        abortOnError: boolean,
        verbose: boolean,
    ): Promise<unknown> {
        const MAX_OPS = 200;
        const trimmed = ops.slice(0, MAX_OPS);
        // figma-mcp-server 定制: clientRef 冲突检测——同批同名 clientRef 直接报错（列 op 序号），不静默覆盖
        const seenRefs = new Map<string, number>();
        for (let i = 0; i < trimmed.length; i++) {
            const ref = trimmed[i].clientRef;
            if (!ref) continue;
            const prev = seenRefs.get(ref);
            if (prev !== undefined) {
                throw new Error(`batch clientRef 冲突: op#${prev} 与 op#${i} 都声明了 "${ref}"，同名引用会互相覆盖；请给其中一个改名`);
            }
            seenRefs.set(ref, i);
        }
        const results: Array<Record<string, unknown>> = [];
        const fullResults: Array<Record<string, unknown>> = [];
        const rawByIndex: unknown[] = [];
        const failures: Array<{ index: number; name: string; args?: Record<string, unknown>; code?: string; message: string }> = [];
        const startedAt = Date.now();
        for (let i = 0; i < trimmed.length; i++) {
            const op = trimmed[i];
            try {
                const resolvedArgs = this.resolveRefs(op.args ?? {}, rawByIndex, trimmed) as Record<string, unknown>;
                const result = await this.execToolWrapped(op.name, resolvedArgs);
                if ((result as { isError?: boolean }).isError) {
                    // figma-mcp-server 定制: isError 项计入 failed，failures 带 code/message 摘要（修 allOk 虚高）
                    const message = extractContentText(result).slice(0, 200);
                    const code = extractErrorCode(message);
                    // figma-mcp-server 定制: 失败项回显原始 args，排障靠它（@引用未解析时看到的是提交原样）
                    failures.push({ index: i, name: op.name, args: op.args ?? {}, ...(code ? { code } : {}), message });
                    results.push({ index: i, ok: false, error: `${code ? `${code}: ` : ''}${message}` });
                    if (abortOnError) break;
                } else {
                    rawByIndex[i] = result;
                    fullResults.push({ index: i, ok: true, result });
                    // figma-mcp-server 定制: 默认瘦身——从大结果对象提取摘要字段，防批量大图撑爆上下文
                    const env = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;
                    results.push({
                        index: i,
                        name: op.name,
                        ...(op.clientRef ? { clientRef: op.clientRef } : {}),
                        ...(typeof env?.id === 'string' ? { id: env.id } : {}),
                        ...(typeof env?.durationMs === 'number' ? { durationMs: env.durationMs } : {}),
                    });
                }
            } catch (e) {
                const message = (e as Error).message.slice(0, 200);
                const code = extractErrorCode(message);
                failures.push({ index: i, name: op.name, args: op.args ?? {}, ...(code ? { code } : {}), message });
                results.push({ index: i, ok: false, error: `${code ? `${code}: ` : ''}${message}` });
                if (abortOnError) break;
            }
        }
        // figma-mcp-server 定制: batch 审计汇总行 + 失败项简摘（开关同单调审计）
        if (this.config.auditLog) {
            log(this.config, `[batch] ${trimmed.length} ops → ${results.length}/${failures.length} (${Date.now() - startedAt}ms)`);
            for (const f of failures) {
                log(this.config, `[batch-fail] #${f.index} ${f.name}: ${(f.code ?? f.message).slice(0, 150)}`);
            }
        }
        const summary = {
            total: ops.length,
            executed: results.length,
            failed: failures.length,
            allOk: failures.length === 0,
        };
        // figma-mcp-server 定制: 默认只回摘要（results 为瘦身项 + failures）；verbose=true 才回全量结果
        return verbose
            ? { ...summary, results: fullResults }
            : { ...summary, results, failures };
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
                        (msg.ops ?? []) as Array<{ name: string; args?: Record<string, unknown>; clientRef?: string }>,
                        Boolean(msg.abortOnError),
                        // figma-mcp-server 定制: 默认瘦身摘要，verbose 显式 true 才回全量结果
                        msg.verbose === true,
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
    // 崩溃留遗言：broker 此前为静默崩溃（无任何日志），此处记录堆栈后退出，
    // 瘦客户端会自动拉起新实例（broker.log 里可查到死因）
    process.on('uncaughtException', (e) => {
        log(config, `未捕获异常（进程退出）: ${e.stack ?? e.message}`);
        broker.shutdown(1);
    });
    process.on('unhandledRejection', (reason) => {
        log(config, `未处理 Promise 拒绝: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    });
    broker.start().catch((e) => {
        console.error(`[broker] 启动失败: ${(e as Error).message}`);
        process.exit(1);
    });
}
