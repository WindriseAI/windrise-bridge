/**
 * 开机自启（Windows / macOS）。
 *
 * 用 Electron 自带的 app.setLoginItemSettings：
 *   - Windows：写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run（不需要管理员，不依赖 reg.exe ——
 *     有的公司电脑把 reg.exe 禁用了，老版本在那种机器上开不了自启）
 *   - macOS：加到「登录项」
 * 便携版每次运行都解压到临时目录，所以要写便携 exe 本身的路径（PORTABLE_EXECUTABLE_FILE），不能写 execPath。
 *
 * 开机自启的启动命令带一个 `--autostart` 标记：托盘化之后「用户自己打开」和「开机自动拉起」
 * 的启动流程不一样（前者自动开格子 1，后者默认不弹浏览器），主进程靠这个标记区分。
 */

const { app } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");

const NAME = "WindriseBridge";
/** 老版本用 reg.exe 写的值名，开关时顺手清掉，免得开两份 */
const LEGACY_VALUE = "BridgeReplica";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const supported = process.platform === "win32" || process.platform === "darwin";
/** 开机自启的启动命令里带的标记：主进程靠它区分「开机自启」和「用户自己打开」 */
const AUTOSTART_FLAG = "--autostart";

function target({ autostart = true } = {}) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  // 开发模式：electron 需要知道要跑哪个目录
  const base = process.defaultApp ? [path.resolve(__dirname, "..")] : [];
  const args = autostart ? [...base, AUTOSTART_FLAG] : base;
  return { exe, args };
}

/** 开机自启用的启动命令（带 --autostart 标记） */
function launchCommand() {
  const { exe, args } = target({ autostart: true });
  return [exe, ...args].map((p) => `"${p}"`).join(" ");
}

/** 普通启动命令（不带 --autostart）：任务栏固定项的 RelaunchCommand 用它，点图标 = 正常打开 Windrise */
function plainLaunchCommand() {
  const { exe, args } = target({ autostart: false });
  return [exe, ...args].map((p) => `"${p}"`).join(" ");
}

function query() {
  const { exe, args } = target({ autostart: true });
  return app.getLoginItemSettings(process.platform === "win32" ? { path: exe, args, name: NAME } : {});
}

/**
 * 读「现在是否开机自启」。
 * Windows 上不能只看 openAtLogin：实测（Electron 当前版本）Run 键已经写进去、launchItems 里也是 enabled，
 * openAtLogin 仍然返回 false，导致「开启」永远被判失败。改为按本程序的值名在 launchItems 里找，
 * enabled 同时反映了用户在任务管理器里手动禁用的情况；executableWillLaunchAtLogin 作兜底。
 */
function enabledNow() {
  const s = query();
  if (process.platform !== "win32") return Boolean(s.openAtLogin);
  const item = (s.launchItems ?? []).find((i) => i?.name === NAME);
  if (item) return Boolean(item.enabled);
  return Boolean(s.openAtLogin || s.executableWillLaunchAtLogin);
}

/** 系统里实际写的启动命令（自愈对比用）：Windows 读 Run 键里记的 path + args，读不到才回落规范命令 */
async function current() {
  if (!supported) return null;
  try {
    if (!enabledNow()) return null;
    if (process.platform === "win32") {
      const item = (query().launchItems ?? []).find((i) => i?.name === NAME);
      if (item?.path) {
        const parts = [item.path, ...(Array.isArray(item.args) ? item.args : [])];
        return parts.map((p) => `"${p}"`).join(" ");
      }
    }
    return launchCommand();
  } catch { return null; }
}

async function isEnabled() {
  if (!supported) return false;
  try { return enabledNow(); } catch { return false; }
}

function dropLegacy() {
  if (process.platform !== "win32") return;
  execFile("reg", ["delete", RUN_KEY, "/v", LEGACY_VALUE, "/f"], { windowsHide: true, timeout: 8000 }, () => {});
}

async function setEnabled(enabled) {
  if (!supported) return { ok: false, error: "这个系统暂不支持开机自启" };
  try {
    const { exe, args } = target({ autostart: true });
    app.setLoginItemSettings(process.platform === "win32"
      ? { openAtLogin: Boolean(enabled), path: exe, args, name: NAME }
      : { openAtLogin: Boolean(enabled), openAsHidden: true });
    dropLegacy();
    const now = await isEnabled();
    if (now !== Boolean(enabled)) return { ok: false, error: enabled ? "系统没让开机自启生效（可能被安全软件拦了）" : "关闭没生效" };
    return { ok: true, enabled: now, command: launchCommand() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 这次运行是不是开机自启拉起来的：
 *   - Windows：启动命令里带 --autostart 标记（Run 键写命令时带上）；
 *   - macOS：登录项带 openAsHidden，用 wasOpenedAtLogin 判断。
 */
function wasAutostart() {
  if (process.argv.includes(AUTOSTART_FLAG)) return true;
  try {
    if (process.platform === "darwin") return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch { /* 拿不到就不算 */ }
  return false;
}

module.exports = { isEnabled, setEnabled, current, launchCommand, plainLaunchCommand, wasAutostart, VALUE_NAME: NAME, RUN_KEY, AUTOSTART_FLAG };
