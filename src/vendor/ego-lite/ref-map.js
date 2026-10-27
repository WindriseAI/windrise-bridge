// SPDX-License-Identifier: MIT
// Portions derived from citrolabs/ego-lite (MIT),
//   file: package/ego-browser/src/ref-map.ts
//   commit: d392204d1ea1a8027a591ab2b0129c2e11d85f26
// Copyright (c) 2026 CitroLabs
// Modified for Windrise Bridge: imports routed to ego-shims.js (CDP via webContents.debugger). 2026-10-24.
export class RefMap {
    map;
    allowFallback;
    constructor({ allowFallback = true } = {}) {
        this.map = new Map();
        this.allowFallback = allowFallback;
    }
    add(refId, backendNodeId, role, name, nth = undefined) {
        this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
    }
    addWithFrame(refId, backendNodeId, role, name, nth = undefined, frameId = undefined, frameProvenance = undefined) {
        this.map.set(refId, {
            backendNodeId,
            role,
            name,
            nth,
            frameId,
            ...(frameProvenance ? { frameProvenance } : {}),
        });
    }
    get(refId) {
        return this.map.get(refId);
    }
    clear() {
        this.map.clear();
    }
}
export function parseRef(input) {
    const trimmed = String(input || "").trim();
    for (const candidate of [
        trimmed.startsWith("@") ? trimmed.slice(1) : null,
        trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
        trimmed,
    ]) {
        if (candidate && /^\d+$/.test(candidate)) {
            return candidate;
        }
    }
    return null;
}
