import { resolveAppendableParent } from './nodeCreators.js';
import { rethrowAfterCreatorCleanup, getAbsoluteOffset } from '../utils/nodeUtils.js';
import { assertNonEmptyExplicitName } from '../utils/creatorValidation.js';

export async function createNodeFromSvg(params: any) {
    const { parentId, svg, name, x = 0, y = 0, coordinateSpace = "parent" } = params || {};

    if (!svg) {
        throw new Error("Missing required parameter: svg string.");
    }

    assertNonEmptyExplicitName(
        name,
        "name",
        "create_svg",
        "Omit name to use the default name.",
    );

    const parentNode = await resolveAppendableParent(parentId, "create_svg");

    // figma-mcp-server 定制：coordinateSpace=canvas 时把画布绝对坐标换算成父级相对坐标（默认 parent=旧行为，将切换 canvas 默认另行通知）
    let svgX = x;
    let svgY = y;
    if (coordinateSpace === "canvas") {
        const offset = await getAbsoluteOffset(parentNode);
        svgX = x - offset.x;
        svgY = y - offset.y;
    }

    const node = figma.createNodeFromSvg(svg);
    try {
        // D11: createNodeFromSvg uses an implicit parent; contain it first.
        parentNode.appendChild(node);

        if (name !== undefined) {
            node.name = name;
        }

        node.x = svgX;
        node.y = svgY;

        const result = {
            id: node.id,
            name: node.name,
            type: node.type,
            // D11: report where the node actually landed, so the caller can
            // confirm containment from the response instead of re-reading.
            parentId: node.parent ? node.parent.id : undefined,
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, node, "create_svg", parentId);
    }
}
