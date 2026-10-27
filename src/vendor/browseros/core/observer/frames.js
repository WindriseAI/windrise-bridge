// SPDX-License-Identifier: AGPL-3.0
// 来源：BrowserOS（https://github.com/browseros-ai/BrowserOS）提交 512f9cc15962
//       packages/browseros-agent/packages/browser-core/src/core/observer/frames.ts
// 由 tools/vendor-browseros.mjs 从 TypeScript 转成 JavaScript，逻辑未改。不要直接改这个文件，重跑脚本会覆盖。
/**
 * Tracks out-of-process iframe (OOPIF) sessions via flat auto-attach and resolves any frame to the
 * right CDP session + params. OOPIF sessions are keyed globally by frameId — Chrome reuses the
 * frameId as the OOPIF targetId, which is globally unique — so the owning page never has to be
 * threaded through. Same-origin frames are reached through their page session with a frameId param.
 * Mirrors agent-browser's resolve_ax_session / resolve_frame_session split, unified here.
 */
export class FrameRegistry {
    cdp;
    oopifSessions = new Map();
    pageSessions = new Map();
    constructor(cdp) {
        this.cdp = cdp;
        this.cdp.Target.on('attachedToTarget', (params) => {
            void this.onAttached(params);
        });
        this.cdp.Target.on('detachedFromTarget', (params) => {
            this.onDetached(params);
        });
    }
    /** Record a page's session and enable cross-origin iframe attachment on it. */
    async registerPage(pageSession, pageId, sessionId) {
        this.pageSessions.set(pageId, sessionId);
        await pageSession.Target.setAutoAttach({
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
        }).catch(() => { });
    }
    /**
     * main frame → page session, no frameId. cross-origin OOPIF → its dedicated session, no frameId.
     * same-origin iframe → page session WITH a frameId param.
     */
    resolveFrameTarget(pageId, frameId) {
        const pageSessionId = this.pageSessions.get(pageId);
        if (pageSessionId === undefined) {
            throw new Error(`Page ${pageId} has no attached session`);
        }
        if (frameId === undefined) {
            return { session: this.cdp.session(pageSessionId), axParams: {} };
        }
        const oopif = this.oopifSessions.get(frameId);
        if (oopif) {
            return { session: this.cdp.session(oopif), axParams: {} };
        }
        return { session: this.cdp.session(pageSessionId), axParams: { frameId } };
    }
    async onAttached(params) {
        if (params.targetInfo?.type !== 'iframe')
            return;
        this.oopifSessions.set(params.targetInfo.targetId, params.sessionId);
        const session = this.cdp.session(params.sessionId);
        if (params.waitingForDebugger) {
            await session.Runtime.runIfWaitingForDebugger().catch(() => { });
        }
        await session.DOM.enable().catch(() => { });
        await session.Accessibility.enable().catch(() => { });
    }
    onDetached(params) {
        for (const [frameId, sessionId] of this.oopifSessions) {
            if (sessionId === params.sessionId)
                this.oopifSessions.delete(frameId);
        }
    }
}
