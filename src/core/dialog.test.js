/**
 * JS 对话框（alert / confirm / prompt）：不能卡到超时，要返回明确错误码并能关掉（纯 Node，假 CDP）。
 *   node --test src/core/dialog.test.js
 *
 * 覆盖：
 *   ① 对话框开着时，发别的命令当场报 DIALOG_OPEN（带类型和文字），不会去等 CDP 超时；
 *   ② 处理对话框的命令（Page.handleJavaScriptDialog）照常放行；
 *   ③ handleDialog(accept) 真的发命令，并且清掉记录；
 *   ④ page_act action:"dialog" 走通：确认 / 取消 / prompt 带文字；没开对话框时报 DIALOG_NOT_OPEN；
 *   ⑤ 关完对话框之后，原来的动作可以继续做。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSurfaceAct } from "./surface-act.js";

/**
 * 一个最小的假 TargetSurface：send 记命令，dialog 是公开字段（和真适配层一致），
 * handleDialog 按真实现的样子清记录。
 */
function fakeSurface({ dialog = null } = {}) {
  const sent = [];
  const cdp = {
    inputBlocked: null,
    dialog,
    session: () => ({}),
    async send(method, params = {}) {
      sent.push({ method, params });
      // 真适配层在对话框开着时会拦所有非白名单命令，错误里带类型和文字
      if (this.dialog && !/^(Page\.handleJavaScriptDialog|Page\.navigate|Page\.stopLoading|Page\.reload|Page\.getNavigationHistory|Page\.navigateToHistoryEntry|Target\.|Browser\.|Inspector\.)|\.(enable|disable)$/.test(String(method))) {
        throw Object.assign(
          new Error(`页面开着 ${this.dialog.type} 对话框（${JSON.stringify(this.dialog.message ?? "")}），命令被拦`),
          { code: "DIALOG_OPEN", dialog: { ...this.dialog } },
        );
      }
      if (method === "Page.handleJavaScriptDialog") {
        this.dialog = null;
        return {};
      }
      if (method === "Runtime.evaluate") return { result: { value: null } };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      return {};
    },
    async handleDialog({ accept = true, promptText } = {}) {
      if (!this.dialog) return null;
      const open = { ...this.dialog };
      const params = { accept: Boolean(accept) };
      if (open.type === "prompt" && typeof promptText === "string") params.promptText = promptText;
      await this.send("Page.handleJavaScriptDialog", params);
      return open;
    },
  };
  const snap = {
    refScope: undefined,
    baseline: { text: '- RootWebArea "页"\n  - button "保存" [ref=e1]', url: "https://example.test/" },
    refs: { get: (ref) => (ref === "e1" ? { ref, role: "button", name: "保存", hint: "", backendNodeId: 1, nth: 0 } : null) },
    async readMainFrameState() { return { url: "https://example.test/", documentId: "doc-1" }; },
    async snapshot() { return { text: snap.baseline.text, url: "https://example.test/" }; },
    async resolveRef() { return { backendNodeId: 1 }; },
  };
  return { cdp, snap, sent };
}

const ALERT = { type: "alert", message: "保存成功", defaultPrompt: "", url: "https://example.test/", at: Date.now() };
const CONFIRM = { type: "confirm", message: "确定删除这条吗？", defaultPrompt: "", url: "https://example.test/", at: Date.now() };
const PROMPT = { type: "prompt", message: "新名字", defaultPrompt: "旧名字", url: "https://example.test/", at: Date.now() };

test("对话框开着时，其它命令当场报 DIALOG_OPEN（带类型和文字），不等超时", async () => {
  const { cdp } = fakeSurface({ dialog: ALERT });
  const error = await cdp.send("Runtime.evaluate", { expression: "1" }).then(() => null, (e) => e);
  assert.equal(error?.code, "DIALOG_OPEN");
  assert.match(error.message, /alert/);
  assert.match(error.message, /保存成功/);
  assert.equal(error.dialog.type, "alert");
  assert.equal(error.dialog.message, "保存成功");
});

test("处理对话框的命令本身照常放行（不会被自己拦住）", async () => {
  const { cdp, sent } = fakeSurface({ dialog: CONFIRM });
  await cdp.send("Page.handleJavaScriptDialog", { accept: false });
  assert.equal(sent.length, 1);
  assert.equal(cdp.dialog, null, "关掉之后记录要清掉");
});

test("handleDialog：确认时发 accept:true，并清掉记录", async () => {
  const { cdp, sent } = fakeSurface({ dialog: CONFIRM });
  const open = await cdp.handleDialog({ accept: true });
  assert.equal(open.type, "confirm");
  assert.deepEqual(sent.at(-1).params, { accept: true });
  assert.equal(cdp.dialog, null);
});

test("handleDialog：prompt 取消时不带 promptText，确认时带上", async () => {
  const first = fakeSurface({ dialog: { ...PROMPT } });
  await first.cdp.handleDialog({ accept: false });
  assert.deepEqual(first.sent.at(-1).params, { accept: false });

  const second = fakeSurface({ dialog: { ...PROMPT } });
  await second.cdp.handleDialog({ accept: true, promptText: "新名字值" });
  assert.deepEqual(second.sent.at(-1).params, { accept: true, promptText: "新名字值" });
});

test("handleDialog：没有开着的对话框时返回 null（不瞎发命令）", async () => {
  const { cdp, sent } = fakeSurface({ dialog: null });
  assert.equal(await cdp.handleDialog({ accept: true }), null);
  assert.equal(sent.length, 0);
});

/* ---------------- page_act action:"dialog" ---------------- */

test("page_act dialog：确认一个 confirm，返回对话框内容并标记 closed", async () => {
  const { cdp, snap, sent } = fakeSurface({ dialog: CONFIRM });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "dialog", accept: true });
  assert.equal(result.ok, true);
  assert.equal(result.dialog.type, "confirm");
  assert.equal(result.dialog.message, "确定删除这条吗？");
  assert.equal(result.closed, true);
  assert.deepEqual(sent.filter((item) => item.method === "Page.handleJavaScriptDialog").at(-1).params, { accept: true });
  assert.equal(cdp.dialog, null);
  act.dispose();
});

test("page_act dialog：取消 alert，accept:false", async () => {
  const { cdp, snap, sent } = fakeSurface({ dialog: ALERT });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "dialog", accept: false });
  assert.equal(result.dialog.type, "alert");
  assert.deepEqual(sent.filter((item) => item.method === "Page.handleJavaScriptDialog").at(-1).params, { accept: false });
  act.dispose();
});

test("page_act dialog：prompt 带 text 时作为 promptText 发出去", async () => {
  const { cdp, snap, sent } = fakeSurface({ dialog: PROMPT });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  await act.act({ action: "dialog", accept: true, text: "新名字值" });
  assert.deepEqual(sent.filter((item) => item.method === "Page.handleJavaScriptDialog").at(-1).params, { accept: true, promptText: "新名字值" });
  act.dispose();
});

test("page_act dialog：没有开着的对话框时明确报 DIALOG_NOT_OPEN", async () => {
  const { cdp, snap } = fakeSurface({ dialog: null });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ action: "dialog", accept: true }).then(() => null, (e) => e);
  assert.equal(error?.code, "DIALOG_NOT_OPEN");
  assert.match(error.message, /没有开着/);
  act.dispose();
});

test("page_act dialog：缺 accept 时报 INVALID_ARGUMENT（不猜该确认还是取消）", async () => {
  const { cdp, snap } = fakeSurface({ dialog: ALERT });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ action: "dialog" }).then(() => null, (e) => e);
  assert.equal(error?.code, "INVALID_ARGUMENT");
  assert.match(error.message, /accept/);
  assert.equal(cdp.dialog?.type, "alert", "参数不对时不能动对话框");
  act.dispose();
});

test("对话框关掉之后，原来的动作能继续做", async () => {
  const { cdp, snap, sent } = fakeSurface({ dialog: CONFIRM });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  await act.act({ action: "dialog", accept: true });
  const before = sent.length;
  // 再做一次动作：现在没有对话框了，命令应该能真的发出去（用 focus，不需要盒子几何）
  const result = await act.act({ ref: "e1", action: "focus" });
  assert.equal(result.ok, true);
  assert.ok(sent.length > before, "关掉对话框后动作要真的发命令");
  act.dispose();
});
