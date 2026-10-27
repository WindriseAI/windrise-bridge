// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/observer/ax-tree.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
/** Fetches a session's full accessibility tree (main frame). Frame stitching layers on later. */
export async function fetchAxTree(session, params = {}) {
    const result = await session.Accessibility.getFullAXTree(params);
    return result.nodes ?? [];
}
