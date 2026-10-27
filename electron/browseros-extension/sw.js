/**
 * Windrise 自带插件的后台（MV3 service worker）。
 *
 * 它只干这几件事：报身份、设 WebRTC 策略并回报真实状态、读回代理设置、把两个标签页并排放好、
 * 报当前哪个窗口拿到 / 失去系统焦点（主进程靠它判断「人是不是坐到账号窗口前面了」）、
 * 把页面左下角按钮 / 侧边栏 / 新标签页的格子动作转给主程序（Runtime.addBinding 加的全局函数）、
 * 把主程序推来的只读状态写进 chrome.storage.session（侧边栏和新标签页读它）、
 * 监听 chrome.management 把「这个格子里新装了商店插件」报给主程序（插件装到所有格子）、
 * 一上来就试着停用 BrowserOS 自带的 AI（Chat / Assistant，hideBundledAi；组件插件可能停不掉，失败只记）。
 * 控制端（electron/browseros-engine.cjs、browseros-profiles.cjs）**不跟它打电话**：
 * 不开端口、不用 native messaging、不设 externally_connectable。
 * 控制端在调试接口（CDP 管道）里找到这个 worker 的目标，直接 Runtime.evaluate 调下面这个
 * globalThis.__windrise 对象 —— 这是唯一通道。
 *
 * 三条硬规矩：
 *   1. 不联网、不上报、不读页面内容。整份代码里没有 fetch / XMLHttpRequest / WebSocket。
 *      这一版多了一个 content script，但它只在页面左下角放自己的按钮，不读页面 DOM 内容。
 *   2. 只报「真的」：set 之后一定再 get 一次，把浏览器真正认的 value 和 levelOfControl 带回去；
 *      设不上就写进 errors，绝不假装成功。
 *   3. 不留常驻资源：没有端口、没有定时器、没有 alarms。
 *
 * 与契约对应：docs/research/browseros-engine-contract-2026-10-24.md §3。
 *
 * 注意：MV3 的 worker 空转 30 秒左右会被浏览器停掉；被停掉之后再被叫醒（比如控制端 attach 上去）时，
 * 整份脚本会重跑，__windrise 跟着重新挂上。所以它必须是**顶层同步赋值**，不能等某个事件才挂。
 */

"use strict";

/**
 * 钉住（Pin）的共享模块：校验和 chrome.storage.local 包装都在 pins.js 里，
 * sw.js 和侧边栏引的是同一份，两边校验一个样。importScripts 是同步的，
 * 加载完 globalThis.__windrisePins 就有了。
 */
try {
  importScripts("pins.js");
} catch (error) {
  // 老资料目录里可能只有旧的 sw.js 缓存、没有 pins.js：钉住功能不可用，但别把整个 worker 带走
  globalThis.__windrisePins = null;
}

/** 契约版本：控制端拿它判断插件是不是这一版 */
const VERSION = "1";

/** 默认 WebRTC 策略：不许非代理的 UDP 直接出去 */
const DEFAULT_WEBRTC_POLICY = "disable_non_proxied_udp";

/** 浏览器自带分屏那个调用的名字，原样当返回值用，别让上层靠猜 */
const SPLIT_API = "chrome.tabs.create(splitWithTabId)";

/**
 * 页面左下角按钮 / 侧边栏 / 新标签页能发来的动作：静态白名单 + grid-open:<编号> + space-focus:<空间id>。
 * 别的（拼写变体、注入的脚本、旧版本）一律不转发。
 * 主程序收到 binding 后还会再校验一次，两边都不信对方。
 */
const GRID_ACTIONS = new Set([
  "layout:1x1", "layout:1x2", "layout:2x2", "layout:3x3", "hide-self", "show-settings",
  // 初次设置引导页（onboarding.html）的动作：主程序一侧还有同一张白名单，两边都不信对方
  "tunnel-connect", "owner-key-new", "tool-tier:basic", "tool-tier:full", "onboarding-done", "onboarding-open",
  // 引导页「购买」：支付宝下单只有这三个档位；请求号复用 owner-key 的短随机串规则
  "pay-order:D", "pay-order:M", "pay-order:Y",
]);
const GRID_OPEN_PATTERN = /^grid-open:[1-9]\d{0,3}$/;
/**
 * show-settings 可以带一个「跳到设置窗口的哪一页」：只有这几个值，别的按 settings。
 * 主程序再校验一次（SETTINGS_TABS 同名单），两边都不信对方。
 */
const SHOW_SETTINGS_TABS = new Set(["settings", "account", "bridge", "context", "choose-connection"]);
/** owner-key-new 的请求号形状：页面随机生成的短串，只放行安全字符 */
const OWNER_KEY_REQUEST_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** 点侧边栏空间列表：切到那个空间的主标签页。空间 id 是短随机串，只放行安全的字符 */
const SPACE_FOCUS_PATTERN = /^space-focus:[A-Za-z0-9_-]{1,32}$/;
/**
 * 插件装到所有格子：插件 id 只收 32 位小写 a~p（Chrome 插件 id 格式）。
 * ext-share / ext-unshare / ext-autosync 是侧边栏发来的；ext-installed 是这里监听到商店装了新插件后报给主程序的。
 */
const EXT_ID_PATTERN = /^[a-p]{32}$/;
const EXT_SHARE_PATTERN = /^ext-share:[a-p]{32}$/;
const EXT_UNSHARE_PATTERN = /^ext-unshare:[a-p]{32}$/;
const EXT_INSTALLED_PATTERN = /^ext-installed:[a-p]{32}$/;
const EXT_AUTOSYNC_PATTERN = /^ext-autosync:(on|off)$/;

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

/** chrome.storage.session 里存编号和账号名的键 */
const GRID_INFO_KEY = "gridInfo";

/** chrome.storage.session 里存侧边栏 / 新标签页状态（只读、不含口令）的键 */
const PANEL_STATE_KEY = "panelState";

/**
 * content script 默认读不到 chrome.storage.session（只有扩展自己的页面能读）。
 * 页面左下角按钮要显示「格子 N」，所以放开给不受信任的上下文；只放开 session，不碰 local/sync。
 * 放开的也只有这一份编号 + 账号名，没有 Cookie、没有页面内容。
 */
try {
  chrome.storage?.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
} catch {
  /* 老版本没有 setAccessLevel：content script 拿不到就显示“格子”，侧边栏仍然正常 */
}

/**
 * 点工具栏图标直接开侧边栏（不再弹 popup）。
 * 有的构建没有 sidePanel API：别让顶层抛错把整个 worker 带走。
 */
function enableSidePanelOnAction() {
  try {
    const result = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    result?.catch?.((error) => remember(`设置侧边栏行为失败：${why(error)}`));
  } catch (error) {
    remember(`设置侧边栏行为失败：${why(error)}`);
  }
}

/** 最近发生了什么（只在内存里，worker 停了就没了；给控制端排错看，不上报、不落盘） */
const events = [];

/**
 * 窗口焦点：人接管检测的信号源。
 *
 * 为什么只靠 chrome.windows：CDP 发输入不会让窗口变成系统前台，而真实键鼠点进窗口会。
 * 所以「哪个窗口拿到系统焦点」本身就是 CDP 伪造不了的信息。主进程会定时来问 focusState()，
 * 这里只记账，不主动联网、不上报。
 *
 * 字段含义：
 *   ready     —— 这个构建有没有 windows.onFocusChanged（没有就是检测不了，上层要显示「未就绪」）
 *   windowId  —— 最近拿到系统焦点的窗口；null = 所有浏览器窗口都不在前台
 *   focused   —— 那个窗口现在是不是真在前台（用 windows.get 读回来的，不靠猜）
 *   seq       —— 焦点事件序号，每次变化 +1（主进程拿它判断有没有新事件）
 */
const focus = {
  ready: typeof chrome.windows?.onFocusChanged?.addListener === "function",
  windowId: null,
  focused: false,
  at: 0,
  seq: 0,
  error: null,
};

/** 最近的焦点事件（最多留 20 条；主进程想看就 evaluate 一下 __windrise.focusState().events） */
const focusEvents = [];

/** 记一次焦点变化。windowId 传 null 表示「浏览器整体不在前台」 */
function recordFocus(windowId, focused, why) {
  const id = typeof windowId === "number" && windowId >= 0 ? windowId : null;
  focus.windowId = id;
  focus.focused = Boolean(focused) && id !== null;
  focus.at = Date.now();
  focus.seq += 1;
  focus.error = null;
  try {
    focusEvents.push({ seq: focus.seq, windowId: id, focused: focus.focused, at: focus.at, why: String(why || "") });
    if (focusEvents.length > 20) focusEvents.shift();
  } catch {
    /* 什么都不做 */
  }
  remember(`焦点：${id === null ? "没有窗口在前台" : `窗口 ${id}`}${focus.focused ? "（前台）" : "（不在前台）"} —— ${why || ""}`);
}

/**
 * 问浏览器「最近拿到焦点的是哪个窗口」，并读回它现在到底在不在前台。
 * 启动（包括 worker 被叫醒后重跑）时用一次：onFocusChanged 只报变化，不给初始值。
 * 读不到不算致命：ready 仍然为 true，只是 focused 保持 false（宁可漏判，不乱判）。
 */
async function refreshFocus(why) {
  if (!focus.ready) {
    focus.error = "这个浏览器没有 chrome.windows.onFocusChanged，检测不了系统焦点";
    return { ...focus, events: focusEvents.slice(-8) };
  }
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win || typeof win.id !== "number") {
      recordFocus(null, false, `${why || "查前台"}：没有窗口`);
    } else {
      recordFocus(win.id, Boolean(win.focused), why || "查前台");
    }
  } catch (error) {
    // 常见原因：一个窗口都没开（getLastFocused 会拒绝）。这不等于检测坏了，
    // 但读不到就按「没有前台窗口」处理（宁可漏判），别把上一次的旧值当成现在的
    focus.windowId = null;
    focus.focused = false;
    focus.error = `读前台窗口失败：${error?.message || String(error)}`;
    remember(`读前台窗口失败：${error?.message || String(error)}`);
  }
  return { ...focus, events: focusEvents.slice(-8) };
}

/** 读当前前台窗口里正在看的那个标签页（可选信息；主进程用它核对「是不是我们管的那个标签页」） */
async function activeTabOf(windowId) {
  if (windowId === null || windowId === undefined) return null;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    const tab = Array.isArray(tabs) ? tabs[0] : null;
    if (!tab) return null;
    return {
      id: typeof tab.id === "number" ? tab.id : null,
      url: typeof tab.url === "string" ? tab.url : null,
      title: typeof tab.title === "string" ? tab.title : null,
    };
  } catch {
    // 没有 tabs 权限、或者窗口刚关掉：拿不到就算了，主进程按窗口号判断
    return null;
  }
}

/** 记一条（时间都拿不到就只丢日志，不影响主流程） */
function remember(text) {
  try {
    events.push(`${new Date().toISOString()} ${text}`);
    if (events.length > 40) events.shift();
  } catch {
    /* 什么都不做 */
  }
}

/** 把浏览器抛出来的东西变成一句中文，别把 [object Object] 交给上层 */
function why(error) {
  if (!error) return "没有说明";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/* 顶层挂一次；后面 onInstalled 里再挂一次，确保装好后立刻生效 */
enableSidePanelOnAction();
try { chrome.runtime?.onStartup?.addListener?.(enableSidePanelOnAction); } catch { /* 老版本没有 onStartup */ }

/* ---------------- 读真实状态 ---------------- */

/**
 * 读 WebRTC 现在到底是什么。
 * 只读「regular」（普通窗口）那一份，和我们 set 时用的 scope 对齐。
 */
async function readWebRtc() {
  const got = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
  return {
    value: got && got.value !== undefined ? got.value : null,
    levelOfControl: (got && got.levelOfControl) || "unknown",
  };
}

/**
 * 读代理设置。
 *
 * **实测事实（2026-10-24，本机 BrowserOS 155.0.8309.26，见 _probe/browseros-extension-check.mjs）**：
 * 启动时带 `--proxy-server=http://127.0.0.1:<端口>`，这里读到的是
 * `mode: "fixed_servers"` + `rules.singleProxy{host, port}`，和命令行给的一模一样；
 * 不带命令行代理时读到 `mode: "system"`。两趟的 levelOfControl 都是 `controllable_by_this_extension`。
 * 也就是说**这份浏览器看得见命令行代理**（引擎契约 §3 第 2 条原本以为看不见，实测是看得见的）。
 *
 * 但反过来别下结论：「`mode` 是 `system`」不等于「代理没生效」。命令行代理是启动时定死的配置，
 * 不同版本、不同构建展不展示出来不一定；真要证明流量走了代理，得看控制端自己的证据
 * （比如第一个请求的 Network.responseReceived 里 remoteIPAddress）。判断权限归属看 levelOfControl，
 * 不要拿 mode 一个字段当否决票。
 */
async function readProxy() {
  const got = await chrome.proxy.settings.get({ incognito: false });
  const raw = (got && got.value) || {};
  return {
    mode: typeof raw.mode === "string" ? raw.mode : null,
    levelOfControl: (got && got.levelOfControl) || "unknown",
    incognitoSpecific: got && typeof got.incognitoSpecific === "boolean" ? got.incognitoSpecific : null,
    // 原样带回，有 rules / pacScript 就给：上层想自己核对时不用再问一遍
    value: raw,
    note:
      "命令行 --proxy-server 在 BrowserOS 155 上会显示成 fixed_servers + singleProxy；" +
      "读到 system 只说明这份浏览器没把命令行代理显示出来，不代表代理没生效",
  };
}

/* ---------------- 字符串里的代理解析（只为核对，不设代理） ---------------- */

/** "http://1.2.3.4:8080" / "socks5://h:1080" / "h:8080" → {scheme, host, port}；认不出来给 null */
function parseProxyText(text) {
  if (typeof text !== "string") return null;
  const body = text.trim();
  if (!body) return null;
  const withScheme = /^([a-z0-9]+):\/\/(.+)$/i.exec(body);
  const scheme = withScheme ? withScheme[1].toLowerCase() : "http";
  const rest = withScheme ? withScheme[2] : body;
  const hostPort = /^\[?([^\]\/]+?)\]?:(\d{1,5})$/.exec(rest) || /^([^:\/]+?):(\d{1,5})$/.exec(rest);
  if (!hostPort) return null;
  const port = Number(hostPort[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { scheme, host: hostPort[1].toLowerCase(), port };
}

/** 从 chrome.proxy 的 value 里捞单代理（fixed_servers/singleProxy）；不是这个形状给 null */
function singleProxyOf(value) {
  const single = value && value.rules && value.rules.singleProxy;
  if (!single || !single.host || !single.port) return null;
  return { scheme: String(single.scheme || "http").toLowerCase(), host: String(single.host).toLowerCase(), port: Number(single.port) };
}

/**
 * 把「命令行给的代理」和「插件里看到的代理」对一下。
 * 返回 matches 三态，别用一个布尔糊过去：
 *   true  —— 读到了 singleProxy，host/port 和命令行一致；
 *   false —— 读到了 singleProxy，但和命令行对不上（这才是真的「配错了」）；
 *   null  —— 这里压根没读到代理服务器（mode 不是 fixed_servers），属于「没法核对」，
 *            不是「核对不上」；上层别拿这个当「代理没生效」的判决。
 * 对不上**不写进 errors**：命令行代理由启动参数决定，插件这边只是核对。
 */
function compareProxy(expectProxy, proxy) {
  const wanted = parseProxyText(expectProxy);
  const actual = singleProxyOf(proxy && proxy.value);
  const mode = proxy ? proxy.mode : null;
  if (!actual) {
    return {
      matches: null,
      note:
        `命令行 --proxy-server=${String(expectProxy).trim()}，插件这边 chrome.proxy.settings.get 读到 mode=${String(mode)}、` +
        `levelOfControl=${proxy ? proxy.levelOfControl : "unknown"}，里面没有代理服务器，这一趟核对不了。` +
        `本机 155 实测命令行代理是会被读成 fixed_servers 的，所以读到 ${String(mode)} 要么是真没配，要么这份浏览器没展示 —— ` +
        `别直接判定「代理没生效」，代理要另外核对（看控制端第一个请求的 remoteIPAddress）。`,
    };
  }
  const same = Boolean(wanted) && wanted.host === actual.host && wanted.port === actual.port;
  return {
    matches: same,
    note: same
      ? `插件里看到的代理和命令行一致：${actual.scheme}://${actual.host}:${actual.port}`
      : `插件里看到的代理是 ${actual.scheme}://${actual.host}:${actual.port}，命令行给的是 ${String(expectProxy)}`,
  };
}

/* ---------------- 对外五件事 ---------------- */

/**
 * 报当前焦点状态（人接管检测用）。
 *
 * 主进程每 300ms 来问一次；这里只把缓存交出去，不主动查浏览器（查一次要几百微秒，没必要每 300ms 查）。
 * activeTab 是给主进程核对「前台窗口里正在看的是不是我们管的那个标签页」用的，拿不到就是 null。
 */
async function focusState() {
  // 还没查过初始值（刚被叫醒、事件也还没来）：补一次，别让主进程一直以为没有窗口在前台
  if (!focus.at && focus.ready) await refreshFocus("第一次问焦点");
  const activeTab = focus.focused ? await activeTabOf(focus.windowId) : null;
  return {
    ready: focus.ready,
    supported: focus.ready,
    windowId: focus.windowId,
    focused: focus.focused,
    at: focus.at,
    seq: focus.seq,
    error: focus.error,
    activeTab,
    events: focusEvents.slice(-8),
  };
}

/** 报身份。控制端拿 id 核对「附上来的确实是我们这个插件」 */
async function ping() {
  const manifest = chrome.runtime.getManifest();
  return {
    version: VERSION,
    id: chrome.runtime.id,
    manifestName: manifest && manifest.name ? manifest.name : "",
    manifestVersion: manifest && manifest.version ? manifest.version : "",
    // 运行时真正生效的权限（写进返回里，比读 manifest 文件更硬）
    permissions: Array.isArray(manifest && manifest.permissions) ? manifest.permissions.slice() : [],
    hostPermissions: Array.isArray(manifest && manifest.host_permissions) ? manifest.host_permissions.slice() : [],
    hasCreateSplit: typeof chrome.tabs.createSplit === "function",
    hasUnsplit: typeof chrome.tabs.unsplit === "function",
  };
}

/**
 * 设 WebRTC 策略，并把真实状态带回去。
 *
 * 顺序是死的：先 set（失败也继续），再 get 读真的。
 * 上层要靠 levelOfControl 判断「本扩展到底管不管得着」：
 *   controlled_by_this_extension —— 就是我们在管，可以开窗口；
 *   controllable_by_this_extension —— 现在没人占，我们设的值还没被采纳（一般意味着 set 没成功）；
 *   not_controllable / controlled_by_other_extensions —— 被别的插件或企业策略接管了，我们说了不算。
 */
async function applyPolicy(options = {}) {
  const wanted =
    typeof options.webRtcPolicy === "string" && options.webRtcPolicy.trim()
      ? options.webRtcPolicy.trim()
      : DEFAULT_WEBRTC_POLICY;
  const errors = [];

  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: wanted, scope: "regular" });
    remember(`WebRTC 策略设成 ${wanted}`);
  } catch (error) {
    // 设不上就是设不上，如实记；后面照样 get 一次，把现在真实的值交出去
    errors.push(`设 WebRTC 策略（${wanted}）失败：${why(error)}`);
    remember(`WebRTC 策略没设上：${why(error)}`);
  }

  let webRtc = { value: null, levelOfControl: "unknown" };
  try {
    webRtc = await readWebRtc();
  } catch (error) {
    errors.push(`读 WebRTC 策略失败：${why(error)}`);
  }

  // 写进去的和读回来的不一致，也要说出来（只有前面没报错时才补这一条，免得同一个毛病记两遍）
  if (!errors.length && webRtc.value !== wanted) {
    errors.push(`WebRTC 策略写的是 ${wanted}，读回来是 ${String(webRtc.value)}（可能被别的插件或策略接管了）`);
  }

  let proxy = null;
  try {
    proxy = await readProxy();
  } catch (error) {
    errors.push(`读代理设置失败：${why(error)}`);
  }

  const expectProxy = options.expectProxy === undefined || options.expectProxy === null ? null : options.expectProxy;
  const compared = expectProxy ? compareProxy(expectProxy, proxy) : null;
  if (compared) remember(compared.note);

  return {
    webRtc: { value: webRtc.value, levelOfControl: webRtc.levelOfControl },
    proxy,
    errors,
    version: VERSION,
    // 下面几项是契约之外的补充，方便上层判断，不改上面的形状
    expectProxy,
    proxyMatchesExpectation: compared ? compared.matches : null,
    proxyNote: compared ? compared.note : null,
    events: events.slice(-8),
  };
}

/** 交个底：现在 WebRTC 是什么、代理是什么、开了几个标签页 */
async function getState() {
  const state = {
    webRtc: { value: null, levelOfControl: "unknown" },
    proxy: null,
    tabs: 0,
    errors: [],
    version: VERSION,
  };
  try {
    state.webRtc = await readWebRtc();
  } catch (error) {
    state.errors.push(`读 WebRTC 策略失败：${why(error)}`);
  }
  try {
    // 本机 155 实测：命令行 --proxy-server 会显示成 fixed_servers；读到 system 只说明这份浏览器没展示它，
    // 不代表代理没生效（详见 readProxy 的注释）
    state.proxy = await readProxy();
  } catch (error) {
    state.errors.push(`读代理设置失败：${why(error)}`);
  }
  try {
    state.tabs = (await chrome.tabs.query({})).length;
  } catch (error) {
    state.errors.push(`数标签页失败：${why(error)}`);
  }
  return state;
}

/**
 * 停用 BrowserOS 自带的 AI（Chat / Assistant 侧边栏，产品计划 2026-10-26「去掉」）。
 *
 * 只对**本格子**的资料目录生效（chrome.management.setEnabled），不删安装目录里的任何文件；
 * 组件类插件可能不允许停用（setEnabled 抛错 / 停完又回来），失败只记不拦，
 * 结果写 chrome.storage.session（键 aiHideResult），主进程 / 侧边栏可读，不影响别的功能。
 * worker 被叫醒整份脚本重跑时会再走一遍：已经停用的会短路跳过（幂等）。
 */
const BUNDLED_AI_IDS = ["bflpfmnmnokmjhmgnolecpppdbdophmk"];

async function hideBundledAi() {
  const results = [];
  if (!chrome.management || typeof chrome.management.setEnabled !== "function") {
    remember("这个构建没有 chrome.management.setEnabled，藏不掉自带 AI（留到自编译时处理）");
    return { ok: false, results, reason: "NO_MANAGEMENT" };
  }
  for (const id of BUNDLED_AI_IDS) {
    try {
      const ext = await chrome.management.get(id).catch(() => null);
      if (!ext) {
        results.push({ id, disabled: false, reason: "没找到这个插件" });
        continue;
      }
      if (ext.enabled === false) {
        results.push({ id, disabled: true, reason: "本来就是停用的" });
        continue;
      }
      try {
        await chrome.management.setEnabled(id, false);
      } catch (error) {
        // 组件插件常见：不让 setEnabled。记下来，留到自编译时处理
        results.push({ id, disabled: false, installType: ext.installType, reason: `浏览器不让停：${why(error)}` });
        remember(`自带 AI 插件 ${id} 停用失败（${why(error)}，组件插件？），留到自编译时处理`);
        continue;
      }
      const after = await chrome.management.get(id).catch(() => null);
      const disabled = !after || after.enabled === false;
      results.push({ id, disabled, installType: ext.installType, reason: disabled ? "已停用" : "停完又回来了" });
      remember(`自带 AI 插件 ${id}${disabled ? "已停用" : "停完又回来了（组件插件），留到自编译时处理"}`);
    } catch (error) {
      results.push({ id, disabled: false, reason: why(error) });
      remember(`停用自带 AI 插件 ${id} 失败：${why(error)}`);
    }
  }
  try { await chrome.storage.session.set({ aiHideResult: results }); } catch { /* 存不上也无所谓 */ }
  return { ok: results.some((r) => r.disabled), results };
}

/** worker 一挂上就试一次：第一次开格子就把自带 AI 停掉 */
try {
  hideBundledAi().catch((error) => remember(`藏自带 AI 失败：${why(error)}`));
} catch {
  /* 老构建没有 management：上面已经记过，这里兜住别把 worker 带走 */
}

/**
 * 把两页并排放进同一个窗口。
 *
 *   1. 先试浏览器自带分屏：chrome.tabs.create({url, splitWithTabId})（Chrome 155 起有，BrowserOS 同源也有）；
 *   2. 调不通，就退回「同一窗口里相邻两个普通标签页」，split 标 "fallback"，不骗上层说分屏成功；
 *   3. 连标签页都建不出来，标 "unsupported"。
 *
 * 全程 active:false：不抢前台、不弹任何界面（没有窗口、没有对话框、没有标签页抢焦点）。
 * 另外：接口没报错也**不等于**真并排了，所以要读回两个标签页的 splitViewId 对一次；
 * 对不上就如实降级 —— 「没报错」不能当成功。
 */
async function openSplit(options = {}) {
  const url = typeof options.url === "string" ? options.url.trim() : "";
  if (!url) throw new Error("openSplit 没给 url，不知道该开哪一页");
  const withUrl =
    typeof options.withUrl === "string" && options.withUrl.trim() ? options.withUrl.trim() : "about:blank";

  const errors = [];

  // 先建底下那一页：分屏要拿它的 tabId 当锚
  const baseTab = await chrome.tabs.create({ url: withUrl, active: false });
  if (!baseTab || typeof baseTab.id !== "number") throw new Error("连第一个标签页都没建出来");

  let secondTab = null;
  let split = "unsupported";

  try {
    secondTab = await chrome.tabs.create({ url, splitWithTabId: baseTab.id, active: false });
    split = SPLIT_API;
    remember(`splitWithTabId 调通了：${baseTab.id} + ${secondTab && secondTab.id}`);
  } catch (error) {
    errors.push(`chrome.tabs.create({splitWithTabId}) 不行：${why(error)}`);
    remember(`splitWithTabId 不行：${why(error)}`);
    try {
      secondTab = await chrome.tabs.create({
        url,
        windowId: baseTab.windowId,
        index: typeof baseTab.index === "number" ? baseTab.index + 1 : undefined,
        active: false,
      });
      split = "fallback";
    } catch (error2) {
      errors.push(`退回「同一窗口相邻两个标签页」也失败：${why(error2)}`);
      remember(`退回相邻标签页也失败：${why(error2)}`);
    }
  }

  if (!secondTab || typeof secondTab.id !== "number") {
    // 一个都没并成：把刚建出来的第一个标签页也收掉，别给用户留一个莫名其妙的空白页
    let closedBase = false;
    try {
      await chrome.tabs.remove(baseTab.id);
      closedBase = true;
      remember(`unsupported：已把建出来的标签页 ${baseTab.id} 关掉`);
    } catch (error) {
      errors.push(`想关掉建出来的第一个标签页也没关成（${baseTab.id}）：${why(error)}`);
    }
    return {
      windowId: typeof baseTab.windowId === "number" ? baseTab.windowId : null,
      // 没并排成功就没有两个标签页可给；关掉了就报 null，别把一个已经没了的 id 交上去
      tabIds: closedBase ? [null, null] : [baseTab.id, null],
      split: "unsupported",
      splitViewIds: null,
      sameWindow: false,
      closedBaseTab: closedBase,
      errors,
      events: events.slice(-8),
    };
  }

  // 读回来核对：真的并排了吗？真的在同一个窗口吗？
  // 注意判据：**没分屏时实测 splitViewId 是 -1**（不是 null、也不是 undefined），
  // 所以「不是 null」根本不够 —— 必须要求 >= 0，否则「接口收下 splitWithTabId 却没真并排」会被当成成功。
  const viewIdOf = (tab) => (tab && typeof tab.splitViewId === "number" ? tab.splitViewId : null);
  const isSplitViewId = (value) => typeof value === "number" && value >= 0;
  let a = baseTab;
  let b = secondTab;
  try {
    [a, b] = await Promise.all([chrome.tabs.get(baseTab.id), chrome.tabs.get(secondTab.id)]);
  } catch (error) {
    errors.push(`回读两个标签页失败：${why(error)}`);
  }
  const splitViewIds = [viewIdOf(a), viewIdOf(b)];
  const reallySplit = isSplitViewId(splitViewIds[0]) && splitViewIds[0] === splitViewIds[1];

  if (split === SPLIT_API && !reallySplit) {
    errors.push(
      `splitWithTabId 没报错，但两个标签页没真的并排（splitViewId 读到 ${JSON.stringify(splitViewIds)}；` +
        `没分屏时是 -1 或没有），按退回处理`,
    );
    split = "fallback";
    remember(`splitWithTabId 没真并排（${JSON.stringify(splitViewIds)}）`);
  }

  const sameWindow = Boolean(a && b && a.windowId === b.windowId);
  if (!sameWindow) errors.push(`两个标签页落在不同窗口（${a ? a.windowId : "?"} / ${b ? b.windowId : "?"}）`);

  return {
    windowId: a && typeof a.windowId === "number" ? a.windowId : null,
    tabIds: [a ? a.id : baseTab.id, b ? b.id : secondTab.id],
    split,
    splitViewIds,
    sameWindow,
    errors,
    events: events.slice(-8),
  };
}

/* ---------------- 空间（标签组）---------------- */

/**
 * 空间的标记网址：主程序新建空间标签页时先让它加载这个网址，
 * 插件后台按网址找到 chrome tab id（CDP 的 targetId 和 chrome tab id 对不上，只能靠网址认）。
 * 空间 id 是短随机串，不会撞上用户自己的网址。
 */
function spaceMarkerUrl(spaceId) {
  return `about:blank#windrise-space-${String(spaceId)}`;
}

/** 标签组颜色轮换：按空间序号挑一个，不挑灰（和没分组的标签页区别开） */
const SPACE_COLORS = ["blue", "green", "yellow", "purple", "cyan", "pink", "orange", "red"];

/**
 * 把一个或多个标签页放进一个标签组（新空间 / 空间里新开的标签页共用）。
 *
 * tabIds 没给时按 marker 找：主程序先把新标签页加载成 about:blank#windrise-space-<id>，
 * 这里用 chrome.tabs.query 按网址找到那个标签页（CDP targetId 到不了 chrome tab id，只能这样对）。
 * 找到的组 id 和 chrome tab id 一起还回去，主程序存起来，以后 space-focus / space_close 都用 chrome tab id。
 *
 * @param {{tabIds?: number[], marker?: string, title?: string, color?: string, collapsed?: boolean}} options
 * @returns {Promise<{tabId: number, groupId: number, title: string, color: string, collapsed: boolean}>}
 */
async function groupTabs(options = {}) {
  let tabIds = Array.isArray(options.tabIds)
    ? options.tabIds.map(Number).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const marker = typeof options.marker === "string" ? options.marker.trim() : "";
  if (!tabIds.length && marker) {
    const wanted = spaceMarkerUrl(marker);
    // 新标签页刚建好时 url 可能还没写上：最多等 3 秒（15 次 × 200ms）
    let hit = null;
    for (let attempt = 0; attempt < 15 && !hit; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({});
      } catch (error) {
        throw new Error(`groupTabs 按网址找标签页失败：${why(error)}`);
      }
      hit = tabs.find((tab) => tab && (tab.url === wanted || tab.pendingUrl === wanted)) || null;
    }
    if (!hit || typeof hit.id !== "number") {
      throw new Error(`groupTabs 没有找到加载 ${wanted} 的标签页（可能还没加载出来，稍后重试）`);
    }
    tabIds = [hit.id];
  }
  if (!tabIds.length) throw new Error("groupTabs 没给 tabIds，也没有 marker，不知道分组哪些标签页");

  if (typeof chrome.tabs.group !== "function") throw new Error("这个浏览器没有 chrome.tabs.group，建不了标签组");
  const groupId = await chrome.tabs.group({ tabIds });
  if (typeof groupId !== "number" || groupId < 0) throw new Error(`chrome.tabs.group 没给 groupId（${String(groupId)}）`);

  const title = typeof options.title === "string" ? options.title.trim().slice(0, 40) : "";
  const color = SPACE_COLORS.includes(options.color) ? options.color : "blue";
  const collapsed = options.collapsed !== false;
  let updated = null;
  try {
    updated = await chrome.tabGroups.update(groupId, { title, color, collapsed });
  } catch (error) {
    throw new Error(`标签组 ${groupId} 建好了，但改标题 / 颜色 / 折叠失败：${why(error)}`);
  }
  remember(`把标签页 ${tabIds.join(",")} 放进标签组 ${groupId}（${title || "没起名字"}）`);
  return {
    tabId: tabIds[0],
    groupId,
    title: typeof updated?.title === "string" ? updated.title : title,
    color: typeof updated?.color === "string" ? updated.color : color,
    collapsed: updated?.collapsed === true,
  };
}

/**
 * 关掉某个空间的全部标签页：groupId 有值就按标签组找，另外还给的 tabIds 也一起收。
 * 主程序空间记录里存的 chrome tab id 可能已经过期，所以这里以「现在查询到的」为准。
 * @param {{groupId?: number, tabIds?: number[]}} options
 * @returns {Promise<{removed: number, tabIds: number[]}>}
 */
async function closeGroupTabs(options = {}) {
  const groupId = Number(options.groupId);
  const wantGroup = Number.isInteger(groupId) && groupId >= 0;
  const ids = new Set(
    Array.isArray(options.tabIds) ? options.tabIds.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : [],
  );
  if (!wantGroup && !ids.size) return { removed: 0, tabIds: [] };
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    throw new Error(`closeGroupTabs 读标签页失败：${why(error)}`);
  }
  for (const tab of tabs) {
    if (wantGroup && tab && tab.groupId === groupId && typeof tab.id === "number") ids.add(tab.id);
  }
  const list = [...ids].filter((value) => Number.isInteger(value) && value >= 0);
  if (!list.length) return { removed: 0, tabIds: [] };
  await chrome.tabs.remove(list);
  remember(`关掉了空间标签页 ${list.join(",")}`);
  return { removed: list.length, tabIds: list };
}

/**
 * 卸载某个空间里的后台标签页（chrome.tabs.discard）：只从内存里拿掉，不关闭，人点回去浏览器会自动重载。
 * 前台（active）标签页和已经卸载过的跳过；「我的」不归这个函数管，调用方只传 AI 空间的组。
 *
 * @param {{groupId?: number, tabIds?: number[]}} options
 * @returns {Promise<{discarded: number, tabIds: number[]}>}
 */
async function discardGroupTabs(options = {}) {
  const groupId = Number(options.groupId);
  const wantGroup = Number.isInteger(groupId) && groupId >= 0;
  const ids = new Set(
    Array.isArray(options.tabIds) ? options.tabIds.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : [],
  );
  if (!wantGroup && !ids.size) return { discarded: 0, tabIds: [] };
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    throw new Error(`discardGroupTabs 读标签页失败：${why(error)}`);
  }
  const list = tabs
    .filter((tab) => tab && typeof tab.id === "number")
    .filter((tab) => (wantGroup && tab.groupId === groupId) || ids.has(tab.id))
    .filter((tab) => tab.active !== true && tab.discarded !== true)
    .map((tab) => tab.id);
  if (!list.length) return { discarded: 0, tabIds: [] };
  if (typeof chrome.tabs.discard !== "function") throw new Error("这个浏览器没有 chrome.tabs.discard，卸载不了");
  await chrome.tabs.discard(list);
  remember(`卸载了空间标签页 ${list.join(",")}（内存）`);
  return { discarded: list.length, tabIds: list };
}

/**
 * 把某个标签页切到前台。只给人在侧边栏点「切到空间」用（这是人点的，可以切前台）；
 * AI 的控制路径绝不许调它（AI 走 CDP，不碰 chrome.tabs.update）。
 */
async function focusTab(options = {}) {
  const tabId = Number(options.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("focusTab 需要合法的 tabId");
  const tab = await chrome.tabs.update(tabId, { active: true });
  remember(`把标签页 ${tabId} 切到前台`);
  return { tabId, active: tab?.active === true };
}

/**
 * 新标签页该不该自动并入「打开它的那个标签页」所在的标签组（纯判断，主程序自测直接测它）。
 *
 * 规则（产品计划「空间里新开的标签页自动归入当前空间」）：
 *   - 新标签页要有 openerTabId（页面里 window.open / target=_blank 开的才有；用户 Ctrl+T 开的没有，不动）；
 *   - 打开它的标签页确实在某个标签组里（groupId 是 >= 0 的数，TAB_GROUP_ID_NONE = -1 不算）；
 *   两个条件都满足才给那个 groupId，别的都返回 null。
 *
 * @param {{id?: number, openerTabId?: number}} tab 新建的标签页
 * @param {{id?: number, groupId?: number}|null} openerTab 打开它的标签页（chrome.tabs.get 读回来的；读不到就是 null）
 * @returns {number|null}
 */
function groupToJoinForNewTab(tab, openerTab) {
  if (!tab || typeof tab.id !== "number") return null;
  const openerTabId = Number(tab.openerTabId);
  if (!Number.isInteger(openerTabId) || openerTabId <= 0) return null;
  if (!openerTab || typeof openerTab.id !== "number" || openerTab.id !== openerTabId) return null;
  const none = (typeof chrome.tabGroups === "object" && typeof chrome.tabGroups.TAB_GROUP_ID_NONE === "number")
    ? chrome.tabGroups.TAB_GROUP_ID_NONE
    : -1;
  if (typeof openerTab.groupId !== "number" || openerTab.groupId === none || openerTab.groupId < 0) return null;
  return openerTab.groupId;
}

/** 新标签页归组：判断抽成纯函数 groupToJoinForNewTab，这里只做 chrome 调用 */
async function autoJoinOpenerGroup(tab) {
  if (!tab || typeof tab.id !== "number") return;
  const openerTabId = Number(tab.openerTabId);
  if (!Number.isInteger(openerTabId) || openerTabId <= 0) return;
  let opener = null;
  try {
    opener = await chrome.tabs.get(openerTabId);
  } catch {
    opener = null;   // 打开它的标签页已经没了：不归组
  }
  const groupId = groupToJoinForNewTab(tab, opener);
  if (groupId === null) return;
  if (typeof chrome.tabs.group !== "function") {
    remember(`新标签页 ${tab.id} 应该并入标签组 ${groupId}，但这个浏览器没有 chrome.tabs.group`);
    return;
  }
  try {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
    remember(`新标签页 ${tab.id} 已并入打开它那个标签页所在的标签组 ${groupId}`);
  } catch (error) {
    remember(`新标签页 ${tab.id} 并入标签组失败：${why(error)}`);
  }
}

/* ---------------- 钉住（快速访问）---------------- */

/**
 * 钉住接口：数据在 chrome.storage.local（跟着这个账号的资料目录走），校验全在 pins.js 的纯函数里。
 * 主程序经 CDP 调这些；侧边栏是插件自己的页面，直接引 pins.js 调 chrome.storage，不经这里。
 *
 * 返回值一律是 {ok, ...}、不抛错：CDP 桥那边只能把异常的文本带回来，错误码会丢，
 * 所以 pins.js 把错包成 {ok:false, code, error}，主程序按 code 转回带码的错误。
 */
function pinsApi() {
  if (typeof globalThis.__windrisePins !== "object" || !globalThis.__windrisePins) {
    throw new Error("钉住功能没就绪（pins.js 没加载）");
  }
  return globalThis.__windrisePins;
}

/** 某个空间的钉住清单 */
async function pinList(options = {}) {
  return pinsApi().pinList(options);
}

/** 钉一条（by 只认 human / ai；主程序那边固定传 ai） */
async function pinAdd(options = {}) {
  return pinsApi().pinAdd(options);
}

/** 取消一条 */
async function pinRemove(options = {}) {
  return pinsApi().pinRemove(options);
}

/** 挪位置 */
async function pinMove(options = {}) {
  return pinsApi().pinMove(options);
}

/** 清掉某个空间的全部钉住（space_close 时主程序顺手调） */
async function pinClear(options = {}) {
  return pinsApi().pinClear(options);
}

/* ---------------- 格子编号 / 左下角按钮 ---------------- */

/**
 * 主程序经 CDP 在 worker 上调用：把「格子 N · 账号名」写进 chrome.storage.session。
 * content script 和侧边栏读这个键；编号只用于显示和让主程序知道点的是哪一格。
 */
async function setGridInfo(input = {}) {
  const slot = Number(input.slot);
  if (!Number.isInteger(slot) || slot <= 0) {
    throw new Error(`setGridInfo 的 slot 必须是正整数（收到 ${String(input.slot)}）`);
  }
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  const info = { slot, name };
  await chrome.storage.session.set({ [GRID_INFO_KEY]: info });
  remember(`格子信息：格子 ${slot}${name ? ` · ${name}` : ""}`);
  return info;
}

/** 给侧边栏 / 新标签页的兜底读取（正常走 storage.session.get） */
async function getGridInfo() {
  try {
    const got = await chrome.storage.session.get(GRID_INFO_KEY);
    return got?.[GRID_INFO_KEY] || null;
  } catch {
    return null;
  }
}

/**
 * 主程序经 CDP 调用：把侧边栏 / 新标签页要的只读状态写进 chrome.storage.session。
 *
 * 状态里**不该有**口令明文或带令牌地址；主程序那头已经裁过一遍，这里只保证写进去的是
 * 一个能序列化的小对象，不额外解释字段（以后加字段不用改插件）。
 */
async function setPanelState(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("setPanelState 需要一份对象状态");
  }
  let state;
  try {
    state = JSON.parse(JSON.stringify(input));
  } catch {
    throw new Error("setPanelState 的状态不能序列化成 JSON");
  }
  await chrome.storage.session.set({ [PANEL_STATE_KEY]: state });
  return { stored: true, at: Date.now() };
}

/** 面板 / 新标签页的兜底读取（正常走 storage.session.get + onChanged） */
async function getPanelState() {
  try {
    const got = await chrome.storage.session.get(PANEL_STATE_KEY);
    return got?.[PANEL_STATE_KEY] || null;
  } catch {
    return null;
  }
}

/**
 * 页面按钮 → 后台：先校验白名单，再调用主程序加的全局 binding。
 *
 * 主程序只在**这个 service worker 的调试会话**上 Runtime.addBinding({name:"windriseGridAction"})，
 * 页面世界（content script 所在的网页）没有这个函数。所以即使网页脚本伪造一条
 * chrome.runtime.sendMessage，也只能到这一步；动作又只作用于本账号窗口，跨不到别的格子。
 */
function forwardGridAction(action, options = {}) {
  if (!isGridActionAllowed(action)) {
    return { ok: false, error: `动作「${String(action)}」不在白名单里` };
  }
  if (typeof globalThis.windriseGridAction !== "function") {
    remember(`收到了格子动作 ${action}，但主程序没连上（没有 binding）`);
    return { ok: false, error: "主程序没连上，动作没有发出去" };
  }
  // show-settings 可带一个受控的 tab 参数（跳到设置窗口的对应页）；别的值一律当没给
  const tab = action === "show-settings" && SHOW_SETTINGS_TABS.has(options?.tab) ? options.tab : undefined;
  const payload = { action };
  if (tab) payload.tab = tab;
  try {
    globalThis.windriseGridAction(JSON.stringify(payload));
    remember(`已转发格子动作 ${action}`);
    return { ok: true, forwarded: true, action };
  } catch (error) {
    remember(`转发格子动作 ${action} 失败：${why(error)}`);
    return { ok: false, error: why(error) };
  }
}

/* ---------------- 口令生成（owner-key-new，只许引导页发） ---------------- */

/** 引导页发来的口令请求：requestId → sendResponse。主程序生成后经 deliverOwnerKey 把明文送回来一次 */
const pendingOwnerKeys = new Map();
/** 口令请求最多等多久（毫秒），超时的应答直接丢掉 */
const OWNER_KEY_PENDING_MS = 30_000;

/**
 * 只接受来自引导页的 owner-key-new：sender.url 必须是 chrome-extension://<自己>/onboarding.html。
 * 别的插件页面（侧边栏 / 新标签页）和网页都不许生成口令。
 */
function ownerKeySenderAllowed(senderUrl, ownId) {
  return typeof senderUrl === "string"
    && senderUrl === `chrome-extension://${ownId}/onboarding.html`;
}

function handleOwnerKeyNew(message, sender, sendResponse) {
  const senderUrl = typeof sender?.url === "string" ? sender.url : "";
  if (!ownerKeySenderAllowed(senderUrl, chrome.runtime.id)) {
    sendResponse({ ok: false, error: "只有初次设置引导页能生成口令（请在引导页里操作）" });
    return;
  }
  const requestId = typeof message?.requestId === "string" ? message.requestId : "";
  if (!OWNER_KEY_REQUEST_PATTERN.test(requestId)) {
    sendResponse({ ok: false, error: "口令请求号不合法" });
    return;
  }
  if (typeof globalThis.windriseGridAction !== "function") {
    sendResponse({ ok: false, error: "主程序没连上，口令没有生成" });
    return;
  }
  // 清理过期请求（worker 睡了一觉回来，地图里可能躺着没被回应的旧请求）
  const now = Date.now();
  for (const [id, item] of pendingOwnerKeys) {
    if (now - item.at > OWNER_KEY_PENDING_MS) pendingOwnerKeys.delete(id);
  }
  pendingOwnerKeys.set(requestId, { sendResponse, at: now });
  try {
    globalThis.windriseGridAction(JSON.stringify({ action: "owner-key-new", requestId }));
  } catch (error) {
    pendingOwnerKeys.delete(requestId);
    sendResponse({ ok: false, error: why(error) });
  }
}

/**
 * 主程序经 CDP 调用：把生成好的口令明文送回给发起请求的引导页（只这一次）。
 * 口令不进 chrome.storage、不进面板状态、不经定时推送 —— 只在这里经 sendResponse 回到页面。
 */
function deliverOwnerKey(input = {}) {
  const requestId = typeof input?.requestId === "string" ? input.requestId : "";
  const pending = pendingOwnerKeys.get(requestId);
  if (pending) pendingOwnerKeys.delete(requestId);
  if (!pending) {
    return { ok: false, delivered: false, reason: "口令请求已经超时，或不是这个页面发起的" };
  }
  if (typeof input?.key === "string" && input.key) {
    pending.sendResponse({ ok: true, key: input.key });
    return { ok: true, delivered: true };
  }
  pending.sendResponse({ ok: false, error: typeof input?.error === "string" ? input.error : "主程序没有生成口令" });
  return { ok: false, delivered: true };
}

/* ---------------- 支付宝下单（pay-order:D|M|Y，只许引导页发） ---------------- */

/**
 * 引导页发起的购买：requestId → 发起页面自己建的长连接 port。
 * 主程序轮询到二维码 / 支付结果后经 deliverPayOrder 只在这个 port 上回推；
 * 二维码不会进 chrome.storage、不会广播给侧边栏 / 新标签页。
 */
const pendingPayOrders = new Map();
const PAY_ORDER_PENDING_MS = 35 * 60_000;

function cleanupPayOrders(now = Date.now()) {
  for (const [id, item] of pendingPayOrders) {
    if (now - item.at > PAY_ORDER_PENDING_MS) pendingPayOrders.delete(id);
  }
}

/** 引导页 → 后台：一条长连接只负责一单；第一次消息带 action + requestId */
chrome.runtime.onConnect.addListener((port) => {
  if (port?.name !== "pay-order") return;
  const senderUrl = typeof port?.sender?.url === "string" ? port.sender.url : "";
  if (!ownerKeySenderAllowed(senderUrl, chrome.runtime.id)) {
    try { port.disconnect(); } catch { /* 已经断开 */ }
    return;
  }
  let requestId = "";
  const reply = (payload) => {
    try { port.postMessage({ type: "pay-order-update", ...payload }); } catch { /* 页面已关 */ }
  };
  port.onMessage.addListener((message) => {
    if (requestId) return;
    const action = typeof message?.action === "string" ? message.action : "";
    if (!/^pay-order:[DMY]$/.test(action)) return reply({ ok: false, error: "套餐类型不对" });
    const id = typeof message?.requestId === "string" ? message.requestId : "";
    if (!OWNER_KEY_REQUEST_PATTERN.test(id)) return reply({ ok: false, error: "购买请求号不合法" });
    if (typeof globalThis.windriseGridAction !== "function") return reply({ ok: false, error: "主程序没连上，购买没有发起" });
    requestId = id;
    cleanupPayOrders();
    pendingPayOrders.set(id, { port, at: Date.now() });
    reply({ requestId: id, ok: true, pending: true });
    try {
      globalThis.windriseGridAction(JSON.stringify({ action, requestId: id }));
    } catch (error) {
      pendingPayOrders.delete(id);
      reply({ requestId: id, ok: false, error: why(error) });
    }
  });
  port.onDisconnect.addListener(() => {
    if (!requestId) return;
    const item = pendingPayOrders.get(requestId);
    if (item?.port === port) pendingPayOrders.delete(requestId);
  });
});

/**
 * 主程序经 CDP 调用：把下单 / 支付状态推回发起页。
 * 只认这个页面自己登记过的 requestId；终止状态后清掉，避免重复推。
 */
function deliverPayOrder(input = {}) {
  const requestId = typeof input?.requestId === "string" ? input.requestId : "";
  const pending = pendingPayOrders.get(requestId);
  if (!pending) return { ok: false, delivered: false, reason: "购买请求已经超时，或不是这个页面发起的" };
  const terminal = input?.status === "paid" || input?.status === "expired" || input?.status === "failed" || input?.ok === false;
  const payload = { ...input, requestId };
  if (input?.ok === false) payload.error = typeof input.error === "string" ? input.error : "购买失败";
  try { pending.port.postMessage({ type: "pay-order-update", ...payload }); }
  catch { pendingPayOrders.delete(requestId); return { ok: false, delivered: false, reason: "发起页面已关闭" }; }
  if (terminal) pendingPayOrders.delete(requestId);
  return { ok: true, delivered: true };
}

/* ---------------- 插件装到所有格子：看商店里装了什么 ---------------- */

/**
 * 监听 chrome.management 的装卸/启停（产品计划 2026-10-26「默认一键装到所有格子」）。
 * 只关心 installType === "normal"（Chrome 应用商店装的）；我们自己和共享库加载进来的插件
 * （都是 installType "development"）一律不看。
 * 新装上（或升级）时经白名单动作 ext-installed:<id> 报主程序；卸载 / 启停只记日志，
 * 不擅自报（同步方向由主程序决定）。
 */
function forwardExtInstalled(info) {
  const id = typeof info?.id === "string" ? info.id : "";
  if (!EXT_ID_PATTERN.test(id) || id === chrome.runtime.id) return;
  if (typeof globalThis.windriseGridAction !== "function") {
    remember(`看到新插件 ${id}，但主程序没连上（没有 binding），没报出去`);
    return;
  }
  try {
    globalThis.windriseGridAction(JSON.stringify({ action: `ext-installed:${id}` }));
    remember(`已把新插件 ${id} 报给主程序（${info?.reason || "install"}）`);
  } catch (error) {
    remember(`报新插件 ${id} 失败：${why(error)}`);
  }
}

function considerExtEvent(info) {
  if (!info || typeof info.id !== "string") return;
  if (info.id === chrome.runtime.id) return;                  // 我们自己
  if (!EXT_ID_PATTERN.test(info.id)) return;                  // id 格式不对
  if (typeof info.installType === "string") {
    // onInstalled 带 installType：只有 normal（商店装的）才报
    if (info.installType === "normal") forwardExtInstalled(info);
    return;
  }
  // onUninstalled / onEnabled / onDisabled 只带 id：查一次安装方式再定（development = 共享库加载的，不看）
  try {
    chrome.management.get(info.id).then((ext) => {
      if (!ext || ext.installType !== "normal" || ext.id === chrome.runtime.id) return;
      remember(`商店插件 ${ext.id} 的${info.event || "变化"}（只记不报）`);
    }).catch(() => {});
  } catch {
    /* 这个构建没有 management：插件同步功能不可用，不影响别的 */
  }
}

try {
  chrome.management?.onInstalled?.addListener?.((info) => considerExtEvent({ ...info, event: "installed" }));
  chrome.management?.onUninstalled?.addListener?.((info) => considerExtEvent({ ...info, event: "uninstalled" }));
  chrome.management?.onEnabled?.addListener?.((info) => considerExtEvent({ ...info, event: "enabled" }));
  chrome.management?.onDisabled?.addListener?.((info) => considerExtEvent({ ...info, event: "disabled" }));
} catch {
  /* 同上：没有 management 就什么都不做 */
}

/** 页面左下角「更多 → 打开侧边栏」：只能由用户手势触发；sender.tab.windowId 让它在当前窗口打开 */
async function openSidePanel(sender) {
  const windowId = Number(sender?.tab?.windowId);
  try {
    if (typeof chrome.sidePanel?.open !== "function") throw new Error("这个浏览器没有 chrome.sidePanel.open");
    await chrome.sidePanel.open(Number.isInteger(windowId) && windowId >= 0 ? { windowId } : {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: why(error) };
  }
}

/**
 * content script / 侧边栏 / 新标签页的消息入口。
 * 只认四种消息：grid-action（按钮动作）、get-grid-info（读编号）、get-panel-state（兜底读状态）、
 * open-side-panel（页面里的「更多」按钮，必须带用户手势）。
 * grid-action 里只有 owner-key-new 是异步应答（等主程序生成口令后经 deliverOwnerKey 回），
 * 而且只接受来自引导页（onboarding.html）的请求。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "grid-action") {
    const action = typeof message.action === "string" ? message.action : "";
    if (action === "owner-key-new") {
      handleOwnerKeyNew(message, sender, sendResponse);
      return true;
    }
    if (/^pay-order:[DMY]$/.test(action)) {
      // 购买必须走引导页自己的 pay-order 长连接（二维码只回那条连接）
      sendResponse({ ok: false, error: "购买请求要经引导页的支付通道发起" });
      return false;
    }
    sendResponse(forwardGridAction(action, { tab: message.tab }));
    return false;
  }
  if (message.type === "get-grid-info") {
    getGridInfo().then((info) => sendResponse({ ok: true, gridInfo: info })).catch(() => sendResponse({ ok: false, gridInfo: null }));
    return true;
  }
  if (message.type === "get-panel-state") {
    getPanelState().then((state) => sendResponse({ ok: true, panelState: state })).catch(() => sendResponse({ ok: false, panelState: null }));
    return true;
  }
  if (message.type === "open-side-panel") {
    openSidePanel(sender).then(sendResponse).catch(() => sendResponse({ ok: false, error: "打开侧边栏失败" }));
    return true;
  }
  return false;
});

/* ---------------- 挂上去（必须顶层同步） ---------------- */

globalThis.__windrise = {
  version: VERSION,
  ping,
  applyPolicy,
  getState,
  openSplit,
  focusState,
  setGridInfo,
  getGridInfo,
  setPanelState,
  getPanelState,
  groupTabs,
  closeGroupTabs,
  discardGroupTabs,
  focusTab,
  /** 停用 BrowserOS 自带 AI（结果写 chrome.storage.session 的 aiHideResult） */
  hideBundledAi,
  /** 新标签页归组判断（纯函数，主程序自测直接调它核对规则） */
  groupToJoinForNewTab,
  /** 钉住：清单 / 钉 / 取消 / 挪位置 / 清空（数据在 chrome.storage.local，校验在 pins.js） */
  pinList,
  pinAdd,
  pinRemove,
  pinMove,
  pinClear,
  /** 引导页的口令请求：送回口令明文（只这一次）；来源判断的纯函数给主程序自测核对 */
  deliverOwnerKey,
  ownerKeySenderAllowed,
  /** 引导页购买：二维码 / 支付状态只推回发起这一单的标签页 */
  deliverPayOrder,
  /** 最近的内部记录，排错用；控制端想看就 evaluate 一下 __windrise.events */
  events,
};

/**
 * 焦点监听：窗口拿到系统焦点 / 所有窗口都失去焦点（WINDOW_ID_NONE）。
 *
 * 只记账，不做动作。主进程那边才是判「人接管」的地方：它要同时看到
 * 「窗口在前台」和「系统里刚有真实键鼠输入（powerMonitor.getSystemIdleTime() === 0）」才动手。
 * 所以这里误报一次也不致命，顶多让主进程多问几次空闲时间。
 */
if (focus.ready) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    const none = chrome.windows.WINDOW_ID_NONE;
    if (windowId === none || windowId === undefined || windowId === null) {
      recordFocus(null, false, "onFocusChanged：所有浏览器窗口都失去前台");
    } else {
      recordFocus(windowId, true, "onFocusChanged：窗口拿到前台");
    }
  });
  // 启动时 onFocusChanged 不会补发当前值，自己问一次（worker 被叫醒重跑时也会走到这里）
  refreshFocus("启动").catch(() => {});
}

/**
 * 挂一个空的 onInstalled 监听：它不做任何事，只是让 worker 在「刚装好」那一小段时间里
 * 被事件唤醒并稳定跑着，控制端在调试接口里找它时少一次扑空。
 */
chrome.runtime.onInstalled.addListener((details) => {
  remember(`插件装载完成（${details && details.reason ? details.reason : "install"}）`);
  enableSidePanelOnAction();
});

/**
 * 叫醒用的监听：**实测**（2026-10-24，本机 155.0.8309.26）MV3 的 worker 在浏览器起来约 30~35 秒后会被停掉，
 * 停掉之后目标从 Target.getTargets 里消失，拿旧 targetId attach 会被拒（No target with given id），
 * 而这个构建里连 ServiceWorker.enable / startWorker 都没有，CDP 叫不醒它。
 * 但被停掉的 worker 仍然记着顶层注册过的事件监听：只要事件真的发生，浏览器会把它拉起来再送事件。
 * 所以这里注册一个「有人建标签页」的监听 —— 控制端想调插件却发现它睡着时，
 * 先 `Target.createTarget({url:"about:blank"})` 建一个空标签页把它叫醒，再去找 `chrome-extension://<id>/sw.js`。
 * 监听体本身什么也不做（只记一行），不读页面、不联网。
 */
chrome.tabs.onCreated.addListener((tab) => {
  remember(`看见新建标签页（${tab && tab.id !== undefined ? tab.id : "?"}），worker 被叫醒`);
  void autoJoinOpenerGroup(tab);
});

/*
 * 新标签页换成 Windrise 仪表盘（2026-10-26 真机踩到）：
 * BrowserOS 自带的 Assistant 插件（bflpfmnmnokmjhmgnolecpppdbdophmk）也声明了 chrome_url_overrides.newtab，
 * 而且优先级比我们高，manifest 里的 newtab 覆盖不生效。这里只做一件事：
 * 新建的标签页如果正要打开「新标签页」（chrome://newtab 或 Assistant 的 app.html），就改成我们的 newtab.html。
 * 不碰别的标签页、不读页面内容；用户自己地址栏输入的网址不受影响。
 */
const OUR_NEWTAB = chrome.runtime.getURL("newtab.html");
const NEWTAB_TAKEOVER = /^(chrome:\/\/(newtab|new-tab-page)\/?|chrome-extension:\/\/bflpfmnmnokmjhmgnolecpppdbdophmk\/app\.html)(\?.*)?$/i;
function takeOverNewTab(tabId, url) {
  if (typeof url !== "string" || !NEWTAB_TAKEOVER.test(url) || url.startsWith(OUR_NEWTAB)) return;
  chrome.tabs.update(tabId, { url: OUR_NEWTAB }).catch(() => {});
}
chrome.tabs.onCreated.addListener((tab) => {
  takeOverNewTab(tab.id, tab.pendingUrl || tab.url);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // 只在新建后的第一次跳转里接管：url 变成新标签页地址、而且这个标签页没有历史（刚开出来）
  if (info.url && tab && !tab.openerTabId && tab.index !== undefined) takeOverNewTab(tabId, info.url);
});
