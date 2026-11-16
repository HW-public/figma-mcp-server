// 冒烟测试：spawn server（bundle）→ MCP 握手 → 工具枚举 → REST 错误路径 → 多客户端并发验证
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleEntry = join(root, 'dist', 'bundle', 'index.mjs');
const tscEntry = join(root, 'dist', 'index.js');
const serverEntry = existsSync(bundleEntry) ? bundleEntry : tscEntry;
const BROKER_PORT = 3056;

const child = spawn(process.execPath, [serverEntry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
        ...process.env,
        FIGMA_EDIT_BRIDGE_PORT: '3055',
        FIGMA_MCP_BROKER_PORT: String(BROKER_PORT),
        FIGMA_MCP_BROKER_IDLE_EXIT_MS: '4000', // 冒烟后 broker 快速自退
    },
});

child.on('exit', (code) => console.error(`[smoke] server 进程退出, code=${code}`));
child.on('error', (e) => console.error(`[smoke] server 进程错误: ${e.message}`));
process.on('uncaughtException', (e) => {
    console.error(`[smoke] 未捕获异常: ${e.message}`);
    process.exit(1);
});

let nextId = 1;
const pending = new Map();
const buffer = { chunks: [] };

child.stdout.on('data', (chunk) => {
    buffer.chunks.push(chunk);
    let buf = Buffer.concat(buffer.chunks);
    for (;;) {
        const idx = buf.indexOf(0x0a);
        if (idx < 0) break;
        const line = buf.subarray(0, idx).toString('utf-8').trim();
        buffer.chunks = [buf.subarray(idx + 1)];
        buf = buffer.chunks[0];
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    }
});

function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`请求超时: ${method}`));
            }
        }, 60000);
    });
}

// ---- broker 原始 TCP 客户端（验证多客户端并发） ----
function encodeFrame(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

function brokerCall(token, msg) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: BROKER_PORT }, () => {
            socket.write(encodeFrame({ type: 'hello', token, clientName: 'smoke-raw-client' }));
        });
        let buf = Buffer.alloc(0);
        let authed = false;
        let callId = 0;
        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= 4) {
                const len = buf.readUInt32BE(0);
                if (buf.length < 4 + len) break;
                const raw = JSON.parse(buf.subarray(4, 4 + len).toString('utf-8'));
                buf = buf.subarray(4 + len);
                if (raw.type === 'welcome') {
                    authed = true;
                    callId = 1;
                    socket.write(encodeFrame({ ...msg, id: callId }));
                } else if ((raw.type === 'result' || raw.type === 'tools') && authed) {
                    socket.destroy();
                    resolve(raw);
                } else if (raw.type === 'error' || raw.type === 'invalid') {
                    socket.destroy();
                    reject(new Error(raw.message ?? 'broker error'));
                }
            }
        });
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); reject(new Error('broker 调用超时')); }, 20000);
    });
}

let failed = false;
try {
    await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const toolsRes = await send('tools/list', {});
    const names = (toolsRes.result?.tools ?? []).map((t) => t.name);
    console.log(`工具总数: ${names.length}`);
    console.log(`REST 工具: ${['get_design_context', 'download_images'].filter((n) => names.includes(n)).join(', ')}`);
    const liveOnes = names.filter((n) => ['channel_join', 'page_info', 'create_frame', 'node_info'].includes(n));
    console.log(`Live 工具样例: ${liveOnes.join(', ') || '(未连接)'}`);

    const callRes = await send('tools/call', {
        name: 'get_design_context',
        arguments: { fileKey: 'dummy' },
    });
    const text = JSON.stringify(callRes.result ?? callRes.error);
    console.log(`未配 token 调用结果: ${text.includes('REST_NOT_CONFIGURED') ? '✔ 结构化错误符合预期' : '✘ 异常: ' + text.slice(0, 200)}`);

    // 多客户端：第二个 TCP 客户端直连 broker（此时 broker 已由 server 按需拉起）
    const token = readFileSync(join(process.env.LOCALAPPDATA ?? homedir(), 'figma-mcp-server', 'broker.token'), 'utf-8').trim();
    const raw = await brokerCall(token, { type: 'tools/list' });
    const brokerToolCount = raw.tools?.length ?? 0;
    console.log(`并发客户端直连 broker: ${brokerToolCount} 个 live 工具 ${brokerToolCount >= 45 ? '✔' : '✘ 数量异常'}`);

    console.log('SMOKE PASS');
} catch (e) {
    console.error('SMOKE FAIL:', e.message);
    failed = true;
} finally {
    child.kill();
    // 注意：不杀 broker —— pidfile 指向的可能是用户正在使用的生产 broker。
    // smoke 自建的 broker 带有 FIGMA_MCP_BROKER_IDLE_EXIT_MS=4000，会自行闲置退出。
    try { unlinkSync(join(homedir(), '.figma-mcp-server.lock')); } catch { /* ignore */ } // 旧锁文件残留清理
    process.exitCode = failed ? 1 : 0;
}
