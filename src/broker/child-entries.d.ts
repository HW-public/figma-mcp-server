/** figma-child-* 为 scripts/bundle.mjs 构建时别名到 src/figma-edit-mcp 真实模块的 ambient 声明 */
declare module 'figma-child-server' {
    export function runFigmaMcpServer(): Promise<void>;
}
declare module 'figma-child-socket' {
    export function runSocketBridge(): void;
}
