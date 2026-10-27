// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/snapshot/refs.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
/** Allocates public `eN` refs while preserving same-document backend-node identity. */
export class RefMap {
    byRef = new Map();
    nextRefNum = 1;
    nextFallbackRefNum = 1;
    byStableNode = new Map();
    stableRefs = new Set();
    nthCounter = new Map();
    /** Starts a new snapshot without discarding same-document stable ref assignments. */
    beginSnapshot() {
        this.byRef.clear();
        this.nthCounter.clear();
        this.nextFallbackRefNum = 1;
    }
    /** Returns an isolated working map for a new same-document snapshot capture. */
    forkForSnapshot() {
        const fork = new RefMap();
        fork.nextRefNum = this.nextRefNum;
        fork.byStableNode.clear();
        for (const [key, ref] of this.byStableNode) {
            fork.byStableNode.set(key, ref);
        }
        fork.stableRefs.clear();
        for (const ref of this.stableRefs) {
            fork.stableRefs.add(ref);
        }
        fork.beginSnapshot();
        return fork;
    }
    /** Clears all current and stable refs for a new top-level document. */
    reset() {
        this.byRef.clear();
        this.byStableNode.clear();
        this.stableRefs.clear();
        this.nthCounter.clear();
        this.nextRefNum = 1;
        this.nextFallbackRefNum = 1;
    }
    /** Returns the public ref for a node and records its latest resolution metadata. */
    mint(node) {
        const key = `${node.frameId ?? ''}\u0000${node.role}\u0000${node.name}`;
        const nth = this.nthCounter.get(key) ?? 0;
        this.nthCounter.set(key, nth + 1);
        const stableKey = node.documentId === undefined
            ? undefined
            : stableNodeKey({
                backendNodeId: node.backendNodeId,
                documentId: node.documentId,
                frameId: node.frameId,
            });
        const ref = stableKey === undefined
            ? this.nextFallbackRef()
            : this.refForStableNode(stableKey);
        this.byRef.set(ref, {
            ref,
            backendNodeId: node.backendNodeId,
            role: node.role,
            name: node.name,
            nth,
            frameId: node.frameId,
        });
        return ref;
    }
    get(ref) {
        return this.byRef.get(ref);
    }
    get size() {
        return this.byRef.size;
    }
    refForStableNode(key) {
        const existing = this.byStableNode.get(key);
        if (existing !== undefined)
            return existing;
        const ref = this.nextRef();
        this.byStableNode.set(key, ref);
        this.stableRefs.add(ref);
        return ref;
    }
    nextRef() {
        for (;;) {
            const ref = `e${this.nextRefNum++}`;
            if (!this.isReserved(ref))
                return ref;
        }
    }
    nextFallbackRef() {
        for (;;) {
            const ref = `e${this.nextFallbackRefNum++}`;
            if (!this.isReserved(ref))
                return ref;
        }
    }
    isReserved(ref) {
        if (this.byRef.has(ref))
            return true;
        return this.stableRefs.has(ref);
    }
}
function stableNodeKey(node) {
    return `${node.documentId}\u0000${node.frameId ?? ''}\u0000${node.backendNodeId}`;
}
