/**
 * 插件构建：esbuild 打包 + 把 ui.html 内联为 __html__ 定义，
 * 使产物 plugin/code.js 成为自包含单文件（Figma 只需要 code.js + manifest.json）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'ui.html'), 'utf-8');
// 版本单一来源：项目的 package.json（与 figma-mcp-server 同版本）
const { version: APP_VERSION } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));

await esbuild.build({
    entryPoints: [join(here, 'src', 'main.ts')],
    bundle: true,
    outfile: join(here, 'code.js'),
    format: 'iife',
    target: ['es2018'],
    platform: 'browser',
    define: {
        __PLUGIN_VERSION__: JSON.stringify(APP_VERSION),
        __html__: JSON.stringify(html),
    },
    logLevel: 'warning',
});

// 内联校验：产物必须包含 UI 特征串，否则 showUI(__html__) 会拿到 undefined
const out = readFileSync(join(here, 'code.js'), 'utf-8');
if (!out.includes('channel-card')) {
    console.error('[plugin:build] 校验失败: code.js 未内联 ui.html');
    process.exit(1);
}
console.log('[plugin:build] code.js 构建完成，UI 已内联（自包含单文件）');
