import type { FigmaNode } from './rest-client.js';

export interface SimplifiedNode {
    id: string;
    name: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    text?: string;
    fills?: string[];   // 已解析为 hex/rgba 字符串
    strokes?: string[];
    strokeWeight?: number;
    cornerRadius?: number;
    autoLayout?: {
        mode: string;
        itemSpacing?: number;
        padding?: [number, number, number, number]; // top right bottom left
        primaryAxisAlign?: string;
        counterAxisAlign?: string;
    };
    children?: SimplifiedNode[];
}

/** 把 Figma REST 的 fills/strokes 数组解析为可读颜色字符串 */
export function paintToString(paint: Record<string, unknown>): string | null {
    if (paint.visible === false) return null;
    if (paint.type === 'SOLID') {
        const c = paint.color as { r: number; g: number; b: number } | undefined;
        if (!c) return null;
        const to255 = (v: number) => Math.round(v * 255);
        const alpha = typeof paint.opacity === 'number' ? paint.opacity : 1;
        const hex = `#${[c.r, c.g, c.b].map((v) => to255(v).toString(16).padStart(2, '0')).join('')}`;
        return alpha >= 1 ? hex : `${hex} @ ${Math.round(alpha * 100)}%`;
    }
    return String(paint.type).toLowerCase();
}

/** 递归简化节点树，面向代码生成场景裁剪字段 */
export function simplifyNode(node: FigmaNode, depth: number, maxDepth: number): SimplifiedNode {
    const box = node.absoluteBoundingBox;
    const out: SimplifiedNode = {
        id: node.id,
        name: node.name,
        type: node.type,
    };
    if (box) {
        out.x = Math.round(box.x);
        out.y = Math.round(box.y);
        out.width = Math.round(box.width);
        out.height = Math.round(box.height);
    }
    if (typeof node.characters === 'string') out.text = node.characters;
    if (node.fills) out.fills = node.fills.map(paintToString).filter((s): s is string => s !== null);
    if (node.strokes) out.strokes = node.strokes.map(paintToString).filter((s): s is string => s !== null);
    if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
    if (typeof node.cornerRadius === 'number') out.cornerRadius = node.cornerRadius;
    if (node.layoutMode) {
        out.autoLayout = {
            mode: node.layoutMode,
            itemSpacing: node.itemSpacing,
            padding: [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0],
            primaryAxisAlign: node.primaryAxisAlignItems,
            counterAxisAlign: node.counterAxisAlignItems,
        };
    }
    if (node.children && depth < maxDepth) {
        out.children = node.children.map((c) => simplifyNode(c, depth + 1, maxDepth));
    }
    return out;
}
