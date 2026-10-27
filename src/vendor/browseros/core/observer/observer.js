// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/observer/observer.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
// 例外：本文件已由 tools/vendor-patches/browseros/observer.js.patch 改写（光标扫描换成 src/core/snapshot-cursor.js
// 的批量实现：进 shadow DOM、一次往返收候选、带合成提示名）。改行为请改那个 patch，重跑脚本会自动套上。
import { diffSnapshotObservations } from '../snapshot/diff.js';
import { RefMap } from '../snapshot/refs.js';
import { renderSnapshot } from '../snapshot/render.js';
import { fetchAxTree } from './ax-tree.js';
import { scanCursorInFrame } from '../../../../core/snapshot-cursor.js';
import { resolveRefEntry } from './resolve.js';
const MAX_FRAME_DEPTH = 5;
const MAX_STABLE_CAPTURE_ATTEMPTS = 3;
/** Per-page snapshot, ref, and diff state for one BrowserOS page id. */
export class Observer {
    pages;
    frames;
    pageId;
    baseline;
    refs = new RefMap();
    refScope;
    constructor(pages, frames, pageId) {
        this.pages = pages;
        this.frames = frames;
        this.pageId = pageId;
    }
    async snapshot() {
        const result = await this.capture();
        this.commit(result);
        return result;
    }
    async diff() {
        const before = this.baseline;
        const result = await this.capture();
        this.commit(result);
        return diffSnapshotObservations(before, result);
    }
    get lastRefs() {
        return this.refs;
    }
    /** Resolve a ref from the last snapshot to a live element, routed to its frame's session. */
    async resolveRef(ref) {
        const entry = this.refs.get(ref);
        if (!entry) {
            throw new Error(`Unknown ref ${ref}; take a new snapshot.`);
        }
        await this.pages.getSession(this.pageId);
        const { session, axParams } = this.frames.resolveFrameTarget(this.pageId, entry.frameId);
        return resolveRefEntry(session, entry, axParams);
    }
    async capture() {
        const pageSession = await this.pages.getSession(this.pageId);
        // 光标扫描的「专用会话」：默认就是页面会话；有 scanSessionFor 钩子时换成快照层给的窄会话
        // （只放 Runtime / Page / DOM，不碰无障碍树）。同一个页面文档只扫一次，各框架共享结果。
        const scanSession = this.scanSessionFor ? this.scanSessionFor() : pageSession.session;
        const scan = await scanCursorInFrame(scanSession).catch(() => null);
        for (let attempt = 0; attempt < MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
            const before = await this.readMainFrameState(pageSession.session);
            const refs = this.refsForCapture(before);
            const text = await this.captureFrame(undefined, refs, 0, new Set(), pageSession.session, before.frameDocuments, scan, scanSession);
            const after = await this.readMainFrameState(pageSession.session);
            if (!knownMainFrameChanged(before, after)) {
                return { text, refs, url: after.url, scope: refScopeFrom(after), documentId: before.documentId };
            }
        }
        throw new Error('Page document changed during snapshot capture; retry.');
    }
    /** Render a frame, then splice each child iframe's rendered tree under its `- iframe` line. */
    async captureFrame(frameId, refs, baseDepth, visited, rootSession, frameDocuments, scan, scanSession) {
        if (frameId !== undefined) {
            if (visited.has(frameId))
                return '';
            visited.add(frameId);
        }
        const { session, axParams } = this.frames.resolveFrameTarget(this.pageId, frameId);
        const nodes = await fetchAxTree(session, axParams);
        // 光标扫描只能在**当前文档**里跑：主框架扫得到主文档和嵌在里面的同源 iframe 元素，
        // 但跨域 iframe 的内部元素在它自己的文档里，必须换到那个框架的会话再跑一遍。
        // 两份结果合成一张表交给 render：同一个元素只认一次（先到先得），编号不重复。
        const cursorHits = new Map();
        const shareHits = (scanResult) => {
            if (!scanResult) return;
            for (const [backendNodeId, hit] of scanResult.hits) {
                if (!cursorHits.has(backendNodeId)) cursorHits.set(backendNodeId, hit);
            }
        };
        if (scan) {
            await scan.collect(session).catch(() => null);
            shareHits(scan);
        } else {
            // 跨域 iframe：用它自己的会话重新扫一遍（主框架那次在同一棵文档树里，扫不到它）。
            // 注意这里必须用子框架自己的 session，不能拿主框架的 scanSession —— 跨域文档不在它的执行上下文里。
            const own = await scanCursorInFrame(session, { frameId: axParams?.frameId }).catch(() => null);
            if (own) {
                await own.collect(session).catch(() => null);
                shareHits(own);
            }
        }
        const documentId = await this.stableDocumentIdForFrame(rootSession, frameId, frameDocuments);
        const { text, iframes } = renderSnapshot(nodes, {
            refs,
            frameId,
            documentId,
            baseDepth,
            cursorHits,
        });
        if (iframes.length === 0 || baseDepth >= MAX_FRAME_DEPTH)
            return text;
        const lines = text.split('\n');
        // Splice bottom-up so earlier line indices stay valid as we insert.
        for (const stitch of [...iframes].reverse()) {
            const childFrameId = await resolveChildFrameId(session, stitch.backendNodeId);
            if (!childFrameId)
                continue;
            // 子框架先把会话找出来，再决定用哪条会话扫：跨域 iframe 有子会话，同源 iframe 还是页面会话
            const childTarget = this.frames.resolveFrameTarget(this.pageId, childFrameId);
            const childScan = childTarget.session === session ? scan : null;
            const childText = await this.captureFrame(childFrameId, refs, stitch.depth + 1, visited, rootSession, frameDocuments, childScan, scanSession).catch(() => '');
            if (childText)
                lines.splice(stitch.lineIndex + 1, 0, childText);
        }
        return lines.join('\n');
    }
    commit(result) {
        this.baseline = { text: result.text, url: result.url };
        this.refs = result.refs;
        this.refScope = result.scope;
    }
    refsForCapture(state) {
        if (shouldResetRefs(this.refScope, state))
            return new RefMap();
        return this.refs.forkForSnapshot();
    }
    async readMainFrameState(session) {
        try {
            const result = await session.Page.getFrameTree();
            const tree = result.frameTree;
            return {
                url: frameUrl(tree.frame),
                documentId: frameDocumentId(tree.frame),
                frameDocuments: collectFrameDocuments(tree),
            };
        }
        catch {
            return {
                url: await this.readRegistryUrl(),
                frameDocuments: new Map(),
            };
        }
    }
    /** Reads the tab registry URL after frame-tree lookup has already failed. */
    async readRegistryUrl() {
        try {
            return (await this.pages.refresh(this.pageId))?.url ?? 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    async stableDocumentIdForFrame(rootSession, frameId, frameDocuments) {
        const beforeDocumentId = frameDocuments.get(frameId);
        if (frameId === undefined || beforeDocumentId === undefined) {
            return beforeDocumentId;
        }
        const latest = await this.readFrameDocuments(rootSession).catch(() => undefined);
        const afterDocumentId = latest?.get(frameId);
        return afterDocumentId === beforeDocumentId ? beforeDocumentId : undefined;
    }
    async readFrameDocuments(session) {
        const result = await session.Page.getFrameTree();
        return collectFrameDocuments(result.frameTree);
    }
}
function knownUrlsDiffer(beforeUrl, afterUrl) {
    return (beforeUrl !== 'unknown' && afterUrl !== 'unknown' && beforeUrl !== afterUrl);
}
function knownMainFrameChanged(before, after) {
    if (knownUrlsDiffer(before.url, after.url))
        return true;
    return (before.documentId !== undefined &&
        after.documentId !== undefined &&
        before.documentId !== after.documentId);
}
function shouldResetRefs(current, next) {
    if (current === undefined || next.documentId === undefined)
        return true;
    if (current.documentId !== next.documentId)
        return true;
    return knownUrlsDiffer(current.url, next.url);
}
function refScopeFrom(state) {
    if (state.documentId === undefined)
        return undefined;
    return { documentId: state.documentId, url: state.url };
}
function collectFrameDocuments(tree) {
    const documents = new Map();
    function visit(node, isRoot) {
        const documentId = frameDocumentId(node.frame);
        if (documentId !== undefined) {
            documents.set(isRoot ? undefined : node.frame.id, documentId);
            documents.set(node.frame.id, documentId);
        }
        for (const child of node.childFrames ?? [])
            visit(child, false);
    }
    visit(tree, true);
    return documents;
}
function frameDocumentId(frame) {
    if (frame.loaderId === undefined)
        return undefined;
    return `${frame.id}:${frame.loaderId}`;
}
function frameUrl(frame) {
    return frame.url ? `${frame.url}${frame.urlFragment ?? ''}` : 'unknown';
}
/** Resolve an iframe element to the frameId of its embedded document. */
async function resolveChildFrameId(session, backendNodeId) {
    try {
        const described = await session.DOM.describeNode({
            backendNodeId,
            depth: 1,
        });
        const node = described.node;
        return node.contentDocument?.frameId ?? node.frameId;
    }
    catch {
        return undefined;
    }
}
