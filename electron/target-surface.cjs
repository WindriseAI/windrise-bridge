/**
 * 标签页会话层：把外部浏览器里的一个标签页，包成现有代码认识的那个「页面对象」。
 *
 * 为什么需要这一层：
 *   src/core 里的快照、动作模块（从 BrowserOS / Ego Lite 搬来的）只认三样东西：
 *   `cdp.send(method, params, sessionId)`、`cdp.session(id).Domain.method/on`、`cdp.api.Target.on`，
 *   而且写死了「根会话的会话号是空串」「根会话的 .on 收到这个页面所有子会话的事件」。
 *   这里用「一条浏览器级连接 + Target.attachToTarget({flatten:true})」满足这三条。
 *
 * 三个外部浏览器决定的差别：
 *   1. 没有 webContents：网址、标题靠 CDP 事件维护一份缓存（Page.frameNavigated / navigatedWithinDocument /
 *      Target.targetInfoChanged）。缓存里没有网址时**按拒绝处理**，不猜。
 *   2. 一条连接上挂着好几个标签页：只把「本标签页的会话」和「父会话是本标签页的跨域 iframe 会话」的事件分给自己，
 *      其余一律丢掉（否则两个账号窗口的 iframe 会串台，脱敏和 ref 编号都会错）。
 *   3. attach / dispose / send 全是异步的，而且会话可能在中途死掉（人关了标签页）：这时立刻按
 *      TARGET_CLOSED / SESSION_CLOSED 失败，不等 15 秒超时（2026-10-24 真机实测：浏览器对死会话不回包）。
 *
 * 对外保证（browser-control.cjs 依赖这些）：
 *   send / session / api / onEvent / waitForEvent / blockInput / resumeInput / inputBlocked /
 *   isSendingInput / isAttached / dispose；错误码 CDP_TIMEOUT；urlGuard 每条命令前都问一次，
 *   读类命令拿回结果后再核对一次网址（防止导航提交的瞬间把登录页内容读走）。
 */

const { ROOT_SESSION, CdpTimeoutError, CdpError } = require("./cdp-connection.cjs");

const DEFAULT_TIMEOUT_MS = 15_000;
/** 一次导航刚开始、还没提交时，用「打算去的网址」判禁区；超过这么久还没落地就当它取消了（防误伤） */
const PENDING_URL_TTL_MS = 5_000;
/** 这些命令不碰页面内容（或本来就是收尾），结果回来不用再核对一次网址 */
const NO_POSTCHECK = /^(Target\.|Browser\.|Inspector\.)|\.(enable|disable)$|^Page\.setLifecycleEventsEnabled$|^Runtime\.runIfWaitingForDebugger$/;

/**
 * 对话框开着时仍然能发的命令：处理对话框本身、导航离开、收尾。其余一律按 DIALOG_OPEN 当场拒绝。
 * 为什么不放 Runtime.* 进来：对话框开着时页面的执行上下文被堵住，Runtime.evaluate 只会挂到超时。
 */
const DIALOG_SAFE_COMMANDS = /^(Page\.handleJavaScriptDialog|Page\.navigate|Page\.stopLoading|Page\.reload|Page\.getNavigationHistory|Page\.navigateToHistoryEntry|Target\.|Browser\.|Inspector\.)|\.(enable|disable)$/;

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 调用方带进来的取消信号（跟着外部超时走）。
 *
 * 取消不是超时：写命令如果已经发出去，结果可能已经落到页面上，必须用独立错误码
 * CDP_ABORTED + next_step 明确「不要自动重试」；还没发就取消时直接说没发，可以重试。
 */
function abortError(method, reason, { sent = false } = {}) {
  const code = reason?.code === "DIALOG_OPEN" ? "DIALOG_OPEN" : "CDP_ABORTED";
  return codedError(code, sent
    ? `${method} 被调用方取消（等不下去了），命令可能已经发到页面`
    : `${method} 被调用方取消（等不下去了），命令没有发出`, {
    method,
    cause: reason,
    aborted: true,
    sent,
    next_step: sent
      ? "命令可能已经发出，不要自动重试；先读回页面确认"
      : "命令没有发出，可以按原参数重试",
    ...(reason?.dialog ? { dialog: reason.dialog } : {}),
  });
}

class TargetSurface {
  /**
   * @param {import("./cdp-connection.cjs").CdpConnection} conn  一个浏览器进程一条的连接
   * @param {{
   *   targetId: string,
   *   timeoutMs?: number,
   *   urlGuard?: (url: string | null, method: string, info: { afterResult: boolean }) => (null | { code: string, message: string }),
   *   label?: string,
   * }} options
   *   urlGuard：每条命令前问一次「这个网址 AI 能不能碰」，返回非空就拒绝（见 ai-site-guard.cjs 的 checkAiAccess）。
   *   会把命令名一起传过去：个别命令要放行（例如账号窗口里的「离开页面」）就在护栏函数里按命令判断，
   *   不要去改 this.urlGuard —— 这个字段整个会话共用，临时摘掉会让同时在途的别的命令也不过护栏。
   */
  constructor(conn, { targetId, timeoutMs = DEFAULT_TIMEOUT_MS, urlGuard = null, label = "标签页" } = {}) {
    if (!conn) throw codedError("CDP_TRANSPORT", "标签页会话需要一条浏览器连接");
    if (!targetId) throw codedError("TARGET_CLOSED", "标签页会话需要一个 targetId");
    this.conn = conn;
    this.targetId = targetId;
    this.timeoutMs = timeoutMs;
    this.urlGuard = urlGuard;
    this.label = label;
    /** 页面会话号；attach() 之前是 null */
    this.pageSessionId = null;
    /** 跨域 iframe 的子会话（父会话是本标签页的那些） */
    this.childSessions = new Set();
    /** 主框架 frameId：判「哪条 frameNavigated 才是页面本身」用 */
    this.mainFrameId = null;
    /** 网址 / 标题缓存 */
    this.url = null;
    this.title = null;
    this.pendingUrl = null;
    this.pendingUrlAt = 0;
    this.attached = false;
    this.disposed = false;
    /** 标签页没了的证据：{ code, message }；有值之后所有命令立刻失败 */
    this.gone = null;
    /** 人接管后置上：之后 AI 的 Input.* 一律拒绝 */
    this.inputBlocked = null;
    /**
     * 页面上还开着没处理的 JS 对话框：{ type, message, defaultPrompt, url, at }。
     * 为什么必须记：alert / confirm / prompt 开着的时候，渲染进程把脚本执行和输入都堵住了，
     * 后面每一条 Runtime.evaluate / Input.* 都会一直挂着直到 15 秒超时 ——
     * 看起来像「工具卡死」，其实是等一个永远不会自己关的模态框（真机 10-27 踩到）。
     */
    this.dialog = null;
    this.inputsInFlight = new Map();
    this.inputSeq = 0;
    this.lastInputDoneAt = 0;
    /** Map<"Domain.event", Set<{ sessionId: string|undefined, handler }>> */
    this.listeners = new Map();
    /** 已经挂到连接上的事件桥：Map<事件名, 退订函数> */
    this.bridges = new Map();
    /** 标签页被关掉时通知外面（browser-control 用它收掉快照） */
    this.onTargetGone = null;
    /** 虚拟点击后延迟复查（和 SurfaceCdp 同一个钩子） */
    this.onInputSettled = null;
    this.api = this.session(ROOT_SESSION);
  }

  /* ---------- 建立 / 摘除 ---------- */

  /**
   * 附到这个标签页：拿页面会话、开 Page 域、打开跨域 iframe 自动挂接、把主框架和初始网址记下来。
   * 可以重复调用；已经附上就原样返回。
   */
  async attach() {
    if (this.disposed) throw codedError("TARGET_CLOSED", "这个标签页会话已经关掉了，要重新开一个");
    if (this.attached) return this;
    if (this.conn.isClosed) throw codedError(this.conn.closedReason?.code || "CDP_DISCONNECTED", "浏览器已经不在了，附不上这个标签页");
    const attached = await this.conn.send("Target.attachToTarget", { targetId: this.targetId, flatten: true }, "", { timeoutMs: this.timeoutMs });
    this.pageSessionId = attached.sessionId;
    const targetInfo = attached.targetInfo || {};
    this.url = targetInfo.url || null;
    this.title = targetInfo.title || null;
    // 先把监听挂上，再开域：这样 enable 期间发生的导航也不会漏
    this.#installBridges();
    await this.conn.send("Page.enable", {}, this.pageSessionId, { timeoutMs: this.timeoutMs });
    // 标题只能从 Target.targetInfoChanged 拿到，而它要先开「发现目标」才会发（2026-10-24 真机实测：
    // 不开的话标题永远是 null）。这一步是幂等的，重复开没有副作用。
    await this.conn.send("Target.setDiscoverTargets", { discover: true }, "", { timeoutMs: this.timeoutMs }).catch(() => {});
    // 主框架 id：没有它就只能靠「第一条 frameNavigated 没有 parentId」猜，能拿就先拿
    try {
      const tree = await this.conn.send("Page.getFrameTree", {}, this.pageSessionId, { timeoutMs: this.timeoutMs });
      this.mainFrameId = tree?.frameTree?.frame?.id ?? null;
      if (tree?.frameTree?.frame?.url) this.url = tree.frameTree.frame.url;
    } catch { /* 拿不到不影响用：frameNavigated 里再补 */ }
    this.attached = true;
    return this;
  }

  /** 摘掉监听、断开会话。断开失败不算错（可能浏览器已经退了）。 */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.bridges.values()) { try { off(); } catch { /* */ } }
    this.bridges.clear();
    this.listeners.clear();
    const session = this.pageSessionId;
    this.pageSessionId = null;
    this.attached = false;
    this.childSessions.clear();
    if (session && !this.conn.isClosed) {
      try { await this.conn.send("Target.detachFromTarget", { sessionId: session }, "", { timeoutMs: 3000 }); } catch { /* 会话已经没了 */ }
    }
  }

  /** 会话还活着吗（连接没断、没 dispose、标签页没被关） */
  isAttached() {
    if (this.disposed || this.gone || !this.pageSessionId) return false;
    if (this.conn.isClosed) return false;
    return !this.conn.isSessionClosed(this.pageSessionId);
  }

  /* ---------- 网址 / 标题 ---------- */

  /**
   * 现在这条命令该按哪个网址判禁区：优先「刚开始导航、还没落地的目标网址」。
   * 拿不到网址返回 null —— 调用方按拒绝处理，不猜。
   */
  urlForGuard() {
    const now = Date.now();
    if (this.pendingUrl && now - this.pendingUrlAt <= PENDING_URL_TTL_MS) return this.pendingUrl;
    return this.url || null;
  }

  getUrl() {
    return this.url || null;
  }

  getTitle() {
    return this.title || null;
  }

  /* ---------- 人接管 ---------- */

  /** 人接管：之后 AI 的输入命令直接被拒，错误码 CONTROL_PREEMPTED。 */
  blockInput(reason = "人接管了这个标签页") {
    this.inputBlocked = reason;
  }

  /** 人交还：AI 可以继续输入。 */
  resumeInput() {
    this.inputBlocked = null;
  }

  /**
   * 这一刻的输入是不是 AI 发的：有刚发出不久的 Input.* 在途，或刚结束不到 graceMs。
   * 判法照抄 SurfaceCdp（外部浏览器没有 input-event，这一步这一版先不做）。
   */
  isSendingInput(graceMs = 50, freshMs = 500) {
    const now = Date.now();
    for (const startedAt of this.inputsInFlight.values()) if (now - startedAt <= freshMs) return true;
    return now - this.lastInputDoneAt <= graceMs;
  }

  /* ---------- 发命令 ---------- */

  /**
   * 发一条命令。sessionId 空串 = 这个标签页本身；跨域 iframe 要传它自己的子会话号。
   * 每条命令前过 urlGuard；读类命令拿回结果后再核对一次网址。
   *
   * 额外选项：
   *   signal：调用方自己的取消信号（跟着外部超时走）。已经取消的不发命令；
   *     在途被取消用 CDP_ABORTED 结算，并提示「可能已发出，不要自动重试」。
   *
   * 为什么这里会「不等结果就返回」：点击一个 onClick 里有 alert() 的按钮时，Input.dispatchMouseEvent
   * 的响应要等输入派发完才回来，而对话框开着的时候渲染进程把这条响应压住了 —— 真机实测要卡满 15 秒。
   * 所以 Input.* 这类命令发出去之后，一边等结果、一边等 Page.javascriptDialogOpening：
   * 对话框先到就用 DIALOG_OPEN 结算这条命令（真正的鼠标 ack 就地作废，不等了）。
   */
  async send(method, params = {}, sessionId = ROOT_SESSION, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.disposed) throw codedError("TARGET_CLOSED", "这个标签页会话已经关掉了");
    if (this.gone) throw codedError(this.gone.code, this.gone.message, { method, sessionId: sessionId || ROOT_SESSION });
    // 已经取消：一个字都不要发。尤其写命令，发出去再作废等于「调用方以为取消了，页面其实已经改过」。
    if (signal?.aborted) throw abortError(method, signal.reason, { sent: false });
    // 模态对话框开着的时候，除了「处理对话框」和收尾类命令，其它命令都会被浏览器堵住（等满超时才回来）。
    // 与其让调用方等 15 秒再收到一个说不清的 CDP_TIMEOUT，不如当场报 DIALOG_OPEN 并告诉它怎么关。
    if (this.dialog && !DIALOG_SAFE_COMMANDS.test(String(method))) {
      throw codedError(
        "DIALOG_OPEN",
        `页面开着 ${this.dialog.type} 对话框（${JSON.stringify(this.dialog.message ?? "")}），脚本和输入都被它挡住了。先用 page_act 的 action:"dialog"（accept:true 确认 / false 取消）关掉它`,
        { dialog: { ...this.dialog }, method },
      );
    }
    const connSession = this.#connSessionFor(sessionId, method);
    this.#assertAllowed(method);
    const isInput = method.startsWith("Input.");
    if (isInput && this.inputBlocked) {
      throw codedError("CONTROL_PREEMPTED", `${this.inputBlocked}，AI 的输入已停止；等人交还后再继续，不要重试`);
    }
    const seq = isInput ? ++this.inputSeq : 0;
    if (isInput) this.inputsInFlight.set(seq, Date.now());
    let result;
    try {
      result = await this.#sendWaitingForDialog(method, params, connSession, { timeoutMs, isInput, signal });
    } catch (error) {
      throw this.#translate(error, method, sessionId);
    } finally {
      if (isInput) {
        this.inputsInFlight.delete(seq);
        this.lastInputDoneAt = Date.now();
        if (this.onInputSettled) setTimeout(() => this.onInputSettled?.(), 30);
      }
    }
    // 结果回来后再核对一次：缓存有延迟，登录页内容可能在导航提交的瞬间被读走
    if (!NO_POSTCHECK.test(method) && !isInput) this.#assertAllowed(method, { afterResult: true });
    return result;
  }

  /**
   * 发命令并和对话框「赛跑」：结果先回来就用结果；Page.javascriptDialogOpening 先到就当场报 DIALOG_OPEN。
   * 覆盖 Input.*、Runtime.evaluate，以及会派发 change / 触发页面脚本的写入
   * （时间框 setTemporalValueForAction、下拉框 selectOptionsForAction 都走 Runtime.callFunctionOn）；
   * 其它命令（导航、取帧树、Accessibility.getFullAXTree）照旧干等，但可以带上调用方的取消信号。
   */
  async #sendWaitingForDialog(method, params, connSession, { timeoutMs, isInput, signal }) {
    const racesDialog = isInput
      || method === "Runtime.evaluate"
      || (method === "Runtime.callFunctionOn"
        && /setTemporalValueForAction|selectOptionsForAction/.test(String(params?.functionDeclaration ?? "")));
    const pending = this.conn.send(method, params, connSession, { timeoutMs });
    if (!racesDialog && !signal) return pending;
    let settled = false;
    let abort = null;
    let watcher = null;
    try {
      return await new Promise((resolve, reject) => {
        const done = (fn, value) => {
          if (settled) return;
          settled = true;
          watcher?.();
          signal?.removeEventListener?.("abort", onAbortExternal);
          fn(value);
        };
        // 走到这里命令已经交给连接层了：取消只能按「可能已发出」上报，不能再说没发。
        const onAbortExternal = () => { done(reject, abortError(method, signal?.reason, { sent: true })); };
        signal?.addEventListener?.("abort", onAbortExternal, { once: true });
        pending.then((value) => done(resolve, value), (error) => done(reject, error));
        // 已经在途的命令：拿到句柄才能就地作废（否则它会一直挂到超时）
        abort = (reason) => pending.abort?.(reason) ?? false;
        if (racesDialog) {
          // 对话框事件和「命令已发出」之间有时序差：挂监听时对话框已经开了的话立刻兑现
          if (this.dialog) { done(reject, this.#dialogOpenError(method)); return; }
          watcher = this.onEvent("Page.javascriptDialogOpening", () => {
            // 这里只处理「本次命令发出之后才出现」的对话框；发命令前就开着的那条在最上面拦过
            const reason = new CdpError("DIALOG_OPEN", "页面弹出了对话框，这次动作不再等鼠标事件的返回", { dialog: { ...this.dialog }, method, aborted: true });
            done(reject, reason);
            abort?.(reason);
          });
        }
        if (signal?.aborted) onAbortExternal();
      });
    } finally {
      // 命令被作废 / 被放弃时，绝不能留下一个没人结算的 Promise（否则迟到的结果会变成未处理的 rejection）
      pending.catch?.(() => {});
    }
  }

  #dialogOpenError(method) {
    return codedError(
      "DIALOG_OPEN",
      `页面开着 ${this.dialog?.type ?? "alert"} 对话框（${JSON.stringify(this.dialog?.message ?? "")}），脚本和输入都被它挡住了。先用 page_act 的 action:"dialog"（accept:true 确认 / false 取消）关掉它`,
      { dialog: { ...(this.dialog ?? {}) }, method },
    );
  }

  /**
   * 关掉当前开着的对话框：accept=true 确认（prompt 会带 promptText），false 取消。
   * 没有开着的对话框时什么都不做，返回 null —— 调用方据此说明「本来就没开」。
   */
  async handleDialog({ accept = true, promptText } = {}) {
    if (!this.dialog) return null;
    const open = { ...this.dialog };
    const params = { accept: Boolean(accept) };
    if (open.type === "prompt" && typeof promptText === "string") params.promptText = promptText;
    await this.conn.send("Page.handleJavaScriptDialog", params, this.#connSessionFor(ROOT_SESSION, "Page.handleJavaScriptDialog"), { timeoutMs: 5_000 });
    // Page.javascriptDialogClosed 也会把它清掉；这里先清，免得事件晚到时又拦住下一条命令
    this.dialog = null;
    return open;
  }

  /* ---------- 事件 ---------- */

  /**
   * 订阅事件。sessionId 不传 = 这个标签页（含跨域 iframe）的事件都收；传 '' = 只要页面本身的；
   * 传子会话号 = 只要那个 iframe 的。返回退订函数。
   */
  onEvent(event, handler, sessionId) {
    const entry = { sessionId, handler };
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(entry);
    this.#ensureBridge(event);
    return () => {
      this.listeners.get(event)?.delete(entry);
      if (this.listeners.get(event)?.size === 0) this.listeners.delete(event);
    };
  }

  /** 等某个事件来一次（带时限）。match 返回 true 才算。 */
  waitForEvent(event, { sessionId, timeoutMs = this.timeoutMs, match = () => true } = {}) {
    return new Promise((resolve, reject) => {
      if (this.gone) { reject(codedError(this.gone.code, this.gone.message)); return; }
      const timer = setTimeout(() => { off(); reject(new CdpTimeoutError(event, timeoutMs, sessionId)); }, timeoutMs);
      const off = this.onEvent(event, (params, from) => {
        if (!match(params, from)) return;
        clearTimeout(timer);
        off();
        resolve({ params, sessionId: from });
      }, sessionId);
    });
  }

  /**
   * 领域式接口：session(会话号).Domain.method(params) / session(会话号).Domain.on(event, fn)。
   * 根会话（空串）的 .on 收这个标签页所有会话的事件——surface-snapshot.js 的 FrameRegistry 就靠这条。
   */
  session(sessionId = ROOT_SESSION) {
    const surface = this;
    const scope = sessionId === ROOT_SESSION ? undefined : sessionId;
    return new Proxy({}, {
      get(_target, domain) {
        if (typeof domain !== "string" || domain === "then") return undefined;
        return new Proxy({}, {
          get(_t, name) {
            if (typeof name !== "string") return undefined;
            if (name === "on") return (event, handler) => surface.onEvent(`${domain}.${event}`, handler, scope);
            return (params = {}) => surface.send(`${domain}.${name}`, params, sessionId);
          },
        });
      },
    });
  }

  /* ---------- 内部 ---------- */

  /** 会话号映射：'' → 页面会话；子会话 → 自己；别的 → 不归我管，直接拒绝（防串台） */
  #connSessionFor(sessionId, method) {
    const wanted = sessionId || ROOT_SESSION;
    if (!this.pageSessionId) throw codedError("TARGET_CLOSED", `标签页会话还没附上，命令 ${method} 发不出去`);
    if (wanted === ROOT_SESSION) return this.pageSessionId;
    if (this.childSessions.has(wanted)) return wanted;
    throw codedError("SESSION_NOT_OURS", `${method} 想发到不归这个标签页管的会话（${String(wanted).slice(0, 12)}…），已拒绝，避免串到别的标签页`);
  }

  /** 过禁区。afterResult=true 时是「结果回来再核对一次」，报错措辞不一样。 */
  #assertAllowed(method, { afterResult = false } = {}) {
    const url = this.urlForGuard();
    if (!url) {
      throw codedError("URL_UNKNOWN", `还不知道这个标签页现在的网址，${method} 一律不做（宁可停下，也不在不明页面上动手）`);
    }
    if (!this.urlGuard) return;
    let blocked;
    try {
      blocked = this.urlGuard(url, method, { afterResult });
    } catch (error) {
      // urlGuard 直接抛（assertAiAllowed 那种写法）也算拒绝
      throw error;
    }
    if (!blocked) return;
    const message = afterResult ? `${blocked.message}（这条命令的结果已经作废，不要用）` : blocked.message;
    throw codedError(blocked.code, message, { url, label: blocked.label, discarded: afterResult });
  }

  #installBridges() {
    const conn = this.conn;
    // 页面自己的导航：主框架提交了才算页面变了
    this.onEvent("Page.frameNavigated", (params) => {
      const frame = params?.frame || {};
      if (frame.parentId) return; // 子框架的导航不改页面网址
      this.mainFrameId = frame.id || this.mainFrameId;
      if (frame.url) this.url = frame.url;
      if (frame.urlFragment) this.url = `${frame.url}${frame.urlFragment}`;
      this.pendingUrl = null;
    });
    this.onEvent("Page.navigatedWithinDocument", (params) => {
      if (this.mainFrameId && params?.frameId !== this.mainFrameId) return;
      if (params?.url) this.url = params.url;
    });
    this.onEvent("Page.frameStartedNavigating", (params) => {
      if (this.mainFrameId && params?.frameId !== this.mainFrameId) return;
      if (params?.url) { this.pendingUrl = params.url; this.pendingUrlAt = Date.now(); }
    });
    this.onEvent("Page.loadEventFired", () => { this.pendingUrl = null; });
    // JS 对话框（alert / confirm / prompt / beforeunload）：记下来，之后所有命令按 DIALOG_OPEN 当场拒绝，
    // 不用等 CDP 超时。关掉的时候（Page.javascriptDialogClosed）把记录清掉。
    this.onEvent("Page.javascriptDialogOpening", (params) => {
      this.dialog = {
        type: String(params?.type ?? "alert"),
        message: String(params?.message ?? ""),
        defaultPrompt: params?.defaultPrompt ?? "",
        url: this.url || null,
        at: Date.now(),
      };
      this.#dispatch("Surface.dialogOpen", { ...this.dialog }, ROOT_SESSION);
    });
    this.onEvent("Page.javascriptDialogClosed", () => { this.dialog = null; });
    // 跨域 iframe 会话：记住哪些子会话归这个标签页
    this.onEvent("Target.attachedToTarget", (params) => {
      if (params?.sessionId) this.childSessions.add(params.sessionId);
    });
    this.onEvent("Target.detachedFromTarget", (params) => {
      if (params?.sessionId) this.childSessions.delete(params.sessionId);
    });

    // 标签页没了 / 会话断了：立刻判死，别让调用方等超时
    const offGone = conn.onEvent("Target.targetDestroyed", (params) => {
      if (params?.targetId === this.targetId) this.#markGone({ code: "TARGET_CLOSED", message: "这个标签页被关掉了" });
    }, ROOT_SESSION);
    const offDetach = conn.onEvent("Target.detachedFromTarget", (params) => {
      if (params?.sessionId && params.sessionId === this.pageSessionId) void this.#resolveDetach();
    });
    // 网址和标题：targetInfoChanged 只在变化时发；targetCreated 是开了「发现目标」以后每个已有目标都发一次
    const applyInfo = (info) => {
      if (!info || info.targetId !== this.targetId) return;
      if (info.url) this.url = info.url;
      if (info.title) this.title = info.title;
    };
    const offCreated = conn.onEvent("Target.targetCreated", (params) => applyInfo(params?.targetInfo), ROOT_SESSION);
    const offInfo = conn.onEvent("Target.targetInfoChanged", (params) => applyInfo(params?.targetInfo), ROOT_SESSION);
    // 桥自己的退订挂在 dispose 上；这几条是生命周期，不受 listeners 影响
    this.bridges.set("\u0000lifecycle", () => { offGone(); offDetach(); offCreated(); offInfo(); });
  }

  /** 会话级事件桥：连接上订阅一次，按会话号筛过再分给本标签页的监听器 */
  #ensureBridge(event) {
    if (this.bridges.has(event)) return;
    const off = this.conn.onEvent(event, (params, from) => {
      const mapped = this.#mapSession(from);
      if (mapped === undefined) return;
      this.#dispatch(event, params, mapped);
    });
    this.bridges.set(event, off);
  }

  #mapSession(from) {
    if (this.pageSessionId && from === this.pageSessionId) return ROOT_SESSION;
    if (this.childSessions.has(from)) return from;
    return undefined;
  }

  #dispatch(event, params, sessionId) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const entry of [...handlers]) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      try { entry.handler(params, sessionId); } catch { /* 一个监听器出错不影响别的 */ }
    }
  }

  /**
   * 页面会话断了以后定性：先问浏览器「这个标签页还在不在」。
   * 2026-10-24 真机实测：人关标签页时 Target.detachedFromTarget 先到、targetDestroyed 后到
   * （而且没开「发现目标」时根本不发）。只看 detach 分不清「标签页没了」和「只是这个会话被收走了」，
   * 所以补一次 getTargetInfo：浏览器说「没有这个 target」才算 TARGET_CLOSED。
   */
  async #resolveDetach() {
    if (this.gone || this.disposed) return;
    if (this.conn.isClosed) {
      const reason = this.conn.closedReason || {};
      this.#markGone({ code: reason.code || "CDP_DISCONNECTED", message: reason.message || "浏览器已经不在了" });
      return;
    }
    let alive = true;
    try {
      await this.conn.send("Target.getTargetInfo", { targetId: this.targetId }, "", { timeoutMs: 3000 });
    } catch (error) {
      alive = !(error?.code === "TARGET_CLOSED" || /No target with given id|no such target/i.test(String(error?.message || "")));
    }
    if (this.gone || this.disposed) return;
    this.#markGone(alive
      ? { code: "SESSION_CLOSED", message: "这个标签页的会话断开了（标签页本身还在）" }
      : { code: "TARGET_CLOSED", message: "这个标签页被关掉了" });
  }

  /** 标签页死了：记住原因、把在途命令结算掉、通知外面收快照 */
  #markGone(info) {
    if (this.gone || this.disposed) return;
    this.gone = info;
    this.dialog = null;
    const session = this.pageSessionId;
    if (session) this.conn.markSessionClosed(session, info);
    // 只发一个专门的事件，不拿这条消息去冒充 Page.* 之类的事件（那会让快照那边看到假的帧数据）
    this.#dispatch("Surface.targetGone", { ...info }, ROOT_SESSION);
    this.onTargetGone?.(info);
  }

  /** 把连接层的错误翻成这个层的说法（会话没了归到 TARGET_CLOSED，调用方只关心「标签页还能不能用」） */
  #translate(error, method, sessionId) {
    const code = error?.code;
    if (code === "SESSION_CLOSED" && sessionId !== ROOT_SESSION && this.childSessions.has(sessionId)) {
      // 跨域 iframe 的会话没了：标签页本身还在，别误报成整个页面没了
      return Object.assign(new Error(`${method} 失败：这个跨域 iframe 的会话已经不在了`), { code: "FRAME_CLOSED", method, sessionId });
    }
    if (code === "SESSION_CLOSED" && (!sessionId || sessionId === ROOT_SESSION)) {
      this.#markGone({ code: "TARGET_CLOSED", message: "这个标签页的会话已经不在了" });
      return Object.assign(new Error(`${method} 失败：这个标签页已经不在了（被关掉或跳转走了）`), { code: "TARGET_CLOSED", method, cause: error });
    }
    if (code === "BROWSER_EXITED" && error.message?.includes("没等到结果")) {
      return Object.assign(new Error(`${method} 没等到结果：浏览器进程已经退出`), { code: "BROWSER_EXITED", method, cause: error });
    }
    return error;
  }
}

module.exports = { TargetSurface, PENDING_URL_TTL_MS };
