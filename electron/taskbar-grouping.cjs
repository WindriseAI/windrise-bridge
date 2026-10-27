/**
 * 格子窗口任务栏分组的调度（Windows）：
 *   - 开格子后 5 秒内扫一次这个进程的新窗口；
 *   - 之后每 30 秒把所有开着的格子进程扫一遍（用户 Ctrl+N 新开的窗口也会被扫到）；
 *   - 每个进程设过的 HWND 记下来，不重复设（新进程 = 新账本，句柄复用不会漏）；
 *   - 只处理调用方给的那几个 pid（都是我们自己起的 BrowserOS 进程），别的进程的窗口一律不碰；
 *   - PowerShell 设置失败静默：只记日志，绝不影响开格子。
 *
 * 不碰 Electron、不碰浏览器；找 HWND / 设 AppUserModelID 走 win-appid.cjs（自测换假货）。
 */

const winAppId = require("./win-appid.cjs");

/** 开格子后第一次扫描的延时（5 秒内） */
const DEFAULT_RESCAN_DELAY_MS = 5_000;
/** 之后对每个开着的格子扫新窗口的周期 */
const DEFAULT_RESCAN_INTERVAL_MS = 30_000;

function createTaskbarGrouping(options = {}) {
  const {
    appId = "",
    relaunchCommand = "",
    relaunchDisplayName = "",
    relaunchIcon = "",
    log = () => {},
    findHwnds = (pids) => winAppId.findGridHwnds(pids),
    setAppIds = (hwnds, props) => winAppId.setWindowAppIds(hwnds, props),
    rescanDelayMs = DEFAULT_RESCAN_DELAY_MS,
    rescanIntervalMs = DEFAULT_RESCAN_INTERVAL_MS,
  } = options;

  /** Map<pid, Set<hwnd>>：每个 BrowserOS 进程设过句柄的账本；进程退了账本自然作废 */
  const handled = new Map();
  let scanning = false;
  const pendingTimers = new Set();

  /**
   * 扫给定 pid 的顶层窗口，给没设过的新 HWND 设 AppUserModelID。
   * 失败静默：任何一步出错都只记日志，绝不抛给调用方。
   * @param {Array<number|string>} pids
   */
  async function scanPids(pids) {
    const wanted = (Array.isArray(pids) ? pids : [])
      .map((pid) => String(pid ?? "").trim())
      .filter((pid) => winAppId.PID_PATTERN.test(pid));
    if (!wanted.length || process.platform !== "win32") return { scanned: 0, fresh: [] };
    if (scanning) return { skipped: true, scanned: 0, fresh: [] };
    scanning = true;
    try {
      const found = await findHwnds(wanted);
      const list = Array.isArray(found?.hwnds) ? found.hwnds : [];
      const byPid = new Map();
      for (const item of list) {
        const pid = String(item?.pid ?? "");
        const hwnd = String(item?.hwnd ?? "");
        if (!winAppId.PID_PATTERN.test(pid) || !winAppId.HWND_PATTERN.test(hwnd)) continue;
        if (!wanted.includes(pid)) continue;   // 只处理我们自己起的 BrowserOS 进程
        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid).push(hwnd);
      }
      const fresh = [];
      for (const [pid, hwnds] of byPid) {
        const seen = handled.get(pid) ?? new Set();
        for (const hwnd of hwnds) {
          if (seen.has(hwnd)) continue;
          seen.add(hwnd);
          fresh.push(hwnd);
        }
        handled.set(pid, seen);
      }
      if (fresh.length) {
        try {
          const result = await setAppIds(fresh, { appId, relaunchCommand, relaunchDisplayName, relaunchIcon });
          if (result?.error) log(`给格子窗口设任务栏分组失败（忽略）：${result.error}`);
          else if (result?.set) log(`已把 ${result.set} 个格子窗口归进 Windrise 任务栏分组`);
        } catch (error) {
          log(`给格子窗口设任务栏分组失败（忽略）：${error.message}`);
        }
      }
      return { scanned: wanted.length, fresh };
    } catch (error) {
      log(`扫格子窗口句柄失败（忽略）：${error.message}`);
      return { scanned: 0, fresh: [] };
    } finally {
      scanning = false;
    }
  }

  /** 这个格子的进程刚开：5 秒后先扫一次（之后靠 30 秒的循环兜住用户新开的窗口） */
  function watchWindow(pid) {
    if (process.platform !== "win32") return;
    const text = String(pid ?? "").trim();
    if (!winAppId.PID_PATTERN.test(text)) return;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      scanPids([text]).catch(() => {});
    }, rescanDelayMs);
    timer.unref?.();
    pendingTimers.add(timer);
  }

  /** 起 30 秒循环：getPids 返回当前开着的格子进程号；返回停止函数 */
  function startLoop(getPids) {
    if (process.platform !== "win32") return () => {};
    const interval = setInterval(() => {
      let pids = [];
      try { pids = typeof getPids === "function" ? (getPids() ?? []) : []; } catch { pids = []; }
      scanPids(pids).catch(() => {});
    }, rescanIntervalMs);
    interval.unref?.();
    return () => clearInterval(interval);
  }

  /** 清掉还没到点的 5 秒定时器（退出前收尾） */
  function stop() {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
  }

  return { scanPids, watchWindow, startLoop, stop, handled };
}

module.exports = { createTaskbarGrouping, DEFAULT_RESCAN_DELAY_MS, DEFAULT_RESCAN_INTERVAL_MS };
