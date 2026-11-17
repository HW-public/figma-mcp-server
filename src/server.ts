import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const APP_VERSION = (globalThis as Record<string, unknown>).__APP_VERSION__ as string ?? '0.0.0-dev';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LiveChannel } from './client/live.js';
import { restToolDefs, makeRestHandlers } from './client/rest-tools.js';
import type { Config } from './config.js';

/** 组装 MCP server：REST 工具 + live 工具合并暴露，调用时按名字路由 */
export function createServer(config: Config, live: LiveChannel): Server {
    const server = new Server(
        { name: 'figma-mcp-server', version: APP_VERSION },
        { capabilities: { tools: {} } },
    );
    const restHandlers = makeRestHandlers(config);

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (live.isBridgeConnected) await live.ensureTools(); // broker 桥刚拉起时补一次同步，避免空表竞态
        const liveTools = live.isBridgeConnected
            ? [
                ...live.listToolDefs().map((t) => ({
                    name: t.name,
                    description: t.description ?? '',
                    inputSchema: t.inputSchema ?? { type: 'object' as const },
                })),
                {
                    name: 'batch_execute',
                    description: '批量执行多个 live 工具，一次调用完成（≤200 项，broker 内串行执行）。'
                        // figma-mcp-server 定制: clientRef 命名引用示例——先命名 op，后续用 "@名字.字段" 引用
                        + ' 【示例】{"ops":[{"name":"create_frame","clientRef":"hero","args":{"name":"卡片","width":300,"height":120,"cornerRadius":12}},'
                        + '{"name":"create_text","args":{"parentId":"@hero.id","name":"标题","characters":"标题"}},'
                        + '{"name":"node_set_fill","args":{"nodeId":"@hero.id","r":1,"g":0.38,"b":0.3}}],'
                        + '"verbose":true}'
                        + ' args 中的字符串 "@opN.字段路径" 或 "@clientRef名.字段路径" 会被替换为同批 op 的返回字段'
                        + '（opN=第 N 个 op 的序号；clientRef 名先匹配同名 op 的 clientRef 字段，匹配不到再回退数字索引；create_* 返回 {id,name}，故 "@hero.id" 引用名为 hero 的 op 创建的节点）。'
                        // figma-mcp-server 定制：batch 引用/超时防坑说明
                        + ' 引用失败 op 的字段会导致本 op 报错（batch 引用未解析，错误会列出可用 clientRef 与索引）。单批 150s 超时。'
                        // figma-mcp-server 定制：默认瘦身摘要，verbose 显式 true 才回全量
                        + ' 默认只回每个成功 op 的 {index,name,clientRef,id,durationMs} 摘要 + failures；详细结果显式 verbose:true（回全量 results）。abortOnError:true 时首个失败即停。'
                        + ' node_set_fill 图片用 {"image":{"filePath":"C:\\\\绝对\\\\路径.png"}}（broker 读本地文件，勿用 localhost/file://）。',
                    inputSchema: {
                        type: 'object' as const,
                        properties: {
                            ops: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string', description: 'live 工具名，如 create_frame / node_set_fill' },
                                        // figma-mcp-server 定制: 命名引用——后续 op 可用 "@名字.字段" 引用本 op 的结果
                                        clientRef: { type: 'string', description: '可选命名引用，如 "hero"；后续 op 用 "@hero.id" 引用本 op 的返回字段' },
                                        args: { type: 'object' },
                                    },
                                    required: ['name'],
                                },
                                maxItems: 200,
                            },
                            abortOnError: { type: 'boolean', default: false },
                            verbose: { type: 'boolean', default: false, description: 'true 回全量结果；默认 false 只回 {index,name,clientRef,id,durationMs} 摘要 + failures' },
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
            // broker 被杀后有 ~3-8s 自愈窗口（重连+按需拉起），先等而不是立刻失败打断 AI
            if (!live.isBridgeConnected && !await live.waitConnected(10_000)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: 'LIVE_NOT_CONNECTED: broker 未连接（10s 内未恢复；任意会话再调一次会自动拉起）' }],
                };
            }
            const ops = (input.ops ?? []) as Array<{ name: string; args?: Record<string, unknown> }>;
            if (!Array.isArray(ops) || ops.length === 0) {
                return { isError: true, content: [{ type: 'text' as const, text: 'ops 必须是非空数组' }] };
            }
            const result = await live.callBatch(ops, Boolean(input.abortOnError), input.verbose === true);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Live 通道工具（figma-edit-mcp 代理）
        if (live.hasTool(name)) {
            if (!live.isBridgeConnected && !await live.waitConnected(10_000)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: 'LIVE_NOT_CONNECTED: broker 未连接（10s 内未恢复；任意会话再调一次会自动拉起）' }],
                };
            }
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
