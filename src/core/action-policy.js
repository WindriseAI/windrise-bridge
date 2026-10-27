/**
 * 写操作闸门：动作分级、结果三态、提交边界、已达成状态判定。
 *
 * 背景：云端模型「以为没成功」又点一次 → 抖音 / 小红书重复发布。参考 Skyvern 的
 * browser_action_policy，只借设计（动作分级 + 提交边界 + 结果三态），实现自己写。
 *
 * 这里全是纯函数：不碰 CDP、不读文件、不记日志，单测直接调。
 */

/** 动作分级。未知动作按 MUTATING 处理 —— 宁可多问一句，不可重复发布。 */
export const ACTION_CLASSES = Object.freeze({
  BENIGN: "BENIGN",
  READ: "READ",
  NAVIGATION: "NAVIGATION",
  MUTATING: "MUTATING",
});

/** MUTATING 的四种结果。没发事件才可能是 failed；发了事件但拿不到证据最多是 dispatched。 */
export const OUTCOMES = Object.freeze({
  CONFIRMED: "confirmed",
  DISPATCHED: "dispatched",
  UNKNOWN: "unknown",
  FAILED: "failed",
});

const { BENIGN, READ, NAVIGATION, MUTATING } = ACTION_CLASSES;

/** 动作名 → 分级。键都写成小写 + 下划线，查表前统一规范化。 */
const ACTION_CLASS_TABLE = new Map([
  // 只是看 / 挪：不改页面数据
  ["scroll", BENIGN],
  ["hover", BENIGN],
  ["screenshot", BENIGN],
  ["wait", BENIGN],
  // 聚焦不写数据，也不提交任何东西
  ["focus", BENIGN],
  // 只读
  ["snapshot", READ],
  ["read", READ],
  ["find", READ],
  ["extract", READ],
  // 换地址：不产生业务写操作
  ["navigate", NAVIGATION],
  ["goto", NAVIGATION],
  ["back", NAVIGATION],
  ["forward", NAVIGATION],
  ["reload", NAVIGATION],
  // 会改页面 / 改业务状态
  ["click", MUTATING],
  ["double_click", MUTATING],
  ["type", MUTATING],
  ["fill", MUTATING],
  ["select", MUTATING],
  ["check", MUTATING],
  ["uncheck", MUTATING],
  ["press", MUTATING],
  ["key", MUTATING],
  ["upload", MUTATING],
  ["set_files", MUTATING],
  ["setfiles", MUTATING],
  ["drag", MUTATING],
  ["drag_and_drop", MUTATING],
  ["draganddrop", MUTATING],
  ["submit", MUTATING],
  // 处理 JS 对话框：确认一个 confirm / prompt 可能真的提交业务动作（「确认删除？」「确定付款？」），
  // 所以按 MUTATING 走闸门，拿得到 outcome 三态；取消也一样（取消本身也可能是个写操作）。
  ["dialog", MUTATING],
]);

/**
 * 动作分级。不认识的动作（拼错、新动作）一律 MUTATING：
 * 这是整套闸门的默认安全方向。
 */
export function classifyAction(action) {
  const key = String(action ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ACTION_CLASS_TABLE.get(key) ?? MUTATING;
}

/** 工具名 → 这次调用的动作分级；不认识的工具返回 null（不进审计，也不套闸门）。 */
const TOOL_CLASS = new Map([
  ["page_act", (args) => classifyAction(args?.action)],
  ["browser_nav", (args) => classifyAction(args?.action)],
  ["browser_click", () => MUTATING],
  ["browser_type", () => MUTATING],
  ["page_snapshot", () => READ],
  ["page_choose", () => READ],
  ["page_read", () => READ],
  ["browser_snapshot", () => READ],
  ["browser_screenshot", () => READ],
  ["browser_wait", () => BENIGN],
]);

export function classifyToolCall(tool, args = {}) {
  const resolve = TOOL_CLASS.get(String(tool ?? ""));
  return resolve ? resolve(args) : null;
}

/**
 * 提交边界关键词：命中就要求调用方显式 confirm。
 * 可配置 —— 调用方可以传自己的表（例如自家后台的「发布到公众号」按钮叫「群发」）。
 */
export const DEFAULT_COMMIT_KEYWORDS = Object.freeze([
  "发布", "发表", "提交", "确认支付", "立即购买", "付款", "删除", "授权",
  "Publish", "Submit", "Pay", "Delete", "Buy",
]);

/**
 * 提交边界的排除词：目标名里带这些词的，基本都是导航标签 / 入口页，不是提交按钮
 * （「发布设置」「发布管理」「发布记录」……）。可配置。
 */
export const DEFAULT_COMMIT_EXCLUDES = Object.freeze([
  "设置", "管理", "记录", "列表", "中心", "指南", "帮助", "settings", "history",
]);

/**
 * 目标名超过这么多字符就不当提交按钮：长名字多半是整块卡片 / 说明文字，
 * 命中「发布」只是顺带提到，真按钮名一般很短。
 */
export const COMMIT_TARGET_MAX_CHARS = 12;

/**
 * 只有点击类动作会真的提交：click / double_click，以及 key 且按键是 Enter
 * （回车可能提交表单）。type / select / check / focus / hover 一律不套提交边界 ——
 * 往「删除原因」这种输入框里打字不该被拦。
 */
export function needsCommitGate(action, key = "") {
  const name = String(action ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (name === "click" || name === "double_click") return true;
  if (name === "key") {
    const pressed = String(key ?? "").trim().toLowerCase();
    return pressed === "enter" || pressed === "numpadenter";
  }
  return false;
}

/** 目标名是不是排除项：太长，或者带排除词（导航标签 / 入口页）。 */
export function isCommitExcluded(target, excludes = DEFAULT_COMMIT_EXCLUDES, maxChars = COMMIT_TARGET_MAX_CHARS) {
  const text = String(target ?? "").trim().toLowerCase();
  if (!text) return false;
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.floor(Number(maxChars))) : COMMIT_TARGET_MAX_CHARS;
  if (text.length > limit) return true;
  for (const word of excludes) {
    const needle = String(word ?? "").trim().toLowerCase();
    if (needle && text.includes(needle)) return true;
  }
  return false;
}

/**
 * 目标名字里命中哪个关键词；没命中返回 null。大小写不敏感，按子串匹配。
 * 命中排除项（太长 / 导航词）就当没命中：宁可少拦，不可把「发布设置」当成发布。
 */
export function matchCommitKeyword(target, keywords = DEFAULT_COMMIT_KEYWORDS, excludes = DEFAULT_COMMIT_EXCLUDES, maxChars = COMMIT_TARGET_MAX_CHARS) {
  const text = String(target ?? "").trim().toLowerCase();
  if (!text || isCommitExcluded(text, excludes, maxChars)) return null;
  for (const keyword of keywords) {
    const needle = String(keyword ?? "").trim().toLowerCase();
    if (needle && text.includes(needle)) return String(keyword);
  }
  return null;
}

/**
 * 提交边界判定，编译成一段能直接注入页面的函数源码（browser_click 的旧路径在页面里判断，
 * 避免多一次往返）。规则和 matchCommitKeyword 完全一致：太长 / 带排除词都不算。
 */
export function commitBoundaryCheckSource({
  keywords = DEFAULT_COMMIT_KEYWORDS,
  excludes = DEFAULT_COMMIT_EXCLUDES,
  maxChars = COMMIT_TARGET_MAX_CHARS,
} = {}) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.floor(Number(maxChars))) : COMMIT_TARGET_MAX_CHARS;
  return `((label) => {
    const text = String(label ?? "").trim();
    if (!text || text.length > ${limit}) return false;
    const lower = text.toLowerCase();
    const excluded = ${JSON.stringify(excludes.map((word) => String(word ?? "").trim().toLowerCase()).filter(Boolean))};
    if (excluded.some((word) => lower.includes(word))) return false;
    const keywords = ${JSON.stringify(keywords.map((word) => String(word ?? "").trim().toLowerCase()).filter(Boolean))};
    return keywords.some((word) => lower.includes(word));
  })`;
}

/**
 * 结果三态判定（其实是四种：failed / dispatched / unknown / confirmed）。
 *
 *   dispatched=false                → failed（事件没发出去，可以按原参数重试）
 *   dispatched=true 且 error         → unknown（可能已生效，禁止自动重试）
 *   dispatched=true 且读到 expect    → confirmed
 *   dispatched=true 且没有 expect    → dispatched（不许说成功）
 */
export function decideOutcome({ dispatched = false, error = null, expectSatisfied = null } = {}) {
  if (!dispatched) return { outcome: OUTCOMES.FAILED, dispatched: false };
  if (error) return { outcome: OUTCOMES.UNKNOWN, dispatched: true };
  if (expectSatisfied === true) return { outcome: OUTCOMES.CONFIRMED, dispatched: true };
  return { outcome: OUTCOMES.DISPATCHED, dispatched: true };
}

/** 每种结果给模型的一句话下一步。 */
export const OUTCOME_NEXT_STEP = Object.freeze({
  confirmed: "动作已经生效，并读到了 expect 指定的结果，可以继续下一步",
  dispatched: "事件已经发出，但没有 expect 佐证：先 page_snapshot / page_read 读回确认，再决定要不要再点",
  unknown: "动作可能已生效，先 page_snapshot / page_read 读回确认，不要直接再点",
  failed: "动作没有发到页面，可以按原参数重试；先 page_snapshot 看页面有没有变",
});

/** 提交边界被拦下时给模型的话：这一句要能直接照着做。 */
export const CONFIRM_NEXT_STEP = "这是不可撤销的提交动作。先向用户确认，确认后带 confirm:true 重试";

/**
 * 提交边界拦截的返回体：调用方（surface-act / browser-control）把它挂到错误的 details 上，
 * 最后原样进 structuredContent。
 */
export function confirmRequired({ target, keyword = null } = {}) {
  return {
    code: "NEEDS_CONFIRM",
    reason: "commit_boundary",
    target: String(target ?? ""),
    keyword,
    retryable: true,
    next_step: CONFIRM_NEXT_STEP,
  };
}

/**
 * expect 规范化：调用方可以给一段文字，也可以给选择器。
 *   字符串         → 等这段文字出现
 *   { text }       → 等文字
 *   { selector }   → 等元素
 *   { timeoutMs }  → 最多等多久（默认 3000，夹在 100…10000 之间）
 * 什么都没有就返回 null（= 没传 expect）。
 */
export function normalizeExpect(expect) {
  if (expect === undefined || expect === null || expect === "") return null;
  let text = "";
  let selector = "";
  let timeoutMs = 3000;
  if (typeof expect === "string") {
    text = expect;
  } else if (typeof expect === "object" && !Array.isArray(expect)) {
    text = typeof expect.text === "string" ? expect.text : "";
    selector = typeof expect.selector === "string" ? expect.selector : "";
    const asked = Number(expect.timeoutMs);
    if (Number.isFinite(asked) && asked > 0) timeoutMs = Math.min(10000, Math.max(100, Math.floor(asked)));
  }
  if (!text.trim() && !selector.trim()) return null;
  return { text, selector, timeoutMs };
}

/**
 * 注入页面里的 expect 探测表达式：有 selector 就先看元素在不在，否则看正文 / 标题里有没有这段文字。
 * 不区分大小写；任何异常都当「还没出现」，绝不让探测本身失败。
 */
export function expectProbeExpression(expect) {
  const spec = normalizeExpect(expect);
  if (!spec) return null;
  return `(() => {
    const text = ${JSON.stringify(spec.text)};
    const selector = ${JSON.stringify(spec.selector)};
    try {
      if (selector) return Boolean(document.querySelector(selector));
      if (!text) return false;
      const needle = text.toLowerCase();
      const body = String(document.body ? document.body.innerText : "");
      if (body.toLowerCase().includes(needle)) return true;
      return String(document.title || "").toLowerCase().includes(needle);
    } catch { return false; }
  })()`;
}

/**
 * 已经是目标状态就不发事件：
 *   check / uncheck —— current 是当前勾选状态，target 是想要的；
 *   select          —— current 是当前选项表，target 是要选的值 / 显示文字。
 * 读不到状态（null）一律返回 false：宁可点一下，不猜。
 */
export function alreadyInState({ action, current = null, target = null } = {}) {
  const key = String(action ?? "").trim().toLowerCase();
  if (key === "check" || key === "uncheck") {
    if (typeof current !== "boolean" || typeof target !== "boolean") return false;
    return current === target;
  }
  if (key === "select") return selectMatches(current, target);
  return false;
}

/**
 * 下拉框当前选中的就是想要的那几项？
 * options: [{ value, label, selected }]；choices: 选项的值或显示文字。
 * 数量也要对上：多选时「想选 2 项、实际选了 3 项」不算达成。
 */
export function selectMatches(options, choices) {
  const list = Array.isArray(options) ? options : [];
  const wanted = (Array.isArray(choices) ? choices : []).map((choice) => String(choice ?? "")).filter(Boolean);
  if (!wanted.length) return false;
  const selected = list.filter((option) => option?.selected === true);
  if (selected.length !== wanted.length) return false;
  return wanted.every((choice) => selected.some((option) => String(option.value) === choice || String(option.label) === choice));
}

/** 审计里的目标名：截断 80 字，换行压成空格（日志一行一条）。 */
export function clipTarget(target, limit = 80) {
  const text = String(target ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * 审计摘要：只有 MUTATING 调用才返回，其余返回 null。
 * 绝不把输入内容写进来 —— 目标名只从结果里的可访问名取，取不到就只记选择器。
 */
export function actionAudit({ tool, args = {}, structured = null, failed = false } = {}) {
  const actionClass = classifyToolCall(tool, args);
  if (actionClass !== MUTATING) return null;
  const target = clipTarget(targetNameOf(tool, args, structured));
  const outcome = structured?.outcome ?? (failed ? OUTCOMES.FAILED : null);
  // 只有点击类动作才会被提交边界拦；往「删除原因」里打字不算踩到提交边界
  const gated = needsCommitGate(auditActionName(tool, args), args?.key);
  return {
    actionClass,
    outcome: outcome ?? null,
    target: target || null,
    commitBoundary: (gated && Boolean(matchCommitKeyword(target))) || structured?.commitBoundary === true,
  };
}

/** 审计用的动作名：page_act / browser_nav 从参数取，旧工具按工具名定死。 */
function auditActionName(tool, args) {
  if (tool === "browser_click") return "click";
  if (tool === "browser_type") return "type";
  return String(args?.action ?? "");
}

function targetNameOf(tool, args, structured) {
  if (!structured || typeof structured !== "object") return "";
  if (typeof structured.target === "string" && structured.target) return structured.target;
  if (tool === "browser_click" && typeof structured.clicked?.label === "string") return structured.clicked.label;
  if (tool === "browser_type" && typeof structured.typed?.label === "string") return structured.typed.label;
  // 兜底只认选择器：args.text 在 page_act 里是输入内容，可能含密码 / 验证码，绝不进日志
  if (typeof args?.selector === "string") return args.selector;
  return "";
}
