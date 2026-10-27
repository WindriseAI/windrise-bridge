/**
 * 浏览器控制服务 —— 让外部 Agent 能自己开窗口、点页面、填表单、截图。
 *
 * 架构：
 *   MCP 工具（Node 侧）→ 本机 HTTP + 令牌 → 这个服务 → BrowserOS 标签页外观（webContents 形状）
 *
 * 为什么走 HTTP 而不是直接在 MCP 进程里开浏览器：
 *   账号窗口只能由 Windrise 主进程通过 BrowserOS 启动。
 *   MCP 服务可能在另一个进程（甚至纯 Node 模式），所以中间要有一条通道。
 *
 * 安全：
 *   - 只绑 127.0.0.1，端口随机
 *   - 令牌放 URL 路径里（跟 Bridge 本身一个套路），错误令牌 404
 *   - 端口和令牌写到一个 0600 的文件里，MCP 工具读它来发现服务
 *   - eval 类操作默认关闭，要显式开启
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { pathToFileURL } = require("node:url");
const { AccountSurface } = require("./browseros-profiles.cjs");
const { checkSiteUrl } = require("./url-guard.cjs");
const { checkAiAccess, assertAiAllowed } = require("./ai-site-guard.cjs");
const { AgentOverlay } = require("./agent-overlay.cjs");
const { SpaceReaper } = require("./space-reaper.cjs");

/** 登录页这类「只许人操作」的页面上，AI 仍然可以做的动作：都是离开或不碰页面内容的（钉住/插件清单在插件里，也不碰页面） */
const AI_GUARD_EXEMPT = new Set(["status", "list", "open", "close", "navigate", "back", "layout", "show", "hide", "space/list", "space/open", "space/close", "space/handoff", "space/return", "pin/list", "pin/add", "pin/remove", "pin/open", "extension/list"]);

const DISCOVERY_FILE = path.join(process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"), "browser-control.json");

/** BrowserOS 账号窗口在前台时，多久查一次「系统里有没有真实键鼠输入」 */
const HUMAN_TAKEOVER_POLL_MS = 300;
/**
 * 人点「交还给 AI」之后多久内不重新判接管。
 * 为什么需要：点按钮本身也是真实键鼠输入，系统空闲时间会在 1 秒内还是 0；没有这段宽限，
 * 下一次 300ms 轮询会立刻又判人接管，「交还」等于没点。1.5 秒刚好盖过空闲时间的整秒粒度。
 */
const HUMAN_HANDBACK_GRACE_MS = 1_500;

/**
 * 系统空闲秒数：Windows 上就是 GetLastInputInfo，只认真实硬件输入，CDP 合成输入不算。
 * 做成函数是为了自测能注入假值；正常路径懒加载 electron —— 纯 Node 里 require("electron")
 * 拿到的是可执行文件路径，没有 powerMonitor，就返回 null（上层按「检测未就绪」处理）。
 */
function defaultIdleSeconds() {
  try {
    const electron = require("electron");
    const powerMonitor = electron?.powerMonitor;
    if (typeof powerMonitor?.getSystemIdleTime !== "function") return null;
    const value = Number(powerMonitor.getSystemIdleTime());
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
/** 快照、正文、差异回给 AI 的字数上限；超了截断并说明总长（落盘加句柄见派活表第 6 项） */
const PAGE_TEXT_LIMIT = 20_000;

/**
 * 覆盖层按钮防伪造的时间窗（毫秒）：AI 对这个标签页派发输入的前后各留这段宽限，
 * 落在窗内的「按钮点击」一律按 AI 自己的输入丢弃 —— CDP 合成点击 isTrusted 也是 true，
 * 不能只看 isTrusted，要靠主程序自己记的输入窗口和插件的系统焦点一起判。
 */
const OVERLAY_AI_INPUT_GRACE_MS = 500;
/** 「终止任务」状态最多持续多久（毫秒），人没点「交还给 AI」就自动清除 */
const TASK_STOPPED_TTL_MS = 30 * 60_000;

/** 语义快照和按编号动作是 ES 模块（src/core），这里按需加载一次 */
let surfaceModules = null;
function loadSurfaceModules() {
  surfaceModules ??= Promise.all([
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "surface-snapshot.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "surface-act.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "snapshot-query.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "action-policy.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "page-settle.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "upload-guard.js")).href),
    import(pathToFileURL(path.join(__dirname, "..", "src", "core", "page-fill.js")).href),
  ]).then(([snapshot, act, query, policy, settle, upload, fill]) => ({ ...snapshot, ...act, ...query, ...policy, ...settle, ...upload, ...fill }));
  return surfaceModules;
}

/** 控制权状态机 / 变更摘要 / 审计事件是纯 ES 模块，按需加载一次 */
let handoffModules = null;
function loadHandoffModules() {
  handoffModules ??= import(pathToFileURL(path.join(__dirname, "..", "src", "core", "handoff.js")).href);
  return handoffModules;
}

/** 读标签页网址；标签页已经销毁时 getURL 会抛，返回空串而不是让整个调用失败 */
function safeUrl(wc) {
  try {
    if (!wc || wc.isDestroyed?.()) return "";
    return String(wc.getURL?.() ?? "");
  } catch {
    return "";
  }
}

/** 读标签页标题，同上 */
function safeTitle(wc) {
  try {
    if (!wc || wc.isDestroyed?.()) return "";
    return String(wc.getTitle?.() ?? "");
  } catch {
    return "";
  }
}

/** 对外（MCP 返回）的控制权：不含 before 快照，那份可能两万字。 */
function publicControl(control) {
  if (!control || typeof control !== "object") return null;
  return {
    state: control.state ?? "ai_running",
    since: control.since ?? null,
    reason: control.reason ?? "",
    message: control.message ?? "",
    by: control.by ?? null,
  };
}

/** 把交还摘要挂到结果 / 错误上（工具层再把它放到正文最前面）。 */
function withReturnSummary(value, summary) {
  if (!summary || !value || typeof value !== "object") return value;
  value.returnSummary = summary;
  return value;
}

/**
 * 这个元素能不能吃文件（page_act upload 的前置判断）：file input 本身，或者包着它 / 用 label 指着它的元素。
 * 写成常量是因为判断和回读要用同一套「怎么找到那个 input」的规则，两处不能各写一份。
 */
const FILE_INPUT_PROBE = `function () {
  const isFileInput = (node) => node && String(node.tagName || "").toUpperCase() === "INPUT" && String(node.type || "").toLowerCase() === "file";
  if (isFileInput(this)) return { ok: true, kind: "file-input" };
  const nested = this.querySelector ? this.querySelector('input[type="file"]') : null;
  if (isFileInput(nested)) return { ok: true, kind: "wrapped" };
  const fromLabel = this.labels ? Array.from(this.labels).find(isFileInput) : null;
  if (isFileInput(fromLabel)) return { ok: true, kind: "label" };
  return { ok: false, tag: String(this.tagName || "").toLowerCase(), type: String(this.type || "").toLowerCase() };
}`;

/** 回读文件框里到底挂上了哪些文件：名字 + 字节数（0 字节说明浏览器没读到那个路径）。 */
const FILE_INPUT_READBACK = `function () {
  const isFileInput = (node) => node && String(node.tagName || "").toUpperCase() === "INPUT" && String(node.type || "").toLowerCase() === "file";
  let input = isFileInput(this) ? this : null;
  if (!input && this.querySelector) input = this.querySelector('input[type="file"]');
  if (!input && this.labels) input = Array.from(this.labels).find(isFileInput) || null;
  if (!input || !input.files) return null;
  return Array.from(input.files).map((file) => ({ name: file.name, size: file.size }));
}`;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clip(text, limit) {
  const value = String(text ?? "");
  return value.length <= limit ? { text: value, truncated: false, length: value.length } : { text: value.slice(0, limit), truncated: true, length: value.length };
}

/** 参数里的「一串东西」：数组原样收，字符串按逗号 / 换行拆（账号名里可能有空格，不按空白拆），空串全丢掉 */
function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，\r\n]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/**
 * 写操作闸门的字段（action-policy.js 定的三态 + 提交边界）原样带到 HTTP 返回里。
 * 只在错误对象上真的挂了这些字段时才加，别的错误返回体和以前一模一样。
 */
const GATE_FIELDS = [
  "outcome", "dispatched", "next_step", "target", "reason", "keyword", "retryable", "skipped", "dialog", "returnSummary",
  // 批量填表 / 选项候选：这些字段在错误路径上同样要带到 MCP 侧（否则 AI 拿不到可选项和逐项结果）
  "options", "optionsTotal", "optionsTruncated", "suggestions", "matchedBy", "verified", "occludedBy",
  "fields", "filled", "failed", "total", "aborted", "unverified",
];
function gateDetails(error) {
  const out = {};
  if (!error || typeof error !== "object") return out;
  for (const key of GATE_FIELDS) {
    if (error[key] !== undefined) out[key] = error[key];
  }
  return out;
}

/** 给可能挂起的调用套一层超时 —— capturePage 被遮挡时会一直挂着不返回。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超过 ${ms} 毫秒未返回`)), ms)),
  ]);
}

/**
 * 不靠 Electron 的 nativeImage 也能从 PNG 头里读出宽高（IHDR 从第 16 字节开始）。
 * 为什么需要：外部浏览器那条路上没有 nativeImage，同时端到端验收要能在纯 Node 里跑。
 */
function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 注入到页面里的辅助函数：找元素、取页面信息。 */
const PAGE_HELPERS = `
(() => {
  if (window.__bridgeHelpers?.version === 4) return;
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.name) { part += '[name="' + node.name + '"]'; parts.unshift(part); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  // 和 src/core/surface-snapshot.js 同一套规则：密码、卡号、验证码、身份证这类输入框的值不能进快照。
  const sensitiveToken = /^(password|passwd|pwd|pw|pin|cvc|cvv|cvv2|csc|otp|ssn|idcard)$/;
  const sensitiveCardToken = /^card(number|no|num|cvc)$/;
  const cardFollowTokens = ["number", "no", "num", "cvc"];
  const ccFollowTokens = ["number", "no", "num", "csc", "cvv", "cvc", "exp"];
  // 中文和其他语言没有大小写边界，仍按子串命中；拉丁词在下面按整词匹配。
  const sensitiveSubstring = /密码|密碼|口令|安全码|安全碼|交易码|交易碼|支付密码|支付密碼|验证码|驗證碼|校验码|校驗碼|卡号|卡號|身份证|身份證|パスワード|暗証番号|비밀번호|пароль|contraseñ|senha|kennwort|passwort|mot de passe/i;
  // 裸 code / 码 仍要命中（name=code 这种字段名是真验证码），但排除邮编、促销码、邀请码这些常见非密词。
  const captchaHint = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|短信码|簡訊碼|认证码|認證碼|确认码|確認碼|安全码|安全碼|交易码|交易碼|支付密码|支付密碼|(?<![a-z])(?<!zip |postal |post |promo |coupon |discount |voucher |gift |product |country |area |tracking )code(?![a-z])|passcode|(?<![a-z])pin(?![a-z])|(?<![a-z])(?:2fa|mfa|otp)(?![a-z])|authenticat|verif|one.?time|captcha|인증|コード|código(?! postal)|bestätigung|暗証番号|(?<!号|號|编|編|邀请|邀請|优惠|優惠|兑换|兌換|条形|條形|二维|二維|货|貨)码/i;
  const words = (text) => String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());
  const sensitiveText = (text) => {
    const raw = String(text ?? "");
    if (!raw) return false;
    if (sensitiveSubstring.test(raw)) return true;
    const list = words(raw);
    for (let index = 0; index < list.length; index += 1) {
      const word = list[index];
      if (sensitiveToken.test(word) || sensitiveCardToken.test(word)) return true;
      if (word === "card" && cardFollowTokens.includes(list[index + 1] || "")) return true;
      if (word === "cc" && ccFollowTokens.includes(list[index + 1] || "")) return true;
    }
    return false;
  };
  // <label> / aria-labelledby 的文字：无障碍名字之外，旧版 label() 也要用它来区分字段。
  const labelText = (el) => {
    const parts = [];
    try {
      if (el.labels) parts.push([...el.labels].map(label => label.innerText || label.textContent || "").join(" "));
    } catch {}
    try {
      const labelEl = el.closest?.("label");
      if (labelEl) parts.push(labelEl.innerText || labelEl.textContent || "");
    } catch {}
    try {
      const ids = String(el.getAttribute?.("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
      for (const id of ids) {
        const target = document.getElementById?.(id);
        if (target) parts.push(target.innerText || target.textContent || "");
      }
    } catch {}
    return parts.filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
  };
  const longDigits = (value) => /^\\d{12,}$/.test(String(value ?? "").replace(/[\\s-]/g, ""));
  const idCard = (value) => /^(?:\\d{15}|\\d{17}[\\dXx])$/.test(String(value ?? "").replace(/[\\s-]/g, ""));
  const captchaNearby = (el) => {
    const own = [
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("title"),
      el.getAttribute?.("name"),
      el.id,
    ].filter(Boolean).join(" ");
    if (captchaHint.test(own)) return true;
    const fromLabel = labelText(el);
    if (fromLabel && captchaHint.test(fromLabel)) return true;
    try {
      const parent = el.parentElement;
      if (parent) {
        // 只看紧挨着的前后两个兄弟：表单层级的兄弟里总会有「验证码」标签，全扫会误伤普通字段。
        const siblings = [el.previousElementSibling, el.nextElementSibling].filter(Boolean);
        const directText = [...(parent.childNodes || [])]
          .filter(node => node.nodeType === 3)
          .map(node => node.textContent || "")
          .join(" ");
        const text = siblings.map(sibling => sibling.innerText || sibling.textContent || "").join(" ") + " " + directText;
        if (captchaHint.test(text)) return true;
      }
    } catch {}
    return false;
  };
  const sensitive = (el) => {
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName || "")) return false;
    const type = (el.getAttribute?.("type") || el.type || "").toLowerCase();
    if (type === "password") return true;
    const autocomplete = (el.getAttribute?.("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("password") || autocomplete.includes("one-time-code") || autocomplete.includes("cc-")) return true;
    const described = ["name", "id", "aria-label", "placeholder", "title"]
      .map(name => el.getAttribute?.(name) || "").join(" ");
    if (sensitiveText((described + " " + labelText(el)).trim())) return true;
    const value = String(el.value ?? "");
    if (!value) return false;
    if (/^[\\u2022\\u25CF\\u25E6\\u26AB]+$/.test(value.trim())) return true;
    const maxLength = Number.parseInt(el.getAttribute?.("maxlength") ?? el.maxLength ?? "", 10);
    // inputmode=numeric 太常见（数量、邮编都写它），只认 maxlength 很短的拆分框。
    if (/^\\d{1,2}$/.test(value.trim()) && maxLength > 0 && maxLength <= 2) return true;
    if (longDigits(value) || idCard(value)) return true;
    // 验证码提示只对「像验证码的值」生效：手机号、带空格的文字、城市名不该因为旁边有「验证码」就被藏。
    if (/^[A-Za-z0-9]{1,8}$/.test(value.replace(/[\\s-]/g, ""))) return captchaNearby(el);
    return false;
  };
  // 按钮、勾选框的 value 是控件自己的文字/内部值，不是用户输入的敏感内容；只有文字类输入框才按「已填」显示。
  const textEntry = (el) => {
    if (el.tagName === "TEXTAREA") return true;
    const type = (el.getAttribute?.("type") || el.type || "text").toLowerCase();
    return !["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"].includes(type);
  };
  const identifier = (el) => {
    const value = String(el.value ?? "");
    for (const candidate of [el.getAttribute?.("aria-label"), el.getAttribute?.("placeholder"), el.getAttribute?.("title")]) {
      if (!candidate) continue;
      // title 可能和值一模一样（设计器把 CVC 写进 title），别把值当标签报出去。
      if (value && (candidate === value || (value.length >= 3 && candidate.includes(value)))) continue;
      return candidate;
    }
    const fromLabels = labelText(el);
    if (fromLabels) return fromLabels.slice(0, 60);
    return el.tagName.toLowerCase();
  };
  const label = (el) => {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (textEntry(el)) {
        const value = String(el.value ?? "");
        const name = identifier(el);
        if (!value) return name;
        return sensitive(el) ? name + "（已填）" : name + "（已填 " + value.length + " 字）";
      }
      const text = el.getAttribute?.("aria-label") || el.getAttribute?.("placeholder") || el.getAttribute?.("title");
      if (text) return text;
      const type = (el.getAttribute?.("type") || el.type || "").toLowerCase();
      if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(type) && el.value) return String(el.value).slice(0, 60);
      return el.innerText?.trim().slice(0, 60) || el.tagName.toLowerCase();
    }
    const text = el.getAttribute?.("aria-label") || el.getAttribute?.("placeholder") || el.getAttribute?.("title");
    if (text) return text;
    return el.innerText?.trim().slice(0, 60) || el.value?.slice(0, 60) || el.tagName.toLowerCase();
  };
  const byText = (text) => {
    const needle = String(text).trim().toLowerCase();
    const all = [...document.querySelectorAll("a, button, input[type=submit], input[type=button], [role=button], [role=link], label, summary, [onclick]")];
    const hit = all.find(el => visible(el) && (el.innerText || el.value || "").trim().toLowerCase().includes(needle));
    return hit || null;
  };
  window.__bridgeHelpers = {
    version: 4,
    visible, cssPath, label, byText,
    // 敏感框判断（覆盖层标签要用：密码框只显示 ••••）；老页面没有这个字段，调用方自己兜底
    sensitive,
    find(selector) {
      if (!selector) return null;
      try { return document.querySelector(selector); } catch { return null; }
    },
    locate(selector, text) {
      if (text) return byText(text);
      return this.find(selector);
    },
    outline() {
      const nodes = [...document.querySelectorAll("a, button, input, select, textarea, [role=button], [role=link], [contenteditable=true]")];
      return nodes.filter(visible).slice(0, 120).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        name: el.getAttribute("name") || null,
        label: label(el),
        selector: cssPath(el),
        disabled: Boolean(el.disabled),
      }));
    },
  };
})();
`;

/**
 * 账号窗口「人接管」检测（BrowserOS 专用）。
 *
 * 为什么不能只看输入事件：BrowserOS 的标签页是我们包出来的外观，Electron 的 input-event / focus
 * 根本不会发（browseros-tab.cjs 里 isFocused() 恒 false），所以只能靠插件和系统空闲时间。
 * 这里用两个 CDP 伪造不了的信号同时成立才判：
 *   1. 插件报「这个账号窗口拿到了系统焦点」（chrome.windows.onFocusChanged / getLastFocused）；
 *   2. powerMonitor.getSystemIdleTime() === 0（1 秒内系统里有真实键鼠输入）。
 * CDP 的 Input.dispatch* 不会把窗口变成前台，也不算进系统空闲时间，所以 AI 自己动手不会误判。
 *
 * 只做判断和回调，具体拦谁由 BrowserControlServer 处理。
 * 轮询器故意写得很小：目标清单、焦点、空闲时间都是注入的函数，自测用假货就能跑。
 */
class HumanTakeoverWatcher {
  constructor({
    listTargets,
    readFocus,
    readIdleSeconds,
    onTakeover = () => {},
    onFocused = () => {},
    pollMs = HUMAN_TAKEOVER_POLL_MS,
    log = () => {},
    timerApi = null,
  } = {}) {
    if (typeof listTargets !== "function") throw new Error("人接管检测需要 listTargets（现在开着哪些账号窗口）");
    if (typeof readFocus !== "function") throw new Error("人接管检测需要 readFocus（插件报的焦点状态）");
    if (typeof readIdleSeconds !== "function") throw new Error("人接管检测需要 readIdleSeconds（系统空闲秒数）");
    this.listTargets = listTargets;
    this.readFocus = readFocus;
    this.readIdleSeconds = readIdleSeconds;
    this.onTakeover = onTakeover;
    this.onFocused = typeof onFocused === "function" ? onFocused : () => {};
    this.pollMs = Math.max(50, Number(pollMs) || HUMAN_TAKEOVER_POLL_MS);
    this.log = typeof log === "function" ? log : () => {};
    this.setTimer = timerApi?.setTimeout || setTimeout;
    this.clearTimer = timerApi?.clearTimeout || clearTimeout;
    this.timer = null;
    this.running = false;
    this.polling = false;
    /** Map<账号 id, { id, windowId, ready, focused, focusWindowId, foreground, idleSeconds, error, at, takeoverAt }> */
    this.states = new Map();
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.#schedule(0);
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    return this;
  }

  #schedule(delay) {
    if (!this.running) return;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      if (!this.running) return;
      // 上一轮还没跑完（比如插件回得慢）就跳过这一拍，别堆请求
      if (!this.polling) {
        this.polling = true;
        try {
          await this.pollOnce();
        } catch (error) {
          this.log(`人接管轮询出错（不影响控制服务）：${error.message}`);
        } finally {
          this.polling = false;
        }
      }
      this.#schedule(this.pollMs);
    }, delay);
    this.timer?.unref?.();
  }

  /** 跑一轮：读焦点；只有「这个窗口在前台」才去读空闲时间。窗口失焦后自然就不读了。 */
  async pollOnce() {
    const targets = await this.listTargets();
    const rows = [];
    for (const target of targets || []) {
      if (!target || target.id === undefined || target.id === null) continue;
      const id = String(target.id);
      // 一个格子可能有多个标签页（空间）：状态按「格子 + 标签页」分开记，人接管按标签页判
      const key = target.spaceId !== undefined && target.spaceId !== null ? `${id}#space:${target.spaceId}` : id;
      let state = this.states.get(key);
      if (!state) {
        state = {
          id,
          spaceId: target.spaceId !== undefined && target.spaceId !== null ? String(target.spaceId) : null,
          windowId: null,
          ready: false,
          focused: false,
          focusWindowId: null,
          foreground: false,
          idleSeconds: null,
          error: null,
          at: 0,
          takeoverAt: 0,
        };
        this.states.set(key, state);
      }
      if (typeof target.windowId === "number") state.windowId = target.windowId;

      let focus = null;
      try {
        focus = await this.readFocus(target);
      } catch (error) {
        state.ready = false;
        state.focused = false;
        state.foreground = false;
        state.idleSeconds = null;
        state.error = `问插件焦点状态失败：${error.message}`;
        rows.push(this.#publicState(state));
        continue;
      }

      state.ready = focus?.ready === true;
      state.focused = focus?.focused === true;
      state.focusWindowId = typeof focus?.windowId === "number" ? focus.windowId : null;
      state.error = typeof focus?.error === "string" ? focus.error : (typeof focus?.reason === "string" ? focus.reason : null);
      state.at = Date.now();

      const sameWindow = state.windowId !== null && state.focusWindowId === state.windowId;
      const foreground = state.ready && state.focused && sameWindow && this.#activeTabMatches(target, focus);
      state.foreground = foreground;
      // 这个格子的窗口被人切到了前台（例如在任务栏点它）：交给上层决定要不要把收起的格子摆回屏幕内
      if (state.ready && state.focused && sameWindow) {
        try { await this.onFocused(target); } catch (error) { this.log(`窗口前台处理失败（不影响轮询）：${error.message}`); }
      }

      if (foreground) {
        let idle = null;
        try {
          idle = await this.readIdleSeconds();
        } catch (error) {
          state.error = `读系统空闲时间失败：${error.message}`;
        }
        state.idleSeconds = Number.isFinite(Number(idle)) ? Number(idle) : null;
        if (state.idleSeconds === 0) {
          state.takeoverAt = Date.now();
          try {
            await this.onTakeover(target, { focus, idleSeconds: 0 });
          } catch (error) {
            this.log(`人接管处理失败（不影响轮询）：${error.message}`);
          }
        }
      } else {
        state.idleSeconds = null;
      }
      rows.push(this.#publicState(state));
    }
    return { ready: rows.some((row) => row.ready), targets: rows };
  }

  /** 状态查询用：只读焦点，不读空闲、不触发接管（状态输出不该顺手改东西） */
  async inspect() {
    const targets = await this.listTargets();
    const rows = [];
    for (const target of targets || []) {
      if (!target || target.id === undefined || target.id === null) continue;
      const id = String(target.id);
      let focus = null;
      let error = null;
      try {
        focus = await this.readFocus(target);
      } catch (err) {
        error = `问插件焦点状态失败：${err.message}`;
      }
      rows.push({
        id,
        windowId: typeof target.windowId === "number" ? target.windowId : null,
        ready: focus?.ready === true,
        focused: focus?.focused === true,
        focusWindowId: typeof focus?.windowId === "number" ? focus.windowId : null,
        detail: error || (typeof focus?.error === "string" ? focus.error : (typeof focus?.reason === "string" ? focus.reason : null)),
      });
    }
    return rows;
  }

  snapshot() {
    return [...this.states.values()].map((state) => this.#publicState(state));
  }

  /**
   * 人现在是不是正在看这个标签页（自动收摊用）。
   * 按「格子 + 空间」查轮询结果；没有这一行 / 插件没就绪时返回 null，
   * 调用方把 null 当「人在看」，宁可不收也不误关。
   *
   * @param {string} id 格子 id
   * @param {string|null} spaceId AI 空间 id；空 = 默认空间「我的」
   * @returns {boolean|null}
   */
  foregroundOf(id, spaceId) {
    const grid = String(id ?? "");
    const space = spaceId === undefined || spaceId === null ? "" : String(spaceId);
    const key = space ? `${grid}#space:${space}` : grid;
    const state = this.states.get(key);
    if (!state || !state.ready) return null;
    return state.foreground === true;
  }

  /**
   * 前台窗口里正在看的，是不是我们管的那个标签页。
   * 插件给了 activeTab.url 就比一下；对不上说明人切到了同一个窗口里的别的标签页，
   * 这时不该把 AI 的账号标签页判成人接管（宁可漏判，不误伤）。拿不到网址就只按窗口号判断。
   */
  #activeTabMatches(target, focus) {
    const activeUrl = typeof focus?.activeTabUrl === "string" ? focus.activeTabUrl : null;
    if (!activeUrl) return true;
    let current = null;
    try {
      current = target.wc?.getURL?.() || null;
    } catch {
      current = null;
    }
    if (!current) return true;
    return current === activeUrl;
  }

  #publicState(state) {
    return {
      id: state.id,
      spaceId: state.spaceId ?? null,
      windowId: state.windowId,
      ready: state.ready,
      focused: state.focused,
      focusWindowId: state.focusWindowId,
      foreground: state.foreground,
      idleSeconds: state.idleSeconds,
      error: state.error,
      at: state.at,
      takeoverAt: state.takeoverAt,
    };
  }
}

class BrowserControlServer {
  constructor({ manager, onLog = () => {}, onNotify = null, onAudit = null, allowEval = false, appHandler = null, autoHandbackMs = 0, getIdleSeconds = null, now = null, getAgentCursorEnabled = null, autoTakeoverOnInput = true, getWorkspaceRoots = null, getIdleMinutes = null, getAvailableMemoryBytes = null } = {}) {
    this.manager = manager;
    /** 软件本身的控制（状态、隧道、账号…）：action 形如 app/<名字>，交给主进程处理 */
    this.appHandler = appHandler;
    this.onLog = onLog;
    /**
     * 交接时提示用户的接口：主进程传「系统通知 + 托盘日志」，自测传收集函数。
     * 没传就只走 onLog —— 绝不让通知失败影响交接本身。
     */
    this.onNotify = typeof onNotify === "function" ? onNotify : null;
    /**
     * 审计出口：主进程写进 Bridge 的 call-log（type=handoff|return|approval 是一等事件）。
     * 没传时只留在 this.recentAudit + onLog，不影响交接。
     */
    this.onAudit = typeof onAudit === "function" ? onAudit : null;
    /** 最近 50 条交接审计（调试 / status 用） */
    this.recentAudit = [];
    /** 已经有人领走交还摘要的空间（防并发调用各拿一份） */
    this.returnClaims = new Set();
    this.allowEval = allowEval;
    this.server = null;
    this.port = null;
    this.token = crypto.randomBytes(16).toString("hex");
    this.calls = 0;
    /** 人接管后停手多久自动交还；默认 0 = 关，只能由人点格子顶栏的「交还给 AI」 */
    this.autoHandbackMs = Math.max(0, Number(autoHandbackMs) || 0);
    /**
     * 人一动键鼠就算接管吗。用户 2026-10-26 定：不算——鼠标挪过去点控制条就把 AI 停了，没法用；
     * 只有点控制条「接管 / 终止任务」才停（像 Ego Lite）。主程序传 false；保留 true 给老自测和以后的可选设置。
     */
    this.autoTakeoverOnInput = autoTakeoverOnInput !== false;
    /** 系统空闲秒数的来源；自测注入假函数，正常走 powerMonitor.getSystemIdleTime() */
    this.getIdleSeconds = typeof getIdleSeconds === "function" ? getIdleSeconds : defaultIdleSeconds;
    /** 当前时间；自测注入假时钟，正常就是 Date.now */
    this.now = typeof now === "function" ? now : Date.now;
    /**
     * 用户授权过的目录（工作区根 + 额外授权目录），上传文件时用来判边界。
     * 主程序注入的是读 state.roots 的函数（运行中改工作区立即生效）；不注入就是 null，
     * 上传一律拒绝 —— 没有授权目录时放开等于把整台机器交给网页。
     */
    this.getWorkspaceRoots = typeof getWorkspaceRoots === "function" ? getWorkspaceRoots : null;
    /** 设置里的「显示 AI 光标和控制条」；自测注入假函数，正常由 main.cjs 从 settings 读 */
    this.getAgentCursorEnabled = typeof getAgentCursorEnabled === "function" ? getAgentCursorEnabled : null;
    /** BrowserOS 账号窗口的人接管轮询器 */
    this.humanWatcher = null;
    /** Map<webContents.id, { id, wcId, at, reason }>：被插件信号判成人接管的账号窗口 */
    this.humanTakeovers = new Map();
    /** Map<webContents.id, number>：人点「交还给 AI」的时间，用来躲开按钮自己那次键鼠输入 */
    this.humanHandbackAt = new Map();
    /** Map<webContents.id, { id, wcId, spaceId, at, reason }>：人点控制条「终止任务」的标签页（30 分钟自动清除） */
    this.taskStopped = new Map();
    /** Map<webContents.id, { start, end }>：AI 对某个标签页派发输入的进行中时间窗（防伪造第二条） */
    this.aiInputWindows = new Map();
    /** Map<webContents.id, { wc, cdp, snap, actor }>：AI 用过的窗口，各自一份 CDP 会话和快照 */
    this.surfaces = new Map();
    /**
     * AI 空间自动收摊（用户 2026-10-28 定）：每分钟看一次，空闲到点关掉、内存不够卸载。
     * 判断在 src/core/space-autoclose.js；人是不是正在看的判断沿用 humanWatcher 的轮询结果。
     */
    this.spaceReaper = new SpaceReaper({
      backend: this.manager?.backend ?? null,
      log: (text) => this.onLog(`[browser-control] ${text}`),
      audit: (event) => this.#audit(event),
      isForeground: (gridId, spaceId) => this.humanWatcher?.foregroundOf(gridId, spaceId) ?? null,
      isHeld: (gridId, spaceId) => this.#spaceHumanHeld(gridId, spaceId),
      getIdleMinutes: typeof getIdleMinutes === "function" ? getIdleMinutes : null,
      getAvailableMemoryBytes: typeof getAvailableMemoryBytes === "function" ? getAvailableMemoryBytes : null,
      now: () => this.now(),
    });
  }

  /** Bridge 的 MCP 会话断了：空间记上断开时间，2 分钟后插一次检查（不用等满 idleMinutes） */
  noteSessionClosed(sessionId) {
    this.spaceReaper?.noteSessionClosed(sessionId);
  }

  /** 设置开关：默认开；关掉就不画覆盖层（防伪造和 TASK_STOPPED 逻辑照常，只是没有按钮可点） */
  agentCursorEnabled() {
    return !this.getAgentCursorEnabled || this.getAgentCursorEnabled() !== false;
  }

  /** 窗口被交还给 AI：接管（inputBlocked）和「任务已终止」一起解除，覆盖层回到「Agent 正在控制」 */
  handback(wcId) {
    const id = Number(wcId);
    const surface = this.surfaces.get(id);
    const takeover = this.humanTakeovers.get(id);
    const stopped = this.taskStopped.get(id);
    // BrowserOS 账号窗口可能还没被 AI 用过（没有 surface）：只要记过人接管或终止，也允许交还
    if (!surface) {
      if (!takeover && !stopped) return;
      this.humanTakeovers.delete(id);
      this.taskStopped.delete(id);
      this.humanHandbackAt.set(id, this.now());
      return;
    }
    if (surface.wc.isDestroyed()) return;
    if (!surface.cdp.inputBlocked && !takeover && !stopped) return;
    this.humanTakeovers.delete(id);
    this.taskStopped.delete(id);
    this.humanHandbackAt.set(id, this.now());
    surface.cdp.resumeInput?.();
    surface.overlay?.setState({ mode: "ai" }).catch(() => {});
    if (stopped) this.#logAgentActivity("解除了「任务已终止」（点「交还给 AI」）", surface);
  }

  /* ---------------- BrowserOS 账号窗口：人接管检测 ---------------- */

  /**
   * 现在开着哪些 BrowserOS 账号窗口标签页（给轮询器用）。
   * 一个格子可能有好几个标签页（默认空间 + 各 AI 空间的主标签页）：每个都是独立一行，
   * 人接管按标签页判 —— 人在某个空间标签页上操作，只拦 AI 在那个标签页上的输入。
   * 这里不建 surface、不碰页面，只拿 manager.open 登记过的外观和 backend 的空间外观。
   */
  async #browserOsTargets() {
    const rows = [];
    const liveWcIds = new Set();
    this.#sweepTaskStopped();
    const open = this.manager?.open;
    if (!open || typeof open.entries !== "function") return rows;
    for (const [id, entry] of open.entries()) {
      if (!entry || entry.engine !== "browseros") continue;
      const wc = entry.window?.webContents;
      if (!wc || wc.isDestroyed?.() || !wc.isBrowserOsTab) continue;
      liveWcIds.add(wc.id);
      let windowId = typeof entry.windowId === "number" ? entry.windowId : null;
      // 窗口号问一次就记在登记项上；问不到就跳过这个窗口（对不上窗口号时绝不能猜成前台）
      if (windowId === null && typeof this.manager.backend?.windowIdOf === "function") {
        try {
          windowId = await this.manager.backend.windowIdOf(String(id));
        } catch (error) {
          this.onLog(`[browser-control] 账号窗口 ${id} 问 windowId 失败（人接管检测先跳过它）：${error.message}`);
          windowId = null;
        }
        if (typeof windowId === "number") entry.windowId = windowId;
      }
      rows.push({ id: String(id), wc, windowId });
      // 每个开着的 AI 空间的主标签页也各算一个「人在操作的目标」（和主标签页同窗口、同焦点状态）
      if (typeof this.manager.backend?.spacesOf === "function") {
        let spaces = [];
        try {
          spaces = this.manager.backend.spacesOf(String(id)) || [];
        } catch (error) {
          this.onLog(`[browser-control] 账号窗口 ${id} 读空间列表失败（人接管检测先跳过空间）：${error.message}`);
          spaces = [];
        }
        for (const space of spaces) {
          const spaceWc = space?.wc || space?.window?.webContents;
          if (!spaceWc || spaceWc.isDestroyed?.() || !spaceWc.isBrowserOsTab) continue;
          liveWcIds.add(spaceWc.id);
          rows.push({ id: String(id), wc: spaceWc, windowId, spaceId: String(space.id) });
        }
      }
    }
    // 窗口已经关了、又从来没被 AI 碰过（没有 surface 去触发 disposeSurface）：把接管记录顺手清掉
    for (const wcId of this.humanTakeovers.keys()) {
      if (!liveWcIds.has(wcId)) this.humanTakeovers.delete(wcId);
    }
    for (const [wcId, at] of this.humanHandbackAt) {
      if (!liveWcIds.has(wcId) || this.now() - at >= HUMAN_HANDBACK_GRACE_MS) this.humanHandbackAt.delete(wcId);
    }
    return rows;
  }

  /** 建轮询器（只建一次） */
  #ensureHumanWatcher() {
    if (this.humanWatcher) return this.humanWatcher;
    if (!this.manager?.backend) return null;
    this.humanWatcher = new HumanTakeoverWatcher({
      listTargets: () => this.#browserOsTargets(),
      readFocus: (target) => this.manager.backend.extensionFocus(target.id),
      readIdleSeconds: () => this.getIdleSeconds(),
      onTakeover: (target, info) => { if (this.autoTakeoverOnInput) this.#takeoverFromHuman(target, info); },
      // 收起的格子在屏幕外；人在任务栏点它时窗口会被切到前台但看不见（2026-10-26 用户反馈）。
      // 一旦发现收起的格子成了前台窗口，就把它摆回屏幕内（回到上次的格子位置）。
      onFocused: async (target) => {
        const entry = this.manager?.backend?.get?.(target.id);
        if (!entry?.hidden) return;
        this.onLog(`[browser-control] 收起的格子 ${target.id} 被人切到前台，摆回屏幕内`);
        await this.manager.backend.show(target.id);
      },
      log: (message) => this.onLog(`[browser-control] ${message}`),
    });
    return this.humanWatcher;
  }

  /**
   * 插件报「账号窗口在前台」+ 系统空闲 0 秒 → 人接管这个窗口。
   * 结果：CDP 会话 blockInput；交还只能人点「交还给 AI」（autoHandbackMs 默认 0）。
   */
  #takeoverFromHuman(target, info = {}) {
    const wc = target?.wc;
    if (!wc || wc.isDestroyed?.()) return;
    const wcId = wc.id;
    if (this.humanTakeovers.has(wcId)) return;
    // 刚点过「交还给 AI」：按钮那一下键鼠输入还会让空闲时间是 0，先别立刻又判回来
    const handedBackAt = this.humanHandbackAt.get(wcId) || 0;
    if (this.now() - handedBackAt < HUMAN_HANDBACK_GRACE_MS) return;
    this.humanHandbackAt.delete(wcId);
    const reason = "人接管了这个窗口";
    this.humanTakeovers.set(wcId, { id: String(target.id), wcId, spaceId: target.spaceId ?? null, at: this.now(), reason });
    const surface = this.surfaces.get(wcId);
    if (surface) {
      try { surface.cdp.blockInput(reason); } catch (error) { this.onLog(`[browser-control] 拦 AI 输入时出错（忽略）：${error.message}`); }
      surface.overlay?.setState({ mode: "human" }).catch(() => {});
    }
    this.onLog(`[browser-control] 账号窗口 ${target.id} 判为人接管（空闲 ${info.idleSeconds ?? 0} 秒），AI 的输入先停下`);
  }

  /**
   * 状态输出用：人接管检测到底就绪没有。
   * 插件没连上时必须能看见「未就绪」，不能静默 —— 那段时间账号窗口其实没有保护。
   */
  async #humanTakeoverStatus() {
    const engine = "browseros";
    let idleAvailable = false;
    try {
      idleAvailable = Number.isFinite(Number(this.getIdleSeconds()));
    } catch {
      idleAvailable = false;
    }
    const watcher = this.#ensureHumanWatcher();
    if (!watcher) {
      return { engine, applicable: true, ready: false, idleAvailable, detail: "账号窗口后端没就绪，人接管检测未就绪", windows: [] };
    }
    let rows = [];
    try {
      rows = await watcher.inspect();
    } catch (error) {
      return { engine, applicable: true, ready: false, idleAvailable, detail: `问插件焦点状态失败，人接管检测未就绪：${error.message}`, windows: [] };
    }
    const ready = idleAvailable && rows.some((row) => row.ready);
    let detail;
    if (!rows.length) detail = "还没有打开的账号窗口（插件没连上），人接管检测未就绪";
    else if (!idleAvailable) detail = "拿不到系统空闲时间（powerMonitor 不可用），人接管检测未就绪";
    else if (ready) detail = "账号窗口插件已连上，人接管检测在跑";
    else detail = "插件没连上或没有焦点能力，人接管检测未就绪";
    return {
      engine,
      applicable: true,
      ready,
      idleAvailable,
      detail,
      windows: rows.map((row) => ({
        id: row.id,
        windowId: row.windowId,
        ready: row.ready,
        focused: row.focused,
        focusWindowId: row.focusWindowId,
        detail: row.detail,
      })),
    };
  }

  /** 自测用：跑一轮人接管检测（不启动定时器、不开端口、不碰网络） */
  async pollHumanTakeoverOnce() {
    const watcher = this.#ensureHumanWatcher();
    if (!watcher) return { applicable: false, ready: false, targets: [] };
    return watcher.pollOnce();
  }

  /**
   * BrowserOS 标签页被人接管时，凡是会改变页面的输入动作都拒绝。
   * 读快照、读正文、截图不受影响（只拦 click / type / key / page_act）。
   * 按标签页判：传进来的是哪个外观就查哪个（空间标签页接管只拦那个标签页）。
   */
  #assertHumanFree(wc) {
    if (!wc?.isBrowserOsTab) return;
    const surface = this.surfaces.get(wc.id);
    if (this.humanTakeovers.has(wc.id) || surface?.cdp?.inputBlocked) {
      throw codedError("CONTROL_PREEMPTED", "人正在用这个标签页，AI 的输入已停止；等人点「交还给 AI」再继续，不要重试");
    }
  }

  /* ---------------- 覆盖层控制条：终止任务 / 接管 / 交还（带防伪造） ---------------- */

  /** 「终止任务」满 30 分钟自动解除（也顺手把覆盖层换回「Agent 正在控制」） */
  #sweepTaskStopped() {
    let cleared = 0;
    for (const [wcId, entry] of this.taskStopped) {
      if (this.now() - entry.at < TASK_STOPPED_TTL_MS) continue;
      this.taskStopped.delete(wcId);
      cleared += 1;
      const surface = this.surfaces.get(wcId);
      if (surface && !this.humanTakeovers.has(wcId)) {
        surface.overlay?.setState({ mode: "ai" }).catch(() => {});
      }
    }
    if (cleared) this.onLog(`[browser-control] ${cleared} 个标签页的「任务已终止」满 30 分钟，自动解除`);
  }

  /**
   * 「任务被用户终止」的门：这个标签页上的输入和导航动作一律抛 TASK_STOPPED；
   * 读类动作（快照、正文、截图、等待）照常。状态持续到人点「交还给 AI」或 30 分钟自动清除。
   */
  #assertTaskNotStopped(wc) {
    if (!wc?.isBrowserOsTab) return;
    this.#sweepTaskStopped();
    if (this.taskStopped.has(wc.id)) {
      // 同上：页面跳转后把「已终止 + 交还给 AI」重新画出来
      this.surfaces.get(wc.id)?.overlay?.setState?.({ mode: "stopped" })?.catch?.(() => {});
      throw codedError(
        "TASK_STOPPED",
        "这个标签页的任务被用户终止了：停下来，向用户报告做到哪了；不要重试，也不要换别的标签页继续同一个任务",
      );
    }
  }

  /** AI 开始给这个标签页派发输入：记下时间窗起点（防伪造第二条） */
  #beginAiInput(wc) {
    if (!wc) return;
    this.aiInputWindows.set(wc.id, { start: this.now(), end: null });
  }

  /** AI 对这个标签页的这次输入派发结束：补上时间窗终点 */
  #endAiInput(wc) {
    if (!wc) return;
    const windowEntry = this.aiInputWindows.get(wc.id);
    if (windowEntry) windowEntry.end = this.now();
  }

  /** 这一刻是否落在「AI 正在给这个标签页派发输入」的时间窗里（前后各留 500ms 宽限） */
  #aiInputActive(wcId) {
    const windowEntry = this.aiInputWindows.get(wcId);
    if (!windowEntry) return false;
    const start = Number(windowEntry.start) || 0;
    const end = windowEntry.end === null || windowEntry.end === undefined ? Number.POSITIVE_INFINITY : Number(windowEntry.end);
    const now = this.now();
    return now >= start - OVERLAY_AI_INPUT_GRACE_MS && now <= end + OVERLAY_AI_INPUT_GRACE_MS;
  }

  /**
   * 覆盖层按钮事件回到主程序后要同时满足三条才算是人点的（CDP 合成点击 isTrusted 也是 true，
   * 所以不能只靠 isTrusted）：
   *   1. event.isTrusted 为真（页面脚本伪造的 dispatchEvent 一律是 false）；
   *   2. 这一刻 AI 没有正在给这个标签页派发输入（前后各留 500ms，防 AI 自己点「交还给 AI」）；
   *   3. 插件报这个格子窗口拿到了系统焦点（系统焦点是 CDP 伪造不了的）。
   * 三条有一条不满足就丢弃并记日志。
   *
   * 「接管 / 终止任务」不受第 2 条限制：AI 就算伪造成功也只是把自己停掉，不构成越权；
   * 而人正是靠这两个按钮在批量填表进行中停手的，不能被 AI 输入时间窗吞掉。
   */
  async onOverlayButton(surface, message) {
    const wc = surface?.wc;
    if (!wc || wc.isDestroyed?.()) return;
    const parsed = message && typeof message === "object" ? message : {};
    const action = typeof parsed.action === "string" ? parsed.action : "";
    const drop = (why) => this.onLog(`[browser-control] 丢弃控制条按钮事件（${action || "未知动作"}，标签页 ${wc.id}）：${why}`);
    if (!["takeover", "handback", "stop"].includes(action)) { drop("动作不在白名单"); return; }
    if (parsed.isTrusted !== true) { drop("event.isTrusted 不为真"); return; }
    // 只有「交还给 AI」要躲开 AI 输入时间窗；接管 / 终止任务必须随时能停手（见上面的说明）
    if (action === "handback" && this.#aiInputActive(wc.id)) { drop("落在 AI 输入时间窗内"); return; }
    if (!(await this.#overlayFocusConfirmed(String(surface.id)))) { drop("插件没有报这个格子窗口拿到系统焦点"); return; }
    if (action === "takeover") this.#takeoverFromButton(surface);
    else if (action === "handback") this.handback(wc.id);
    else if (action === "stop") this.#stopTaskFromButton(surface);
  }

  /**
   * 问插件「这个格子窗口拿到系统焦点了吗」。人点按钮的那一下正好让窗口拿到焦点，
   * 插件可能还没来得及记（onFocusChanged 是异步事件），所以隔 150ms 再确认一次。
   */
  async #overlayFocusConfirmed(id) {
    const backend = this.manager?.backend;
    if (!backend || typeof backend.extensionFocus !== "function") return false;
    for (const delay of [0, 150]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const focus = await backend.extensionFocus(String(id));
        if (focus?.ready === true && focus?.focused === true) return true;
      } catch { /* 下一次再试 */ }
    }
    return false;
  }

  /** 人点控制条「接管」：和自动检测到的接管同一个状态、同一个「交还给 AI」流程 */
  #takeoverFromButton(surface) {
    const wc = surface.wc;
    const reason = "人点了控制条「接管」";
    if (this.humanTakeovers.has(wc.id)) return;
    this.humanTakeovers.set(wc.id, { id: String(surface.id), wcId: wc.id, spaceId: surface.space ?? null, at: this.now(), reason });
    try { surface.cdp.blockInput?.(reason); } catch (error) { this.onLog(`[browser-control] 拦 AI 输入时出错（忽略）：${error.message}`); }
    surface.overlay?.setState({ mode: "human" }).catch(() => {});
    this.#logAgentActivity("接管了这个标签页（点控制条「接管」）", surface);
  }

  /** 人点控制条「终止任务」：之后 AI 的输入 / 导航都被 TASK_STOPPED 拦下 */
  #stopTaskFromButton(surface) {
    const wc = surface.wc;
    if (this.taskStopped.has(wc.id)) return;
    this.taskStopped.set(wc.id, { id: String(surface.id), wcId: wc.id, spaceId: surface.space ?? null, at: this.now(), reason: "人点了控制条「终止任务」" });
    surface.overlay?.setState({ mode: "stopped" }).catch(() => {});
    this.#logAgentActivity("终止了任务（点控制条「终止任务」）", surface);
  }

  /** 活动日志：谁、哪个格子、哪个空间、哪个标签页、什么时候 */
  #logAgentActivity(kind, surface) {
    const spaceText = surface.space ? `空间「${surface.space}」` : "「我的」空间";
    this.onLog(`[browser-control] 活动：用户${kind} —— 格子 ${surface.id}、${spaceText}、标签页 ${surface.wc?.id ?? "?"}、时间 ${new Date(this.now()).toISOString()}`);
  }

  /** 旧的 click / type / key / scroll / navigate 也画覆盖层（失败一律静默，绝不拖累动作本身） */
  async #showLegacyOverlay(id, tab, { label = "", point = null } = {}) {
    if (!this.agentCursorEnabled()) return;
    if (!label && !point) return;
    try {
      const surface = await this.surfaceFor(id, tab.wc, tab.space);
      if (label) await surface.overlay?.showAction(label);
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) await surface.overlay?.showCursor(point.x, point.y);
    } catch { /* 覆盖层失败一律静默 */ }
  }

  /**
   * 旧的 click / type 的 expect：动作发出后等页面出现指定文字或选择器。
   * 返回 true（读到）/ false（超时）/ null（没传 expect）。
   * 只读页面，不产生输入事件，所以探测本身不会改变状态。
   */
  async #waitForExpect(wc, expect) {
    const { normalizeExpect, expectProbeExpression } = await loadSurfaceModules();
    const spec = normalizeExpect(expect);
    if (!spec) return null;
    const expression = expectProbeExpression(spec);
    const deadline = Date.now() + spec.timeoutMs;
    for (;;) {
      const hit = await wc.executeJavaScript(expression).catch(() => false);
      if (hit === true) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * 取某个账号窗口标签页的 CDP 会话、快照、动作器；第一次用时建，窗口关了就扔掉。
   * tab 不传就用格子的主标签页（默认空间「我的」）；传了（空间的主标签页）就用那个。
   */
  async surfaceFor(id, wcArg = null, space = null) {
    const wc = wcArg ? (wcArg.webContents || wcArg) : this.windowFor(id).webContents;
    // 登录页上不挂调试器（execute 已经拦过一次，这里防直接调 surfaceFor 的路径）
    assertAiAllowed(wc.getURL());
    const cached = this.surfaces.get(wc.id);
    if (cached && cached.wc === wc && !wc.isDestroyed()) {
      // 复用时要补上空间号：空间标签页的 surface 一开始可能没带 space 建出来
      if (space !== undefined && space !== null && cached.space === undefined) cached.space = String(space);
      return cached;
    }
    const entry = this.manager?.backend?.get?.(String(id));
    if (!entry?.handle?.conn) {
      throw codedError("TARGET_CLOSED", `账号窗口 ${id} 没有可用的 BrowserOS 会话`);
    }
    // targetId 必须来自「这一个标签页」。以前这里回退到 entry.tab.targetId（格子的主标签页），
    // 空间标签页一旦没带 targetId，动作就会静默打到「我的」那个标签页上 —— 正是 t1/t3/t5 报的
    // 「操作落到别的标签页、却返回 ok」。宁可报错，也不猜。
    const targetId = wc.targetId;
    if (!targetId) {
      const isMainTab = entry?.tab === wc;
      throw codedError(
        "TARGET_CLOSED",
        isMainTab
          ? `账号窗口 ${id} 的主标签页没有 targetId，包不了 CDP 会话`
          : `账号窗口 ${id} 的这个标签页没有 targetId（可能不是这个格子的标签页），拒绝操作，免得打到别的标签页；先 space_list 确认空间还在，必要时 space_open 重开`,
      );
    }
    const { createSurfaceSnapshot, createSurfaceAct } = await loadSurfaceModules();
    // 独立一条页面会话：和标签页外观各用各的会话号，互不影响
    const cdp = new AccountSurface(entry.handle.conn, {
      targetId,
      // urlGuard：动作做到一半页面跳进了登录页，之后的每一条 CDP 命令都直接拒绝
      urlGuard: (url) => checkAiAccess(url),
      label: `账号窗口 ${id}`,
    });
    await cdp.attach();
    const snap = await createSurfaceSnapshot(cdp, { getUrl: () => wc.getURL() });
    // AI 光标 + 控制条覆盖层（isolated world 里画）：显示层，任何失败都不能影响动作
    const overlay = new AgentOverlay({
      cdp,
      enabled: () => this.agentCursorEnabled(),
      onButton: (message) => { void this.onOverlayButton(surface, message); },
      log: (message) => this.onLog(`[browser-control] ${message}`),
    });
    const surface = {
      id,
      wc,
      cdp,
      snap,
      space: space !== undefined && space !== null ? String(space) : null,
      overlay,
      actor: createSurfaceAct(cdp, snap, {
        showAgentMousePosition: (x, y) => overlay.showCursor(x, y),
        showAgentTaskState: (label) => overlay.showAction(label),
        overlayUi: () => this.agentCursorEnabled(),
      }),
    };
    const wcId = wc.id;   // 销毁以后再读 wc.id 会抛错，先记下来
    this.surfaces.set(wcId, surface);
    // 人接管发生在 AI 第一次碰这个窗口之前：surface 刚建出来就把拦截补上
    if (this.humanTakeovers.has(wcId)) cdp.blockInput("人接管了这个窗口");
    wc.once("destroyed", () => this.disposeSurface(wcId));
    // 页面跳进登录页：立刻扔掉会话和快照，AI 之前拍的编号也一起作废
    surface.onNavigate = (_event, url) => { if (checkAiAccess(url)) this.disposeSurface(wcId); };
    wc.on("did-navigate", surface.onNavigate);
    wc.on("did-navigate-in-page", surface.onNavigate);
    return surface;
  }

  disposeSurface(wcId) {
    const surface = this.surfaces.get(wcId);
    if (!surface) return;
    this.surfaces.delete(wcId);
    // 窗口真的没了：人接管的记录跟着清掉；只是页面跳去登录页时保留（人可能还在用这个窗口）
    try {
      if (surface.wc.isDestroyed()) {
        this.humanTakeovers.delete(wcId);
        this.humanHandbackAt.delete(wcId);
        this.taskStopped.delete(wcId);
        this.aiInputWindows.delete(wcId);
      }
    } catch { /* 正在销毁 */ }
    if (surface.onNavigate && !surface.wc.isDestroyed()) {
      try {
        surface.wc.removeListener("did-navigate", surface.onNavigate);
        surface.wc.removeListener("did-navigate-in-page", surface.onNavigate);
      } catch { /* 正在销毁 */ }
    }
    // 在 destroyed 事件里跑：任何一步抛错都会变成主进程错误框，所以逐个兜住，一步失败不影响后面的清理
    for (const part of [surface.actor, surface.snap, surface.overlay, surface.cdp]) {
      try { Promise.resolve(part.dispose()).catch(() => {}); } catch (error) { this.onLog(`[browser-control] 清理窗口时出错（已忽略）：${error.message}`); }
    }
  }

  /* ---------------- 空间控制权：AI ⇄ 人 ---------------- */

  /** 读空间控制权。老后端没有这套接口时返回 null，页面行为与以前完全一样。 */
  async #spaceControl(id, space) {
    const backend = this.manager?.backend;
    if (!backend || typeof backend.spaceControl !== "function") return null;
    return backend.spaceControl(String(id), space);
  }

  /** 走一步状态机并落盘。非法转换报 INVALID_CONTROL_STATE（不会静默改状态）。 */
  async #saveControl(id, space, nextState, options = {}) {
    const record = await this.#spaceControl(id, space);
    if (!record) return null;
    const { transitionControl } = await loadHandoffModules();
    let control;
    try {
      control = transitionControl(record.control, nextState, { at: this.now(), ...options });
    } catch (error) {
      throw codedError("INVALID_CONTROL_STATE", error.message);
    }
    const backend = this.manager?.backend;
    if (backend && typeof backend.setSpaceControl === "function") {
      return backend.setSpaceControl(String(id), space, control);
    }
    return { ...record, control };
  }

  /** 拍一次当前页面观察（URL / 标题 / 快照正文 / 是否已登录）。拍不到就返回空正文，不阻断交接。 */
  async #observationOf(surface) {
    const { createObservation } = await loadHandoffModules();
    let text = "";
    try {
      const snap = await surface?.snap?.snapshot?.();
      text = snap?.text ?? "";
    } catch (error) {
      this.onLog(`[browser-control] 交接快照拍摄失败（摘要会如实说明）：${error.message}`);
    }
    return createObservation({
      url: safeUrl(surface?.wc),
      title: safeTitle(surface?.wc),
      text,
      at: this.now(),
    });
  }

  /** 交接前快照：空间标签页没开 / CDP 不通时返回 null，摘要会写「无法确认」。 */
  async #captureSpaceObservation(id, space) {
    try {
      const tab = this.resolveTab(id, space);
      const surface = await this.surfaceFor(id, tab.wc, tab.space);
      return await this.#observationOf(surface);
    } catch (error) {
      this.onLog(`[browser-control] 交接时读不到页面（摘要会写「无法确认」）：${error.message}`);
      // CDP 不通（例如登录页不许 AI 碰）时仍然记下 URL / 标题：登录状态变化照样能看出来
      try {
        const tab = this.resolveTab(id, space);
        const { createObservation } = await loadHandoffModules();
        return createObservation({ url: safeUrl(tab.wc), title: safeTitle(tab.wc), text: "", at: this.now() });
      } catch {
        return null;
      }
    }
  }

  /** 审计一等事件：写进 onAudit（Bridge 的 call-log），失败只记一行，绝不影响交接。 */
  async #audit(event) {
    try {
      const { createAuditEvent } = await loadHandoffModules();
      const normalized = createAuditEvent({ ...event, at: new Date(this.now()) });
      this.recentAudit.push(normalized);
      if (this.recentAudit.length > 50) this.recentAudit.splice(0, this.recentAudit.length - 50);
      // 自动收摊没有 from / to，写「几个标签页 + 原因」才好读
      const transition = normalized.type === "space_auto_close" || normalized.type === "space_auto_discard"
        ? `${normalized.tabs ?? 0} 个标签页，原因 ${normalized.reason || "?"}`
        : `${normalized.from ?? "?"} → ${normalized.to ?? "?"}${normalized.reason ? `（${normalized.reason}）` : ""}`;
      this.onLog(`[browser-control] 审计事件：${normalized.type} 空间 ${normalized.space} ${transition}`);
      if (this.onAudit) await this.onAudit(normalized);
    } catch (error) {
      this.onLog(`[browser-control] 写交接审计失败（忽略）：${error.message}`);
    }
  }

  /** 通知用户（主进程接系统通知 / 托盘日志）。没有接口就只留 onLog。 */
  async #notify(note) {
    if (!this.onNotify) return false;
    try {
      await this.onNotify(note);
      return true;
    } catch (error) {
      this.onLog(`[browser-control] 交接通知发送失败（忽略）：${error.message}`);
      return false;
    }
  }

  /**
   * 写操作闸门的审批事件（一等审计）：
   *   拒绝 → 状态进 awaiting_approval，等 AI 带 confirm:true 重试；
   *   放行 → 状态回 ai_running。
   * 状态写失败（老后端 / 非法转换）只记一行，审计照写 —— 审批结论本身不能丢。
   */
  async #recordApproval(id, space, { allowed, target = "", keyword = "", from = "ai_running" }) {
    const spaceKey = space ?? "home";
    const next = allowed ? "ai_running" : "awaiting_approval";
    const reason = allowed
      ? `放行：confirm:true 的提交动作「${target || "(未知)"}」`
      : `拒绝：未带 confirm:true 的提交动作「${target || "(未知)"}」${keyword ? `（命中「${keyword}」）` : ""}`;
    try {
      await this.#saveControl(id, spaceKey, next, { reason: allowed ? "" : reason, message: "", by: "ai" });
    } catch (error) {
      this.onLog(`[browser-control] 审批状态更新失败（审计照写）：${error.message}`);
    }
    await this.#audit({ type: "approval", space: spaceKey, from, to: next, reason });
    return next;
  }

  /**
   * human_control / paused / needs_help 期间 AI 的写操作一律 HUMAN_IN_CONTROL；
   * 读操作（page_snapshot / page_read / 截图 / wait）不经过这里，照常可用。
   */
  async #assertSpaceWriteAllowed(id, space, actionName = "") {
    const record = await this.#spaceControl(id, space);
    if (!record) return;
    const { WRITE_BLOCKED_STATES, CONTROL_STATE_LABELS } = await loadHandoffModules();
    const state = record.control?.state;
    if (!WRITE_BLOCKED_STATES.includes(state)) return;
    const label = CONTROL_STATE_LABELS[state] ?? state;
    const why = record.control?.reason ? `（${record.control.reason}）` : "";
    throw codedError(
      "HUMAN_IN_CONTROL",
      `空间「${record.name}」现在${label}${why}：AI 的写操作已停止，读操作照常。等人交还、状态回到「AI 运行中」后再写${actionName ? `（这次被拦下的动作：${actionName}）` : ""}`,
    );
  }

  /** page_act 的动作分级：滚动 / 悬停 / 聚焦这类 benign 动作不算写，照常放行。 */
  async #assertPageWriteAllowed(id, space, action) {
    const { classifyAction, ACTION_CLASSES } = await loadSurfaceModules();
    const actionClass = classifyAction(action);
    if (actionClass === ACTION_CLASSES.BENIGN || actionClass === ACTION_CLASSES.READ) return;
    await this.#assertSpaceWriteAllowed(id, space, `page_act ${action}`);
  }

  /**
   * 交还后第一次调用：先拍快照，跟交接前那份对比，给出变更摘要，然后把状态切回 ai_running。
   * 只给一次：并发调用用 returnClaims 挡住第二个，状态切回 ai_running 后后面的调用不会再进来。
   */
  async #consumeReturnSummary(id, space, surface) {
    const record = await this.#spaceControl(id, space);
    if (!record || record.control?.state !== "returning") return null;
    const key = `${id}:${record.id}`;
    if (this.returnClaims.has(key)) return null;
    this.returnClaims.add(key);
    try {
      const baseline = record.control.before ?? null;
      const current = await this.#observationOf(surface);
      const saved = await this.#saveControl(id, space, "ai_running", { reason: "", message: "", by: "ai", before: null });
      const { summarizeSnapshotChange, describeChangeSummary } = await loadHandoffModules();
      const summary = summarizeSnapshotChange(baseline, current);
      const text = describeChangeSummary(summary, { spaceName: saved?.name ?? record.name });
      this.onLog(`[browser-control] 空间「${saved?.name ?? record.name}」交还后重新观察：${summary.comparable ? "变更摘要已附在这次返回最前面" : summary.note}`);
      return { ...summary, text, at: new Date(this.now()).toISOString() };
    } catch (error) {
      this.onLog(`[browser-control] 交还后重新观察失败（不影响这次调用）：${error.message}`);
      return null;
    } finally {
      this.returnClaims.delete(key);
    }
  }

  /**
   * space_handoff：AI 把空间交给用户。状态由 reason 决定（暂停→paused、登录/验证码→needs_help、其余→human_control），
   * 交接前拍一份快照留给交还时做变更摘要，并通知用户、写一条 handoff 审计。
   */
  async spaceHandoff(id, params = {}) {
    const pid = String(id);
    const spaceRef = String(params.space ?? "").trim();
    if (!spaceRef) throw codedError("INVALID_ARGUMENT", "space_handoff 要给空间 id 或名字");
    if (String(params.to ?? "human").trim() !== "human") {
      throw codedError("INVALID_ARGUMENT", 'space_handoff 现在只支持 to:"human"（把控制权交给用户）');
    }
    const reason = String(params.reason ?? "").trim();
    if (!reason) throw codedError("INVALID_ARGUMENT", "space_handoff 要写清楚为什么交给用户（reason，例如「需要扫码登录」）");
    const message = params.message === undefined || params.message === null ? "" : String(params.message).trim().slice(0, 500);
    const { resolveHandoffState } = await loadHandoffModules();
    const target = resolveHandoffState({ reason, message });
    const record = await this.#spaceControl(pid, spaceRef);
    if (!record) throw codedError("INVALID_ARGUMENT", "这个版本不支持空间控制权（升级 Windrise 主程序后再试）");
    const previous = record.control?.state ?? "ai_running";
    // 交接前快照：交还后第一次 page_* 用它算「你改了什么」
    const before = await this.#captureSpaceObservation(pid, spaceRef);
    const saved = await this.#saveControl(pid, spaceRef, target, { reason, message, by: "ai", before });
    const name = saved?.name ?? record.name;
    const control = publicControl(saved?.control);
    await this.#audit({ type: "handoff", space: saved?.id ?? spaceRef, from: previous, to: target, reason });
    const notified = await this.#notify({
      title: "AI 需要你接手",
      body: target === "needs_help"
        ? `空间「${name}」需要你处理：${reason}${message ? `（${message}）` : ""}。处理完把控制权交还给 AI 就能继续。`
        : `空间「${name}」已交给你控制：${reason}${message ? `（${message}）` : ""}。`,
      id: pid,
      space: { id: saved?.id ?? spaceRef, name },
      state: target,
      reason,
      message,
    });
    this.onLog(`[browser-control] 空间「${name}」交给用户：${target}（${reason}）`);
    return {
      id: pid,
      space: { id: saved?.id ?? spaceRef, name, owner: saved?.owner ?? record.owner },
      control,
      notified,
      next_step: "AI 的写操作已停；读操作照常。用户交还后，下一次 page_* 返回的最前面会带变更摘要。",
    };
  }

  /**
   * 人交还控制权（Bridge 内部函数 + 本机调试入口，没有 UI）：
   *   POST /control/<令牌>/space/return  { id, space, reason? }
   * 状态变 returning；不马上拍快照，等 AI 下一次 page_* 再重新观察（handback 契约）。
   */
  async spaceReturn(id, params = {}) {
    const pid = String(id);
    const spaceRef = String(params.space ?? "").trim();
    if (!spaceRef) throw codedError("INVALID_ARGUMENT", "space/return 要给空间 id 或名字");
    const reason = String(params.reason ?? "").trim() || "人把控制权交还给 AI";
    const record = await this.#spaceControl(pid, spaceRef);
    if (!record) throw codedError("INVALID_ARGUMENT", "这个版本不支持空间控制权（升级 Windrise 主程序后再试）");
    const previous = record.control?.state ?? "ai_running";
    if (previous === "returning") {
      return { id: pid, space: { id: record.id, name: record.name, owner: record.owner }, control: publicControl(record.control), alreadyReturning: true };
    }
    const saved = await this.#saveControl(pid, spaceRef, "returning", { reason, message: "", by: "human" });
    // 标签页级的人接管也一起解除，否则下一次 page_act 会被 CONTROL_PREEMPTED 挡住
    try {
      const tab = this.resolveTab(pid, spaceRef);
      this.handback(tab.wc.id);
    } catch { /* 空间标签页没开着：控制权状态照样交还 */ }
    await this.#audit({ type: "return", space: saved?.id ?? spaceRef, from: previous, to: "returning", reason });
    this.onLog(`[browser-control] 人把空间「${saved?.name ?? record.name}」交还给 AI（${previous} → returning）`);
    return {
      id: pid,
      space: { id: saved?.id ?? spaceRef, name: saved?.name ?? record.name, owner: saved?.owner ?? record.owner },
      control: publicControl(saved?.control),
      next_step: "下一次 page_* 调用会先重新观察页面，把交接前后的变更摘要附在返回最前面，然后 AI 继续。",
    };
  }

  /**
   * AI 要往这个窗口里输入之前：人接管着就不动手（步数为 0，规划 6.7）；
   * 默认只有人点「交还给 AI」才还，构造时传了 autoHandbackMs > 0 才保留「人停手够久自动交还」。
   */
  #claimForAi(surface) {
    const { wc, cdp } = surface;
    const takeover = this.humanTakeovers.get(wc.id);
    if (cdp.inputBlocked || takeover) {
      const lastHuman = takeover?.at ?? 0;
      const idle = this.now() - lastHuman;
      if (!(this.autoHandbackMs > 0 && idle >= this.autoHandbackMs)) {
        // 页面跳转后覆盖层会没：AI 每次被挡都把「你在控制 + 交还给 AI」重新画出来，不然人找不到交还按钮（真机 10-26 踩到）
        if (takeover) surface.overlay?.setState?.({ mode: "human" })?.catch?.(() => {});
        else if (this.taskStopped?.has?.(wc.id)) surface.overlay?.setState?.({ mode: "stopped" })?.catch?.(() => {});
        throw codedError("CONTROL_PREEMPTED", "人正在用这个标签页，等人在标签页里点「交还给 AI」，或者换一个空间继续");
      }
      this.humanTakeovers.delete(wc.id);
      cdp.resumeInput?.();
    }
  }

  /**
   * 页面开着没处理的 JS 对话框：当场报 DIALOG_OPEN（类型 + 文字 + 默认值）。
   *
   * 真机 t12：点一个 onClick 里 alert() 的按钮，鼠标事件本身永远等不到 ack，第一次调用卡满 15 秒、
   * 要到下一次才看到 DIALOG_OPEN。现在适配层（target-surface）在等鼠标 ack 的同时监听对话框事件，
   * 对话框一出现就用 DIALOG_OPEN 结算。但「下一次调用」也可能被堵住：命令发出前对话框还不在、发出去之后
   * 浏览器把这条命令吞了（页面脚本被 alert 打断），所以要补一个迟到检查：任何失败里，只要对话框已经开着，
   * 就按 DIALOG_OPEN 重新定性；只读探测（repeatable）还可以补发一次，拿到浏览器给出的类型和文字。
   */
  async #dialogAware(surface, run, { repeatable = false, writable = false } = {}) {
    try {
      return await run();
    } catch (error) {
      if (error?.code === "DIALOG_OPEN") {
        if (writable) {
          // 统一成对话框专用的下一步：surface-act 在事件发出后会把 next_step 写成「可能已生效」，
          // 那条文案对 DIALOG_OPEN 是误导（现在唯一该做的是先关对话框）。
          error.outcome = "dispatched";
          error.dispatched = true;
          error.next_step = "对话框已经弹出来了：先调 page_act 带 action:\"dialog\" 和 accept:true / false 处理它，再继续原来的动作";
        }
        // 只读动作（page_snapshot）没有「动作已发出」这回事：不要给它凭空加 outcome / dispatched。
        throw error;
      }
      let dialog = surface.cdp?.dialog ?? null;
      if (!dialog && repeatable) {
        dialog = await Promise.race([
          new Promise((resolve) => setTimeout(() => resolve(null), 1_500)),
          new Promise((resolve) => {
            const off = surface.cdp.onEvent?.("Surface.dialogOpen", (params) => { off?.(); resolve(params ?? { type: "alert", message: "" }); });
          }),
        ]).catch(() => null);
      }
      if (!dialog) throw error;
      const open = Object.assign(this.#dialogOpenError({ cdp: { ...surface.cdp, dialog } }), {
        cause: error,
        // 原来的错误码不能丢：闸门拒绝（NEEDS_CONFIRM）被改写成 DIALOG_OPEN 时，调用方还要知道
        // 「关掉对话框之后这条动作本来要干什么」。
        causeCode: error?.code ?? null,
      });
      // 闸门的载荷（reason / keyword / retryable / target / next_step …）原样带过去，不能只剩 cause 里。
      for (const key of GATE_FIELDS) {
        if (key === "outcome" || key === "dispatched" || key === "dialog") continue;
        if (error?.[key] !== undefined) open[key] = error[key];
      }
      if (!writable) {
        // 只读动作：保留原始 outcome / dispatched 的形状（通常两个都没有），不冒充「动作已发出」。
        throw open;
      }
      // 事件已经发出去了（鼠标点下去了）就按「可能已生效」上报，没发出去就是确定没发
      if (!error?.outcome) {
        const dispatched = Boolean(error?.dispatched) || Boolean(error?.method && String(error.method).startsWith("Input."));
        Object.assign(open, dispatched
          ? { outcome: "dispatched", dispatched: true, next_step: "对话框已经弹出来了：先调 page_act 带 action:\"dialog\" 和 accept:true / false 处理它，再继续原来的动作" }
          : { outcome: "failed", dispatched: false });
      } else {
        open.outcome = error.outcome;
        open.dispatched = error.dispatched;
      }
      throw open;
    }
  }

  /**
   * page_snapshot：语义快照，可操作的元素带 [ref=eN] 编号。
   *
   * 长页面（维基词条十万字）以前只能从头截断，尾部的语言面板永远读不到，所以支持：
   *   selector     只拍某个 CSS 选择器的子树（找不到就 NOT_FOUND，绝不返回空清单）
   *   viewportOnly 只列当前屏幕里看得见的元素
   *   offset/maxChars  按字切块，返回 nextOffset / totalChars，截断时写清还有多少字
   *   find         只回含这段文字的行 + 每行的祖先行（在长快照里找「English」这种链接）
   */
  async pageSnapshot(id, params) {
    const tab = this.resolveTab(id, params.space);
    const surface = await this.surfaceFor(id, tab.wc, tab.space);
    // 交还后的第一次调用：先重新观察，摘要跟这次返回一起回去（只给一次）
    const returnSummary = await this.#consumeReturnSummary(id, tab.space, surface);
    try {
      return withReturnSummary(await this.#pageSnapshotSurface(id, params, tab, surface), returnSummary);
    } catch (error) {
      withReturnSummary(error, returnSummary);
      throw error;
    }
  }

  /** page_snapshot 的本体（不含交还摘要那一层） */
  async #pageSnapshotSurface(id, params, tab, surface) {
    // 对话框开着时页面脚本被堵住，拍快照只会挂到超时：当场报 DIALOG_OPEN，让 AI 先关它。
    // 同时套一层迟到检查：读无障碍树的命令有时会被浏览器吞掉（页面里的 alert 打断了脚本），
    // 那种情况下对话框已经弹出来了，返回 DIALOG_OPEN 比返回一条 CDP 超时有用得多。
    return this.#dialogAware(surface, () => this.#pageSnapshot(surface, id, params, tab), { repeatable: true, writable: false });
  }

  async #pageSnapshot(surface, id, params, tab) {
    if (surface.cdp?.dialog) throw this.#dialogOpenError(surface);
    const selector = params.selector === undefined || params.selector === null || String(params.selector).trim() === ""
      ? null
      : String(params.selector);
    const viewportOnly = Boolean(params.viewportOnly);
    const { paginateSnapshot, findInSnapshot, waitForPageReady } = await loadSurfaceModules();
    // 页面刚导航完、还没加载完时先等：等不到就照常拍（比干等更诚实，AI 自己会重试）
    const ready = await waitForPageReady(surface.cdp).catch(() => null);
    const result = selector || viewportOnly
      ? await surface.snap.scopedSnapshot({ selector, viewportOnly })
      : await surface.snap.snapshot();
    const title = surface.wc.getTitle();
    const find = params.find === undefined || params.find === null ? "" : String(params.find).trim();
    if (find) {
      const found = findInSnapshot(result.text, find);
      const page = paginateSnapshot(found.text, { offset: 0, maxChars: Number(params.maxChars ?? PAGE_TEXT_LIMIT) });
      return {
        id,
        space: tab.space ?? null,
        url: result.url,
        title,
        mode: "find",
        find,
        matches: found.count,
        text: found.count ? page.text : `（快照里没有含「${find}」的行）`,
        truncated: page.truncated,
        nextOffset: page.nextOffset,
        totalChars: page.totalChars,
        length: result.text.length,
        ready: ready?.reason ?? null,
      };
    }
    const page = paginateSnapshot(result.text, {
      offset: Number(params.offset ?? 0),
      maxChars: Number(params.maxChars ?? PAGE_TEXT_LIMIT),
    });
    return {
      id,
      space: tab.space ?? null,
      url: result.url,
      title,
      mode: selector ? "selector" : viewportOnly ? "viewport" : "full",
      selector,
      viewportOnly,
      text: page.text,
      offset: page.offset,
      nextOffset: page.nextOffset,
      totalChars: page.totalChars,
      remaining: page.remaining,
      truncated: page.truncated,
      // length：整份快照的字数（含被切掉的部分），和以前一样；totalChars 是这次要分页的那段文字的长度
      length: result.text.length,
      ready: ready?.reason ?? null,
    };
  }

  /** page_act：按编号动作，做完回读这次变了什么 */
  async pageAct(id, params) {
    const tab = this.resolveTab(id, params.space);
    const surface = await this.surfaceFor(id, tab.wc, tab.space);
    const returnSummary = await this.#consumeReturnSummary(id, tab.space, surface);
    try {
      return withReturnSummary(await this.#pageActSurface(id, params, tab, surface), returnSummary);
    } catch (error) {
      withReturnSummary(error, returnSummary);
      throw error;
    }
  }

  /** page_act 的本体（不含交还摘要那一层） */
  async #pageActSurface(id, params, tab, surface) {
    this.#claimForAi(surface);
    this.#assertTaskNotStopped(tab.wc);
    const hasFields = params.fields !== undefined;
    // 既没 action 也没 fields：在分类 / 过闸门之前就说清楚，不要落到单动作路径再报一个不相干的错
    if (!hasFields && params.action === undefined) {
      throw codedError("INVALID_ARGUMENT", "要么给 action（单个动作），要么给 fields（批量填值，最多 30 项）；action 和 fields 不要同时传");
    }
    if (hasFields && !Array.isArray(params.fields)) {
      throw codedError("INVALID_ARGUMENT", "fields 必须是数组：[{ref, value}, …]（最多 30 项）");
    }
    if (hasFields) {
      // 批量填表和单个动作是两条路，不接受混着传（否则「填完再点一下提交」就很难说清）
      if (params.action !== undefined || params.ref !== undefined) {
        throw codedError("INVALID_ARGUMENT", "fields 和 action / ref 不能同时给：批量填表只用 fields，单个动作只用 action + ref");
      }
      // 批量填表也是写操作；按 type 分级走写操作闸门
      await this.#assertPageWriteAllowed(id, tab.space, "fill");
      if (surface.cdp?.dialog) throw this.#dialogOpenError(surface);
      return this.#pageActFields(id, params, tab, surface);
    }
    // human_control / paused / needs_help 期间：写动作当场 HUMAN_IN_CONTROL，一个事件都不发
    await this.#assertPageWriteAllowed(id, tab.space, params.action);
    // 页面上开着 JS 对话框：先当场报 DIALOG_OPEN（带类型和文字），不要让它把动作堵到超时。
    // 例外是 action:"dialog" 本身 —— 它就是为了关掉这个对话框才被调用的。
    if (surface.cdp?.dialog && params.action !== "dialog") throw this.#dialogOpenError(surface);
    const { id: _id, diff: diffMode = "summary", maxChars, ...request } = params;
    // 上传走单独一条路：路径要在主进程里过工作区守卫，绝不能把任意本机路径直接交给 CDP
    if (request.action === "upload") return this.#uploadToPage(id, surface, request, { diffMode, maxChars });
    // 快照只列能操作的元素，不列正文；点完「发送」冒出来的回答在差异里看不到，所以另外数一下正文字数
    const textLength = async () => {
      try {
        const r = await surface.cdp.send("Runtime.evaluate", { expression: "(document.body?.innerText || '').length", returnByValue: true });
        return typeof r?.result?.value === "number" ? r.result.value : null;
      } catch { return null; }
    };
    const urlBefore = safeUrl(tab.wc);
    const beforeLength = diffMode === "none" ? null : await textLength();
    // 写操作闸门的审批审计：拒绝（NEEDS_CONFIRM）和带 confirm:true 放行都记一等事件
    const policy = await loadSurfaceModules();
    const commitGated = policy.needsCommitGate(String(request.action ?? ""), request.key);
    const controlBefore = (await this.#spaceControl(id, tab.space))?.control?.state ?? "ai_running";
    // 输入时间窗：动作开始前记起点、结束后补终点（覆盖层按钮防伪造第二条）
    this.#beginAiInput(tab.wc);
    let result;
    try {
      try {
        result = await this.#dialogAware(surface, () => surface.actor.act(request), { writable: true });
      } catch (error) {
        // 闸门拒绝可能被对话框迟到检查改写成 DIALOG_OPEN（原码留在 causeCode），两种都要记审批
        if (error?.code === "NEEDS_CONFIRM" || error?.causeCode === "NEEDS_CONFIRM") {
          await this.#recordApproval(id, tab.space, {
            allowed: false,
            target: error.target ?? "",
            keyword: error.keyword ?? "",
            from: controlBefore,
          });
        }
        throw error;
      }
    } finally {
      this.#endAiInput(tab.wc);
    }
    if (commitGated && request.confirm === true && policy.matchCommitKeyword(result?.target)) {
      await this.#recordApproval(id, tab.space, { allowed: true, target: result.target, from: controlBefore });
    }
    // 动作过程中弹出了对话框（点「删除」弹出 confirm 是常态）：立刻返回，别继续读页面
    if (surface.cdp?.dialog) {
      const error = this.#dialogOpenError(surface);
      Object.assign(error, { outcome: "dispatched", dispatched: true, target: result?.target ?? null });
      throw error;
    }
    // 动作可能触发导航（点链接 / 回车提交表单）：等页面稳下来再读，否则会拍到空壳，
    // 返回里也不会有新网址和标题（t3 报告：登录成功却报「no change」）。
    // 注意不能要求「一定换页」：大多数点击不换页，硬等满 5 秒会让每次点击都慢 5 秒
    // （t5 报告过「每次点击都约 5 秒」）。这里只观察一个短窗口：窗口内换了页就跟到底，没换就收工。
    const { waitForNavigationSettle } = await loadSurfaceModules();
    const settle = await waitForNavigationSettle(surface.cdp, {
      previousUrl: urlBefore,
      graceMs: 400,
      windowMs: 700,
    }).catch(() => null);
    // 动作发出后对话框才弹出来（点击的 ack 先回、alert 后到）：这里再兜一次，别继续读页面
    if (surface.cdp?.dialog) {
      const error = this.#dialogOpenError(surface);
      Object.assign(error, { outcome: "dispatched", dispatched: true, target: result?.target ?? null });
      throw error;
    }
    const urlAfter = settle?.url || safeUrl(tab.wc);
    const titleAfter = settle?.title || safeTitle(tab.wc);
    const nav = {
      url: urlAfter || null,
      title: titleAfter || null,
      navigated: Boolean(settle?.navigated) || Boolean(urlAfter && urlBefore && urlAfter !== urlBefore),
      settled: settle ? settle.settled : null,
      ...(settle && !settle.settled ? { settleReason: settle.reason } : {}),
    };
    if (diffMode === "none") return { id, ...result, navigation: nav, diff: null };
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等页面对这次动作做出反应
    // 这一下点进了登录页（例如「用 Google 登录」）：不回读差异，免得把登录页的内容带给 AI
    const landed = surface.wc.isDestroyed() ? null : checkAiAccess(surface.wc.getURL());
    if (landed) return { id, ...result, navigation: nav, diff: null, code: landed.code, note: landed.message };
    let diff = null;
    for (const wait of [0, 800]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try { diff = await surface.snap.diff(); break; }
      catch { /* 页面还在变（例如正在跳转），再等一下 */ }
    }
    if (!diff) return { id, ...result, navigation: nav, diff: null, note: "页面还在变化，没拿到差异；稍后用 page_snapshot 重新拍" };
    const afterLength = await textLength();
    const textDelta = beforeLength !== null && afterLength !== null ? afterLength - beforeLength : null;
    const clipped = clip(diff.text, Number(maxChars ?? PAGE_TEXT_LIMIT));
    return {
      id, ...result, navigation: nav,
      diff: {
        added: diff.added, removed: diff.removed, changed: diff.changed,
        // 导航了就必须报 urlChanged：vendor 的逐行 diff 在换了文档时会说「没变化」，那会直接误导 AI
        urlChanged: Boolean(diff.urlChanged) || nav.navigated, url: diff.afterUrl ?? urlAfter,
        textDelta, text: clipped.text, truncated: clipped.truncated,
        // 长页面上 vendor 跳过了逐行 diff：这时 text 是「新出现 / 消失的可操作元素」清单
        lineDiffSkipped: Boolean(diff.lineDiffSkipped),
        actionable: diff.actionable ?? null,
      },
    };
  }

  /**
   * 批量填表：按顺序填完 fields，最后只等一次页面稳定、只回读一次 diff。
   * 一项失败不中断后面的；提交按钮 / 链接在 surface-act 里就被拒绝，这里不会触发提交。
   */
  async #pageActFields(id, params, tab, surface) {
    const { fillFieldsOnce } = await loadSurfaceModules();
    const diffMode = params.diff ?? "summary";
    const maxChars = params.maxChars;
    const expect = params.expect;
    // 快照只列能操作的元素，不列正文；整表填完另外数一次正文字数
    const textLength = async () => {
      try {
        const r = await surface.cdp.send("Runtime.evaluate", { expression: "(document.body?.innerText || '').length", returnByValue: true });
        return typeof r?.result?.value === "number" ? r.result.value : null;
      } catch { return null; }
    };
    const urlBefore = safeUrl(tab.wc);
    const beforeLength = diffMode === "none" ? null : await textLength();
    // 输入时间窗按字段收窄：只在真的派发输入的那一下张开，字段之间的等待 / 回读不算 AI 输入。
    // 整批共用一个窗口会让控制条的人在几十秒里被当成「AI 自己点」而整批停不下来。
    let result = await fillFieldsOnce({
      fields: params.fields,
      fillField: async (field) => {
        this.#beginAiInput(tab.wc);
        try {
          return await surface.actor.fillField(field);
        } finally {
          this.#endAiInput(tab.wc);
        }
      },
      // 每个字段动手前重新过一遍闸门：中途人接管 / 终止任务 / 弹对话框 / 跳登录页就立刻中止整批
      beforeField: async () => {
        this.#claimForAi(surface);
        this.#assertTaskNotStopped(tab.wc);
        await this.#assertSpaceWriteAllowed(id, tab.space, "page_act fields");
        if (surface.cdp?.dialog) throw this.#dialogOpenError(surface);
        // SPA 路由跳登录页时文档没换，编号还能解析到；不能再往登录页 / 受限页里写
        const landed = checkAiAccess(safeUrl(surface.wc));
        if (landed) throw codedError(landed.code, landed.message);
      },
      // 只调用一次：等页面稳定 + 回读一次 diff（不按字段重复）
      readBack: async () => {
        // 中途弹出了 JS 对话框：立刻停下，把已经填完的结果一起带回去
        if (surface.cdp?.dialog) {
          const error = this.#dialogOpenError(surface);
          Object.assign(error, { outcome: "dispatched", dispatched: true, target: null });
          throw error;
        }
        // 动作可能触发导航（自定义下拉里的链接 / 表单联动）：等页面稳下来再读
        const { waitForNavigationSettle } = await loadSurfaceModules();
        const settle = await waitForNavigationSettle(surface.cdp, {
          previousUrl: urlBefore,
          graceMs: 400,
          windowMs: 700,
        }).catch(() => null);
        const urlAfter = settle?.url || safeUrl(tab.wc);
        const titleAfter = settle?.title || safeTitle(tab.wc);
        const navigation = {
          url: urlAfter || null,
          title: titleAfter || null,
          navigated: Boolean(settle?.navigated) || Boolean(urlAfter && urlBefore && urlAfter !== urlBefore),
          settled: settle ? settle.settled : null,
          ...(settle && !settle.settled ? { settleReason: settle.reason } : {}),
        };
        // 整批共用一次 expect 等待（不是每个字段都等一次）
        const expectMet = expect === undefined ? null : await surface.actor.waitForExpect(expect).catch(() => false);
        if (diffMode === "none") return { navigation, expectMet, diff: null };
        await new Promise((resolve) => setTimeout(resolve, 300));
        // 填完落在了登录页（例如自定义下拉里点了「用 Google 登录」）：不回读差异
        const landed = surface.wc.isDestroyed() ? null : checkAiAccess(surface.wc.getURL());
        if (landed) return { navigation, expectMet, diff: null, code: landed.code, note: landed.message };
        let diff = null;
        for (const wait of [0, 800]) {
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          try { diff = await surface.snap.diff(); break; }
          catch { /* 页面还在变（例如正在跳转），再等一下 */ }
        }
        if (!diff) {
          return {
            navigation, expectMet, diff: null,
            note: "页面还在变化，没拿到差异；稍后用 page_snapshot 重新拍",
          };
        }
        const afterLength = await textLength();
        const textDelta = beforeLength !== null && afterLength !== null ? afterLength - beforeLength : null;
        const clipped = clip(diff.text, Number(maxChars ?? PAGE_TEXT_LIMIT));
        return {
          navigation, expectMet,
          diff: {
            added: diff.added, removed: diff.removed, changed: diff.changed,
            urlChanged: Boolean(diff.urlChanged) || navigation.navigated, url: diff.afterUrl ?? urlAfter,
            textDelta, text: clipped.text, truncated: clipped.truncated,
            lineDiffSkipped: Boolean(diff.lineDiffSkipped),
            actionable: diff.actionable ?? null,
          },
        };
      },
    });
    const expectMet = result?.expectMet ?? null;
    const unverified = Array.isArray(result?.fields)
      ? result.fields.filter((item) => item.ok && item.verified === false).length
      : 0;
    const failed = Number(result?.failed ?? 0);
    const aborted = Number(result?.aborted ?? 0);
    // 只要有一项失败 / 中止 / 「点选出去了但没读回确认」，就不能算 confirmed —— 只有读回才算确认
    const outcome = expectMet === true && unverified === 0 && failed === 0 && aborted === 0
      ? "confirmed"
      : (result.filled + result.skipped > 0 ? "dispatched" : "failed");
    const next_step = outcome === "confirmed"
      ? "整表都填好了，expect 也读到了，可以继续下一步"
      : outcome === "dispatched"
        ? `${failed ? `还有 ${failed} 个字段没填成功，见 fields；` : ""}字段已经填进页面${unverified ? `；${unverified} 项只点选、没读回确认，见 verified:false` : ""}。批量填表不会提交：要提交仍然单独调用一次 page_act（提交类动作需要 confirm:true）`
        : "这次没有字段填成功：先 page_snapshot 看页面，确认编号和控件类型再重试";
    return { id, ...(result ?? {}), unverified, outcome, target: null, next_step };
  }

  /** 对话框开着时统一的错误：类型 + 文字 + 怎么关，一个字段都不省 */
  #dialogOpenError(surface) {
    const dialog = surface.cdp?.dialog ?? {};
    const kind = String(dialog.type ?? "alert");
    const text = String(dialog.message ?? "");
    const error = codedError(
      "DIALOG_OPEN",
      `页面开着 ${kind} 对话框${text ? `：${JSON.stringify(text)}` : ""}。它挡住了页面的脚本和输入，先调 page_act 带 action:"dialog" 和 accept:true（确认）/ false（取消）把它关掉`,
    );
    error.dialog = { type: kind, message: text, defaultPrompt: dialog.defaultPrompt ?? "", url: dialog.url ?? null };
    return error;
  }

  /**
   * 往页面的文件框里放文件（page_act action:"upload"）。
   *
   * 安全边界（用户 10-27 定）：只许放「用户授权过的工作区目录」里的文件，别的一律拒绝。
   * 为什么不直接 `DOM.setFileInputFiles`：那条命令收的是浏览器进程本机路径，等于把 AI 的读能力
   * 借给网页 —— 一个被投毒的页面放个 <input type=file>，就能让 AI 把任意本机文件塞进上传框。
   * 所以路径先过 upload-guard（绝对路径 / 存在 / 是普通文件 / 真实路径在授权目录里），再发命令。
   *
   * 授权根目录来自 main.cjs 注入的 getWorkspaceRoots（设置里的工作区，含额外授权目录）。
   * 没注入（纯 Node 自测 / 老版本）时一律拒绝：宁可报「没授权目录」，也不能悄悄放开。
   */
  async #uploadToPage(id, surface, request, { diffMode = "summary", maxChars } = {}) {
    const { checkUploadPaths } = await loadSurfaceModules();
    const ref = request.ref ? String(request.ref) : "";
    if (!ref) throw codedError("INVALID_ARGUMENT", "upload 需要 ref（快照里那个 file-input 或上传按钮的编号）");
    const files = request.files ?? [];
    const roots = typeof this.getWorkspaceRoots === "function" ? this.getWorkspaceRoots() : [];
    const paths = await checkUploadPaths(files, roots);
    // 解析编号 → backendNodeId：DOM.setFileInputFiles 只认 backendNodeId / objectId
    const element = await surface.snap.resolveRef(ref).catch((error) => {
      throw codedError("REF_STALE", `编号 ${ref} 对应的元素已经不在了，请重新拍快照（${error?.message ?? error}）`);
    });
    const backendNodeId = element?.backendNodeId;
    if (backendNodeId === undefined) throw codedError("REF_STALE", `编号 ${ref} 解析不到 backendNodeId，请重新拍快照`);
    const objectId = (await surface.cdp.send("DOM.resolveNode", { backendNodeId }))?.object?.objectId;
    if (!objectId) throw codedError("REF_STALE", `编号 ${ref} 对应的元素已经不在了，请重新拍快照`);
    try {
      // 先确认这个元素真的能吃文件（file input 本身，或者是包着 file input 的按钮 / label）：
      // 直接对普通按钮发这条命令，浏览器会报一个看不懂的协议错，不如自己说清楚。
      const check = await surface.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FILE_INPUT_PROBE,
        returnByValue: true,
      }).catch(() => null);
      const verdict = check?.result?.value ?? null;
      if (!verdict?.ok) {
        throw codedError(
          "NOT_ACTIONABLE",
          `编号 ${ref} 不是文件框（${verdict ? `${verdict.tag}${verdict.type ? `:${verdict.type}` : ""}` : "读不到元素类型"}）：只往 <input type="file"> 或包着它的按钮 / label 上传，先 page_snapshot 找 file-input 那一行`,
        );
      }
      this.#beginAiInput(surface.wc);
      try {
        await surface.cdp.send("DOM.setFileInputFiles", { files: paths, backendNodeId });
      } finally {
        this.#endAiInput(surface.wc);
      }
      // 后置校验：读回 input.files 的个数和大小。0 字节 / 0 个文件说明路径没被浏览器认（跨主机就是这样），
      // 那时候必须报错，不能让 AI 以为上传成功（t1 报告里的「假成功」）。
      const readBack = await surface.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FILE_INPUT_READBACK,
        returnByValue: true,
      }).catch(() => null);
      const attached = Array.isArray(readBack?.result?.value) ? readBack.result.value : null;
      if (attached && (attached.length !== paths.length || attached.some((file) => !file.size))) {
        throw codedError(
          "ACT_FAILED",
          `文件框里只挂上了 ${attached.length}/${paths.length} 个文件${attached.some((f) => !f.size) ? "（有 0 字节的）" : ""}：浏览器没读到这些路径，检查文件是否在浏览器能访问的本机位置`,
        );
      }
      const result = {
        ok: true,
        action: "upload",
        ref,
        target: String(surface.snap.refs?.get(ref)?.name ?? ""),
        files: attached ?? paths.map((file) => ({ name: path.basename(file), size: null })),
        outcome: "confirmed",
        dispatched: true,
        next_step: "文件已经放进文件框；要提交表单就点那个提交按钮（提交类动作需要 confirm:true）",
      };
      if (diffMode === "none") return { id, ...result, diff: null };
      await new Promise((resolve) => setTimeout(resolve, 300));
      const diff = await surface.snap.diff().catch(() => null);
      if (!diff) return { id, ...result, diff: null, note: "页面还在变化，没拿到差异；稍后用 page_snapshot 重新拍" };
      const clipped = clip(diff.text, Number(maxChars ?? PAGE_TEXT_LIMIT));
      return {
        id, ...result,
        diff: {
          added: diff.added, removed: diff.removed, changed: diff.changed,
          urlChanged: Boolean(diff.urlChanged), url: diff.afterUrl ?? safeUrl(surface.wc),
          textDelta: null, text: clipped.text, truncated: clipped.truncated,
          lineDiffSkipped: Boolean(diff.lineDiffSkipped),
          actionable: diff.actionable ?? null,
        },
      };
    } finally {
      await surface.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  /** page_read：读页面正文（转成 markdown），例如把 AI 对话网站的回答原样拿回来 */
  async pageRead(id, params) {
    const tab = this.resolveTab(id, params.space);
    const surface = await this.surfaceFor(id, tab.wc, tab.space);
    const returnSummary = await this.#consumeReturnSummary(id, tab.space, surface);
    try {
      return withReturnSummary(await this.#pageReadSurface(id, params, tab, surface), returnSummary);
    } catch (error) {
      withReturnSummary(error, returnSummary);
      throw error;
    }
  }

  /** page_read 的本体（不含交还摘要那一层） */
  async #pageReadSurface(id, params, tab, surface) {
    if (surface.cdp?.dialog) throw this.#dialogOpenError(surface);
    const { readSurfaceContent, waitForPageReady } = await loadSurfaceModules();
    // 页面刚导航、还没加载完时先等：否则 selector 会 0 命中，报出来的 NOT_FOUND 就指向错的原因
    const ready = await waitForPageReady(surface.cdp).catch(() => null);
    const text = await readSurfaceContent(surface.cdp, { selector: params.selector, last: Boolean(params.last), viewportOnly: Boolean(params.viewportOnly), includeLinks: Boolean(params.includeLinks) });
    const clipped = clip(text, Number(params.maxChars ?? PAGE_TEXT_LIMIT));
    return { id, space: tab.space ?? null, url: surface.wc.getURL(), text: clipped.text, truncated: clipped.truncated, length: clipped.length, ready: ready?.reason ?? null };
  }

  /**
   * 清理死实例留下的发现文件（被强杀时 stop() 来不及删，原来会一直攒：实测 38 个）。
   * 判活用 process.kill(pid, 0)：不发信号，只检查进程是否存在。
   */
  async #sweepStaleDiscoveryFiles() {
    const dir = path.dirname(DISCOVERY_FILE);
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const name of names) {
      const match = /^browser-control-(\d+)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = error.code === "EPERM"; }
      if (!alive) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }

  async start() {
    if (this.server) return this.info();
    // 账号窗口的人接管轮询
    this.#ensureHumanWatcher()?.start();
    // AI 空间自动收摊：每分钟一次；内存闸门跟着这一拍
    this.spaceReaper?.start();
    await this.#sweepStaleDiscoveryFiles().catch(() => {});
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    await this.publishDiscovery();
    this.onLog(`[browser-control] 已启动 http://127.0.0.1:${this.port}/control/<令牌>`);
    return this.info();
  }

  async publishDiscovery() {
    await fs.promises.mkdir(path.dirname(DISCOVERY_FILE), { recursive: true });
    const payload = {
      url: `http://127.0.0.1:${this.port}/control/${this.token}`,
      pid: process.pid,
      startedAt: Date.now(),
      allowEval: this.allowEval,
    };
    const text = JSON.stringify(payload, null, 2);

    /*
     * 写两个文件：主文件（兼容老读者）+ 按 PID 命名的专属文件。
     *
     * 为什么要按 PID 再写一份：
     *   主文件是「一个文件记录一个实例」，两个实例（比如开发版和打包版同时开）
     *   会互相覆盖。先退出的那个还会把自己的主文件删掉 —— 结果活着的那个
     *   反而没有发现文件了，外部 Agent 找不到控制服务。
     *
     *   有了专属文件，读取端可以扫目录、逐个探活，谁活着用谁。
     *   主文件仍然写，是为了不让只看主文件的老读者直接失效。
     */
    this.discoveryFiles = [DISCOVERY_FILE, this.#ownDiscoveryFile()];
    for (const file of this.discoveryFiles) {
      await fs.promises.writeFile(file, text, { mode: 0o600 });
    }
  }

  /** 本实例专属的发现文件路径 */
  #ownDiscoveryFile() {
    return path.join(path.dirname(DISCOVERY_FILE), `browser-control-${process.pid}.json`);
  }

  async stop() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    this.humanWatcher?.stop();
    this.humanWatcher = null;
    this.spaceReaper?.stop();
    this.humanTakeovers.clear();
    this.humanHandbackAt.clear();
    this.taskStopped.clear();
    this.aiInputWindows.clear();
    for (const wcId of [...this.surfaces.keys()]) this.disposeSurface(wcId);

    /*
     * 清理发现文件时**必须确认是自己写的**再删。
     *
     * 踩过的坑：两个实例同时开时，后启动的会覆盖主文件；
     * 先退出的那个无脑删掉主文件，结果活着的那个反而没有发现文件了，
     * 外部 Agent 找不到控制服务（表现是「浏览器工具明明该在线却不在线」）。
     */
    await fs.promises.rm(this.#ownDiscoveryFile(), { force: true }).catch(() => {});
    try {
      const raw = await fs.promises.readFile(DISCOVERY_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.pid === process.pid) {
        await fs.promises.rm(DISCOVERY_FILE, { force: true });
      }
    } catch {
      // 文件不在、或读坏了 —— 都不该影响关闭流程
    }
    this.discoveryFiles = [];
  }

  info() {
    return { running: Boolean(this.server), port: this.port, calls: this.calls, allowEval: this.allowEval };
  }

  /** 取某个 profile 的账号窗口；没有就报错。 */
  windowFor(id) {
    const entry = this.manager.open.get(id);
    if (!entry?.window || entry.window.isDestroyed()) {
      throw codedError("TARGET_CLOSED", `格子 ${id} 没有打开。先 browser_open 打开这个格子（id 或格子编号都行），再重试`);
    }
    return entry.window;
  }

  /**
   * 格子没开就打开它（走 browser_open 同一条路：manager.openWindow → BrowserOS 的打开流程），
   * 已经开着就什么都不做。返回 true 表示这次真的打开了。
   *
   * 为什么放在这里：space_open 以前遇到没开的格子直接报 TARGET_CLOSED，把「先 browser_open」的
   * 家务事推给 AI；而 AI 手里的 id 本来就是格子编号，打开它没有歧义，自动做掉更省事。
   */
  async #ensureGridOpen(id) {
    if (id === undefined || id === null || String(id).trim() === "") return false;
    const key = String(id);
    const entry = this.manager?.open?.get?.(key);
    if (entry?.window && !entry.window.isDestroyed?.()) return false;
    if (typeof this.manager?.openWindow !== "function") {
      throw codedError("TARGET_CLOSED", `格子 ${key} 没有打开，而这个版本不支持自动打开它：先 browser_open 打开这个格子，再重试`);
    }
    try {
      await this.manager.openWindow(key, {});
    } catch (error) {
      // 打不开就给出唯一一条正确的下一步：说清是哪一格、为什么失败、该做什么
      throw codedError(
        "TARGET_CLOSED",
        `格子 ${key} 没有打开，自动打开也失败了（${error.message}）。先确认这个格子存在（browser_profiles 看有哪些格子），再 browser_open 打开它；还不行就是 BrowserOS 那边的问题，请人看一眼`,
      );
    }
    return true;
  }

  /**
   * 这个空间是不是已经被人接管 / 人点了「终止任务」（接管模块的状态，按标签页记）。
   * 是的话自动收摊一律不动它，哪怕人切到了别的标签页。
   */
  #spaceHumanHeld(gridId, spaceId) {
    try {
      const spaces = this.manager?.backend?.spacesOf?.(String(gridId)) || [];
      const row = spaces.find((item) => String(item.id) === String(spaceId));
      const wcId = row?.wc?.id;
      if (wcId === undefined || wcId === null) return false;
      return this.humanTakeovers.has(wcId) || this.taskStopped.has(wcId);
    } catch {
      return false;
    }
  }

  /**
   * 记一次「AI 在这个空间里动过」：空闲计时从现在重新算，并记下调用它的 MCP 会话。
   * 空间不存在 / 是「我的」时静默返回 —— 记账不该把正常操作打挂。
   */
  #noteSpaceActivity(id, space, sessionId) {
    const backend = this.manager?.backend;
    if (!backend || typeof backend.noteSpaceAiActivity !== "function") return;
    try {
      backend.noteSpaceAiActivity(String(id), String(space), {
        sessionId: sessionId ? String(sessionId) : null,
        at: this.now(),
      });
    } catch { /* 记账失败无所谓 */ }
  }

  /**
   * 按「格子 + 空间」拿标签页：不给 space 就是默认空间「我的」的主标签页（和以前一样）。
   * 给 space（空间 id 或名字）就走 backend.spaceWindow 拿那个空间的主标签页外观。
   * 返回 {window, wc, space}：window 是外观，wc 是标签页，space 是空间 id（没给空间时是 null）。
   */
  resolveTab(id, space) {
    const wantsSpace = space !== undefined && space !== null && String(space).trim() !== "";
    if (!wantsSpace) {
      // 主标签页：这里不强制 targetId —— 旧路径（click / type / snapshot）用 executeJavaScript，不需要它；
      // 需要 CDP 会话的 page_* 会在 surfaceFor 里因为拿不到 targetId 明确报错（绝不回退到别的标签页）。
      const window = this.windowFor(id);
      return { window, wc: window.webContents, space: null };
    }
    const backend = this.manager?.backend;
    if (!backend || typeof backend.spaceWindow !== "function") {
      throw codedError("INVALID_ARGUMENT", "这个版本不支持空间（升级 Windrise 主程序后再试）");
    }
    const window = backend.spaceWindow(String(id), String(space));
    const wc = window?.webContents;
    if (!wc) throw codedError("SPACE_CLOSED", `空间「${space}」没有可操作的标签页，先 space_open 重开它`);
    // 调用方可能给的是名字：把返回里的 space 换成真实空间 id（拿不到就原样返回）
    let resolved = String(space);
    try {
      const match = (backend.spacesOf?.(String(id)) || []).find((item) => item.wc === wc || item.window === window);
      if (match?.id) resolved = match.id;
    } catch { /* 名字解析不到 id 也不影响操作 */ }
    // 这里不查 targetId：旧路径（click / type / snapshot）用 executeJavaScript，作用的就是这个 wc 自己，
    // 不存在打到别的标签页的可能。需要 CDP 会话的 page_* 在 surfaceFor 里查，拿不到就报错、绝不回退。
    return { window, wc, space: resolved };
  }

  async handle(req, res) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const prefix = "/control/";
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end("not found"); return; }
    const token = url.pathname.slice(prefix.length).split("/")[0];
    if (token !== this.token) { res.writeHead(404).end("not found"); return; }
    const action = url.pathname.slice(prefix.length + token.length).replace(/^\//, "") || "status";

    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
      catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "请求体不是合法 JSON" })); return; }
    }

    this.calls += 1;
    try {
      const result = await this.execute(action, { ...body, ...Object.fromEntries(url.searchParams) });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, action, result }));
    } catch (error) {
      this.onLog(`[browser-control] ${action} 失败：${error.message}`);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      // 写操作闸门的字段要原样送到 MCP 侧：outcome / dispatched / next_step / target / reason / keyword / retryable
      res.end(JSON.stringify({ ok: false, action, error: error.message, code: error.code ?? null, ...gateDetails(error) }));
    }
  }

  /**
   * 对外入口：先把「格子 2」/「slot:2」/「2」换成账号 id，执行完再把 slot 和账号名补进返回。
   * 只加字段，不改任何已有字段 —— 老调用方照原样读原来的字段。
   */
  async execute(action, params = {}) {
    const resolvedId = await this.#resolveTargetId(params?.id);
    const next = resolvedId === params?.id ? params : { ...params, id: resolvedId };
    const result = await this.#executeAction(action, next);
    if (String(action).startsWith("app/")) return result;
    if (action === "layout") return result;
    return this.#withGridInfo(next?.id, result);
  }

  /** 把格子编号写法换成账号 id；换不了就原样返回（交给后面的「没打开」报错） */
  async #resolveTargetId(raw) {
    if (raw === undefined || raw === null) return raw;
    const text = String(raw);
    if (!text.trim()) return raw;
    if (this.manager.open?.has?.(text)) return text;
    if (typeof this.manager.resolveGridId !== "function") return raw;
    try {
      const resolved = await this.manager.resolveGridId(text);
      return resolved || raw;
    } catch {
      return raw;
    }
  }

  /** 返回里补 slot / accountName（只加不覆盖） */
  async #withGridInfo(id, result) {
    if (id === undefined || id === null || String(id).trim() === "") return result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    try {
      const row = (await this.manager.list()).find((item) => item.id === String(id));
      if (!row) return result;
      const slot = result.slot !== undefined ? result.slot : (row.slot ?? null);
      const accountName = result.accountName !== undefined ? result.accountName : (row.name ?? null);
      return {
        ...result,
        slot,
        accountName,
        // name 也带上：账号表里一直叫 name，老调用方不用为格子工具换字段名
        name: result.name !== undefined ? result.name : accountName,
      };
    } catch {
      return result;
    }
  }

  async #executeAction(action, params) {
    const { id } = params;
    if (action.startsWith("app/")) {
      if (!this.appHandler) throw new Error("这个版本不支持软件控制");
      return this.appHandler(action.slice(4), params);
    }

    /*
     * AI 空间自动收摊的记账（只看时间、会话号，不记网址）：
     *   - 任何一次带 sessionId 的调用都算「这个会话活着」，把断开标记清掉；
     *   - 带 space 的调用算「AI 在这个空间里动过」，空闲计时从现在重新算。
     * 记账失败绝不影响正在做的操作。
     */
    const backendForSpaces = this.manager?.backend;
    if (id && params.sessionId && typeof backendForSpaces?.clearSessionGone === "function") {
      try { backendForSpaces.clearSessionGone(String(params.sessionId)); } catch { /* 记账失败无所谓 */ }
    }
    if (id && params.space) this.#noteSpaceActivity(id, params.space, params.sessionId);

    // AI 禁区：当前页面是登录页（只许人操作）时，读、点、填、截图、执行脚本一律拒绝；离开类动作照常放行
    if (id && !AI_GUARD_EXEMPT.has(action)) {
      // 带 space 时查那个空间的标签页（空间标签页停在登录页，旧的 click / type / key 也得拦）
      let wc = null;
      const wantsSpace = params.space !== undefined && params.space !== null && String(params.space).trim() !== "";
      if (wantsSpace) {
        try { wc = this.resolveTab(id, params.space).wc; } catch { wc = null; /* 空间不在：后面的动作自己会报 SPACE_* */ }
      } else {
        wc = this.manager.open?.get?.(id)?.window?.webContents;
      }
      if (wc && !wc.isDestroyed()) assertAiAllowed(wc.getURL());
    }

    switch (action) {
      case "grid/diagnose":
        // 排查用，只走本机 HTTP（带令牌），不挂 MCP 工具
        return this.manager?.backend?.diagnoseGrid ? this.manager.backend.diagnoseGrid(params.id) : { ok: false, reason: "账号窗口后端没就绪" };

      case "status":
        return {
          profiles: (await this.manager.list()).length,
          openWindows: this.manager.openCount,
          allowEval: this.allowEval,
          // 插件没连上时这里会是 ready:false + 「未就绪」说明，别让账号窗口静默地没有保护
          humanTakeover: await this.#humanTakeoverStatus(),
          // 最近的控制权交接 / 审批事件（完整审计在 Bridge 的 call-log）
          recentAudit: this.recentAudit.slice(-10),
        };

      case "list":
        return { profiles: await this.manager.list() };

      case "open": {
        // AI 传的网址只放行 http / https：file:// 能读本机文件，javascript: 会绕过 eval 开关直接在页面里执行
        const url = params.url ? checkSiteUrl(params.url) : undefined;
        const result = await this.manager.openWindow(id, { url });
        return { id, reused: result.reused, partition: result.partition, url: result.url ?? null, slot: result.slot ?? null };
      }

      case "close":
        return this.manager.closeWindow(id);

      case "space/list": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.listSpaces !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持空间");
        return backend.listSpaces(id);
      }

      case "space/open": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.spaceOpen !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持空间");
        const name = String(params.name ?? "").trim();
        if (!name) throw codedError("INVALID_ARGUMENT", "space_open 要给空间起个名字");
        // 格子没开就先开它（走 browser_open 同一条 BrowserOS 打开流程），再开空间：
        // AI 只该关心「在哪个格子开空间」，不该先自己猜要不要 browser_open
        const openedGrid = await this.#ensureGridOpen(id);
        const result = await backend.spaceOpen(id, { name, url: params.url, keep: params.keep === undefined ? undefined : params.keep === true });
        // 开空间本身也是一次 AI 活动：空闲计时从这一刻算
        if (result?.space?.id) this.#noteSpaceActivity(id, result.space.id, params.sessionId);
        return openedGrid ? { ...result, gridOpened: true } : result;
      }

      case "space/close": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.spaceClose !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持空间");
        const space = String(params.space ?? "").trim();
        if (!space) throw codedError("INVALID_ARGUMENT", "space_close 要给空间 id 或名字");
        await this.#assertSpaceWriteAllowed(id, space, "space_close");
        return backend.spaceClose(id, space);
      }

      case "space/handoff":
        return this.spaceHandoff(id, params);

      // 人交还控制权的本机调试入口：POST /control/<令牌>/space/return { id, space, reason? }
      // 不走 MCP 工具（AI 不能自己把人交还的状态改回去），也不做 UI。
      case "space/return":
        return this.spaceReturn(id, params);

      case "pin/list": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.pinList !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持钉住");
        // 不给 space 就是「我的」（backend 里解析成 home）
        return backend.pinList(id, params.space);
      }

      case "pin/add": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.pinAdd !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持钉住");
        const space = String(params.space ?? "").trim();
        if (!space) throw codedError("INVALID_ARGUMENT", "pin_add 要给空间 id 或名字（AI 默认钉在自己的空间里）");
        const url = checkSiteUrl(params.url, { allowBlank: false });
        if (!url) throw codedError("INVALID_ARGUMENT", "pin_add 要给 url");
        return backend.pinAdd(id, space, { url, title: params.title });
      }

      case "pin/remove": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.pinRemove !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持钉住");
        const space = String(params.space ?? "").trim();
        if (!space) throw codedError("INVALID_ARGUMENT", "pin_remove 要给空间 id 或名字");
        const pin = String(params.pin ?? "").trim();
        if (!pin) throw codedError("INVALID_ARGUMENT", "pin_remove 要给钉住 id");
        return backend.pinRemove(id, space, pin);
      }

      case "pin/open": {
        const backend = this.manager?.backend;
        if (!backend || typeof backend.pinGet !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持钉住");
        const space = String(params.space ?? "").trim();
        if (!space) throw codedError("INVALID_ARGUMENT", "pin_open 要给空间 id 或名字");
        const pin = String(params.pin ?? "").trim();
        if (!pin) throw codedError("INVALID_ARGUMENT", "pin_open 要给钉住 id");
        // 钉住的网址只在插件里：先经插件会话按 id（或网址）拿到，再和 navigate 走同一条路
        const found = await backend.pinGet(id, space, pin);
        const url = checkSiteUrl(found.pin.url, { allowBlank: false });
        const tab = this.resolveTab(id, found.space);
        this.#assertTaskNotStopped(tab.wc);
        await tab.window.loadURL(url);
        return { id, space: tab.space ?? null, url, pin: found.pin.id };
      }

      case "extension/list": {
        // 只读：共享插件库清单 + 每个开着的格子装了哪些插件。安装 / 移除只能人在侧边栏点，不给 AI 工具。
        const backend = this.manager?.backend;
        if (!backend || typeof backend.extensionList !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持插件清单");
        return backend.extensionList();
      }

      case "extension/sync": {
        // 只写 External Extensions 清单（插件 id + 更新地址），不复制插件文件、登录和任何数据目录。
        const backend = this.manager?.backend;
        if (!backend || typeof backend.extensionSync !== "function") throw codedError("INVALID_ARGUMENT", "这个版本不支持插件同步");
        const rawFrom = String(params.from ?? "").trim();
        if (!rawFrom) throw codedError("INVALID_ARGUMENT", "extension_sync 要给 from（源格子：账号 id、名字或格子编号）");
        const from = await this.#resolveTargetId(rawFrom);
        const to = [];
        for (const key of stringList(params.to)) to.push(await this.#resolveTargetId(key));
        const ids = stringList(params.ids);
        return backend.extensionSync({ from, to: to.length ? to : null, ids: ids.length ? ids : null });
      }

      case "navigate": {
        const tab = this.resolveTab(id, params.space);
        this.#assertTaskNotStopped(tab.wc);
        await this.#assertSpaceWriteAllowed(id, tab.space, "navigate");
        const url = checkSiteUrl(params.url, { allowBlank: true });
        if (!url) throw codedError("INVALID_ARGUMENT", "navigate 要给 url");
        await tab.window.loadURL(url);
        await this.#showLegacyOverlay(id, tab, { label: `打开网址：${url}` });
        // 站点常把目标网址重定向（维基首页 → /wiki/…、登录墙、反爬页）：返回里给出最终地址和标题，
        // 别让 AI 以为「我跳到的就是 requested 那个地址」（t3 报告：重定向后 origin 还是旧的）。
        const finalUrl = safeUrl(tab.wc) || url;
        const surface = await this.surfaceFor(id, tab.wc, tab.space).catch(() => null);
        const { waitForNavigationSettle } = await loadSurfaceModules();
        const settle = surface ? await waitForNavigationSettle(surface.cdp, { previousUrl: url, graceMs: 600 }).catch(() => null) : null;
        return {
          id,
          space: tab.space ?? null,
          url: finalUrl,
          requestedUrl: url,
          title: settle?.title || safeTitle(tab.wc),
          redirected: finalUrl !== url,
          ...(settle && !settle.settled ? { stillLoading: true, settleReason: settle.reason } : {}),
        };
      }

      case "layout": {
        // 不给 id 就用当前 slot 1；给了 id 就以那个格子为基准（它会变成 slot 1）
        const result = await this.manager.applyLayout(params.id ?? null, params.layout);
        return { id: params.id ?? null, layout: result.layout, assigned: result.assigned, created: result.created, hidden: result.hide, workArea: result.workArea };
      }

      case "show":
        return this.manager.show(id);

      case "hide":
        return this.manager.hide(id);

      case "page/snapshot":
        return this.pageSnapshot(id, params);

      case "page/act":
        return this.pageAct(id, params);

      case "page/read":
        return this.pageRead(id, params);

      case "snapshot":
        return this.snapshot(id, params);

      case "click":
        return this.click(id, params);

      case "type":
        return this.typeText(id, params);

      case "screenshot":
        return this.screenshot(id, params);

      case "eval":
        return this.evalScript(id, params);

      case "wait":
        return this.waitFor(id, params);

      case "back":
      case "forward":
      case "reload": {
        const tab = this.resolveTab(id, params.space);
        this.#assertTaskNotStopped(tab.wc);
        await this.#assertSpaceWriteAllowed(id, tab.space, action);
        // 对话框开着时后退 / 前进 / 刷新也会被堵住：先让 AI 用 page_act action:"dialog" 关掉
        {
          const surface = this.surfaces.get(tab.wc.id);
          if (surface?.cdp?.dialog) throw this.#dialogOpenError(surface);
        }
        const urlBefore = safeUrl(tab.wc);
        if (action === "back") tab.wc.navigationHistory.goBack();
        if (action === "forward") tab.wc.navigationHistory.goForward();
        if (action === "reload") tab.wc.reload();
        // 后退 / 前进在 SPA 里是异步换页（t3 报告：第一次快照拿到空壳，2 秒后才恢复），
        // 所以这里等页面真的稳下来再报地址，别拿「刚发完命令那一刻」的缓存交差。
        const surface = await this.surfaceFor(id, tab.wc, tab.space).catch(() => null);
        const { waitForNavigationSettle } = await loadSurfaceModules();
        const settle = surface
          ? await waitForNavigationSettle(surface.cdp, { previousUrl: urlBefore, expectChange: action !== "reload", graceMs: 900 }).catch(() => null)
          : null;
        if (!settle) await new Promise((r) => setTimeout(r, 1200));
        return {
          id,
          space: tab.space ?? null,
          url: settle?.url || safeUrl(tab.wc),
          title: settle?.title || safeTitle(tab.wc),
          navigated: Boolean(settle?.navigated) || (safeUrl(tab.wc) !== urlBefore),
          ...(settle && !settle.settled ? { stillLoading: true, settleReason: settle.reason } : {}),
          action,
        };
      }

      case "key": {
        const tab = this.resolveTab(id, params.space);
        this.#assertHumanFree(tab.wc);
        this.#assertTaskNotStopped(tab.wc);
        await this.#assertSpaceWriteAllowed(id, tab.space, "key");
        const key = String(params.key ?? "Enter");
        this.#beginAiInput(tab.wc);
        try {
          tab.wc.sendInputEvent({ type: "keyDown", keyCode: key });
          tab.wc.sendInputEvent({ type: "keyUp", keyCode: key });
        } finally {
          this.#endAiInput(tab.wc);
        }
        await new Promise(r => setTimeout(r, 400));
        await this.#showLegacyOverlay(id, tab, { label: `按键：${key}` });
        return { id, space: tab.space ?? null, key };
      }

      case "scroll": {
        const tab = this.resolveTab(id, params.space);
        this.#assertTaskNotStopped(tab.wc);
        const amount = Number(params.amount ?? 600);
        this.#beginAiInput(tab.wc);
        try {
          await tab.wc.executeJavaScript(`window.scrollBy(0, ${amount}); "ok"`).catch(() => {});
        } finally {
          this.#endAiInput(tab.wc);
        }
        await new Promise(r => setTimeout(r, 300));
        await this.#showLegacyOverlay(id, tab, { label: "滚动" });
        return { id, space: tab.space ?? null, scrolled: amount };
      }

      default:
        throw new Error(`不认识的操作：${action}`);
    }
  }

  /** 页面快照：标题、地址、可见文本、可交互元素清单 —— 让模型「看见」页面。 */
  async snapshot(id, params) {
    const tab = this.resolveTab(id, params.space);
    const wc = tab.wc;
    // 对话框开着时 executeJavaScript 会被堵到超时：先让 AI 去关掉它
    const surface = this.surfaces.get(wc.id);
    if (surface?.cdp?.dialog) throw this.#dialogOpenError(surface);
    await wc.executeJavaScript(PAGE_HELPERS).catch(() => {});
    const maxChars = Number(params.maxChars ?? 4000);
    const data = await wc.executeJavaScript(`
      (() => {
        const h = window.__bridgeHelpers;
        const text = (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          text: text.slice(0, ${maxChars}),
          textLength: text.length,
          elements: h ? h.outline() : [],
        };
      })()
    `);
    return { id, space: tab.space ?? null, ...data, truncated: data.textLength > maxChars };
  }

  /** 点击：优先用 CSS 选择器，其次用可见文字（对中文界面更友好）。 */
  async click(id, params) {
    const tab = this.resolveTab(id, params.space);
    const wc = tab.wc;
    // BrowserOS 的 click 是 executeJavaScript 里点 DOM，不走 Input.*，适配层的 blockInput 拦不到它，这里单独把门
    this.#assertHumanFree(wc);
    this.#assertTaskNotStopped(wc);
    await this.#assertSpaceWriteAllowed(id, tab.space, "click");
    const controlBefore = (await this.#spaceControl(id, tab.space))?.control?.state ?? "ai_running";
    // 对话框开着时 executeJavaScript 会被堵到超时（不是动作失败，是页面在等一个模态框）
    {
      const surface = this.surfaces.get(wc.id);
      if (surface?.cdp?.dialog) throw this.#dialogOpenError(surface);
    }
    await wc.executeJavaScript(PAGE_HELPERS).catch(() => {});
    const selector = JSON.stringify(params.selector ?? null);
    const text = JSON.stringify(params.text ?? null);
    // 提交边界 + 三态：判定函数注入页面，命中了就在页面里停下，一个事件都不发
    const policy = await loadSurfaceModules();
    const boundaryCheck = policy.commitBoundaryCheckSource();
    const confirmed = params.confirm === true;
    this.#beginAiInput(wc);
    let result;
    try {
      result = await wc.executeJavaScript(`
        (() => {
          const h = window.__bridgeHelpers;
          if (!h) return { ok: false, reason: "辅助函数未注入" };
          const el = h.locate(${selector}, ${text});
          if (!el) return { ok: false, reason: "没找到目标元素" };
          const label = h.label(el);
          const boundaryHit = (${boundaryCheck})(label);
          const blocked = !${confirmed} && boundaryHit;
          if (blocked) {
            return { ok: false, blocked: true, reason: "commit_boundary", label };
          }
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.focus?.();
          el.click();
          const rect = el.getBoundingClientRect();
          return { ok: true, tag: el.tagName.toLowerCase(), label, boundaryHit, selector: h.cssPath(el), point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
        })()
      `);
    } finally {
      this.#endAiInput(wc);
    }
    if (result?.blocked) {
      // 事件没发出：failed + dispatched:false，带 NEEDS_CONFIRM 让模型先问人
      const error = codedError("NEEDS_CONFIRM", `「${result.label}」是不可撤销的提交动作，没有 confirm:true 不执行`);
      Object.assign(error, policy.confirmRequired({ target: result.label }), { outcome: "failed", dispatched: false });
      await this.#recordApproval(id, tab.space, { allowed: false, target: result.label, from: controlBefore });
      throw error;
    }
    if (!result.ok) throw new Error(result.reason + (params.text ? `（文字：${params.text}）` : params.selector ? `（选择器：${params.selector}）` : ""));
    if (confirmed && result.boundaryHit) {
      await this.#recordApproval(id, tab.space, { allowed: true, target: result.label, from: controlBefore });
    }
    // 到这里 DOM 点击已经发生：之后任何失败都只能算 unknown（可能已生效）
    let outcome = { outcome: "dispatched", dispatched: true, expectMet: null };
    try {
      await new Promise(r => setTimeout(r, Number(params.waitMs ?? 900)));
      await this.#showLegacyOverlay(id, tab, { label: `点击：${result.label || result.selector || ""}`, point: result.point ?? null });
      const expectMet = await this.#waitForExpect(wc, params.expect);
      outcome = { ...policy.decideOutcome({ dispatched: true, expectSatisfied: expectMet === true }), expectMet };
    } catch (error) {
      const wrapped = new Error(error.message);
      wrapped.code = "ACT_FAILED";
      Object.assign(wrapped, { outcome: "unknown", dispatched: true, target: result.label, next_step: policy.OUTCOME_NEXT_STEP.unknown });
      throw wrapped;
    }
    return {
      id,
      clicked: result,
      url: wc.getURL(),
      target: result.label ?? null,
      ...outcome,
      next_step: outcome.expectMet === false
        ? "事件已经发出，但 expect 没在超时内读到：先 page_snapshot / page_read 读回确认，不要直接再点"
        : policy.OUTCOME_NEXT_STEP[outcome.outcome],
    };
  }

  /** 填输入框：用原生 setter 写值，再派发 input/change 事件（React 这类框架才认）。 */
  async typeText(id, params) {
    const tab = this.resolveTab(id, params.space);
    const wc = tab.wc;
    // 同上：type 也是 executeJavaScript 写值，得单独拦
    this.#assertHumanFree(wc);
    this.#assertTaskNotStopped(wc);
    await this.#assertSpaceWriteAllowed(id, tab.space, "type");
    {
      const surface = this.surfaces.get(wc.id);
      if (surface?.cdp?.dialog) throw this.#dialogOpenError(surface);
    }
    await wc.executeJavaScript(PAGE_HELPERS).catch(() => {});
    const selector = JSON.stringify(params.selector ?? null);
    const text = JSON.stringify(params.text ?? null);
    const value = JSON.stringify(String(params.value ?? ""));
    const submit = Boolean(params.submit);
    // 提交边界不套在输入上：往「删除原因」这类输入框里打字不该被拦（点击 / 回车才拦）
    const policy = await loadSurfaceModules();
    this.#beginAiInput(wc);
    let result;
    try {
      result = await wc.executeJavaScript(`
      (() => {
        const h = window.__bridgeHelpers;
        if (!h) return { ok: false, reason: "辅助函数未注入" };
        const el = h.locate(${selector}, ${text});
        if (!el) return { ok: false, reason: "没找到输入框" };
        const label = h.label(el);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, ${value}); else el.value = ${value};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const rect = el.getBoundingClientRect();
        const sensitive = typeof h.sensitive === "function" ? h.sensitive(el) : false;
        if (${submit}) {
          const form = el.form;
          if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
          else {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          }
        }
        return { ok: true, tag: el.tagName.toLowerCase(), label, submitted: ${submit}, sensitive, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
      })()
    `);
    } finally {
      this.#endAiInput(wc);
    }
    if (!result.ok) throw new Error(result.reason);
    // 写值 + input/change 已经派发：之后失败只能算 unknown
    let outcome = { outcome: "dispatched", dispatched: true, expectMet: null };
    try {
      await new Promise(r => setTimeout(r, Number(params.waitMs ?? 900)));
      // 密码框（或像密码的框）只显示 ••••，不把输入内容画到覆盖层上
      const typed = String(params.value ?? "");
      const overlayLabel = result.sensitive === true ? "输入：••••" : `输入：${typed.length > 20 ? `${typed.slice(0, 20)}…` : typed}`;
      await this.#showLegacyOverlay(id, tab, { label: overlayLabel, point: result.point ?? null });
      const expectMet = await this.#waitForExpect(wc, params.expect);
      outcome = { ...policy.decideOutcome({ dispatched: true, expectSatisfied: expectMet === true }), expectMet };
    } catch (error) {
      const wrapped = new Error(error.message);
      wrapped.code = "ACT_FAILED";
      Object.assign(wrapped, { outcome: "unknown", dispatched: true, target: result.label, next_step: policy.OUTCOME_NEXT_STEP.unknown });
      throw wrapped;
    }
    return {
      id,
      typed: result,
      url: wc.getURL(),
      target: result.label ?? null,
      ...outcome,
      next_step: outcome.expectMet === false
        ? "事件已经发出，但 expect 没在超时内读到：先 page_snapshot / page_read 读回确认，不要直接再填"
        : policy.OUTCOME_NEXT_STEP[outcome.outcome],
    };
  }

  /**
   * 截图：返回 base64 PNG。
   *
   * BrowserOS 标签页外观的 capturePage 本来就是 CDP 抓的，而且认 maxWidth，
   * 不存在「被遮挡就挂住」的问题，也不需要把窗口提到前台。
   */
  async screenshot(id, params) {
    const tab = this.resolveTab(id, params.space);
    const wc = tab.wc;
    const maxWidth = Number(params.maxWidth ?? 0);
    const attempts = ["BrowserOS 标签页直接抓（CDP）"];
    try {
      const image = await withTimeout(wc.capturePage(maxWidth > 0 ? { maxWidth } : undefined), 6000, "capturePage");
      if (!image || image.isEmpty()) throw new Error("返回空图");
      const buffer = image.toPNG();
      const size = image.getSize?.() ?? pngSize(buffer);
      return {
        id, space: tab.space ?? null, via: "cdp", format: "png",
        width: size.width, height: size.height,
        bytes: buffer.length,
        base64: buffer.toString("base64"),
        attempts,
      };
    } catch (error) {
      attempts.push(`BrowserOS 标签页直接抓失败：${error.message}`);
      throw new Error(`截图失败。尝试过程：${attempts.join("；")}`);
    }
  }

  /** 执行任意 JS：默认关闭，因为等于把页面完全交出去。 */
  async evalScript(id, params) {
    if (!this.allowEval) {
      throw new Error("eval 操作未开启。启动时加 --allow-eval 才能用（这等于把页面控制权完全交出去，默认关着更安全）。");
    }
    const tab = this.resolveTab(id, params.space);
    this.#assertTaskNotStopped(tab.wc);
    await this.#assertSpaceWriteAllowed(id, tab.space, "eval");
    const script = String(params.script ?? "");
    if (!script.trim()) throw new Error("script 不能为空");
    const value = await tab.wc.executeJavaScript(`(async () => { ${script} })()`);
    return { id, value: typeof value === "object" ? JSON.stringify(value).slice(0, 4000) : String(value).slice(0, 4000) };
  }

  /** 等条件满足：等文字出现、等选择器出现、或等页面加载完。 */
  async waitFor(id, params) {
    const tab = this.resolveTab(id, params.space);
    const wc = tab.wc;
    const timeout = Number(params.timeoutMs ?? 15000);
    const deadline = Date.now() + timeout;
    const selector = JSON.stringify(params.selector ?? null);
    const text = JSON.stringify(params.text ?? null);
    await wc.executeJavaScript(PAGE_HELPERS).catch(() => {});

    while (Date.now() < deadline) {
      const hit = await wc.executeJavaScript(`
        (() => {
          const h = window.__bridgeHelpers;
          if (${text} !== null) {
            const needle = ${text}.toLowerCase();
            const body = ((document.title || "") + " " + (document.body?.innerText || "")).toLowerCase();
            return body.includes(needle) ? { found: true, how: "文字" } : { found: false };
          }
          if (${selector} !== null) {
            const el = h ? h.find(${selector}) : document.querySelector(${selector});
            return el ? { found: true, how: "选择器" } : { found: false };
          }
          return { found: document.readyState === "complete", how: "加载完成" };
        })()
      `).catch(() => ({ found: false }));
      if (hit.found) return { id, waited: true, how: hit.how, elapsedMs: timeout - (deadline - Date.now()) };
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error(`等待超时（${timeout}ms）${params.text ? `，没等到文字「${params.text}」` : params.selector ? `，没等到元素 ${params.selector}` : ""}`);
  }
}

/** 读发现文件，拿到控制服务地址（给 MCP 工具用）。 */
async function readDiscovery() {
  try {
    const raw = await fs.promises.readFile(DISCOVERY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.url) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  BrowserControlServer,
  HumanTakeoverWatcher,
  readDiscovery,
  DISCOVERY_FILE,
  PAGE_HELPERS,
  HUMAN_TAKEOVER_POLL_MS,
};
