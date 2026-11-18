/**
 * Styling handlers for Figma plugin
 * Handles fill, stroke, and corner radius operations
 */
import { base64ToBytes } from "../utils/exportUtils";

/**
 * Sets the fill color of a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to modify
 * @param {Object} params.color - Color object with r, g, b, a values (0-1)
 * @returns {Promise<Object>} Result with node info and applied fills
 */
export async function setFillColor(params: any) {
    console.log("setFillColor", params);
    const { nodeId, color, image, gradient, clear } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`Node not found with ID: ${nodeId}`);
    }

    if (clear) {
        if (!("fills" in node)) {
            throw new Error(`node_set_fill: '${node.name}' (type ${node.type}) has no 'fills' property to clear.`);
        }
        node.fills = [];
        return {
            id: node.id,
            name: node.name,
            fills: [],
        };
    }

    if (!("fills" in node)) {
        throw new Error(`node_set_fill: '${node.name}' (type ${node.type}) has no 'fills' property to set a fill on.`);
    }

    // figma-mcp-server 定制：gradient 计入模式计数，否则 gradient-only 会在此被误拦（gradient 分支变死代码）
    const fillModes = [color, image, gradient].filter(Boolean).length;
    if (fillModes > 1) {
        throw new Error("node_set_fill: provide exactly one of: a solid color (r,g,b[,a]), an image, a gradient, or clear:true.");
    }
    if (fillModes === 0) {
        throw new Error("node_set_fill: provide exactly one of: a solid color (r,g,b[,a]), an image, a gradient, or clear:true.");
    }

    let paintStyle: any;

    if (color) {
        const { r, g, b, a } = color;
        // Create RGBA color
        const rgbColor: any = {
            r: parseFloat(r) || 0,
            g: parseFloat(g) || 0,
            b: parseFloat(b) || 0,
            a: a !== undefined ? parseFloat(a) : 1,
        };

        // Set fill
        paintStyle = {
            type: "SOLID",
            color: {
                r: parseFloat(rgbColor.r),
                g: parseFloat(rgbColor.g),
                b: parseFloat(rgbColor.b),
            },
            opacity: parseFloat(rgbColor.a),
        };
    } else if (gradient) {
        // 本地扩展：渐变填充 {type, stops:[{position,color:{r,g,b,a}}], gradientTransform?}
        const gTypeMap: Record<string, string> = {
            LINEAR: 'GRADIENT_LINEAR', GRADIENT_LINEAR: 'GRADIENT_LINEAR',
            RADIAL: 'GRADIENT_RADIAL', GRADIENT_RADIAL: 'GRADIENT_RADIAL',
            ANGULAR: 'GRADIENT_ANGULAR', GRADIENT_ANGULAR: 'GRADIENT_ANGULAR',
            DIAMOND: 'GRADIENT_DIAMOND', GRADIENT_DIAMOND: 'GRADIENT_DIAMOND',
        };
        const gType = gTypeMap[String(gradient.type || 'LINEAR').toUpperCase()];
        if (!gType) throw new Error(`node_set_fill: unsupported gradient type '${gradient.type}' (use LINEAR/RADIAL/ANGULAR/DIAMOND)`);
        // figma-mcp-server 定制：gradientTransform 便捷角度 —— 支持 number 或 {angle:number}（度，顺时针，0=从上到下渐变，180=向上），
        // 数组形式照旧透传。换算为绕中心 (0.5,0.5) 的标准旋转矩阵：
        //   x' = cos*(x-0.5) + 0.5 - sin*(y-0.5)
        //   y' = sin*(x-0.5) + 0.5 + cos*(y-0.5)
        // 即 [[cos, -sin, 0.5-0.5*cos+0.5*sin], [sin, cos, 0.5-0.5*sin-0.5*cos]]；angle=0 时退化为 Figma 默认 [[1,0,0],[0,1,0]]
        // figma-mcp-server 定制：gradientTransform 便捷角度 —— 支持 number、{angle:number}，或 gradient 兄弟键 angle（设计会话实测的调用形态）
        let gradientTransform: any = gradient.gradientTransform || [[1, 0, 0], [0, 1, 0]];
        let gradientTransformNote = "";
        const angleDeg = typeof gradientTransform === "number"
            ? gradientTransform
            : (!Array.isArray(gradientTransform) && typeof gradientTransform?.angle === "number" ? gradientTransform.angle
                : (typeof gradient.angle === "number" ? gradient.angle : null));
        if (angleDeg !== null) {
            const rad = angleDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            gradientTransform = [
                [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
                [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
            ];
            gradientTransformNote = ` | received gradientTransform: ${JSON.stringify(gradient.gradientTransform)}; converted angle ${angleDeg}° -> ${JSON.stringify(gradientTransform)}`;
        }
        const stops = Array.isArray(gradient.stops) ? gradient.stops : [];
        if (stops.length < 2) throw new Error(`node_set_fill: gradient requires at least 2 stops [{position,color:{r,g,b,a}}]${gradientTransformNote}`);
        paintStyle = {
            type: gType,
            gradientTransform,
            gradientStops: stops.map((st: any) => ({
                position: Math.min(1, Math.max(0, Number(st.position) || 0)),
                color: {
                    r: Math.min(1, Math.max(0, Number(st.color?.r) || 0)),
                    g: Math.min(1, Math.max(0, Number(st.color?.g) || 0)),
                    b: Math.min(1, Math.max(0, Number(st.color?.b) || 0)),
                    a: st.color?.a !== undefined ? Math.min(1, Math.max(0, Number(st.color.a))) : 1,
                },
            })),
        };
    } else {
        const { url, bytesBase64, scaleMode, opacity } = image;
        if (url && bytesBase64) {
            throw new Error("node_set_fill: image requires exactly one of 'url' or 'bytesBase64'.");
        }
        if (!url && !bytesBase64) {
            throw new Error("node_set_fill: image requires exactly one of 'url' or 'bytesBase64'.");
        }

        let figmaImage;
        try {
            if (url) {
                try {
                    figmaImage = await figma.createImageAsync(url);
                } catch (e: any) {
                    if (e.message && (e.message.includes("is too large") || e.message.includes("type is unsupported") || e.message.includes("is too small"))) {
                        throw e;
                    }
                    throw new Error(`node_set_fill: could not fetch image from URL '${url}' (network/CORS). createImageAsync needs a directly fetchable, public URL to a PNG/JPEG/GIF.`);
                }
            } else {
                let bytes;
                try {
                    bytes = base64ToBytes(bytesBase64);
                } catch (e) {
                    throw new Error("node_set_fill: 'bytesBase64' is not valid base64. Provide base64-encoded raw PNG/JPEG/GIF bytes.");
                }
                figmaImage = figma.createImage(bytes);
            }
        } catch (e: any) {
            let msg = e.message || String(e);
            if (msg.startsWith("node_set_fill:")) {
                throw e;
            }
            throw new Error(`node_set_fill: Figma rejected the image — '${msg}'. Images must be PNG/JPEG/GIF, ≤4096px per side. PNG/JPEG bytes are auto-resized; this typically means an oversized 'url' image, an oversized GIF, or an unsupported/too-small image — pre-resize or convert it.`);
        }

        paintStyle = {
            type: "IMAGE",
            imageHash: figmaImage.hash,
            scaleMode: scaleMode || "FILL",
        };
        if (opacity !== undefined) {
            paintStyle.opacity = opacity;
        }
    }

    console.log("paintStyle", paintStyle);

    node.fills = [paintStyle];

    return {
        id: node.id,
        name: node.name,
        fills: [paintStyle],
    };
}

/**
 * Sets the stroke color and weight of a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to modify
 * @param {Object} params.color - Color object with r, g, b, a values (0-1)
 * @param {number} params.weight - Uniform stroke weight (default: 1)
 * @param {number} params.strokeTopWeight - Top stroke weight (optional)
 * @param {number} params.strokeBottomWeight - Bottom stroke weight (optional)
 * @param {number} params.strokeLeftWeight - Left stroke weight (optional)
 * @param {number} params.strokeRightWeight - Right stroke weight (optional)
 * @returns {Promise<Object>} Result with node info and applied strokes
 */
export async function setStroke(params: any) {
    const {
        nodeId,
        color: { r, g, b, a },
        weight = 1,
        strokeTopWeight,
        strokeBottomWeight,
        strokeLeftWeight,
        strokeRightWeight,
    } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`Node not found with ID: ${nodeId}`);
    }

    if (!("strokes" in node)) {
        throw new Error(`Node does not support strokes: ${nodeId}`);
    }

    // Create RGBA color
    const rgbColor: any = {
        r: r !== undefined ? r : 0,
        g: g !== undefined ? g : 0,
        b: b !== undefined ? b : 0,
        a: a !== undefined ? a : 1,
    };

    // Set stroke
    const paintStyle: any = {
        type: "SOLID",
        color: {
            r: rgbColor.r,
            g: rgbColor.g,
            b: rgbColor.b,
        },
        opacity: rgbColor.a,
    };

    node.strokes = [paintStyle];

    // Check if any individual stroke side weight is provided
    const hasIndividualWeights =
        strokeTopWeight !== undefined ||
        strokeBottomWeight !== undefined ||
        strokeLeftWeight !== undefined ||
        strokeRightWeight !== undefined;

    if (hasIndividualWeights) {
        // Set individual stroke side weights
        if ("strokeTopWeight" in node) {
            node.strokeTopWeight = strokeTopWeight !== undefined ? strokeTopWeight : 0;
            node.strokeBottomWeight = strokeBottomWeight !== undefined ? strokeBottomWeight : 0;
            node.strokeLeftWeight = strokeLeftWeight !== undefined ? strokeLeftWeight : 0;
            node.strokeRightWeight = strokeRightWeight !== undefined ? strokeRightWeight : 0;
        } else {
            throw new Error(`Node does not support individual stroke weights: ${nodeId}`);
        }
    } else if ("strokeWeight" in node) {
        // Set uniform stroke weight
        node.strokeWeight = weight;
    }

    // Build return value - handle figma.mixed Symbol for strokeWeight
    const strokeWeightValue = "strokeWeight" in node
        ? (node.strokeWeight === figma.mixed ? "mixed" : node.strokeWeight)
        : undefined;

    return {
        id: node.id,
        name: node.name,
        strokes: node.strokes,
        strokeWeight: strokeWeightValue,
        strokeTopWeight: "strokeTopWeight" in node ? node.strokeTopWeight : undefined,
        strokeBottomWeight: "strokeBottomWeight" in node ? node.strokeBottomWeight : undefined,
        strokeLeftWeight: "strokeLeftWeight" in node ? node.strokeLeftWeight : undefined,
        strokeRightWeight: "strokeRightWeight" in node ? node.strokeRightWeight : undefined,
    };
}

/**
 * Sets the corner radius of a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to modify
 * @param {number} params.radius - Corner radius value
 * @param {boolean[]} params.corners - Optional array of 4 booleans [topLeft, topRight, bottomRight, bottomLeft]
 * @returns {Promise<Object>} Result with node info and applied corner radii
 */
export async function setCornerRadius(params: any) {
    const { nodeId, radius, corners } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    if (radius === undefined) {
        throw new Error("Missing radius parameter");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`Node not found with ID: ${nodeId}`);
    }

    // Check if node supports corner radius
    if (!("cornerRadius" in node)) {
        throw new Error(`Node does not support corner radius: ${nodeId}`);
    }

    // If corners array is provided, set individual corner radii
    if (corners && Array.isArray(corners) && corners.length === 4) {
        if ("topLeftRadius" in node) {
            // Node supports individual corner radii
            if (corners[0]) node.topLeftRadius = radius;
            if (corners[1]) node.topRightRadius = radius;
            if (corners[2]) node.bottomRightRadius = radius;
            if (corners[3]) node.bottomLeftRadius = radius;
        } else {
            // Node only supports uniform corner radius
            // @ts-expect-error TS2540: Cannot assign to 'cornerRadius' because it is a read-only property.
            node.cornerRadius = radius;
        }
    } else {
        // Set uniform corner radius
        // @ts-expect-error TS2540: Cannot assign to 'cornerRadius' because it is a read-only property.
        node.cornerRadius = radius;
    }

    return {
        id: node.id,
        name: node.name,
        cornerRadius: "cornerRadius" in node ? node.cornerRadius : undefined,
        topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : undefined,
        topRightRadius: "topRightRadius" in node ? node.topRightRadius : undefined,
        bottomRightRadius:
            "bottomRightRadius" in node ? node.bottomRightRadius : undefined,
        bottomLeftRadius:
            "bottomLeftRadius" in node ? node.bottomLeftRadius : undefined,
    };
}

/**
 * Sets effects (shadows, blurs) on a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to modify
 * @param {Array} params.effects - Array of effect objects
 * @returns {Promise<Object>} Result with node info and applied effects
 */
/**
 * Figma's `Effect` union discriminators. Mirrors `EFFECT_TYPES` in
 * `src/mcp_server/tools/style.ts` — kept as a SEPARATE definition for the same
 * reason the error registries are (Q27): the plugin bundle does not import
 * `src/` at runtime. A behavioural parity test covers both against the pinned
 * typings.
 */
const KNOWN_EFFECT_TYPES = [
    "DROP_SHADOW",
    "INNER_SHADOW",
    "LAYER_BLUR",
    "BACKGROUND_BLUR",
    "NOISE",
    "TEXTURE",
    "GLASS",
];

export function normalizeEffects(effects: any[]): any[] {
    return effects.map((effect: any) => {
        if (!effect.type) {
            throw new Error("Each effect must have a type (DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR, NOISE, TEXTURE, GLASS)");
        }

        // A type outside the pinned union can only reach here from a client that
        // bypassed the schema. We know nothing about its shape, so forward it
        // untouched rather than injecting fields it may not accept.
        if (!KNOWN_EFFECT_TYPES.includes(effect.type)) {
            return effect;
        }

        // Q35: fill defaults ON TOP of the caller's object instead of rebuilding
        // from an enumerated field list. Rebuilding silently discarded every
        // field this function did not name — including `blurType` and the
        // PROGRESSIVE ramp, which downgraded a progressive blur to a normal one
        // with no error, and every field of the NOISE/TEXTURE/GLASS variants.
        // The schema is now the authority on which fields are valid (a
        // per-variant discriminated union pinned to the typings), so whatever
        // reaches here has already been validated and must be forwarded intact.
        const normalized: any = Object.assign({}, effect, {
            visible: effect.visible !== undefined ? effect.visible : true,
        });

        if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
            normalized.color = effect.color || { r: 0, g: 0, b: 0, a: 0.25 };
            normalized.offset = effect.offset || { x: 0, y: 4 };
            normalized.radius = effect.radius !== undefined ? effect.radius : 4;
            normalized.spread = effect.spread !== undefined ? effect.spread : 0;
            normalized.blendMode = effect.blendMode || "NORMAL";
            // showShadowBehindNode is a DROP_SHADOW-only property; Figma's runtime
            // rejects it on INNER_SHADOW ("Unrecognized key(s) ... 'showShadowBehindNode'").
            // The schema already rejects it there; deleting it is defense in depth
            // for a client that bypasses the schema (AS1).
            if (effect.type === "DROP_SHADOW") {
                normalized.showShadowBehindNode = effect.showShadowBehindNode !== undefined ? effect.showShadowBehindNode : false;
            } else {
                delete normalized.showShadowBehindNode;
            }
        } else if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
            normalized.radius = effect.radius !== undefined ? effect.radius : 4;
        }

        return normalized;
    });
}

export async function setEffects(params: any) {
    const { nodeId, effects } = params || {};

    if (!nodeId) {
        throw new Error("Missing nodeId parameter");
    }

    if (!effects || !Array.isArray(effects)) {
        throw new Error("Missing effects parameter or it is not an array");
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
        throw new Error(`Node not found with ID: ${nodeId}`);
    }

    if (!("effects" in node)) {
        throw new Error(`Node does not support effects: ${nodeId}`);
    }

    // Validate and process effects (basic validation)
    const processedEffects = normalizeEffects(effects);


    node.effects = processedEffects;

    return {
        id: node.id,
        name: node.name,
        effects: node.effects
    };
}
