/**
 * AI 空间自动收摊的策略层：纯函数，不碰浏览器、不读文件、不记日志，单测直接调。
 *
 * 为什么单独一层：定时器、chrome.tabs.discard、审计谁来做是 electron/space-reaper.cjs 的事，
 * 这里只回答「这个空间现在该关 / 该卸载 / 别动」。判断条件写在一处，以后加规则不用改三个地方。
 *
 * 产品规矩（用户 2026-10-28 定）：AI 用完浏览器必须收摊，不然几百个标签页吃光内存。
 *   - 「我的」永远不碰（owner 不是 ai 一律不动）；
 *   - keep:true 的空间是「用户要亲自看结果」：空闲后只卸载内存，不关闭、不删记录；
 *   - 需要你 / 人已接管 / 交接中（控制权不是 ai_running）不碰；
 *   - 人正看着的前台标签页不碰（判断沿用 HumanTakeoverWatcher 的 foreground）；
 *   - 会话断开满 2 分钟，不用等 idleMinutes，按上面同样条件立刻判断一次；
 *   - idleMinutes = 0（「永不」）：不自动关闭，空闲够久只卸载。
 */

/** 设置里能选的 idleMinutes：5 / 10 / 30，0 = 永不（只卸载） */
export const IDLE_MINUTE_CHOICES = Object.freeze([5, 10, 30, 0]);
export const DEFAULT_IDLE_MINUTES = 10;
/** 「永不」时仍然要卸载内存：用默认的 10 分钟当卸载门槛 */
export const UNLOAD_IDLE_MINUTES = DEFAULT_IDLE_MINUTES;
export const MINUTE_MS = 60_000;
/** MCP 会话断开后多久没回来就算真的走了 */
export const SESSION_GONE_GRACE_MS = 2 * MINUTE_MS;
/** 系统可用物理内存低于这个值就卸载后台标签页（1.5 GB） */
export const MEMORY_FLOOR_BYTES = 1.5 * 1024 ** 3;
/** 后台多久检查一次 */
export const REAP_INTERVAL_MS = MINUTE_MS;

/** 自动动作的原因，写进审计事件的 reason 字段 */
export const REAP_REASONS = Object.freeze({
  IDLE: "idle",
  SESSION_GONE: "session_gone",
  LOW_MEMORY: "low_memory",
});

/** 审计事件类型（写进 Bridge 的 call-log，和 handoff / return / approval 平级） */
export const REAP_EVENT_TYPES = Object.freeze({
  CLOSE: "space_auto_close",
  DISCARD: "space_auto_discard",
});

/** 设置里存的值不认识就当默认 10 分钟（老配置没有这个字段也是它） */
export function parseIdleMinutes(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_IDLE_MINUTES;
  const minutes = Number(value);
  return IDLE_MINUTE_CHOICES.includes(minutes) ? minutes : DEFAULT_IDLE_MINUTES;
}

/** 控制权不是 ai_running 就别动：需要人处理 / 人接管 / 交接中 / 暂停 / 等批准都算 */
export function isControlProtected(state) {
  const text = String(state ?? "").trim();
  return text !== "" && text !== "ai_running";
}

function noAction() {
  return { action: "none", reason: null };
}

/**
 * 空闲（含会话断开）这个空间该怎么办。
 *
 * @param {{
 *   owner?: string, keep?: boolean, tabAlive?: boolean, controlState?: string,
 *   foreground?: boolean, lastAiActivityAt?: number, sessionGoneAt?: number,
 * }} space 空间视图（backend.spacesForAutoClose 给的）
 * @param {{now?: number, idleMinutes?: number, sessionGoneGraceMs?: number}} [options]
 * @returns {{action: "none"|"close"|"discard", reason: "idle"|"session_gone"|null}}
 */
export function decideIdleAction(space, options = {}) {
  const now = Number(options.now ?? Date.now());
  const idleMinutes = parseIdleMinutes(options.idleMinutes);
  const grace = Number(options.sessionGoneGraceMs ?? SESSION_GONE_GRACE_MS);
  if (!space || space.owner !== "ai") return noAction();
  // 没有标签页就没有可关 / 可卸载的：名字记录留着（删掉只会让用户以为空间丢了）
  if (space.tabAlive === false) return noAction();
  if (space.foreground === true) return noAction();
  // 人点控制条「接管 / 终止任务」也算人在用这个标签页（接管模块的状态），哪怕窗口不在前台
  if (space.held === true) return noAction();
  if (isControlProtected(space.controlState)) return noAction();

  const keep = space.keep === true;
  // 关闭 = 关标签页 + 删记录；卸载 = chrome.tabs.discard，人点回去会自己重载
  const cause = (reason) => ({ action: keep ? "discard" : "close", reason });

  // 会话走掉满 2 分钟：不用等 idleMinutes，立刻按同样条件判断
  const goneAt = Number(space.sessionGoneAt) > 0 ? Number(space.sessionGoneAt) : 0;
  if (goneAt > 0 && now - goneAt >= grace) return cause(REAP_REASONS.SESSION_GONE);

  const last = Number(space.lastAiActivityAt) > 0 ? Number(space.lastAiActivityAt) : 0;
  if (!last) return noAction(); // 不知道最后活动时间就别动，宁可不收

  if (idleMinutes === 0) {
    // 「永不」：只卸载不关闭；门槛用默认 10 分钟，免得每分钟都把刚卸载的又审一遍
    if (now - last >= UNLOAD_IDLE_MINUTES * MINUTE_MS) return { action: "discard", reason: REAP_REASONS.IDLE };
    return noAction();
  }

  if (now - last < idleMinutes * MINUTE_MS) return noAction();
  return cause(REAP_REASONS.IDLE);
}

/**
 * 内存闸门：可用物理内存低于下限时，按最久没用的顺序挑要卸载的 AI 空间后台标签页。
 * 只返回顺序，不判断「卸载几个就够」—— 调用方每次卸载后重新读一次可用内存，回到下限以上就停。
 *
 * 不碰的：owner 不是 ai（「我的」）、人正看着的前台标签页、没有标签页的空间。
 * keep:true 不排除：卸载只释放内存，人点回去会自动重新加载。
 *
 * @param {Array<{gridId: string, spaceId: string, name?: string, owner?: string, keep?: boolean,
 *   tabAlive?: boolean, foreground?: boolean, lastAiActivityAt?: number, createdAt?: number}>} spaces
 * @param {{availableBytes?: number, floorBytes?: number}} [options]
 */
export function planMemoryRelief(spaces, options = {}) {
  const floor = Number(options.floorBytes ?? MEMORY_FLOOR_BYTES);
  const available = Number(options.availableBytes);
  if (!Number.isFinite(available) || !Number.isFinite(floor)) return [];
  if (available >= floor) return [];
  return (Array.isArray(spaces) ? spaces : [])
    .filter((space) => space && space.owner === "ai")
    .filter((space) => space.tabAlive !== false)
    .filter((space) => space.foreground !== true)
    .filter((space) => space.held !== true)
    .map((space) => ({
      // 排序键：最后一次 AI 活动；不知道就按创建时间（更老）
      usedAt: Number(space.lastAiActivityAt) > 0 ? Number(space.lastAiActivityAt) : Number(space.createdAt) || 0,
      space,
    }))
    .sort((a, b) => a.usedAt - b.usedAt)
    .map(({ space }) => ({
      gridId: String(space.gridId ?? ""),
      spaceId: String(space.spaceId ?? ""),
      name: String(space.name ?? ""),
      reason: REAP_REASONS.LOW_MEMORY,
    }))
    .filter((item) => item.gridId && item.spaceId);
}
