/**
 * 快照层两条修复（纯 Node，假 CDP）：
 *   node --test src/core/surface-snapshot.test.js
 *
 *   ① 整页快照只跑一次光标扫描：vendor 的 capture 已经把命中交给 render，withHints 不再重复扫；
 *   ② 无障碍读取预算挂在显式上下文上，reset 之后下一次快照重新拿到完整预算（不会跨快照累积）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { __testing, createSurfaceSnapshot } from "./surface-snapshot.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeCdp({ onCursorScan }) {
  const session = {
    Page: {
      async enable() { return {}; },
      async getFrameTree() {
        return { frameTree: { frame: { id: "main", loaderId: "L1", url: "https://example.test/" } } };
      },
      async createIsolatedWorld() { return { executionContextId: 1 }; },
      async setAutoAttach() { return {}; },
    },
    DOM: {
      async enable() { return {}; },
      async describeNode({ objectId }) {
        if (objectId === "el-0") return { node: { backendNodeId: 10 } };
        return { node: { backendNodeId: 99 } };
      },
    },
    Accessibility: {
      async enable() { return {}; },
      async getFullAXTree() {
        return {
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
            { nodeId: "2", role: { value: "generic" }, backendDOMNodeId: 10, childIds: [] },
          ],
        };
      },
    },
    Runtime: {
      async evaluate({ expression }) {
        const text = String(expression);
        if (text.includes("collectCandidates")) {
          onCursorScan();
          return { result: { objectId: "cursor-root" } };
        }
        // 时间框扫描返回空（这条用例只数光标扫描次数）
        if (text.includes('TEMPORAL = ["date"')) return { result: {} };
        return { result: { value: null } };
      },
      async getProperties({ objectId }) {
        if (objectId === "cursor-root") {
          return { result: [
            { name: "nodes", value: { objectId: "nodes" } },
            { name: "meta", value: { objectId: "meta" } },
          ] };
        }
        if (objectId === "nodes") return { result: [{ name: "0", value: { objectId: "el-0" } }] };
        return { result: [] };
      },
      async callFunctionOn({ objectId }) {
        if (objectId === "meta") return { result: { value: [{ hint: "发布", reasons: ["cursor"] }] } };
        return { result: { value: null } };
      },
      async releaseObject() { return {}; },
    },
    Target: { async setAutoAttach() { return {}; } },
  };
  return {
    session: () => session,
    api: { Target: { on: () => () => {} } },
    send: async () => ({}),
  };
}

test("整页快照只跑一次光标扫描，提示名仍然由 vendor 渲染出来", async () => {
  let cursorScans = 0;
  const cdp = fakeCdp({ onCursorScan: () => { cursorScans += 1; } });
  const snap = await createSurfaceSnapshot(cdp, { getUrl: () => "https://example.test/" });
  try {
    const out = await snap.snapshot();
    assert.equal(cursorScans, 1, "一次快照不该扫两三遍整页");
    assert.match(out.text, /- clickable \[ref=e\d+\] \[cursor=pointer\] \(提示: 发布\)/);
  } finally {
    snap.dispose();
  }
});

test("AX 预算拍完就 reset：连续两次读取都拿到完整预算", async () => {
  const { createRedactingSession, resetAxTreeBudget } = __testing;
  let calls = 0;
  const raw = {
    Accessibility: {
      async getFullAXTree() {
        calls += 1;
        await sleep(calls === 1 ? 20 : 120);
        return { nodes: [] };
      },
    },
  };
  const cdp = { session: () => raw };
  const axBudget = {};
  const session = createRedactingSession(cdp, "", { axBudget, axBudgetMs: 200 });
  // 第一次用掉 20ms，再等 100ms：旧实现在这里只剩 80ms 预算。
  await session.Accessibility.getFullAXTree({});
  await sleep(100);
  resetAxTreeBudget(axBudget);
  // 第二次本身要 120ms：reset 生效就成功；delete 空操作就会 CDP_TIMEOUT。
  const result = await session.Accessibility.getFullAXTree({});
  assert.deepEqual(result, { nodes: [] });
});