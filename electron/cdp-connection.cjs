/**
 * CDP 连接层：一个浏览器进程一条连接，管收发、管超时、管断开。
 *
 * 是什么：
 *   Windrise 和外部浏览器（BrowserOS 主力，Chrome 备用）之间那一层。两种传输：
 *     - 管道 PipeTransport：浏览器用 `--remote-debugging-pipe` 启动，本机不开端口、不写 DevToolsActivePort。
 *       父进程写第 3 号文件描述符（子进程读），读第 4 号（子进程写），每条消息是「一段 UTF-8 JSON + 一个 \0」。
 *     - WebSocket WebSocketTransport：Chrome 备用内核走这条（它不支持管道下 navigator.webdriver=false）。
 *   两条传输都归成同一句：`send(method, params, sessionId)` / 按 sessionId 收事件 / 断开时在途命令全部报错。
 *
 * 不负责：
 *   - 起浏览器、挑程序、拼参数、清孤儿（browseros-engine.cjs）；
 *   - 把「标签页」包成快照代码认的会话（target-surface.cjs）；
 *   - 能不能碰这个网址（ai-site-guard.cjs）、网址合不合法（url-guard.cjs）。
 *
 * 为什么这么写（都有实测或对源码的核对，见 docs/research/browser-engine-2026-10-24.md）：
 *   1. 管道里消息用 \0 分隔，不是一个消息一行：JSON 里可以有换行（base64 截图没有，但 evaluate 的字符串有），
 *      按行切会切碎。这里自己攒 Buffer、按 0x00 切，多字节字符不会被腰斩（切的是字节，不是字符串下标）。
 *   2. 命令号必须按「会话 + 命令号」配对，不能只按命令号：flat 会话（Target.attachToTarget({flatten:true})）
 *      下每个标签页会话有自己的一套命令号，不同会话的 1 号命令会撞车，只按 id 配会把 A 标签页的结果交给 B。
 *      依据：Puppeteer 的 Connection 就是先用 sessionId、再用 id 找回调。
 *   3. 每条命令都带时限：浏览器卡住（后台窗口、模态框、渲染进程挂掉）时不能让调用方永远挂着；
 *      超时只废掉这一条，不牵连连接。
 *   4. 断开必须一次结算所有在途命令：管道一断（浏览器退出、崩溃）或者连接被本机关掉，
 *      还在等的命令立刻按 BROWSER_EXITED / CDP_DISCONNECTED 失败，调用方不会等满 15 秒才知道浏览器没了。
 *
 * 对外两种用法：
 *   - 底层：conn.send("Target.getTargets")、conn.onEvent("Target.targetCreated", fn)
 *   - 领域式：conn.session("").Page.enable()、conn.session(id).DOM.describeNode(...)
 *     注意会话层（target-surface.cjs）会再包一层，把页面会话号换成空串；直接用连接层时 sessionId 要写真的会话号。
 */

const DEFAULT_TIMEOUT_MS = 15_000;
/** 单条消息上限：正常最大的消息是截图（base64 十几 MB），128 MB 以上一定是协议乱了 */
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
/** 根会话（浏览器级）的会话号：空串（快照/动作模块也写死了这个值） */
const ROOT_SESSION = "";

/* ---------------- 错误 ---------------- */

class CdpTimeoutError extends Error {
  constructor(method, ms, sessionId) {
    super(`CDP 命令 ${method} 超过 ${Math.round(ms / 1000)} 秒没有返回`);
    this.name = "TimeoutError";
    this.code = "CDP_TIMEOUT";
    this.method = method;
    this.sessionId = sessionId || ROOT_SESSION;
  }
}

class CdpError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ method?: string, sessionId?: string, cdpCode?: number, cdpData?: string, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 浏览器自己报的错 → 我们的错误码。只是按 Chromium 的措辞做启发式归类，
 * 归不进去就原样留在 CDP_ERROR（带 cdpCode 和原文），不丢信息、也不假装认得。
 */
function codeForCdpError(message) {
  const text = String(message || "");
  if (/Session with given id not found|No session with given id|Not attached to an active page|Session.*not found/i.test(text)) return "SESSION_CLOSED";
  if (/Inspected target navigated or closed|Target closed|Target.*has been closed|No target with given id/i.test(text)) return "TARGET_CLOSED";
  if (/Browser.*(closed|has been closed)|browser process.*(gone|closed)/i.test(text)) return "BROWSER_EXITED";
  return "CDP_ERROR";
}

/* ---------------- 管道分帧 ---------------- */

/**
 * 管道里的消息分帧：攒字节，按 \0 切，切出来的整段按 UTF-8 解码。
 * 用 Buffer 而不是字符串拼接，是因为 Node 的字符串按 UTF-16 下标走，跨块的多字节汉字会被截成半个。
 */
class NulFramer {
  constructor({ maxBytes = MAX_MESSAGE_BYTES, onMessage, onOverflow } = {}) {
    this.maxBytes = maxBytes;
    this.onMessage = onMessage;
    this.onOverflow = onOverflow;
    /** 已收到、还没遇到分隔符的字节片 */
    this.parts = [];
    this.size = 0;
  }

  /** @param {Buffer|string} chunk */
  feed(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let start = 0;
    while (start <= buf.length) {
      const zero = buf.indexOf(0, start);
      if (zero === -1) break;
      const piece = buf.subarray(start, zero);
      if (piece.length) { this.parts.push(piece); this.size += piece.length; }
      const text = this.size ? Buffer.concat(this.parts, this.size).toString("utf8") : "";
      this.parts = [];
      this.size = 0;
      start = zero + 1;
      // 连续两个 \0（或结尾多一个）会切出空消息：当噪声跳过，不算协议错误
      if (text) this.onMessage?.(text);
    }
    if (start < buf.length) {
      const rest = buf.subarray(start);
      this.parts.push(rest);
      this.size += rest.length;
      if (this.size > this.maxBytes) {
        this.parts = [];
        this.size = 0;
        this.onOverflow?.(this.maxBytes);
      }
    }
  }

  /** 流结束时缓冲区里还剩半条消息：当作截断，返回长度，调用方按协议错误处理 */
  drain() {
    const left = this.size;
    this.parts = [];
    this.size = 0;
    return left;
  }
}

/* ---------------- 传输：管道 ---------------- */

class PipeTransport {
  /**
   * @param {{ read: NodeJS.ReadableStream, write: NodeJS.WritableStream, label?: string, maxMessageBytes?: number }} options
   *   read：读子进程写出来的管道（Node 里是 child.stdio[4]）
   *   write：写进子进程的管道（child.stdio[3]）
   */
  constructor({ read, write, label = "管道", maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    if (!read || !write) throw new CdpError("CDP_TRANSPORT", "管道传输需要两个流（读第 4 号、写第 3 号文件描述符）");
    this.kind = "pipe";
    this.label = label;
    this.read = read;
    this.write = write;
    /** 本机主动关过：之后不许再写，但还等子进程退出/读端关闭来通知断开 */
    this.closing = false;
    /** 已经通知过断开了 */
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    this.framer = new NulFramer({
      maxBytes: maxMessageBytes,
      onMessage: (text) => this.onMessage?.(text),
      onOverflow: (limit) => this.#close({ code: "CDP_PROTOCOL", message: `管道里攒了超过 ${limit} 字节还没看到消息结束的 \\0，协议乱了` }),
    });
    read.on("data", this.onData = (chunk) => { try { this.framer.feed(chunk); } catch (error) { this.#close({ code: "CDP_PROTOCOL", message: `管道消息解析失败：${error.message}` }); } });
    read.on("error", this.onReadError = (error) => this.#close({ code: "CDP_DISCONNECTED", message: `管道读端出错：${error.message}`, cause: error }));
    read.on("close", this.onReadClose = () => this.#close({ code: "CDP_DISCONNECTED", message: "管道读端已关闭（浏览器退出或崩溃）" }));
    read.on("end", this.onReadEnd = () => this.#close({ code: "CDP_DISCONNECTED", message: "管道读端已结束" }));
    write.on("error", this.onWriteError = (error) => this.#close({ code: "CDP_DISCONNECTED", message: `管道写端出错：${error.message}`, cause: error }));
  }

  /** 一条消息：JSON 文本 + \0 */
  send(text) {
    if (this.closed || this.closing) throw new CdpError("CDP_DISCONNECTED", `连接已断开，写不进去了（${this.label}）`);
    try {
      this.write.write(`${text}\0`);
    } catch (error) {
      this.#close({ code: "CDP_DISCONNECTED", message: `管道写端出错：${error.message}`, cause: error });
      throw new CdpError("CDP_DISCONNECTED", `管道写端出错：${error.message}`, { cause: error });
    }
  }

  /**
   * 关掉写端。不立刻销毁读端：浏览器看到 EOF 会自己退出，退出原因（exit code）还要读得到。
   * 读端由子进程退出事件或流自己关闭来收尾，那时才通知断开。
   */
  close() {
    if (this.closing || this.closed) return;
    this.closing = true;
    try { this.write.end?.(); } catch { /* 已经断了 */ }
  }

  #close(info) {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    const left = this.framer.drain();
    this.onClose?.(left > 0 ? { ...info, message: `${info.message}（还有 ${left} 字节没读完的半条消息）` } : info);
  }

  /** 浏览器进程先没了、写端却没报错时，引擎可以拿这个主动收尾（幂等） */
  markClosed(info) {
    this.#close(info);
  }
}

/* ---------------- 传输：WebSocket ---------------- */

/**
 * 把两种 WebSocket 实现归一成 { send(text), close() }：
 *   - 浏览器 / Node 自带的 WHATWG 版（addEventListener + event.data）
 *   - ws 这个包（on('message') + 回调里的 data）
 * Chrome 备用内核走这条，因此要能吞掉两种形状；没装 ws、运行时也没有全局 WebSocket 时明确报错，不默默降级。
 */
class WebSocketTransport {
  constructor(ws, { label = "WebSocket" } = {}) {
    this.kind = "ws";
    this.label = label;
    this.ws = ws;
    this.closing = false;
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    const isWhatwg = typeof ws.addEventListener === "function";
    this.isWhatwg = isWhatwg;
    if (isWhatwg) {
      ws.addEventListener("message", this.onMessageEvent = (event) => {
        const data = event?.data;
        if (typeof data === "string") this.onMessage?.(data);
        else if (data?.toString) this.onMessage?.(data.toString());
      });
      ws.addEventListener("close", this.onCloseEvent = (event) => this.#close({ code: "CDP_DISCONNECTED", message: `WebSocket 已关闭（${event?.code ?? "?"}${event?.reason ? ` ${event.reason}` : ""}）` }));
      ws.addEventListener("error", this.onErrorEvent = () => this.#close({ code: "CDP_DISCONNECTED", message: "WebSocket 出错" }));
    } else {
      ws.on("message", this.onMessageEvent = (data) => this.onMessage?.(typeof data === "string" ? data : data.toString()));
      ws.on("close", this.onCloseEvent = (code, reason) => this.#close({ code: "CDP_DISCONNECTED", message: `WebSocket 已关闭（${code ?? "?"}${reason ? ` ${String(reason)}` : ""}）` }));
      ws.on("error", this.onErrorEvent = (error) => this.#close({ code: "CDP_DISCONNECTED", message: `WebSocket 出错：${error?.message || error}` }));
    }
  }

  send(text) {
    if (this.closed || this.closing) throw new CdpError("CDP_DISCONNECTED", `连接已断开，写不出去了（${this.label}）`);
    try {
      this.ws.send(text);
    } catch (error) {
      this.#close({ code: "CDP_DISCONNECTED", message: `WebSocket 写失败：${error.message}`, cause: error });
      throw new CdpError("CDP_DISCONNECTED", `WebSocket 写失败：${error.message}`, { cause: error });
    }
  }

  close(code = 1000, reason = "bye") {
    if (this.closing || this.closed) return;
    this.closing = true;
    try { this.ws.close(code, reason); } catch { /* 已经断了 */ }
  }

  #close(info) {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.onClose?.(info);
  }

  /** 对端先断了、close 事件却没到时，引擎可以拿这个主动收尾（幂等） */
  markClosed(info) {
    this.#close(info);
  }
}

/** 找一个能用的 WebSocket 实现（不改依赖：有全局就用全局，装了 ws 就用 ws） */
function resolveWebSocketImpl(explicit) {
  if (explicit) return explicit;
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    const Required = require("ws");
    return Required.WebSocket || Required;
  } catch { /* 两个都没有 */ }
  throw new CdpError("CDP_TRANSPORT", "这台机器上没有 WebSocket 实现：需要 Node 自带的全局 WebSocket，或者装 ws 这个包");
}

/* ---------------- 连接 ---------------- */

class CdpConnection {
  /**
   * @param {PipeTransport | WebSocketTransport} transport
   * @param {{ timeoutMs?: number, label?: string }} [options]
   */
  constructor(transport, { timeoutMs = DEFAULT_TIMEOUT_MS, label = "CDP 连接" } = {}) {
    if (!transport || typeof transport.send !== "function") throw new CdpError("CDP_TRANSPORT", "连接需要一个传输（管道或 WebSocket）");
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.nextId = 1;
    /** Map<"会话号|命令号", { method, sessionId, resolve, reject, timer, startedAt }> */
    this.pending = new Map();
    /** Map<"Domain.event", Set<{ sessionId: string|undefined, handler }>> */
    this.listeners = new Map();
    /** Map<"*", Set<handler>>：不想按事件名挑的时候用，调试和调用日志 */
    this.anyListeners = new Set();
    /** 断开原因：null 表示还连着 */
    this.closedInfo = null;
    /**
     * 已经死掉的会话：Map<会话号, { code, message, at }>。
     * 为什么要记：2026-10-24 真机实测，标签页被关掉之后，往它的旧会话发命令，浏览器**不回**——
     * 不报错、不返回，只能等满 15 秒超时。所以收到 Target.detachedFromTarget / Inspector.detached 就标记死掉，
     * 在途的命令当场按 SESSION_CLOSED 失败，之后也不许再往这个会话发。
     */
    this.deadSessions = new Map();
    this.closeHandlers = new Set();
    this.stats = { sent: 0, received: 0, events: 0, other: 0, protocolErrors: 0, bytesOut: 0, bytesIn: 0, failed: 0, timedOut: 0 };
    /** 收到不是 JSON 的消息时回调；不设就只计数（半条包不该把整条连接带走） */
    this.onProtocolError = null;
    transport.onMessage = (text) => this.#onMessage(text);
    transport.onClose = (info) => this.disconnect(info);
    // 会话没了是浏览器自己通知的；这两条是 CDP 里通用的「会话生命周期」，在连接层收最省事
    this.onEvent("Target.detachedFromTarget", (params, from) => {
      const session = params?.sessionId;
      if (session) this.markSessionClosed(session, {
        code: "SESSION_CLOSED",
        message: `标签页会话已断开（${params?.reason || "detached"}），可能是这个标签页被关掉了`,
        parentSessionId: from,
      });
    });
    this.onEvent("Inspector.detached", (params, from) => {
      if (from) this.markSessionClosed(from, { code: "SESSION_CLOSED", message: `标签页会话已被浏览器断开（${params?.reason || "detached"}）` });
    });
  }

  /* ---------- 建立连接 ---------- */

  /**
   * @param {{ read: NodeJS.ReadableStream, write: NodeJS.WritableStream, timeoutMs?: number, label?: string }} options
   * @returns {CdpConnection}
   */
  static overPipe({ read, write, timeoutMs, label = "管道连接" } = {}) {
    return new CdpConnection(new PipeTransport({ read, write, label }), { timeoutMs, label });
  }

  /**
   * 从子进程接管道：浏览器必须是用 stdio 里带第 3、4 号管道的方式启动的（`--remote-debugging-pipe`）。
   * 进程退出、启动失败都会把连接按 BROWSER_EXITED / CDP_DISCONNECTED 结算掉。
   * @param {import("node:child_process").ChildProcess} child
   */
  static overChild(child, { timeoutMs, label = "管道连接" } = {}) {
    const write = child?.stdio?.[3];
    const read = child?.stdio?.[4];
    if (!write || !read) {
      // 启动失败时（比如找不到程序）子进程也会发 error 事件；先挂个空监听，免得起一个没人接的未捕获异常
      child?.on?.("error", () => {});
      throw new CdpError("CDP_TRANSPORT", "子进程没有第 3、4 号管道：启动时要写 stdio: ['pipe','pipe','pipe','pipe','pipe']，并加 --remote-debugging-pipe");
    }
    const conn = CdpConnection.overPipe({ read, write, timeoutMs, label: `${label}（进程 ${child.pid ?? "?"}）` });
    conn.child = child;
    conn.processState = { pid: child.pid ?? null, exited: false, exitCode: null, signal: null };
    child.once("exit", (code, signal) => {
      conn.processState = { pid: child.pid ?? null, exited: true, exitCode: code, signal };
      const how = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      conn.disconnect({ code: "BROWSER_EXITED", message: `浏览器进程已经退出（${how}）`, exitCode: code, signal });
    });
    child.once("error", (error) => {
      conn.disconnect({ code: "CDP_DISCONNECTED", message: `浏览器进程启动失败：${error.message}`, cause: error });
    });
    return conn;
  }

  /**
   * Chrome 备用内核的 WebSocket 版。地址是浏览器自己报的 ws://127.0.0.1:端口/devtools/browser/…
   * @param {string} url
   * @param {{ timeoutMs?: number, label?: string, WebSocketImpl?: any }} [options]
   */
  static async connectWebSocket(url, { timeoutMs, label = "WebSocket 连接", WebSocketImpl } = {}) {
    const Impl = resolveWebSocketImpl(WebSocketImpl);
    const ws = new Impl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new CdpError("CDP_TIMEOUT", `连 WebSocket 超过 ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)} 秒`)); try { ws.close?.(); } catch { /* */ } }, timeoutMs || DEFAULT_TIMEOUT_MS);
      const ok = () => { clearTimeout(timer); resolve(); };
      const bad = (error) => { clearTimeout(timer); reject(new CdpError("CDP_DISCONNECTED", `连不上 ${url}：${error?.message || error}`, { cause: error })); };
      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("open", ok, { once: true });
        ws.addEventListener("error", (event) => bad(event?.error || new Error("WebSocket 握手失败")), { once: true });
      } else {
        ws.once("open", ok);
        ws.once("error", bad);
      }
    });
    return new CdpConnection(new WebSocketTransport(ws, { label }), { timeoutMs, label });
  }

  /* ---------- 发命令 ---------- */

  get isClosed() { return this.closedInfo !== null; }
  get closedReason() { return this.closedInfo; }

  /**
   * 发一条命令，拿到 result（不含 id/sessionId 外壳）。
   * @param {string} method
   * @param {object} [params]
     * @param {string} [sessionId]  空串/不传 = 浏览器级会话；页面会话要写真的会话号
     * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
     *   signal：调用方已经拿到结论（例如热点「点击弹出了对话框」）时用它把这条命令就地作废，
     *   不必等到超时；在途命令表里删掉它，迟到的结果按「超时之后才回来」丢掉。
     * @returns {Promise<any> & { abort?: (reason?: any) => boolean }}
     */
  send(method, params = {}, sessionId = ROOT_SESSION, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.closedInfo) return Promise.reject(this.#closedError(method, sessionId));
    const session = sessionId || ROOT_SESSION;
    if (session) {
      const dead = this.deadSessions.get(session);
      if (dead) return Promise.reject(new CdpError(dead.code, `${dead.message}；命令 ${method} 发不出去`, { method, sessionId: session }));
    }
    // 已经取消的命令不能先发出去再作废：写命令会在页面上真的执行，调用方却以为取消了。
    if (signal?.aborted) {
      return Promise.reject(new CdpError("CDP_ABORTED", `命令 ${method} 在发出前已被调用方取消`, { method, sessionId: session, aborted: true }));
    }
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (session) payload.sessionId = session;
    let text;
    try {
      text = JSON.stringify(payload);
    } catch (error) {
      return Promise.reject(new CdpError("CDP_PROTOCOL", `命令 ${method} 的参数没法转成 JSON：${error.message}`, { method, sessionId: session, cause: error }));
    }
    const key = `${session}|${id}`;
    let abort = null;
    const work = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(key);
        fn(value);
      };
      // 就地作废：命令已经发出去，浏览器那边可能还在处理，但我们不等了（调用方已经拿别的证据下了结论）
      abort = (reason) => {
        if (settled) return false;
        finish(reject, reason ?? new CdpError("CDP_ABORTED", `命令 ${method} 已被调用方作废（不等结果了）`, { method, sessionId: session, aborted: true }));
        return true;
      };
      const timer = setTimeout(() => {
        this.stats.timedOut++;
        finish(reject, new CdpTimeoutError(method, timeoutMs, session));
      }, timeoutMs);
      this.pending.set(key, { method, sessionId: session, resolve, reject, timer, startedAt: Date.now(), abort });
      const onAbort = () => { abort(); };
      if (signal) {
        // 竞态：上面的检查之后、这里之前被取消。此时还没 transport.send，直接结算，别发。
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener?.("abort", onAbort, { once: true });
      }
      try {
        this.transport.send(text);
        this.stats.sent++;
        this.stats.bytesOut += Buffer.byteLength(text);
      } catch (error) {
        // 传输已经断了：disconnect 会结算在途命令，这一条自己也要立刻结掉
        this.stats.failed++;
        finish(reject, error instanceof CdpError ? error : new CdpError("CDP_DISCONNECTED", `命令 ${method} 没发出去：${error.message}`, { method, sessionId: session, cause: error }));
      }
    });
    // 让调用方拿到这条命令的句柄，需要时可就地作废（Surface 层「弹对话框就别再等鼠标 ack」用）
    work.abort = (reason) => Boolean(abort?.(reason));
    return work;
  }

  /* ---------- 收事件 ---------- */

  /**
   * 订阅事件。sessionId 不传 = 所有会话的该事件都收；传了就只收这个会话（空串 = 浏览器级）。
   * 返回退订函数。
   * @param {string} event  "Domain.event"
   * @param {(params: any, sessionId: string) => void} handler
   * @param {string} [sessionId]
   */
  onEvent(event, handler, sessionId) {
    const entry = { sessionId, handler };
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(entry);
    return () => { this.listeners.get(event)?.delete(entry); };
  }

  /** 收所有事件（调试、调用日志）。handler(method, params, sessionId)。 */
  onAnyEvent(handler) {
    this.anyListeners.add(handler);
    return () => this.anyListeners.delete(handler);
  }

  /** 等某个事件来一次。match 返回 true 才算命中；连接断了就立刻失败，不等满时限。 */
  waitForEvent(event, { sessionId, timeoutMs = this.timeoutMs, match = () => true } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closedInfo) {
        reject(new CdpError(this.closedInfo.code, `${this.closedInfo.message}，等不到 ${event} 了`, { sessionId }));
        return;
      }
      let timer;
      let offClose = () => {};
      const off = this.onEvent(event, (params, from) => {
        if (!match(params, from)) return;
        clearTimeout(timer);
        off();
        offClose();
        resolve({ params, sessionId: from });
      }, sessionId);
      offClose = this.onClose((info) => {
        clearTimeout(timer);
        off();
        reject(new CdpError(info.code, `${info.message}，等不到 ${event} 了`, { cause: info.cause, exitCode: info.exitCode }));
      });
      timer = setTimeout(() => {
        off();
        offClose();
        reject(new CdpTimeoutError(event, timeoutMs, sessionId));
      }, timeoutMs);
    });
  }

  /* ---------- 断开 ---------- */

  /** 连接断了（传输自己断的、进程退出的、超时收尾的）时回调，已在断开状态就立刻回调一次。 */
  onClose(handler) {
    if (this.closedInfo) { try { handler(this.closedInfo); } catch { /* 回调自己的错不算连接的 */ } return () => {}; }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * 标记某个页面会话已经死了：在途命令当场报错，之后不许再往它发。
   * 收到 Target.detachedFromTarget / Inspector.detached 会自动调；会话层（target-surface）关自己时也调一次。
   * @param {string} sessionId
   * @param {{ code?: string, message?: string, parentSessionId?: string }} [info]
   */
  markSessionClosed(sessionId, { code = "SESSION_CLOSED", message = "标签页会话已经不在了", parentSessionId = null } = {}) {
    if (!sessionId) return null;
    const existing = this.deadSessions.get(sessionId);
    if (existing) return existing;
    const record = { code, message, at: Date.now(), parentSessionId };
    this.deadSessions.set(sessionId, record);
    // 长命的浏览器里标签页会反复开关：名单只留最近的一批，免得一直涨
    while (this.deadSessions.size > 512) {
      const oldest = this.deadSessions.keys().next().value;
      this.deadSessions.delete(oldest);
    }
    const pending = [...this.pending.entries()].filter(([, entry2]) => entry2.sessionId === sessionId);
    for (const [key, entry2] of pending) {
      this.pending.delete(key);
      clearTimeout(entry2.timer);
      entry2.reject(new CdpError(code, `${message}（${entry2.method} 没等到结果）`, { method: entry2.method, sessionId, cause: new CdpError(code, message) }));
    }
    return record;
  }

  /** 这个会话是不是已经判死了 */
  isSessionClosed(sessionId) {
    return Boolean(sessionId) && this.deadSessions.has(sessionId);
  }

  /**
   * 结算连接：所有在途命令报错、通知断开监听、之后 send 立刻失败。
   * 由传输/子进程退出自动调；也可以由引擎在收尾时主动调。重复调用只生效第一次。
   * @param {{ code?: string, message?: string, cause?: unknown, exitCode?: number|null, signal?: string|null }} [info]
   */
  disconnect({ code = "CDP_DISCONNECTED", message = "连接已断开", cause = null, exitCode = null, signal = null } = {}) {
    if (this.closedInfo) return this.closedInfo;
    const info = { code, message, cause, exitCode, signal, at: Date.now() };
    this.closedInfo = info;
    // 先把在途命令全部结算，再通知外面：调用方拿到错误时，连接状态已经是一致的
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      const error = new CdpError(code, `${message}（${entry.method} 没等到结果）`, { method: entry.method, sessionId: entry.sessionId, cause, exitCode });
      entry.reject(error);
    }
    this.listeners.clear();
    this.anyListeners.clear();
    this.deadSessions.clear();
    for (const handler of [...this.closeHandlers]) {
      try { handler(info); } catch { /* 一个监听器出错不影响别的 */ }
    }
    this.closeHandlers.clear();
    return info;
  }

  /** 本机主动关：先断传输（管道会停掉浏览器），再结算命令。 */
  close(reason = "连接已由本机关闭") {
    if (this.closedInfo) return this.closedInfo;
    try { this.transport.close(); } catch { /* 已经断了 */ }
    return this.disconnect({ code: "CDP_CLOSED", message: reason });
  }

  /* ---------- 领域式接口 ---------- */

  /**
   * session(会话号).Domain.method(params) 发命令，session(会话号).Domain.on(event, fn) 收这个会话的事件。
   * 不传会话号 = 浏览器级会话；注意 `.on` 在不传会话号时收所有会话的事件。
   */
  session(sessionId = ROOT_SESSION) {
    const conn = this;
    const scope = sessionId === ROOT_SESSION ? undefined : sessionId;
    return new Proxy({}, {
      get(_target, domain) {
        if (typeof domain !== "string" || domain === "then") return undefined;
        return new Proxy({}, {
          get(_t, name) {
            if (typeof name !== "string") return undefined;
            if (name === "on") return (event, handler) => conn.onEvent(`${domain}.${event}`, handler, scope);
            return (params = {}) => conn.send(`${domain}.${name}`, params, sessionId);
          },
        });
      },
    });
  }

  /* ---------- 内部 ---------- */

  #closedError(method, sessionId) {
    const info = this.closedInfo;
    return new CdpError(info.code, `浏览器已经不在了（${info.message}），命令 ${method} 没法发；需要重新打开账号窗口`, {
      method,
      sessionId: sessionId || ROOT_SESSION,
      cause: info.cause,
      exitCode: info.exitCode,
    });
  }

  #onMessage(text) {
    if (this.closedInfo) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      // 半条消息、乱码：报给外面，但**不**断连接（一条坏消息不等于整条链路不可信，分帧仍然由 \0 保证）
      this.stats.protocolErrors++;
      this.onProtocolError?.({ message: `收到不是 JSON 的消息：${String(text).slice(0, 120)}`, cause: error });
      return;
    }
    if (!message || typeof message !== "object") return;
    this.stats.received++;
    this.stats.bytesIn += Buffer.byteLength(text);
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : ROOT_SESSION;

    if (typeof message.id === "number" || typeof message.id === "string") {
      const key = `${sessionId}|${message.id}`;
      const entry = this.pending.get(key);
      if (!entry) { this.stats.other++; return; } // 超时之后才回来的结果：丢掉，不打扰任何人
      this.pending.delete(key);
      clearTimeout(entry.timer);
      if (message.error) {
        const text2 = String(message.error.message ?? "没有说明");
        this.stats.failed++;
        entry.reject(new CdpError(codeForCdpError(text2), `${entry.method} 被浏览器拒绝：${text2}`, {
          method: entry.method,
          sessionId: entry.sessionId,
          cdpCode: message.error.code,
          cdpData: message.error.data,
        }));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === "string") {
      this.stats.events++;
      this.#dispatch(message.method, message.params ?? {}, sessionId);
      return;
    }
    this.stats.other++;
  }

  #dispatch(method, params, sessionId) {
    for (const handler of [...this.anyListeners]) {
      try { handler(method, params, sessionId); } catch { /* 一个监听器出错不影响别的 */ }
    }
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    for (const entry of [...handlers]) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      try { entry.handler(params, sessionId); } catch { /* 一个监听器出错不影响别的 */ }
    }
  }
}

module.exports = {
  CdpConnection,
  PipeTransport,
  WebSocketTransport,
  NulFramer,
  CdpError,
  CdpTimeoutError,
  codeForCdpError,
  resolveWebSocketImpl,
  ROOT_SESSION,
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
};
