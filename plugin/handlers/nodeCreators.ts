/**
 * Node creator handlers for Figma plugin
 * Handles creation of new nodes (rectangles, frames, text, clones)
 */

import { setCharacters } from '../utils/textUtils.js';
import { rethrowAfterCreatorCleanup } from '../utils/nodeUtils.js';
import { assertNonEmptyExplicitName } from '../utils/creatorValidation.js';

export async function resolveAppendableParent(parentId: string, command: string): Promise<any> {
    if (!parentId) throw new Error(`${command}: missing parentId parameter.`);
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error(`${command}: parent node not found with ID: ${parentId}.`);
    if (!("appendChild" in parent)) {
        throw new Error(`${command}: parent '${parent.name}' (type ${parent.type}) cannot contain children.`);
    }
    return parent;
}

/**
 * Creates a new shape node (rectangle, ellipse, polygon, or star)
 * @param {Object} params - Parameters object
 * @param {string} params.type - RECTANGLE, ELLIPSE, POLYGON, or STAR
 * @param {number} params.x - X position
 * @param {number} params.y - Y position
 * @param {number} params.width - Width of shape
 * @param {number} params.height - Height of shape
 * @param {string} params.name - Optional name for the shape
 * @param {string} params.parentId - Optional parent node ID
 * @param {boolean} params.useAbsolutePosition - Optional flag to force absolute position
 * @param {Object} params.fillColor - Optional fill color in RGBA
 * @param {Object} params.strokeColor - Optional stroke color in RGBA
 * @param {Object} params.arcData - Optional arc properties (ELLIPSE only)
 * @param {number} params.pointCount - Vertex count (POLYGON/STAR only)
 * @param {number} params.innerRadius - Star sharpness (STAR only)
 * @returns {Promise<Object>} Created shape info
 */
export async function createShape(params: any) {
    const {
        type,
        x = 0,
        y = 0,
        width = 100,
        height = 100,
        name,
        parentId,
        useAbsolutePosition = false,
        fillColor,
        strokeColor,
        arcData,
        pointCount,
        innerRadius,
        cornerRadius,
    } = params || {};

    if (!type) {
        throw new Error("Missing shape type parameter");
    }

    // 本地扩展：创建时直接指定圆角（仅矩形类形状支持）
    if (cornerRadius !== undefined) {
        if (typeof cornerRadius !== "number" || cornerRadius < 0) {
            throw new Error(`create_shape: cornerRadius must be a non-negative number, got ${cornerRadius}`);
        }
        if (type.toUpperCase() !== "RECTANGLE") {
            throw new Error(`create_shape: cornerRadius is only supported for RECTANGLE, got ${type}`);
        }
    }

    assertNonEmptyExplicitName(
        name,
        "name",
        "create_shape",
        "Omit name to use the default name.",
    );

    const upperType = type.toUpperCase();
    if (arcData !== undefined && upperType !== "ELLIPSE") {
        throw new Error(`arcData is only supported for shape type ELLIPSE, got ${type}`);
    }
    if ((upperType === "POLYGON" || upperType === "STAR") && pointCount === undefined) {
        throw new Error(`pointCount is required for shape type ${type}`);
    }
    if (innerRadius !== undefined && upperType !== "STAR") {
        throw new Error(`innerRadius is only supported for shape type STAR, got ${type}`);
    }

    const parent = await resolveAppendableParent(parentId, "create_shape");

    if ((upperType === "POLYGON" || upperType === "STAR") && pointCount! < 3) {
        throw new Error(`${upperType === "POLYGON" ? "Polygons" : "Stars"} require pointCount >= 3`);
    }

    let createNode: () => RectangleNode | EllipseNode | PolygonNode | StarNode;
    switch (upperType) {
        case "RECTANGLE":
            createNode = () => figma.createRectangle();
            break;
        case "ELLIPSE":
            createNode = () => figma.createEllipse();
            break;
        case "POLYGON":
            createNode = () => figma.createPolygon();
            break;
        case "STAR":
            createNode = () => figma.createStar();
            break;
        default:
            throw new Error(`Unsupported shape type: ${type}`);
    }

    const node = createNode();
    try {
        // D11: implicit creators place on currentPage. Reparent synchronously
        // before any property write, await, progress event, or response.
        parent.appendChild(node);

        if (upperType === "ELLIPSE" && arcData) {
            (node as EllipseNode).arcData = {
                startingAngle: arcData.startingAngle ?? 0,
                endingAngle: arcData.endingAngle ?? Math.PI * 2,
                innerRadius: arcData.innerRadius ?? 0
            };
        }
        if ((upperType === "POLYGON" || upperType === "STAR") && pointCount !== undefined) {
            (node as PolygonNode | StarNode).pointCount = pointCount;
        }
        if (upperType === "STAR" && innerRadius !== undefined) {
            (node as StarNode).innerRadius = innerRadius;
        }

        node.x = x;
        node.y = y;
        node.resize(width, height);
        if (name !== undefined) {
            node.name = name;
        } else {
            node.name = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
        }

        // 本地扩展：创建时直接指定圆角
        if (cornerRadius !== undefined && upperType === "RECTANGLE") {
            (node as RectangleNode).cornerRadius = cornerRadius;
        }

        if (fillColor) {
            node.fills = [{
                type: 'SOLID',
                color: {
                    r: parseFloat(fillColor.r) || 0,
                    g: parseFloat(fillColor.g) || 0,
                    b: parseFloat(fillColor.b) || 0,
                },
                opacity: typeof fillColor.a === 'number' ? fillColor.a : 1
            }];
        }

        if (strokeColor) {
            node.strokes = [{
                type: 'SOLID',
                color: {
                    r: parseFloat(strokeColor.r) || 0,
                    g: parseFloat(strokeColor.g) || 0,
                    b: parseFloat(strokeColor.b) || 0,
                },
                opacity: typeof strokeColor.a === 'number' ? strokeColor.a : 1
            }];
        }

        // Handle absolute positioning if requested and parent is auto-layout
        if (useAbsolutePosition && parentId) {
            if (parent && (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL")) {
                node.layoutPositioning = "ABSOLUTE";
                node.x = x;
                node.y = y;
            }
        }

        const result = {
            id: node.id,
            name: node.name,
            type: node.type,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            parentId: node.parent ? node.parent.id : undefined
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, node, "create_shape", parentId);
    }
}

/**
 * Creates a new frame node
 * @param {Object} params - Parameters object
 * @param {number} params.x - X position
 * @param {number} params.y - Y position
 * @param {number} params.width - Width of frame
 * @param {number} params.height - Height of frame
 * @param {string} params.name - Name of frame
 * @param {string} params.parentId - Optional parent node ID
 * @param {Object} params.fillColor - Optional fill color
 * @param {Object} params.strokeColor - Optional stroke color
 * @param {number} params.strokeWeight - Optional stroke weight
 * @param {string} params.layoutMode - Layout mode (NONE, HORIZONTAL, VERTICAL)
 * @param {string} params.layoutWrap - Layout wrap (NO_WRAP, WRAP)
 * @returns {Promise<Object>} Created frame info
 */
export async function createFrame(params: any) {
    const {
        x = 0,
        y = 0,
        width = 100,
        height = 100,
        name = "Frame",
        parentId,
        fillColor,
        strokeColor,
        strokeWeight,
        layoutMode = "NONE",
        layoutWrap = "NO_WRAP",
        paddingTop = 10,
        paddingRight = 10,
        paddingBottom = 10,
        paddingLeft = 10,
        primaryAxisAlignItems = "MIN",
        counterAxisAlignItems = "MIN",
        layoutSizingHorizontal = "FIXED",
        layoutSizingVertical = "FIXED",
        itemSpacing = 0,
        cornerRadius,
    } = params || {};

    assertNonEmptyExplicitName(
        name,
        "name",
        "create_frame",
        "Omit name to use the default name.",
    );

    const parentNode = await resolveAppendableParent(parentId, "create_frame");

    const frame = figma.createFrame();
    try {
        // D11: contain the new frame before any fallible configuration.
        parentNode.appendChild(frame);

        frame.x = x;
        frame.y = y;
        frame.resize(width, height);
        frame.name = name;

        // 本地扩展：创建时直接指定圆角（省一次 node_set_corner_radius 往返）
        if (cornerRadius !== undefined) {
            if (typeof cornerRadius !== "number" || cornerRadius < 0) {
                throw new Error(`create_frame: cornerRadius must be a non-negative number, got ${cornerRadius}`);
            }
            frame.cornerRadius = cornerRadius;
        }

        // Set layout mode if provided
        if (layoutMode !== "NONE") {
            frame.layoutMode = layoutMode;
            frame.layoutWrap = layoutWrap;

            // Set padding values only when layoutMode is not NONE
            frame.paddingTop = paddingTop;
            frame.paddingRight = paddingRight;
            frame.paddingBottom = paddingBottom;
            frame.paddingLeft = paddingLeft;

            // Set axis alignment only when layoutMode is not NONE
            frame.primaryAxisAlignItems = primaryAxisAlignItems;
            frame.counterAxisAlignItems = counterAxisAlignItems;

            // Set layout sizing only when layoutMode is not NONE
            frame.layoutSizingHorizontal = layoutSizingHorizontal;
            frame.layoutSizingVertical = layoutSizingVertical;

            // Set item spacing only when layoutMode is not NONE
            frame.itemSpacing = itemSpacing;
        }

        // Set fill color if provided
        if (fillColor) {
            const paintStyle: any = {
                type: "SOLID",
                color: {
                    r: parseFloat(fillColor.r) || 0,
                    g: parseFloat(fillColor.g) || 0,
                    b: parseFloat(fillColor.b) || 0,
                },
                opacity: typeof fillColor.a === 'number' ? fillColor.a : 1,
            };
            frame.fills = [paintStyle];
        }

        // Set stroke color and weight if provided
        if (strokeColor) {
            const strokeStyle: any = {
                type: "SOLID",
                color: {
                    r: parseFloat(strokeColor.r) || 0,
                    g: parseFloat(strokeColor.g) || 0,
                    b: parseFloat(strokeColor.b) || 0,
                },
                opacity: typeof strokeColor.a === 'number' ? strokeColor.a : 1,
            };
            frame.strokes = [strokeStyle];
        }

        // Set stroke weight if provided
        if (strokeWeight !== undefined) {
            frame.strokeWeight = strokeWeight;
        }

        const result = {
            id: frame.id,
            name: frame.name,
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            fills: frame.fills,
            strokes: frame.strokes,
            strokeWeight: frame.strokeWeight,
            layoutMode: frame.layoutMode,
            layoutWrap: frame.layoutWrap,
            parentId: frame.parent ? frame.parent.id : undefined,
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, frame, "create_frame", parentId);
    }
}

// figma-mcp-server 定制：创建 SECTION（分区）——Figma 中合法的导航容器，
// 子帧可直接作为 NAVIGATE 目标（同页顶层规则对 SECTION 子帧放行）
export async function createSection(params: any) {
    const {
        x = 0,
        y = 0,
        width = 1000,
        height = 1000,
        name = "Section",
        parentId,
    } = params || {};

    assertNonEmptyExplicitName(
        name,
        "name",
        "create_section",
        "Omit name to use the default name.",
    );

    const parentNode = await resolveAppendableParent(parentId, "create_section");

    const section = figma.createSection();
    try {
        parentNode.appendChild(section);
        section.x = x;
        section.y = y;
        section.resizeWithoutConstraints(width, height);
        section.name = name;

        const result = {
            id: section.id,
            name: section.name,
            width: section.width,
            height: section.height,
            parentId: section.parent ? section.parent.id : undefined,
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, section, "create_section", parentId);
    }
}

/**
 * Maps font weight number to Figma font style name
 * @param {number} weight - Font weight (100-900)
 * @returns {string} Figma font style name
 */
function getFontStyle(weight: any) {
    switch (weight) {
        case 100:
            return "Thin";
        case 200:
            return "Extra Light";
        case 300:
            return "Light";
        case 400:
            return "Regular";
        case 500:
            return "Medium";
        case 600:
            return "Semi Bold";
        case 700:
            return "Bold";
        case 800:
            return "Extra Bold";
        case 900:
            return "Black";
        default:
            throw new Error(`Unsupported fontWeight ${weight}; expected one of 100, 200, 300, 400, 500, 600, 700, 800, or 900.`);
    }
}

/**
 * Creates a new text node
 * @param {Object} params - Parameters object
 * @param {number} params.x - X position
 * @param {number} params.y - Y position
 * @param {string} params.text - Text content
 * @param {number} params.fontSize - Font size
 * @param {number} params.fontWeight - Font weight (100-900)
 * @param {Object} params.fontColor - Font color
 * @param {string} params.name - Node name
 * @param {string} params.parentId - Optional parent node ID
 * @returns {Promise<Object>} Created text node info
 */
export async function createText(params: any) {
    const {
        x = 0,
        y = 0,
        text = "Text",
        fontSize = 14,
        fontWeight = 400,
        fontColor = { r: 0, g: 0, b: 0, a: 1 }, // Default to black
        name,
        parentId,
        width,
        textAlign,
        textAlignHorizontal,
        lineHeight,
        letterSpacing,
    } = params || {};

    assertNonEmptyExplicitName(
        name,
        "name",
        "create_text",
        "Omit name to use the default name.",
    );

    // Defense in depth for clients that bypass the MCP schema. Never silently
    // map an unsupported weight to Regular and then echo the unapplied input.
    const fontStyle = getFontStyle(fontWeight);
    const parentNode = await resolveAppendableParent(parentId, "create_text");

    const textNode = figma.createText();
    try {
        // D11: insertion must precede font-loading awaits and character writes.
        parentNode.appendChild(textNode);

        textNode.x = x;
        textNode.y = y;
        textNode.name = name !== undefined ? name : text;
        // Font loading and both configuration writes are part of creation.
        // Failure must reach the outer creator cleanup/disclosure path rather
        // than returning success with a default or partially applied style.
        await figma.loadFontAsync({
            family: "Inter",
            style: fontStyle,
        });
        textNode.fontName = { family: "Inter", style: fontStyle };
        textNode.fontSize = fontSize;
        // 本地扩展：lineHeight / letterSpacing（数字=像素，或 {value, unit: PIXELS|PERCENT|AUTO}）
        if (lineHeight !== undefined) {
            if (typeof lineHeight === 'number') {
                textNode.lineHeight = { unit: 'PIXELS', value: lineHeight };
            } else if (lineHeight && typeof lineHeight === 'object') {
                const unitMap: Record<string, any> = { PIXELS: 'PIXELS', PERCENT: 'PERCENT', AUTO: 'AUTO' };
                const unit = unitMap[String(lineHeight.unit || 'PIXELS').toUpperCase()];
                if (!unit) throw new Error(`create_text: lineHeight.unit must be PIXELS/PERCENT/AUTO`);
                textNode.lineHeight = unit === 'AUTO' ? { unit: 'AUTO' } : { unit, value: Number(lineHeight.value) || 0 };
            }
        }
        if (letterSpacing !== undefined) {
            const spValue = typeof letterSpacing === 'number'
                ? { unit: 'PIXELS' as const, value: letterSpacing }
                : { unit: (String(letterSpacing.unit || 'PIXELS').toUpperCase() === 'PERCENT' ? 'PERCENT' as const : 'PIXELS' as const), value: Number(letterSpacing.value) || 0 };
            textNode.letterSpacing = spValue;
        }
        // 本地扩展：width 固定宽度自动换行；textAlign 水平对齐
        if (width !== undefined) {
            if (typeof width !== "number" || width <= 0) {
                throw new Error(`create_text: width must be a positive number, got ${width}`);
            }
            textNode.textAutoResize = "HEIGHT";
            textNode.resize(width, textNode.height);
        }
        const alignInput = textAlignHorizontal ?? textAlign;
        if (alignInput !== undefined) {
            const alignMap: Record<string, TextNode["textAlignHorizontal"]> = { LEFT: "LEFT", CENTER: "CENTER", RIGHT: "RIGHT", JUSTIFIED: "JUSTIFIED" };
            const align = alignMap[String(alignInput).toUpperCase()];
            if (!align) throw new Error(`create_text: textAlignHorizontal must be LEFT/CENTER/RIGHT/JUSTIFIED, got ${alignInput}`);
            textNode.textAlignHorizontal = align;
        }
        // setCharacters is async (loads fonts + writes characters); must be awaited
        // or the node has no text when we read/return it (characters:"", width:0).
        await setCharacters(textNode, text);

        // Set text color
        const paintStyle: any = {
            type: "SOLID",
            color: {
                r: parseFloat(fontColor.r) || 0,
                g: parseFloat(fontColor.g) || 0,
                b: parseFloat(fontColor.b) || 0,
            },
            opacity: typeof fontColor.a === 'number' ? fontColor.a : 1,
        };
        textNode.fills = [paintStyle];

        const result = {
            id: textNode.id,
            name: textNode.name,
            x: textNode.x,
            y: textNode.y,
            width: textNode.width,
            height: textNode.height,
            characters: textNode.characters,
            fontSize: textNode.fontSize,
            fontWeight: fontWeight,
            fontColor: fontColor,
            fontName: textNode.fontName,
            fills: textNode.fills,
            parentId: textNode.parent ? textNode.parent.id : undefined,
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, textNode, "create_text", parentId);
    }
}

/**
 * Clones an existing node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of node to clone
 * @param {number} params.x - Optional X position for clone
 * @param {number} params.y - Optional Y position for clone
 * @returns {Promise<Object>} Cloned node info
 */
export async function cloneNode(params: any) {
    const { nodeId, x, y } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`Node not found with ID: ${nodeId}`);
    }

    const parent = node.parent;
    if (!parent) {
        throw new Error(`node_clone: '${node.name}' has no parent and cannot be cloned.`);
    }
    // The typings prove every non-null parent is appendable; retain the
    // runtime guard for non-conforming hosts and test doubles.
    if (!("appendChild" in (parent as BaseNode))) {
        throw new Error(`node_clone: parent '${parent.name}' (type ${parent.type}) cannot accept cloned children.`);
    }
    const verifiedParentId = parent.id;

    // Clone the node
    // @ts-expect-error TS2339: Property 'clone' does not exist on type 'BaseNode'.
    const clone = node.clone();
    try {
        // D11: clone() uses an implicit parent, so move it immediately.
        parent.appendChild(clone);

        // If x and y are provided, move the clone to that position
        if (x !== undefined && y !== undefined) {
            clone.x = x;
            clone.y = y;
        }

        const result = {
            id: clone.id,
            name: clone.name,
            x: "x" in clone ? clone.x : undefined,
            y: "y" in clone ? clone.y : undefined,
            width: "width" in clone ? clone.width : undefined,
            height: "height" in clone ? clone.height : undefined,
            // D11: report where the node actually landed, so the caller can
            // confirm containment from the response instead of re-reading.
            parentId: clone.parent ? clone.parent.id : undefined,
        };
        return result;
    } catch (error: any) {
        rethrowAfterCreatorCleanup(error, clone, "node_clone", verifiedParentId);
    }
}
