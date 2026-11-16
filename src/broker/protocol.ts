/** 瘦客户端 ↔ broker 的 TCP 分帧协议：4 字节大端长度前缀 + UTF-8 JSON */

export function encodeFrame(obj: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

/** 增量解码器：feed 任意分片的 Buffer，产出完整消息对象 */
export class FrameDecoder {
    private buf: Buffer = Buffer.alloc(0);

    feed(chunk: Buffer): unknown[] {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const out: unknown[] = [];
        for (;;) {
            if (this.buf.length < 4) break;
            const len = this.buf.readUInt32BE(0);
            if (this.buf.length < 4 + len) break;
            const payload = this.buf.subarray(4, 4 + len).toString('utf-8');
            this.buf = this.buf.subarray(4 + len);
            try {
                out.push(JSON.parse(payload));
            } catch {
                // 单条坏帧不致命，跳过
            }
        }
        return out;
    }
}

// ---- 消息类型（类型契约，双方共用） ----

export interface HelloMsg { type: 'hello'; token: string; clientName: string }
export interface WelcomeMsg {
    type: 'welcome';
    serverVersion: string;
    bridge: 'connected' | 'disconnected';
    channel: string | null;
}
export interface ToolsListMsg { type: 'tools/list' }
export interface ToolsMsg { type: 'tools'; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
export interface CallMsg { type: 'tools/call'; id: number; name: string; args: Record<string, unknown> }
export interface ResultMsg { type: 'result'; id: number; result: unknown }
export interface ErrorMsg { type: 'error'; id: number; message: string }
export interface BatchMsg {
    type: 'tools/batch';
    id: number;
    ops: Array<{ name: string; args?: Record<string, unknown> }>;
    abortOnError?: boolean;
    /** false → 只返回 total/executed/failed + 失败项详情（默认 true 返回逐项结果） */
    verbose?: boolean;
}
export interface BatchResultMsg {
    type: 'batch-result';
    id: number;
    total: number;
    executed: number;
    failed: number;
    allOk: boolean;
    results?: Array<Record<string, unknown>>;
    failures?: Array<{ index: number; name: string; error: string }>;
}
export interface StatusMsg { type: 'status' }
export interface StatusReportMsg {
    type: 'status-report';
    clients: number;
    bridge: 'connected' | 'disconnected';
    channel: string | null;
    queued: number;
}
export interface InvalidMsg { type: 'invalid'; message: string }

export type BrokerMsg = WelcomeMsg | ToolsMsg | ResultMsg | ErrorMsg | BatchResultMsg | StatusReportMsg | InvalidMsg;
