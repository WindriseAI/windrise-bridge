/**
 * 写操作闸门的纯函数单测（不需要浏览器）：
 *   node --test src/core/action-policy.test.js
 *
 * 覆盖：
 *   ① 动作分级：BENIGN / READ / NAVIGATION / MUTATING，未知动作按 MUTATING；
 *   ② 三态判定：没发事件 = failed，发了没 expect = dispatched，发了后出错 = unknown，expect 读到 = confirmed；
 *   ③ 提交边界：只拦点击类动作（needsCommitGate）、关键词命中 / 排除词 / 长度上限、可配置表；
 *   ④ already_in_state：checkbox / radio / switch、select 同一值、多选数量不一致；
 *   ⑤ 审计摘要：只有 MUTATING 才记，目标名截到 80 字，输入内容不进日志。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTION_CLASSES,
  COMMIT_TARGET_MAX_CHARS,
  DEFAULT_COMMIT_EXCLUDES,
  DEFAULT_COMMIT_KEYWORDS,
  OUTCOMES,
  OUTCOME_NEXT_STEP,
  actionAudit,
  alreadyInState,
  classifyAction,
  classifyToolCall,
  clipTarget,
  commitBoundaryCheckSource,
  confirmRequired,
  decideOutcome,
  expectProbeExpression,
  isCommitExcluded,
  matchCommitKeyword,
  needsCommitGate,
  normalizeExpect,
  selectMatches,
} from "./action-policy.js";

const { BENIGN, READ, NAVIGATION, MUTATING } = ACTION_CLASSES;

/* ---------------- ① 分类 ---------------- */

test("分类：BENIGN / READ / NAVIGATION 各就各位", () => {
  for (const action of ["scroll", "hover", "screenshot", "wait"]) {
    assert.equal(classifyAction(action), BENIGN, action);
  }
  for (const action of ["snapshot", "read", "find", "extract"]) {
    assert.equal(classifyAction(action), READ, action);
  }
  for (const action of ["navigate", "back", "forward", "reload"]) {
    assert.equal(classifyAction(action), NAVIGATION, action);
  }
});

test("分类：写操作全部 MUTATING", () => {
  for (const action of ["click", "type", "fill", "select", "check", "press", "upload", "setFiles", "drag", "double_click", "key"]) {
    assert.equal(classifyAction(action), MUTATING, action);
  }
});

test("分类：未知动作默认 MUTATING（宁可多问一句，不可重复发布）", () => {
  for (const action of ["", null, undefined, "teleport", "publish_everything"]) {
    assert.equal(classifyAction(action), MUTATING, String(action));
  }
});

test("分类：大小写 / 连字符 / 空格都能认", () => {
  assert.equal(classifyAction("  Click "), MUTATING);
  assert.equal(classifyAction("SCROLL"), BENIGN);
  assert.equal(classifyAction("double-click"), MUTATING);
  assert.equal(classifyAction("drag and drop"), MUTATING);
});

test("分类：工具调用按参数里的 action 分级；不认识的工具返回 null", () => {
  assert.equal(classifyToolCall("page_act", { action: "scroll" }), BENIGN);
  assert.equal(classifyToolCall("page_act", { action: "click" }), MUTATING);
  assert.equal(classifyToolCall("browser_click", {}), MUTATING);
  assert.equal(classifyToolCall("browser_type", {}), MUTATING);
  assert.equal(classifyToolCall("page_snapshot", {}), READ);
  // 只选不点：问 Jev 不碰页面，写操作仍然由 page_act 的闸门管
  assert.equal(classifyToolCall("page_choose", { intent: "点发布" }), READ);
  assert.equal(classifyToolCall("space_list", {}), null);
});

/* ---------------- ② 三态 ---------------- */

test("三态：事件没发出 → failed 且 dispatched:false", () => {
  const decided = decideOutcome({ dispatched: false, error: new Error("ref 找不到") });
  assert.equal(decided.outcome, OUTCOMES.FAILED);
  assert.equal(decided.dispatched, false);
});

test("三态：事件已发出但没有 expect → dispatched（不许说成功）", () => {
  const decided = decideOutcome({ dispatched: true });
  assert.equal(decided.outcome, OUTCOMES.DISPATCHED);
  assert.equal(decided.dispatched, true);
});

test("三态：事件已发出后出错 → unknown", () => {
  const decided = decideOutcome({ dispatched: true, error: new Error("页面跳转，上下文丢失") });
  assert.equal(decided.outcome, OUTCOMES.UNKNOWN);
  assert.equal(decided.dispatched, true);
});

test("三态：带 expect 且读到了 → confirmed", () => {
  const decided = decideOutcome({ dispatched: true, expectSatisfied: true });
  assert.equal(decided.outcome, OUTCOMES.CONFIRMED);
});

test("三态：expect 没读到也只能是 dispatched（不能算失败，也不能算成功）", () => {
  assert.equal(decideOutcome({ dispatched: true, expectSatisfied: false }).outcome, OUTCOMES.DISPATCHED);
  assert.equal(decideOutcome({ dispatched: true, expectSatisfied: null }).outcome, OUTCOMES.DISPATCHED);
});

test("三态：unknown 的下一步必须写「先读回确认，不要直接再点」", () => {
  assert.match(OUTCOME_NEXT_STEP.unknown, /不要直接再点/);
  assert.match(OUTCOME_NEXT_STEP.unknown, /page_snapshot/);
  assert.match(OUTCOME_NEXT_STEP.dispatched, /读回确认/);
  assert.equal(OUTCOMES.CONFIRMED, "confirmed");
  assert.equal(OUTCOMES.DISPATCHED, "dispatched");
  assert.equal(OUTCOMES.UNKNOWN, "unknown");
  assert.equal(OUTCOMES.FAILED, "failed");
});

/* ---------------- ③ 提交边界 ---------------- */

test("关键词：默认表里每个词都能命中", () => {
  for (const keyword of DEFAULT_COMMIT_KEYWORDS) {
    assert.equal(matchCommitKeyword(`确定${keyword}一下`), keyword, keyword);
  }
});

test("关键词：英文大小写不敏感", () => {
  assert.equal(matchCommitKeyword("PUBLISH NOW"), "Publish");
  assert.equal(matchCommitKeyword("Delete draft"), "Delete");
  assert.equal(matchCommitKeyword("buy now"), "Buy");
});

test("关键词：普通按钮不误伤", () => {
  for (const name of ["保存草稿", "搜索", "下一页", "取消", "Save", "Next"]) {
    assert.equal(matchCommitKeyword(name), null, name);
  }
  assert.equal(matchCommitKeyword(""), null);
  assert.equal(matchCommitKeyword(null), null);
});

test("关键词：可以换自己的表", () => {
  assert.equal(matchCommitKeyword("群发文章", ["群发"]), "群发");
  assert.equal(matchCommitKeyword("发布文章", ["群发"]), null);
});

test("关键词：导航标签（发布设置 / 发布记录…）不拦", () => {
  for (const name of ["发布设置", "发布记录", "发布管理", "发布列表", "发布中心", "发布指南", "发布帮助", "Publish settings", "publish history"]) {
    assert.equal(matchCommitKeyword(name), null, name);
  }
  // 真按钮照拦
  assert.equal(matchCommitKeyword("发布"), "发布");
  assert.equal(matchCommitKeyword("立即发布"), "发布");
});

test("关键词：目标名超过 12 个字符不拦", () => {
  assert.equal(COMMIT_TARGET_MAX_CHARS, 12);
  assert.equal(matchCommitKeyword("发布作品到小红书"), "发布", "8 个字照拦");
  assert.equal(matchCommitKeyword("发布作品到小红书首页草稿"), "发布", "12 个字是上限，照拦");
  assert.equal(matchCommitKeyword("发布作品到小红书首页草稿箱"), null, "13 个字就不拦");
  assert.equal(matchCommitKeyword("Publish this post now"), null, "英文长名字也不拦");
  assert.equal(matchCommitKeyword("Publish"), "Publish", "短英文名字照拦");
});

test("关键词：排除词表可配置", () => {
  assert.equal(matchCommitKeyword("群发助手", ["群发"], []), "群发", "不传排除词就不排除");
  assert.equal(matchCommitKeyword("群发助手", ["群发"], ["助手"]), null);
  assert.equal(isCommitExcluded("群发助手", ["助手"]), true);
  assert.equal(isCommitExcluded("群发", ["助手"]), false);
  for (const word of DEFAULT_COMMIT_EXCLUDES) {
    assert.equal(isCommitExcluded(`发布${word}`), true, word);
  }
});

test("needsCommitGate：只拦点击类动作与 Enter", () => {
  assert.equal(needsCommitGate("click"), true);
  assert.equal(needsCommitGate("double_click"), true);
  assert.equal(needsCommitGate("Double-Click"), true, "动作名规范化后也认");
  assert.equal(needsCommitGate("key", "Enter"), true);
  assert.equal(needsCommitGate("key", "enter"), true, "按键名大小写不敏感");
  assert.equal(needsCommitGate("key", "NumpadEnter"), true);
  assert.equal(needsCommitGate("key", "Tab"), false);
  assert.equal(needsCommitGate("key", "a"), false);
  assert.equal(needsCommitGate("key"), false);
  for (const action of ["type", "select", "check", "focus", "hover", "scroll"]) {
    assert.equal(needsCommitGate(action), false, action);
    assert.equal(needsCommitGate(action, "Enter"), false, `${action} 不看按键`);
  }
});

test("注入页面的判定函数：和 matchCommitKeyword 同一套规则", () => {
  const check = eval(`(${commitBoundaryCheckSource()})`);
  assert.equal(check("发布"), true);
  assert.equal(check("立即发布"), true);
  assert.equal(check("发布设置"), false);
  assert.equal(check(""), false);
  assert.equal(check(null), false);
  // 自定义表
  const custom = eval(`(${commitBoundaryCheckSource({ keywords: ["群发"], excludes: ["助手"], maxChars: 4 })})`);
  assert.equal(custom("群发"), true);
  assert.equal(custom("群发助手"), false);
  assert.equal(custom("群发文章列表"), false, "超过 maxChars 不拦");
});

test("提交边界返回体：字段和文案固定", () => {
  const body = confirmRequired({ target: "发布笔记", keyword: "发布" });
  assert.equal(body.code, "NEEDS_CONFIRM");
  assert.equal(body.reason, "commit_boundary");
  assert.equal(body.target, "发布笔记");
  assert.equal(body.retryable, true);
  assert.equal(body.next_step, "这是不可撤销的提交动作。先向用户确认，确认后带 confirm:true 重试");
});

/* ---------------- ④ 已达成状态 ---------------- */

test("already_in_state：checkbox 已经是目标状态就跳过", () => {
  assert.equal(alreadyInState({ action: "check", current: true, target: true }), true);
  assert.equal(alreadyInState({ action: "check", current: false, target: true }), false);
  assert.equal(alreadyInState({ action: "uncheck", current: false, target: false }), true);
  assert.equal(alreadyInState({ action: "uncheck", current: true, target: false }), false);
});

test("already_in_state：读不到状态时不跳过（不猜）", () => {
  assert.equal(alreadyInState({ action: "check", current: null, target: true }), false);
  assert.equal(alreadyInState({ action: "check", current: "true", target: true }), false);
});

test("already_in_state：select 选同一个值就跳过（值和显示文字都认）", () => {
  const options = [
    { value: "apple", label: "苹果", selected: false },
    { value: "banana", label: "香蕉", selected: true },
  ];
  assert.equal(alreadyInState({ action: "select", current: options, target: ["banana"] }), true);
  assert.equal(alreadyInState({ action: "select", current: options, target: ["香蕉"] }), true);
  assert.equal(alreadyInState({ action: "select", current: options, target: ["apple"] }), false);
});

test("selectMatches：多选时数量也要对上", () => {
  const options = [
    { value: "a", label: "A", selected: true },
    { value: "b", label: "B", selected: true },
    { value: "c", label: "C", selected: false },
  ];
  assert.equal(selectMatches(options, ["a", "b"]), true);
  assert.equal(selectMatches(options, ["a"]), false, "实际选了 2 项、只想 1 项：不算达成");
  assert.equal(selectMatches(options, ["a", "c"]), false);
  assert.equal(selectMatches(options, []), false);
  assert.equal(selectMatches(null, ["a"]), false);
});

/* ---------------- ⑤ 审计 ---------------- */

test("审计：只读动作不记 action 字段", () => {
  assert.equal(actionAudit({ tool: "page_snapshot", args: {} }), null);
  assert.equal(actionAudit({ tool: "page_act", args: { action: "scroll" } }), null);
  assert.equal(actionAudit({ tool: "browser_wait", args: {} }), null);
});

test("审计：写操作记 actionClass / outcome / target / commitBoundary", () => {
  const audit = actionAudit({
    tool: "page_act",
    args: { action: "click", ref: "e12" },
    structured: { outcome: "dispatched", target: "发布笔记" },
  });
  assert.deepEqual(audit, { actionClass: MUTATING, outcome: "dispatched", target: "发布笔记", commitBoundary: true });
});

test("审计：失败的写操作按 failed 记", () => {
  const audit = actionAudit({ tool: "browser_click", args: { text: "保存" }, structured: { code: "ACT_FAILED" }, failed: true });
  assert.equal(audit.outcome, "failed");
  assert.equal(audit.commitBoundary, false);
});

test("审计：绝不把输入的文本内容写进 target", () => {
  const audit = actionAudit({
    tool: "page_act",
    args: { action: "type", ref: "e3", text: "我的密码是 hunter2" },
    structured: { outcome: "dispatched" },
  });
  assert.equal(audit.target, null);
  assert.doesNotMatch(JSON.stringify(audit), /hunter2/);
});

test("审计：只有点击类动作才记 commitBoundary", () => {
  const typed = actionAudit({
    tool: "page_act",
    args: { action: "type", ref: "e3" },
    structured: { outcome: "dispatched", target: "删除原因" },
  });
  assert.equal(typed.commitBoundary, false, "往「删除原因」里打字不算踩提交边界");
  const enter = actionAudit({
    tool: "page_act",
    args: { action: "key", key: "Enter", ref: "e3" },
    structured: { outcome: "dispatched", target: "发布" },
  });
  assert.equal(enter.commitBoundary, true, "Enter 提交算");
  const tab = actionAudit({
    tool: "page_act",
    args: { action: "key", key: "Tab", ref: "e3" },
    structured: { outcome: "dispatched", target: "发布" },
  });
  assert.equal(tab.commitBoundary, false, "Tab 不算");
});

test("审计：目标名截到 80 字", () => {
  const long = "发布".repeat(100);
  assert.equal(clipTarget(long).length, 81, "80 字 + 省略号");
  assert.equal(clipTarget("  发布\n笔记  "), "发布 笔记");
  const audit = actionAudit({ tool: "page_act", args: { action: "click" }, structured: { target: long, outcome: "dispatched" } });
  assert.equal(audit.target.length, 81);
});

/* ---------------- expect 规范化 ---------------- */

test("expect：字符串 / 对象 / 空值", () => {
  assert.deepEqual(normalizeExpect("已发布"), { text: "已发布", selector: "", timeoutMs: 3000 });
  assert.deepEqual(normalizeExpect({ selector: "#done", timeoutMs: 500 }), { text: "", selector: "#done", timeoutMs: 500 });
  assert.equal(normalizeExpect(undefined), null);
  assert.equal(normalizeExpect(""), null);
  assert.equal(normalizeExpect({}), null);
  assert.equal(normalizeExpect({ text: "  " }), null);
});

test("expect：超时夹在 100…10000 之间", () => {
  assert.equal(normalizeExpect({ text: "x", timeoutMs: 1 }).timeoutMs, 100);
  assert.equal(normalizeExpect({ text: "x", timeoutMs: 999999 }).timeoutMs, 10000);
  assert.equal(normalizeExpect({ text: "x", timeoutMs: "abc" }).timeoutMs, 3000);
});

test("expect：探测表达式能执行，且不吞掉特殊字符", () => {
  const source = expectProbeExpression({ text: 'a"b\\c' });
  assert.match(source, /a\\"b/);
  assert.match(source, /innerText/);
  assert.equal(expectProbeExpression(null), null);
  assert.match(expectProbeExpression({ selector: "#done" }), /querySelector/);
});
