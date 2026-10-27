/**
 * 按编号动作的两条修复（纯 Node，假 CDP）：
 *   node --test src/core/surface-act.test.js
 *
 * 覆盖：
 *   ① 编号失效（element is not connected / REF_STALE）时自动重拍快照、按 role + 名字 + 序号找回同一个元素，重试一次；
 *   ② 找不到时报 REF_STALE，并带上最新快照里最像的 3 个元素；
 *   ③ type 不给 ref 时往当前焦点元素输入；没有可输入的焦点元素时明确报错。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSurfaceAct } from "./surface-act.js";

const PAGE = 'https://zh.wikipedia.org/wiki/新加坡';

/**
 * 一个假 CDP + 假快照：
 *   - refs 里记编号 → backendNodeId；resolveRef 按 alive 决定还活着吗；
 *   - 页面脚本（Runtime.callFunctionOn / Input.insertText）都记在 sent 里，按 script 决定返回值。
 */
function harness({ snapshotText, alive = new Set(), onSnapshot = null, focusScript = null, focusName = "" } = {}) {
  const sent = [];
  const state = { text: snapshotText, alive: new Set(alive), snapshots: 0 };
  const cdp = {
    inputBlocked: null,
    session: () => ({}),
    async send(method, params = {}) {
      sent.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression ?? "");
        // type 不给 ref 时先找当前焦点元素：这里给一个假 objectId
        if (/activeElement/.test(expression)) {
          // 同一个表达式有两种用法：要 objectId（returnByValue:false）还是要名字（returnByValue:true）
          return params.returnByValue === true ? { result: { value: focusName } } : { result: { objectId: "obj-focused" } };
        }
        return { result: { value: expression.includes("innerWidth") ? { x: 1, y: 2 } : null } };
      }
      if (method === "Runtime.callFunctionOn") {
        const script = String(params.functionDeclaration ?? "");
        if (focusScript) return focusScript(script, params);
        // type 的 prepare：成功
        return { result: { value: { ok: true, tag: "input" } } };
      }
      if (method === "DOM.resolveNode") {
        return state.alive.has(params.backendNodeId) ? { object: { objectId: `obj-${params.backendNodeId}` } } : {};
      }
      if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    },
  };
  const snap = {
    refScope: undefined,
    baseline: { text: snapshotText, url: PAGE },
    refs: { get: (ref) => state.refs?.[ref] },
    async readMainFrameState() { return { url: PAGE, documentId: "doc-1" }; },
    async snapshot() {
      state.snapshots += 1;
      if (onSnapshot) onSnapshot(state);
      return { text: state.text, url: PAGE };
    },
    async resolveRef(ref) {
      const entry = state.refs?.[ref];
      if (!entry) throw new Error(`Unknown ref ${ref}`);
      if (!state.alive.has(entry.backendNodeId)) throw new Error(`Stale ref ${ref} (${entry.role} "${entry.name}"); take a new snapshot.`);
      return { backendNodeId: entry.backendNodeId };
    },
  };
  return { cdp, snap, state, sent };
}

/** 让 refs 和快照对得上：按行里的 [ref=eN] 建表。 */
function indexRefs(text) {
  const refs = {};
  for (const line of text.split("\n")) {
    const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
    if (!ref) continue;
    const role = /^- ([^\s"[]+)/.exec(line.trim())?.[1] ?? "";
    const name = /"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? "";
    const hint = /\(提示: ([^)]*)\)/.exec(line)?.[1] ?? "";
    const backendNodeId = Number(ref.slice(1));
    refs[ref] = { ref, role, name, hint, backendNodeId, nth: 0 };
  }
  return refs;
}

/* ---------------- ③ 编号失效后自动重拍、按 role + 名字 + 序号找回 ---------------- */

test("focus：节点被框架换掉（element is not connected）时重拍快照找回同一个元素并重试一次", async () => {
  const before = '- RootWebArea "维基百科"\n  - searchbox "搜索维基百科" [ref=e238]';
  const { cdp, snap, state } = harness({ snapshotText: before });
  state.refs = indexRefs(before);
  state.alive = new Set([238]);
  // 重拍之后同一个输入框换了编号、连角色都变了（实测维基从 searchbox 变成 combobox）
  state.text = '- RootWebArea "维基百科"\n  - combobox "搜索维基百科" [ref=e249]';
  let failures = 0;
  let successes = 0;
  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId, extra) => {
    if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration ?? "").includes("focusElementForAction")) {
      if (failures === 0) {
        failures += 1;
        // 第一次：节点被 React 换掉，ego 的 focus 会把 transient 的这句原样抛出来
        return { result: { value: { error: "element is not connected" } } };
      }
      successes += 1;
      return { result: { value: { focused: true } } };
    }
    return originalSend(method, params, sessionId, extra);
  };
  state.refs = { ...indexRefs(state.text), e238: state.refs.e238 };
  state.alive = new Set([238, 249]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ ref: "e238", action: "focus" });
  assert.equal(state.snapshots, 1, "应该重拍了一次快照");
  assert.equal(failures, 1);
  assert.equal(successes, 1, "重试一次就成功了");
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.equal(result.ref, "e249", "名字相同、角色变了的那个元素要认出来");
  assert.equal(result.previousRef, "e238");
  act.dispose();
});

test("重试只做一次：第二次还失败就如实报 REF_STALE", async () => {
  const before = '- RootWebArea "页"\n  - button "保存" [ref=e5]';
  const { cdp, snap, state } = harness({ snapshotText: before });
  state.refs = indexRefs(before);
  state.alive = new Set([5]);
  let calls = 0;
  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId, extra) => {
    if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration ?? "").includes("focusElementForAction")) {
      calls += 1;
      return { result: { value: { error: "element is not connected" } } };
    }
    return originalSend(method, params, sessionId, extra);
  };
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ ref: "e5", action: "focus" }).catch((caught) => caught);
  assert.equal(calls, 2, "第一次 + 重试一次，不多试");
  assert.ok(["REF_STALE", "NOT_ACTIONABLE"].includes(error.code), error.code);
  act.dispose();
});

test("两个同名搜索框、值都变了：重认仍回到原来那一个（不能落到第一个）", async () => {
  const before = [
    '- RootWebArea "页"',
    '  - searchbox "搜索" [ref=e1]: "a"',
    '  - searchbox "搜索" [ref=e2]: "b"',
  ].join("\n");
  const { cdp, snap, state } = harness({ snapshotText: before });
  state.refs = indexRefs(before);
  state.alive = new Set([1, 2]);
  // 页面自己改了值：完整签名（含 value）两个都对不上，但「同名里的第二个」不能变。
  state.text = [
    '- RootWebArea "页"',
    '  - searchbox "搜索" [ref=e101]: "x"',
    '  - searchbox "搜索" [ref=e102]: "y"',
  ].join("\n");
  state.refs = { ...indexRefs(before), ...indexRefs(state.text) };
  state.alive = new Set([1, 2, 101, 102]);
  let failures = 0;
  const originalSend = cdp.send.bind(cdp);
  const resolvedNodes = [];
  cdp.send = async (method, params, sessionId, extra) => {
    if (method === "DOM.resolveNode") resolvedNodes.push(params.backendNodeId);
    if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration ?? "").includes("focusElementForAction")) {
      if (failures === 0) {
        failures += 1;
        return { result: { value: { error: "element is not connected" } } };
      }
      return { result: { value: { focused: true } } };
    }
    return originalSend(method, params, sessionId, extra);
  };
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ ref: "e2", action: "focus" });
  assert.equal(result.ref, "e102", "应该认回第二个搜索框");
  assert.equal(resolvedNodes.at(-1), 102, "重试时解析的必须是第二个搜索框的 backendNodeId");
  act.dispose();
});

test("重拍后找不到同一个元素：报 REF_STALE，并带上最像的 3 个元素", async () => {
  const before = '- RootWebArea "页"\n  - button "保存草稿" [ref=e5]';
  const { cdp, snap, state } = harness({ snapshotText: before });
  state.refs = indexRefs(before);
  state.alive = new Set();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  // 重拍后的快照里没有「保存草稿」，只有几个像的
  state.text = [
    '- RootWebArea "页"',
    '  - button "保存" [ref=e20]',
    '  - button "保存并关闭" [ref=e21]',
    '  - button "另存为" [ref=e22]',
    '  - link "帮助" [ref=e23]',
  ].join("\n");
  const error = await act.act({ ref: "e5", action: "click" }).catch((caught) => caught);
  assert.equal(error.code, "REF_STALE");
  assert.match(error.message, /最新快照里最像的 3 个元素/);
  assert.match(error.message, /保存并关闭/);
  assert.doesNotMatch(error.message, /帮助/);
  act.dispose();
});

/* ---------------- ⑧ type 不给 ref：往当前焦点元素输入 ---------------- */

test("type 不给 ref：当前焦点是输入框，就往里输入", async () => {
  const { cdp, snap, sent } = harness({ snapshotText: '- RootWebArea "页"' });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "type", text: "新加坡" });
  assert.equal(result.ok, true);
  assert.equal(result.focused, true);
  assert.equal(result.ref, null);
  const inserted = sent.find((item) => item.method === "Input.insertText");
  assert.equal(inserted?.params.text, "新加坡");
  act.dispose();
});

test("type 不给 ref：当前焦点不是输入框时报 NOT_ACTIONABLE", async () => {
  const { cdp, snap } = harness({
    snapshotText: '- RootWebArea "页"',
    focusScript: () => ({ result: { value: { error: "not-fillable", tag: "div" } } }),
  });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ action: "type", text: "x" }).catch((caught) => caught);
  assert.equal(error.code, "NOT_ACTIONABLE");
  assert.match(error.message, /不是输入框/);
  act.dispose();
});

test("type 不给 ref：页面上没有焦点元素时明确报错（不猜目标）", async () => {
  const { cdp, snap } = harness({ snapshotText: '- RootWebArea "页"' });
  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId, extra) => {
    if (method === "Runtime.evaluate" && /activeElement/.test(String(params?.expression ?? ""))) return { result: { objectId: undefined } };
    return originalSend(method, params, sessionId, extra);
  };
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ action: "type", text: "x" }).catch((caught) => caught);
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.match(error.message, /没有获得焦点的元素/);
  act.dispose();
});

/* ---------------- ⑩ 时间 / 日期框：宿主 input 和 shadow 里的 spinbutton 都能填 ---------------- */

/** 时间框的假页面脚本：探测返回 time，写入返回读回值（或格式错误）。 */
function temporalScript({ value = "12:30", current = "", error = null } = {}) {
  return (script, params) => {
    // 写入函数里也有 `const TEMPORAL =`，必须先认 setTemporalValueForAction，否则会误当成只读探测
    if (script.includes("setTemporalValueForAction")) {
      const expected = params?.arguments?.[0]?.value ?? value;
      return { result: { value: error ?? { ok: true, type: "time", value: expected, expected } } };
    }
    if (script.includes("const TEMPORAL =")) return { result: { value: { type: "time", value: current } } };
    return { result: { value: { ok: true, tag: "input" } } };
  };
}

test("type 时间框（快照里是 spinbutton）：走原生 setter，读回确认，不发 Input.insertText", async () => {
  const text = '- RootWebArea "表单"\n  - InputTime "Preferred delivery time:"\n    - spinbutton "小时 小时" [ref=e11]';
  const { cdp, snap, state, sent } = harness({ snapshotText: text, focusScript: temporalScript() });
  state.refs = indexRefs(text);
  state.alive = new Set([11]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ ref: "e11", action: "type", text: "12:30" });
  assert.equal(result.temporal?.type, "time");
  assert.equal(result.temporal?.value, "12:30");
  assert.equal(result.outcome, "confirmed", "写完读回值已经核对过，就是 confirmed，不是 dispatched");
  assert.equal(result.dispatched, true);
  assert.equal(result.kind, "temporal");
  assert.equal(sent.filter((item) => item.method === "Input.insertText").length, 0, "时间框不该走键盘输入");
  assert.ok(sent.some((item) => item.method === "Runtime.callFunctionOn" && String(item.params.functionDeclaration).includes("setTemporalValueForAction")));
  act.dispose();
});

test("type 时间框：浏览器不接受的值报 ACT_FAILED，不假成功", async () => {
  const text = '- RootWebArea "表单"\n  - InputTime "Preferred delivery time:"\n    - spinbutton "小时 小时" [ref=e11]';
  const { cdp, snap, state } = harness({
    snapshotText: text,
    focusScript: temporalScript({ error: { error: "malformed value", type: "time", value: "", expected: "25:99" } }),
  });
  state.refs = indexRefs(text);
  state.alive = new Set([11]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ ref: "e11", action: "type", text: "25:99" }).catch((caught) => caught);
  assert.equal(error.code, "ACT_FAILED");
  // 宿主字段已经被写入过（可能被浏览器清空）：不能说「什么都没发生」，否则上层会按 failed 自动重试。
  assert.equal(error.outcome, "unknown");
  assert.equal(error.dispatched, true);
  assert.match(error.message, /不是有效的 time 值/);
  assert.match(error.message, /已经写入/);
  assert.match(error.next_step, /不要直接再点/);
  act.dispose();
});

test("type 时间框 clear:false：明确报 INVALID_ARGUMENT，绝不默默整段覆盖", async () => {
  const text = '- RootWebArea "表单"\n  - InputTime "Preferred delivery time:"\n    - spinbutton "分钟 分钟" [ref=e11]';
  const { cdp, snap, state, sent } = harness({ snapshotText: text, focusScript: temporalScript({ current: "12:30" }) });
  state.refs = indexRefs(text);
  state.alive = new Set([11]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ ref: "e11", action: "type", text: "30", clear: false }).catch((caught) => caught);
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.equal(error.outcome, "failed");
  assert.equal(error.dispatched, false);
  assert.match(error.message, /clear:false/);
  assert.equal(sent.filter((item) => String(item.params.functionDeclaration ?? "").includes("setTemporalValueForAction")).length, 0, "不该写入");
  act.dispose();
});

test("type 不给 ref、焦点在时间框上：也能填（t12 问题 7）", async () => {
  const { cdp, snap, sent } = harness({ snapshotText: '- RootWebArea "表单"', focusScript: temporalScript({ value: "07:05" }) });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "type", text: "07:05" });
  assert.equal(result.focused, true);
  assert.equal(result.temporal?.value, "07:05");
  assert.equal(sent.filter((item) => item.method === "Input.insertText").length, 0);
  act.dispose();
});

test("type 时间框只给一个数字：按分段并进当前值（小时段 12 → 12:00）", async () => {
  const text = [
    '- RootWebArea "表单"',
    '  - InputTime "Preferred delivery time:"',
    '    - spinbutton "小时 小时" [ref=e11]',
    '    - spinbutton "分钟 分钟" [ref=e12]',
  ].join("\n");
  const { cdp, snap, state } = harness({ snapshotText: text, focusScript: temporalScript({ current: "12:00" }) });
  state.refs = indexRefs(text);
  state.alive = new Set([11, 12]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const hour = await act.act({ ref: "e11", action: "type", text: "12" });
  assert.equal(hour.temporal?.value, "12:00");
  const minute = await act.act({ ref: "e12", action: "type", text: "30" });
  assert.equal(minute.temporal?.value, "12:30");
  act.dispose();
});

test("type 不给 ref、焦点在时间框上只给数字：也能并进当前值", async () => {
  const { cdp, snap } = harness({ snapshotText: '- RootWebArea "表单"', focusScript: temporalScript({ value: "12:00" }) });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "type", text: "12" });
  assert.equal(result.temporal?.value, "12:00");
  act.dispose();
});

test("click 还是必须给 ref（type 是唯一的例外）", async () => {
  const { cdp, snap } = harness({ snapshotText: '- RootWebArea "页"' });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ action: "click" }).catch((caught) => caught);
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.match(error.message, /需要 ref/);
  act.dispose();
});

test("click：旧编号不在最近一次快照里（REF_STALE）→ 重拍找回新编号再点", async () => {
  const before = '- RootWebArea "页"\n  - button "保存" [ref=e5]';
  const { cdp, snap, state } = harness({ snapshotText: before });
  // 旧编号已经从 refs 里掉了（重拍过 / 换过文档），新编号在
  state.text = '- RootWebArea "页"\n  - button "保存" [ref=e8]';
  state.refs = indexRefs(state.text);
  state.alive = new Set([8]);
  const resolvedNodes = [];
  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId, extra) => {
    if (method === "DOM.resolveNode") resolvedNodes.push(params.backendNodeId);
    return originalSend(method, params, sessionId, extra);
  };
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  // 假 CDP 做不了命中测试，点击最后会失败在 ACT_FAILED；要验的是「重拍 + 用新编号重试」这一段
  const outcome = await act.act({ ref: "e5", action: "click" }).catch((caught) => caught);
  assert.equal(state.snapshots, 1, "应该重拍了一次快照");
  assert.deepEqual(resolvedNodes, [8], "重试时用的是新编号 e8 对应的节点");
  assert.equal(outcome.code, "ACT_FAILED", "点击失败在命中测试（假 CDP 没有布局），不是编号失效");
  act.dispose();
});

/* ---------------- ⑧½ 点击弹出对话框：立刻按 DIALOG_OPEN 结算，且算作「事件已发出」 ---------------- */

test("动作触发 alert：Input 命令报 DIALOG_OPEN 时按 dispatched 上报，不重试", async () => {
  const text = '- RootWebArea "JavaScript Alerts"';
  const { cdp, snap, state } = harness({ snapshotText: text });
  const dialog = { type: "alert", message: "I am a JS Alert", defaultPrompt: "" };
  const originalSend = cdp.send.bind(cdp);
  let keys = 0;
  cdp.send = async (method, params, sessionId, extra) => {
    if (String(method).startsWith("Input.dispatchKeyEvent")) {
      keys += 1;
      // 真机：回车触发 onkeydown 里的 alert，输入命令的 ack 被对话框压住，适配层用 DIALOG_OPEN 结算
      const error = new Error("页面弹出了对话框，这次动作不再等鼠标事件的返回");
      Object.assign(error, { code: "DIALOG_OPEN", dialog, method });
      throw error;
    }
    return originalSend(method, params, sessionId, extra);
  };
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const started = Date.now();
  const error = await act.act({ action: "key", key: "Enter" }).catch((caught) => caught);
  assert.equal(error.code, "DIALOG_OPEN");
  assert.equal(error.dialog?.type, "alert");
  assert.equal(error.dialog?.message, "I am a JS Alert");
  assert.equal(error.outcome, "unknown", "动作结果要看对话框的返回值");
  assert.equal(error.dispatched, true, "对话框弹出说明事件已经发出去了，调用方不能再自动重试");
  assert.match(error.next_step, /action:"dialog"/);
  assert.equal(state.snapshots, 0, "对话框开着时不要重拍快照");
  assert.ok(Date.now() - started < 1_000, `应该立即返回，实际等了 ${Date.now() - started}ms`);
  assert.ok(keys > 0, "键盘事件确实发过（只是 ack 被对话框压住了）");
  act.dispose();
});

/* ---------------- ⑨ 提交边界只拦点击类动作 ---------------- */

test("提交边界：点「发布」没带 confirm 时返回 NEEDS_CONFIRM，一个事件都不发", async () => {
  const text = '- RootWebArea "页"\n  - button "发布" [ref=e5]';
  const { cdp, snap, state, sent } = harness({ snapshotText: text });
  state.refs = indexRefs(text);
  state.alive = new Set([5]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const error = await act.act({ ref: "e5", action: "click" }).catch((caught) => caught);
  assert.equal(error.code, "NEEDS_CONFIRM");
  assert.equal(error.outcome, "failed");
  assert.equal(error.dispatched, false);
  assert.equal(sent.filter((item) => String(item.method).startsWith("Input.")).length, 0, "事件一个都不发");
  act.dispose();
});

test("提交边界：往「删除原因」输入框里打字不拦（type 不套提交边界）", async () => {
  // 不给 ref 的 type 走焦点元素路径：目标名就是焦点输入框的名字（命中「删除」关键词）
  const { cdp, snap, sent } = harness({ snapshotText: '- RootWebArea "页"', focusName: "删除原因" });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ action: "type", text: "内容不合适" });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "dispatched", "写值已经派发，但没有 expect 只能算 dispatched");
  assert.ok(sent.some((item) => item.method === "Input.insertText"));
  act.dispose();
});

test("提交边界：导航标签「发布设置」不拦", async () => {
  const text = '- RootWebArea "页"\n  - link "发布设置" [ref=e7]';
  const { cdp, snap, state } = harness({ snapshotText: text });
  state.refs = indexRefs(text);
  state.alive = new Set([7]);
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await act.act({ ref: "e7", action: "click" }).catch((caught) => caught);
  assert.notEqual(result.code, "NEEDS_CONFIRM");
  act.dispose();
});

test("提交边界：key + Enter 用所在 form 的提交按钮名判断", async () => {
  const text = '- RootWebArea "页"\n  - textbox "说明" [ref=e3]';
  const cases = [
    { submitName: "发布", key: "Enter", blocked: true },
    { submitName: "保存草稿", key: "Enter", blocked: false },
    { submitName: "发布", key: "Tab", blocked: false },
  ];
  for (const item of cases) {
    const { cdp, snap, state, sent } = harness({ snapshotText: text });
    state.refs = indexRefs(text);
    state.alive = new Set([3]);
    const originalSend = cdp.send.bind(cdp);
    cdp.send = async (method, params, sessionId, extra) => {
      if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration ?? "").includes("querySelectorAll")) {
        return { result: { value: item.submitName } };
      }
      return originalSend(method, params, sessionId, extra);
    };
    const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
    const result = await act.act({ ref: "e3", action: "key", key: item.key }).catch((caught) => caught);
    if (item.blocked) {
      assert.equal(result.code, "NEEDS_CONFIRM", `${item.key} + 「${item.submitName}」应该拦`);
      assert.equal(sent.filter((entry) => String(entry.method).startsWith("Input.")).length, 0);
    } else {
      assert.equal(result.ok, true, `${item.key} + 「${item.submitName}」不该拦`);
    }
    act.dispose();
  }
});
