/** 扫描 vendored 源码（src + plugin）中的定制标记，生成 scripts/CUSTOMIZATIONS.md。
 *  上游升级 rebase 时对照本清单逐条补回；CI 用它做防丢护栏。 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'figma-mcp-server 定制';
const SCAN_DIRS = ['src/bridge', 'src/tools', 'src/protocol', 'plugin'];
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']); // 只扫代码文件——fe/ 里的 .md 文档提到标记会自引用失真

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) yield* walk(p);
        else if (CODE_EXT.has(name.slice(name.lastIndexOf('.')))) yield p;
    }
}

const hits = [];
for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
        const lines = readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, i) => {
            if (line.includes(MARKER)) {
                hits.push({ file: relative(root, file).replaceAll('\\', '/'), line: i + 1, text: line.trim().slice(0, 120) });
            }
        });
    }
}

const md = [
    '# 定制清单（自动生成，勿手改）',
    '',
    `扫描标记：\`${MARKER}\` ｜ 范围：\`${SCAN_DIRS.join('、')}\` ｜ 由 \`scripts/list-customizations.mjs\` 生成`,
    '',
    `共 ${hits.length} 处：`,
    '',
    ...hits.map((h) => `- \`${h.file}:${h.line}\` — ${h.text.replaceAll('`', "'")}`),
    '',
].join('\n');

writeFileSync(join(root, "scripts", "CUSTOMIZATIONS.md"), md);
console.log(`[customizations] ${hits.length} 处定制 → scripts/CUSTOMIZATIONS.md`);
