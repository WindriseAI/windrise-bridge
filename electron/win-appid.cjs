/**
 * 格子窗口的任务栏分组（Windows AppUserModelID，不编译的品牌统一）。
 *
 * 每个 BrowserOS 格子窗口是独立进程起的 Chromium 窗口，默认在任务栏上各自一组。
 * 这里用 Win32 的 SHGetPropertyStoreForWindow + IPropertyStore 给窗口设：
 *   - PKEY_AppUserModel_ID（设成 Windrise 自己的 AppUserModelID，所有格子合成一组）
 *   - PKEY_AppUserModel_RelaunchCommand / RelaunchDisplayNameResource / RelaunchIconResource
 *     （用户把任务栏项固定后，点固定项 = 启动 Windrise 而不是 BrowserOS 自己的 exe）
 *
 * 做法和 electron/browseros-profiles.cjs 的 measureFrameInsets 一样：
 * PowerShell 内联 C#（Add-Type）一次性处理一批 HWND，失败静默（调用方记日志）。
 *
 * 安全规矩（自测强制检查）：
 *   1. Add-Type 的 C# 源码是**常量**，绝不拼接任何外部输入 —— HWND 清单、AppUserModelID、
 *      图标路径、Relaunch 命令全部经环境变量传给脚本，脚本在运行时才读它们；
 *   2. HWND 只收纯数字（^[0-9]{1,20}$），pid 只收纯数字（^[0-9]{1,10}$），别的形状一律丢弃；
 *   3. 这份模块只发 PowerShell 子进程，不碰文件、不联网。
 */

const { execFile } = require("node:child_process");

/**
 * 按 pid 枚举顶层窗口：可见、有标题、类名 Chrome_WidgetWin_1 的才算格子窗口。
 * 输出一行一个 `pid:hwnd`；pid 清单经环境变量 WINDRISE_GRID_PIDS 传进来（逗号分隔）。
 */
const FIND_GRID_HWNDS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WEnumG {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder c, int n);
}
"@
$global:outG = New-Object 'System.Collections.Generic.List[string]'
$global:wantedG = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($t in ($env:WINDRISE_GRID_PIDS -split ',')) {
  $v = $t.Trim()
  if ($v -match '^[0-9]{1,10}$') { $null = $global:wantedG.Add([uint32]$v) }
}
$cb = [WEnumG+P]{ param($h,$l)
  $p = [uint32]0
  $null = [WEnumG]::GetWindowThreadProcessId($h,[ref]$p)
  if ($global:wantedG.Contains($p) -and [WEnumG]::IsWindowVisible($h) -and [WEnumG]::GetWindowTextLength($h) -gt 0) {
    $c = New-Object System.Text.StringBuilder 256
    $null = [WEnumG]::GetClassName($h,$c,256)
    if ($c.ToString() -eq 'Chrome_WidgetWin_1') { $global:outG.Add(("{0}:{1}" -f $p, $h.ToInt64())) }
  }
  return $true
}
$null = [WEnumG]::EnumWindows($cb,[IntPtr]::Zero)
# 回调里 Write-Output 出不到管道：先攒起来，枚举完再统一输出
foreach ($line in $global:outG) { Write-Output $line }
`;

/**
 * 给一批 HWND 设 AppUserModelID 和三个 Relaunch 属性。
 * 输入全部经环境变量：WINDRISE_APPID_HWNDS（逗号分隔的纯数字）、WINDRISE_APPID_ID、
 * WINDRISE_APPID_RELAUNCH、WINDRISE_APPID_DISPLAYNAME、WINDRISE_APPID_ICON。
 * 最后一行输出 SET <成功数>；哪个窗口失败只跳过，不报错。
 */
const SET_APPID_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PKG { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit, Size = 16)]
public struct PVG { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStoreG {
  [PreserveSig] int GetCount(out uint c);
  [PreserveSig] int GetAt(uint i, out PKG k);
  [PreserveSig] int GetValue(ref PKG k, out PVG v);
  [PreserveSig] int SetValue(ref PKG k, ref PVG v);
  [PreserveSig] int Commit();
}
public static class WAppIdG {
  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStoreG store);
  static readonly Guid Fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  static bool Put(IPropertyStoreG s, uint id, string value) {
    // 空值不写（例如没给图标）：只算成功
    if (string.IsNullOrEmpty(value)) return true;
    PKG k = new PKG(); k.fmtid = Fmt; k.pid = id;
    PVG v = new PVG(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(value);
    try { return s.SetValue(ref k, ref v) == 0; } finally { Marshal.FreeCoTaskMem(v.p); }
  }
  // PKEY_AppUserModel_*：RelaunchCommand=2、RelaunchIconResource=3、RelaunchDisplayNameResource=4、ID=5
  public static bool Apply(long hwnd, string appId, string relaunch, string displayName, string icon) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStoreG s;
    if (SHGetPropertyStoreForWindow(new IntPtr(hwnd), ref iid, out s) != 0 || s == null) return false;
    try {
      bool ok = Put(s, 5, appId);
      // Relaunch 三项要么都设、要么都不设（Windows 规定有 RelaunchCommand 就要有显示名）
      if (!string.IsNullOrEmpty(relaunch)) {
        ok = Put(s, 2, relaunch) && ok;
        ok = Put(s, 4, displayName) && ok;
        ok = Put(s, 3, icon) && ok;
      }
      if (ok) s.Commit();
      return ok;
    } finally { Marshal.ReleaseComObject(s); }
  }
}
"@
$setG = 0
foreach ($t in ($env:WINDRISE_APPID_HWNDS -split ',')) {
  $v = $t.Trim()
  if ($v -notmatch '^[0-9]{1,20}$') { continue }
  try {
    if ([WAppIdG]::Apply([int64]$v, $env:WINDRISE_APPID_ID, $env:WINDRISE_APPID_RELAUNCH, $env:WINDRISE_APPID_DISPLAYNAME, $env:WINDRISE_APPID_ICON)) { $setG += 1 }
  } catch {
    # 这个窗口设不上（权限 / 窗口刚好销毁）：跳过，别的照常
  }
}
Write-Output ("SET {0}" -f $setG)
`;

/** 数字形状校验：HWND 20 位以内、pid 10 位以内的纯数字 */
const HWND_PATTERN = /^[0-9]{1,20}$/;
const PID_PATTERN = /^[0-9]{1,10}$/;

/** 跑一段 PowerShell（UTF-16LE 编码后 base64 走 -EncodedCommand，和 frame insets 同一个写法） */
function runEncodedPs(script, env = {}, { exec = null } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ ok: false, stdout: "", error: "not-win32" });
      return;
    }
    const runner = exec || ((...args) => execFile(...args));
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const call = () => runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, ...env },
    }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || ""), error: error ? error.message : null });
    });
    try { call(); } catch (error) { resolve({ ok: false, stdout: "", error: error.message }); }
  });
}

/** 解析「pid:hwnd」行；形状不对的丢弃 */
function parseHwndLines(stdout) {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^(\d{1,10}):(\d{1,20})$/.exec(line.trim());
    if (!match) continue;
    out.push({ pid: match[1], hwnd: match[2] });
  }
  return out;
}

/**
 * 按 pid 找这些 BrowserOS 进程的可见顶层窗口（类名 Chrome_WidgetWin_1）。
 * @param {Array<number|string>} pids
 * @param {{ exec?: function }} [options] 自测注入假执行器
 * @returns {Promise<{ ok: boolean, hwnds: Array<{pid: string, hwnd: string}>, error: string|null }>}
 */
async function findGridHwnds(pids, options = {}) {
  const wanted = (Array.isArray(pids) ? pids : []).map((pid) => String(pid ?? "").trim()).filter((pid) => PID_PATTERN.test(pid));
  if (!wanted.length) return { ok: false, hwnds: [], error: "没有合法的 pid" };
  const result = await runEncodedPs(FIND_GRID_HWNDS_PS, { WINDRISE_GRID_PIDS: wanted.join(",") }, options);
  if (!result.ok) return { ok: false, hwnds: [], error: result.error || "PowerShell 没跑成" };
  return { ok: true, hwnds: parseHwndLines(result.stdout), error: null };
}

/**
 * 给一批 HWND 设 AppUserModelID + Relaunch 属性。
 * @param {Array<number|string>} hwnds 纯数字句柄
 * @param {{ appId: string, relaunchCommand: string, relaunchDisplayName: string, relaunchIcon: string }} props
 * @param {{ exec?: function }} [options] 自测注入假执行器
 * @returns {Promise<{ set: number, error: string|null }>}
 */
async function setWindowAppIds(hwnds, props = {}, options = {}) {
  const wanted = (Array.isArray(hwnds) ? hwnds : []).map((hwnd) => String(hwnd ?? "").trim()).filter((hwnd) => HWND_PATTERN.test(hwnd));
  if (!wanted.length) return { set: 0, error: "没有合法的 HWND" };
  const env = {
    WINDRISE_APPID_HWNDS: wanted.join(","),
    WINDRISE_APPID_ID: String(props.appId ?? ""),
    WINDRISE_APPID_RELAUNCH: String(props.relaunchCommand ?? ""),
    WINDRISE_APPID_DISPLAYNAME: String(props.relaunchDisplayName ?? ""),
    WINDRISE_APPID_ICON: String(props.relaunchIcon ?? ""),
  };
  const result = await runEncodedPs(SET_APPID_PS, env, options);
  if (!result.ok) return { set: 0, error: result.error || "PowerShell 没跑成" };
  const match = /SET (\d+)/.exec(result.stdout);
  return { set: match ? Number(match[1]) : 0, error: null };
}

/** C# 源码（Add-Type 块里的部分）：自测拿它核对「没有拼接任何外部输入」 */
function csharpSourceOf(script) {
  const start = String(script).indexOf('@"');
  const end = String(script).indexOf('"@', start + 2);
  if (start < 0 || end < 0) return "";
  return String(script).slice(start + 2, end);
}

module.exports = {
  FIND_GRID_HWNDS_PS,
  SET_APPID_PS,
  HWND_PATTERN,
  PID_PATTERN,
  runEncodedPs,
  parseHwndLines,
  findGridHwnds,
  setWindowAppIds,
  csharpSourceOf,
};
