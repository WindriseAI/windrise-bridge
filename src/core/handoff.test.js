/**
 * 控制权交接的状态机 / 变更摘要 / 审计事件单测。
 *
 * 覆盖：
 *   ① 状态转换合法性（合法箭头、非法箭头、同状态幂等）；
 *   ② 交还摘要：URL / 标题 / 新出现和消失的元素 / 登录状态，以及没有交接前快照时如实说无法确认；
 *   ③ 摘要只放在正文最前面（prefixReturnSummary）；
 *   ④ 审计事件字段齐全（type / space / from / to / reason / at），并真的写进 call-log 的 jsonl。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AUDIT_EVENT_TYPES,
  CONTROL_STATES,
  canTransition,
  createAuditEvent,
  createControl,
  createObservation,
  describeChangeSummary,
  detectLoginState,
  prefixReturnSummary,
  resolveHandoffState,
  summarizeSnapshotChange,
  transitionControl,
} from "./handoff.js";
import { createCallLog } from "./call-log.js";

/* ---------------- ① 状态机 ---------------- */

test("状态机：合法箭头全部放行", () => {
  const legal = [
    [CONTROL_STATES.AI_RUNNING, CONTROL_STATES.AWAITING_APPROVAL],
    [CONTROL_STATES.AI_RUNNING, CONTROL_STATES.NEEDS_HELP],
    [CONTROL_STATES.AI_RUNNING, CONTROL_STATES.HUMAN_CONTROL],
    [CONTROL_STATES.AI_RUNNING, CONTROL_STATES.PAUSED],
    [CONTROL_STATES.AWAITING_APPROVAL, CONTROL_STATES.AI_RUNNING],
    [CONTROL_STATES.NEEDS_HELP, CONTROL_STATES.HUMAN_CONTROL],
    [CONTROL_STATES.NEEDS_HELP, CONTROL_STATES.RETURNING],
    [CONTROL_STATES.HUMAN_CONTROL, CONTROL_STATES.RETURNING],
    [CONTROL_STATES.PAUSED, CONTROL_STATES.RETURNING],
    [CONTROL_STATES.PAUSED, CONTROL_STATES.AI_RUNNING],
    [CONTROL_STATES.RETURNING, CONTROL_STATES.AI_RUNNING],
  ];
  for (const [from, to] of legal) assert.equal(canTransition(from, to), true, `${from} → ${to}`);
});

test("状态机：非法箭头一律拒绝（不能跳过交还、不能从人控制直接回 AI）", () => {
  const illegal = [
    [CONTROL_STATES.AI_RUNNING, CONTROL_STATES.RETURNING],
    [CONTROL_STATES.HUMAN_CONTROL, CONTROL_STATES.AI_RUNNING],
    [CONTROL_STATES.RETURNING, CONTROL_STATES.HUMAN_CONTROL],
    [CONTROL_STATES.RETURNING, CONTROL_STATES.PAUSED],
    [CONTROL_STATES.NEEDS_HELP, CONTROL_STATES.AI_RUNNING],
    ["whatever", CONTROL_STATES.AI_RUNNING],
    [CONTROL_STATES.AI_RUNNING, "done"],
  ];
  for (const [from, to] of illegal) assert.equal(canTransition(from, to), false, `${from} → ${to}`);
});

test("状态机：同状态幂等（重复 handoff / 重复允许不打挂调用）", () => {
  assert.equal(canTransition(CONTROL_STATES.HUMAN_CONTROL, CONTROL_STATES.HUMAN_CONTROL), true);
  assert.equal(canTransition(undefined, CONTROL_STATES.AI_RUNNING), true);
});

test("状态机：transitionControl 返回新对象、非法转换报 INVALID_CONTROL_STATE", () => {
  const initial = createControl({ at: 1000 });
  assert.equal(initial.state, CONTROL_STATES.AI_RUNNING);
  const next = transitionControl(initial, CONTROL_STATES.NEEDS_HELP, { at: 2000, reason: "需要扫码" });
  assert.equal(next.state, CONTROL_STATES.NEEDS_HELP);
  assert.equal(next.since, 2000);
  assert.equal(next.reason, "需要扫码");
  assert.equal(initial.state, CONTROL_STATES.AI_RUNNING, "不能改入参");
  assert.throws(
    () => transitionControl({ ...next, state: CONTROL_STATES.HUMAN_CONTROL }, CONTROL_STATES.AI_RUNNING),
    (error) => error.code === "INVALID_CONTROL_STATE",
  );
});

test("交还：before 只在显式传入时改，没传就保留交接前快照", () => {
  const baseline = { url: "https://a.test/", title: "A", text: "- button \"登录\"", login: "logged_out", at: 1 };
  const returning = transitionControl({ state: "human_control", before: baseline }, "returning", { at: 5 });
  assert.deepEqual(returning.before, baseline);
  const resumed = transitionControl(returning, "ai_running", { at: 6, before: null });
  assert.equal(resumed.before, null);
});

test("handoff 状态：登录 / 验证码 / 支付进 needs_help，暂停进 paused，其余交整段 human_control", () => {
  assert.equal(resolveHandoffState({ reason: "需要扫码登录" }), CONTROL_STATES.NEEDS_HELP);
  assert.equal(resolveHandoffState({ reason: "收短信验证码" }), CONTROL_STATES.NEEDS_HELP);
  assert.equal(resolveHandoffState({ reason: "需要人确认支付" }), CONTROL_STATES.NEEDS_HELP);
  assert.equal(resolveHandoffState({ reason: "先暂停一下" }), CONTROL_STATES.PAUSED);
  assert.equal(resolveHandoffState({ reason: "页面我看不懂，交给你" }), CONTROL_STATES.HUMAN_CONTROL);
});

/* ---------------- ② 变更摘要 ---------------- */

test("登录状态：只认明显标记，认不出就是 unknown", () => {
  assert.equal(detectLoginState({ url: "https://a.test/login", title: "登录" }), "logged_out");
  assert.equal(detectLoginState({ url: "https://a.test/home", text: "欢迎，张三 退出登录" }), "logged_in");
  assert.equal(detectLoginState({ url: "https://a.test/home", text: "今天天气不错" }), "unknown");
});

test("交还摘要：URL / 标题 / 新出现和消失的元素 / 登录状态都报出来", () => {
  const before = createObservation({
    url: "https://site.test/login",
    title: "登录",
    text: '- button "登录" [ref=e1]\n- textbox "手机号" [ref=e2]',
    at: 1,
  });
  const after = createObservation({
    url: "https://site.test/home",
    title: "首页",
    text: '- button "发布" [ref=e3]\n- button "退出登录" [ref=e4]',
    at: 2,
  });
  const summary = summarizeSnapshotChange(before, after);
  assert.equal(summary.comparable, true);
  assert.equal(summary.urlChanged, true);
  assert.equal(summary.titleChanged, true);
  assert.equal(summary.loginChanged, true);
  assert.equal(summary.login, "logged_in");
  assert.equal(summary.appeared.length, 2);
  assert.ok(summary.appeared.some((line) => line.includes("发布")));
  assert.equal(summary.disappeared.length, 2);
  assert.ok(summary.disappeared.some((line) => line.includes("手机号")));
  const text = describeChangeSummary(summary, { spaceName: "整理邮件" });
  assert.match(text, /^【交还变更摘要】/);
  assert.match(text, /空间：整理邮件/);
  assert.match(text, /地址变了：https:\/\/site\.test\/login → https:\/\/site\.test\/home/);
  assert.match(text, /登录状态：未登录 \/ 登录页 → 已登录/);
  assert.match(text, /发布/);
  assert.match(text, /手机号/);
});

test("交还摘要：没有交接前快照就如实说无法确认，不假装没变", () => {
  const summary = summarizeSnapshotChange(null, createObservation({ url: "https://a.test/", text: "x" }));
  assert.equal(summary.comparable, false);
  const text = describeChangeSummary(summary);
  assert.match(text, /无法确认/);
});

test("交还摘要：页面没变就明确写没有明显变化", () => {
  const obs = createObservation({ url: "https://a.test/", title: "A", text: '- button "发送" [ref=e1]' });
  const text = describeChangeSummary(summarizeSnapshotChange(obs, { ...obs }));
  assert.match(text, /没有明显变化/);
});

test("摘要在返回正文最前面，且没有摘要时正文原样", () => {
  const text = prefixReturnSummary("页面正文", { text: "【交还变更摘要】\n现在页面：x" });
  assert.ok(text.startsWith("【交还变更摘要】"));
  assert.ok(text.endsWith("页面正文"));
  assert.equal(prefixReturnSummary("页面正文", null), "页面正文");
});

/* ---------------- ③ 审计 ---------------- */

test("审计事件：字段齐全，时间用 ISO", () => {
  assert.deepEqual([...AUDIT_EVENT_TYPES], ["handoff", "return", "approval", "space_auto_close", "space_auto_discard"]);
  const event = createAuditEvent({
    type: "handoff",
    space: "sp1",
    from: "ai_running",
    to: "needs_help",
    reason: "需要扫码登录",
    at: new Date("2026-10-27T10:00:00.000Z"),
  });
  assert.deepEqual(event, {
    type: "handoff",
    space: "sp1",
    from: "ai_running",
    to: "needs_help",
    reason: "需要扫码登录",
    at: "2026-10-27T10:00:00.000Z",
  });
  assert.throws(() => createAuditEvent({ type: "click", space: "sp1" }), (error) => error.code === "INVALID_AUDIT_EVENT");
  assert.throws(() => createAuditEvent({ type: "handoff", space: "" }), (error) => error.code === "INVALID_AUDIT_EVENT");
});

test("审计事件：真的写进 call-log 的 jsonl，字段原样可查", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "windrise-audit-"));
  try {
    const log = createCallLog({ dir });
    const event = createAuditEvent({
      type: "approval",
      space: "sp1",
      from: "awaiting_approval",
      to: "ai_running",
      reason: '放行：confirm:true 的提交动作「发布」',
      at: new Date("2026-10-27T10:00:00.000Z"),
    });
    await log.record({ event });
    const name = (await import("node:fs/promises")).readdir(dir).then((names) => names.find((file) => file.startsWith("mcp-calls-")));
    const file = path.join(dir, await name);
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const line = lines.at(-1);
    assert.equal(line.type, "approval");
    assert.equal(line.space, "sp1");
    assert.equal(line.from, "awaiting_approval");
    assert.equal(line.to, "ai_running");
    assert.match(line.reason, /放行/);
    assert.equal(line.at, "2026-10-27T10:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
