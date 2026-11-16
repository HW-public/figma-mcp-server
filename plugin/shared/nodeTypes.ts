/**
 * 共享类型定义 —— 原 figma-edit-mcp 仓库 src/shared/nodeTypes.ts 的最小重建。
 * npm 包未随包发布此文件（仅源码引用），此处按引用点形状复原。
 * 纯类型模块，运行时无产物；esbuild 会擦除类型导入。
 */

/** 祖先链路径元组: [nodeType, nodeId, nodeName] */
export type PathTuple = [string, string, string];

/** node_info 工具返回的树形节点条目 */
export interface NodeEntry {
    id: string;
    name: string;
    type: string;
    children?: NodeEntry[];
    /** 祖先链（buildPathArray 结果） */
    path?: PathTuple[];
    properties?: Record<string, any>;
    /** 截断边界节点携带的后代计数（区分真叶子与被截断的节点） */
    descendantCount?: number;
}
