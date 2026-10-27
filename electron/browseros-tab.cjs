/**
 * 标签页的「Electron 外观」：让 browser-control 那种只认 webContents 的老代码，
 * 以为自己在操作一个 Electron 页面，其实底下全是外部浏览器里的一个标签页。
 *
 * 为什么需要这一层：
 *   browser-control.cjs 到处直接摸 webContents：`wc.isDestroyed()`、`wc.getURL()`、`wc.executeJavaScript()`、
 *   `wc.sendInputEvent()`、`wc.capturePage()`、`wc.navigationHistory.goBack()`，还有 `wc.debugger.xxx` 和
 *   `wc.on("destroyed"| "did-navigate" | "did-navigate-in-page")`。这些在 Electron 里是现成的，外部浏览器里没有。
 *   与其把 browser-control 里几十处调用都改成走 CDP，不如在这里造一个形状一样的对象：调用方一行不改。
 *
 * 底下是谁：
 *   全部委托给 target-surface.cjs 的 TargetSurface（`send` / `onEvent` / `waitForEvent` / `getUrl` / `getTitle` /
 *   `isAttached` / `dispose`）。禁区判断（urlGuard）、超时、标签页没了立刻判死，这些都在会话层里，这一层不重复做。
 *
 * 几条必须守住的规矩（2026-10-24 契约 §4）：
 *   1. 绝不抢前台：不调 Target.activateTarget，也不调 Page.bringToFront。isFocused() 恒 false，
 *      isVisible() 恒 true，isMinimized() 恒 false —— 上层（browser-control 的截图阶梯、焦点守卫）靠这三个值分流。
 *   2. debugger.attach() 是**同步返回**的（SurfaceCdp 假定如此），会话在后台建；sendCommand 必须等这次 attach 建完再发。
 *      连发三条命令也只建一次会话。
 *   3. debugger.detach() 只把会话收掉，页面本身不动；下一条命令自动重建。会话死了要 emit("detach") 通知一次。
 *   4. dispose() 之后所有命令抛 TARGET_CLOSED，不当哑巴、也不假装成功。
 *
 * 和 Electron 行为不同的地方（都在下面注释里写明，不藏着）：
 *   - `reload()` / `goBack()` / `goForward()` 在 Electron 里是「返回 void 的即发即忘」，browser-control 也确实不 await。
 *     这里返回 Promise 方便测试和排查，但**自己挂了一个空 catch**：没人 await 也不会变成未处理拒绝把主进程打崩，
 *     await 的人仍然能拿到真实的错误。
 *   - 浏览器级事件（sessionId 为空的 Target.* / Browser.*）不转发给 debugger 的 message 监听：
 *     Electron 的一个 debugger 只绑一个页面，本来就看不到浏览器级事件，这里保持一样，免得上层误以为能跨标签页。
 */

const { EventEmitter } = require("node:events");
const { ROOT_SESSION } = require("./cdp-connection.cjs");

/** 标签页编号从 900001 起：browser-control 拿它当 Map 的 key，不能和 Electron 的 webContents.id 撞 */
const FIRST_TAB_ID = 900_001;
let nextTabId = FIRST_TAB_ID;

/** loadURL / 刷新 等一次 load；和 TargetSurface 的默认时限一致 */
const LOAD_TIMEOUT_MS = 15_000;
/** 导航之后隔多久去刷一次历史（canGoBack/canGoForward 是同步方法，只能读缓存） */
const HISTORY_REFRESH_MS = 150;
/**
 * 后退/前进之后最多等多久「页面真的换了」。
 * 2026-10-24 真机实测：这种历史跳转经常是 bfcache 恢复，**一个页面事件都不发**
 * （Page.frameNavigated / navigatedWithinDocument 都没有，等 5 秒也等不到），
 * 所以只能隔一会儿问一次页面「你现在在哪」。
 */
const HISTORY_POLL_MS = 3_000;
/** 导航之后隔多久去问一次 document.title（标题要等页面解析出来，问太早拿到的是空） */
const TITLE_REFRESH_MS = 180;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 小工具 ---------------- */

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function log(message) {
  // 和现有文件一个口味：中文、短、带前缀；不抛错（日志出问题不能影响正事）
  console.log(`[browseros-tab] ${message}`);
}

/**
 * Electron 的 keyCode（加速键写法）→ CDP Input.dispatchKeyEvent 要的几个字段。
 * 只收契约要求的那几个键；别的键记一句日志就算了，不装作能按。
 */
const KEYS = new Map([
  ["Enter", { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
  ["Return", { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
  ["Tab", { key: "Tab", code: "Tab", vk: 9 }],
  ["Escape", { key: "Escape", code: "Escape", vk: 27 }],
  ["Esc", { key: "Escape", code: "Escape", vk: 27 }],
  ["Backspace", { key: "Backspace", code: "Backspace", vk: 8 }],
  ["Delete", { key: "Delete", code: "Delete", vk: 46 }],
  ["Up", { key: "ArrowUp", code: "ArrowUp", vk: 38 }],
  ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", vk: 38 }],
  ["Down", { key: "ArrowDown", code: "ArrowDown", vk: 40 }],
  ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", vk: 40 }],
  ["Left", { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }],
  ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }],
  ["Right", { key: "ArrowRight", code: "ArrowRight", vk: 39 }],
  ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", vk: 39 }],
  ["Home", { key: "Home", code: "Home", vk: 36 }],
  ["End", { key: "End", code: "End", vk: 35 }],
  ["PageUp", { key: "PageUp", code: "PageUp", vk: 33 }],
  ["PageDown", { key: "PageDown", code: "PageDown", vk: 34 }],
  ["Space", { key: " ", code: "Space", vk: 32, text: " " }],
]);

/** 单字符补齐 code / 虚拟键码；认不出来就当普通文本按下去（text 才是真正决定插入什么的东西） */
function keyForChar(ch) {
  if (/^[a-zA-Z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  if (ch === " ") return { key: " ", code: "Space", vk: 32, text: " " };
  return { key: ch, code: "", vk: ch.toUpperCase().charCodeAt(0), text: ch };
}

/**
 * 直接从 PNG 字节里读真实像素宽高（IHDR 就在第 16、20 字节）。
 * 为什么要读字节而不是自己算：2026-10-24 真机实测，Chromium 的 `Page.captureScreenshot` 出的图是**设备像素**，
 * 一个 851 CSS 宽、devicePixelRatio=1.5 的页面截出来是 1277 宽 —— 按 CSS 算出来的尺寸会小一圈，
 * 上层就会以为「400 宽的图」其实是 600 宽。报告给别人的数字只能来自图片本身。
 */
function pngPixelSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* ---------------- debugger 外壳 ---------------- */

/**
 * 长得像 webContents.debugger 的东西。
 * SurfaceCdp 只用到这几样：isAttached() / attach() / detach() / sendCommand() / on("message"|"detach") / removeListener。
 * 另外 captureViaCdp 会先 attach("1.3")、事后 detach()，所以这些都得能重复调、能在 dispose 之后再调不炸。
 */
class TabDebugger {
  constructor(tab) {
    this.tab = tab;
    /** Map<"message"|"detach", Set<Function>> */
    this.listeners = new Map();
  }

  /** 现在有没有可用的会话（= 已经 attach 上、而且没死） */
  isAttached() {
    return this.tab._isSessionAlive();
  }

  /** 同步返回：会话在后台建，sendCommand 会等这次建完（SurfaceCdp 假定 attach() 是同步的） */
  attach() {
    this.tab._attachNow();
    return this;
  }

  /** 摘掉会话；页面本身不动。下一条命令会重建会话，并重新发一次 attach 的「隐含动作」 */
  detach() {
    this.tab._detachNow();
    return this;
  }

  /**
   * 发一条命令：
   *   sessionId 空（或没传）→ 这个页面；
   *   是本标签页的跨域 iframe 子会话 → 原样透传；
   *   别的会话 → 抛 SESSION_NOT_OURS（防串到别人的标签页）。
   */
  async sendCommand(method, params = {}, sessionId) {
    return this.tab._send(String(method), params || {}, sessionId);
  }

  on(event, handler) {
    if (typeof handler !== "function") return this;
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return this;
  }

  once(event, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    wrapped.__source = handler;
    return this.on(event, wrapped);
  }

  off(event, handler) {
    return this.removeListener(event, handler);
  }

  removeListener(event, handler) {
    const set = this.listeners.get(event);
    if (!set) return this;
    set.delete(handler);
    for (const fn of [...set]) if (fn.__source === handler) set.delete(fn);
    if (set.size === 0) this.listeners.delete(event);
    return this;
  }

  /** 内部用：把会话收到的事件交给监听器。参数形状照拷 Electron：({}, method, params, sessionId) */
  _emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return false;
    for (const handler of [...set]) {
      try { handler(...args); } catch (error) { log(`debugger 的 ${event} 监听器抛错了（不影响别的）：${error.message}`); }
    }
    return true;
  }

  /** facade 收掉时清干净，免得旧监听挂着已经不要的 SurfaceCdp */
  _clear() {
    this.listeners.clear();
  }
}

/* ---------------- 标签页 ---------------- */

class TabFacade extends EventEmitter {
  /**
   * @param {{
   *   targetId: string,
   *   sessionProvider: () => Promise<object>,
   *   label?: string,
   * }} options
   *   sessionProvider：每次调用都要给一个「已经 attach 好」的会话（TargetSurface 或同样形状的假货）。
   *   上一次的会话被 dispose 之后，再调一次要能 attach 出新的来。
   */
  constructor({ targetId, sessionProvider, label = "标签页" } = {}) {
    super();
    if (!targetId) throw codedError("TARGET_CLOSED", "标签页外观需要一个 targetId");
    if (typeof sessionProvider !== "function") throw codedError("SESSION_CLOSED", "标签页外观需要 sessionProvider（一个能给出已 attach 会话的函数）");
    this.id = nextTabId++;
    /**
     * 「我是外部浏览器的标签页」标记：browser-control 的截图分支靠它决定走哪条路
     * （普通 webContents 的 capturePage 不认参数，得走 captureViaCdp；这里认 maxWidth）。
     * 普通可枚举属性，谁都能读，不搞花活。
     */
    this.isBrowserOsTab = true;
    this.targetId = String(targetId);
    this.label = label || "标签页";
    this.sessionProvider = sessionProvider;
    /** 当前会话；null = 还没有 / 被摘掉了 */
    this.session = null;
    /** 正在建会话的那一次（三条命令同时来也只建一次） */
    this.sessionPending = null;
    /** 摘会话时要退订的东西 */
    this.sessionOffs = [];
    /** 页面没了（被关掉 / 浏览器退出）的原因；有值之后所有命令按 TARGET_CLOSED 拒 */
    this.gone = null;
    /** dispose 过了 */
    this.destroyed = false;
    /** "destroyed" 事件发过没有：判死那条路和 dispose 那条路共用一个标记，一辈子只发一次 */
    this.destroyedEmitted = false;
    this.mainFrameId = null;
    this.urlCache = null;
    this.titleCache = null;
    /** 页面自己报的 document.title（Electron 的 getTitle 给的就是它）；比会话层那份「网址当标题」靠谱 */
    this.documentTitle = null;
    this.titleTimer = null;
    /** 设备像素比缓存（截图缩放要用）；换会话重问 */
    this.dprCache = null;
    this.historyCache = null;
    this.historyTimer = null;
    /** 已经念叨过的告警，避免每帧刷一条 */
    this.warned = new Set();
    this.debugger = new TabDebugger(this);
  }

  /* ---------- 身份 ---------- */

  /** 就是自己：browser-control 到处拿「webContents」当 Map 的 key，必须是同一个对象 */
  get webContents() {
    return this;
  }

  isDestroyed() {
    return this.destroyed || Boolean(this.gone);
  }

  /** 绝不抢前台：外部浏览器那边这个标签页根本没被激活，说「有焦点」就是撒谎 */
  isFocused() {
    return false;
  }

  isVisible() {
    return true;
  }

  isMinimized() {
    return false;
  }

  /* 焦点守卫 / 老的窗口代码会顺手调这几个；对外部浏览器的标签页全是空动作，不报错 */
  focus() {}
  show() {}
  restore() {}
  hide() {}

  /* ---------- 网址 / 标题 ---------- */

  getURL() {
    // 自己这份缓存优先：它和 did-navigate 是同一条事件喂出来，刚刚发生过什么这里最清楚。
    // 缓存还是空的（刚建好、还没收到事件）才去问会话层要一次。
    if (!this.urlCache && this.session && typeof this.session.getUrl === "function") {
      const url = this.session.getUrl();
      if (url) this.urlCache = url;
    }
    return this.urlCache || "";
  }

  getTitle() {
    // 优先用页面自己报的 document.title；还没问到才退回会话层那份（它可能只是「网址当标题」）
    if (this.documentTitle) return this.documentTitle;
    if (!this.titleCache && this.session && typeof this.session.getTitle === "function") {
      const title = this.session.getTitle();
      if (title) this.titleCache = title;
    }
    return this.titleCache || "";
  }

  /* ---------- 导航 ---------- */

  /**
   * 打开网址，等 load。
   * 先订阅再导航，避免「页面比回包还快」的竞态。
   */
  async loadURL(url) {
    const target = String(url ?? "");
    if (!target) throw codedError("URL_UNKNOWN", `${this.label}：loadURL 要给一个网址`);
    const session = await this._sessionForCommand("Page.navigate");
    const loaded = this._waitLoad(session);
    let result;
    try {
      result = await this._send("Page.navigate", { url: target });
    } catch (error) {
      loaded.catch(() => {});
      throw error;
    }
    if (result?.errorText) throw codedError("CDP_ERROR", `${this.label}：导航到 ${target} 失败（${result.errorText}）`);
    await loaded;
    // load 到了就把标题问一次：上层紧接着调 getTitle() 才能拿到这一页的标题（不是上一页的）
    await this._refreshTitle();
    return result;
  }

  reload() {
    const work = (async () => {
      const session = await this._sessionForCommand("Page.reload");
      const loaded = this._waitLoad(session);
      await this._send("Page.reload", {});
      await loaded;
      return { reloaded: true };
    })();
    return this._quiet(work, "刷新");
  }

  goBack() {
    return this.navigationHistory.goBack();
  }

  goForward() {
    return this.navigationHistory.goForward();
  }

  /* ---------- 脚本 ---------- */

  /**
   * 在页面里跑一段脚本，拿返回值。
   * 页面自己抛错要抛出来（exceptionDetails），别把 undefined 当成功糊过去。
   */
  async executeJavaScript(code) {
    const expression = String(code ?? "");
    const result = await this._send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const details = result?.exceptionDetails;
    if (details) {
      const text = details.exception?.description
        || details.exception?.value
        || details.text
        || "页面脚本抛错（浏览器没给说明）";
      throw codedError("PAGE_ERROR", `${this.label}：页面里这段脚本抛错了 —— ${String(text).split("\n")[0]}`, {
        exceptionDetails: details,
      });
    }
    return result?.result?.value;
  }

  /* ---------- 截图 ---------- */

  /**
   * 截图。maxWidth > 0 时按「设备像素宽」判断要不要缩，让浏览器自己缩（clip.scale），不拿图片二次采样。
   * 返回的对象照 Electron 的 nativeImage 只做了上层用到的几个方法；resize() 直接还自己
   * （上层只在 maxWidth 没被满足时才调，正常调不到）。
   *
   * 两个真机上踩出来的坑（2026-10-24，BrowserOS 155）：
   *   1. clip 的坐标是 CSS 像素，但出来的图是**设备像素**：带 clip 时输出宽 = clip 宽 × dpr × scale；
   *      不带 clip 时输出宽 = CSS 宽 × dpr（页面 851 CSS 宽、dpr=1.5，整幅截出来是 1277 宽）。
   *      所以不能拿 CSS 宽跟 maxWidth 比：maxWidth 落在「CSS 宽 ≤ maxWidth < CSS 宽 × dpr」这段时，
   *      原来会以为不用缩，交出去一张比 maxWidth 还宽的图。要拿「CSS 宽 × dpr」这个设备像素宽比，
   *      scale 也按 maxWidth / (CSS 宽 × dpr) 算。
   *   2. 不同版本的算法不完全一样，所以最后再拿图片字节里真实宽度核对一遍；还宽就按实际比例补缩一次。
   *      宁可多截一张，也不能交一张比 maxWidth 还宽的图出去。
   */
  async capturePage(options = {}) {
    const { width, height } = await this._viewportSize();
    const maxWidth = Math.max(0, Number(options?.maxWidth ?? 0) || 0);
    // 不给 maxWidth（或给 0）就不问 dpr、不带 clip，整幅原样截
    const dpr = maxWidth > 0 ? await this._devicePixelRatio() : 1;
    const deviceWidth = width * dpr;   // 不带 clip 时浏览器会出的设备像素宽
    const wantScale = maxWidth > 0 && maxWidth < deviceWidth;
    const scale = wantScale ? maxWidth / deviceWidth : 1;
    let shot = await this._capture(scale, width, height);
    let actual = pngPixelSize(shot);
    // 补缩只看「要了宽度、而且图真的还比它宽」，不再依赖 wantScale（浏览器给的可能比算的还宽）
    if (maxWidth > 0 && actual && actual.width > maxWidth) {
      const fixed = scale * (maxWidth / actual.width);
      this._warnOnce("capture-retry", `${this.label}：截图实际宽 ${actual.width} 比要的 ${maxWidth} 宽，按真实比例再缩一次（scale=${fixed.toFixed(4)}）`);
      const second = await this._capture(fixed, width, height);
      const secondSize = pngPixelSize(second);
      if (secondSize) { shot = second; actual = secondSize; }
    }
    // 拿不到图片真实尺寸时只能自己算：输出宽 = CSS 宽 × dpr × scale（带不带 clip 都是这个式子）
    const size = actual || {
      width: Math.max(1, Math.round(width * dpr * scale)),
      height: Math.max(1, Math.round(height * dpr * scale)),
    };
    const image = {
      isEmpty: () => shot.length === 0,
      getSize: () => ({ width: size.width, height: size.height }),
      toPNG: () => shot,
      toDataURL: () => `data:image/png;base64,${shot.toString("base64")}`,
      resize: () => image,
    };
    return image;
  }

  /* ---------- 输入 ---------- */

  /**
   * 发输入。支持的：Enter / Tab / Escape / Backspace / Delete / 方向键 / Home / End / PageUp / PageDown / 单字符。
   * `char` 类型走 Input.insertText（Electron 那边就是「插入这段文字」）。
   * 认不出来的记一句日志就算了 —— 不抛错、也不假装按过了。
   */
  async sendInputEvent(input) {
    const type = String(input?.type ?? "");
    const keyCode = input?.keyCode;
    if (type === "char") {
      if (keyCode === undefined || keyCode === null || keyCode === "") {
        log(`${this.label}：char 事件没给 keyCode，跳过`);
        return;
      }
      await this._send("Input.insertText", { text: String(keyCode) });
      return;
    }
    if (type !== "keyDown" && type !== "keyUp" && type !== "rawKeyDown") {
      log(`${this.label}：不认识的输入事件 ${type || "（空）"}，跳过（只支持 keyDown / keyUp / rawKeyDown / char）`);
      return;
    }
    const name = String(keyCode ?? "");
    const def = KEYS.get(name) || (name.length === 1 ? keyForChar(name) : null);
    if (!def) {
      log(`${this.label}：不认识的按键 ${name || "（空）"}，跳过（支持 Enter/Tab/Escape/Backspace/Delete/方向键/单字符）`);
      return;
    }
    const params = {
      type: type === "rawKeyDown" ? "rawKeyDown" : type,
      key: def.key,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
    };
    if (def.code) params.code = def.code;
    // keyUp 不带 text：带了 Chromium 会再插一遍
    if (type !== "keyUp" && def.text) params.text = def.text;
    await this._send("Input.dispatchKeyEvent", params);
  }

  /* ---------- 历史 ---------- */

  get navigationHistory() {
    const tab = this;
    return {
      /** 同步：读缓存（Electron 的 canGoBack 也是同步的） */
      canGoBack: () => Boolean(tab.historyCache) && tab.historyCache.currentIndex > 0,
      canGoForward: () => Boolean(tab.historyCache) && tab.historyCache.currentIndex < tab.historyCache.entries.length - 1,
      goBack: () => tab._historyGo(-1),
      goForward: () => tab._historyGo(1),
      /** 额外给的：主动刷一次历史（canGoBack 之前想拿准数就 await 它） */
      refresh: () => tab._history(true),
    };
  }

  /* ---------- 收尾 ---------- */

  /**
   * 收摊：摘事件桥、把会话 dispose 掉（页面本身不动，除非调用方自己去关标签页）、置 destroyed。
   * 之后所有命令抛 TARGET_CLOSED。
   *
   * 注意：标签页可能先被判死（_markGone 已经发过 "destroyed"），调用方随后才调 dispose()。
   * 那时候收尾照样要做（定时器、事件桥、会话都得清干净），但事件不能再发 —— Electron 的
   * webContents 一辈子只发一次 "destroyed"。
   */
  async dispose() {
    if (this.destroyed) return;   // 已经关过了：收尾做完了，第二次什么也不用做
    this.destroyed = true;
    if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = null; }
    if (this.titleTimer) { clearTimeout(this.titleTimer); this.titleTimer = null; }
    this.debugger._clear();
    const session = this.session;
    this.session = null;
    await this._dropBridges();
    if (session && typeof session.dispose === "function") {
      try { await session.dispose(); } catch (error) { log(`${this.label}：收会话时出错（浏览器可能已经退了）：${error.message}`); }
    }
    this._emitDestroyed();
  }

  /** 发 "destroyed"，但一辈子只发一次（判死和 dispose 谁先到谁发） */
  _emitDestroyed() {
    if (this.destroyedEmitted) return;
    this.destroyedEmitted = true;
    this.emit("destroyed");
  }

  /* ================= 内部：给 debugger 外壳调的几个 ================= */

  /** 现在这个会话还能用吗（没 dispose、没判死、底层自己也说还挂着） */
  _isSessionAlive() {
    if (this.destroyed || this.gone || !this.session) return false;
    const session = this.session;
    if (typeof session.isAttached === "function") {
      try { return Boolean(session.isAttached()); } catch { return false; }
    }
    return true;
  }

  /** attach() 的同步部分：把建会话踢起来，错留给 sendCommand 去报（attach 是同步的，不能抛异步错） */
  _attachNow() {
    if (this.destroyed) throw codedError("TARGET_CLOSED", `${this.label}已经关掉了（dispose 过），attach 不了`);
    if (this.gone) throw codedError("TARGET_CLOSED", this.gone.message);
    if (this._isSessionAlive()) return;
    const work = this._ensureSession();
    work.catch(() => {});   // 没人等这一次建会话：错误留给下一条命令再抛一遍
  }

  /** detach()：只收会话，页面不动；下一条命令自动重建 */
  _detachNow() {
    if (this.destroyed || this.gone) return;
    const session = this.session;
    this.session = null;
    this.historyCache = null;
    this.dprCache = null;
    this.documentTitle = null;
    if (this.titleTimer) { clearTimeout(this.titleTimer); this.titleTimer = null; }
    const offs = this.sessionOffs;
    this.sessionOffs = [];
    for (const off of offs) { try { off(); } catch { /* 会话已经清了 */ } }
    if (session && typeof session.dispose === "function") {
      this._quiet(Promise.resolve().then(() => session.dispose()), "摘会话");
    }
    this.debugger._emit("detach", {}, "本机摘掉了调试器");
  }

  /** debugger.sendCommand 的实体：解析会话号、转发、吞掉不该出现的会话号 */
  async _send(method, params = {}, sessionId) {
    const wanted = sessionId === undefined || sessionId === null || sessionId === "" ? ROOT_SESSION : String(sessionId);
    const session = await this._sessionForCommand(method);
    if (wanted !== ROOT_SESSION) {
      const children = session.childSessions;
      if (children && typeof children.has === "function") {
        if (!children.has(wanted)) {
          throw codedError("SESSION_NOT_OURS", `${method} 想发到不归${this.label}管的会话（${wanted.slice(0, 12)}…），已拒绝：避免串到别的标签页`, { method, sessionId: wanted });
        }
      } else {
        this._warnOnce("no-child-sessions", `${this.label}：会话没给 childSessions，跨域 iframe 的子会话号没法核对，只能原样交给会话层去拒`);
      }
    }
    return session.send(method, params, wanted);
  }

  /* ================= 内部：会话生命周期 ================= */

  /** 拿一个能用的会话：有活着的直接用，没有就建（并发只建一次） */
  async _sessionForCommand(method = "命令") {
    if (this.destroyed) throw codedError("TARGET_CLOSED", `${this.label}已经关掉了（dispose 过），${method} 不再发送`, { method });
    if (this.gone) throw codedError(this.gone.code || "TARGET_CLOSED", this.gone.message, { method });
    if (this._isSessionAlive()) return this.session;
    return this._ensureSession(method);
  }

  /** 建会话：同一个时间只建一个，三条命令同时到也只建一次 */
  _ensureSession(method = "命令") {
    if (this.sessionPending) return this.sessionPending;
    this.sessionPending = (async () => {
      if (this.session) await this._dropSession();   // 旧会话已经不可用了，先干净收掉
      if (this.destroyed) throw codedError("TARGET_CLOSED", `${this.label}已经关掉了（dispose 过），${method} 不再发送`);
      if (this.gone) throw codedError(this.gone.code || "TARGET_CLOSED", this.gone.message);
      let session;
      try {
        session = await this.sessionProvider();
      } catch (error) {
        // 提供者的错原样抛（它自己带错误码，别在这里改写成别的说法）
        throw error;
      }
      if (!session || typeof session.send !== "function") {
        throw codedError("SESSION_CLOSED", `${this.label}：sessionProvider 没给出能用的会话（要有 send 方法）`);
      }
      if (this.destroyed) {
        try { await session.dispose?.(); } catch { /* 已经没了 */ }
        throw codedError("TARGET_CLOSED", `${this.label}一边建会话一边被关掉了，这次会话作废`);
      }
      this._bindSession(session);
      return session;
    })().finally(() => { this.sessionPending = null; });
    return this.sessionPending;
  }

  /** 把会话挂上：记网址标题、订阅事件（导航 / 页面内跳转 / 标签页没了 / 浏览器退出）、打开事件转发 */
  _bindSession(session) {
    this.session = session;
    const offs = [];
    this.sessionOffs = offs;
    const keep = (off) => { if (typeof off === "function") offs.push(off); };
    this.dprCache = null;         // 新会话重问设备像素比
    this.documentTitle = null;    // 标题也要重问（新会话可能已经换页面了）

    if (typeof session.getUrl === "function") {
      const url = session.getUrl();
      if (url) this.urlCache = url;
    }
    if (typeof session.getTitle === "function") {
      const title = session.getTitle();
      if (title) this.titleCache = title;
    }
    if (session.mainFrameId) this.mainFrameId = session.mainFrameId;

    // 主框架提交：页面真的换了，Electron 那边就是 did-navigate
    keep(session.onEvent("Page.frameNavigated", (params) => {
      const frame = params?.frame || {};
      if (frame.parentId) return;           // 子框架的导航不改页面网址
      if (frame.id) this.mainFrameId = frame.id;
      const url = `${frame.url || ""}${frame.urlFragment || ""}`;
      if (url) this.urlCache = url;
      this._afterNavigate(url);
      this.emit("did-navigate", {}, url, null, "");
    }, ROOT_SESSION));

    // 页面内跳转（锚点、history.pushState）：Electron 那边是 did-navigate-in-page
    keep(session.onEvent("Page.navigatedWithinDocument", (params) => {
      if (this.mainFrameId && params?.frameId && params.frameId !== this.mainFrameId) return;
      if (params?.url) this.urlCache = params.url;
      this._afterNavigate(params?.url || this.urlCache);
      this.emit("did-navigate-in-page", {}, params?.url || this.urlCache || "", false);
    }, ROOT_SESSION));

    // 标签页没了：会话层有专门一条事件，也有 onTargetGone 钩子，两条都接（只认第一次）
    keep(session.onEvent("Surface.targetGone", (params) => this._markGone(params), ROOT_SESSION));
    if (!session.onTargetGone) session.onTargetGone = (info) => this._markGone(info);

    // 浏览器整条连接没了：这个标签页跟着不算了
    const conn = session.conn;
    if (conn) {
      if (typeof conn.onClose === "function") {
        keep(conn.onClose((info) => this._markGone({
          code: info?.code || "BROWSER_EXITED",
          message: `${info?.message || "浏览器已经不在了"}；${this.label}跟着没了`,
        })));
      }
      if (typeof conn.onAnyEvent === "function") {
        // 页面 / 跨域 iframe 的事件转给 debugger 的 message 监听（SurfaceCdp 那套就靠这条）
        keep(conn.onAnyEvent((method, params, from) => {
          const mapped = this._mapSession(from);
          if (mapped === undefined) return;
          this.debugger._emit("message", {}, method, params, mapped);
        }));
      } else {
        this._warnOnce("no-any-event", `${this.label}：连接没有 onAnyEvent，页面事件不会转给 debugger.on("message")（SurfaceCdp 的快照会少东西）`);
      }
    }

    // 挂上就问一次标题：这个页面可能在我们 attach 之前就加载好了，光等导航事件是等不到的
    this._refreshTitle().catch(() => {});   // 标题只是锦上添花，拿不到别吵
  }

  /** 会话号映射：页面会话 → 空串；本标签页的跨域 iframe → 它自己；别的 → undefined（丢掉） */
  _mapSession(from) {
    const session = this.session;
    if (!session || typeof from !== "string") return undefined;
    if (session.pageSessionId && from === session.pageSessionId) return ROOT_SESSION;
    const children = session.childSessions;
    if (from && children && typeof children.has === "function" && children.has(from)) return from;
    return undefined;
  }

  /** 摘掉会话的订阅（不动会话本身） */
  async _dropBridges() {
    const offs = this.sessionOffs;
    this.sessionOffs = [];
    for (const off of offs) { try { off(); } catch { /* 会话已经清了 */ } }
  }

  /** 会话不可用了：摘订阅 + dispose 掉（页面不动），等下一次命令重建 */
  async _dropSession() {
    const session = this.session;
    this.session = null;
    this.historyCache = null;
    await this._dropBridges();
    if (session && typeof session.dispose === "function") {
      try { await session.dispose(); } catch (error) { log(`${this.label}：收旧会话时出错（可能是浏览器已经退了）：${error.message}`); }
    }
  }

  /**
   * 页面没了：记住原因、把会话收掉、通知一次。
   * 之后的命令一律 TARGET_CLOSED —— 不重建（标签页都没了，重建只会得到一个假会话）。
   */
  _markGone(info) {
    if (this.destroyed || this.gone) return;
    this.gone = {
      code: info?.code || "TARGET_CLOSED",
      message: info?.message || `${this.label}已经不在了`,
    };
    const session = this.session;
    this.session = null;
    const offs = this.sessionOffs;
    this.sessionOffs = [];
    for (const off of offs) { try { off(); } catch { /* 会话已经清了 */ } }
    if (session && typeof session.dispose === "function") {
      this._quiet(Promise.resolve().then(() => session.dispose()), "收掉死会话");
    }
    this.debugger._emit("detach", {}, this.gone.message);
    this._emitDestroyed();
  }

  /* ================= 内部：导航之后的小事 ================= */

  /** 导航之后：历史缓存作废、标题重问，过一会儿再刷（canGoBack 是同步的，只能读缓存） */
  _afterNavigate(url) {
    this.historyCache = null;
    // 上一页的标题留在这里只会骗人（真机实测：上一页的「about:blank」一直挂着），清掉
    this.titleCache = null;
    this.documentTitle = null;
    if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = null; }
    if (this.titleTimer) { clearTimeout(this.titleTimer); this.titleTimer = null; }
    if (this.destroyed || this.gone) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      if (this.destroyed || this.gone) return;
      this._quiet(this._history(true), "刷新历史");
    }, HISTORY_REFRESH_MS);
    this.historyTimer.unref?.();
    // 标题要等页面把 <title> 解析出来，所以晚一点问，别在导航刚提交那一瞬间问
    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      if (this.destroyed || this.gone) return;
      this._refreshTitle().catch(() => {});
    }, TITLE_REFRESH_MS);
    this.titleTimer.unref?.();
    if (url) this.urlCache = url;
  }

  /** 等一次 load；会话没有 waitForEvent 就退化成「发完就算」（会说一句） */
  _waitLoad(session, timeoutMs = LOAD_TIMEOUT_MS) {
    if (!session || typeof session.waitForEvent !== "function") {
      this._warnOnce("no-wait", `${this.label}：会话没有 waitForEvent，导航只能发出去、等不到 load`);
      return Promise.resolve(null);
    }
    const work = session.waitForEvent("Page.loadEventFired", { timeoutMs });
    work.catch(() => {});
    return work;
  }

  /** 页面尺寸（CSS 像素）：clip 用的是 CSS 像素，所以这里必须取 cssLayoutViewport（layoutViewport 是设备像素） */
  async _viewportSize() {
    try {
      const metrics = await this._send("Page.getLayoutMetrics", {});
      const box = metrics?.cssLayoutViewport || metrics?.layoutViewport;
      const width = Math.max(1, Math.round(Number(box?.clientWidth ?? 0) || 0));
      const height = Math.max(1, Math.round(Number(box?.clientHeight ?? 0) || 0));
      if (width > 1 && height > 1) return { width, height };
    } catch (error) {
      // 标签页没了 / 会话没了：照原样抛，别退化成「再发一条别的命令」——那只会把错误说糊
      if (["TARGET_CLOSED", "SESSION_CLOSED", "BROWSER_EXITED", "CDP_TIMEOUT"].includes(error?.code)) throw error;
      this._warnOnce("layout-metrics", `${this.label}：Page.getLayoutMetrics 没拿到（${error.code || error.message}），改用 innerWidth/innerHeight`);
    }
    const size = await this.executeJavaScript("({ width: innerWidth, height: innerHeight })");
    return {
      width: Math.max(1, Math.round(Number(size?.width ?? 0) || 1)),
      height: Math.max(1, Math.round(Number(size?.height ?? 0) || 1)),
    };
  }

  /** 截一张，返回图片字节（PNG） */
  async _capture(scale, width, height) {
    const params = { format: "png" };
    if (scale !== 1) params.clip = { x: 0, y: 0, width, height, scale };
    const shot = await this._send("Page.captureScreenshot", params);
    if (!shot?.data) throw codedError("CDP_ERROR", `${this.label}：截图没拿到图像数据`);
    return Buffer.from(shot.data, "base64");
  }

  /** 设备像素比：截图缩放要用（缓存一份，一个会话问一次就够；换了会话重问） */
  async _devicePixelRatio() {
    if (this.dprCache !== null) return this.dprCache;
    try {
      const value = await this._send("Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true });
      const dpr = Number(value?.result?.value);
      this.dprCache = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    } catch (error) {
      if (["TARGET_CLOSED", "SESSION_CLOSED", "BROWSER_EXITED", "CDP_TIMEOUT"].includes(error?.code)) throw error;
      this.dprCache = 1;
    }
    return this.dprCache;
  }

  /**
   * 标题：会话层那份来自 Target.targetInfoChanged，真机上它一直停在「网址当成标题」那个值
   * （2026-10-24 实测：页面标题明明是「标签页甲」，缓存里一直是「127.0.0.1:7176/one」）。
   * Electron 的 getTitle() 给的是 document.title，所以这里自己问一次页面，缓存起来。
   */
  async _refreshTitle() {
    try {
      const value = await this._send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      const title = value?.result?.value;
      if (typeof title === "string" && title.trim()) this.documentTitle = title;
    } catch { /* 页面正在跳 / 已经没了：留着上一次的，下次导航再问 */ }
  }

  /** 读历史（缓存 1 秒；refresh=true 强制读） */
  async _history(refresh = false) {
    const now = Date.now();
    if (!refresh && this.historyCache && now - this.historyCache.at < 1_000) return this.historyCache;
    const raw = await this._send("Page.getNavigationHistory", {});
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const cache = {
      at: Date.now(),
      currentIndex: Number(raw?.currentIndex ?? 0),
      entries,
    };
    this.historyCache = cache;
    return cache;
  }

  /** 前进/后退：按 currentIndex 找那条记录，跳过去，然后问页面「你到底换没换」（bfcache 恢复不发事件） */
  async _historyGo(delta) {
    const work = (async () => {
      const state = await this._history(true);
      const next = state.currentIndex + delta;
      const entry = state.entries[next];
      if (!entry) {
        return { moved: false, landed: false, reason: delta < 0 ? "没有上一页了" : "没有下一页了", url: this.getURL() };
      }
      await this._sessionForCommand("Page.navigateToHistoryEntry");
      await this._send("Page.navigateToHistoryEntry", { entryId: entry.id });
      const landed = await this._waitForUrl(entry.url, HISTORY_POLL_MS);
      const now = landed ? entry.url : await this._readHref();
      if (landed && entry.url) this.urlCache = entry.url;
      // 历史缓存作废重读：canGoBack/canGoForward 读的就是它，宁可多读一次也不给旧数
      this.historyCache = null;
      try {
        await this._history(true);
        // 浏览器偶尔慢一拍：拿到的 currentIndex 还没落到目标那条，等一拍再读一次
        if (this.historyCache.entries[this.historyCache.currentIndex]?.url !== entry.url) {
          await sleep(150);
          await this._history(true);
        }
      } catch {
        this.historyCache = { at: Date.now(), currentIndex: next, entries: state.entries };
      }
      if (!landed) this._warnOnce("history-slow", `${this.label}：${delta < 0 ? "后退" : "前进"}之后 ${HISTORY_POLL_MS}ms 内页面网址没变成 ${entry.url || "（空）"}，按浏览器现在的状态继续`);
      return { moved: true, landed, url: now || this.getURL() };
    })();
    return this._quiet(work, delta < 0 ? "后退" : "前进");
  }

  /** 页面现在的网址（问页面本身，不信缓存） */
  async _readHref() {
    try {
      const value = await this._send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      return typeof value?.result?.value === "string" ? value.result.value : null;
    } catch { return null; }
  }

  /** 隔一会儿问一次页面「是不是到 url 了」；等到 true，超时 false（不抛） */
  async _waitForUrl(expected, timeoutMs) {
    if (!expected) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._readHref() === expected) return true;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    return false;
  }

  /* ================= 内部：杂项 ================= */

  /** 挂个空 catch：没人 await 也不会变成未处理拒绝（Electron 里这些方法本来是返回 void 的） */
  _quiet(work, what) {
    Promise.resolve(work).catch((error) => {
      log(`${this.label}：${what}没成功 —— ${error?.code ? `${error.code} ` : ""}${error?.message || error}（调用方没等它，这里记一笔）`);
    });
    return work;
  }

  _warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log(message);
  }
}

/* ---------------- 窗口外观 ---------------- */

/**
 * 长得像 BrowserWindow 的东西：browser-control 只用 window.isDestroyed() / isVisible() /
 * isMinimized() / isFocused() / show() / focus() / restore() / webContents。
 * 这里一个都不真做 —— 外部浏览器的窗口不是我们建的，绝不去抢前台、不去恢复。
 */
class WindowFacade {
  constructor(tab) {
    if (!tab) throw codedError("TARGET_CLOSED", "窗口外观需要先有一个标签页外观");
    this.tab = tab;
    /** 和 Electron 一样：窗口的 webContents 就是那个标签页 */
    this.webContents = tab;
  }

  get id() {
    return this.tab.id;
  }

  isDestroyed() {
    return this.tab.isDestroyed();
  }

  /** 标签页在外，但「有没有显示」这件事不归我们管；说 true 才不会让截图的第三级阶梯去调 show/focus */
  isVisible() {
    return !this.tab.isDestroyed();
  }

  isMinimized() {
    return false;
  }

  isFocused() {
    return false;
  }

  show() {}
  focus() {}
  restore() {}
  hide() {}

  loadURL(url) {
    return this.tab.loadURL(url);
  }

  /* 事件都在标签页上；窗口这边转发一下，老代码按窗口找监听也不至于报错 */
  on(event, handler) { this.tab.on(event, handler); return this; }
  once(event, handler) { this.tab.once(event, handler); return this; }
  off(event, handler) { this.tab.off(event, handler); return this; }
  removeListener(event, handler) { this.tab.removeListener(event, handler); return this; }
  emit(event, ...args) { return this.tab.emit(event, ...args); }
}

/* ---------------- 出口 ---------------- */

/**
 * 建一个标签页外观。
 *
 * 会先把第一条会话建好（await 这一下就是它）：建不起来当场抛，而不是等第一条命令才发现这个标签页不可用。
 * 契约里写的就是 `const tab = await createTabFacade(...)`。
 */
async function createTabFacade({ targetId, sessionProvider, label } = {}) {
  const tab = new TabFacade({ targetId, sessionProvider, label });
  try {
    await tab._sessionForCommand("建标签页外观");
  } catch (error) {
    await tab.dispose().catch(() => {});
    throw error;
  }
  return tab;
}

/** 顺手给一个「窗口」，browser-profiles 那边 windowFor 要的就是它 */
function createWindowFacade(tab) {
  return new WindowFacade(tab);
}

module.exports = { TabFacade, TabDebugger, WindowFacade, createTabFacade, createWindowFacade, FIRST_TAB_ID, KEYS };
