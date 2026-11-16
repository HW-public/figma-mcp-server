import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config } from '../config.js';
import { FigmaClient, FigmaApiError } from './rest-client.js';
import { simplifyNode } from './simplify.js';

/** 从 Figma URL 解析 fileKey 和 nodeId
 *  支持: https://www.figma.com/design/:key/... ?node-id=1-2 及 /file/ 形式 */
export function parseFigmaUrl(input: string): { fileKey: string; nodeId?: string } | null {
    const m = input.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const nodeMatch = input.match(/[?&]node-id=([0-9-]+)/);
    return {
        fileKey: m[1],
        nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]).replace('-', ':') : undefined,
    };
}

export function makeRestClient(config: Config): FigmaClient {
    if (!config.figmaApiKey) {
        throw new FigmaApiError(0, 'REST_NOT_CONFIGURED: 未配置 FIGMA_API_KEY（.env 或环境变量），REST 通道不可用');
    }
    return new FigmaClient(config.figmaApiKey, config.figmaBaseUrl);
}

export const restToolDefs = [
    {
        name: 'get_design_context',
        description:
            '获取 Figma 设计上下文（结构、尺寸、颜色、文本、自动布局），面向代码生成裁剪字段。' +
            '传 figmaUrl 或 fileKey 走 REST（无头，不需要 Figma 客户端）；只传 nodeId 时也可用。',
        inputSchema: {
            type: 'object' as const,
            properties: {
                figmaUrl: { type: 'string', description: 'Figma 文件/节点链接' },
                fileKey: { type: 'string', description: '文件 key（与 figmaUrl 二选一）' },
                nodeId: { type: 'string', description: '节点 id，如 1:2；缺省为整份文件' },
                depth: { type: 'number', description: '子树最大深度，默认 6', default: 6 },
            },
        },
    },
    {
        name: 'download_images',
        description:
            '批量导出 Figma 节点为图片（PNG/JPG/SVG/PDF）。返回保存的本地路径列表。',
        inputSchema: {
            type: 'object' as const,
            properties: {
                figmaUrl: { type: 'string' },
                fileKey: { type: 'string' },
                nodeIds: { type: 'array', items: { type: 'string' }, description: '节点 id 列表' },
                format: { type: 'string', enum: ['png', 'jpg', 'svg', 'pdf'], default: 'png' },
                scale: { type: 'number', default: 2 },
                outDir: { type: 'string', description: '输出目录，默认 FIGMA_ASSETS_DIR/<fileKey>/' },
            },
            required: ['nodeIds'],
        },
    },
];

function resolveKey(input: { figmaUrl?: string; fileKey?: string }): { fileKey: string; nodeId?: string } {
    if (input.figmaUrl) {
        const parsed = parseFigmaUrl(input.figmaUrl);
        if (!parsed) throw new FigmaApiError(0, `无法解析 Figma URL: ${input.figmaUrl}`);
        return { fileKey: input.fileKey ?? parsed.fileKey, nodeId: parsed.nodeId };
    }
    if (input.fileKey) return { fileKey: input.fileKey };
    throw new FigmaApiError(0, '必须提供 figmaUrl 或 fileKey');
}

export function makeRestHandlers(config: Config) {
    return {
        async get_design_context(args: Record<string, unknown>) {
            const input = args as { figmaUrl?: string; fileKey?: string; nodeId?: string; depth?: number };
            const { fileKey, nodeId: urlNodeId } = resolveKey(input);
            const nodeId = input.nodeId ?? urlNodeId;
            const depth = Math.min(Math.max(input.depth ?? 6, 1), 20);
            const client = makeRestClient(config);

            if (nodeId) {
                const res = await client.getFileNodes(fileKey, [nodeId]);
                const entry = res.nodes[nodeId];
                if (!entry) throw new FigmaApiError(404, `节点 ${nodeId} 不存在于文件 ${fileKey}`);
                return {
                    fileName: res.name,
                    fileKey,
                    node: simplifyNode(entry.document, 0, depth),
                };
            }
            const res = await client.getFile(fileKey);
            return {
                fileName: res.name,
                fileKey,
                node: simplifyNode(res.document, 0, depth),
            };
        },

        async download_images(args: Record<string, unknown>) {
            const input = args as {
                figmaUrl?: string; fileKey?: string;
                nodeIds: string[]; format?: string; scale?: number; outDir?: string;
            };
            const { fileKey } = resolveKey(input);
            const format = input.format ?? 'png';
            const scale = input.scale ?? 2;
            const client = makeRestClient(config);

            const urls = await client.getImageUrls(fileKey, input.nodeIds, format, scale);
            const outDir = resolve(input.outDir ?? join(config.assetsDir, fileKey));
            await mkdir(outDir, { recursive: true });

            const saved: Array<{ nodeId: string; path: string }> = [];
            for (const [nodeId, url] of Object.entries(urls)) {
                const safeName = nodeId.replace(/:/g, '_');
                const filePath = join(outDir, `${safeName}.${format}`);
                const res = await fetch(url);
                if (!res.ok) throw new FigmaApiError(res.status, `下载渲染图失败 ${nodeId}: HTTP ${res.status}`);
                const buf = Buffer.from(await res.arrayBuffer());
                await writeFile(filePath, buf);
                saved.push({ nodeId, path: filePath });
            }
            return { fileKey, outDir, count: saved.length, saved };
        },
    };
}
