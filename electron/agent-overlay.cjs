/**
 * AI 光标 + 控制条覆盖层（「AI 自己的鼠标」第一阶段，不编译浏览器）。
 *
 * 思路（按产品计划 2026-10-26「AI 自己的鼠标」，参考 Ego Lite）：
 *   主程序经 CDP 在账号窗口的标签页里建一个专用 isolated world（Page.createIsolatedWorld），
 *   把画界面用的脚本只在那个 world 里执行；页面主世界从头到尾拿不到这些函数。
 *   界面的宿主元素挂在 documentElement 上，带 closed shadow root —— 网页脚本改不了里面的内容；
 *   宿主本身 aria-hidden + role=presentation，进不了语义快照（AX 树）和正文读取。
 *
 * 防伪造为什么不能只靠 isTrusted：
 *   CDP 的 Input.dispatchMouseEvent 派发出来的点击事件 isTrusted 也是 true，页面脚本伪造的
 *   反而是 false。所以按钮事件回到主程序后还要再过两道（见 browser-control.cjs 的 #onOverlayButton）：
 *   那一刻 AI 没有正在给这个标签页派发输入、插件报这个格子窗口拿到了系统焦点。
 *   本模块只负责「把带 isTrusted 的点击原样传回去」，判断都在主程序。
 *
 * 出错一律静默：这是显示层，任何一步失败都不能影响 AI 动作本身的成功率。
 */

/** isolated world 的名字：binding 也只加在这个名字的执行上下文上，页面主世界拿不到 */
const WORLD_NAME = "windrise-agent-ui";
/** 按钮点击经这个 binding 回主程序（只存在于上面的 isolated world 里） */
const BINDING_NAME = "windriseOverlayAction";
/** AI 空闲多久后整个覆盖层淡出（毫秒） */
const IDLE_FADE_MS = 8_000;

/**
 * 注入到 isolated world 里的界面脚本：光标（紫色箭头 + 光晕，300ms 平滑移动）、
 * 动作标签、顶部提示条、底部控制条。全部画在 closed shadow root 里，宿主不可见也不可点。
 */
const OVERLAY_SCRIPT = `
(() => {
  "use strict";
  if (globalThis.__windriseOverlay) return;
  var BINDING = ${JSON.stringify(BINDING_NAME)};
  var FADE_MS = ${IDLE_FADE_MS};
  var send = function (action, event) {
    var fn = globalThis[BINDING];
    if (typeof fn !== "function") return;
    try { fn(JSON.stringify({ action: action, isTrusted: Boolean(event && event.isTrusted), at: Date.now() })); } catch (e) { /* 静默 */ }
  };
  var host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("role", "presentation");
  host.style.cssText = "position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483646!important;pointer-events:none!important;opacity:0;transition:opacity 400ms ease;";
  var shadow = host.attachShadow({ mode: "closed" });
  var style = document.createElement("style");
  style.textContent = [
    ":host { all: initial; }",
    "* { box-sizing: border-box; margin: 0; padding: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; color: #f5f3ff; user-select: none; }",
    ".wr-top { position: fixed; left: 0; top: 0; right: 0; height: 26px; display: flex; align-items: center; justify-content: center; background: linear-gradient(90deg, rgba(124,58,237,.95), rgba(168,85,247,.95), rgba(124,58,237,.95)); box-shadow: 0 0 12px rgba(139,92,246,.9), 0 1px 0 rgba(196,181,253,.9); letter-spacing: .5px; z-index: 2; }",
    ".wr-cursor { position: fixed; left: 0; top: 0; will-change: transform; pointer-events: none; z-index: 2; }",
    ".wr-cursor svg { display: block; filter: drop-shadow(0 0 6px rgba(139,92,246,.95)) drop-shadow(0 1px 2px rgba(0,0,0,.35)); }",
    ".wr-label { position: absolute; left: 24px; top: 20px; max-width: min(320px, 60vw); padding: 3px 8px; border-radius: 8px; background: rgba(76,29,149,.92); border: 1px solid rgba(196,181,253,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 10px rgba(76,29,149,.5); pointer-events: none; }",
    ".wr-bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 7px 10px 7px 14px; border-radius: 999px; background: rgba(30,27,75,.95); border: 1px solid rgba(196,181,253,.5); box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 14px rgba(139,92,246,.35); pointer-events: auto; z-index: 2; }",
    ".wr-status { color: #e9d5ff; white-space: nowrap; }",
    ".wr-btn { pointer-events: auto; cursor: pointer; padding: 5px 14px; border-radius: 999px; border: 1px solid rgba(196,181,253,.6); background: rgba(139,92,246,.25); color: #f5f3ff; white-space: nowrap; }",
    ".wr-btn:hover { background: rgba(139,92,246,.5); }",
    ".wr-stop { border-color: rgba(251,113,133,.6); background: rgba(244,63,94,.18); }",
    ".wr-stop:hover { background: rgba(244,63,94,.4); }",
  ].join("\\n");
  var top = document.createElement("div");
  top.className = "wr-top";
  top.textContent = "AI 正在这个标签页工作";
  var cursor = document.createElement("div");
  cursor.className = "wr-cursor";
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3l13.5 8.2-6.2 1.4-2.6 7.9L5 3z" fill="#a78bfa" stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  var label = document.createElement("div");
  label.className = "wr-label";
  cursor.appendChild(label);
  var bar = document.createElement("div");
  bar.className = "wr-bar";
  var status = document.createElement("span");
  status.className = "wr-status";
  status.textContent = "Agent 正在控制";
  var btnTakeover = document.createElement("button");
  btnTakeover.type = "button";
  btnTakeover.className = "wr-btn";
  btnTakeover.textContent = "接管";
  var btnHandback = document.createElement("button");
  btnHandback.type = "button";
  btnHandback.className = "wr-btn";
  btnHandback.textContent = "交还给 AI";
  btnHandback.style.display = "none";
  var btnStop = document.createElement("button");
  btnStop.type = "button";
  btnStop.className = "wr-btn wr-stop";
  btnStop.textContent = "终止任务";
  bar.appendChild(status);
  bar.appendChild(btnTakeover);
  bar.appendChild(btnHandback);
  bar.appendChild(btnStop);
  shadow.appendChild(style);
  shadow.appendChild(top);
  shadow.appendChild(cursor);
  shadow.appendChild(bar);
  (document.documentElement || document.body).appendChild(host);

  var lastPoint = null;
  var hideTimer = null;
  // 当前模式：ai 才会自动淡出；human / stopped 要一直留着「交还给 AI」按钮
  var mode = "ai";
  // 淡出时控制条看不见但还能点会挡住网页：初始和淡出都关掉它的点击
  bar.style.pointerEvents = "none";
  function cancelFade() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function show() {
    // 显隐直接改宿主的内联 opacity：shadow 里的 .wr-visible 选不中 shadow 外的宿主
    host.style.setProperty("opacity", "1", "important");
    bar.style.pointerEvents = "auto";
    cancelFade();
    if (mode === "ai") hideTimer = setTimeout(fade, FADE_MS);
  }
  function fade() {
    hideTimer = null;
    host.style.setProperty("opacity", "0", "important");
    bar.style.pointerEvents = "none";
  }
  function moveTo(x, y) {
    var px = Math.max(-8, Math.min(x, (window.innerWidth || 0) - 8));
    var py = Math.max(-8, Math.min(y, (window.innerHeight || 0) - 8));
    cursor.style.transition = lastPoint ? "transform 300ms ease" : "none";
    cursor.style.transform = "translate(" + px + "px," + py + "px)";
    lastPoint = { x: px, y: py };
  }
  function setMode(next) {
    mode = next === "human" || next === "stopped" ? next : "ai";
    if (mode === "human") {
      status.textContent = "你在控制";
      btnTakeover.style.display = "none";
      btnHandback.style.display = "";
      btnStop.style.display = "none";
      top.style.display = "none";
    } else if (mode === "stopped") {
      status.textContent = "已终止";
      btnTakeover.style.display = "none";
      btnHandback.style.display = "";
      btnStop.style.display = "none";
      top.style.display = "none";
    } else {
      status.textContent = "Agent 正在控制";
      btnTakeover.style.display = "";
      btnHandback.style.display = "none";
      btnStop.style.display = "";
      top.style.display = "";
    }
  }
  btnTakeover.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); send("takeover", event); });
  btnHandback.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); send("handback", event); });
  btnStop.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); send("stop", event); });
  // 人把鼠标悬到控制条上：先别淡出
  bar.addEventListener("mouseenter", show);
  globalThis.__windriseOverlay = {
    cursor: function (x, y, text) {
      if (typeof x === "number" && isFinite(x) && typeof y === "number" && isFinite(y)) moveTo(x, y);
      if (typeof text === "string" && text) label.textContent = text;
      show();
    },
    action: function (text) {
      if (typeof text === "string" && text) label.textContent = text;
      show();
    },
    state: function (mode) {
      setMode(mode);
      show();
    },
    hide: fade,
  };
})();
`;

/**
 * 一个标签页（surface）一份的覆盖层控制器。
 * @param {{ cdp: { send: Function, onEvent?: Function, mainFrameId?: string|null }, enabled?: () => boolean,
 *           onButton?: (message: { action: string, isTrusted: boolean, at?: number }) => void, log?: (m: string) => void }} options
 */
class AgentOverlay {
  constructor({ cdp, enabled = () => true, onButton = null, log = () => {} } = {}) {
    if (!cdp || typeof cdp.send !== "function") throw new Error("AgentOverlay 需要 TargetSurface 形状的 CDP 适配层");
    this.cdp = cdp;
    this.enabled = typeof enabled === "function" ? enabled : () => true;
    this.onButton = typeof onButton === "function" ? onButton : null;
    this.log = typeof log === "function" ? log : () => {};
    /** isolated world 在主框架里的执行上下文 id；导航后作废，按需重建 */
    this.contextId = null;
    this.bindingOn = false;
    this.offBinding = null;
    this.disposed = false;
    this.ensuring = null;
  }

  /** 建 world + 加 binding + 注入脚本。幂等；导航后 contextId 会作废，下次再走一遍。 */
  async ensure() {
    if (this.disposed) return false;
    if (!this.enabled()) { await this.#bestEffort("globalThis.__windriseOverlay && globalThis.__windriseOverlay.hide()"); return false; }
    if (this.contextId) return true;
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.#doEnsure().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  async #doEnsure() {
    try {
      if (this.disposed || !this.enabled()) return false;
      const frameId = this.cdp.mainFrameId || await this.#mainFrameId();
      if (!frameId) { this.log("拿不到主框架 id，覆盖层不画"); return false; }
      const created = await this.cdp.send("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME, grantUniveralAccess: false });
      const contextId = created?.executionContextId;
      if (!contextId) { this.log("createIsolatedWorld 没给 executionContextId，覆盖层不画"); return false; }
      if (!this.bindingOn) {
        await this.cdp.send("Runtime.addBinding", { name: BINDING_NAME, executionContextName: WORLD_NAME });
        this.offBinding = this.cdp.onEvent?.("Runtime.bindingCalled", (params, sessionId) => this.#onBinding(params, sessionId)) || null;
        this.bindingOn = true;
      }
      await this.cdp.send("Runtime.evaluate", { expression: OVERLAY_SCRIPT, contextId, returnByValue: true });
      this.contextId = contextId;
      return true;
    } catch (error) {
      this.log(`覆盖层初始化失败（静默，不影响动作）：${error?.message || String(error)}`);
      return false;
    }
  }

  async #mainFrameId() {
    try {
      const tree = await this.cdp.send("Page.getFrameTree", {});
      return tree?.frameTree?.frame?.id || null;
    } catch {
      return null;
    }
  }

  /** bindingCalled 只收我们那个名字的载荷，转成对象交给主程序（判断都在主程序） */
  #onBinding(params, sessionId) {
    void sessionId;
    if (!params || params.name !== BINDING_NAME) return;
    if (typeof params.payload !== "string") return;
    let parsed = null;
    try { parsed = JSON.parse(params.payload); } catch { this.log("覆盖层按钮载荷不是合法 JSON，丢弃"); return; }
    if (!parsed || typeof parsed !== "object" || parsed === null) return;
    try { this.onButton?.(parsed); } catch (error) { this.log(`处理覆盖层按钮事件失败：${error?.message || String(error)}`); }
  }

  /** 在 isolated world 里执行一句；world 没了（导航后）就重置，下次动作重建 */
  async #eval(expression) {
    if (this.disposed) return;
    if (!(await this.ensure())) return;
    try {
      await this.cdp.send("Runtime.evaluate", { expression, contextId: this.contextId, returnByValue: true });
    } catch {
      this.contextId = null;
      if (await this.ensure()) {
        try {
          await this.cdp.send("Runtime.evaluate", { expression, contextId: this.contextId, returnByValue: true });
        } catch { /* 再失败就算了：下次动作还会重试 */ }
      }
    }
  }

  async #bestEffort(expression) {
    if (!this.contextId) return;
    try { await this.cdp.send("Runtime.evaluate", { expression, contextId: this.contextId, returnByValue: true }); } catch { this.contextId = null; }
  }

  /** 光标移到 (x, y)（CSS 像素，主框架视口坐标）；页面里做 300ms 平滑移动 */
  async showCursor(x, y) {
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return;
    await this.#eval(`globalThis.__windriseOverlay && globalThis.__windriseOverlay.cursor(${x}, ${y}, null)`);
  }

  /** 动作标签，例如「点击：发送」 */
  async showAction(label) {
    const text = String(label ?? "");
    if (!text) return;
    await this.#eval(`globalThis.__windriseOverlay && globalThis.__windriseOverlay.action(${JSON.stringify(text)})`);
  }

  /** 控制条状态：ai（Agent 正在控制）/ human（你在控制）/ stopped（已终止） */
  async setState(state = {}) {
    const mode = state?.mode === "human" || state?.mode === "stopped" ? state.mode : "ai";
    await this.#eval(`globalThis.__windriseOverlay && globalThis.__windriseOverlay.state(${JSON.stringify(mode)})`);
  }

  dispose() {
    this.disposed = true;
    this.contextId = null;
    try { this.offBinding?.(); } catch { /* 忽略 */ }
    this.offBinding = null;
  }
}

module.exports = { AgentOverlay, OVERLAY_SCRIPT, WORLD_NAME, BINDING_NAME, IDLE_FADE_MS };
