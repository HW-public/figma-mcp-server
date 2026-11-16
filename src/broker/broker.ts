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
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire as nodeCreateRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, persistChannel, type Config } from '../config.js';
import { encodeFrame, FrameDecoder } from './protocol.js';

const APP_VERSION = (globalThis as Record<string, unknown>).__APP_VERSION__ as string ?? '0.0.0-dev';

const nodeRequire = nodeCreateRequire(import.meta.url);
const VERSION = APP_VERSION;

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

        await this.ensureFigmaEditPatched();
        await this.spawnSocket();
        await this.connectBridge();
        this.startIdleTimer();
    }

    /** 给 figma-edit-mcp 打本地扩展补丁（幂等 + 语法自检）：① variable_manage 枚举加 ADD_MODE
     *  ② node_set_fill 描述补充 image.filePath 用法。
     *  注意：插入文本禁止含双引号（会截断目标文件里的字符串字面量）；写完用 node --check 自检，失败回滚。 */
    private ensureFigmaEditPatched(): void {
        try {
            const serverPath = resolveFigmaEditDist('server.js');
            const original = readFileSync(serverPath, 'utf-8');
            let src = original;
            let changed = false;

            if (!src.includes('"ADD_MODE"')) {
                const oldEnum = 'enum(["CREATE_COLLECTION", "CREATE_VARIABLE", "UPDATE_VARIABLE"])';
                if (src.includes(oldEnum)) {
                    src = src.replace(
                        oldEnum,
                        'enum(["CREATE_COLLECTION", "CREATE_VARIABLE", "UPDATE_VARIABLE", "ADD_MODE"]).describe("Action type; ADD_MODE adds a mode to an existing collection (requires collectionId + modeName, returns modeId)")',
                    );
                    changed = true;
                } else {
                    log(this.config, '警告: 未能定位 variable_manage 的 action 枚举，ADD_MODE 补丁未生效');
                }
            }

            const fillAnchor = 'or `node_bind_variable` to bind a color token.';
            if (!src.includes('For LOCAL image files use image')) {
                if (src.includes(fillAnchor)) {
                    src = src.replace(
                        fillAnchor,
                        `${fillAnchor} For LOCAL image files use image: { filePath: '<absolute path>' } (broker reads the file and converts; do NOT use file:// or localhost URLs).`,
                    );
                    changed = true;
                } else {
                    log(this.config, '警告: 未能定位 node_set_fill 描述，filePath 说明补丁未生效');
                }
            }

            // ③ create_shape schema 放行 cornerRadius（插件 handler 已支持，schema 层此前拦截 Unrecognized key）
            const shapeAnchor = 'useAbsolutePosition: external_exports.boolean().optional()';
            if (!src.includes('cornerRadius: external_exports.number()') && src.includes(shapeAnchor)) {
                src = src.replace(
                    shapeAnchor,
                    'cornerRadius: external_exports.number().min(0).optional().describe("Corner radius at creation; RECTANGLE only"), ' + shapeAnchor,
                );
                changed = true;
            }

            // ④ create_text schema 放行 width/textAlignHorizontal（锚点 fontWeight，唯一性守卫）
            const textAnchor = 'fontWeight: external_exports';
            const textMarker = 'width: external_exports.number().positive().optional().describe("Fixed width';
            if (!src.includes(textMarker)) {
                if (src.split(textAnchor).length === 2) {
                    src = src.replace(
                        textAnchor,
                        'width: external_exports.number().positive().optional().describe("Fixed width; enables wrapping (textAutoResize=HEIGHT)"), textAlignHorizontal: external_exports.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(), lineHeight: external_exports.any().optional().describe("number=pixels, or {value, unit: PIXELS|PERCENT|AUTO}"), letterSpacing: external_exports.any().optional().describe("number=pixels, or {value, unit: PIXELS|PERCENT}"), ' + textAnchor,
                    );
                    changed = true;
                } else {
                    log(this.config, `警告: create_text 补丁锚点不唯一（出现 ${src.split(textAnchor).length - 1} 次），未生效`);
                }
            }

            // ⑤ create_frame schema 放行 cornerRadius（锚点 counterAxisAlignItems，唯一性守卫）
            const frameAnchor = 'strokeWeight: external_exports';
            const frameMarker = 'Corner radius at creation (frame)';
            if (!src.includes(frameMarker)) {
                if (src.split(frameAnchor).length === 2) {
                    src = src.replace(
                        frameAnchor,
                        'cornerRadius: external_exports.number().min(0).optional().describe("' + frameMarker + '"), ' + frameAnchor,
                    );
                    changed = true;
                } else {
                    log(this.config, `警告: create_frame 补丁锚点不唯一（出现 ${src.split(frameAnchor).length - 1} 次），未生效`);
                }
            }

            // ⑥ node_set_fill schema 放行 gradient（z.any() 宽松校验，插件侧精校）
            const fillSchemaAnchor = 'image: external_exports';
            if (!src.includes('gradient: external_exports.any()')) {
                if (src.split(fillSchemaAnchor).length === 2) {
                    src = src.replace(
                        fillSchemaAnchor,
                        'gradient: external_exports.any().optional().describe("Gradient fill: {type: LINEAR|RADIAL|ANGULAR|DIAMOND, stops: [{position, color: {r,g,b,a}}], gradientTransform?}"), ' + fillSchemaAnchor,
                    );
                    changed = true;
                } else {
                    log(this.config, `警告: node_set_fill 补丁锚点不唯一（${src.split(fillAnchor).length - 1} 次），未生效`);
                }
            }

            if (!changed) return;
            writeFileSync(serverPath, src);
            try {
                execFileSync(process.execPath, ['--check', serverPath]);
                log(this.config, '已应用 figma-edit-mcp 本地补丁（ADD_MODE / filePath 说明）并通过语法自检');
            } catch (e) {
                writeFileSync(serverPath, original); // 回滚
                log(this.config, `补丁语法自检失败，已回滚: ${(e as Error).message}`);
            }
        } catch (e) {
            log(this.config, `figma-edit-mcp 补丁失败（非致命）: ${(e as Error).message}`);
        }
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
        // socket 桥就绪需要一两秒，子进程连接可能撞上未就绪 → 重试至成功
        for (let attempt = 1; attempt <= 10; attempt++) {
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
