/**
 * AI 空间自动收摊的定时器层：每分钟看一遍 AI 空间，空闲到点就关掉，内存不够就卸载后台标签页。
 *
 * 判断全在 src/core/space-autoclose.js（纯函数，单测直接调）；这里只做三件事：
 *   1) 拿空间视图（backend.spacesForAutoClose）、什么时候算「人正在看」（isForeground）；
 *   2) 调 backend.spaceClose / backend.spaceDiscard；
 *   3) 写审计事件（空间名 + 原因 + 标签页数量，绝不写网址 / 页面内容）。
 *
 * 安全取向：人正在看的前台判断拿不到（插件没连上、轮询还没跑完）就当成「人在看」，宁可不收也不误关。
 * 同一份策略也用在会话断开（断开满 2 分钟时插一次临时检查，不用等满 idleMinutes）。
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** 和 src/core/space-autoclose.js 的 SESSION_GONE_GRACE_MS 同一个值（那边是判断，这边只用来排检查时间） */
const SESSION_GONE_GRACE_MS = 2 * 60_000;

/** 策略模块是 ESM（和 src/core 其它模块一致），按需动态加载一次 */
let policyPromise = null;
function loadPolicy() {
  policyPromise ??= import(pathToFileURL(path.join(__dirname, "..", "src", "core", "space-autoclose.js")).href);
  return policyPromise;
}

class SpaceReaper {
  /**
   * @param {{
   *   backend: any,
   *   log?: (text: string) => void,
   *   audit?: (event: object) => Promise<void>|void,
   *   isForeground?: (gridId: string, spaceId: string) => boolean|null,
   *   isHeld?: (gridId: string, spaceId: string) => boolean,
   *   getIdleMinutes?: () => number,
   *   getAvailableMemoryBytes?: () => number|null,
   *   now?: () => number,
   *   intervalMs?: number,
   *   timerApi?: {setTimeout: Function, clearTimeout: Function},
   * }} options
   */
  constructor({
    backend = null,
    log = () => {},
    audit = null,
    isForeground = null,
    isHeld = null,
    getIdleMinutes = null,
    getAvailableMemoryBytes = null,
    now = Date.now,
    intervalMs = 60_000,
    timerApi = null,
  } = {}) {
    this.backend = backend;
    this.log = typeof log === "function" ? log : () => {};
    this.audit = typeof audit === "function" ? audit : null;
    this.isForeground = typeof isForeground === "function" ? isForeground : null;
    this.isHeld = typeof isHeld === "function" ? isHeld : null;
    this.getIdleMinutes = typeof getIdleMinutes === "function" ? getIdleMinutes : null;
    this.getAvailableMemoryBytes = typeof getAvailableMemoryBytes === "function" ? getAvailableMemoryBytes : null;
    this.now = typeof now === "function" ? now : Date.now;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || 60_000);
    this.setTimer = timerApi?.setTimeout || setTimeout;
    this.clearTimer = timerApi?.clearTimeout || clearTimeout;
    this.timer = null;
    this.running = false;
    this.ticking = false;
    /** 会话断开后要插的那次检查的时间点（0 = 没有） */
    this.sessionCheckAt = 0;
    /** Map<`格子#空间`, 时间>：刚卸载过的别再每分钟重复卸载（5 分钟冷却） */
    this.recentDiscards = new Map();
  }

  /** 每 5 分钟允许对同一个空间再做一次卸载（期间它没被 AI 用过） */
  static DISCARD_COOLDOWN_MS = 5 * 60_000;

  start() {
    if (this.running) return this;
    this.running = true;
    this.#schedule(this.intervalMs);
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

  /**
   * Bridge 报「这个 MCP 会话断了」：记到空间上，2 分钟后插一次检查。
   * 会话回来（任何一次带 sessionId 的调用）会把 sessionGoneAt 清掉，那次检查自然什么都不做。
   */
  noteSessionClosed(sessionId) {
    if (!sessionId) return;
    const backend = this.backend;
    if (!backend || typeof backend.noteSessionGone !== "function") return;
    try {
      const affected = backend.noteSessionGone(String(sessionId), this.now());
      if (affected > 0) this.log(`MCP 会话 ${String(sessionId).slice(0, 12)}… 断了，${affected} 个空间 2 分钟后检查是否收摊`);
    } catch (error) {
      this.log(`记录会话断开失败（不影响其它功能）：${error.message}`);
    }
    this.#scheduleSessionCheck();
  }

  /** 会话断开了就安排一次「满 2 分钟」的检查；已经在跑也更早的那次为准 */
  #scheduleSessionCheck() {
    const at = this.now() + SESSION_GONE_GRACE_MS;
    if (this.sessionCheckAt === 0 || at < this.sessionCheckAt) this.sessionCheckAt = at;
    if (this.running) this.#schedule(SESSION_GONE_GRACE_MS);
  }

  #schedule(delay) {
    if (!this.running) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    let wait = Math.max(0, Number(delay) || 0);
    if (this.sessionCheckAt > 0) {
      wait = Math.min(wait, Math.max(0, this.sessionCheckAt - this.now()));
    }
    this.timer = this.setTimer(async () => {
      this.timer = null;
      if (!this.running) return;
      // 上一轮还没跑完（浏览器回得慢）就跳过这一拍，别堆请求
      if (!this.ticking) {
        this.ticking = true;
        this.sessionCheckAt = 0;
        try {
          await this.runOnce();
        } catch (error) {
          this.log(`自动收摊检查出错（不影响控制服务）：${error.message}`);
        } finally {
          this.ticking = false;
        }
      }
      this.#schedule(this.intervalMs);
    }, wait);
    this.timer?.unref?.();
  }

  /**
   * 跑一轮。单测直接调它，不用等定时器。
   * @param {{now?: number}} [options]
   * @returns {Promise<{closed: string[], discarded: string[], audit: object[]}>}
   */
  async runOnce({ now = this.now() } = {}) {
    const summary = { closed: [], discarded: [], audit: [] };
    if (!this.backend) return summary;
    const policy = await loadPolicy();
    const idleMinutes = policy.parseIdleMinutes(this.getIdleMinutes ? this.getIdleMinutes() : undefined);

    // 1) 空闲 / 会话断开
    for (const raw of this.#safeSpaces()) {
      const space = this.#withHumanState(raw);
      const decision = policy.decideIdleAction(space, { now, idleMinutes });
      if (decision.action === "none") continue;
      const done = await this.#apply(space, decision, policy);
      if (!done) continue;
      if (decision.action === "close") summary.closed.push(space.spaceId);
      else summary.discarded.push(space.spaceId);
      if (done.audit) summary.audit.push(done.audit);
    }

    // 2) 内存闸门（标签页刚关掉一批，重新读一遍空间和可用内存）
    summary.discarded.push(...await this.#relieveMemory(policy, summary.audit));
    return summary;
  }

  /** 拿全部空间；后端没实现就看不了，别抛 */
  #safeSpaces() {
    try {
      const spaces = this.backend.spacesForAutoClose?.();
      return Array.isArray(spaces) ? spaces : [];
    } catch (error) {
      this.log(`读空间列表失败（这一拍跳过）：${error.message}`);
      return [];
    }
  }

  /**
   * 补上「人是不是正在看」。
   * 拿不到（null）当人在看：宁可少收一次，也不把用户正看的页面关掉。
   */
  #withHumanState(space) {
    const view = { ...space };
    if (view.tabAlive === false) {
      view.foreground = false;
      view.held = false;
      return view;
    }
    let foreground = null;
    if (this.isForeground) {
      try {
        foreground = this.isForeground(String(view.gridId ?? ""), String(view.spaceId ?? ""));
      } catch {
        foreground = null;
      }
    }
    view.foreground = foreground === null ? true : foreground === true;
    let held = false;
    if (this.isHeld) {
      try {
        held = this.isHeld(String(view.gridId ?? ""), String(view.spaceId ?? "")) === true;
      } catch {
        held = false;
      }
    }
    view.held = held;
    return view;
  }

  /** 执行关闭 / 卸载，返回 {audit}；失败只记日志，不影响下一批 */
  async #apply(space, decision, policy) {
    const close = decision.action === "close";
    const method = close ? "spaceClose" : "spaceDiscard";
    if (typeof this.backend[method] !== "function") return null;
    let result = null;
    try {
      result = await this.backend[method](space.gridId, space.spaceId);
    } catch (error) {
      this.log(`空间「${space.name}」自动${close ? "关闭" : "卸载"}失败（下一拍再试）：${error.message}`);
      return null;
    }
    const tabs = close ? Number(result?.closedTabs) || 0 : Number(result?.discarded) || 0;
    if (!close) {
      // 已经卸载过（0 个）就不重复写审计
      if (!tabs) return { audit: null };
      this.recentDiscards.set(`${space.gridId}#${space.spaceId}`, this.now());
    }
    const event = {
      type: close ? policy.REAP_EVENT_TYPES.CLOSE : policy.REAP_EVENT_TYPES.DISCARD,
      space: space.name,
      reason: decision.reason,
      tabs,
    };
    this.log(`空间「${space.name}」自动${close ? "关闭" : "卸载"}（${decision.reason}，${tabs} 个标签页）`);
    if (this.audit) {
      try {
        await this.audit(event);
      } catch (error) {
        this.log(`写自动收摊审计失败（忽略）：${error.message}`);
      }
    }
    return { audit: event };
  }

  /** 可用内存（字节）；拿不到就返回 null，闸门这一拍不动作 */
  #availableBytes() {
    if (!this.getAvailableMemoryBytes) return null;
    try {
      const value = Number(this.getAvailableMemoryBytes());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 内存闸门：低于下限就按最久没用的顺序卸载 AI 空间的后台标签页，直到回到下限以上或没有可卸载的。
   * 不关闭、不碰「我的」。
   */
  async #relieveMemory(policy, auditList) {
    const discarded = [];
    if (!this.getAvailableMemoryBytes) return discarded;
    const floor = policy.MEMORY_FLOOR_BYTES;
    let available = this.#availableBytes();
    if (available === null || available >= floor) return discarded;
    if (typeof this.backend.spaceDiscard !== "function") return discarded;

    const spaces = this.#safeSpaces().map((space) => this.#withHumanState(space));
    const plan = policy.planMemoryRelief(spaces, { availableBytes: available, floorBytes: floor });
    this.log(`可用内存 ${(available / 1024 ** 3).toFixed(2)} GB 低于 ${(floor / 1024 ** 3).toFixed(1)} GB，准备卸载 ${plan.length} 个 AI 空间的后台标签页`);
    for (const item of plan) {
      available = this.#availableBytes();
      if (available === null || available >= floor) break;
      const key = `${item.gridId}#${item.spaceId}`;
      const last = this.recentDiscards.get(key) || 0;
      if (last && this.now() - last < SpaceReaper.DISCARD_COOLDOWN_MS) continue;
      const space = spaces.find((candidate) => candidate.gridId === item.gridId && candidate.spaceId === item.spaceId);
      if (!space) continue;
      // #apply 只知道 close/discard 两种；这里给一个和 decide 同形的结果
      const done = await this.#apply(space, { action: "discard", reason: item.reason }, policy);
      if (done?.audit) {
        auditList.push(done.audit);
        discarded.push(item.spaceId);
      }
    }
    return discarded;
  }
}

module.exports = { SpaceReaper };
