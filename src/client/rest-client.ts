/**
 * Figma REST API 客户端
 * 鉴权: X-Figma-Token header
 * 文档: https://www.figma.com/developers/api
 */
export class FigmaApiError extends Error {
    constructor(
        public status: number,
        message: string,
        public body?: string,
    ) {
        super(message);
        this.name = 'FigmaApiError';
    }
}

export class FigmaClient {
    constructor(
        private apiKey: string,
        private baseUrl: string,
    ) {}

    async request<T>(path: string, retries = 3): Promise<T> {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const res = await fetch(`${this.baseUrl}${path}`, {
                    headers: { 'X-Figma-Token': this.apiKey },
                });
                if (res.status === 429 || res.status >= 500) {
                    lastError = new FigmaApiError(res.status, `Figma API ${res.status}`);
                    await sleep(500 * attempt);
                    continue;
                }
                if (!res.ok) {
                    const body = await res.text().catch(() => '');
                    throw new FigmaApiError(res.status, `Figma API ${res.status}: ${body.slice(0, 300)}`, body);
                }
                return (await res.json()) as T;
            } catch (e) {
                if (e instanceof FigmaApiError && e.status !== 429 && e.status < 500) throw e;
                lastError = e;
                if (attempt < retries) await sleep(500 * attempt);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /** 拉取完整文件文档 */
    getFile(fileKey: string) {
        return this.request<FigmaFileResponse>(`/files/${fileKey}`);
    }

    /** 按节点 id 拉取子树 */
    getFileNodes(fileKey: string, nodeIds: string[]) {
        const ids = nodeIds.map(encodeURIComponent).join(',');
        return this.request<FigmaNodesResponse>(`/files/${fileKey}/nodes?ids=${ids}`);
    }

    /** 获取渲染 URL 列表；返回 nodeId → 临时下载地址 */
    async getImageUrls(fileKey: string, nodeIds: string[], format: string, scale: number): Promise<Record<string, string>> {
        const ids = nodeIds.map(encodeURIComponent).join(',');
        const data = await this.request<{ images: Record<string, string | null>; err?: string }>(
            `/files/${fileKey}/images?ids=${ids}&format=${format}&scale=${scale}`,
        );
        if (data.err) throw new FigmaApiError(400, `Figma images API error: ${data.err}`);
        const out: Record<string, string> = {};
        for (const [id, url] of Object.entries(data.images)) {
            if (url) out[id] = url;
        }
        return out;
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// ---- Figma REST 响应类型（仅声明用到的字段）----

export interface FigmaFileResponse {
    name: string;
    document: FigmaNode;
}

export interface FigmaNodesResponse {
    name: string;
    nodes: Record<string, { document: FigmaNode }>;
}

export interface FigmaNode {
    id: string;
    name: string;
    type: string;
    absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
    fills?: Array<Record<string, unknown>>;
    strokes?: Array<Record<string, unknown>>;
    strokeWeight?: number;
    cornerRadius?: number;
    characters?: string;
    style?: Record<string, unknown>;
    layoutMode?: string;
    itemSpacing?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
    children?: FigmaNode[];
}
