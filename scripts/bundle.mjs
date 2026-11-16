/** 打包：index.mjs（MCP server）+ broker.mjs
 *  broker bundle 内含 figma-edit-mcp 子进程代码（src/figma-edit-mcp，经 figma-child-* 别名静态打包），
 *  以 --fe-child=server|socket spawn 自身完成子进程路由 —— 分发物只有 index.mjs + broker.mjs 两个文件。
 *  版本从 package.json 单一注入。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const banner = "import { createRequire as __fe_cr } from 'node:module'; const require = __fe_cr(import.meta.url);";
// tsup 式 banner：导入必须用 __ 别名（banner 是裸文本，esbuild 看不见，名字会和包内模块的导入撞车）；
// __dirname/__filename 因 jimp 等 CJS 依赖在子进程运行时要用而 shim（tsup 默认开启，esbuild 没有）
const shimsBanner = 'import { createRequire as __fe_cr } from \'node:module\'; import { fileURLToPath as __fe_f2p } from \'node:url\'; import { dirname as __fe_dp } from \'node:path\'; const require = __fe_cr(import.meta.url); const __filename = __fe_f2p(import.meta.url); const __dirname = __fe_dp(__filename);';
const define = { 'globalThis.__APP_VERSION__': JSON.stringify(version) };


// figma-child-* 是 ambient 声明（src/broker/child-entries.d.ts），构建时别名到 vendored 源码真实模块
const aliasChildren = {
    name: 'alias-fe-children',
    setup(b) {
        b.onResolve({ filter: /^figma-child-(server|socket)$/ }, (args) => ({
            path: join(root, 'src', 'bridge', args.path === 'figma-child-server' ? 'server.ts' : 'socket.ts'),
        }));
    },
};

const common = { bundle: true, platform: 'node', target: 'node20', format: 'esm', define, logLevel: 'warning' };
await esbuild.build({ ...common, entryPoints: [join(root, 'src/index.ts')], outfile: join(root, 'dist/bundle/index.mjs'), banner: { js: banner } });
await esbuild.build({
    ...common,
    entryPoints: [join(root, 'src/broker/broker.ts')],
    outfile: join(root, 'dist/bundle/broker.mjs'),
    banner: { js: shimsBanner },
    plugins: [aliasChildren],
});
console.log(`[bundle] index.mjs + broker.mjs（子进程代码 --fe-child 路由）@ ${version}`);
