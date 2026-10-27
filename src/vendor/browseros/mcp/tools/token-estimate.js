// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-mcp/src/tools/token-estimate.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
const APPROX_CHARS_PER_TOKEN = 3;
/** Estimates plain text tokens with the same chars/3 heuristic used by compaction. */
export function estimateTextTokens(text) {
    return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}
/** Returns the longest prefix that stays within the estimated token limit. */
export function sliceTextByEstimatedTokens(text, maxTokens) {
    if (estimateTextTokens(text) <= maxTokens)
        return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) {
            low = mid;
        }
        else {
            high = mid - 1;
        }
    }
    return text.slice(0, low);
}
