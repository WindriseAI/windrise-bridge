/**
 * 导航之后的「等页面稳下来」：动作（点击 / 回车）可能触发导航，后退 / 前进在 SPA 里又是异步换页，
 * 立刻拍快照会拍到一张空壳（t3 报告：后退后第一次快照是空页，等 2 秒才恢复）。
 *
 * 这里只做一件事：反复问页面「你现在在哪、加载完了没、DOM 还动不动」，直到满足条件或超时。
 * 判据和 waitForPageReady 一致 —— readyState 为 complete，或 DOM 连续 quietMs 没有变动；
 * 额外看网址变没变，好让调用方知道「这次动作到底有没有换页」。
 *
 * 不抛错：超时返回 settled:false + reason，让调用方如实写进返回（比干等或假装成功诚实）。
 * 唯一的例外是页面已经没了（标签页关闭 / 会话断开），那种情况下继续问没有意义。
 */

/** 问一次页面身份和加载状态。 */
async function probePage(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      lastAt: window.__windriseQuiet ? window.__windriseQuiet.lastAt : 0,
    }))()`,
    returnByValue: true,
  });
  const value = result?.value ?? {};
  return {
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    readyState: String(value.readyState ?? ""),
    lastAt: Number(value.lastAt) || 0,
  };
}

/** 页面没了 / 会话没了：再问下去也不会有结果。 */
const HARD_FAIL = new Set(["TARGET_CLOSED", "SESSION_CLOSED", "BROWSER_EXITED", "CDP_DISCONNECTED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等页面稳下来。
 *
 * @param {{ send: Function }} cdp
 * @param {{
 *   previousUrl?: string|null,  上一次看到的网址；给了才能判「这次换页了没有」
 *   expectChange?: boolean,     一定要换页（后退 / 前进 / 导航用），超时算没换
 *   graceMs?: number,           没换页时再观察多久（毫秒），用来抓「点完稍晚才开始跳」的导航
 *   windowMs?: number,          不管稳不稳，至少观察这么久（毫秒）再下「没换页」的结论；
 *                               点「登录」这类按钮后导航常常晚一两百毫秒才开始
 *   timeoutMs?: number,         最长等多久
 *   quietMs?: number,           DOM 安静多久算稳
 *   pollMs?: number,
 * }} [options]
 * @returns {Promise<{ url: string, title: string, readyState: string, navigated: boolean, settled: boolean, waitedMs: number, reason: string, blockedBy: string|null }>}
 */
export async function waitForNavigationSettle(cdp, {
  previousUrl = null,
  expectChange = false,
  graceMs = 600,
  windowMs = 0,
  timeoutMs = 5_000,
  quietMs = 300,
  pollMs = 100,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(0, Number(timeoutMs) || 0);
  const graceUntil = started + Math.max(0, Number(graceMs) || 0);
  const windowUntil = started + Math.max(0, Number(windowMs) || 0);
  let last = { url: previousUrl ?? "", title: "", readyState: "", lastAt: 0 };
  let seenChange = false;
  let sawReady = false;
  let stableAt = 0;

  for (;;) {
    let state = null;
    try {
      state = await probePage(cdp);
    } catch (error) {
      const code = error?.code ?? null;
      if (HARD_FAIL.has(code)) {
        return {
          url: last.url, title: last.title, readyState: last.readyState,
          navigated: seenChange, settled: false, waitedMs: Date.now() - started,
          reason: `页面已经不在了（${code}）`, blockedBy: code,
        };
      }
      // 对话框开着：页面脚本被堵住，等下去也没用，立刻如实报给调用方（不要白等满 5 秒）
      if (code === "DIALOG_OPEN") {
        return {
          url: last.url, title: last.title, readyState: last.readyState,
          navigated: seenChange, settled: false, waitedMs: Date.now() - started,
          reason: "dialog", blockedBy: "DIALOG_OPEN",
        };
      }
      // 正在导航（执行上下文换了）：等下一拍
    }
    if (state) {
      last = state;
      if (previousUrl !== null && previousUrl !== undefined && state.url && state.url !== previousUrl) seenChange = true;
      const ready = state.readyState === "complete"
        || (state.lastAt > 0 && Date.now() - state.lastAt >= quietMs);
      if (ready) sawReady = true;
      // 「已经稳了」还要再确认一次没在跳：两个条件同时成立才算数。
      // 没换页又没要求换页时，先观察满 windowMs 再下结论（点「登录」后跳转常常晚一两百毫秒才开始）。
      const earlyOk = !expectChange && !seenChange ? Date.now() >= windowUntil : true;
      if (ready && (seenChange || !expectChange) && earlyOk) {
        if (!stableAt) stableAt = Date.now();
        else if (Date.now() - stableAt >= Math.min(pollMs, 100)) {
          return {
            url: state.url, title: state.title, readyState: state.readyState,
            navigated: seenChange, settled: true, waitedMs: Date.now() - started,
            reason: seenChange ? "navigated" : "stable",
            blockedBy: null,
          };
        }
      } else {
        stableAt = 0;
      }
    }
    const now = Date.now();
    if (now >= deadline) {
      // 三种「没等到」要分开说：换页了但没稳 / 要求换页却没换 / 一直没就绪。
      // 对话框在循环上面已经提前 return 了，这里不用再判 blockedBy === "DIALOG_OPEN"（永远不成立）。
      const reason = expectChange && !seenChange ? "no-navigation"
        : sawReady ? "unstable"
        : "timeout";
      return {
        url: last.url, title: last.title, readyState: last.readyState,
        navigated: seenChange, settled: false, waitedMs: now - started,
        reason,
        blockedBy: null,
      };
    }
    // 没在换页、也没要求换页：过了观察窗口就收工，不为「点了个按钮」白等满超时。
    // 判据用「稳了」（complete 或 DOM 安静够久），不是只看 complete —— 长轮询页面的 readyState
    // 可能一直停在 interactive，那种页面照样可以拍快照。
    if (!expectChange && !seenChange && sawReady && now >= graceUntil && now >= windowUntil) {
      return {
        url: last.url, title: last.title, readyState: last.readyState,
        navigated: false, settled: true, waitedMs: now - started,
        reason: "stable", blockedBy: null,
      };
    }
    await sleep(pollMs);
  }
}
