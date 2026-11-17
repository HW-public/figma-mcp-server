import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommandToFigma } from "../bridge/client.js";
import { toolResult, looseOutput } from "./_result.js";

// Figma Plugin API typings for Reaction (as of current known API version)
const VariableDataSchema: z.ZodType<any> = z.lazy(() => z.object({
    type: z.string().optional(),
    resolvedType: z.string().optional(),
    value: z.any().optional(), // Could be string, number, boolean, VariableAlias, or Expression
}));

const ActionSchema: z.ZodType<any> = z.lazy(() => z.union([
    z.object({ type: z.enum(["BACK", "CLOSE"]) }),
    z.object({ type: z.literal("URL"), url: z.string(), openInNewTab: z.boolean().optional() }),
    z.object({ type: z.literal("UPDATE_MEDIA_RUNTIME"), destinationId: z.string().nullable().optional(), mediaAction: z.enum(["PLAY", "PAUSE", "TOGGLE_PLAY_PAUSE", "MUTE", "UNMUTE", "TOGGLE_MUTE_UNMUTE", "SKIP_FORWARD", "SKIP_BACKWARD", "SKIP_TO"]).describe('媒体动作枚举（注意是 SKIP_TO 不是 SEEK_TO）。SKIP_FORWARD/SKIP_BACKWARD 必填 amountToSkip；SKIP_TO 必填 newTimestamp。'), amountToSkip: z.number().optional(), newTimestamp: z.number().optional() }),
    z.object({ type: z.literal("SET_VARIABLE"), variableId: z.string().nullable(), variableValue: VariableDataSchema.optional() }),
    z.object({ type: z.literal("SET_VARIABLE_MODE"), variableCollectionId: z.string().nullable(), variableModeId: z.string().nullable() }),
    z.object({ type: z.literal("CONDITIONAL"), conditionalBlocks: z.array(z.object({ condition: VariableDataSchema.optional(), actions: z.array(ActionSchema) })) }),
    // figma-mcp-server 定制：transition 文档与媒体/导航 action 防坑描述
    z.object({
        type: z.literal("NODE"), destinationId: z.string().nullable(),
        navigation: z.string().describe('Navigation enum: NAVIGATE | SWAP | OVERLAY | SCROLL_TO | CHANGE_TO (CHANGE_TO 已废弃，勿用).'),
        transition: z.any().nullable().optional().describe(
            '过渡对象；easing/duration 必须放在 transition 对象内（放在 action 顶层会被静默忽略，zod strip）；传 null 表示无动画。'
            + ' 两类：SimpleTransition（type: DISSOLVE | SMART_ANIMATE | SCROLL_ANIMATE，不要 matchLayers）'
            + ' 与 DirectionalTransition（type: MOVE_IN | MOVE_OUT | PUSH | SLIDE_IN | SLIDE_OUT，必须同时给 direction: LEFT|RIGHT|TOP|BOTTOM 和 matchLayers: boolean）。'
            + ' duration 必填（毫秒 ms）。'
            + ' easing: { type, ... }，type 枚举 EASE_IN|EASE_OUT|EASE_IN_AND_OUT|LINEAR|EASE_IN_BACK|EASE_OUT_BACK|EASE_IN_AND_OUT_BACK|CUSTOM_CUBIC_BEZIER|GENTLE|QUICK|BOUNCY|SLOW|CUSTOM_SPRING。'
            + ' easing.type 为 CUSTOM_CUBIC_BEZIER 时必须带 easingFunctionCubicBezier: {x1,y1,x2,y2}；'
            + ' 为 CUSTOM_SPRING 时必须带 easingFunctionSpring: {mass,stiffness,damping,initialVelocity}。'
        ),
        preserveScrollPosition: z.boolean().optional(), overlayRelativePosition: z.any().optional(), resetVideoPosition: z.boolean().optional(), resetScrollPosition: z.boolean().optional(), resetInteractiveComponents: z.boolean().optional(),
    }),
]));

const TriggerSchema = z.object({
    // figma-mcp-server 定制：注明 Figma 按 trigger.type 校验字段，非法值执行期才报错
    type: z.string().describe("Trigger type (e.g. ON_CLICK, ON_HOVER)"),
    timeout: z.number().optional().describe("Timeout，仅 AFTER_TIMEOUT 类型有效"),
    delay: z.number().optional().describe("Delay before trigger fires，仅 MOUSE_* 类型有效"),
    deprecatedVersion: z.boolean().optional().describe("Whether the trigger is deprecated"),
    device: z.string().optional().describe("Device setting，闭枚举（KEYBOARD_AND_POINTER/KEYBOARD/POINTER）"),
    keyCodes: z.array(z.number()).optional().describe("Key codes for key trigger"),
    mediaHitTime: z.number().optional().describe("Media hit time"),
}).describe("Figma 按 trigger.type 校验字段：delay 仅 MOUSE_* 有效、timeout 仅 AFTER_TIMEOUT 有效、device 是闭枚举；传了与类型不匹配的字段在执行期才报错。");

const ReactionSchema = z.object({
    action: ActionSchema.optional().describe("Primary action of the reaction"),
    actions: z.array(ActionSchema).optional().describe("List of actions for multi-action triggers"),
    trigger: TriggerSchema.nullable().describe("Trigger settings"),
});

export function registerReactionTools(server: McpServer) {
    server.registerTool(
        "reaction_list",
        {
            title: "List Reactions",
            description: "Read prototype reactions from one or more nodes and their descendants. Note: CHANGE_TO reactions are omitted from results.",
            inputSchema: z.object({
                nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
            }),
            outputSchema: looseOutput({
                nodesCount: z.number().optional().describe("Number of inspected nodes"),
                nodesWithReactions: z.number().optional().describe("Number of nodes found that have reactions"),
                nodes: z.array(z.any()).optional().describe("List of node entries with their reactions"),
            }),
            annotations: {
                readOnlyHint: true,
                openWorldHint: true
            }
        },
        async ({ nodeIds }: any) => {
            const result = await sendCommandToFigma("reaction_list", { nodeIds });
            return toolResult(result);
        }
    );

    server.registerTool(
        "reaction_update",
        {
            title: "Update Reactions",
            description: "Replace a node's prototype reactions with a full new reactions array (read first via `reaction_list`). Warning: reaction_list does NOT return CHANGE_TO reactions, so read-modify-write will silently lose them — account for this before updating.",
            inputSchema: z.object({
                // figma-mcp-server 定制
                strictNames: z.boolean().optional().describe("false 时跳过 nodeName 一致性校验（节点被改名后脚本仍可用，靠 nodeId 定位）"),
                nodeId: z.string().describe("The ID of the node to update reactions for"),
                nodeName: z.string().describe("The node's current exact name, passed back verbatim from `node_info`."),
                reactions: z.array(ReactionSchema).describe("The full array of Reaction objects to set"),
            }),
            outputSchema: looseOutput({
                success: z.boolean().optional().describe("Whether the reactions were updated successfully"),
            }),
            annotations: {
                idempotentHint: true,
                openWorldHint: true
            }
        },
        async (params: any) => {
            const result = await sendCommandToFigma("reaction_update", params);
            return toolResult(result);
        }
    );
}
