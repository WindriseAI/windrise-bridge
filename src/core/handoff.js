/**
 * 控制权交接：每个空间一个状态，AI ⇄ 人 之间的接管、交还、审批都走这里。
 *
 * 设计取舍：
 *   - 纯函数：不碰浏览器、不读文件、不记日志，单测直接调；
 *   - 状态是「空间级」的：人在一个空间里接管，不影响同一个格子的其它空间；
 *   - 交还时不做「假设页面没变」：调用方重新拍快照，用 summarizeSnapshotChange 给变更摘要；
 *   - 审计事件只有三种一等类型（handoff / return / approval），字段固定，方便事后筛选。
 *
 * 状态机（只有下面这些箭头是合法的）：
 *
 *   ai_running ⇄ awaiting_approval
 *   ai_running  → needs_help / human_control / paused
 *   awaiting_approval → needs_help / human_control / paused
 *   needs_help  → human_control / paused / returning
 *   human_control → returning / paused
 *   paused      → ai_running / human_control / returning
 *   returning   → ai_running
 *
 * `returning` 是一个过渡态：人已经把控制权还回来，但 AI 还没重新观察页面。
 * 下一次 page_* 调用先拍快照、给出变更摘要，再把状态切回 ai_running —— 摘要只给一次。
 */

/** 六个控制权状态。字符串会进 space_list 和审计日志，改名要同时改老数据。 */
export const CONTROL_STATES = Object.freeze({
  AI_RUNNING: "ai_running",
  AWAITING_APPROVAL: "awaiting_approval",
  NEEDS_HELP: "needs_help",
  PAUSED: "paused",
  HUMAN_CONTROL: "human_control",
  RETURNING: "returning",
});

const { AI_RUNNING, AWAITING_APPROVAL, NEEDS_HELP, PAUSED, HUMAN_CONTROL, RETURNING } = CONTROL_STATES;

export const CONTROL_STATE_LABELS = Object.freeze({
  ai_running: "AI 运行中",
  awaiting_approval: "等待批准",
  needs_help: "需要人处理",
  paused: "已暂停",
  human_control: "人正在控制",
  returning: "交还中",
});

/** 状态 → 允许的下一跳（同状态视为幂等，另外判）。 */
const NEXT_STATES = Object.freeze({
  [AI_RUNNING]: Object.freeze([AWAITING_APPROVAL, NEEDS_HELP, HUMAN_CONTROL, PAUSED]),
  [AWAITING_APPROVAL]: Object.freeze([AI_RUNNING, NEEDS_HELP, HUMAN_CONTROL, PAUSED]),
  [NEEDS_HELP]: Object.freeze([HUMAN_CONTROL, PAUSED, RETURNING]),
  [PAUSED]: Object.freeze([AI_RUNNING, HUMAN_CONTROL, RETURNING]),
  [HUMAN_CONTROL]: Object.freeze([RETURNING, PAUSED]),
  [RETURNING]: Object.freeze([AI_RUNNING]),
});

const STATE_SET = new Set(Object.values(CONTROL_STATES));

/** 这些状态下 AI 的写操作一律拒绝（读操作照常）。needs_help 也算：AI 已经请人处理了，不能自己接着写。 */
export const WRITE_BLOCKED_STATES = Object.freeze([NEEDS_HELP, PAUSED, HUMAN_CONTROL]);

/**
 * 审计事件类型。交接 / 审批和空间自动收摊都是一等事件，不埋进 tool call 里。
 * space_auto_close / space_auto_discard 只记空间名、原因和标签页数量，不记网址和页面内容。
 */
export const AUDIT_EVENT_TYPES = Object.freeze(["handoff", "return", "approval", "space_auto_close", "space_auto_discard"]);

const MAX_OBSERVATION_TEXT = 20_000;
const MAX_ELEMENT_LINES = 5;
const MAX_LINE_CHARS = 160;

export function isControlState(state) {
  return STATE_SET.has(String(state ?? ""));
}

/**
 * 这一步转换合法吗。from 为空按初始状态 ai_running 处理。
 * 同状态 → 同状态允许（幂等：重复的 handoff / 重复的允许不应该把调用打挂）。
 */
export function canTransition(from, to) {
  const current = from === undefined || from === null || from === "" ? AI_RUNNING : String(from);
  const next = String(to ?? "");
  if (!isControlState(current) || !isControlState(next)) return false;
  if (current === next) return true;
  return NEXT_STATES[current].includes(next);
}

function controlError(message, code = "INVALID_CONTROL_STATE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 新空间的初始控制状态（AI 可以干活）。 */
export function createControl({ at = Date.now(), by = null } = {}) {
  return {
    state: AI_RUNNING,
    since: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
    reason: "",
    message: "",
    by,
    before: null,
  };
}

/**
 * 走一步状态机，返回新的 control 对象（不改入参）。
 *
 * @param {object|null} control 现有 control（可为空 = ai_running）
 * @param {string} nextState
 * @param {{at?: number, reason?: string, message?: string, by?: string|null, before?: object|null}} [options]
 */
export function transitionControl(control, nextState, options = {}) {
  const { at = Date.now(), reason = "", message = "", by = null, before } = options;
  const current = control?.state ?? AI_RUNNING;
  const next = String(nextState ?? "");
  if (!isControlState(next)) throw controlError(`不认识的控制权状态：${next || "(空)"}`);
  if (!canTransition(current, next)) {
    throw controlError(`控制权不能从「${CONTROL_STATE_LABELS[current] ?? current}」直接变成「${CONTROL_STATE_LABELS[next] ?? next}」`);
  }
  const hasBefore = Object.prototype.hasOwnProperty.call(options, "before");
  return {
    state: next,
    since: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
    reason: String(reason ?? ""),
    message: String(message ?? ""),
    by: by ?? null,
    before: hasBefore ? (before ?? null) : (control?.before ?? null),
  };
}

/**
 * AI 说「交给用户」时落到哪个状态：
 *   - 说「暂停」→ paused；
 *   - 说「登录 / 扫码 / 验证码 / 支付 / 授权」这类要人做一步的事 → needs_help；
 *   - 其余（整段交给用户）→ human_control。
 *
 * 为什么用关键词而不是再加一个 mode 参数：交接请求本来就带原因，原因才是判断依据；
 * 加参数会让模型多一个容易填错的东西。
 */
export function resolveHandoffState({ reason = "", message = "" } = {}) {
  const text = `${reason} ${message}`;
  if (/暂停|先停|停一下|等一下|pause|hold on|稍后继续/i.test(text)) return PAUSED;
  if (/登录|登入|扫码|二维码|验证码|密码|人脸|指纹|人机|二次验证|双因素|短信|邮件验证|授权|支付|付款|captcha|2fa|mfa|sign.?in|log.?in|password|verification|otp/i.test(text)) {
    return NEEDS_HELP;
  }
  return HUMAN_CONTROL;
}

/** 观测结果里要看的「是否已登录」：只认明显的标记，认不出就 unknown，不猜。 */
export function detectLoginState({ url = "", title = "", text = "" } = {}) {
  const head = `${url}\n${title}`;
  const body = String(text ?? "").slice(0, 4000);
  const all = `${head}\n${body}`;
  if (/退出登录|退出账号|注销|个人中心|我的账户|我的账号|sign out|log out|logout|my account|account settings/i.test(all)) return "logged_in";
  if (/扫码登录|密码登录|验证码登录|请登录|登录后|立即登录|登录\/注册|sign in|log in|log.?in|create account|sign up|注册|forgot password|忘记密码/i.test(all)) return "logged_out";
  if (/\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(url)) return "logged_out";
  return "unknown";
}

export const LOGIN_STATE_LABELS = Object.freeze({
  logged_in: "已登录",
  logged_out: "未登录 / 登录页",
  unknown: "看不出来",
});

/** 把一次页面观察收成可比较的形状。text 只留前 20000 字，够看元素变化。 */
export function createObservation({ url = "", title = "", text = "", at = Date.now() } = {}) {
  const clipped = String(text ?? "").slice(0, MAX_OBSERVATION_TEXT);
  return {
    url: String(url ?? ""),
    title: String(title ?? ""),
    text: clipped,
    login: detectLoginState({ url, title, text: clipped }),
    at: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
  };
}

/** 快照正文里的可操作元素行：`- button "发送" [ref=e12]` 这种。 */
function elementLines(text) {
  const lines = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    lines.add(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  }
  return lines;
}

/**
 * 交接前快照 vs 现在：URL / 标题 / 新出现和消失的主要元素 / 登录状态。
 * 没有交接前快照时如实说「无法确认」，绝不假装页面没变。
 */
export function summarizeSnapshotChange(before, after) {
  const current = after ? createObservation(after) : null;
  if (!before || !current) {
    return {
      comparable: false,
      note: before ? "现在页面读不到（标签页可能关着），无法确认改了什么" : "没有交接前快照，无法确认页面改了什么",
      url: current?.url ?? "",
      title: current?.title ?? "",
      urlChanged: false,
      titleChanged: false,
      beforeUrl: before?.url ?? "",
      beforeTitle: before?.title ?? "",
      login: current?.login ?? "unknown",
      beforeLogin: before?.login ?? "unknown",
      loginChanged: false,
      appeared: [],
      disappeared: [],
      appearedCount: 0,
      disappearedCount: 0,
    };
  }
  const previous = createObservation(before);
  const beforeLines = elementLines(previous.text);
  const afterLines = elementLines(current.text);
  const appearedAll = [...afterLines].filter((line) => !beforeLines.has(line));
  const disappearedAll = [...beforeLines].filter((line) => !afterLines.has(line));
  return {
    comparable: true,
    note: "",
    url: current.url,
    title: current.title,
    beforeUrl: previous.url,
    beforeTitle: previous.title,
    urlChanged: previous.url !== current.url,
    titleChanged: previous.title !== current.title,
    login: current.login,
    beforeLogin: previous.login,
    loginChanged: previous.login !== current.login && current.login !== "unknown",
    appeared: appearedAll.slice(0, MAX_ELEMENT_LINES),
    disappeared: disappearedAll.slice(0, MAX_ELEMENT_LINES),
    appearedCount: appearedAll.length,
    disappearedCount: disappearedAll.length,
  };
}

/** 给人 / AI 看的简短摘要。第一行固定标记，方便工具返回把它放在最前面。 */
export function describeChangeSummary(summary, { spaceName = "" } = {}) {
  const lines = ["【交还变更摘要】"];
  if (spaceName) lines.push(`空间：${spaceName}`);
  if (!summary || summary.comparable === false) {
    lines.push(summary?.note || "没有交接前快照，无法确认页面改了什么");
    return lines.join("\n");
  }
  lines.push(`现在页面：${summary.url || "(未知地址)"}${summary.title ? `（${summary.title}）` : ""}`);
  if (summary.urlChanged) lines.push(`地址变了：${summary.beforeUrl || "(空)"} → ${summary.url || "(空)"}`);
  if (summary.titleChanged) lines.push(`标题变了：${summary.beforeTitle || "(空)"} → ${summary.title || "(空)"}`);
  if (summary.loginChanged) {
    lines.push(`登录状态：${LOGIN_STATE_LABELS[summary.beforeLogin] ?? summary.beforeLogin} → ${LOGIN_STATE_LABELS[summary.login] ?? summary.login}`);
  }
  if (summary.appearedCount) {
    const more = summary.appearedCount > summary.appeared.length ? `（共 ${summary.appearedCount} 个，只列前 ${summary.appeared.length} 个）` : "";
    lines.push(`新出现的主要元素${more}：`);
    for (const line of summary.appeared) lines.push(`  ${line}`);
  }
  if (summary.disappearedCount) {
    const more = summary.disappearedCount > summary.disappeared.length ? `（共 ${summary.disappearedCount} 个，只列前 ${summary.disappeared.length} 个）` : "";
    lines.push(`消失的主要元素${more}：`);
    for (const line of summary.disappeared) lines.push(`  ${line}`);
  }
  if (!summary.urlChanged && !summary.titleChanged && !summary.loginChanged && !summary.appearedCount && !summary.disappearedCount) {
    lines.push("页面没有明显变化。");
  }
  return lines.join("\n");
}

/** 工具返回：把交还摘要放在正文最前面（只在那一次调用带 summary 时）。 */
export function prefixReturnSummary(text, summary) {
  const note = summary?.text;
  if (!note) return text;
  return `${note}\n\n${text}`;
}

/**
 * 审计事件（一等事件）：type=handoff|return|approval|space_auto_close|space_auto_discard、
 * space、from、to、reason、时间；自动收摊事件额外带 tabs（关掉 / 卸载了几个标签页）。
 * 时间用 ISO 字符串，和 call-log 的 at 同一个格式。
 */
export function createAuditEvent({ type, space, from = null, to = null, reason = "", at = new Date(), tabs = null } = {}) {
  if (!AUDIT_EVENT_TYPES.includes(String(type ?? ""))) {
    const error = new Error(`审计事件类型只能是 ${AUDIT_EVENT_TYPES.join(" / ")}，收到：${type ?? "(空)"}`);
    error.code = "INVALID_AUDIT_EVENT";
    throw error;
  }
  const spaceText = String(space ?? "").trim();
  if (!spaceText) {
    const error = new Error("审计事件必须带 space（空间 id 或名字）");
    error.code = "INVALID_AUDIT_EVENT";
    throw error;
  }
  let when;
  try {
    when = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  } catch {
    when = new Date().toISOString();
  }
  const count = tabs === undefined || tabs === null ? Number.NaN : Number(tabs);
  return {
    type: String(type),
    space: spaceText.slice(0, 64),
    from: from === undefined || from === null ? null : String(from),
    to: to === undefined || to === null ? null : String(to),
    reason: String(reason ?? "").slice(0, 240),
    at: when,
    ...(Number.isFinite(count) && count >= 0 ? { tabs: count } : {}),
  };
}
