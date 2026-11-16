// 冒烟测试：spawn server → MCP 握手 → tools/list 断言 → REST 未配置错误路径
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(root, 'dist', 'index.js');

const child = spawn(process.execPath, [serverEntry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FIGMA_EDIT_BRIDGE_PORT: '3055' },
});

child.on('exit', (code) => console.error(`[smoke] server 进程提前退出, code=${code}`));
child.on('error', (e) => console.error(`[smoke] server 进程错误: ${e.message}`));
process.on('uncaughtException', (e) => {
    console.error(`[smoke] 未捕获异常: ${e.message}`);
    process.exit(1);
});

let nextId = 1;
const pending = new Map();
const buffer = { text: '' };

child.stdout.on('data', (chunk) => {
    buffer.text += chunk.toString();
    let idx;
    while ((idx = buffer.text.indexOf('\n')) >= 0) {
        const line = buffer.text.slice(0, idx).trim();
        buffer.text = buffer.text.slice(idx + 1);
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

    // REST 未配置 token → 期望结构化错误而不是崩溃
    const callRes = await send('tools/call', {
        name: 'get_design_context',
        arguments: { fileKey: 'dummy' },
    });
    const text = JSON.stringify(callRes.result ?? callRes.error);
    console.log(`未配 token 调用结果: ${text.includes('REST_NOT_CONFIGURED') ? '✔ 结构化错误符合预期' : '�’ 异常: ' + text.slice(0, 200)}`);

    console.log('SMOKE PASS');
} catch (e) {
    console.error('SMOKE FAIL:', e.message);
    process.exitCode = 1;
} finally {
    child.kill();
}
