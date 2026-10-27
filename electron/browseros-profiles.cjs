/**
 * 账号窗口登记表（BrowserOS 引擎版）：一个账号 = 一个浏览器进程 + 一个窗口 + 一个标签页外观。
 *
 * 它管什么：
 *   - 按账号 id 起一个独立的 BrowserOS 进程（各自一份资料目录，所以各存各的登录态）；
 *   - 起完之后先找到「自带插件」并核对 WebRTC 策略，管不着就把进程收掉，不留半条命；
 *   - 把浏览器里的一个标签页包成 browser-control 认识的 webContents 外观（browseros-tab.cjs），
 *     所以上层的 windowFor / surfaceFor / execute / pageSnapshot 一行不用改；
 *   - 空间（产品计划 2026-10-26「格子 + 空间」）：一个账号里可以有多个空间，
 *     每个空间 = 一个浏览器标签组（chrome.tabGroups，插件后台建的），共用这个账号的登录；
 *     默认空间「我的」就是开窗时的那个标签页，AI 空间由 space_open 开、page_* 带 space 参数路由过去；
 *     空间名单（只存 id/name/owner/createdAt，不含网址）持久化在该账号资料目录的 windrise-spaces.json，
 *     格子重开时只恢复名字，标签页不自动恢复；
 *   - 钉住（产品计划 2026-10-26「钉住」，像快速访问）：人和 AI 都能钉常用网页，按空间分开存；
 *     唯一数据源在插件后台的 chrome.storage.local（键 windrise.pins，跟着这个账号的资料目录走），
 *     主程序经插件会话调 __windrise.pinList / pinAdd / pinRemove；AI 钉的 by 固定写 "ai"，
 *     不信调用方；space_close 关掉 AI 空间时顺手清掉它的钉住清单；
 *   - 记账：谁开着、现在在哪个网址、进程什么时候自己死了（死了就自动注销并报一次 window-closed）。
 *
 * 它不管什么：
 *   - 进程怎么起怎么关（browseros-engine.cjs）；
 *   - 标签页命令怎么发、超时怎么算、标签页没了怎么判死（target-surface.cjs / cdp-connection.cjs）；
 *   - 账号资料（名字、代理、图标……）的增删改和落盘（browser-profiles.cjs）；
 *   - 分屏。这一版账号窗口只有「独立窗口」，分屏那套在 browser-profiles.cjs 里直接拒。
 *
 * 几条硬规矩（契约 §5.2，都是真机踩出来的）：
 *   1. **不 require electron**。这一层要能在纯 Node 里跑（端到端验收就是纯 Node 起控制服务）。
 *   2. 绝不抢前台：open / 布局 / 空间这些 AI 能触发的路径不调 Target.activateTarget / Page.bringToFront。
 *      新格子用 Browser.setWindowBounds 摆到工作区里（默认居中、宽 60% 高 70%），不再一律挪到屏幕外；
 *      只有人主动点「打开 / 聚焦」（托盘、second-instance、侧边栏）走 focus()，那里才允许 Target.activateTarget。
 *   3. 复用同 id 时不新开窗口（两次开同一份资料目录会互相踢下线）；只有调用方明确给了网址才导航，
 *      没给就只把现有窗口交回去（和 Electron 分支一个样，不把人填了一半的表单冲掉）。
 *   4. 有代理就**真对账**：带 --proxy-server 启动时 chrome.proxy.settings 会读到 fixed_servers + singleProxy，
 *      和命令行给的 host/port 一致才对；对不上关进程抛 PROXY_NOT_APPLIED。没配代理时读到 system 属正常。
 *   5. 自己关掉的窗口只报一次 window-closed；进程自己死了也报一次，日志里写清楚原因。
 *
 * 自带插件这块的三个真机事实（2026-10-24，B 验完写进契约 §5.2 第 3 条）：
 *   - BrowserOS 预装了 2~3 个扩展，目标列表里一开始就有别的 `chrome-extension://…/background.js` worker。
 *     所以不能「看见第一个就当是我们的」，得逐个 attach 然后 `globalThis.__windrise && __windrise.ping()`，
 *     谁 ping 得通、带 id 的才是我们那份（本机是 nfdbgpcmhfpeieafmfijjfnfajnlboek，但这里不写死）。
 *   - MV3 worker 起来 18~35 秒会被停掉，停了就从目标列表消失，旧 targetId attach 报「no such target」；
 *     这个构建没有 ServiceWorker.enable / startWorker。**调试器会话挂着不放时 40 秒都不会被停**，
 *     所以 attach 上就保持会话不摘；真判 EXTENSION_NOT_READY 之前先建个标签页把它叫醒、重找重 ping。
 *   - 命令行代理在这个构建里是看得见的（fixed_servers），所以代理能真对账，不用「只记录不阻断」那套保守做法。
 */

const fs = require("node:fs");
const path = require("node:path");

const { ROOT_SESSION } = require("./cdp-connection.cjs");
const { TargetSurface } = require("./target-surface.cjs");
const { checkSiteUrl } = require("./url-guard.cjs");
const { checkAiAccess } = require("./ai-site-guard.cjs");
const { buildPanelState } = require("./panel-state.cjs");
const {
  normalizeWorkArea,
  normalizeLayout,
  computeLayout,
  defaultWindowBounds,
  planLayoutChange,
} = require("./grid-layout.cjs");

/** 等浏览器起来（Browser.getVersion 应声）的默认时限 */
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
/** 等自带插件 worker 出现并设上策略的时限（MV3 的 worker 可能晚几百毫秒才起） */
const EXTENSION_WAIT_MS = 15_000;
/** 叫醒 worker 之后再给它多久回来（实测 371~454ms 就回来了，6 秒足够宽松） */
const WAKE_GRACE_MS = 6_000;
/** 缺省 WebRTC 策略：非代理的 UDP 一律不走 */
const DEFAULT_WEBRTC_POLICY = "disable_non_proxied_udp";
/** 「收起这一格」时摆到哪儿：屏幕外面，不抢键盘鼠标；进程和登录态都还在 */
const OFFSCREEN_BOUNDS = { left: -2400, top: -1800, width: 1000, height: 760, windowState: "normal" };
/**
 * 纯 Node 里没有 Electron 的 screen 时可用的假工作区。
 * 真机上 main.cjs 会注入 getWorkArea（来自 screen.getPrimaryDisplay / getDisplayMatching），
 * 所以这里只负责「没注入时也别崩」，不是真机兜底方案。
 */
const FALLBACK_WORK_AREA = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 });
/** 插件里接收格子动作的全局 binding：只加在插件 service worker 的会话上，页面世界没有 */
const GRID_BINDING_NAME = "windriseGridAction";
/**
 * 格子动作白名单：静态动作 + 「打开某个格子」+ 「切到某个空间」。
 * grid-open:<编号> 只接受 1~9999 的正整数；space-focus:<空间id> 只接受短随机串能用的安全字符；别的写法一律丢弃。
 */
const GRID_ACTIONS = Object.freeze(new Set([
  "layout:1x1",
  "layout:1x2",
  "layout:2x2",
  "layout:3x3",
  "hide-self",
  "show-settings",
  // 初次设置引导页（插件 onboarding.html）：与插件 sw.js 的 GRID_ACTIONS 保持一致，两边都不信对方
  "tunnel-connect",
  "owner-key-new",
  "pay-order:D",
  "pay-order:M",
  "pay-order:Y",
  "tool-tier:basic",
  "tool-tier:full",
  "onboarding-done",
  "onboarding-open",
]));
const GRID_OPEN_PATTERN = /^grid-open:[1-9]\d{0,3}$/;
const SPACE_FOCUS_PATTERN = /^space-focus:[A-Za-z0-9_-]{1,32}$/;
/** show-settings 可带的设置页目标（与 sw.js 的 SHOW_SETTINGS_TABS 同一张表） */
const SETTINGS_TABS = Object.freeze(new Set(["settings", "account", "bridge", "context", "choose-connection"]));
/** owner-key-new 的频率限制：一分钟最多一把（主程序在生成前检查） */
const OWNER_KEY_MIN_INTERVAL_MS = 60_000;
/**
 * 插件装到所有格子（产品计划 2026-10-26）：插件 id 只收 32 位小写 a~p（Chrome 插件 id 格式）。
 * 侧边栏发 ext-share / ext-unshare / ext-autosync；插件后台报 ext-installed（新装或升级）。
 */
const EXT_SHARE_PATTERN = /^ext-share:[a-p]{32}$/;
const EXT_UNSHARE_PATTERN = /^ext-unshare:[a-p]{32}$/;
const EXT_INSTALLED_PATTERN = /^ext-installed:[a-p]{32}$/;
const EXT_AUTOSYNC_PATTERN = /^ext-autosync:(on|off)$/;
/** 每 5 秒把面板状态推给打开的格子（失败静默） */
const PANEL_PUSH_INTERVAL_MS = 5_000;

/** 空间列表持久化文件（放在每个账号的资料目录根下，只存 id/name/owner/createdAt，不存网址） */
const SPACES_FILE = "windrise-spaces.json";
/** 默认空间：人在用的那一个，就是格子开窗时的主标签页；不建标签组 */
const DEFAULT_SPACE_ID = "home";
const DEFAULT_SPACE_NAME = "我的";
/** 空间 id 的短随机串字母表：去掉 0/O、1/I/L 这类容易看混的 */
const SPACE_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SPACE_ID_LENGTH = 8;
/** 空间名字最长多少字（存盘 / 标签组标题都用它裁） */
const SPACE_NAME_LIMIT = 40;
/** 空间标签组颜色轮换（和插件 sw.js 里同一张表） */
const SPACE_COLORS = ["blue", "green", "yellow", "purple", "cyan", "pink", "orange", "red"];

/**
 * 空间的控制权初始状态。只有运行态，不写进 windrise-spaces.json：
 * 格子重开后 AI 任务本来就不存在了，默认回到 ai_running 才是对的。
 * 状态机的合法转换在 src/core/handoff.js（ESM），这里只存字段。
 */
function newSpaceControl(createdAt = Date.now()) {
  return {
    state: "ai_running",
    since: Number(createdAt) || Date.now(),
    reason: "",
    message: "",
    by: null,
    // 交接前快照（{ url, title, text, login, at }），交还后第一次 page_* 用它做变更摘要
    before: null,
  };
}


/** 两边（插件后台 / 主程序）用同一套判断：静态白名单 + grid-open:<编号> + space-focus:<空间id> + 插件动作 */
function isGridActionAllowed(action) {
  return typeof action === "string" && (
    GRID_ACTIONS.has(action)
    || GRID_OPEN_PATTERN.test(action)
    || SPACE_FOCUS_PATTERN.test(action)
    || EXT_SHARE_PATTERN.test(action)
    || EXT_UNSHARE_PATTERN.test(action)
    || EXT_INSTALLED_PATTERN.test(action)
    || EXT_AUTOSYNC_PATTERN.test(action)
  );
}
/** 书签文件在资料目录里的相对位置 */
const BOOKMARKS_RELATIVE = ["Default", "Bookmarks"];

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 带错误码的错：上层按 code 分支，不用抠中文提示（错误码见契约 §7） */
function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** 运行中的主程序把这里的日志也接进软件日志文件（只打控制台的话，出问题时看不到；2026-10-25 排查格子按钮踩到） */
let logSink = null;
function log(message) {
  // 和现有文件一个口味：中文、短、带前缀。日志出问题不能影响正事
  try { console.log(`[browseros-profiles] ${message}`); } catch { /* 控制台没了也照跑 */ }
  try { logSink?.(String(message)); } catch { /* 日志不能影响正事 */ }
}

/* ---------------- 自带插件更新后，清掉旧的后台脚本缓存 ---------------- */

/**
 * 为什么要有这个（2026-10-25 真机踩到）：BrowserOS 用 --load-extension 加载我们的插件，但插件后台（service worker）
 * 的脚本会被浏览器存进资料目录的 Default/Service Worker 里。插件文件改了以后（哪怕 manifest 版本号也改了），
 * 老账号里跑的仍是**旧的后台脚本**：新加的函数不存在，页面按钮发的消息没人收（"Receiving end does not exist"）。
 * 新建的账号没有这份缓存，所以测试时一切正常，只有用了很久的账号出问题。
 *
 * 做法：算一份插件文件的指纹，记在资料目录里；启动前发现指纹变了，就删掉 Default/Service Worker 下的
 * Database 和 ScriptCache（只是 service worker 的注册表和脚本缓存；网站的 SW 下次访问会自己重新注册，
 * Cookie、登录、书签、CacheStorage 都不动）。真机验证：删完后插件后台是新代码，连开两次都对。
 */
const EXTENSION_STAMP_FILE = "windrise-extension-stamp.txt";

function extensionFingerprint(extensionDir) {
  const hash = require("node:crypto").createHash("sha256");
  const walk = (dir, rel = "") => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(full, `${rel}${name}/`); continue; }
      hash.update(`${rel}${name}\0`);
      try { hash.update(fs.readFileSync(full)); } catch { /* 读不了就只算名字 */ }
    }
  };
  walk(extensionDir);
  return hash.digest("hex");
}

/** 插件变了就清该账号的 service worker 注册；返回 {cleared, reason} */
async function refreshExtensionWorkerCache(userDataDir, extensionDir) {
  const fingerprint = extensionFingerprint(extensionDir);
  const stampFile = path.join(userDataDir, EXTENSION_STAMP_FILE);
  const previous = await fs.promises.readFile(stampFile, "utf8").then((x) => x.trim()).catch(() => "");
  if (previous === fingerprint) return { cleared: false, reason: "插件没变" };
  const swDir = path.join(userDataDir, "Default", "Service Worker");
  const cleared = [];
  for (const name of ["Database", "ScriptCache"]) {
    const target = path.join(swDir, name);
    // 只删资料目录里的真目录：路径上任何一层是联接点 / 符号链接就不碰
    let unsafe = false;
    for (const p of [userDataDir, path.join(userDataDir, "Default"), swDir, target]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) unsafe = true; } catch { /* 不存在就算了 */ }
    }
    if (unsafe) return { cleared: false, reason: `路径是联接点 / 符号链接，不删：${target}` };
    if (!fs.existsSync(target)) continue;
    await fs.promises.rm(target, { recursive: true, force: true });
    cleared.push(name);
  }
  await fs.promises.mkdir(userDataDir, { recursive: true }).catch(() => {});
  await fs.promises.writeFile(stampFile, `${fingerprint}\n`, "utf8");
  return { cleared: cleared.length > 0, reason: previous ? "插件文件变了" : "第一次记录插件指纹", removed: cleared };
}

/* ---------------- 窗口看不见的边框（铺格子要扣掉） ---------------- */

/**
 * Windows 10/11 的窗口左、右、下各有一圈看不见的拖拽边框（100% 缩放实测 7 像素，上边 0）。
 * Browser.setWindowBounds 摆的是包含这圈边框的外框，所以按格子大小直接摆，看得见的部分之间会留 14 像素缝、
 * 贴屏幕边的地方留 7 像素（2026-10-26 用户反馈「不能丝滑完整地铺满」，用 DwmGetWindowAttribute 实测确认）。
 * 做法：第一次摆窗口后量一次「外框 - 可见框」的差，缓存起来；之后每格都把外框往外扩这么多。
 * 不同缩放比例边框宽度不一样，所以量真窗口，不写死。量不到（不是 Windows / PowerShell 出错）就当 0。
 */
const FRAME_PROBE_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public struct WRECT { public int L, T, R, B; }
public class WFrame { public delegate bool P(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out WRECT r);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out WRECT r, int s); }
"@
$target = [uint32]$env:WINDRISE_FRAME_PID
$global:hit = $null
$cb = [WFrame+P]{ param($h,$l) $p=0; [WFrame]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null
  if ($p -eq $target -and [WFrame]::IsWindowVisible($h) -and -not [WFrame]::IsZoomed($h) -and [WFrame]::GetWindowTextLength($h) -gt 0 -and -not $global:hit) { $global:hit = $h }; $true }
[WFrame]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null
if (-not $global:hit) { "none"; exit 0 }
$r=New-Object WRECT; [WFrame]::GetWindowRect($global:hit,[ref]$r)|Out-Null
$e=New-Object WRECT; $hr=[WFrame]::DwmGetWindowAttribute($global:hit,9,[ref]$e,16)
if ($hr -ne 0) { "none"; exit 0 }
"{0},{1},{2},{3}" -f ($e.L-$r.L),($e.T-$r.T),($r.R-$e.R),($r.B-$e.B)
`;

let frameInsetsCache = null;

/** 换布局补出来的新格子默认打开的网址（2026-10-26 用户定：Google） */
const NEW_GRID_START_URL = "https://www.google.com/";

function measureFrameInsets(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || !pid) { resolve(null); return; }
    const encoded = Buffer.from(FRAME_PROBE_PS, "utf16le").toString("base64");
    require("node:child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 15_000, env: { ...process.env, WINDRISE_FRAME_PID: String(pid) },
    }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const m = /^(\d+),(\d+),(\d+),(\d+)/m.exec(String(stdout || "").trim());
      if (!m) { resolve(null); return; }
      const insets = { left: Number(m[1]), top: Number(m[2]), right: Number(m[3]), bottom: Number(m[4]) };
      // 只信合理范围：0~40 像素
      if (Object.values(insets).some((v) => !Number.isFinite(v) || v < 0 || v > 40)) { resolve(null); return; }
      resolve(insets);
    });
  });
}

/** 把格子矩形（想让人看见的范围）换成要交给浏览器的外框 */
function expandByInsets(rect, insets) {
  if (!insets) return rect;
  return {
    ...rect,
    x: rect.x - insets.left,
    y: rect.y - insets.top,
    width: rect.width + insets.left + insets.right,
    height: rect.height + insets.top + insets.bottom,
  };
}

/* ---------------- 格子：坐标、书签复制 ---------------- */

/** 这个路径是不是真的在 root 下面（不认 ..、不认另一个盘符） */
function isPathInside(root, target) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(target)));
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function isLink(target) {
  try {
    return (await fs.promises.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 新格子的书签从基准格子复制过来（只复制 Default/Bookmarks，绝不带 Cookie / 登录数据）。
 *
 * 安全边界（需求点名要的）：
 *   - 两边资料目录必须都在 <dataHome>/browseros/profiles 下面；
 *   - 路径上任何一层（资料根、两个资料目录、两边 Default、书签文件本身）是符号链接/联接点就不复制；
 *   - 基准格子没有书签文件就跳过，不算失败。
 *
 * 返回 {copied:boolean, reason?:string, from?:string, to?:string}；调用方按日志处理，不阻断开窗。
 */
async function copyBookmarksBetweenProfiles({ dataHome, profilesRoot = null, fromId, toId, log: logLine = log } = {}) {
  if (fromId === undefined || fromId === null || String(fromId) === "" || toId === undefined || toId === null || String(toId) === "") {
    return { copied: false, reason: "缺基准格子或新格子的编号" };
  }
  const root = profilesRoot
    ? path.resolve(String(profilesRoot))
    : path.resolve(String(dataHome || ""), "browseros", "profiles");
  const fromDir = path.resolve(root, String(fromId));
  const toDir = path.resolve(root, String(toId));
  if (!isPathInside(root, fromDir) || !isPathInside(root, toDir)) {
    return { copied: false, reason: `资料目录不在 BrowserOS 资料根目录下（${root}）` };
  }
  if (fromDir === toDir) return { copied: false, reason: "基准格子和新格子是同一个资料目录" };

  const fromDefault = path.join(fromDir, BOOKMARKS_RELATIVE[0]);
  const toDefault = path.join(toDir, BOOKMARKS_RELATIVE[0]);
  const fromFile = path.join(fromDefault, BOOKMARKS_RELATIVE[1]);
  const toFile = path.join(toDefault, BOOKMARKS_RELATIVE[1]);

  for (const target of [root, fromDir, toDir, fromDefault, toDefault, fromFile, toFile]) {
    if (await isLink(target)) {
      return { copied: false, reason: `路径是符号链接/联接点，不复制：${target}` };
    }
  }

  const source = await fs.promises.lstat(fromFile).catch(() => null);
  if (!source || !source.isFile()) return { copied: false, reason: "基准格子没有书签文件" };

  await fs.promises.mkdir(toDefault, { recursive: true });
  // mkdir 之后再看一次：目标目录可能本来就是别人放好的联接点
  if (await isLink(toDefault) || await isLink(toFile)) {
    return { copied: false, reason: `目标路径是符号链接/联接点，不复制：${toFile}` };
  }
  await fs.promises.copyFile(fromFile, toFile);
  try { logLine(`已把基准格子 ${fromId} 的书签复制给格子 ${toId}`); } catch { /* 日志不重要 */ }
  return { copied: true, from: fromFile, to: toFile };
}

/** 统一的窗口矩形：x/y 和 left/top 都认，宽度高度必须是正数；一律取整 */
function normalizeRect(bounds) {
  if (!bounds || typeof bounds !== "object") {
    throw codedError("INVALID_ARGUMENT", "setBounds 需要 {x, y, width, height}（也认 left / top）");
  }
  const x = Number(bounds.x ?? bounds.left);
  const y = Number(bounds.y ?? bounds.top);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw codedError("INVALID_ARGUMENT", `窗口位置不合法：${JSON.stringify(bounds)}`);
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** 内部矩形 → Browser.setWindowBounds 的 bounds */
function cdpBoundsOf(rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/**
 * 「离开这个页面」这类命令：页面在登录页上也得能用，否则 AI 会被关在里面出不来。
 *
 * 为什么要单独列：TargetSurface 的护栏（urlGuard）对**每一条**命令都先问一次「这个网址 AI 能不能碰」，
 * 读正文、点击、截图被拦住是对的；但 `Page.navigate` / `Page.navigateToHistoryEntry` / `Page.reload` /
 * `Page.getNavigationHistory` 是「走开」用的，拦掉它们就变成「进了登录页再也出不去」。
 * 现在所有动作都走页面会话，才需要在这里把「离开页面」的命令单独放行。
 *
 * 2026-10-24 真机实测：不补这一条会怎样 —— 在伪造的 accounts.google.com 上，
 * control 的 navigate 返回 SIGNIN_PAGE_HUMAN_ONLY、back 也返回 SIGNIN_PAGE_HUMAN_ONLY，
 * 而护栏自己的提示文案写的是「或者后退离开这个页面」，等于让人往墙上撞。
 */
const LEAVING_COMMANDS = /^(Page\.navigate|Page\.navigateToHistoryEntry|Page\.reload|Page\.stopLoading|Page\.getNavigationHistory)$/;

/**
 * 账号窗口的标签页会话：就是 TargetSurface，只多一条「离开页面」的例外。
 * 别的命令一概照原样过护栏 —— 登录页上的读、点、填、截图还是会被 SIGNIN_PAGE_HUMAN_ONLY 拦住。
 *
 * 例外是按「这一条命令是什么」判的，不去动会话上的 urlGuard 字段。
 * 早先的写法是离开类命令在途时把 this.urlGuard 整个摘掉、结束再挂回（2026-10-24 审核查出两个问题）：
 *   1. 摘掉期间，同一标签页上同时在途的读、截图、执行，命令前和结果后两道检查都跳过，
 *      页面刚跳进登录页时正文能被读走；
 *   2. 两条离开类命令交错结束（外观导航后会自己发 Page.getNavigationHistory 刷历史，AI 的 navigate 就可能和它交错），
 *      后结束的那条把「空」挂回去，护栏就永久没了。
 */
class AccountSurface extends TargetSurface {
  constructor(conn, options = {}) {
    const guard = options.urlGuard;
    super(conn, {
      ...options,
      urlGuard: guard
        ? (url, method, info) => (LEAVING_COMMANDS.test(String(method)) ? null : guard(url, method, info))
        : null,
    });
  }
}

class BrowserOsProfiles {
  /**
   * @param {{
   *   dataHome: string,
   *   onEvent?: (event: any) => void,
   *   extensionDir?: string,
   *   engineDir?: string,
   *   engine?: any,
   *   tabModule?: any,
   *   launchTimeoutMs?: number,
   *   extensionWaitMs?: number,
   *   getWorkArea?: (nearBounds?: {x:number,y:number,width:number,height:number}|null) => {x:number,y:number,width:number,height:number},
   *   createProfile?: (input: {name: string, startUrl: string}) => Promise<any>,
   *   listProfiles?: () => any[],
   * }} options
   *   dataHome：Windrise 的数据目录（账号资料目录落在 <dataHome>\browseros\profiles\<id>）
   *   engine / tabModule：给自测注入假货用；正常不传，按需 require 真的
   *   getWorkArea：工作区来源。这一层不许 require electron，所以由 browser-profiles / main.cjs 注入；
   *     纯 Node 自测里注入假函数，真机上来自 Electron 的 screen 模块。
   *   createProfile / listProfiles：换布局要补新账号时，用 browser-profiles 的建账号逻辑和完整账号名单。
   *   getPanelState：侧边栏 / 新标签页要的只读状态（main.cjs 实现）。不传就不推面板状态。
   *   showSettings：插件里点「管理口令」时，让主程序把设置页叫出来。
   *   openGrid：插件里点格子列表时，按格子编号打开 / 摆回那一格。
   */
  constructor({
    dataHome,
    onEvent = () => {},
    extensionDir,
    engineDir,
    engine = null,
    tabModule = null,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    extensionWaitMs = EXTENSION_WAIT_MS,
    getWorkArea = null,
    createProfile = null,
    listProfiles = null,
    getPanelState = null,
    showSettings = null,
    openGrid = null,
    getExtAutoSync = null,
    setExtAutoSync = null,
    extensionsLib = null,
    extensionSyncLib = null,
    tunnelConnect = null,
    generateOwnerKey = null,
    payOrder = null,
    setToolTier = null,
    setOnboardingDone = null,
  } = {}) {
    if (!dataHome) throw codedError("ENGINE_NOT_FOUND", "BrowserOsProfiles 需要 dataHome（Windrise 的数据目录），不然不知道账号资料放哪");
    this.dataHome = path.resolve(String(dataHome));
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    logSink = (message) => this.onEvent({ kind: "note", name: message });
    // 自带插件的目录：默认就是仓库里那份；engineDir 是契约里留的另一个名字，两个都认
    this.extensionDir = path.resolve(String(extensionDir || engineDir || path.join(__dirname, "browseros-extension")));
    this.engineOverride = engine;
    this.tabOverride = tabModule;
    this.launchTimeoutMs = Number(launchTimeoutMs) > 0 ? Number(launchTimeoutMs) : DEFAULT_LAUNCH_TIMEOUT_MS;
    this.extensionWaitMs = Number(extensionWaitMs) > 0 ? Number(extensionWaitMs) : EXTENSION_WAIT_MS;
    this.getWorkArea = typeof getWorkArea === "function" ? getWorkArea : () => ({ ...FALLBACK_WORK_AREA });
    this.createProfile = typeof createProfile === "function" ? createProfile : null;
    this.listProfiles = typeof listProfiles === "function" ? listProfiles : () => [];
    /** 面板状态：由 main.cjs 注入；没注入就完全不推，不影响开窗口 */
    this.getPanelState = typeof getPanelState === "function" ? getPanelState : null;
    this.showSettings = typeof showSettings === "function" ? showSettings : null;
    this.openGrid = typeof openGrid === "function" ? openGrid : null;
    /** 「新装的插件自动装到所有格子」开关：main.cjs 注入读/写 settings；没注入按默认开 */
    this.getExtAutoSync = typeof getExtAutoSync === "function" ? getExtAutoSync : null;
    this.setExtAutoSync = typeof setExtAutoSync === "function" ? setExtAutoSync : null;
    /** 共享插件库模块：给自测注入假货用；正常不传，按需 require 真的 */
    this.extensionsOverride = extensionsLib;
    /** 外部扩展清单同步模块（extension_sync）：同样给自测留注入口 */
    this.extensionSyncOverride = extensionSyncLib;
    /** 引导页动作的注入（main.cjs 实现）：打通隧道 / 生成口令 / 切工具档位 / 记引导完成 */
    this.tunnelConnect = typeof tunnelConnect === "function" ? tunnelConnect : null;
    this.generateOwnerKey = typeof generateOwnerKey === "function" ? generateOwnerKey : null;
    /** 引导页支付宝下单：main.cjs 注入（下单 + 轮询），这里只负责把结果推回发起页 */
    this.payOrder = typeof payOrder === "function" ? payOrder : null;
    this.setToolTier = typeof setToolTier === "function" ? setToolTier : null;
    this.setOnboardingDone = typeof setOnboardingDone === "function" ? setOnboardingDone : null;
    /** owner-key-new 上次成功生成口令的时间（频率限制用，只对成功生成计数） */
    this.ownerKeyLastAt = 0;
    /** 5 秒一次的推送定时器（只对打开的格子；unref 不挡退出） */
    this.panelTimer = null;
    /** BrowserOS 资料根目录：书签复制只允许在这个目录下面发生（按引擎的 defaultUserDataDir 反推） */
    try {
      this.profilesRoot = path.dirname(this.engineModule.defaultUserDataDir(this.dataHome, "__root_probe__"));
    } catch {
      this.profilesRoot = path.join(this.dataHome, "browseros", "profiles");
    }
    /** 换布局串行做：连点两下按钮时，不能两套 planLayoutChange 交错改 slot */
    this.layoutQueue = Promise.resolve();

    /** Map<id, {id, profile, handle, tab, window, partition, policy, closing, slot, lastSlot, hidden, bounds}> 开着的账号窗口 */
    this.entriesMap = new Map();
    /** Map<id, handle>：标签页被关掉、但进程还没退的（下次 open 直接复用这个进程） */
    this.orphans = new Map();
    /**
     * Map<id, Promise>：正在关、还没关完的账号。
     * 关进程要等它真退出，这中间要是有人又 open 同一个账号，进程还没退、资料目录还锁着，
     * 再起一个就会撞在同一份资料目录上。open 先等这张表里的 Promise，关完再决定复用还是重起。
     */
    this.closing = new Map();
  }

  /* ---------------- 依赖（按需加载：这一层不许 require electron） ---------------- */

  get engineModule() {
    return this.engineOverride || require("./browseros-engine.cjs");
  }

  get tabModule() {
    return this.tabOverride || require("./browseros-tab.cjs");
  }

  /** 共享插件库模块（按需加载：这一层不许 require electron） */
  get extLib() {
    return this.extensionsOverride || require("./browseros-extensions.cjs");
  }

  /** 外部扩展清单同步模块（只写 External Extensions 清单，不复制插件数据） */
  get extSyncLib() {
    return this.extensionSyncOverride || require("./browseros-extension-sync.cjs");
  }

  /** 分区的短标签：只给上层当 key 用，不是 Electron 的 persist: 分区名，也不带盘符路径 */
  partitionOf(id) {
    return `browseros:${String(id)}`;
  }

  /** 这个账号的资料目录（浏览器进程的 --user-data-dir） */
  userDataDirOf(id) {
    return this.engineModule.defaultUserDataDir(this.dataHome, String(id));
  }

  /* ---------------- 查询 ---------------- */

  has(id) {
    return this.entriesMap.has(String(id));
  }

  get(id) {
    return this.entriesMap.get(String(id)) || null;
  }

  /** 迭代开着的登记项（id / profile / tab / handle / window） */
  entries() {
    return [...this.entriesMap.values()];
  }

  /**
   * 给 browser-profiles.cjs 用：只说「哪些开着、现在在哪个网址」。
   * **不带** pid、端口、ws 地址、完整路径 —— 这些不该出现在给界面的数据里。
   */
  list() {
    return this.entries().map((entry) => {
      const alive = Boolean(entry.tab && !entry.tab.isDestroyed());
      return {
        id: entry.id,
        running: alive,
        currentUrl: alive ? (entry.tab.getURL() || null) : null,
        partition: entry.partition,
        mode: "window",
        engine: "browseros",
        // 格子编号（当前布局里的位置；收起后是 null）和是否被挪到屏幕外
        slot: entry.slot ?? null,
        hidden: Boolean(entry.hidden),
      };
    });
  }

  /**
   * 给侧边栏 / 新标签页的格子列表：只给编号、名字、是否收起。
   * 收起后 slot 是 null，用 lastSlot 保住它原来的编号（点「打开」时还能按编号找回来）。
   */
  panelGrids() {
    return this.entries()
      .map((entry) => ({
        slot: Number.isInteger(entry.slot) && entry.slot > 0
          ? entry.slot
          : (Number.isInteger(entry.lastSlot) && entry.lastSlot > 0 ? entry.lastSlot : null),
        name: String(entry.profile?.name || entry.id),
        hidden: Boolean(entry.hidden),
      }))
      .sort((a, b) => {
        const left = a.slot ?? Number.MAX_SAFE_INTEGER;
        const right = b.slot ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return left - right;
        return a.name.localeCompare(b.name);
      });
  }

  /* ---------------- 人接管检测要的两样东西 ---------------- */

  /**
   * 问自带插件「现在哪个窗口在前台」。
   *
   * 主进程拿这个信号 + powerMonitor.getSystemIdleTime() 一起判人接管；插件没连上（刚启动、
   * 被禁用、worker 睡死）时这里返回 ready:false，上层必须把「人接管检测未就绪」显示出来，不能静默。
   * 注意：只读插件内存里的状态，不点页面、不抢前台。
   *
   * @returns {Promise<{ready: boolean, windowId?: number|null, focused?: boolean, seq?: number, at?: number,
   *   activeTabUrl?: string|null, error?: string|null, reason?: string, events?: any[]}>}
   */
  /**
   * 排查用（2026-10-25 格子按钮在真机不通）：在运行中的程序里查插件后台和页面内容脚本两头。
   * 只读：不改页面、不发动作；内容脚本那头只问 chrome.runtime.id 和 get-grid-info。
   */
  async diagnoseGrid(id) {
    const entry = this.entriesMap.get(String(id));
    if (!entry) return { ok: false, reason: "没打开" };
    const out = { id: entry.id, slot: entry.slot, url: entry.tab?.getURL?.() || null };
    const sid = entry.policy?.workerSessionId;
    out.workerSession = Boolean(sid);
    out.binding = entry.handle?.gridBinding ? { ok: entry.handle.gridBinding.ok, error: entry.handle.gridBinding.error || null } : null;
    if (sid) {
      try {
        out.sw = await this.#evaluate(entry.handle.conn, sid, "(async()=>({id:chrome.runtime.id,url:location.href,binding:typeof globalThis.windriseGridAction,info:(await chrome.storage.session.get('gridInfo')).gridInfo||null}))()", { awaitPromise: true });
      } catch (error) { out.sw = { error: error.message }; }
      try {
        const targets = (await entry.handle.conn.send("Target.getTargets", {}, "", { timeoutMs: 8_000 })).targetInfos || [];
        out.workers = targets.filter((t) => t.type === "service_worker").map((t) => t.url);
      } catch (error) { out.workers = { error: error.message }; }
    }
    try {
      const dbg = entry.tab.debugger;
      const contexts = [];
      const onMessage = (_event, method, params) => { if (method === "Runtime.executionContextCreated") contexts.push(params.context); };
      dbg.on?.("message", onMessage);
      await dbg.sendCommand("Runtime.disable"); await dbg.sendCommand("Runtime.enable");
      await new Promise((resolve) => setTimeout(resolve, 800));
      dbg.removeListener?.("message", onMessage);
      out.contexts = contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, type: c.auxData?.type, frame: c.auxData?.frameId }));
      out.contentScripts = [];
      for (const c of contexts.filter((x) => x.auxData?.type === "isolated" && x.name === "Windrise 助手")) {
        const r = await dbg.sendCommand("Runtime.evaluate", { contextId: c.id, awaitPromise: true, returnByValue: true, expression: "new Promise(res=>{let id;try{id=chrome.runtime.id}catch(e){return res('id THROW '+e.message)};try{chrome.runtime.sendMessage({type:'get-grid-info'},(y)=>res('id='+id+' reply='+JSON.stringify(y)+' err='+(chrome.runtime.lastError&&chrome.runtime.lastError.message)))}catch(e){res('id='+id+' send THROW '+e.message)};setTimeout(()=>res('id='+id+' TIMEOUT'),3000)})" });
        out.contentScripts.push({ ctx: c.id, result: r?.result?.value ?? r?.exceptionDetails?.text ?? null });
      }
    } catch (error) { out.pageError = error.message; }
    return out;
  }

  async extensionFocus(id) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry) return { ready: false, reason: `账号窗口 ${pid} 没有打开，插件没连上` };
    const sessionId = entry.policy?.workerSessionId;
    if (!sessionId) return { ready: false, reason: `账号窗口 ${pid} 的插件会话没记下来（插件没连上）` };
    try {
      const state = await this.#evaluate(
        entry.handle.conn,
        sessionId,
        "globalThis.__windrise && __windrise.focusState ? __windrise.focusState() : null",
        { awaitPromise: true },
      );
      if (!state || typeof state !== "object") {
        return { ready: false, reason: "插件没有 focusState（插件版本太旧或没连上）" };
      }
      return {
        ready: state.ready === true,
        windowId: typeof state.windowId === "number" ? state.windowId : null,
        focused: state.focused === true,
        seq: Number(state.seq) || 0,
        at: Number(state.at) || 0,
        activeTabUrl: typeof state.activeTab?.url === "string" ? state.activeTab.url : null,
        error: typeof state.error === "string" ? state.error : null,
        events: Array.isArray(state.events) ? state.events.slice(-8) : [],
      };
    } catch (error) {
      return { ready: false, reason: `问插件焦点状态失败：${error.message}` };
    }
  }

  /**
   * 这个账号窗口在浏览器里的 windowId（插件报的焦点窗口号要和它对上）。
   * 走的是浏览器级 Browser.getWindowForTarget，和挪窗口用的是同一条命令，不碰页面。
   * 拿不到就返回 null（上层按「对不上」处理，不会误判成前台）。
   */
  async windowIdOf(id) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry?.tab || entry.tab.isDestroyed()) return null;
    if (typeof entry.windowId === "number") return entry.windowId;
    try {
      const got = await entry.handle.conn.send(
        "Browser.getWindowForTarget",
        { targetId: entry.tab.targetId },
        "",
        { timeoutMs: 8_000 },
      );
      if (typeof got?.windowId === "number") {
        entry.windowId = got.windowId;
        return got.windowId;
      }
    } catch (error) {
      log(`账号窗口 ${pid} 问不到 windowId（${error.code || "错误"}：${error.message}），人接管检测先跳过这个窗口`);
    }
    return null;
  }

  /* ---------------- 开窗口 ---------------- */

  /**
   * 打开（或复用）一个账号窗口。
   *
   * 顺序是死的，一步失败就停下并把已经起的进程收掉（和「防护就位才加载页面」同一个原则）：
   *   1. 预写 Preferences（写不进去只记日志，不阻断）
   *   2. launch（带资料目录、代理、自带插件）
   *   3. 找到自带插件、核对 WebRTC 策略（拿不到/管不着 → EXTENSION_NOT_READY，先关进程再抛）；
   *      叫醒插件用的标签页一律先开 about:blank，策略和代理都对上以后才导航到目标网址
   *   4. 有代理就真对账（对不上 → PROXY_NOT_APPLIED，关进程再抛）
   *   5. Target.createTarget 建窗口，并用 Browser.setWindowBounds 摆到工作区中间（不抢前台）
   *   6. 包成 Electron 外观、登记、报 window-opened
   *
   * 复用已开窗口时：调用方明确给了网址才导航；没给网址只把现有窗口交回去，不 loadURL(startUrl)。
   * 如果这个格子是「收起」状态，复用的时候顺手摆回屏幕内（setWindowBounds 不会抢焦点）。
   *
   * @param {string} id
   * @param {{ profile?: any, url?: string }} [options]
   * @returns {Promise<{reused: boolean, id: string, url: string, partition: string, window: any, tabId: number}>}
   */
  async open(id, { profile, url } = {}) {
    const pid = String(id);

    // 同一个账号正在关：等它关完再往下走，不然会对着同一份资料目录起第二个进程
    await this.#waitForClosing(pid);

    const prof = profile || { id: pid, name: pid };
    // 「明确给了网址」才算数：空串 / 没给都按没给处理（界面上的「打开」按钮就是不带网址的）
    const explicitUrl = url !== undefined && url !== null && String(url).trim() !== "";
    const wanted = checkSiteUrl(explicitUrl ? url : prof.startUrl || "about:blank") || "about:blank";

    /* 1) 已经开着这个账号的标签页：给网址才导航，绝不新开窗口、绝不抢前台 */
    const existing = this.entriesMap.get(pid);
    if (existing) {
      if (existing.tab && !existing.tab.isDestroyed()) {
        if (existing.hidden) {
          // 收起状态被重新打开：先摆回屏幕内（只发 setWindowBounds，不激活窗口）
          await this.show(pid).catch((error) => log(`账号窗口 ${pid} 摆回屏幕内失败（继续复用）：${error.message}`));
        }
        if (explicitUrl) {
          await existing.tab.loadURL(wanted);
        } else {
          // 只碰本地外观：focus() 是空动作，不走任何 CDP 命令（Target.activateTarget / Page.bringToFront 一律不发）
          existing.window?.focus?.();
        }
        return {
          reused: true,
          id: pid,
          url: explicitUrl ? wanted : (existing.tab.getURL?.() || wanted),
          partition: existing.partition,
          window: existing.window,
          tabId: existing.tab.id,
          slot: existing.slot ?? null,
          hidden: Boolean(existing.hidden),
        };
      }
      // 标签页自己没了：把这半条命收掉，下面按「进程还在不在」重新决定复用还是重起
      await this.#dropEntry(existing, "标签页已经不在了，重新开");
    }

    const userDataDir = this.userDataDirOf(pid);

    /* 2) 进程还在（标签页被关掉但浏览器没退）：复用进程，别再起一个抢同一份资料目录 */
    let handle = this.#liveOrphan(pid);
    const reusedProcess = Boolean(handle);
    if (!handle) {
      // 1. Preferences 先写好（窗口名 + WebRTC 兜底策略）。写不进去不算启动失败，只记日志
      try {
        const prefs = await this.engineModule.writePreferences(userDataDir, { profileName: prof.name });
        if (!prefs?.written) log(`账号窗口 ${pid} 的 Preferences 没写成（${prefs?.reason || "没给原因"}），照常开`);
      } catch (error) {
        log(`账号窗口 ${pid} 预写 Preferences 出错（不影响开窗口）：${error.message}`);
      }

      // 1.5 插件文件变过就清掉这个账号里缓存的旧后台脚本（不然老账号一直跑旧插件，见 refreshExtensionWorkerCache）
      try {
        const refreshed = await refreshExtensionWorkerCache(userDataDir, this.extensionDir);
        if (refreshed.cleared) log(`账号窗口 ${pid}：${refreshed.reason}，清掉了旧的插件后台脚本缓存（${refreshed.removed.join("、")}）`);
        else if (/联接点/.test(refreshed.reason)) log(`账号窗口 ${pid}：${refreshed.reason}`);
      } catch (error) {
        log(`账号窗口 ${pid} 检查插件缓存出错（照常开）：${error.message}`);
      }

      // 2. 起进程。--load-extension 除了我们自己的插件，再带上共享插件库里 enabled 的每个插件目录
      //    （引擎那边逗号分隔；共享库读失败就当没有，不挡开窗）
      let extensionDirs = [this.extensionDir];
      try {
        // 这个格子自己已经有商店版（Default/Extensions/<id>）的就别再带共享版：同一个 id 加载两份会打架
        const ownExtensionsDir = path.join(this.userDataDirOf(pid), "Default", "Extensions");
        const shared = this.extLib.extensionDirsForLaunch(this.dataHome)
          .filter((dir) => !fs.existsSync(path.join(ownExtensionsDir, path.basename(dir))));
        extensionDirs = extensionDirs.concat(shared);
      } catch (error) {
        log(`账号窗口 ${pid} 读共享插件库失败（照常开，不带共享插件）：${error.message}`);
      }
      handle = await this.engineModule.launch({
        profileId: pid,
        dataHome: this.dataHome,
        proxy: prof.proxy || "",
        extensionDir: this.extensionDir,
        extensionDirs,
        timeoutMs: this.launchTimeoutMs,
        profileName: prof.name,
      });
    }

    let policy;
    try {
      /* 3+4) 插件策略 + 代理对账：管不着/对不上就关进程再抛（不然开出来的窗口 WebRTC 是漏的、代理是假的） */
      policy = await this.#ensureExtensionPolicy(handle, prof);

      /* 5) 建窗口 + 摆到工作区里。叫醒插件时如果已经建了一个，就直接用它，别多开一个窗口 */
      let targetId = policy?.seedTargetId || null;
      const seeded = Boolean(targetId);
      let placement = policy?.seedBounds || null;
      if (!targetId) {
        const created = await handle.conn.send("Target.createTarget", { url: wanted, newWindow: true, background: true }, "", { timeoutMs: 15_000 });
        targetId = created?.targetId;
        if (!targetId) throw codedError("TARGET_CLOSED", `账号窗口 ${pid}：浏览器没给 targetId，窗口没建起来`);
        placement = await this.#placeOnScreen(handle, targetId, null, pid);
      } else if (!placement) {
        placement = await this.#placeOnScreen(handle, targetId, null, pid);
      }

      /* 6) 包成外观并登记 */
      const tab = await this.tabModule.createTabFacade({
        targetId,
        sessionProvider: () => this.#sessionFor(handle, targetId, pid),
        label: `账号窗口 ${prof.name || pid}`,
      });
      const window = this.tabModule.createWindowFacade(tab);

      // 叫醒插件用的那个标签页是 about:blank：策略和代理都核对通过了，这时候才导航到目标网址。
      // 不是叫醒用的标签页在 Target.createTarget 时就已经按 wanted 加载了，不用再导航一次。
      if (seeded && wanted !== "about:blank") {
        await tab.loadURL(wanted);
      }

      const slot = this.#nextFreeSlot();
      const entry = {
        id: pid,
        profile: prof,
        handle,
        tab,
        window,
        partition: this.partitionOf(pid),
        policy,
        closing: false,
        // 格子编号 = 当前布局里的位置（左上为 1）；收起后 slot 变 null，lastSlot 留原编号用来保持顺序
        slot,
        lastSlot: slot,
        hidden: false,
        // 最后一次「在屏幕内」的位置；show() 就摆回这里
        bounds: placement || defaultWindowBounds(this.#workArea()),
        // 有插件改动要重开格子才生效（运行中装卸不可用/失败时置真，面板里提示）
        extRestartNeeded: false,
        // 空间：Map<空间id, {id, name, owner, createdAt, tab, window, groupId, chromeTabId}>
        // 默认空间「我的」就是本标签页；AI 空间从 windrise-spaces.json 恢复名字，标签页不自动恢复
        spaces: new Map(),
      };
      this.entriesMap.set(pid, entry);
      this.#watch(entry);
      // 恢复空间：默认空间 + 之前存下来的 AI 空间名字（标签页不恢复，AI 再用时按需开）
      await this.#restoreSpaces(entry);
      // 把编号和账号名交给插件（存 chrome.storage.session，页面左下角按钮和侧边栏都读它）
      await this.#pushGridInfo(entry).catch((error) => log(`账号窗口 ${pid} 的格子信息没推给插件（不影响开窗）：${error.message}`));
      // 开窗后立刻推一次面板状态；之后每 5 秒一次
      await this.#pushPanelState(entry).catch(() => {});
      this.#ensurePanelTimer();
      this.onEvent({ kind: "window-opened", id: pid, url: wanted, pid: handle.pid ?? null });
      return {
        reused: false,
        id: pid,
        url: wanted,
        partition: entry.partition,
        window,
        tabId: tab.id,
        reusedProcess,
        slot: entry.slot,
        hidden: false,
      };
    } catch (error) {
      // 任何一步失败都不留半条命：把这个账号的浏览器进程收掉再抛
      await this.#closeHandleQuietly(handle, `账号窗口 ${pid} 开窗口失败，收掉它的进程`);
      throw error;
    }
  }

  /**
   * 每次要会话时给一个「已经 attach 好」的 AccountSurface。
   * 外观把上一次的会话 dispose 掉之后，这里会重新 attach 出新的来。
   * urlGuard 用 ai-site-guard：登录页上读/点/填/截图一律拒（SIGNIN_PAGE_HUMAN_ONLY），
   * 只有「离开页面」那几条命令例外（见 LEAVING_COMMANDS 的注释）。
   */
  async #sessionFor(handle, targetId, pid) {
    const surface = new AccountSurface(handle.conn, {
      targetId,
      urlGuard: (url) => checkAiAccess(url),
      label: `账号窗口 ${pid}`,
    });
    await surface.attach();
    return surface;
  }

  /* ---------------- 格子位置：摆屏幕内 / 收起 / 换布局 ---------------- */

  /** 工作区：默认主显示器；给 nearBounds 时问那个显示器（Electron 那边用 getDisplayMatching） */
  #workArea(nearBounds = null) {
    try {
      return normalizeWorkArea(nearBounds ? this.getWorkArea(nearBounds) : this.getWorkArea());
    } catch (error) {
      log(`拿不到工作区（${error.code || "错误"}：${error.message}），按内置的 ${FALLBACK_WORK_AREA.width}x${FALLBACK_WORK_AREA.height} 算`);
      return { ...FALLBACK_WORK_AREA };
    }
  }

  /** 这个格子当前在屏幕上的位置：优先用它上次的屏幕内矩形，没有就用默认小窗口 */
  #screenRectOf(entry) {
    if (entry?.bounds) {
      try { return normalizeRect(entry.bounds); } catch { /* 旧数据坏了就用默认 */ }
    }
    return defaultWindowBounds(this.#workArea());
  }

  /** 问浏览器窗口现在真实在哪（用户可能手动拖过）；问不到就用上次记的 */
  async #currentRectOf(entry) {
    try {
      const windowId = await this.#windowIdFor(entry.handle, entry.tab.targetId);
      const got = await entry.handle.conn.send("Browser.getWindowBounds", { windowId }, "", { timeoutMs: 8_000 });
      const bounds = got?.bounds;
      if (bounds) {
        return normalizeRect({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
      }
    } catch {
      /* 假连接 / 老版本可能没有这条命令：按上次记住的位置 */
    }
    return this.#screenRectOf(entry);
  }

  async #windowIdFor(handle, targetId) {
    const got = await handle.conn.send("Browser.getWindowForTarget", { targetId }, "", { timeoutMs: 8_000 });
    if (got?.windowId === undefined || got?.windowId === null) {
      throw codedError("TARGET_CLOSED", `账号窗口 ${handle.id}：浏览器没给 windowId，摆不了窗口`);
    }
    return got.windowId;
  }

  /**
   * 只发 Browser.setWindowBounds：不调 Target.activateTarget / Page.bringToFront，窗口不会跳到前台。
   * 失败会抛（调用方决定是记日志还是让换布局失败）。
   */
  async #setWindowRect(handle, targetId, rect, { offscreen = false } = {}) {
    const windowId = await this.#windowIdFor(handle, targetId);
    const bounds = offscreen ? { ...OFFSCREEN_BOUNDS } : cdpBoundsOf(expandByInsets(rect, frameInsetsCache));
    // 人把窗口最大化 / 最小化 / 全屏之后，setWindowBounds 带位置是不生效的（2026-10-25 真机踩到：
    // 换布局跑完了，窗口一动不动，新格子被压在最大化窗口后面）。先单独发一次 windowState:normal 再摆位置。
    // 只改窗口状态，不激活窗口，不抢前台。
    try {
      const current = await handle.conn.send("Browser.getWindowBounds", { windowId }, "", { timeoutMs: 8_000 });
      if (current?.bounds?.windowState && current.bounds.windowState !== "normal") {
        await handle.conn.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, "", { timeoutMs: 8_000 });
      }
    } catch { /* 老版本 / 假连接没有 getWindowBounds：直接摆 */ }
    await handle.conn.send("Browser.setWindowBounds", { windowId, bounds }, "", { timeoutMs: 8_000 });
    // 还没量过边框：摆好后量一次，量到非零就按扣掉边框的外框重摆一次（之后都直接用缓存）
    if (!offscreen && !frameInsetsCache && handle.pid) {
      const insets = await measureFrameInsets(handle.pid);
      if (insets) {
        frameInsetsCache = insets;
        log(`量到窗口看不见的边框：左 ${insets.left} 上 ${insets.top} 右 ${insets.right} 下 ${insets.bottom}（像素），之后铺格子都扣掉`);
        if (insets.left || insets.top || insets.right || insets.bottom) {
          await handle.conn.send("Browser.setWindowBounds", { windowId, bounds: cdpBoundsOf(expandByInsets(rect, insets)) }, "", { timeoutMs: 8_000 });
        }
      }
    }
    return rect;
  }

  /** 把新窗口摆到屏幕内（默认小窗口，或调用方给的矩形）。摆不动只记日志，不影响开窗 */
  async #placeOnScreen(handle, targetId, rect, pid = handle.id) {
    const wanted = rect ? normalizeRect(rect) : defaultWindowBounds(this.#workArea());
    try {
      await this.#setWindowRect(handle, targetId, wanted);
    } catch (error) {
      log(`账号窗口 ${pid} 没摆到屏幕内（${error.code || "错误"}：${error.message}），继续`);
    }
    return wanted;
  }

  /** 最小的没被占用的格子编号（1 起） */
  #nextFreeSlot() {
    const used = new Set();
    for (const entry of this.entries()) {
      if (Number.isInteger(entry.slot) && entry.slot > 0) used.add(entry.slot);
    }
    let slot = 1;
    while (used.has(slot)) slot += 1;
    return slot;
  }

  /** 可以拿来补位的已有格子账号：名字是「格子 N」、现在没打开；优先「格子 {slot}」，其次编号最小的 */
  #reusableGridProfile(slot) {
    const candidates = (this.listProfiles() || []).filter((profile) => {
      if (!profile?.id || this.entriesMap.has(String(profile.id))) return false;
      return /^格子 \d+$/.test(String(profile.name || ""));
    });
    if (!candidates.length) return null;
    const exact = candidates.find((profile) => profile.name === `格子 ${slot}`);
    if (exact) return exact;
    return candidates.sort((a, b) => Number(String(a.name).slice(3)) - Number(String(b.name).slice(3)))[0];
  }

  /** 新账号名字「格子 N」：N 取现在还没用掉的最小正整数（按所有账号名算，不只看开着的） */
  #nextGridName(preferred = null) {
    const used = new Set();
    for (const profile of this.listProfiles() || []) {
      if (profile?.name) used.add(String(profile.name));
    }
    for (const entry of this.entries()) {
      if (entry.profile?.name) used.add(String(entry.profile.name));
    }
    // 优先用它将要占的位置编号（第 2 格就叫「格子 2」），被别的账号占了名字才往后找
    if (Number.isInteger(preferred) && preferred > 0 && !used.has(`格子 ${preferred}`)) return `格子 ${preferred}`;
    for (let n = 1; n < 100_000; n += 1) {
      const name = `格子 ${n}`;
      if (!used.has(name)) return name;
    }
    throw codedError("INVALID_ARGUMENT", "账号名「格子 N」已经用掉太多了，建不出新名字");
  }

  #requireEntry(id) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry?.tab || entry.tab.isDestroyed()) {
      throw codedError("TARGET_CLOSED", `格子 ${pid} 没有打开：先 browser_open 打开这个格子（id 或格子编号都行），开着的话只会聚焦不会新开`);
    }
    return entry;
  }

  /**
   * 把像素矩形交给插件（chrome.storage.session）。插件没连上 / 没有 setGridInfo 就跳过，
   * 不能因为一个提示按钮影响开窗口和换布局。
   */
  async #pushGridInfo(entry) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return { pushed: false, reason: "插件会话不在" };
    const slot = Number(entry.slot ?? entry.lastSlot ?? 0) || 0;
    const name = String(entry.profile?.name || entry.id);
    const info = { slot, name };
    const expression = `globalThis.__windrise && typeof __windrise.setGridInfo === "function" ? __windrise.setGridInfo(${JSON.stringify(info)}) : null`;
    const result = await this.#evaluate(entry.handle.conn, sessionId, expression, { awaitPromise: true });
    return { pushed: true, info, result };
  }

  async #pushAllGridInfo() {
    for (const entry of this.entries()) {
      await this.#pushGridInfo(entry).catch((error) => log(`账号窗口 ${entry.id} 的格子信息没推给插件（忽略）：${error.message}`));
    }
  }

  /**
   * 把侧边栏 / 新标签页要的只读状态写进插件（chrome.storage.session 的 panelState）。
   *
   * state 由 main.cjs 注入的 getPanelState 提供；这里再按 panel-state 的白名单字段重建一次，
   * 保证就算上游以后接错数据，口令 / 带令牌地址 / 调用参数也进不了插件。
   * 插件没连上 / 老版本没有 setPanelState 就静默跳过。
   */
  async #pushPanelState(entry) {
    if (!this.getPanelState || !entry) return { pushed: false, reason: "没有 getPanelState" };
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return { pushed: false, reason: "插件会话不在" };
    const slot = Number(entry.slot ?? entry.lastSlot ?? 0) || 0;
    const name = String(entry.profile?.name || entry.id);
    let state;
    try {
      state = await this.getPanelState({
        id: entry.id,
        slot: slot > 0 ? slot : null,
        name,
        hidden: Boolean(entry.hidden),
      });
    } catch {
      return { pushed: false, reason: "getPanelState 出错" };
    }
    if (!state || typeof state !== "object") return { pushed: false, reason: "getPanelState 没有返回对象" };
    const safe = buildPanelState(state);
    let payload;
    try {
      payload = JSON.stringify(safe);
    } catch {
      return { pushed: false, reason: "状态序列化失败" };
    }
    const expression = `globalThis.__windrise && typeof __windrise.setPanelState === "function" ? __windrise.setPanelState(${payload}) : null`;
    const result = await this.#evaluate(entry.handle.conn, sessionId, expression, { awaitPromise: true });
    return { pushed: true, state: safe, result };
  }

  async #pushAllPanelStates() {
    for (const entry of this.entries()) {
      await this.#pushPanelState(entry).catch(() => {});
    }
  }

  /** 第一次开窗口时启动；只对打开的格子推，失败静默 */
  #ensurePanelTimer() {
    if (this.panelTimer || !this.getPanelState) return;
    this.panelTimer = setInterval(() => {
      if (!this.entriesMap.size) {
        this.#stopPanelTimer();
        return;
      }
      void this.#pushAllPanelStates();
    }, PANEL_PUSH_INTERVAL_MS);
    this.panelTimer.unref?.();
  }

  #stopPanelTimer() {
    if (!this.panelTimer) return;
    clearInterval(this.panelTimer);
    this.panelTimer = null;
  }

  #stopPanelTimerIfIdle() {
    if (!this.entriesMap.size) this.#stopPanelTimer();
  }

  /** 把某个格子的窗口摆到指定矩形（公开接口；会顺手把它标成「屏幕内」） */
  async setBounds(id, bounds) {
    const entry = this.#requireEntry(id);
    const rect = normalizeRect(bounds);
    await this.#setWindowRect(entry.handle, entry.tab.targetId, rect);
    entry.bounds = rect;
    entry.hidden = false;
    if (!Number.isInteger(entry.slot) || entry.slot <= 0) {
      entry.slot = this.#nextFreeSlot();
      entry.lastSlot = entry.slot;
    }
    await this.#pushGridInfo(entry).catch(() => {});
    await this.#pushPanelState(entry).catch(() => {});
    return { id: entry.id, slot: entry.slot, hidden: false, bounds: { ...entry.bounds } };
  }

  /** 收起这一格：进程、标签页、登录态都不动，只把窗口挪到屏幕外 */
  async hide(id) {
    const entry = this.#requireEntry(id);
    await this.#setWindowRect(entry.handle, entry.tab.targetId, OFFSCREEN_BOUNDS, { offscreen: true });
    if (Number.isInteger(entry.slot) && entry.slot > 0) entry.lastSlot = entry.slot;
    entry.slot = null;
    entry.hidden = true;
    await this.#pushGridInfo(entry).catch(() => {});
    await this.#pushPanelState(entry).catch(() => {});
    return { id: entry.id, slot: null, hidden: true, bounds: { ...this.#screenRectOf(entry) } };
  }

  /** 摆回屏幕内：优先上次的位置，没有就用默认小窗口；如果它已经没有编号，补一个最小可用编号 */
  async show(id) {
    const entry = this.#requireEntry(id);
    const rect = this.#screenRectOf(entry);
    await this.#setWindowRect(entry.handle, entry.tab.targetId, rect);
    entry.bounds = rect;
    entry.hidden = false;
    if (!Number.isInteger(entry.slot) || entry.slot <= 0) {
      entry.slot = this.#nextFreeSlot();
      entry.lastSlot = entry.slot;
    }
    await this.#pushGridInfo(entry).catch(() => {});
    await this.#pushPanelState(entry).catch(() => {});
    return { id: entry.id, slot: entry.slot, hidden: false, bounds: { ...entry.bounds } };
  }

  /**
   * 人主动点「打开 / 聚焦」（托盘单击、second-instance、侧边栏格子列表）：
   * 收起就先摆回屏幕内，再让浏览器把窗口拿到前台。AI 的控制路径（open / 布局 / 空间）不碰这里，
   * 所以 open 全流程不抢前台的原则（契约 §5.2 第 2 条）不变；拿前台失败只记日志，不抛。
   */
  async focus(id) {
    const entry = this.#requireEntry(id);
    if (entry.hidden) await this.show(id);
    try {
      await entry.handle.conn.send("Target.activateTarget", { targetId: entry.tab.targetId }, "", { timeoutMs: 8_000 });
    } catch (error) {
      log(`账号窗口 ${entry.id} 拿到前台失败（${error.code || "错误"}：${error.message}），窗口已摆回屏幕内`);
    }
    return { id: entry.id, slot: Number.isInteger(entry.slot) ? entry.slot : null, hidden: false };
  }

  /**
   * 换布局：被点的格子变 slot 1，其它按原编号补位；不够的补新账号，多余的收起。
   *
   * 新账号是全新登录态：只把基准格子（被点的那个）的 Default/Bookmarks 复制过去，
   * 不复制 Cookie / 登录数据。复制发生在新账号浏览器进程启动之前（先 createProfile、再 open）。
   *
   * 串行执行：连续点两下按钮时，后一次等前一次做完再算，避免两套 slot 交错。
   */
  applyLayout(clickedId, layout) {
    const run = () => this.#applyLayoutNow(clickedId, layout);
    const queued = this.layoutQueue.then(run, run);
    this.layoutQueue = queued.catch(() => {});
    return queued;
  }

  async #applyLayoutNow(clickedId, layout) {
    const key = normalizeLayout(layout);
    const clicked = this.#requireEntry(clickedId);
    // 以被点的格子「现在真实所在」的显示器工作区为准（用户可能手动把它拖到副屏了）
    const workArea = this.#workArea(await this.#currentRectOf(clicked));
    const cells = computeLayout(workArea, key);
    const plan = planLayoutChange({
      openGrids: this.entries().map((entry) => ({
        id: entry.id,
        slot: entry.slot ?? entry.lastSlot,
        hidden: entry.hidden,
      })),
      clickedId: clicked.id,
      layout: key,
    });
    if (plan.create > 0 && typeof this.createProfile !== "function") {
      throw codedError("GRID_CREATE_UNSUPPORTED", "换布局要补新账号，但没人给 createProfile（BrowserOsProfiles 需要 browser-profiles 注入建账号逻辑）");
    }

    const assigned = [];
    for (const item of plan.assign) {
      const entry = this.entriesMap.get(String(item.id));
      if (!entry) continue;
      const cell = cells[item.slot - 1];
      entry.slot = item.slot;
      entry.lastSlot = item.slot;
      entry.hidden = false;
      await this.#setWindowRect(entry.handle, entry.tab.targetId, cell);
      entry.bounds = { ...cell };
      assigned.push({ id: entry.id, slot: item.slot, bounds: { ...cell } });
    }

    const hidden = [];
    for (const id of plan.hide) {
      const entry = this.entriesMap.get(String(id));
      if (!entry) continue;
      if (Number.isInteger(entry.slot) && entry.slot > 0) entry.lastSlot = entry.slot;
      entry.slot = null;
      await this.#setWindowRect(entry.handle, entry.tab.targetId, OFFSCREEN_BOUNDS, { offscreen: true });
      entry.hidden = true;
      hidden.push(entry.id);
    }

    const created = [];
    for (let index = 0; index < plan.create; index += 1) {
      const wantSlot = assigned.length + created.length + 1;
      // 先复用已有但没打开的「格子 N」账号（2026-10-26 用户定：不然每换一次布局就多几个空账号），优先名字和位置对得上的
      const reusable = this.#reusableGridProfile(wantSlot);
      if (reusable) {
        await this.open(reusable.id, { profile: reusable, url: (!reusable.startUrl || reusable.startUrl === "about:blank") ? NEW_GRID_START_URL : undefined });
        const entry = this.entriesMap.get(String(reusable.id));
        if (!entry) throw codedError("TARGET_CLOSED", `格子 ${reusable.id} 打开后没有登记，换布局没做完`);
        const cell = cells[wantSlot - 1];
        entry.slot = wantSlot;
        entry.lastSlot = wantSlot;
        entry.hidden = false;
        await this.#setWindowRect(entry.handle, entry.tab.targetId, cell);
        entry.bounds = { ...cell };
        created.push({ id: entry.id, name: reusable.name, slot: wantSlot, bounds: { ...cell }, reused: true });
        continue;
      }
      const name = this.#nextGridName(wantSlot);
      const profile = await this.createProfile({ name, startUrl: NEW_GRID_START_URL });
      if (!profile?.id) throw codedError("GRID_CREATE_UNSUPPORTED", `建账号「${name}」没拿到 id`);
      // 只复制书签；复制失败（没有书签文件 / 路径不安全 / 读写出错）不阻断开新格子，但要说出来
      let bookmarks;
      try {
        bookmarks = await copyBookmarksBetweenProfiles({
          dataHome: this.dataHome,
          profilesRoot: this.profilesRoot,
          fromId: clicked.id,
          toId: profile.id,
          log,
        });
      } catch (error) {
        bookmarks = { copied: false, reason: `复制书签出错：${error.message}` };
      }
      if (!bookmarks.copied && bookmarks.reason && !/没有书签文件/.test(bookmarks.reason)) {
        log(`格子 ${profile.id} 没复制到书签：${bookmarks.reason}`);
      }
      await this.open(profile.id, { profile });
      const entry = this.entriesMap.get(String(profile.id));
      if (!entry) throw codedError("TARGET_CLOSED", `新格子 ${profile.id} 打开后没有登记，换布局没做完`);
      const slot = assigned.length + created.length + 1;
      const cell = cells[slot - 1];
      entry.slot = slot;
      entry.lastSlot = slot;
      entry.hidden = false;
      await this.#setWindowRect(entry.handle, entry.tab.targetId, cell);
      entry.bounds = { ...cell };
      created.push({ id: entry.id, name: profile.name, slot, bounds: { ...cell } });
    }

    await this.#pushAllGridInfo();
    await this.#pushAllPanelStates();
    this.#ensurePanelTimer();
    return {
      layout: key,
      workArea: { ...workArea },
      assigned,
      create: plan.create,
      created,
      hide: hidden,
    };
  }

  /* ---------------- 自带插件：找到我们那份、核对策略、对账代理 ---------------- */

  /**
   * 找到自带插件的 service worker，调 __windrise.applyPolicy，读**真实的** levelOfControl；
   * 配了代理再拿 proxyMatchesExpectation 对账。
   *
   * 判定顺序（每一步失败就不往下走）：
   *   a. `globalThis.__windrise && __windrise.ping()` 能通、带 id 的才是我们那份（预装的别的扩展会先出现在列表里）；
   *   b. `levelOfControl` 必须是 controlled_by_this_extension；
   *   c. 配了代理就必须 proxyMatchesExpectation === true。
   *
   * attach 上的会话**不摘**：挂着调试器会话 worker 不会被停（实测 40 秒都稳）；摘掉才 18 秒就睡。
   *
   * @param {any} handle
   * @param {any} profile
   * @returns {Promise<{workerUrl: string, extensionId: string, webRtc: any, proxy: any, errors: string[], notes: string[], seedTargetId: string|null, seedBounds: any, gridBinding: any, waitedMs: number}>}
   */
  async #ensureExtensionPolicy(handle, profile = {}) {
    const conn = handle.conn;
    const pid = handle.id;
    const expectProxy = String(profile?.proxy || "").trim();
    const notes = [];
    /** Map<targetId, sessionId|null>：附过的 worker（附上了就留着，不再摘） */
    const heldSessions = new Map();
    /** 叫醒 worker 时顺手建的那个标签页：醒过来了就直接拿它当账号窗口，不多开一个 */
    let seedTargetId = null;
    /** 叫醒标签页已经摆好的屏幕内矩形（open 里不用再问一次窗口号） */
    let seedBounds = null;
    let woke = false;
    let lastLevel = null;
    const startedAt = Date.now();
    // 叫醒之后重新算一次截止时间（worker 回来只要几百毫秒，6 秒够宽松）
    let deadline = startedAt + this.extensionWaitMs;

    const policyExpression = expectProxy
      ? `globalThis.__windrise && __windrise.applyPolicy({webRtcPolicy:${JSON.stringify(DEFAULT_WEBRTC_POLICY)},expectProxy:${JSON.stringify(expectProxy)}})`
      : `globalThis.__windrise && __windrise.applyPolicy({webRtcPolicy:${JSON.stringify(DEFAULT_WEBRTC_POLICY)}})`;

    /** 在目标列表里找我们那份插件并 ping 一次；找不到返回 null */
    const findOurs = async () => {
      const listed = await conn.send("Target.getTargets", {}, "", { timeoutMs: 8_000 }).catch(() => ({ targetInfos: [] }));
      const candidates = (listed.targetInfos || []).filter(
        (info) => info && info.type === "service_worker" && String(info.url || "").startsWith("chrome-extension://"),
      );
      for (const info of candidates) {
        if (!heldSessions.has(info.targetId)) {
          let sessionId = null;
          try {
            const attached = await conn.send("Target.attachToTarget", { targetId: info.targetId, flatten: true }, "", { timeoutMs: 8_000 });
            sessionId = attached?.sessionId || null;
            if (sessionId) await conn.send("Runtime.enable", {}, sessionId, { timeoutMs: 8_000 }).catch(() => {});
          } catch (error) {
            // 常见原因：worker 刚被浏览器停掉（no such target），下一轮会重新出现在列表里
            notes.push(`${info.url} 附不上（${error.code || "错误"}：${error.message}）`);
            sessionId = null;
          }
          heldSessions.set(info.targetId, sessionId);
        }
        const sessionId = heldSessions.get(info.targetId);
        if (!sessionId) continue;
        const who = await this.#evaluate(conn, sessionId, "globalThis.__windrise && __windrise.ping()", { awaitPromise: true })
          .catch(() => null);
        if (!who || typeof who !== "object" || !who.id) {
          notes.push(`${info.url} 不是我们的插件（ping 不通）`);
          continue;
        }
        return { info, sessionId, who };
      }
      return null;
    };

    while (true) {
      const found = await findOurs();

      if (found) {
        const { info, sessionId, who } = found;
        const policy = await this.#evaluate(conn, sessionId, policyExpression, { awaitPromise: true });
        const level = policy?.webRtc?.levelOfControl ?? null;
        lastLevel = level;
        if (level !== "controlled_by_this_extension") {
          throw codedError(
            "EXTENSION_NOT_READY",
            `账号窗口 ${pid} 的自带插件没生效：WebRTC 策略现在的 levelOfControl 是 ${String(level)}`
            + `（要 controlled_by_this_extension 才算本扩展管着），读回来的值是 ${String(policy?.webRtc?.value)}`,
            { levelOfControl: level, webRtcValue: policy?.webRtc?.value ?? null, extensionId: who.id, errors: policy?.errors || [], notes },
          );
        }

        // 配了代理就真对账（没配代理时读到 system 属正常，不当失败）
        let proxy = null;
        if (expectProxy) {
          const seen = policy?.proxy || null;
          const single = seen?.value?.rules?.singleProxy || null;
          const matches = policy?.proxyMatchesExpectation ?? null;
          proxy = {
            mode: seen?.mode ?? null,
            levelOfControl: seen?.levelOfControl ?? null,
            singleProxy: single && single.host ? { scheme: single.scheme || "http", host: single.host, port: Number(single.port) } : null,
            matches,
            note: policy?.proxyNote ?? "（插件没给说明）",
          };
          if (matches !== true) {
            throw codedError(
              "PROXY_NOT_APPLIED",
              `账号窗口 ${pid} 配了代理，但浏览器里读到的对不上：${proxy.note}`,
              { proxy, extensionId: who.id, notes },
            );
          }
          log(`账号窗口 ${pid} 代理对账通过：${proxy.note}`);
        }

        // 给插件 service worker 会话加格子动作 binding。
        // 关键：只加在这个 sessionId 上，页面会话一条都没加过 —— 网页脚本拿不到 windriseGridAction，
        // 只有插件 service worker 能调；页面内容再怎么伪造也进不了主程序。
        const gridBinding = await this.#installGridBinding(handle, sessionId);

        return {
          workerUrl: info.url,
          extensionId: who.id,
          // 这个 worker 的调试会话要留着：主进程后面靠它问焦点状态（人接管检测）。
          // 会话本来就不摘（见上面的注释），这里只是把会话号记进 policy，别让外面猜。
          workerSessionId: sessionId,
          workerTargetId: info.targetId,
          webRtc: { value: policy?.webRtc?.value ?? null, levelOfControl: level },
          proxy,
          errors: Array.isArray(policy?.errors) ? policy.errors : [],
          notes,
          seedTargetId,
          seedBounds,
          gridBinding,
          waitedMs: Date.now() - startedAt,
        };
      }

      // 还没找到：叫醒一次（MV3 worker 空转会被停，sw.js 里注册了 tabs.onCreated 监听，建标签页就能把它拉起来）
      // 叫醒用的标签页一律开 about:blank：策略和代理还没核对完，不能先把真实网址（带着 Cookie）加载进去
      if (!woke) {
        woke = true;
        const made = await conn.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true }, "", { timeoutMs: 10_000 })
          .catch(() => null);
        if (made?.targetId) {
          seedTargetId = made.targetId;
          // 叫醒用的标签页就是后面的账号窗口：一开始就摆在工作区中间，别丢在屏幕外或左上角
          seedBounds = await this.#placeOnScreen(handle, seedTargetId, null, pid);
          notes.push("目标列表里没找到我们的插件 worker，建了个 about:blank 标签页把它叫醒（这个标签页就是后面的账号窗口）");
          deadline = Date.now() + WAKE_GRACE_MS;
        } else {
          notes.push("想建个标签页把插件 worker 叫醒，浏览器没给 targetId");
        }
      }

      if (Date.now() >= deadline) break;
      await sleep(300);
    }

    throw codedError(
      "EXTENSION_NOT_READY",
      `账号窗口 ${pid} 的自带插件没生效：叫醒之后还是没找到能 ping 通的 service worker`
      + `（真实 levelOfControl：${String(lastLevel)}；经过：${notes.join("；") || "一个候选都没看到"}）`,
      { levelOfControl: lastLevel, notes },
    );
  }

  /**
   * 在插件 service worker 的会话上加 Runtime.addBinding，并只监听这个会话的 bindingCalled。
   *
   * 为什么这样安全：
   *   - Runtime.addBinding 是「按会话」的，我们只对 worker 的 sessionId 发，页面会话从头到尾没加；
   *   - 监听也带 sessionId 过滤，就算别的会话发同名事件也不会进 #onGridBinding；
   *   - 解析出来还要再按白名单校验一次（插件那边已经校验过一次，但主程序不能信插件）。
   */
  async #installGridBinding(handle, sessionId) {
    if (!sessionId) return { ok: false, reason: "没有插件会话，绑定加不上" };
    if (handle.gridBinding?.sessionId === sessionId) return handle.gridBinding;
    try { handle.gridBinding?.off?.(); } catch { /* 旧会话已经没了 */ }
    try {
      await handle.conn.send("Runtime.addBinding", { name: GRID_BINDING_NAME }, sessionId, { timeoutMs: 8_000 });
      const off = handle.conn.onEvent("Runtime.bindingCalled", (params, from) => {
        if (from !== sessionId) return;                        // 只认本账号插件 worker 的会话
        if (params?.name !== GRID_BINDING_NAME) return;        // 只认我们那个 binding 名
        this.#onGridBinding(handle.id, params?.payload);
      }, sessionId);
      handle.gridBinding = { ok: true, sessionId, off };
      log(`账号窗口 ${handle.id} 已给插件 worker 加上格子动作 binding（只加在 worker 会话上）`);
      return handle.gridBinding;
    } catch (error) {
      handle.gridBinding = { ok: false, sessionId, error: error.message };
      log(`账号窗口 ${handle.id} 的格子动作 binding 没加上（不影响开窗，但左下角按钮会没反应）：${error.message}`);
      return handle.gridBinding;
    }
  }

  /** 插件按钮发来的动作：解析 JSON → 再按白名单校验 → 只作用于发消息的那个账号 */
  #onGridBinding(pid, payload) {
    let parsed;
    try {
      parsed = JSON.parse(String(payload ?? ""));
    } catch {
      log(`账号窗口 ${pid} 发来的格子动作不是合法 JSON，丢弃`);
      return;
    }
    const action = typeof parsed?.action === "string" ? parsed.action : "";
    const meta = {
      tab: typeof parsed?.tab === "string" ? parsed.tab : "",
      requestId: typeof parsed?.requestId === "string" ? parsed.requestId : "",
    };
    this.dispatchGridAction(pid, action, meta);
  }

  /** 白名单动作分派（拆出来给自测直接调）：只作用于发消息的那个账号 */
  dispatchGridAction(pid, action, meta = {}) {
    if (!isGridActionAllowed(action)) {
      log(`账号窗口 ${pid} 发来的格子动作「${action}」不在白名单里，丢弃`);
      return;
    }
    if (action === "show-settings") {
      if (!this.showSettings) {
        log(`账号窗口 ${pid} 要求打开设置，但主程序没接 showSettings`);
        return;
      }
      // 跳转目标白名单（与 sw.js 同一张表）：不是这几个值一律按 settings
      const tab = SETTINGS_TABS.has(meta?.tab) ? meta.tab : "settings";
      try {
        Promise.resolve(this.showSettings(tab)).catch((error) => log(`账号窗口 ${pid} 打开设置失败：${error.message}`));
      } catch (error) {
        log(`账号窗口 ${pid} 打开设置失败：${error.message}`);
      }
      return;
    }
    if (action === "tunnel-connect") {
      if (!this.tunnelConnect) {
        log(`账号窗口 ${pid} 要求打通隧道，但主程序没接 tunnelConnect`);
        return;
      }
      const work = this.tunnelConnect();
      Promise.resolve(work).catch((error) => log(`账号窗口 ${pid} 执行「打通隧道」失败：${error.message}`));
      return;
    }
    if (action === "owner-key-new") {
      const work = this.#handleOwnerKeyNew(pid, meta?.requestId || "");
      work.catch((error) => log(`账号窗口 ${pid} 生成口令失败：${error.message}`));
      return;
    }
    if (action === "pay-order:D" || action === "pay-order:M" || action === "pay-order:Y") {
      const work = this.#handlePayOrder(pid, action.slice("pay-order:".length), meta?.requestId || "");
      work.catch((error) => log(`账号窗口 ${pid} 发起支付失败：${error.message}`));
      return;
    }
    if (action === "tool-tier:basic" || action === "tool-tier:full") {
      if (!this.setToolTier) {
        log(`账号窗口 ${pid} 要切工具档位，但主程序没接 setToolTier`);
        return;
      }
      const tier = action === "tool-tier:full" ? "full" : "basic";
      const work = this.setToolTier(tier);
      Promise.resolve(work).catch((error) => log(`账号窗口 ${pid} 切工具档位失败：${error.message}`));
      return;
    }
    if (action === "onboarding-done") {
      if (!this.setOnboardingDone) {
        log(`账号窗口 ${pid} 要记引导完成，但主程序没接 setOnboardingDone`);
        return;
      }
      const work = this.setOnboardingDone();
      Promise.resolve(work).catch((error) => log(`账号窗口 ${pid} 记引导完成失败：${error.message}`));
      return;
    }
    if (action === "onboarding-open") {
      // 人点的：在它自己的格子里开一个前台标签页显示引导页
      const work = this.openOnboardingTab(pid, { foreground: true });
      work.catch((error) => log(`账号窗口 ${pid} 打开初次设置失败：${error.message}`));
      return;
    }
    const gridOpen = /^grid-open:(\d{1,4})$/.exec(action);
    if (gridOpen) {
      const slot = Number(gridOpen[1]);
      const work = this.openGrid ? this.openGrid(slot) : this.#openGridBySlot(slot);
      Promise.resolve(work).catch((error) => log(`账号窗口 ${pid} 执行格子动作「${action}」失败：${error.message}`));
      return;
    }
    const spaceFocus = /^space-focus:(.+)$/.exec(action);
    if (spaceFocus) {
      const work = this.focusSpace(pid, spaceFocus[1]);
      Promise.resolve(work).catch((error) => log(`账号窗口 ${pid} 执行空间动作「${action}」失败：${error.message}`));
      return;
    }
    const extInstalled = /^ext-installed:([a-p]{32})$/.exec(action);
    if (extInstalled) {
      const work = this.#onExtInstalled(pid, extInstalled[1]);
      work.catch((error) => log(`账号窗口 ${pid} 处理插件事件「${action}」失败：${error.message}`));
      return;
    }
    const extShare = /^ext-share:([a-p]{32})$/.exec(action);
    if (extShare) {
      const work = this.shareExtension(pid, extShare[1]);
      work.catch((error) => log(`账号窗口 ${pid} 执行插件动作「${action}」失败：${error.message}`));
      return;
    }
    const extUnshare = /^ext-unshare:([a-p]{32})$/.exec(action);
    if (extUnshare) {
      const work = this.unshareExtension(pid, extUnshare[1]);
      work.catch((error) => log(`账号窗口 ${pid} 执行插件动作「${action}」失败：${error.message}`));
      return;
    }
    const extAutosync = /^ext-autosync:(on|off)$/.exec(action);
    if (extAutosync) {
      const work = this.#setExtAutoSync(extAutosync[1] === "on");
      work.catch((error) => log(`账号窗口 ${pid} 执行插件动作「${action}」失败：${error.message}`));
      return;
    }
    const work = action === "hide-self"
      ? this.hide(pid)
      : this.applyLayout(pid, action.slice("layout:".length));
    work.catch((error) => log(`账号窗口 ${pid} 执行格子动作「${action}」失败：${error.message}`));
  }

  /**
   * 没注入 openGrid 时的兜底（真机由 browser-profiles 注入，它会同步 open 登记表）：
   * 先找已开的格子（按当前编号或收起前的编号），找不到再按名字「格子 N」打开账号。
   */
  async #openGridBySlot(slot) {
    const entry = this.entries().find((item) => item.slot === slot)
      || this.entries().find((item) => item.lastSlot === slot);
    if (entry) return this.show(entry.id);
    const profile = (this.listProfiles() || []).find((item) => item.name === `格子 ${slot}`);
    if (!profile?.id) throw codedError("INVALID_ARGUMENT", `没有编号为 ${slot} 的格子`);
    return this.open(profile.id, { profile });
  }

  /* ---------------- 初次设置引导（onboarding） ---------------- */

  /**
   * 在这个格子的浏览器窗口里开一个引导页标签页（chrome-extension://<扩展id>/onboarding.html）。
   * foreground 给真：这是人主动要看的（第一次启动 / 侧边栏「重新打开初次设置」），可以切前台；
   * AI 的控制路径到不了这里（不在任何 MCP 工具里）。
   */
  async openOnboardingTab(id, { foreground = false } = {}) {
    const pid = String(id);
    const entry = this.#requireEntry(pid);
    const extensionId = entry?.policy?.extensionId;
    if (!extensionId) {
      throw codedError("EXTENSION_NOT_READY", `格子 ${pid} 的插件没记下扩展 id，打不开初次设置引导页`);
    }
    const url = `chrome-extension://${extensionId}/onboarding.html`;
    const created = await entry.handle.conn.send(
      "Target.createTarget",
      { url, newWindow: false, background: !foreground },
      "",
      { timeoutMs: 15_000 },
    );
    if (!created?.targetId) {
      throw codedError("TARGET_CLOSED", `格子 ${pid} 开初次设置引导页时浏览器没给 targetId`);
    }
    log(`账号窗口 ${pid} 打开了初次设置引导页（${url}）`);
    return { id: pid, url, targetId: created.targetId, foreground };
  }

  /**
   * 把「生成口令」的结果（明文或错误）经插件 worker 送回发起请求的引导页（只这一次）。
   * 口令不进面板状态、不写日志：这段表达式只存在于本次 CDP 调用里。
   */
  async #deliverOwnerKey(entry, requestId, payload) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return { delivered: false, reason: "插件会话不在" };
    const result = await this.#evaluate(
      entry.handle.conn,
      sessionId,
      `globalThis.__windrise && typeof __windrise.deliverOwnerKey === "function" ? __windrise.deliverOwnerKey(${JSON.stringify({ requestId, ...payload })}) : null`,
      { awaitPromise: true },
    );
    return { delivered: true, result };
  }

  /**
   * owner-key-new：一分钟最多生成一把；生成在 main.cjs 注入的 generateOwnerKey 里做，
   * 明文只经 #deliverOwnerKey 送回引导页那一次。这里不打印口令本身。
   */
  async #handleOwnerKeyNew(pid, requestId) {
    const entry = this.entriesMap.get(String(pid));
    if (!entry) return;
    const now = Date.now();
    if (this.ownerKeyLastAt && now - this.ownerKeyLastAt < OWNER_KEY_MIN_INTERVAL_MS) {
      await this.#deliverOwnerKey(entry, requestId, { error: "一分钟最多生成一次口令，请稍候再试" });
      return;
    }
    if (typeof this.generateOwnerKey !== "function") {
      await this.#deliverOwnerKey(entry, requestId, { error: "主程序没接口令生成" });
      return;
    }
    let result;
    try {
      result = await this.generateOwnerKey();
    } catch (error) {
      await this.#deliverOwnerKey(entry, requestId, { error: error?.message || "生成口令失败" });
      return;
    }
    this.ownerKeyLastAt = Date.now();
    if (!result?.ok || typeof result?.key !== "string" || !result.key) {
      await this.#deliverOwnerKey(entry, requestId, { error: result?.error || "口令没有生成" });
      return;
    }
    await this.#deliverOwnerKey(entry, requestId, { key: result.key });
  }

  /**
   * 把下单 / 支付状态经插件 worker 推回发起这一单的引导页。
   * 二维码和订单号只走这一条路，不进面板状态、不写日志。
   */
  async #deliverPayOrder(entry, requestId, payload) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return { delivered: false, reason: "插件会话不在" };
    const result = await this.#evaluate(
      entry.handle.conn,
      sessionId,
      `globalThis.__windrise && typeof __windrise.deliverPayOrder === "function" ? __windrise.deliverPayOrder(${JSON.stringify({ requestId, ...payload })}) : null`,
      { awaitPromise: true },
    );
    return { delivered: true, result };
  }

  /**
   * 引导页「购买」：kind 由白名单 pay-order:D|M|Y 限定；下单和轮询由主程序注入的 payOrder 做，
   * 这里只负责按 requestId 把结果推回发起页面。
   */
  async #handlePayOrder(pid, kind, requestId) {
    const entry = this.entriesMap.get(String(pid));
    if (!entry) return;
    const deliver = (payload) => this.#deliverPayOrder(entry, requestId, payload);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      await deliver({ ok: false, error: "购买请求号不合法" });
      return;
    }
    if (typeof this.payOrder !== "function") {
      await deliver({ ok: false, error: "主程序没接支付接口" });
      return;
    }
    try {
      await this.payOrder(kind, deliver);
    } catch (error) {
      await deliver({ ok: false, error: error?.message || "发起支付失败" });
    }
  }

  /** 在某个会话里跑一段表达式，拿返回值；worker 自己抛错就抛 */
  async #evaluate(conn, sessionId, expression, { awaitPromise = false } = {}) {
    const result = await conn.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      sessionId,
      { timeoutMs: 10_000 },
    );
    const details = result?.exceptionDetails;
    if (details) {
      const text = details.exception?.description || details.exception?.value || details.text || "浏览器没给说明";
      throw new Error(String(text).split("\n")[0]);
    }
    return result?.result?.value;
  }

  /* ---------------- 记账：进程/标签页自己没了 ---------------- */

  /**
   * 挂上「它自己没了」的监听：进程退出、连接断开都算进程没了；标签页被关掉只算窗口没了。
   * 两条路都走 #onProcessGone / #onTabGone，重复通知会被 closing 标记和登记表挡住，只报一次。
   */
  #watch(entry) {
    const { handle, tab } = entry;
    try {
      handle.exited?.then?.((info) => this.#onProcessGone(entry, info)).catch?.(() => {});
    } catch { /* 假 handle 没有 exited 也不影响 */ }
    try {
      handle.conn?.onClose?.((info) => this.#onProcessGone(entry, { code: info?.code || "BROWSER_EXITED", signal: null, message: info?.message }));
    } catch { /* 同上 */ }
    try {
      tab?.once?.("destroyed", () => this.#onTabGone(entry));
    } catch { /* 同上 */ }
  }

  #onProcessGone(entry, info = {}) {
    if (entry.closing) return;
    if (this.entriesMap.get(entry.id) !== entry) return;
    this.entriesMap.delete(entry.id);
    this.orphans.delete(entry.id);
    this.#stopPanelTimerIfIdle();
    const how = info?.signal ? `被信号 ${info.signal} 结束` : `退出码 ${info?.code ?? "未知"}`;
    log(`账号窗口 ${entry.id} 的浏览器进程自己没了（${how}${info?.message ? `，${info.message}` : ""}），注销这个窗口`);
    this.#disposeTabQuietly(entry.tab, entry.id);
    this.onEvent({ kind: "window-closed", id: entry.id, reason: "browser-exited", exit: { code: info?.code ?? null, signal: info?.signal ?? null } });
  }

  #onTabGone(entry) {
    if (entry.closing) return;
    if (this.entriesMap.get(entry.id) !== entry) return;
    this.entriesMap.delete(entry.id);
    // 标签页没了但进程可能还活着：记成孤儿，下次 open 直接复用这个进程，不再起一个抢同一份资料目录
    const alive = this.#handleAlive(entry.handle);
    if (alive) this.orphans.set(entry.id, entry.handle);
    this.#stopPanelTimerIfIdle();
    log(`账号窗口 ${entry.id} 的标签页被关掉了（浏览器进程${alive ? "还在，等下次复用" : "也跟着退了"}），注销这个窗口`);
    this.onEvent({ kind: "window-closed", id: entry.id, reason: "tab-closed" });
  }

  #handleAlive(handle) {
    try {
      return Boolean(handle && typeof handle.isAlive === "function" && handle.isAlive());
    } catch {
      return false;
    }
  }

  #liveOrphan(id) {
    const handle = this.orphans.get(id);
    if (!handle) return null;
    if (this.#handleAlive(handle)) return handle;
    this.orphans.delete(id);
    return null;
  }

  #disposeTabQuietly(tab, id) {
    try {
      const work = tab?.dispose?.();
      if (work && typeof work.catch === "function") work.catch((error) => log(`账号窗口 ${id} 收标签页时出错（忽略）：${error.message}`));
    } catch (error) {
      log(`账号窗口 ${id} 收标签页时出错（忽略）：${error.message}`);
    }
  }

  /** 把一条登记收掉（不关进程），用于「标签页已经没了但登记还在」这种半条命 */
  async #dropEntry(entry, why) {
    entry.closing = true;
    if (this.entriesMap.get(entry.id) === entry) this.entriesMap.delete(entry.id);
    log(`账号窗口 ${entry.id}：${why}`);
    try { await entry.tab?.dispose?.(); } catch { /* 已经没了 */ }
  }

  async #closeHandleQuietly(handle, why) {
    if (!handle) return null;
    log(`${why}（${handle.pid ? `进程 ${handle.pid}` : "没有进程号"}）`);
    try {
      return await this.engineModule.closeBrowser(handle);
    } catch (error) {
      log(`关进程时出错（忽略）：${error.message}`);
      return null;
    }
  }

  /* ---------------- 关窗口 ---------------- */

  /**
   * 同一个账号正在关的时候，open 先在这儿等一下。
   * 只等、不抛：close 自己内部都 catch 过了，关成什么样都记在 close 的返回值里，这里照着往下开。
   */
  async #waitForClosing(pid) {
    const pending = this.closing.get(pid);
    if (!pending) return;
    log(`账号窗口 ${pid} 还在关，等它关完再开（不然同一份资料目录会起两次）`);
    await pending.catch(() => {});
  }

  /**
   * 关一个账号窗口：先注销（上层紧接着 list() 就不会再看到它在跑），再收标签页和进程。
   * 内部 catch 完，调用方 await 不 await 都不会炸。
   * 同一个账号连着关两次只真关一次，第二次拿到的是同一个结果（关进程不能并发来两遍）。
   */
  async close(id) {
    const pid = String(id);
    const running = this.closing.get(pid);
    if (running) return running;

    const work = this.#closeEntry(pid);
    this.closing.set(pid, work);
    try {
      return await work;
    } finally {
      // 只删自己这一条：万一有人接着又开又关，别把新那条误删了
      if (this.closing.get(pid) === work) this.closing.delete(pid);
    }
  }

  async #closeEntry(pid) {
    const entry = this.entriesMap.get(pid);
    if (!entry) {
      // 标签页早就没了、只剩进程：也算关掉
      const orphan = this.orphans.get(pid);
      if (!orphan) return { closed: false, reason: "这个账号窗口没开着" };
      this.orphans.delete(pid);
      const result = await this.#closeHandleQuietly(orphan, `账号窗口 ${pid} 关掉残留的浏览器进程`).catch(() => null);
      this.onEvent({ kind: "window-closed", id: pid, reason: "closed" });
      return { closed: true, how: result?.how ?? null, exit: result?.exit ?? null };
    }

    entry.closing = true;
    this.entriesMap.delete(pid);
    this.orphans.delete(pid);
    this.#stopPanelTimerIfIdle();
    this.#disposeTabQuietly(entry.tab, pid);
    const result = await this.engineModule.closeBrowser(entry.handle).catch((error) => {
      log(`账号窗口 ${pid} 关进程时出错（忽略）：${error.message}`);
      return null;
    });
    log(`账号窗口 ${pid} 关掉了（${result?.how || "没拿到关法"}${result?.exit ? `，退出码 ${result.exit.code}` : ""}）`);
    this.onEvent({ kind: "window-closed", id: pid, reason: "closed" });
    return { closed: true, how: result?.how ?? null, exit: result?.exit ?? null };
  }

  /** 全部关掉（并行，各自 catch；关不掉不影响别人） */
  async closeAll() {
    const ids = [...new Set([...this.entriesMap.keys(), ...this.orphans.keys()])];
    await Promise.all(ids.map((id) => this.close(id).catch((error) => log(`关账号窗口 ${id} 时出错（忽略）：${error.message}`))));
    return { closed: ids.length };
  }

  /** 退出前的收尾：把进程全部收掉（和 closeAll 一样，换个名字给上层叫） */
  async shutdown() {
    return this.closeAll();
  }

  /* ---------------- 导航 / Cookie ---------------- */

  /** 让某个账号窗口导航到指定网址（先过 url-guard：只放行 http/https/about:blank） */
  async navigate(id, url) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry?.tab || entry.tab.isDestroyed()) {
      throw codedError("TARGET_CLOSED", `格子 ${pid} 没有打开：先 browser_open 打开这个格子（id 或格子编号都行），开着的话只会聚焦不会新开`);
    }
    const target = checkSiteUrl(url, { allowBlank: true });
    if (!target) throw codedError("URL_UNKNOWN", "navigate 要给一个网址");
    await entry.tab.loadURL(target);
    return { id: pid, url: target };
  }

  /**
   * 数这个账号窗口的 Cookie（证明「各存各的」）。
   * Storage.getCookies 是浏览器级的命令，一次拿到这个资料目录里所有 Cookie。
   */
  async cookieCount(id) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry) throw codedError("TARGET_CLOSED", `格子 ${pid} 没有打开：先 browser_open 打开这个格子（id 或格子编号都行），开着的话只会聚焦不会新开`);
    const result = await entry.handle.conn.send("Storage.getCookies", {}, "", { timeoutMs: 15_000 });
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    const domains = [...new Set(cookies.map((cookie) => cookie?.domain).filter((domain) => typeof domain === "string" && domain))];
    return { id: pid, count: cookies.length, domains: domains.slice(0, 20) };
  }

  /* ---------------- 空间：同一账号里的任务工作区 ---------------- */

  /** 空间 id：短随机串（去掉容易看混的字符），8 位，理论空间 32^8，够用且好认 */
  #newSpaceId() {
    const crypto = require("node:crypto");
    const bytes = crypto.randomBytes(SPACE_ID_LENGTH);
    let id = "";
    for (let index = 0; index < SPACE_ID_LENGTH; index += 1) {
      id += SPACE_ID_ALPHABET[bytes[index] % SPACE_ID_ALPHABET.length];
    }
    return id;
  }

  /** 空间列表文件的路径（放在该账号资料目录根下，跟着账号走） */
  #spacesFileOf(pid) {
    return path.join(this.userDataDirOf(pid), SPACES_FILE);
  }

  /**
   * 恢复空间：默认空间「我的」总是第一个（就是格子开窗的那个标签页），
   * 后面跟着 windrise-spaces.json 里存下来的 AI 空间名字。
   * 标签页一律不自动恢复：AI 再用时 space_open 按名字重开。
   */
  async #restoreSpaces(entry) {
    const pid = entry.id;
    entry.spaces.set(DEFAULT_SPACE_ID, {
      id: DEFAULT_SPACE_ID,
      name: DEFAULT_SPACE_NAME,
      owner: "human",
      createdAt: Date.now(),
      control: newSpaceControl(),
      tab: entry.tab,
      window: entry.window,
      groupId: null,
      chromeTabId: null,
      keep: false,
      lastAiActivityAt: 0,
      sessionId: null,
      sessionGoneAt: null,
    });
    const file = this.#spacesFileOf(pid);
    let parsed = null;
    try {
      const raw = await fs.promises.readFile(file, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      // 没有文件 / 读坏了都按「还没有空间」处理，不阻断开窗
      return;
    }
    const saved = Array.isArray(parsed?.spaces) ? parsed.spaces : [];
    for (const item of saved) {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const name = typeof item?.name === "string" ? item.name.trim().slice(0, SPACE_NAME_LIMIT) : "";
      const owner = item?.owner === "ai" ? "ai" : "human";
      // 只恢复 AI 空间；默认空间是内建的，磁盘上即使有「human」记录也按内建处理
      if (!id || !name || owner !== "ai" || entry.spaces.has(id)) continue;
      const createdAt = Number(item?.createdAt);
      entry.spaces.set(id, {
        id,
        name,
        owner,
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        control: newSpaceControl(createdAt),
        tab: null,
        window: null,
        groupId: null,
        chromeTabId: null,
        keep: false,
        lastAiActivityAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        sessionId: null,
        sessionGoneAt: null,
      });
    }
    if (saved.length) log(`账号窗口 ${pid} 恢复了 ${Math.max(0, entry.spaces.size - 1)} 个 AI 空间的名字（标签页按需再开）`);
  }

  /**
   * 把 AI 空间列表写进资料目录的 windrise-spaces.json。
   * 只存 id / name / owner / createdAt 四样，绝不写网址、tabId、groupId（那些是运行态）。
   */
  async #saveSpaces(entry) {
    const spaces = [...entry.spaces.values()].filter((space) => space.owner === "ai").map((space) => ({
      id: space.id,
      name: space.name,
      owner: space.owner,
      createdAt: Number(space.createdAt) || Date.now(),
    }));
    const file = this.#spacesFileOf(entry.id);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify({ version: 1, spaces }, null, 2)}\n`, "utf8");
  }

  /** 按 id（优先）或名字找一个空间；找不到抛 SPACE_NOT_FOUND */
  #spaceOf(entry, ref) {
    const text = String(ref ?? "").trim();
    if (!text) throw codedError("INVALID_ARGUMENT", "要给一个空间 id 或名字");
    const direct = entry.spaces.get(text);
    if (direct) return direct;
    const byName = [...entry.spaces.values()].find((space) => space.name === text);
    if (byName) return byName;
    throw codedError("SPACE_NOT_FOUND", `格子 ${entry.id} 没有这个空间：${text.slice(0, 40)}（用 space_list 看有哪些空间）`);
  }

  /** 空间的控制权记录（老记录没有就补一份初始状态） */
  #controlOf(space) {
    if (!space.control || typeof space.control !== "object") {
      space.control = newSpaceControl(space.createdAt);
    }
    return space.control;
  }

  /** space_list / 面板要的精简控制权：不含 before（那份快照可能两万字，不往外吐） */
  #publicControl(space) {
    const control = this.#controlOf(space);
    return {
      state: control.state,
      since: control.since ?? null,
      reason: control.reason ?? "",
      message: control.message ?? "",
      by: control.by ?? null,
    };
  }

  /**
   * 读一个空间的控制权（browser-control 用）。
   * ref 为空按默认空间「我的」处理；control.before 也一并给出，交还时要做变更摘要。
   */
  spaceControl(id, ref) {
    const entry = this.#requireEntry(id);
    const record = this.#spaceOf(entry, String(ref ?? "").trim() || DEFAULT_SPACE_ID);
    return {
      id: record.id,
      name: record.name,
      owner: record.owner,
      control: { ...this.#controlOf(record) },
    };
  }

  /**
   * 写一个空间的控制权（browser-control 已经按 handoff.js 的状态机验过转换，这里只落字段）。
   * 传进来的是完整 control；没给的字段保留旧值。
   */
  setSpaceControl(id, ref, control) {
    const entry = this.#requireEntry(id);
    const record = this.#spaceOf(entry, String(ref ?? "").trim() || DEFAULT_SPACE_ID);
    const current = this.#controlOf(record);
    record.control = { ...current, ...(control && typeof control === "object" ? control : {}) };
    return {
      id: record.id,
      name: record.name,
      owner: record.owner,
      control: { ...record.control },
    };
  }

  /** 空间的主标签页外观还在吗（人关了标签页 / 格子重开后还没重开就是不在） */
  #spaceAlive(space) {
    return Boolean(space?.tab && !space.tab.isDestroyed());
  }

  /** 这个格子的全部空间（默认「我的」在最前，AI 空间按开的时间排） */
  #spacesSorted(entry) {
    return [...entry.spaces.values()].sort((a, b) => {
      if (a.owner !== b.owner) return a.owner === "human" ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  /** 人接管检测用的：开着主标签页的 AI 空间（每个都是独立外观，接管按标签页判） */
  spacesOf(id) {
    const entry = this.entriesMap.get(String(id));
    if (!entry) return [];
    return [...entry.spaces.values()]
      .filter((space) => space.owner === "ai" && this.#spaceAlive(space))
      .map((space) => ({ id: space.id, name: space.name, owner: space.owner, wc: space.tab, window: space.window }));
  }

  /** 侧边栏 / MCP space_list 都要的空间清单（含默认空间、控制权状态） */
  listSpaces(id) {
    const entry = this.#requireEntry(id);
    return {
      id: entry.id,
      spaces: this.#spacesSorted(entry).map((space) => ({
        id: space.id,
        name: space.name,
        owner: space.owner,
        tabCount: this.#spaceAlive(space) ? 1 : 0,
        createdAt: space.createdAt ?? null,
        // keep:true 的空间留给用户亲自看，空闲后只卸载不关闭
        keep: space.keep === true,
        control: this.#publicControl(space),
      })),
    };
  }

  /** 侧边栏状态里的空间列表（只给 id、名字、owner、标签页数、标签组编号；「我的」没有标签组是 null） */
  panelSpaces(id) {
    const entry = this.entriesMap.get(String(id));
    if (!entry) return [];
    return this.#spacesSorted(entry).map((space) => {
      const groupId = space.groupId === undefined || space.groupId === null ? null : Number(space.groupId);
      return {
        id: space.id,
        name: space.name,
        owner: space.owner,
        tabCount: this.#spaceAlive(space) ? 1 : 0,
        groupId: Number.isInteger(groupId) && groupId >= 0 ? groupId : null,
        control: this.#publicControl(space),
      };
    });
  }

  /**
   * 空间对应的窗口外观：browser-control 的 windowFor 拿到它，page_* 就作用在那个空间的标签页上。
   * 空间的主标签页没开（格子重开只恢复了名字）时抛 SPACE_CLOSED，让 AI 先 space_open。
   */
  spaceWindow(id, space) {
    const entry = this.#requireEntry(id);
    const record = this.#spaceOf(entry, space);
    if (!this.#spaceAlive(record)) {
      throw codedError(
        "SPACE_CLOSED",
        `空间「${record.name}」现在没有打开的标签页（格子重开后标签页不会自动恢复），先 space_open 重开这个空间再操作`,
      );
    }
    return record.window;
  }

  /**
   * 开一个 AI 空间：在同一个浏览器上下文里建一个后台标签页（不抢前台），
   * 经插件后台放进「AI·名字」的折叠标签组，然后导航到网址（没给就停在 about:blank）。
   *
   * 名字已存在就复用：标签页还开着直接交回；标签页没了（格子重开恢复过名字）就重开一个。
   *
   * CDP targetId ↔ chrome tab id 怎么对上：
   *   Target.createTarget 先让新标签页加载 about:blank#windrise-space-<空间id>，
   *   插件后台 chrome.tabs.query 按这个网址找到 tab id 并分组，把 {tabId, groupId} 还回来；
   *   之后主程序才把标签页导航到真正网址（导航完那个标记网址就没了）。
   *
   * @param {string} id 格子（账号）id
   * @param {{name: string, url?: string, keep?: boolean}} [options]
   *   keep：true = 这个空间留给用户亲自看，空闲后由自动收摊只卸载不关闭；不传表示不改（新空间默认 false）
   */
  async spaceOpen(id, { name, url, keep } = {}) {
    const pid = String(id);
    const entry = this.#requireEntry(pid);
    const wantedName = String(name ?? "").trim().slice(0, SPACE_NAME_LIMIT);
    if (!wantedName) throw codedError("INVALID_ARGUMENT", "space_open 要给空间起个名字");
    if (wantedName === DEFAULT_SPACE_NAME || wantedName === DEFAULT_SPACE_ID) {
      throw codedError("INVALID_ARGUMENT", `「${DEFAULT_SPACE_NAME}」是人在用的空间，AI 不能用这个名字开空间，换个名字`);
    }
    const wantedUrl = url !== undefined && url !== null && String(url).trim() !== "" ? checkSiteUrl(url) : "";

    // 同名复用：开着就交回，没开（只恢复了名字）就走下面的重开
    const existing = [...entry.spaces.values()].find((space) => space.owner === "ai" && space.name === wantedName);
    let record = existing;
    const reused = Boolean(existing);
    // keep 只在调用方明确给了才改：space_open 没带 keep 时不要冲掉之前留给用户看的设置
    if (record && keep !== undefined) record.keep = keep === true;
    if (record) {
      // 开 / 再开一次就是一次 AI 活动：自动收摊从这一刻重新计时
      record.lastAiActivityAt = Date.now();
      record.sessionGoneAt = null;
    }
    if (record && this.#spaceAlive(record)) {
      // 复用但给了网址：主标签页要真的导航过去，返回的 url 必须是导航之后的真实地址。
      // 以前这里直接忽略 url 却回报旧地址，AI 以为换页了其实没有（Notion 实测踩到）。
      const moved = wantedUrl ? await this.#navigateSpaceTab(record.tab, wantedUrl) : { url: record.tab.getURL?.() || "", warning: null };
      await this.#pushPanelState(entry).catch(() => {});
      return {
        id: pid,
        reused: true,
        space: { id: record.id, name: record.name, owner: record.owner, createdAt: record.createdAt, keep: record.keep === true, control: this.#publicControl(record) },
        url: moved.url,
        navigated: Boolean(wantedUrl),
        ...(moved.warning ? { navigationWarning: moved.warning } : {}),
      };
    }
    if (!record) {
      record = {
        id: this.#newSpaceId(),
        name: wantedName,
        owner: "ai",
        createdAt: Date.now(),
        control: newSpaceControl(),
        tab: null,
        window: null,
        groupId: null,
        chromeTabId: null,
        // 自动收摊用的运行态：keep 由 space_open 传入；最后一次 AI 活动；发起它的 MCP 会话
        keep: keep === true,
        lastAiActivityAt: Date.now(),
        sessionId: null,
        sessionGoneAt: null,
      };
      entry.spaces.set(record.id, record);
    }

    try {
      /* 1) 建后台标签页：newWindow:false = 落在这个格子现有的窗口里，background:true = 不抢前台 */
      const created = await entry.handle.conn.send(
        "Target.createTarget",
        { url: `about:blank#windrise-space-${record.id}`, newWindow: false, background: true },
        "",
        { timeoutMs: 15_000 },
      );
      const targetId = created?.targetId;
      if (!targetId) throw codedError("TARGET_CLOSED", `格子 ${pid} 开空间「${record.name}」时浏览器没给 targetId`);

      /* 2) 包成外观（和主标签页同一套 sessionProvider：护栏、登录页禁区都照样生效） */
      const tab = await this.tabModule.createTabFacade({
        targetId,
        sessionProvider: () => this.#sessionFor(entry.handle, targetId, pid),
        label: `账号窗口 ${entry.profile?.name || pid} 空间「${record.name}」`,
      });
      const window = this.tabModule.createWindowFacade(tab);
      record.tab = tab;
      record.window = window;
      // 人把这个标签页关掉：空间记录留着（名字列表还在），主标签页和标签组编号置空
      tab.once("destroyed", () => {
        if (record.tab === tab) {
          record.tab = null;
          record.window = null;
          record.groupId = null;
          record.chromeTabId = null;
        }
      });

      /* 3) 先把空间落盘：从这一刻起空间就算开好了。
       *    导航放在最后，而且要「导航失败不丢空间」—— 以前 loadURL 等不到 load 就抛 CDP_TIMEOUT，
       *    外层 catch 把刚登记的空间删掉，AI 只看到一条超时错误、空间也没了（真机 10-27 踩到）。 */
      await this.#saveSpaces(entry).catch((error) => log(`格子 ${pid} 保存空间列表失败（不影响空间）：${error.message}`));
      await this.#pushPanelState(entry).catch(() => {});

      /* 4) 经插件后台放进「AI·名字」的折叠标签组，换回 {tabId, groupId}（失败不影响空间） */
      await this.#groupSpaceTab(entry, record);

      /* 5) 导航到真正网址（没给网址就停在干净的 about:blank，标记网址不留在地址栏）。
       *    超时/失败只写进返回的 navigationWarning，空间照样交回。 */
      const target = wantedUrl || "about:blank";
      const moved = wantedUrl ? await this.#navigateSpaceTab(tab, target) : { url: tab.getURL?.() || target, warning: null };

      await this.#saveSpaces(entry).catch((error) => log(`格子 ${pid} 保存空间列表失败（不影响空间）：${error.message}`));
      await this.#pushPanelState(entry).catch(() => {});
      log(`账号窗口 ${pid} 开了一个空间「${record.name}」（${record.id}，标签组 ${record.groupId ?? "没建成"}，标签页 ${record.chromeTabId ?? "?"}）`);
      return {
        id: pid,
        reused,
        space: { id: record.id, name: record.name, owner: record.owner, createdAt: record.createdAt, keep: record.keep === true, control: this.#publicControl(record) },
        // 报真实地址：站点可能把目标网址重定向了（维基首页 → /wiki/Wikipedia:首页）
        url: moved.url,
        navigated: Boolean(wantedUrl),
        ...(moved.warning ? { navigationWarning: moved.warning } : {}),
      };
    } catch (error) {
      // 半途失败：清掉这个空间的登记，不留「有记录没标签页」的半条命
      if (record.tab) {
        try { await record.tab.dispose(); } catch { /* 已经没了 */ }
        record.tab = null;
        record.window = null;
      }
      if (!reused) entry.spaces.delete(record.id);
      throw error;
    }
  }

  /**
   * 把空间的主标签页导航到网址，**超时不算开空间失败**。
   *
   * 为什么要单独一层：loadURL 等的是 Page.loadEventFired，最多等 15 秒；广告 / 反爬 / 长轮询页面
   * 常常等不到，于是抛 CDP_TIMEOUT。对 space_open 来说这只是「导航没等到 load」，空间本身已经建好、
   * 标签页也在，把超时原样抛上去会让上层删掉空间，AI 既没有空间也没拿到可用的错误（真机 10-27 踩到）。
   * 所以这里把超时/失败收成一句 navigationWarning：返回里如实告诉 AI「空间开了，页面还在加载」。
   */
  async #navigateSpaceTab(tab, url) {
    try {
      await tab.loadURL(url);
      return { url: tab.getURL?.() || url, warning: null };
    } catch (error) {
      const code = error?.code ?? "NAVIGATION_FAILED";
      const stillThere = tab && !tab.isDestroyed?.();
      log(`空间主标签页导航到 ${url} 失败（空间保留）：${code} ${error?.message ?? error}`);
      return {
        url: (stillThere ? tab.getURL?.() : "") || url,
        warning: `${code}：导航到 ${url} 没有在时限内完成（${error?.message ?? error}）。空间已经开好、标签页也在，页面可能还在加载：稍后用 page_snapshot 看当前状态，或再 browser_navigate 一次`,
      };
    }
  }

  /**
   * 让插件后台把这个标签页放进标签组，并把 chrome tab id 记进空间记录。
   * 插件没连上 / 版本太旧 / 分组失败都不算开空间失败：空间照样能用，只是没有标签组。
   */
  async #groupSpaceTab(entry, record) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) {
      log(`格子 ${entry.id} 空间「${record.name}」没有插件会话，建不了标签组（空间照常开）`);
      return;
    }
    const color = SPACE_COLORS[([...entry.spaces.values()].filter((space) => space.owner === "ai").length - 1) % SPACE_COLORS.length] || "blue";
    const options = { marker: record.id, title: `AI·${record.name}`, color, collapsed: true };
    try {
      const result = await this.#evaluate(
        entry.handle.conn,
        sessionId,
        `globalThis.__windrise && typeof __windrise.groupTabs === "function" ? __windrise.groupTabs(${JSON.stringify(options)}) : null`,
        { awaitPromise: true },
      );
      if (result && typeof result.groupId === "number") {
        record.groupId = result.groupId;
        record.chromeTabId = typeof result.tabId === "number" ? result.tabId : null;
        return;
      }
      log(`格子 ${entry.id} 空间「${record.name}」：插件没给 groupId（${JSON.stringify(result ?? null)}），按没标签组继续`);
    } catch (error) {
      log(`格子 ${entry.id} 空间「${record.name}」建标签组失败（空间照常开，只是没有标签组）：${error.message}`);
    }
  }

  /**
   * 关掉一个空间：关掉它标签组里的全部标签页（含页面上新开出去的那些），删掉记录并落盘。
   * 默认空间「我的」是人的，不能关。
   *
   * 返回 closedTabs：插件报的 removed（标签组里现在实际有几个，含页面自己开出去的新标签页）；
   * 插件没连上 / 没有标签组时，这个空间的主标签页还算一个。AI 侧拿它写「关掉了几个标签页」。
   */
  async spaceClose(id, ref) {
    const pid = String(id);
    const entry = this.#requireEntry(pid);
    const record = this.#spaceOf(entry, ref);
    if (record.owner !== "ai") {
      throw codedError("INVALID_ARGUMENT", `「${record.name}」是人在用的空间，AI 不能关它`);
    }
    const groupId = Number(record.groupId);
    const chromeTabId = Number(record.chromeTabId);
    /** 插件报的真实数量；null = 插件没连上 / 调不通，最后按主标签页估 1 个 */
    let removed = null;
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    // 关标签组里全部标签页（页面自己开出去的新标签页也在这个组里）；插件不在就只收外观
    if (sessionId && ((Number.isInteger(groupId) && groupId >= 0) || (Number.isInteger(chromeTabId) && chromeTabId >= 0))) {
      const options = Number.isInteger(groupId) && groupId >= 0
        ? { groupId, tabIds: Number.isInteger(chromeTabId) && chromeTabId >= 0 ? [chromeTabId] : [] }
        : { tabIds: [chromeTabId] };
      try {
        const result = await this.#evaluate(
          entry.handle.conn,
          sessionId,
          `globalThis.__windrise && typeof __windrise.closeGroupTabs === "function" ? __windrise.closeGroupTabs(${JSON.stringify(options)}) : null`,
          { awaitPromise: true },
        );
        const count = Number(result?.removed);
        if (Number.isFinite(count) && count >= 0) removed = count;
      } catch (error) {
        log(`格子 ${pid} 关空间「${record.name}」的标签组失败（记录照样删）：${error.message}`);
      }
    }
    const tab = record.tab;
    const hadTab = Boolean(tab && !tab.isDestroyed?.());
    const closedTabs = removed === null ? (hadTab ? 1 : 0) : removed;
    record.tab = null;
    record.window = null;
    record.groupId = null;
    record.chromeTabId = null;
    if (tab) await this.#disposeTabQuietly(tab, pid);
    entry.spaces.delete(record.id);
    // 空间没了，它那份钉住清单也顺手清掉（插件没连上就记日志，不影响关空间）
    await this.#pinCall(entry, "pinClear", { space: record.id }).catch((error) => log(`格子 ${pid} 清空间「${record.name}」的钉住失败（空间已经关了）：${error.message}`));
    await this.#saveSpaces(entry).catch((error) => log(`格子 ${pid} 保存空间列表失败（空间已经关了）：${error.message}`));
    await this.#pushPanelState(entry).catch(() => {});
    log(`账号窗口 ${pid} 关掉了空间「${record.name}」（${record.id}，${closedTabs} 个标签页）`);
    return { id: pid, space: record.id, name: record.name, closed: true, closedTabs };
  }

  /**
   * 卸载一个空间里的后台标签页（chrome.tabs.discard，人点回去会自动重新加载）。
   * 只卸载、不关闭、不删记录；「我的」不许碰。
   */
  async spaceDiscard(id, ref) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    if (!entry) return { id: pid, space: String(ref ?? ""), name: "", discarded: 0, tabIds: [] };
    const record = this.#spaceOf(entry, ref);
    if (record.owner !== "ai") {
      throw codedError("INVALID_ARGUMENT", `「${record.name}」是人在用的空间，不能卸载它的标签页`);
    }
    const groupId = Number(record.groupId);
    const chromeTabId = Number(record.chromeTabId);
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    const hasGroup = Number.isInteger(groupId) && groupId >= 0;
    const hasTab = Number.isInteger(chromeTabId) && chromeTabId >= 0;
    if (!sessionId || (!hasGroup && !hasTab)) {
      return { id: pid, space: record.id, name: record.name, discarded: 0, tabIds: [] };
    }
    const options = hasGroup
      ? { groupId, tabIds: hasTab ? [chromeTabId] : [] }
      : { tabIds: [chromeTabId] };
    try {
      const result = await this.#evaluate(
        entry.handle.conn,
        sessionId,
        `globalThis.__windrise && typeof __windrise.discardGroupTabs === "function" ? __windrise.discardGroupTabs(${JSON.stringify(options)}) : null`,
        { awaitPromise: true },
      );
      const discarded = Number(result?.discarded);
      return {
        id: pid,
        space: record.id,
        name: record.name,
        discarded: Number.isFinite(discarded) && discarded >= 0 ? discarded : 0,
        tabIds: Array.isArray(result?.tabIds) ? result.tabIds : [],
      };
    } catch (error) {
      log(`格子 ${pid} 卸载空间「${record.name}」的标签页失败（下一拍再试）：${error.message}`);
      return { id: pid, space: record.id, name: record.name, discarded: 0, tabIds: [] };
    }
  }

  /**
   * AI 在某个空间里动了一次（page_* / 导航 / 钉住 / space_open）：
   * 自动收摊从这一刻重新计时，并记下发起它的 MCP 会话（会话断开满 2 分钟要收摊）。
   * 找不到空间 / 是「我的」时返回 null，不抛 —— 记账不能影响正在做的操作。
   */
  noteSpaceAiActivity(id, ref, { sessionId = null, at = Date.now() } = {}) {
    const entry = this.entriesMap.get(String(id));
    if (!entry) return null;
    let record;
    try {
      record = this.#spaceOf(entry, ref);
    } catch {
      return null;
    }
    if (record.owner !== "ai") return null;
    record.lastAiActivityAt = Number(at) || Date.now();
    record.sessionGoneAt = null;
    if (sessionId) record.sessionId = String(sessionId);
    return { id: record.id, name: record.name };
  }

  /** MCP 会话断了：挂上「断开时间」，2 分钟后由 SpaceReaper 判断。返回影响了几个空间 */
  noteSessionGone(sessionId, at = Date.now()) {
    const sid = String(sessionId ?? "");
    if (!sid) return 0;
    let affected = 0;
    for (const entry of this.entriesMap.values()) {
      for (const space of entry.spaces.values()) {
        if (space.owner !== "ai" || space.sessionId !== sid) continue;
        space.sessionGoneAt = Number(at) || Date.now();
        affected += 1;
      }
    }
    return affected;
  }

  /** 会话回来了：清掉它的「断开时间」（任何一次调用都算回来） */
  clearSessionGone(sessionId) {
    const sid = String(sessionId ?? "");
    if (!sid) return 0;
    let cleared = 0;
    for (const entry of this.entriesMap.values()) {
      for (const space of entry.spaces.values()) {
        if (space.owner !== "ai" || space.sessionId !== sid || !space.sessionGoneAt) continue;
        space.sessionGoneAt = null;
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * 自动收摊要的空间视图（含「我的」，让策略层自己证明它不碰）。
   * 只给判断需要的字段：不暴露网址、标题、页面内容。
   */
  spacesForAutoClose() {
    const rows = [];
    for (const [gridId, entry] of this.entriesMap) {
      for (const space of entry.spaces.values()) {
        rows.push({
          gridId: String(gridId),
          spaceId: space.id,
          name: space.name,
          owner: space.owner,
          keep: space.keep === true,
          tabAlive: this.#spaceAlive(space),
          controlState: this.#controlOf(space).state,
          lastAiActivityAt: Number(space.lastAiActivityAt) || 0,
          sessionGoneAt: Number(space.sessionGoneAt) || 0,
          createdAt: Number(space.createdAt) || 0,
        });
      }
    }
    return rows;
  }

  /**
   * 侧边栏点「切到空间」：人点的，所以可以切前台。
   * 空间标签页还开着就 chrome.tabs.update({active:true}) 切过去；只恢复了名字（标签页没了）就先重开再切。
   */
  async focusSpace(pid, ref) {
    const entry = this.#requireEntry(pid);
    const record = this.#spaceOf(entry, ref);
    if (record.owner !== "ai") {
      // 「我的」就是人正在用的标签页，不用代切
      return { id: entry.id, space: record.id, name: record.name, switched: false, reason: "「我的」是人在用的空间" };
    }
    if (!this.#spaceAlive(record)) {
      const opened = await this.spaceOpen(pid, { name: record.name });
      const space = this.#spaceOf(entry, opened.space.id);
      await this.#activateSpaceTab(entry, space);
      return { id: entry.id, space: space.id, name: space.name, switched: true, reopened: true };
    }
    await this.#activateSpaceTab(entry, record);
    return { id: entry.id, space: record.id, name: record.name, switched: true };
  }

  /** 让插件后台把空间主标签页切到前台（只有人点侧边栏这条路，AI 的控制路径不碰它） */
  async #activateSpaceTab(entry, record) {
    const chromeTabId = Number(record.chromeTabId);
    if (!Number.isInteger(chromeTabId) || chromeTabId < 0) {
      log(`格子 ${entry.id} 空间「${record.name}」没有记 chrome tab id，切不了前台`);
      return;
    }
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) {
      log(`格子 ${entry.id} 空间「${record.name}」没有插件会话，切不了前台`);
      return;
    }
    try {
      await this.#evaluate(
        entry.handle.conn,
        sessionId,
        `globalThis.__windrise && typeof __windrise.focusTab === "function" ? __windrise.focusTab(${JSON.stringify({ tabId: chromeTabId })}) : null`,
        { awaitPromise: true },
      );
    } catch (error) {
      log(`格子 ${entry.id} 空间「${record.name}」切前台失败：${error.message}`);
    }
  }

  /* ---------------- 钉住：像快速访问的常用网页，按空间存 ---------------- */

  /**
   * 经插件会话调钉住接口（唯一数据源是插件后台的 chrome.storage.local）。
   * 插件没连上 / 版本太旧没有这些函数时抛 PIN_UNSUPPORTED。
   * 插件的返回值一律是 {ok, ...} 不抛错（错误码会丢在 CDP 桥里），这里按 code 转回带码的错误。
   */
  async #pinCall(entry, fn, args) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) throw codedError("PIN_UNSUPPORTED", `格子 ${entry.id} 的插件没连上，钉住用不了`);
    const result = await this.#evaluate(
      entry.handle.conn,
      sessionId,
      `globalThis.__windrise && typeof __windrise.${fn} === "function" ? __windrise.${fn}(${JSON.stringify(args)}) : null`,
      { awaitPromise: true },
    );
    if (!result || typeof result !== "object" || result.ok !== true) {
      const code = result && typeof result.code === "string" ? result.code : "PIN_UNSUPPORTED";
      const message = result && typeof result.error === "string" ? result.error : "插件不支持钉住（版本太旧或没连上）";
      throw codedError(code, message);
    }
    return result;
  }

  /** 空间解析：space 可给 id 或名字；不给就是「我的」（home）。找不到抛 SPACE_NOT_FOUND */
  #pinSpaceOf(entry, space) {
    const ref = space === undefined || space === null || String(space).trim() === "" ? DEFAULT_SPACE_ID : space;
    return this.#spaceOf(entry, ref);
  }

  /** 某个空间的钉住清单 */
  async pinList(id, space) {
    const entry = this.#requireEntry(id);
    const record = this.#pinSpaceOf(entry, space);
    const result = await this.#pinCall(entry, "pinList", { space: record.id });
    return { id: entry.id, space: record.id, name: record.name, pins: Array.isArray(result.pins) ? result.pins : [] };
  }

  /** 钉一条（AI 的钉住：by 固定写 "ai"，不信调用方） */
  async pinAdd(id, space, { url, title } = {}) {
    const entry = this.#requireEntry(id);
    const record = this.#pinSpaceOf(entry, space);
    const result = await this.#pinCall(entry, "pinAdd", { space: record.id, url, title, by: "ai" });
    return { id: entry.id, space: record.id, name: record.name, pin: result.pin, pins: Array.isArray(result.pins) ? result.pins : [] };
  }

  /** 取消一条钉住 */
  async pinRemove(id, space, pin) {
    const entry = this.#requireEntry(id);
    const record = this.#pinSpaceOf(entry, space);
    const result = await this.#pinCall(entry, "pinRemove", { space: record.id, pinId: pin });
    return { id: entry.id, space: record.id, name: record.name, removed: result.removed === true, pins: Array.isArray(result.pins) ? result.pins : [] };
  }

  /** 按钉住 id（找不到就按网址）拿一条钉住；pin_open 用它拿网址，找不到抛 PIN_NOT_FOUND */
  async pinGet(id, space, pin) {
    const entry = this.#requireEntry(id);
    const record = this.#pinSpaceOf(entry, space);
    const result = await this.#pinCall(entry, "pinList", { space: record.id });
    const pins = Array.isArray(result.pins) ? result.pins : [];
    const wanted = String(pin ?? "").trim();
    const hit = pins.find((item) => item?.id === wanted) || pins.find((item) => item?.url === wanted);
    if (!hit) {
      throw codedError("PIN_NOT_FOUND", `空间「${record.name}」里没有这个钉住：${wanted.slice(0, 40)}（用 pin_list 看有哪些）`);
    }
    return { id: entry.id, space: record.id, name: record.name, pin: hit };
  }

  /* ---------------- 插件装到所有格子（共享插件库） ---------------- */

  /** 「新装的插件自动装到所有格子」现在是不是开着的（没注入读法就按默认开） */
  #extAutoSyncOn() {
    try {
      return !this.getExtAutoSync || this.getExtAutoSync() !== false;
    } catch {
      return true;
    }
  }

  /** 面板状态里的插件区：只给 id / name / version / enabled，不给任何路径 */
  panelExtensions(id) {
    const entry = this.entriesMap.get(String(id));
    let shared = [];
    try { shared = this.extLib.readSharedExtensions(this.dataHome); } catch { shared = []; }
    return {
      autoSync: this.#extAutoSyncOn(),
      restartNeeded: Boolean(entry?.extRestartNeeded),
      shared: shared.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version,
        enabled: item.enabled !== false,
      })),
    };
  }

  /**
   * 插件后台报告「这个格子里商店装了（或升级了）一个新插件」。
   * 自动同步开着（默认开）就拷进共享库并装到其他开着的格子；关着就只在侧边栏里列出来等人点。
   */
  async #onExtInstalled(pid, id) {
    log(`账号窗口 ${pid} 的插件后台报告：商店装了（或升级了）插件 ${id}`);
    if (!this.#extAutoSyncOn()) {
      log("「新装的插件自动装到所有格子」是关的：不自动同步，等人在侧边栏点「装到所有格子」");
      await this.#pushAllPanelStates().catch(() => {});
      return { ok: true, autoSync: false, shared: false };
    }
    return this.shareExtension(pid, id);
  }

  /**
   * 把插件拷进共享库并装到其他开着的格子（同一个 id 已在共享库里 = 商店版升级，覆盖新版本）。
   * 来源格子自己不动：它本来就是商店装的（installType normal）。
   */
  async shareExtension(pid, id) {
    if (!this.extLib.isValidExtensionId(id)) {
      log(`账号窗口 ${pid} 要同步的插件 id 不合法（${String(id).slice(0, 40)}），拒绝`);
      return { ok: false, error: "插件 id 不合法" };
    }
    const userDataDir = this.userDataDirOf(pid);
    const copied = await this.extLib.copyExtensionToShared({
      dataHome: this.dataHome,
      userDataDir,
      id,
      fromProfile: pid,
    });
    if (!copied.ok) {
      log(`账号窗口 ${pid} 把插件 ${id} 复制进共享库失败：${copied.error}`);
      await this.#pushAllPanelStates().catch(() => {});
      return copied;
    }
    const record = copied.record;
    log(`插件「${record.name}」v${record.version}（${record.id}）已进共享库（来自格子 ${pid}${copied.updated ? "，覆盖旧版本" : ""}），开始装到其他开着的格子`);
    for (const entry of this.entries()) {
      if (entry.id === pid) continue;
      await this.#installSharedIntoRunning(entry, record);
    }
    await this.#pushAllPanelStates().catch(() => {});
    return { ok: true, updated: copied.updated, record: { id: record.id, name: record.name, version: record.version, enabled: record.enabled } };
  }

  /**
   * 在运行中的格子里把共享插件装上去（CDP Extensions.loadUnpacked）。
   * 这个格子本来就有商店版（同名同 id）就不动；已经装过共享版（development）先卸再装（等于重新加载）。
   * 浏览器不支持运行中装卸（能力探测失败）或装不上，就把格子标成「重开后生效」，侧边栏提示。
   */
  async #installSharedIntoRunning(entry, record) {
    if (!record?.enabled) return { installed: false, reason: "共享库里这个插件是停用的" };
    const installType = await this.#extensionInstallType(entry, record.id);
    if (installType === "normal") {
      log(`格子 ${entry.id} 本来就有商店版的 ${record.id}，不用再装`);
      return { installed: false, reason: "already-normal" };
    }
    const capable = await this.#extensionsRuntimeCapable(entry);
    if (capable === false) {
      entry.extRestartNeeded = true;
      log(`格子 ${entry.id} 的浏览器不支持运行中装卸插件（没有 Extensions.loadUnpacked），「${record.name}」重开这个格子后生效`);
      return { installed: false, restartNeeded: true };
    }
    if (installType === "development") {
      await entry.handle.conn.send("Extensions.uninstall", { id: record.id }, "", { timeoutMs: 8_000 }).catch(() => {});
    }
    const dir = this.extLib.extensionDirOf(this.dataHome, record.id);
    try {
      await entry.handle.conn.send("Extensions.loadUnpacked", { path: dir }, "", { timeoutMs: 15_000 });
      log(`格子 ${entry.id} 已在运行中装上共享插件「${record.name}」`);
      return { installed: true };
    } catch (error) {
      entry.extRestartNeeded = true;
      log(`格子 ${entry.id} 运行中装「${record.name}」失败（${error.message}），重开这个格子后生效`);
      return { installed: false, restartNeeded: true, error: error.message };
    }
  }

  /**
   * 从共享库移除插件，并卸掉运行中格子里经共享库加载的那一份（development）。
   * 商店原装的那一份（installType normal）一个都不动；卸不掉就提示重开生效。
   */
  async unshareExtension(pid, id) {
    if (!this.extLib.isValidExtensionId(id)) {
      log(`账号窗口 ${pid} 要移除的插件 id 不合法（${String(id).slice(0, 40)}），拒绝`);
      return { ok: false, error: "插件 id 不合法" };
    }
    const removed = await this.extLib.removeSharedExtension(this.dataHome, id);
    if (!removed.removed) {
      log(`从共享库移除插件 ${id} 失败：${removed.error || "没给原因"}`);
      await this.#pushAllPanelStates().catch(() => {});
      return { ok: false, error: removed.error || "共享库里没有这个插件" };
    }
    log(`插件 ${id} 已从共享库移除，开始卸掉运行中格子里经共享库加载的那一份（商店原装的不动）`);
    for (const entry of this.entries()) {
      const installType = await this.#extensionInstallType(entry, id);
      if (installType !== "development") continue;   // 商店装的 / 没装的 / 查不到的都不动
      const capable = await this.#extensionsRuntimeCapable(entry);
      if (capable === false) {
        entry.extRestartNeeded = true;
        log(`格子 ${entry.id} 的浏览器不支持运行中卸插件，「${id}」重开这个格子后生效`);
        continue;
      }
      try {
        await entry.handle.conn.send("Extensions.uninstall", { id }, "", { timeoutMs: 8_000 });
        log(`格子 ${entry.id} 已卸掉共享版插件 ${id}`);
      } catch (error) {
        entry.extRestartNeeded = true;
        log(`格子 ${entry.id} 卸共享版插件 ${id} 失败（${error.message}），重开这个格子后生效`);
      }
    }
    await this.#pushAllPanelStates().catch(() => {});
    return { ok: true, removed: true };
  }

  /** 存「新装的插件自动装到所有格子」（main.cjs 注入 settings 写入口） */
  async #setExtAutoSync(want) {
    const on = Boolean(want);
    if (typeof this.setExtAutoSync !== "function") {
      log("主程序没接「新装的插件自动装到所有格子」的写入口（setExtAutoSync 没注入），开关没存上");
      return { ok: false, error: "主程序没接这个开关" };
    }
    try {
      await this.setExtAutoSync(on);
    } catch (error) {
      log(`存「新装的插件自动装到所有格子」失败：${error.message}`);
      return { ok: false, error: error.message };
    }
    log(`「新装的插件自动装到所有格子」已${on ? "打开" : "关闭"}`);
    await this.#pushAllPanelStates().catch(() => {});
    return { ok: true, autoSync: on };
  }

  /**
   * 问这个格子里某个插件现在是什么安装方式（经插件后台的 chrome.management.get）。
   * normal = 商店装的；development = 经 --load-extension / Extensions.loadUnpacked 装的（共享库来的）。
   * 插件会话不在 / 查不到就返回 null，调用方按「不确定」保守处理。
   */
  async #extensionInstallType(entry, id) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return null;
    try {
      const result = await this.#evaluate(
        entry.handle.conn,
        sessionId,
        `(async()=>{try{const e=await chrome.management.get(${JSON.stringify(id)});return e&&typeof e.installType==="string"?{installType:e.installType,enabled:e.enabled===true}:null}catch(_){return null}})()`,
        { awaitPromise: true },
      );
      return result && typeof result.installType === "string" ? result.installType : null;
    } catch {
      return null;
    }
  }

  /**
   * 这个格子的浏览器支不支持运行中装卸插件（CDP Extensions.loadUnpacked）。
   * 只在第一次要装卸时用一条无害调用探一次：方法不存在就永久记 false，不反复试。
   * 需要启动参数 --enable-unsafe-extension-debugging（browseros-engine 已经带上）。
   */
  async #extensionsRuntimeCapable(entry) {
    if (entry.handle?.extCdpCapable !== undefined) return entry.handle.extCdpCapable;
    let capable = true;
    try {
      await entry.handle.conn.send(
        "Extensions.loadUnpacked",
        { path: path.join(this.dataHome, "__windrise_capability_probe__") },
        "",
        { timeoutMs: 8_000 },
      );
    } catch (error) {
      const text = String(error?.message ?? "");
      // 方法不存在（不支持）才算「不能运行中装」；别的错（比如探测目录不存在）说明方法在，只是目录不合法
      capable = !/Extensions\.loadUnpacked|Unknown method|wasn't found|32601/i.test(text);
    }
    entry.handle.extCdpCapable = capable;
    return capable;
  }

  /** 读这个格子里装的全部插件（经插件后台 chrome.management.getAll；会话不在返回空表） */
  async #managementAll(entry) {
    const sessionId = entry?.policy?.workerSessionId || entry?.handle?.gridBinding?.sessionId || null;
    if (!sessionId) return [];
    try {
      return await this.#evaluate(
        entry.handle.conn,
        sessionId,
        `(async()=>{try{const all=await chrome.management.getAll();return (all||[]).map(e=>({id:typeof e.id==="string"?e.id:"",name:typeof e.name==="string"?e.name:"",version:typeof e.version==="string"?e.version:"",installType:typeof e.installType==="string"?e.installType:null,enabled:e.enabled===true})).filter(e=>e.id&&e.id!==chrome.runtime.id)}catch(_){return []}})()`,
        { awaitPromise: true },
      ) || [];
    } catch {
      return [];
    }
  }

  /** MCP extension_list 用：共享库清单 + 每个开着的格子装了哪些插件（只读） */
  async extensionList() {
    let shared = [];
    try { shared = this.extLib.readSharedExtensions(this.dataHome); } catch { shared = []; }
    const sharedIds = new Set(shared.map((item) => item.id));
    const grids = [];
    for (const entry of this.entries()) {
      const all = await this.#managementAll(entry);
      // 只列商店装的（normal）和共享库加载进来的（按 id 对回共享库）；我们自己、浏览器自带组件一律不列
      const extensions = all
        .filter((ext) => ext.installType === "normal" || sharedIds.has(ext.id))
        .map((ext) => ({
          id: ext.id,
          name: ext.name,
          version: ext.version,
          enabled: ext.enabled,
          installType: ext.installType,
          shared: sharedIds.has(ext.id),
        }));
      grids.push({
        id: entry.id,
        slot: Number.isInteger(entry.slot) && entry.slot > 0 ? entry.slot : null,
        name: String(entry.profile?.name || entry.id),
        running: true,
        extensions,
      });
    }
    return {
      autoSync: this.#extAutoSyncOn(),
      shared: shared.map((item) => ({ id: item.id, name: item.name, version: item.version, enabled: item.enabled !== false })),
      grids,
    };
  }

  /**
   * MCP extension_sync 用：把源格子里用户自己装的商店插件，同步到其他格子。
   *
   * 只写目标格子资料目录里的 `External Extensions/<id>.json`（插件 id + 更新地址），
   * **不复制插件文件、不复制任何数据目录、不改 Preferences**。所以插件里的登录、chrome.storage、
   * cookie 一个都带不过去，格子之间的账号隔离不变。
   * 目标格子下次启动时浏览器自己去 update_url 下载安装；正在运行的格子不强制重启，返回里只提示「重开后生效」。
   *
   * @param {{from: string, to?: string[]|null, ids?: string[]|null}} params
   *   from 源格子（账号 id / 账号名；格子编号已由控制层换成了 id）
   *   to 目标格子，不给就是除源格子外的所有格子
   *   ids 只同步这些插件 id，不给就是源格子里所有商店装的插件
   */
  async extensionSync({ from, to = null, ids = null } = {}) {
    const fromKey = String(from ?? "").trim();
    if (!fromKey) throw codedError("INVALID_ARGUMENT", "extension_sync 要给 from（源格子）");
    const accounts = (typeof this.listProfiles === "function" ? this.listProfiles() : []) || [];
    const findAccount = (key) => {
      const text = String(key ?? "").trim();
      if (!text) return null;
      const lower = text.toLowerCase();
      return accounts.find((item) => item.id === text)
        || accounts.find((item) => String(item.name ?? "") === text)
        || accounts.find((item) => String(item.name ?? "").toLowerCase() === lower)
        || null;
    };

    const source = findAccount(fromKey);
    if (!source) throw codedError("INVALID_ARGUMENT", `没有这个格子：${fromKey}（用 browser_profiles 看有哪些格子）`);
    const sourceDir = this.userDataDirOf(source.id);
    const read = this.extSyncLib.readInstalledExtensions(sourceDir);
    if (!read.ok) throw codedError("EXTENSION_READ_FAILED", read.error);

    const wanted = (Array.isArray(ids) ? ids : []).map((item) => String(item ?? "").trim()).filter(Boolean);
    const badIds = [];
    const notInSource = [];
    let selected = read.extensions;
    if (wanted.length) {
      const wantedSet = new Set();
      for (const id of wanted) {
        if (!this.extSyncLib.isValidExtensionId(id)) {
          badIds.push(id.slice(0, 80));
          continue;
        }
        wantedSet.add(id);
      }
      selected = read.extensions.filter((record) => wantedSet.has(record.id));
      const found = new Set(selected.map((record) => record.id));
      for (const id of wantedSet) if (!found.has(id)) notInSource.push(id);
    }

    const targetIssues = [];
    const targets = [];
    const requested = (Array.isArray(to) ? to : []).map((item) => String(item ?? "").trim()).filter(Boolean);
    if (requested.length) {
      for (const key of requested) {
        const account = findAccount(key);
        if (!account) {
          targetIssues.push({ target: key.slice(0, 80), reason: "没有这个格子" });
          continue;
        }
        if (account.id === source.id) continue;   // 源格子本来就有，不用往自己身上写
        if (targets.some((item) => item.id === account.id)) continue;
        targets.push(account);
      }
    } else {
      for (const account of accounts) {
        if (!account || String(account.id) === source.id) continue;
        targets.push(account);
      }
    }

    const grids = [];
    for (const account of targets) {
      const dir = this.userDataDirOf(account.id);
      const result = this.extSyncLib.syncExtensionsToProfile(dir, selected);
      const open = this.get(account.id);
      const running = Boolean(open);
      if (result.ok) {
        log(`格子 ${account.id} 的插件清单已写：${result.written}/${result.expected} 个（${selected.map((item) => item.id).join("、") || "没有要同步的"}）${running ? "，这个格子开着，重开后生效" : ""}`);
      } else {
        log(`格子 ${account.id} 的插件清单没写全：写了 ${result.written}/${result.expected}${result.error ? `（${result.error}）` : ""}${result.missing.length ? `，缺 ${result.missing.join("、")}` : ""}`);
      }
      grids.push({
        id: account.id,
        name: String(account.name ?? account.id),
        slot: Number.isInteger(open?.slot) && open.slot > 0 ? open.slot : null,
        running,
        // 开着也不强制重启：清单已经落好，重开这个格子时浏览器自己装
        restartHint: running ? "这个格子正在运行：现在不动它，重开这个格子后浏览器会装上新插件" : null,
        expected: result.expected,
        written: result.written,
        missing: result.missing,
        rejected: result.rejected,
        ok: result.ok,
        error: result.error || null,
      });
    }

    return {
      from: {
        id: source.id,
        name: String(source.name ?? source.id),
        running: Boolean(this.get(source.id)),
        extensions: selected.map((record) => ({
          id: record.id,
          name: record.name,
          version: record.version,
          updateUrlSource: record.updateUrlSource,
          enabled: record.enabled,
        })),
      },
      // 源格子的插件清单是浏览器写盘的 Preferences 快照：刚装完插件可能还没落盘
      sourceHint: this.get(source.id)
        ? "源格子正在运行：插件清单读的是它写盘的 Preferences，刚装完插件这里可能还没看到，等几秒或重开源格子再同步。"
        : null,
      grids,
      skipped: read.skipped,
      warnings: read.warnings || [],
      badIds,
      notInSource,
      targetIssues,
      autoInstallOnNextLaunch: true,
      platformNote: this.extSyncLib.PLATFORM_NOTE || null,
      note: "只写了 External Extensions 清单（插件 id + 更新地址），没有复制插件文件、插件登录和任何数据目录；目标格子下次启动时浏览器会自己安装。正在运行的格子不用现在重启，重开那个格子后生效。",
    };
  }

  /* ---------------- 清账号数据 ---------------- */

  /**
   * 关窗 → 等进程退出 → 删资料目录。
   * 目录删不掉会抛错（那是真的没删掉，不能假装成功）。
   */
  async purge(id) {
    const pid = String(id);
    const entry = this.entriesMap.get(pid);
    const handle = entry?.handle || this.orphans.get(pid) || null;
    await this.close(pid).catch((error) => log(`清账号 ${pid} 前关窗口出错（继续删目录）：${error.message}`));
    if (handle?.exited) {
      // closeBrowser 已经等过一次退出；这里再兜一下，别在进程还占着文件的时候去删目录
      await Promise.race([handle.exited.catch(() => null), sleep(8_000)]);
    }
    const dir = this.userDataDirOf(pid);
    await fs.promises.rm(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw codedError("FORBIDDEN_PROFILE_DIR", `账号 ${pid} 的资料目录还在，没删掉：${dir}`);
    return { id: pid, removed: true, dir };
  }
}

module.exports = {
  BrowserOsProfiles,
  AccountSurface,
  LEAVING_COMMANDS,
  DEFAULT_WEBRTC_POLICY,
  OFFSCREEN_BOUNDS,
  FALLBACK_WORK_AREA,
  GRID_BINDING_NAME,
  GRID_ACTIONS,
  SETTINGS_TABS,
  OWNER_KEY_MIN_INTERVAL_MS,
  SPACE_FOCUS_PATTERN,
  EXT_SHARE_PATTERN,
  EXT_UNSHARE_PATTERN,
  EXT_INSTALLED_PATTERN,
  EXT_AUTOSYNC_PATTERN,
  isGridActionAllowed,
  PANEL_PUSH_INTERVAL_MS,
  SPACES_FILE,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  copyBookmarksBetweenProfiles,
  refreshExtensionWorkerCache,
  expandByInsets,
  extensionFingerprint,
  isPathInside,
};
