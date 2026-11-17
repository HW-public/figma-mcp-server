import { generateCommandId, sendProgressUpdate } from "../utils/progressUtils.js";

/**
 * Gets reactions from nodes and their children.
 */
export async function getReactions(nodeIds: any) {
    try {
        const commandId = generateCommandId();
        await sendProgressUpdate(
            commandId,
            "get_reactions",
            "started",
            0,
            nodeIds.length,
            0,
            `Starting deep search for reactions in ${nodeIds.length} nodes and their children`,
        );

        async function findNodesWithReactions(
            node: any,
            processedNodes = new Set(),
            depth = 0,
            results = [],
        ) {
            if (processedNodes.has(node.id)) {
                return results;
            }

            processedNodes.add(node.id);

            let filteredReactions: any[] = [];
            if (node.reactions && node.reactions.length > 0) {
                // v2.3.4 owns the contract fix that will return CHANGE_TO
                // reactions instead of filtering them out here.
                filteredReactions = node.reactions.filter((reaction: any) => {
                    if (
                        reaction.action &&
                        reaction.action.navigation === "CHANGE_TO"
                    ) {
                        return false;
                    }
                    if (Array.isArray(reaction.actions)) {
                        return !reaction.actions.some(
                            (action: any) => action.navigation === "CHANGE_TO",
                        );
                    }
                    return true;
                });
            }

            if (filteredReactions.length > 0) {
                // @ts-expect-error TS2345: reaction-summary object literal is not assignable to the parameter's declared type
                results.push({
                    id: node.id,
                    name: node.name,
                    type: node.type,
                    depth,
                    hasReactions: true,
                    reactions: filteredReactions,
                    path: getNodePath(node),
                });
            }

            if (node.children) {
                for (const child of node.children) {
                    await findNodesWithReactions(
                        child,
                        processedNodes,
                        depth + 1,
                        results,
                    );
                }
            }

            return results;
        }

        function getNodePath(node: any) {
            const path: any[] = [];
            let current = node;

            while (current && current.parent) {
                path.unshift(current.name);
                current = current.parent;
            }

            return path.join(" > ");
        }

        let allResults: any[] = [];
        let processedCount = 0;
        const totalCount = nodeIds.length;

        for (let i = 0; i < nodeIds.length; i++) {
            try {
                const nodeId = nodeIds[i];
                const node = await figma.getNodeByIdAsync(nodeId);

                if (!node) {
                    processedCount++;
                    await sendProgressUpdate(
                        commandId,
                        "get_reactions",
                        "in_progress",
                        processedCount / totalCount,
                        totalCount,
                        processedCount,
                        `Node not found: ${nodeId}`,
                    );
                    continue;
                }

                const processedNodes = new Set();
                const nodeResults = await findNodesWithReactions(
                    node,
                    processedNodes,
                );
                allResults = allResults.concat(nodeResults);

                processedCount++;
                await sendProgressUpdate(
                    commandId,
                    "get_reactions",
                    "in_progress",
                    processedCount / totalCount,
                    totalCount,
                    processedCount,
                    `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`,
                );
            } catch (error: any) {
                processedCount++;
                await sendProgressUpdate(
                    commandId,
                    "get_reactions",
                    "in_progress",
                    processedCount / totalCount,
                    totalCount,
                    processedCount,
                    `Error processing node: ${error.message}`,
                );
            }
        }

        await sendProgressUpdate(
            commandId,
            "get_reactions",
            "completed",
            1,
            totalCount,
            totalCount,
            `Completed deep search: found ${allResults.length} nodes with reactions.`,
        );

        return {
            nodesCount: nodeIds.length,
            nodesWithReactions: allResults.length,
            nodes: allResults,
        };
    } catch (error: any) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to get reactions: ${detail}`);
    }
}

// figma-mcp-server 定制：向上找"屏"——parent 为 PAGE 或 SECTION 即顶层（Figma 导航目标规则）
async function findTopLevelFrame(node: BaseNode): Promise<BaseNode> {
    let curr: BaseNode = node;
    while (curr.parent && curr.parent.type !== "PAGE" && curr.parent.type !== "SECTION") {
        curr = curr.parent;
    }
    return curr;
}

function pageOf(node: BaseNode): PageNode | null {
    let curr: BaseNode | null = node;
    while (curr) {
        if (curr.type === "PAGE") return curr as PageNode;
        curr = curr.parent;
    }
    return null;
}

export async function updateReactions(params: any) {
    const { nodeId, reactions } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    if (!reactions || !Array.isArray(reactions)) {
        throw new Error("Missing or invalid reactions parameter");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`[源节点不存在] nodeId=${nodeId}：先用 node_info 核对，id 会随增删变化`);
    }

    if (!("reactions" in node)) {
        throw new Error(`[源节点类型不支持] ${node.name} (${node.type}) 不能挂交互，reactions 仅支持 FRAME/COMPONENT/INSTANCE 等节点`);
    }

    // figma-mcp-server 定制：NAVIGATE 目标预校验——Figma API 的错误把"目标不存在/非顶层/跨页"混成一句，
    // 提前逐条拆开报，调试不必猜
    const sourceTop = await findTopLevelFrame(node);
    for (const reaction of reactions) {
        const actions = reaction?.actions ?? (reaction?.action ? [reaction.action] : []);
        for (const action of actions) {
            if (action?.type !== "NODE" || !action.destinationId) continue;
            const dest = await figma.getNodeByIdAsync(action.destinationId);
            if (!dest) {
                throw new Error(`[目标不存在] destinationId=${action.destinationId}：该节点已被删除或 id 已变化，先 node_info 重查`);
            }
            const destTop = await findTopLevelFrame(dest);
            if (destTop.id === sourceTop.id) {
                throw new Error(`[目标是源节点自身] ${dest.name}：NAVIGATE 终点必须与起点屏不同`);
            }
            const destPage = pageOf(destTop);
            const sourcePage = pageOf(sourceTop);
            if (destPage && sourcePage && destPage.id !== sourcePage.id) {
                throw new Error(`[跨页跳转] 目标在「${destPage.name}」，源在「${sourcePage.name}」：NAVIGATE 只支持同页`);
            }
            if (destTop.id !== dest.id && destTop.type !== "SECTION") {
                throw new Error(`[目标不是顶层帧] ${dest.name} 的顶层容器是 ${destTop.name}(${destTop.type})。Figma 要求 NAVIGATE 终点为 PAGE 直接子帧；若顶层容器是 FRAME，请把它转为 SECTION（分区）或移出到页面顶层`);
            }
        }
    }

    try {
        await (node as any).setReactionsAsync(reactions);
        return { success: true, message: `Successfully updated reactions for node ${nodeId}` };
    } catch (e: any) {
        // figma-mcp-server 定制：Figma API 可能抛非 Error 值（undefined/字符串），必须安全序列化，否则错误链路断成 "undefined"
        const detail = e instanceof Error ? (e.stack ?? e.message) : (e === undefined ? 'undefined (Figma API 未给出原因)' : String(e));
        // figma-mcp-server 定制：Figma 内部超时的文案说"check your internet"有误导——实际是插件↔Figma 桌面端连接问题
        const clarified = /Unable to establish connection to Figma/i.test(detail)
            ? `${detail}（注：此错误是 Figma 桌面端内部连接中断，非外网问题——通常是插件 WS 断开或 Figma 进程假死，重开插件即可）`
            : detail;
        throw new Error(`Failed to update reactions: ${clarified}`);
    }
}
