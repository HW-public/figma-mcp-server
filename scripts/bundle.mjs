/** 双入口打包：index.mjs（MCP server）+ broker.mjs，版本从 package.json 单一注入 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const banner = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";
const define = { 'globalThis.__APP_VERSION__': JSON.stringify(version) };
const common = { bundle: true, platform: 'node', target: 'node20', format: 'esm', banner: { js: banner }, define, logLevel: 'warning' };

await esbuild.build({ ...common, entryPoints: [join(root, 'src/index.ts')], outfile: join(root, 'dist/bundle/index.mjs') });
await esbuild.build({ ...common, entryPoints: [join(root, 'src/broker/broker.ts')], outfile: join(root, 'dist/bundle/broker.mjs') });
console.log(`[bundle] index.mjs + broker.mjs @ ${version}`);
