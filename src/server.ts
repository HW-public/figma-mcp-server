import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LiveChannel } from './live/child-client.js';
import { restToolDefs, makeRestHandlers } from './rest/tools.js';
import type { Config } from './config.js';

/** 组装 MCP server：REST 工具 + live 工具合并暴露，调用时按名字路由 */
export function createServer(config: Config, live: LiveChannel): Server {
    const server = new Server(
        { name: 'figma-mcp-server', version: '1.0.7' },
        { capabilities: { tools: {} } },
    );
    const restHandlers = makeRestHandlers(config);

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const liveTools = live.isBridgeConnected
            ? [
                ...live.listToolDefs().map((t) => ({
                    name: t.name,
                    description: t.description ?? '',
                    inputSchema: t.inputSchema ?? { type: 'object' as const },
                })),
                {
                    name: 'batch_execute',
                    description: '批量执行多个 live 操作：一次调用传入 ops 数组（≤200 项），broker 内串行执行并逐项返回结果。'
                        + '写大量节点时优先用它替代循环单调（减少往返与掉线窗口）。默认遇错继续，abortOnError=true 时首个失败即停。',
                    inputSchema: {
                        type: 'object' as const,
                        properties: {
                            ops: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string', description: 'live 工具名，如 create_frame / node_set_fill' },
                                        args: { type: 'object' },
                                    },
                                    required: ['name'],
                                },
                                maxItems: 200,
                            },
                            abortOnError: { type: 'boolean', default: false },
                        },
                        required: ['ops'],
                    },
                },
            ]
            : [];
        return { tools: [...restToolDefs, ...liveTools] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const input = (args ?? {}) as Record<string, unknown>;

        // REST 通道工具
        if (name === 'get_design_context' || name === 'download_images') {
            const result = await restHandlers[name](input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // 批量执行：一次调用跑 N 个 live 操作（写大量节点时优先用它，减少往返与掉线窗口）
        if (name === 'batch_execute') {
            if (!live.isBridgeConnected) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: 'LIVE_NOT_CONNECTED: broker 未连接' }],
                };
            }
            const ops = (input.ops ?? []) as Array<{ name: string; args?: Record<string, unknown> }>;
            if (!Array.isArray(ops) || ops.length === 0) {
                return { isError: true, content: [{ type: 'text' as const, text: 'ops 必须是非空数组' }] };
            }
            const result = await live.callBatch(ops, Boolean(input.abortOnError));
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Live 通道工具（figma-edit-mcp 代理）
        if (live.hasTool(name)) {
            const result = await live.callTool(name, input);
            // figma-edit-mcp 返回的 content 结构直接透传
            return result as { content: unknown[]; isError?: boolean };
        }

        return {
            isError: true,
            content: [{
                type: 'text' as const,
                text: `未知工具: ${name}。REST 通道未配置 FIGMA_API_KEY 或 live 通道未连接时部分工具不可用。`,
            }],
        };
    });

    return server;
}

export async function startStdioServer(server: Server): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[figma-mcp-server] stdio 已就绪');
}
