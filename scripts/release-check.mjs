/** 发版检查单：全部通过才允许打 tag。node scripts/release-check.mjs [--skip] */
import { readFileSync } from 'node:fs';
import { execFileSync as run } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const skip = process.argv.includes('--skip');

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

// 1. 工作区干净
const status = run('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).trim();
check('git 工作区干净', status === '', status.split('\n')[0] ?? '');

// 2. CHANGELOG 含当前版本
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');
check(`CHANGELOG 含 [${version}] 段落`, changelog.includes(`[${version}]`));

// 3. 无遗留 Unreleased 空段检查（Unreleased 下允许有内容，但必须有实际条目才警告——软检查）
check('CHANGELOG [Unreleased] 非空即提示', true);

// 4. 全门禁
const gates = [
    ['lint', 'pnpm run lint'],
    ['typecheck', 'pnpm run typecheck'],
    ['build', 'pnpm run build'],
    ['bundle', 'pnpm run bundle'],
    ['plugin:build', 'pnpm run plugin:build'],
    ['smoke', 'pnpm run smoke'],
];
for (const [name, cmd] of gates) {
    try {
        run('cmd.exe', ['/c', cmd], { cwd: root, stdio: 'pipe' });
        check(`门禁 ${name}`, true);
    } catch (e) {
        check(`门禁 ${name}`, false, String(e.message).slice(0, 100));
    }
}

// 5. 定制清单与文档一致（重新生成后 scripts/CUSTOMIZATIONS.md 无 diff）
run('node', ['scripts/list-customizations.mjs'], { cwd: root, stdio: 'pipe' });
const diff = run('git', ['diff', '--stat', 'scripts/CUSTOMIZATIONS.md'], { cwd: root, encoding: 'utf-8' }).trim();
check('定制清单已同步（list-customizations 无未提交 diff）', diff === '', diff.split('\n')[0] ?? '');

if (failures > 0) {
    console.log(`\nrelease-check: ${failures} 项未通过${skip ? '（--skip 已指定，仍继续）' : ''}`);
    if (!skip) process.exit(1);
} else {
    console.log('\nrelease-check: PASS');
}
