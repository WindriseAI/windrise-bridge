/**
 * 真浏览器路径的对话框竞速（纯 Node，假 CDP 连接）：
 *   node --test src/core/dialog-race.test.js
 *
 * 覆盖 t12 问题 1 的根因：点击的 Input.dispatchMouseEvent 要等输入派发完才回，
 * 而 alert 开着时浏览器把这条响应压住。TargetSurface 必须一边等鼠标 ack、一边等
 * Page.javascriptDialogOpening，对话框先到就立刻按 DIALOG_OPEN 结算，并作废在途鼠标命令。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { CdpConnection } = require("../../electron/cdp-connection.cjs");
const { TargetSurface } = require("../../electron/target-surface.cjs");

/** 假连接：只实现 TargetSurface 用到的 send / onEvent / 会话状态。 */
class FakeConn {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.isClosed = false;
    this.closedReason = null;
    this.aborted = 0;
    this.inputReject = null;
  }

  onEvent(event, handler, sessionId) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    const entry = { handler, sessionId };
    this.listeners.get(event).add(entry);
    return () => this.listeners.get(event)?.delete(entry);
  }

  emit(event, params, sessionId) {
    for (const entry of [...(this.listeners.get(event) ?? [])]) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      entry.handler(params, sessionId);
    }
  }

  send(method, params = {}, sessionId = "", options = {}) {
    this.sent.push({ method, params, sessionId, options });
    if (method === "Target.attachToTarget") {
      return Promise.resolve({ sessionId: "S1", targetInfo: { url: "https://example.test/", title: "示例" } });
    }
    if (method === "Page.getFrameTree") {
      return Promise.resolve({ frameTree: { frame: { id: "F1", url: "https://example.test/" } } });
    }
    if (method === "Input.dispatchMouseEvent" || method === "Runtime.callFunctionOn") {
      // 真机：alert 开着时这条命令的响应被压住，永远等不到；只有 abort 能把它结算掉。
      // 注意这里不能写成 async：async 会包一层新 Promise，挂在里面的 abort 会丢。
      const pending = new Promise((_resolve, reject) => {
        if (method === "Input.dispatchMouseEvent") this.inputReject = reject;
        else this.callFunctionReject = reject;
      });
      pending.abort = (reason) => {
        this.aborted += 1;
        reject(reason);
        return true;
      };
      return pending;
    }
    return Promise.resolve({});
  }

  isSessionClosed() { return false; }
  markSessionClosed() {}
}

async function attachedSurface() {
  const conn = new FakeConn();
  const surface = new TargetSurface(conn, { targetId: "T1", label: "测试标签页" });
  await surface.attach();
  return { conn, surface };
}

test("点击弹出 alert：不等鼠标 ack，立刻按 DIALOG_OPEN 结算并作废在途命令", async () => {
  const { conn, surface } = await attachedSurface();
  const started = Date.now();
  const pending = surface.send("Input.dispatchMouseEvent", { type: "mousePressed" }, "", { timeoutMs: 5_000 });
  // 鼠标命令已经发出，但浏览器还没回；这时 alert 弹出来了
  setTimeout(() => conn.emit("Page.javascriptDialogOpening", {
    type: "alert",
    message: "I am a JS Alert",
    defaultPrompt: "",
  }, "S1"), 10);
  const error = await pending.catch((caught) => caught);
  assert.equal(error.code, "DIALOG_OPEN");
  assert.equal(error.dialog.type, "alert");
  assert.equal(error.dialog.message, "I am a JS Alert");
  assert.equal(error.dialog.defaultPrompt, "");
  assert.ok(Date.now() - started < 1_000, `应该立即返回，实际等了 ${Date.now() - started}ms`);
  assert.equal(conn.aborted, 1, "在途的 Input.dispatchMouseEvent 必须被作废");
  assert.equal(surface.dialog?.type, "alert");
  surface.dispose();
});

test("对话框已经开着时，其它命令当场报 DIALOG_OPEN（带类型 / 文字 / 默认值）", async () => {
  const { surface } = await attachedSurface();
  surface.dialog = { type: "prompt", message: "请输入名字", defaultPrompt: "旧名字", url: "https://example.test/" };
  const error = await surface.send("Runtime.evaluate", { expression: "1" }).catch((caught) => caught);
  assert.equal(error.code, "DIALOG_OPEN");
  assert.deepEqual(error.dialog, surface.dialog);
  surface.dispose();
});

test("handleDialog：prompt 确认时带 promptText，并清掉记录", async () => {
  const { conn, surface } = await attachedSurface();
  surface.dialog = { type: "prompt", message: "请输入名字", defaultPrompt: "旧名字", url: "https://example.test/" };
  const open = await surface.handleDialog({ accept: true, promptText: "新名字" });
  assert.equal(open.type, "prompt");
  assert.equal(surface.dialog, null);
  const sent = conn.sent.filter((item) => item.method === "Page.handleJavaScriptDialog").at(-1);
  assert.deepEqual(sent?.params, { accept: true, promptText: "新名字" });
  surface.dispose();
});

test("时间框写入（Runtime.callFunctionOn）触发的 alert：也立刻 DIALOG_OPEN，不卡到超时", async () => {
  const { conn, surface } = await attachedSurface();
  const pending = surface.send("Runtime.callFunctionOn", {
    functionDeclaration: "function setTemporalValueForAction(payload) { return payload; }",
    returnByValue: true,
  }, "", { timeoutMs: 5_000 });
  setTimeout(() => conn.emit("Page.javascriptDialogOpening", {
    type: "alert",
    message: "saved",
    defaultPrompt: "",
  }, "S1"), 10);
  const outcome = await Promise.race([
    pending.catch((caught) => caught),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  assert.notEqual(outcome, "timeout", "Runtime.callFunctionOn 必须参与对话框竞速，不能干等 15 秒");
  assert.equal(outcome.code, "DIALOG_OPEN");
  assert.equal(outcome.dialog?.message, "saved");
  assert.equal(conn.aborted, 1, "在途的 callFunctionOn 也要被作废");
  surface.dispose();
});

test("signal 已取消：命令一个字都不发，错误码 CDP_ABORTED + 可以重试", async () => {
  const { conn, surface } = await attachedSurface();
  const controller = new AbortController();
  controller.abort();
  const before = conn.sent.filter((item) => item.method === "Input.dispatchMouseEvent").length;
  const error = await surface.send("Input.dispatchMouseEvent", { type: "mousePressed" }, "", {
    timeoutMs: 5_000,
    signal: controller.signal,
  }).catch((caught) => caught);
  assert.equal(error.code, "CDP_ABORTED");
  assert.equal(error.sent, false);
  assert.equal(error.aborted, true);
  assert.match(error.next_step, /没有发出/);
  assert.equal(conn.sent.filter((item) => item.method === "Input.dispatchMouseEvent").length, before, "取消后不能照样发出去");
  surface.dispose();
});

test("在途命令被 signal 取消：独立错误码 CDP_ABORTED，并提示可能已发出、不要重试", async () => {
  const { surface } = await attachedSurface();
  const controller = new AbortController();
  const pending = surface.send("Input.dispatchMouseEvent", { type: "mousePressed" }, "", {
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const error = await pending.catch((caught) => caught);
  assert.equal(error.code, "CDP_ABORTED", "不能伪装成超时（上层会按超时重试）");
  assert.equal(error.sent, true);
  assert.equal(error.aborted, true);
  assert.match(error.next_step, /可能已经发出，不要自动重试/);
  surface.dispose();
});

test("CdpConnection.send 收到已取消的 signal：不发 transport，也不再出现在在途表", async () => {
  const transport = {
    sent: [],
    send(text) { this.sent.push(text); },
    close() {},
  };
  const conn = new CdpConnection(transport, { timeoutMs: 10_000 });
  const controller = new AbortController();
  controller.abort();
  const error = await conn.send("Runtime.evaluate", { expression: "1" }, "", {
    timeoutMs: 10_000,
    signal: controller.signal,
  }).catch((caught) => caught);
  assert.equal(error.code, "CDP_ABORTED");
  assert.equal(transport.sent.length, 0, "已经取消的命令不能在页面里执行");
  assert.equal(conn.pending.size, 0);
});

test("CdpConnection.send 返回可作废的句柄：abort 立刻结算，在途表清空", async () => {
  const transport = {
    sent: [],
    send(text) { this.sent.push(text); },
    close() {},
  };
  const conn = new CdpConnection(transport, { timeoutMs: 10_000 });
  const pending = conn.send("Runtime.evaluate", { expression: "1" }, "", { timeoutMs: 10_000 });
  assert.equal(typeof pending.abort, "function");
  const reason = new Error("调用方不等了");
  assert.equal(pending.abort(reason), true);
  const error = await pending.catch((caught) => caught);
  assert.equal(error, reason);
  assert.equal(conn.pending.size, 0, "作废后不能留在在途表里");
  assert.equal(pending.abort(reason), false, "已经结算过的命令不能再作废一次");
});
