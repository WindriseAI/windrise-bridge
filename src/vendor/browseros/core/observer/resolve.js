// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/observer/resolve.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
// 例外：本文件已由 tools/vendor-patches/browseros/resolve.js.patch 改写（光标扫描救回的元素不走第二层按角色+名字重查）。
import { ROOT_ROLES } from '../snapshot/roles.js';
import { fetchAxTree } from './ax-tree.js';
/** 光标扫描给出的角色：无障碍树里没有同名节点，第二层重查只会撞到别的元素，直接判过期。 */
const PROMOTED_ROLES = new Set(['clickable', 'image', 'icon', 'file-input']);
/**
 * Resolves a ref to a live element via two tiers: trust the cached backendNodeId, and on
 * staleness re-query the same accessibility tree by (role, name, nth). Using the same data
 * source that minted the ref keeps matching consistent across DOM churn — far more robust than
 * caching a CSS selector. Mutates `entry.backendNodeId` to refresh the cache on a re-query.
 */
export async function resolveRefEntry(session, entry, axParams = {}) {
    if (await isLive(session, entry.backendNodeId)) {
        return { session, backendNodeId: entry.backendNodeId };
    }
    // 被忽略的 AX 节点（角色由光标扫描顶上的 clickable / image / icon / file-input）在树里查不到，
    // 按 role+name+nth 重查会撞上一个长得像的别的元素；宁可报过期，让调用方重新拍快照。
    if (PROMOTED_ROLES.has(entry.role)) {
        throw new Error(`Stale ref ${entry.ref} (${entry.role} "${entry.name}"); take a new snapshot.`);
    }
    const fresh = findByRoleNameNth(await fetchAxTree(session, axParams), entry);
    if (fresh === undefined) {
        throw new Error(`Stale ref ${entry.ref} (${entry.role} "${entry.name}"); take a new snapshot.`);
    }
    entry.backendNodeId = fresh;
    return { session, backendNodeId: fresh };
}
async function isLive(session, backendNodeId) {
    try {
        const resolved = await session.DOM.resolveNode({ backendNodeId });
        const objectId = resolved.object?.objectId;
        if (objectId) {
            await session.Runtime.releaseObject({ objectId }).catch(() => { });
        }
        return Boolean(objectId);
    }
    catch {
        return false;
    }
}
/** Pre-order walk matching the renderer, counting (role, name) occurrences to honour `nth`. */
function findByRoleNameNth(nodes, entry) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const roots = nodes
        .filter((node) => ROOT_ROLES.has(roleOf(node)))
        .map((node) => node.nodeId);
    const start = roots.length > 0 ? roots : nodes[0] ? [nodes[0].nodeId] : [];
    let count = 0;
    let found;
    const visit = (id) => {
        if (found !== undefined)
            return;
        const node = byId.get(id);
        if (!node)
            return;
        if (!node.ignored &&
            node.backendDOMNodeId !== undefined &&
            roleOf(node) === entry.role &&
            nameOf(node) === entry.name) {
            if (count === entry.nth) {
                found = node.backendDOMNodeId;
                return;
            }
            count++;
        }
        for (const childId of node.childIds ?? [])
            visit(childId);
    };
    for (const id of start)
        visit(id);
    return found;
}
function roleOf(node) {
    return typeof node.role?.value === 'string' ? node.role.value : '';
}
function nameOf(node) {
    return typeof node.name?.value === 'string' ? node.name.value : '';
}
