// SPDX-License-Identifier: MIT
// Portions derived from citrolabs/ego-lite (MIT),
//   file: package/ego-browser/src/driver/scroll-motion.ts
//   commit: d392204d1ea1a8027a591ab2b0129c2e11d85f26
// Copyright (c) 2026 CitroLabs
// Modified for Windrise Bridge: imports routed to ego-shims.js (CDP via webContents.debugger). 2026-10-24.
const SINGLE_EVENT_DISTANCE = 120;
const PIXELS_PER_STEP = 80;
const MAX_STEPS = 12;
const STEP_INTERVAL_MS = 8;
/**
 * Dispatch one logical wheel action as a short eased browser-input motion.
 * Small deltas stay immediate, while page-sized deltas are spread over enough
 * input frames to remain visually continuous without creating a long gesture.
 */
export async function dispatchWheelMotion(services, motion) {
    const distance = Math.max(Math.abs(motion.deltaX), Math.abs(motion.deltaY));
    const steps = distance <= SINGLE_EVENT_DISTANCE
        ? 1
        : Math.min(MAX_STEPS, Math.ceil(distance / PIXELS_PER_STEP));
    let emittedX = 0;
    let emittedY = 0;
    for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const eased = progress * progress * (3 - 2 * progress);
        const cumulativeX = step === steps ? motion.deltaX : motion.deltaX * eased;
        const cumulativeY = step === steps ? motion.deltaY : motion.deltaY * eased;
        const deltaX = cumulativeX - emittedX;
        const deltaY = cumulativeY - emittedY;
        emittedX = cumulativeX;
        emittedY = cumulativeY;
        await services.dispatch({
            type: "mouseWheel",
            x: motion.x,
            y: motion.y,
            modifiers: motion.modifiers ?? 0,
            deltaX,
            deltaY,
        });
        if (step < steps)
            await services.sleep(STEP_INTERVAL_MS);
    }
}
