/**
 * BrowserOS 引擎：找程序、拒绝不能用的、拼参数、起进程、记账、关进程。
 *
 * 是什么：Windrise 把内核从 Electron 换成 BrowserOS 之后，「怎么把一个账号窗口的浏览器进程领起来、再干净地收掉」这一块。
 * 只管进程和文件；标签页那层在 cdp-connection.cjs（连接）/ target-surface.cjs（会话）/ browseros-tab.cjs（Electron 外观）。
 *
 * 不负责：
 *   - 连接怎么收发、超时、断开结算（cdp-connection.cjs）；
 *   - 账号表、窗口排布（browseros-profiles.cjs）；
 *   - 能不能碰这个网址（ai-site-guard.cjs）；
 *   - WebRTC 策略到底设上没有（那是自带插件的事，引擎只把 Preferences 先写一份兜底）。
 *
 * 几条硬规矩（都是从实测事故里换来的，改之前先看 docs/research/browseros-connection-layer-2026-10-24.md）：
 *   1. 只起我们自己那份浏览器（新版本装在 %LOCALAPPDATA%\Windrise，老机器上还是 %LOCALAPPDATA%\BrowserOS，
 *      优先 Windrise）；路径落到 %LOCALAPPDATA%\BrowserClaw 下面一律不碰（那是用户和酥酥在用的 neo）。
 *   2. 程序目录里出现 new_chrome.exe 说明有更新等着装，这时候起会跟升级打架，不启动。
 *   3. 绝不用浏览器自己的默认资料目录（Chrome / Edge / Windrise / BrowserOS 的那份），不然会把用户正常浏览的东西卷进来。
 *   4. 开调试只走管道（--remote-debugging-pipe），不开端口、不写 DevToolsActivePort、不带 --enable-automation。
 *   5. 关进程只按自己 spawn 出来的那个 child，绝不按名字杀 chrome（机器上还有一堆别人的窗口在跑）。
 *   6. 登记文件（run/<id>.json）只放「这台机器上谁占了哪个资料目录」，不放代理串、不放密码。
 */

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { CdpConnection } = require("./cdp-connection.cjs");
const { parseProxyRule } = require("./proxy-guard.cjs");

/** 产品名：界面上叫 Windrise 浏览器（老版本装在 BrowserOS 目录下，也认） */
const ENGINE_NAME = "Windrise 浏览器";

/** 新版本的安装目录名（%LOCALAPPDATA%\Windrise\Application\chrome.exe） */
const INSTALL_DIR = "Windrise";
/** 老版本的安装目录名：老用户机器上还可能是它，找不到 Windrise 才回退 */
const LEGACY_INSTALL_DIR = "BrowserOS";

/** 默认 WebRTC 策略：非代理的 UDP 一律不走（账号窗口要的就是这个） */
const DEFAULT_WEBRTC_POLICY = "disable_non_proxied_udp";

/** 等 Browser.getVersion 的默认时限：10 秒还没应声就当启动失败 */
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
/** Browser.close 这条命令自己的时限 */
const CLOSE_COMMAND_TIMEOUT_MS = 3_000;
/** 说过「再见」之后等进程自己退的默认时限 */
const CLOSE_WAIT_MS = 8_000;
/** child.kill() / SIGKILL 之后各等多久 */
const KILL_WAIT_MS = 2_000;

/**
 * 绝对不许出现在启动参数里的开关（契约 §2 第 2 条）。
 * 这几个一出现，要么被网站当机器人（--enable-automation / --disable-blink-features），
 * 要么等于把调试口开到外部（--remote-allow-origins / --remote-debugging-port）。
 */
const FORBIDDEN_FLAGS = [
  "--enable-automation",
  "--disable-blink-features",
  "--remote-allow-origins",
  "--remote-debugging-port",
];

/* ---------------- 小工具 ---------------- */

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 带错误码的错：调用方按 code 分支，不用去抠中文提示 */
function engineError(code, message, extra = {}) {
  const error = new Error(message);
  error.name = "EngineError";
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** 等一个 promise，最多等 ms；超时给 null（不抛） */
async function waitFor(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => null)]);
}

/**
 * 比路径用：转绝对、去尾部斜杠、尽量解析符号链接、统一小写。
 * 解析不了（路径还不存在）就按原样比，不报错。
 */
function normPath(target) {
  const raw = String(target ?? "").trim();
  if (!raw) return "";
  let full;
  try {
    full = path.resolve(raw);
  } catch {
    return "";
  }
  full = full.replace(/[\\/]+$/, "");
  try {
    full = fs.realpathSync.native(full);
  } catch {
    /* 不存在就按原样比 */
  }
  return full.replace(/[\\/]+$/, "").toLowerCase();
}

/** 两个路径是不是同一个地方 */
function isSamePath(a, b) {
  const left = normPath(a);
  const right = normPath(b);
  return Boolean(left) && Boolean(right) && left === right;
}

/** child 是不是落在 parent 下面（含相等） */
function isUnder(child, parent) {
  const target = normPath(child);
  const base = normPath(parent);
  if (!target || !base) return false;
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/** 本机 %LOCALAPPDATA%（Windrise / BrowserOS / BrowserClaw / Chrome 的默认资料目录都按它算） */
function localAppDataOf(options = {}) {
  return options.localAppData || process.env.LOCALAPPDATA || "";
}

/** %LOCALAPPDATA%\BrowserClaw：用户和酥酥在用的 neo，一律不碰 */
function forbiddenInstallRoot(options = {}) {
  const base = localAppDataOf(options);
  return base ? path.join(base, "BrowserClaw") : "";
}

/**
 * 浏览器自己的默认资料目录（这些绝对不能拿来当账号窗口的资料目录）：
 *   - %LOCALAPPDATA%\Google\Chrome\User Data
 *   - %LOCALAPPDATA%\Microsoft\Edge\User Data
 *   - %LOCALAPPDATA%\Windrise\User Data（新版本装在自己家时的那份默认）
 *   - %LOCALAPPDATA%\BrowserOS\User Data（老版本装在自己家时的那份默认）
 *   - %LOCALAPPDATA%\Chromium\User Data
 *   - %LOCALAPPDATA%\BrowserClaw\User Data（neo 的）
 *   - 程序目录旁边那份：`…\Windrise\Application\chrome.exe` → `…\Windrise\User Data`
 */
function defaultBrowserProfileDirs(options = {}) {
  const base = localAppDataOf(options);
  const list = [];
  if (base) {
    list.push(path.join(base, "Google", "Chrome", "User Data"));
    list.push(path.join(base, "Microsoft", "Edge", "User Data"));
    list.push(path.join(base, INSTALL_DIR, "User Data"));
    list.push(path.join(base, LEGACY_INSTALL_DIR, "User Data"));
    list.push(path.join(base, "Chromium", "User Data"));
    list.push(path.join(base, "BrowserClaw", "User Data"));
  }
  if (options.exe) {
    const dir = path.dirname(options.exe);
    list.push(path.join(dir, "User Data"));
    list.push(path.join(path.dirname(dir), "User Data"));
  }
  return list;
}

/**
 * 从程序目录里的版本号子目录看出浏览器版本（BrowserOS 沿用了 Chrome 的摆法：
 * `…\Application\chrome.exe` + `…\Application\155.0.8309.26\`）。看不出就给 null，不瞎猜。
 */
function versionFromInstallDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const versions = names
    .filter((name) => /^\d+(\.\d+){2,3}$/.test(name))
    .map((name) => ({ name, parts: name.split(".").map((piece) => Number(piece) || 0) }))
    .sort((a, b) => {
      const length = Math.max(a.parts.length, b.parts.length);
      for (let i = 0; i < length; i += 1) {
        const diff = (b.parts[i] || 0) - (a.parts[i] || 0);
        if (diff) return diff;
      }
      return 0;
    });
  return versions.length ? versions[0].name : null;
}

/** "Chrome/155.0.8309.26" → "155.0.8309.26"；认不出来就原样给 */
function productToVersion(product) {
  const text = String(product ?? "").trim();
  const matched = /^(?:Chrome|Chromium|HeadlessChrome)\/([\w.]+)$/i.exec(text);
  return matched ? matched[1] : text;
}

/* ---------------- 找程序 / 能不能用 ---------------- */

/**
 * 找程序时的候选路径，按优先级排好（新版本 Windrise 在前，老版本 BrowserOS 兜底）：
 *   1. 参数给的 exe（测试或别处装配时用）
 *   2. %LOCALAPPDATA%\Windrise\Application\chrome.exe
 *   3. %LOCALAPPDATA%\Programs\Windrise\Application\chrome.exe
 *   4. %PROGRAMFILES%\Windrise\Application\chrome.exe
 *   5. %LOCALAPPDATA%\BrowserOS\Application\chrome.exe（老用户机器）
 *   6. %LOCALAPPDATA%\Programs\BrowserOS\Application\chrome.exe
 *   7. %PROGRAMFILES%\BrowserOS\Application\chrome.exe
 * 探针脚本也用这份清单，免得和引擎各写一套、慢慢走偏。
 * @param {{ localAppData?: string, exe?: string, programFiles?: string }} [options]
 * @returns {string[]}
 */
function executableCandidates(options = {}) {
  const candidates = [];
  if (options.exe) candidates.push(options.exe);
  const base = localAppDataOf(options);
  const programFiles = options.programFiles === undefined ? (process.env.PROGRAMFILES || "") : String(options.programFiles);
  for (const dir of [INSTALL_DIR, LEGACY_INSTALL_DIR]) {
    if (base) {
      candidates.push(path.join(base, dir, "Application", "chrome.exe"));
      candidates.push(path.join(base, "Programs", dir, "Application", "chrome.exe"));
    }
    if (programFiles) candidates.push(path.join(programFiles, dir, "Application", "chrome.exe"));
  }
  return candidates;
}

/**
 * 找 Windrise 浏览器的主程序（老机器上回退到 BrowserOS 装的那份）。
 * 顺序见 executableCandidates。
 * @param {{ localAppData?: string, exe?: string, programFiles?: string }} [options]
 * @returns {string} 绝对路径
 */
function findExecutable(options = {}) {
  const candidates = executableCandidates(options);

  const forbidden = forbiddenInstallRoot(options);
  for (const candidate of candidates) {
    // 落在 BrowserClaw 下面：先按「不许用」拒，别等到文件存在性判断里混过去
    if (forbidden && isUnder(candidate, forbidden)) {
      throw engineError("FORBIDDEN_INSTALL", `${candidate} 在 BrowserClaw 目录下，那是用户和酥酥在用的 neo，不许拿来开账号窗口`, { exe: candidate });
    }
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      /* 这个候选没有，看下一个 */
    }
  }
  throw engineError(
    "ENGINE_NOT_FOUND",
    `没找到 ${ENGINE_NAME} 主程序；找过：${candidates.join("、") || "（没有任何候选路径）"}`,
    { tried: candidates },
  );
}

/**
 * 这个主程序能不能用。四条拒绝各给一个错误码：
 *   FORBIDDEN_INSTALL   路径在 %LOCALAPPDATA%\BrowserClaw 下面
 *   ENGINE_NOT_FOUND    文件根本不在
 *   UPDATE_PENDING      程序目录里有 new_chrome.exe（有更新等着装）
 * @param {string} exe
 * @param {{ localAppData?: string }} [options]
 * @returns {{ exe: string, version: string|null, dir: string }}
 */
function assertUsableExecutable(exe, options = {}) {
  const raw = String(exe ?? "").trim();
  if (!raw) throw engineError("ENGINE_NOT_FOUND", `没有给 ${ENGINE_NAME} 主程序路径`);

  const forbidden = forbiddenInstallRoot(options);
  if (forbidden && isUnder(raw, forbidden)) {
    throw engineError("FORBIDDEN_INSTALL", `${raw} 在 BrowserClaw 目录下，那是用户和酥酥在用的 neo，不许拿来开账号窗口`, { exe: raw });
  }

  const full = path.resolve(raw);
  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw engineError("ENGINE_NOT_FOUND", `没找到 ${ENGINE_NAME} 主程序：${full}`, { exe: full });
  }

  const dir = path.dirname(full);
  const pending = path.join(dir, "new_chrome.exe");
  if (fs.existsSync(pending)) {
    throw engineError(
      "UPDATE_PENDING",
      `程序目录里有待装的新版（${pending}），现在起会跟升级打架；等人装完再开账号窗口`,
      { exe: full, pending },
    );
  }

  return { exe: full, version: versionFromInstallDir(dir), dir };
}

/**
 * 资料目录能不能用：不许是浏览器默认目录，也不许落在 BrowserClaw 下面。
 * @param {string} userDataDir
 * @param {{ exe?: string, localAppData?: string }} [options]
 * @returns {string} 绝对路径
 */
function assertProfileDirUsable(userDataDir, options = {}) {
  const raw = String(userDataDir ?? "").trim();
  if (!raw) throw engineError("FORBIDDEN_PROFILE_DIR", "没有资料目录：账号窗口必须有自己的资料目录");

  const forbidden = forbiddenInstallRoot(options);
  if (forbidden && isUnder(raw, forbidden)) {
    throw engineError("FORBIDDEN_INSTALL", `资料目录 ${raw} 在 BrowserClaw 下面，那是 neo 的地盘`, { userDataDir: raw });
  }
  for (const reserved of defaultBrowserProfileDirs({ localAppData: options.localAppData, exe: options.exe })) {
    if (isSamePath(raw, reserved)) {
      throw engineError(
        "FORBIDDEN_PROFILE_DIR",
        `资料目录 ${raw} 是浏览器自己的默认目录（${reserved}），不能用；账号窗口要一个单独的空目录`,
        { userDataDir: raw, reserved },
      );
    }
  }
  return path.resolve(raw);
}

/**
 * 账号窗口的资料目录：<dataHome>\browseros\profiles\<profileId>
 * profileId 里有路径分隔符或 .. 一律拒（不然能跳出数据目录）。
 * @param {string} dataHome
 * @param {string} profileId
 * @returns {string}
 */
function defaultUserDataDir(dataHome, profileId) {
  const root = String(dataHome ?? "").trim();
  if (!root) throw engineError("FORBIDDEN_PROFILE_DIR", "没有 dataHome，算不出资料目录");
  const id = String(profileId ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === "." || id === "..") {
    throw engineError("FORBIDDEN_PROFILE_DIR", `profileId 只能用字母数字和 . _ -（最多 64 字），现在给的是「${id}」`, { profileId: id });
  }
  return path.join(path.resolve(root), "browseros", "profiles", id);
}

/* ---------------- 启动参数 ---------------- */

/**
 * 拼启动参数。顺序固定，值全部来自参数，绝不自己加东西。
 * 有代理就加 --proxy-server（先过 proxy-guard 的规范化，不合法按 PROXY_INVALID 拒），有插件就加 --load-extension
 * （extensionDirs 是「我们自己的插件 + 共享插件库里的插件」的完整清单，逗号分隔；只给了 extensionDir 就按单个来）。
 * extraArgs 里要是混进了契约禁止的那几个开关，直接拒（FORBIDDEN_ARG），不静默丢掉。
 *
 * 这里固定带 --enable-unsafe-extension-debugging：
 *   含义 —— 允许经调试通道在运行中装卸插件（CDP 的 Extensions.loadUnpacked / Extensions.uninstall）。
 *   风险 —— 这个开关会放开「调试端装卸插件」的能力；我们的账号窗口只开管道调试
 *   （--remote-debugging-pipe，不开端口、不写 DevToolsActivePort），管道只有本进程独占，
 *   网页和别的程序拿不到调试口，所以这个能力到不了外人手里。
 *   没有这个开关，「插件装到所有格子」就只能重开格子才生效（侧边栏会提示）。
 * @param {{ userDataDir: string, proxy?: string, extensionDir?: string, extensionDirs?: string[], extraArgs?: string[] }} options
 * @returns {string[]}
 */
function buildLaunchArgs(options = {}) {
  const userDataDir = String(options.userDataDir ?? "").trim();
  if (!userDataDir) throw new Error("buildLaunchArgs 需要 userDataDir");

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-startup-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-browseros-server",
    "--disable-browseros-server-updater",
    "--disable-updates",
  ];

  const extensionDirs = [];
  if (Array.isArray(options.extensionDirs)) {
    extensionDirs.push(...options.extensionDirs.filter((dir) => typeof dir === "string" && dir.trim()));
  }
  if (!extensionDirs.length) {
    const single = String(options.extensionDir ?? "").trim();
    if (single) extensionDirs.push(single);
  }
  // 目录里可能有空格 / 中文：整条参数就是一个字符串，逗号分隔，不做任何转义或截断
  if (extensionDirs.length) args.push(`--load-extension=${[...new Set(extensionDirs)].join(",")}`);

  const proxyRaw = String(options.proxy ?? "").trim();
  if (proxyRaw) {
    const rule = parseProxyRule(proxyRaw);
    if (!rule.ok) {
      throw engineError("PROXY_INVALID", `代理地址不能用：${rule.error}`, { proxy: proxyRaw });
    }
    // 用规范化的那份（socks:// → socks5://、裸 主机:端口 → http://主机:端口）；带账号密码的写法已经被上面拒了
    args.push(`--proxy-server=${rule.normalized}`);
  }

  args.push("--disable-backgrounding-occluded-windows");
  args.push("--disable-renderer-backgrounding");

  const extra = Array.isArray(options.extraArgs) ? options.extraArgs.filter((item) => typeof item === "string" && item.trim()) : [];
  for (const item of extra) {
    const name = item.split("=")[0].toLowerCase();
    if (FORBIDDEN_FLAGS.includes(name)) {
      throw engineError("FORBIDDEN_ARG", `extraArgs 里不许带 ${name}：这几个开关会开调试口或把浏览器标成自动化`, { arg: item });
    }
  }
  args.push(...extra);

  // 兜底自检：上面拼完要是还有禁用的开关，宁可当场炸也不起进程
  for (const item of args) {
    const name = item.split("=")[0].toLowerCase();
    if (FORBIDDEN_FLAGS.includes(name)) {
      throw engineError("FORBIDDEN_ARG", `启动参数里混进了 ${name}，不启动`, { arg: item });
    }
  }

  return args;
}

/* ---------------- Preferences ---------------- */

/** 原子写：先写同目录临时文件，再改名顶掉目标（中途断电最多留个 .tmp，不留半个 Preferences） */
function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件也删不掉就算了 */
    }
    throw error;
  }
}

/**
 * 预写 <userDataDir>\Default\Preferences：只动两个键。
 *   profile.name        窗口叫啥（账号名，界面上看得见）
 *   webrtc.ip_handling_policy  WebRTC 策略（默认 disable_non_proxied_udp）
 * 先读、合并、原子写：文件里别的键一个都不碰（Chrome 自己那一堆设置还在）。
 * 写不进去**不算启动失败**：返回 {written:false, path, reason}，让上层照常开窗口。
 * 现有文件不是合法 JSON 时**不覆盖**（宁可这次不写，也不能把用户那一份 Preferences 弄坏）。
 * @param {string} userDataDir
 * @param {{ profileName?: string, webrtcPolicy?: string|null }} [options]
 * @returns {Promise<{ written: boolean, path: string, reason?: string }>}
 */
async function writePreferences(userDataDir, options = {}) {
  const root = String(userDataDir ?? "").trim();
  if (!root) return { written: false, path: "", reason: "没有资料目录，写不了 Preferences" };

  const defaultDir = path.join(path.resolve(root), "Default");
  const file = path.join(defaultDir, "Preferences");
  const profileName = options.profileName === undefined ? undefined : String(options.profileName);
  const webrtcPolicy = options.webrtcPolicy === undefined
    ? DEFAULT_WEBRTC_POLICY
    : (options.webrtcPolicy === null || options.webrtcPolicy === false ? null : String(options.webrtcPolicy));

  if (profileName === undefined && webrtcPolicy === null) {
    return { written: false, path: file, reason: "没给要写的键（profileName 和 webrtcPolicy 都是空的）" };
  }

  try {
    fs.mkdirSync(defaultDir, { recursive: true });
  } catch (error) {
    return { written: false, path: file, reason: `建不了 ${defaultDir}：${error.message}` };
  }

  let current = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { written: false, path: file, reason: `读不了现有 Preferences：${error.message}` };
    text = "";
  }
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { written: false, path: file, reason: "现有 Preferences 不是 JSON 对象，不敢覆盖" };
      }
      current = parsed;
    } catch (error) {
      return { written: false, path: file, reason: `现有 Preferences 不是合法 JSON，不敢覆盖：${error.message}` };
    }
  }

  // 合并：只落到这两个键上
  if (profileName !== undefined) {
    const profile = current.profile && typeof current.profile === "object" && !Array.isArray(current.profile) ? current.profile : {};
    current.profile = { ...profile, name: profileName };
  }
  if (webrtcPolicy !== null) {
    const webrtc = current.webrtc && typeof current.webrtc === "object" && !Array.isArray(current.webrtc) ? current.webrtc : {};
    current.webrtc = { ...webrtc, ip_handling_policy: webrtcPolicy };
  }

  try {
    writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
  } catch (error) {
    return { written: false, path: file, reason: `写不进去：${error.message}` };
  }
  return { written: true, path: file };
}

/* ---------------- 登记文件（run/<id>.json） ---------------- */

/** 登记目录：<dataHome>\browseros\run */
function runDirOf(dataHome) {
  return path.join(path.resolve(String(dataHome ?? "")), "browseros", "run");
}

/**
 * 读登记表。只认自己写的那几个字段，别的键不往外交。
 * 解析不了的文件给一条 {broken:true, file}，**不删**（看不懂的东西不动）。
 * @param {string} dataHome
 * @returns {Promise<Array<{id: string|null, pid: number|null, userDataDir: string|null, startedAt: string|null, version: string|null, file: string, broken?: boolean}>>}
 */
async function readRunFiles(dataHome) {
  const dir = runDirOf(dataHome);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      records.push({ id: null, pid: null, userDataDir: null, startedAt: null, version: null, file, broken: true });
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      records.push({ id: null, pid: null, userDataDir: null, startedAt: null, version: null, file, broken: true });
      continue;
    }
    records.push({
      id: typeof record.id === "string" ? record.id : null,
      pid: Number.isInteger(record.pid) ? record.pid : null,
      userDataDir: typeof record.userDataDir === "string" ? record.userDataDir : null,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
      version: typeof record.version === "string" ? record.version : null,
      file,
    });
  }
  return records;
}

/** pid 还在不在（不归我们的进程 kill(pid,0) 会给 EPERM，那也算在） */
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * 异步跑一次外部命令，只取 stdout。
 * 抽出来是为了自测能塞假 execFile：真跑 PowerShell 那一步在单测里没法覆盖。
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<string>}
 */
function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ""));
    });
  });
}

/**
 * 一次问清楚这些 pid 的命令行（Windows 上用 CIM 查；别的平台不支持就返回空表）。
 * 查不到不算「进程不在」——只算「看不清」，调用方按活着处理。
 *
 * 用异步 execFile 而不是 execFileSync：查命令行最长等 15 秒，同步版会把主进程整个卡住，
 * 界面、控制服务、别的账号的命令全跟着停。异步版等 PowerShell 的这段时间事件循环照转。
 *
 * 两个坑（2026-10-24 真机撞的）：
 *   1. 别用 `ConvertTo-Json -AsArray`：这台机器的 powershell.exe 是 Windows PowerShell 5.1，没这个参数，
 *      整条命令直接报错 → 命令行一条都查不到 → 所有登记都被当「看不清」放过，孤儿永远清不掉。
 *   2. 别让 PowerShell 直接吐中文：5.1 往重定向的 stdout 写的是控制台的 OEM 代码页（这里是 936），
 *      Node 按 UTF-8 解就是乱码，路径里带中文就永远对不上。所以命令行在 PowerShell 那边先 Base64 一下，回来再解，纯 ASCII 不会有歧义。
 * @param {number[]} pids
 * @param {{ execFile?: (file: string, args: string[], options: object) => Promise<string> }} [options]
 *   execFile 是给自测注入假命令用的，签名和 execFileText 一样。
 * @returns {Promise<Map<number, string>>}  pid → 命令行
 */
async function queryCommandLines(pids, options = {}) {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].slice(0, 200);
  const result = new Map();
  if (!wanted.length || process.platform !== "win32") return result;

  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter "${filter}" -ErrorAction Stop)`,
    "$out = @()",
    "foreach ($r in $rows) {",
    '  $cmd = ""',
    "  if ($r.CommandLine) { $cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$r.CommandLine)) }",
    "  $out += [pscustomobject]@{ pid = [int]$r.ProcessId; cmd64 = $cmd }",
    "}",
    "ConvertTo-Json -InputObject $out -Compress -Depth 4",
  ].join("; ");

  const run = typeof options.execFile === "function" ? options.execFile : execFileText;
  let output = "";
  try {
    output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      // 异步版同样把 stderr 吞掉；查询失败不该污染日志
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // 没有 PowerShell、被策略挡了、超时：都当「看不清」，不删任何登记
    return result;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return result;
  }
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || !Number.isInteger(Number(row.pid))) continue;
    let commandLine = "";
    if (typeof row.cmd64 === "string" && row.cmd64) {
      try {
        commandLine = Buffer.from(row.cmd64, "base64").toString("utf8");
      } catch {
        commandLine = "";
      }
    }
    result.set(Number(row.pid), commandLine);
  }
  return result;
}

/** 命令行里是不是写着这个资料目录（pid 有可能被系统复用，光看 pid 不够） */
function commandLineUsesDir(commandLine, userDataDir) {
  if (!commandLine || !userDataDir) return false;
  const haystack = String(commandLine).toLowerCase().replace(/\//g, "\\");
  const needle = `--user-data-dir=${String(userDataDir).toLowerCase().replace(/\//g, "\\")}`;
  return haystack.includes(needle);
}

/**
 * 清孤儿：只删「进程已经不在 / pid 还在但命令行里不是这个资料目录」的登记；活着的一律不动、不杀。
 * @param {string} dataHome
 * @param {{ isAlive?: (record: any) => boolean|Promise<boolean>, execFile?: (file: string, args: string[], options: object) => Promise<string> }} [options]
 *   isAlive 是给自测注入假判定的；execFile 是给自测注入假命令的（不传就真问 PowerShell）。
 * @returns {Promise<{removed: any[], alive: any[], skipped: any[]}>}
 */
async function sweepStaleRuns(dataHome, options = {}) {
  const records = await readRunFiles(dataHome);
  const removed = [];
  const alive = [];
  const skipped = [];

  const usable = [];
  for (const record of records) {
    // 看不懂的登记文件不动：删了就再也找不到那个进程了
    if (record.broken) skipped.push({ ...record, reason: "登记文件读不懂，不动它" });
    else usable.push(record);
  }

  const injected = typeof options.isAlive === "function" ? options.isAlive : null;
  const commandLines = injected ? null : await queryCommandLines(usable.map((record) => record.pid), { execFile: options.execFile });

  for (const record of usable) {
    let live;
    let why;
    if (injected) {
      try {
        live = Boolean(await injected(record));
      } catch (error) {
        skipped.push({ ...record, reason: `isAlive 自己出错：${error.message}` });
        continue;
      }
      why = live ? "isAlive 说还活着" : "isAlive 说没了";
    } else if (!pidExists(record.pid)) {
      live = false;
      why = "进程已经不在了";
    } else if (commandLines && commandLines.has(record.pid)) {
      const commandLine = commandLines.get(record.pid);
      if (commandLine && !commandLineUsesDir(commandLine, record.userDataDir)) {
        live = false;
        why = "pid 还在，但命令行里不是这个资料目录（pid 被系统复用了）";
      } else {
        live = true;
        why = "进程在，命令行也对得上";
      }
    } else {
      // 查不到命令行（没有 PowerShell / 权限不够）：宁可当活着，也不误杀别人的窗口
      live = true;
      why = "进程在，但命令行查不到，保守当活着";
    }

    if (live) {
      alive.push(record);
      continue;
    }
    try {
      fs.rmSync(record.file, { force: true });
      removed.push({ ...record, how: why });
    } catch (error) {
      skipped.push({ ...record, reason: `要删但删不掉：${error.message}` });
    }
  }

  return { removed, alive, skipped };
}

/* ---------------- 起进程 ---------------- */

/**
 * 起一个账号窗口的浏览器进程，连上管道，拿到 Browser.getVersion 才算成功。
 * @param {{
 *   profileId: string, dataHome: string, proxy?: string, extensionDir?: string,
 *   extensionDirs?: string[], timeoutMs?: number, profileName?: string, webrtcPolicy?: string|null,
 *   extraArgs?: string[], localAppData?: string, exe?: string, userDataDir?: string,
 * }} options
 *   exe / userDataDir 是给自测和装配时留的口子（正常调用不用传，按 findExecutable / defaultUserDataDir 算）。
 * @returns {Promise<any>} handle（形状见契约 §2）
 */
async function launch(options = {}) {
  const dataHome = String(options.dataHome ?? "").trim();
  if (!dataHome) throw new Error("launch 需要 dataHome（Windrise 的数据目录）");
  const id = String(options.profileId ?? "").trim();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_LAUNCH_TIMEOUT_MS;

  const localAppData = localAppDataOf(options);
  const exeOption = options.exe ? String(options.exe) : "";
  const exeInfo = assertUsableExecutable(exeOption || findExecutable({ localAppData }), { localAppData });

  const userDataDir = options.userDataDir ? path.resolve(String(options.userDataDir)) : defaultUserDataDir(dataHome, id);
  assertProfileDirUsable(userDataDir, { exe: exeInfo.exe, localAppData });

  const args = buildLaunchArgs({
    userDataDir,
    proxy: options.proxy,
    extensionDir: options.extensionDir,
    extensionDirs: options.extensionDirs,
    extraArgs: options.extraArgs,
  });

  const root = path.resolve(dataHome);
  const runDir = runDirOf(root);
  const logDir = path.join(root, "browseros", "logs");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${id}.log`);
  const runFile = path.join(runDir, `${id}.json`);

  // 先清一遍孤儿登记，清完再 spawn：新进程写登记之前必须把旧的看完，免得把刚写的那份当孤儿删了。
  // 查命令行是异步的，等 PowerShell 的这段时间事件循环照转，界面不会被冻住。
  // handle.sweep 仍按契约给 Promise，等在这里只是保证顺序，结果本身后面没人用。
  const sweep = sweepStaleRuns(root).catch((error) => ({ removed: [], alive: [], skipped: [], error: error.message }));
  await sweep;

  // Preferences 先写：写不进去照开，只记在 handle 上
  const preferences = await writePreferences(userDataDir, {
    profileName: options.profileName === undefined ? id : options.profileName,
    webrtcPolicy: options.webrtcPolicy,
  });

  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(exeInfo.exe, args, {
      stdio: ["ignore", logFd, logFd, "pipe", "pipe"],
      windowsHide: true,
    });
  } finally {
    // 子进程已经拿到自己的句柄副本，父进程这份关掉，免得泄漏
    try { fs.closeSync(logFd); } catch { /* 关不掉就算了 */ }
  }

  const startedAt = new Date().toISOString();
  const conn = CdpConnection.overChild(child, {
    timeoutMs: Math.max(5_000, timeoutMs),
    label: `${ENGINE_NAME}账号窗口 ${id}`,
  });

  let settleExited = () => {};
  const exited = new Promise((resolve) => { settleExited = resolve; });
  const handle = {
    id,
    pid: child.pid ?? null,
    exe: exeInfo.exe,
    userDataDir,
    args,
    conn,
    child,
    runFile,
    logFile,
    startedAt,
    exited,
    preferences,
    sweep,
    version: exeInfo.version,
    product: null,
    runFileError: null,
    isAlive: () => child.exitCode === null && child.signalCode === null,
  };

  let exitedInfo = null;
  child.once("exit", (code, signal) => {
    exitedInfo = { code, signal };
    // 登记文件跟着进程走：人退了，账就销
    try { fs.rmSync(runFile, { force: true }); } catch { /* 删不掉也只是留个文件 */ }
    settleExited(exitedInfo);
  });
  // 启动失败（找不到程序之类）子进程也会发 error；连接层已经接了，这里挂一个空的免得未捕获
  child.once("error", () => {});

  let version;
  let product;
  try {
    const info = await conn.send("Browser.getVersion", {}, "", { timeoutMs });
    product = String(info.product ?? "");
    version = productToVersion(product) || exeInfo.version || null;
  } catch (error) {
    // 连不上就把进程收掉，不留半条命
    await closeBrowser(handle, { timeoutMs: 2_000 }).catch(() => {});
    throw engineError(
      "LAUNCH_TIMEOUT",
      `${Math.round(timeoutMs / 1000)} 秒内没等到 Browser.getVersion（${error.code || "错误"}：${error.message}），进程已经收掉`,
      { cause: error, causeCode: error.code || null, pid: handle.pid, logFile },
    );
  }

  handle.version = version;
  handle.product = product;

  if (!handle.isAlive()) {
    await closeBrowser(handle, { timeoutMs: 1_000 }).catch(() => {});
    throw engineError("BROWSER_EXITED", "浏览器连上之后又立刻退出了（看日志）", {
      pid: handle.pid,
      logFile,
      exit: exitedInfo,
    });
  }

  // 登记：只写「谁占着哪个资料目录」，不写代理串、不写任何密码
  const record = {
    id,
    pid: handle.pid,
    userDataDir,
    startedAt,
    version,
    exe: exeInfo.exe,
  };
  try {
    writeFileAtomic(runFile, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    // 记账失败不该把一个已经开好的窗口弄死，但要让上层看得见
    handle.runFileError = error.message;
  }

  return handle;
}

/* ---------------- 关进程 ---------------- */

/**
 * 关一个账号窗口：先好好说（Browser.close）→ 等它自己退 → 不退就按自己的 child 结束 → 再不行 SIGKILL。
 * 只动传进来的这个 child，绝不按名字杀 chrome。
 * @param {any} handle  launch 回来的（或自测里假造的）
 * @param {{ timeoutMs?: number }} [options]  等它自己退多久（默认 8 秒）
 * @returns {Promise<{ closed: boolean, how: "browser.close"|"kill"|"already", exit?: {code, signal}|null, signal?: string }>}
 */
async function closeBrowser(handle, options = {}) {
  if (!handle || !handle.child) return { closed: true, how: "already" };
  const child = handle.child;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : CLOSE_WAIT_MS;

  const isAlive = typeof handle.isAlive === "function"
    ? () => Boolean(handle.isAlive())
    : () => child.exitCode === null && child.signalCode === null;

  const exited = handle.exited && typeof handle.exited.then === "function"
    ? handle.exited
    : new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
      else child.once("exit", (code, signal) => resolve({ code, signal }));
    });

  // 已经退了：直接说「早就没了」
  if (!isAlive()) {
    return { closed: true, how: "already", exit: await waitFor(exited, 1_000) };
  }

  // 1) 请它自己关（管道上发一条 Browser.close，3 秒不应就算失败，不影响后面步骤）
  if (handle.conn && typeof handle.conn.send === "function") {
    try {
      await Promise.race([
        handle.conn.send("Browser.close", {}, "", { timeoutMs: CLOSE_COMMAND_TIMEOUT_MS }).catch(() => null),
        sleep(CLOSE_COMMAND_TIMEOUT_MS + 200).then(() => null),
      ]);
    } catch {
      /* 发不出去就走下一步 */
    }
  }

  let exit = await waitFor(exited, timeoutMs);
  if (exit) return { closed: true, how: "browser.close", exit };

  // 2) 自己的 child，结束它
  try { child.kill(); } catch { /* 已经退了 */ }
  exit = await waitFor(exited, KILL_WAIT_MS);
  if (exit) return { closed: true, how: "kill", exit, signal: "SIGTERM" };

  // 3) 还不退就硬来
  try { child.kill("SIGKILL"); } catch { /* 同上 */ }
  exit = await waitFor(exited, KILL_WAIT_MS);
  if (exit) return { closed: true, how: "kill", exit, signal: "SIGKILL" };

  return { closed: false, how: "kill", signal: "SIGKILL" };
}

module.exports = {
  ENGINE_NAME,
  INSTALL_DIR,
  LEGACY_INSTALL_DIR,
  executableCandidates,
  findExecutable,
  assertUsableExecutable,
  defaultBrowserProfileDirs,
  defaultUserDataDir,
  buildLaunchArgs,
  writePreferences,
  readRunFiles,
  sweepStaleRuns,
  launch,
  closeBrowser,
};
