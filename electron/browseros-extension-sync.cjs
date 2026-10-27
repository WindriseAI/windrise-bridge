/**
 * 扩展「一键装到所有格子」的清单同步（产品决定 2026-10-27）：
 * 在一个格子里装好的商店插件，把**插件本身**同步到其他格子；插件里的登录和数据一概不同步。
 *
 * 它怎么做到「只同步插件、不同步登录」：
 *   - 不复制 Extensions/<id>/ 里的插件文件，也不复制 Local Extension Settings / Sync Extension Settings /
 *     Managed Extension Settings / Extension State / IndexedDB / Extension Cookies 任何一份数据；
 *   - 只往目标格子资料目录的 `External Extensions/<插件id>.json` 写一行
 *     `{"external_update_url": "..."}`。这是 Chromium 外部扩展 provider 读的清单，浏览器下次启动时
 *     自己去 update_url 下载并安装，装完的登录、storage、cookie 都是那个格子自己的（天然隔离）。
 *
 * 为什么不用复制目录那条路：
 *   - 手动复制的 Extensions/<id> 目录要过 _metadata/verified_contents.json 和 CRX 签名校验，
 *     过不了会被标成 DISABLE_CORRUPTED；
 *   - 复制数据目录就是把登录 token 搬过去，格子之间的账号隔离直接破掉。
 *
 * 写清单前的四道校验（缺一不写）：
 *   1. 插件 id 必须是 32 位小写 a~p（Chromium 的 id 字母表）；
 *   2. 版本号合法（1~4 段数字，每段 0~65535，不允许前导零）；
 *   3. 源插件在 Preferences 里记的路径不许含 `..`，而且必须在这个格子的资料目录里面；
 *   4. 路径上任何一层是符号链接 / 联接点就拒绝（读源、写目标两侧都查）。
 *
 * 它不管什么：
 *   - 谁在什么时候调它（MCP 工具 extension_sync 经 browser-control 进来）；
 *   - 格子进程的启停（browseros-profiles.cjs 只负责读 / 写清单，不强制重启任何格子）；
 *   - 共享插件库（browseros-extensions.cjs 那条 --load-extension 的路，和这里互不影响）。
 */

const fs = require("node:fs");
const path = require("node:path");

const { isPathInside } = require("./browseros-extensions.cjs");

/** Chrome 插件 id 的格式：32 位小写 a~p */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
/** Chromium 外部扩展 provider 读的目录名（在资料目录下面） */
const EXTERNAL_EXTENSIONS_DIR = "External Extensions";
/** 资料目录里的默认 profile 目录 */
const PROFILE_DIR = "Default";
/** 商店默认更新地址：源插件没写 update_url 时用它 */
const DEFAULT_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
/** 单次同步最多写多少个清单（防止一个坏 Preferences 把目标格子刷爆） */
const MAX_SYNC_EXTENSIONS = 100;
/**
 * 这套清单能不能生效，取决于浏览器构建有没有注册「资料目录/External Extensions」这个 provider：
 * Chromium 官方只在 ChromeOS / macOS / Linux（Chromium 品牌）注册，Windows 走注册表。
 * Windrise 浏览器是自编译的，打没打这个补丁要看构建；没打的话清单会被静默忽略（不改任何数据）。
 */
const PLATFORM_NOTE = "External Extensions 要浏览器构建注册这个目录才会读：Chromium 官方 Windows 构建不注册（macOS / Linux / ChromeOS 注册）。Windrise 浏览器没打这个补丁时清单会被忽略，不会改任何数据。";
/** 版本号：1~4 段，每段 0~65535，不允许前导零（和 Chromium base::Version 的合法形状对齐） */
const VERSION_PATTERN = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

/** location 取值（extensions/common/extension.h 的 Extension::Location） */
const LOCATION_LABELS = {
  1: "商店安装",
  2: "外部清单",
  3: "外部注册表",
  4: "开发者未打包",
  5: "组件",
  6: "外部预置下载",
  7: "策略预置下载",
  8: "命令行加载",
  9: "策略下发",
  10: "外部组件",
};

/** Windrise / BrowserOS 自带插件的名字前缀：这些不是用户自己装的，绝不同步 */
const BUILTIN_NAME_PATTERN = /^(windrise|browseros|browserclaw)/i;

/** id 是不是合法 Chrome 插件 id */
function isValidExtensionId(id) {
  return typeof id === "string" && EXTENSION_ID_PATTERN.test(id);
}

/** 版本号是否合法 */
function isValidExtensionVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return false;
  return version.split(".").every((part) => Number(part) <= 65535);
}

/** 路径里有没有 `..` 段（Windows / POSIX 两种分隔符都认） */
function hasParentSegment(target) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(String(target ?? ""));
}

/** 绝对路径判断（win32 上 path.isAbsolute 认盘符；自测里在 Windows 跑，这里只做双保险） */
function isAbsolutePath(target) {
  const text = String(target ?? "");
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text);
}

const PROFILE_PREF_FILES = ["Preferences", "Secure Preferences"];

/**
 * 检查一条路径本身和它的父目录是不是符号链接 / 联接点。
 * 只 lstat，不跟随；路径不存在不算错（调用方决定缺文件怎么办）。
 * @returns {{ok: boolean, missing?: boolean, reason?: string}}
 */
function checkNoSymlink(target) {
  let stat = null;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, missing: true };
    return { ok: false, reason: `看不了 ${target}：${error.message}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: `路径是符号链接/联接点，拒绝：${target}` };
  return { ok: true };
}

/**
 * 源插件的安装路径校验（第 3、4 道）：
 * 必须绝对、不含 `..`、落在资料目录里；存在的话还不能是符号链接。
 * @returns {{ok: true, missing?: boolean}|{ok: false, reason: string}}
 */
function checkExtensionPath(userDataDir, rawPath) {
  const text = String(rawPath ?? "");
  if (!text) return { ok: true };
  if (text.includes("\0")) return { ok: false, reason: "插件路径里有不可见字符，拒绝" };
  if (hasParentSegment(text)) return { ok: false, reason: `插件路径含 ..，拒绝：${text.slice(0, 200)}` };
  if (!isAbsolutePath(text)) return { ok: false, reason: `插件路径不是绝对路径，拒绝：${text.slice(0, 200)}` };
  const root = path.resolve(String(userDataDir ?? ""));
  const resolved = path.resolve(text);
  if (!isPathInside(root, resolved)) {
    return { ok: false, reason: `插件路径跑出了格子的资料目录，拒绝：${text.slice(0, 200)}` };
  }
  const checked = checkNoSymlink(resolved);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  if (checked.missing) return { ok: true, missing: true };
  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    return { ok: false, reason: `看不了插件路径：${error.message}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: `插件路径不是目录，拒绝：${text.slice(0, 200)}` };
  return { ok: true };
}

/**
 * update_url 校验：只收 http(s)；源插件没写就用商店默认地址。
 * @returns {{ok: true, url: string, source: "manifest"|"default"}|{ok: false, reason: string}}
 */
function resolveUpdateUrl(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, url: DEFAULT_UPDATE_URL, source: "default" };
  }
  if (typeof raw !== "string") return { ok: false, reason: "update_url 不是字符串，拒绝" };
  const text = raw.trim();
  if (!text) return { ok: true, url: DEFAULT_UPDATE_URL, source: "default" };
  if (text.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, reason: "update_url 太长或含空白/控制字符，拒绝" };
  }
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: `update_url 不是合法网址，拒绝：${text.slice(0, 120)}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `update_url 只能是 http(s)，拒绝：${text.slice(0, 120)}` };
  }
  return { ok: true, url: text, source: "manifest" };
}

/** 读一个 Preferences 文件里的 extensions.settings；文件不在 / 读坏了都返回空表 + 原因 */
function readSettingsFile(file) {
  const checked = checkNoSymlink(file);
  if (!checked.ok) return { settings: {}, error: checked.reason };
  if (checked.missing) return { settings: {}, missing: true };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { settings: {}, error: `${path.basename(file)} 读不了或不是合法 JSON：${error.message}` };
  }
  const settings = parsed?.extensions?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { settings: {}, empty: true };
  }
  return { settings };
}

/**
 * 读一个格子里「用户自己从商店装的插件」。
 *
 * 数据来源和 Chromium 一致：<资料目录>/Default/Preferences 和 Secure Preferences 里的
 * extensions.settings；两份都读，同一个 id 以 Secure Preferences 为准（新版 Chrome 把扩展设置放那边）。
 *
 * 排除：组件扩展（location 5）、未打包 / 命令行加载（4 / 8）、外部下发 / 策略（2 / 3 / 6 / 7 / 9 / 10）、
 * Windrise / BrowserOS 自带插件、id 或版本不合法、路径含 .. 或跑出资料目录、路径是符号链接。
 *
 * @param {string} userDataDir 格子的资料目录（浏览器的 --user-data-dir）
 * @returns {{ok: true, extensions: Array<{id: string, name: string, version: string, updateUrl: string, updateUrlSource: string, enabled: boolean}>, skipped: Array<{id: string, reason: string}>, files: string[], warnings: string[]}
 *   |{ok: false, error: string}}
 */
function readInstalledExtensions(userDataDir) {
  const root = path.resolve(String(userDataDir ?? ""));
  if (!root || String(userDataDir ?? "").trim() === "") return { ok: false, error: "没有资料目录，读不了插件" };
  if (!isAbsolutePath(String(userDataDir)) || hasParentSegment(String(userDataDir))) {
    return { ok: false, error: `资料目录不合法（要绝对路径、不含 ..）：${String(userDataDir).slice(0, 200)}` };
  }
  const rootCheck = checkNoSymlink(root);
  if (!rootCheck.ok) return { ok: false, error: rootCheck.reason };
  if (rootCheck.missing) return { ok: false, error: `格子的资料目录不存在：${root}` };
  const profileDir = path.join(root, PROFILE_DIR);
  const profileCheck = checkNoSymlink(profileDir);
  if (!profileCheck.ok) return { ok: false, error: profileCheck.reason };

  const settings = new Map();
  const files = [];
  const problems = [];
  for (const name of PROFILE_PREF_FILES) {
    const file = path.join(profileDir, name);
    const read = readSettingsFile(file);
    if (read.error) problems.push(read.error);
    if (read.error || read.missing) continue;
    if (Object.keys(read.settings).length) files.push(file);
    for (const [id, entry] of Object.entries(read.settings)) {
      if (entry && typeof entry === "object") settings.set(id, entry);
    }
  }
  if (!files.length) {
    return {
      ok: false,
      error: problems.length
        ? `读不了这个格子的插件清单：${problems.join("；")}`
        : `这个格子的 Preferences 里还没有插件记录（没启动过浏览器，或者还没装插件）：${profileDir}`,
    };
  }

  const extensions = [];
  const skipped = [];
  for (const [id, entry] of settings) {
    if (!isValidExtensionId(id)) {
      skipped.push({ id: String(id).slice(0, 80), reason: "插件 id 不是 32 位小写 a~p" });
      continue;
    }
    const location = Number(entry.location);
    if (location !== 1) {
      const label = LOCATION_LABELS[location] || `location ${location || "未标注"}`;
      skipped.push({ id, reason: `不是用户从商店装的（${label}）` });
      continue;
    }
    const manifest = entry.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      skipped.push({ id, reason: "没有 manifest，判断不了版本和更新地址" });
      continue;
    }
    const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
    if (!isValidExtensionVersion(version)) {
      skipped.push({ id, reason: `版本号不合法：${version.slice(0, 40) || "（空）"}` });
      continue;
    }
    const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
    if (BUILTIN_NAME_PATTERN.test(name)) {
      skipped.push({ id, reason: `Windrise / BrowserOS 自带插件（${name.slice(0, 40)}），不同步` });
      continue;
    }
    const pathCheck = checkExtensionPath(root, entry.path);
    if (!pathCheck.ok) {
      skipped.push({ id, reason: pathCheck.reason });
      continue;
    }
    const url = resolveUpdateUrl(manifest.update_url);
    if (!url.ok) {
      skipped.push({ id, reason: url.reason });
      continue;
    }
    extensions.push({
      id,
      name: name.slice(0, 200) || id,
      version,
      updateUrl: url.url,
      updateUrlSource: url.source,
      enabled: Number(entry.state) !== 0,
    });
  }

  if (skipped.length > 200) skipped.length = 200;
  return { ok: true, extensions, skipped, files, warnings: problems };
}

/**
 * 准备目标格子的 `External Extensions` 目录。
 * 资料目录必须已经存在（格子至少启动过一次），整条路径不许是符号链接。
 * @returns {{ok: true, dir: string, created: boolean}|{ok: false, error: string}}
 */
function ensureExternalExtensionsDir(userDataDir) {
  const raw = String(userDataDir ?? "");
  if (!raw.trim()) return { ok: false, error: "没有资料目录，写不了插件清单" };
  if (!isAbsolutePath(raw) || hasParentSegment(raw)) {
    return { ok: false, error: `资料目录不合法（要绝对路径、不含 ..）：${raw.slice(0, 200)}` };
  }
  const root = path.resolve(raw);
  const rootCheck = checkNoSymlink(root);
  if (!rootCheck.ok) return { ok: false, error: rootCheck.reason };
  if (rootCheck.missing) return { ok: false, error: `格子的资料目录不存在：${root}` };
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) return { ok: false, error: `格子的资料目录不是目录：${root}` };

  const dir = path.join(root, EXTERNAL_EXTENSIONS_DIR);
  if (!isPathInside(root, dir)) return { ok: false, error: "算出来的清单目录跑出资料目录，拒绝" };
  const before = checkNoSymlink(dir);
  if (!before.ok) return { ok: false, error: before.reason };
  const created = Boolean(before.missing);
  if (created) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, error: `建不了 External Extensions 目录：${error.message}` };
    }
  }
  // mkdir 之后再查一次：目录可能本来就是别人放好的联接点
  const after = checkNoSymlink(dir);
  if (!after.ok) return { ok: false, error: after.reason };
  if (after.missing) return { ok: false, error: `External Extensions 目录不见了：${dir}` };
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return { ok: false, error: `External Extensions 不是目录：${dir}` };
  return { ok: true, dir, created };
}

/**
 * 写一个插件的外部清单文件：`<External Extensions>/<id>.json`。
 * 先校验四道，再原子写（临时文件 + rename），写完回读核对。
 * 已有的同名符号链接先 unlink 掉（只删链接本身，不跟随）；同名目录直接拒绝。
 * @returns {{ok: true, file: string}|{ok: false, reason: string}}
 */
function writeExternalManifest(dir, record) {
  const id = String(record?.id ?? "");
  if (!isValidExtensionId(id)) return { ok: false, reason: `插件 id 不合法（要 32 位小写 a~p）：${id.slice(0, 40) || "（空）"}` };
  const version = String(record?.version ?? "");
  if (!isValidExtensionVersion(version)) return { ok: false, reason: `插件 ${id} 的版本号不合法：${version.slice(0, 40) || "（空）"}` };
  const url = resolveUpdateUrl(record?.updateUrl);
  if (!url.ok) return { ok: false, reason: `插件 ${id} 的 ${url.reason}` };

  const file = path.join(dir, `${id}.json`);
  if (!isPathInside(dir, file)) return { ok: false, reason: `算出来的清单路径跑出 External Extensions，拒绝：${file}` };

  let existing = null;
  try {
    existing = fs.lstatSync(file);
  } catch {
    existing = null;
  }
  if (existing?.isDirectory()) return { ok: false, reason: `同名目录挡住了清单文件，拒绝：${file}` };
  if (existing?.isSymbolicLink()) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      return { ok: false, reason: `删不掉同名的符号链接/联接点：${error.message}` };
    }
  }

  const payload = `${JSON.stringify({ external_update_url: url.url })}\n`;
  const tmp = path.join(dir, `.${id}.json.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件也删不掉就算了 */ }
    return { ok: false, reason: `清单写不进去：${error.message}` };
  }

  // 回读核对：写进去的必须刚好是这一行（防止被别的东西中途改掉）
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.external_update_url !== url.url) throw new Error("回读的 external_update_url 对不上");
  } catch (error) {
    return { ok: false, reason: `写完回读核对失败：${error.message}` };
  }
  return { ok: true, file };
}

/**
 * 把一批插件的外部清单写进一个格子的资料目录。
 * 只写清单，不复制插件文件、不碰任何数据目录、不改 Preferences。
 * @param {string} userDataDir 目标格子的资料目录
 * @param {Array<{id: string, version: string, updateUrl: string}>} extensions 要同步的插件
 * @returns {{ok: boolean, dir?: string, expected: number, written: number, missing: string[], rejected: Array<{id: string, reason: string}>, error?: string}}
 */
function syncExtensionsToProfile(userDataDir, extensions) {
  const list = (Array.isArray(extensions) ? extensions : []).filter((item) => item && typeof item === "object");
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item.id ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  const selected = unique.slice(0, MAX_SYNC_EXTENSIONS);
  const rejected = unique.slice(MAX_SYNC_EXTENSIONS).map((item) => ({
    id: String(item.id ?? "").slice(0, 80),
    reason: `单次最多同步 ${MAX_SYNC_EXTENSIONS} 个插件，这个没写`,
  }));
  const expected = selected.length;

  const target = ensureExternalExtensionsDir(userDataDir);
  if (!target.ok) {
    const missing = selected.map((item) => String(item.id ?? ""));
    return { ok: false, expected, written: 0, missing, rejected, error: target.error };
  }

  let written = 0;
  const missing = [];
  for (const item of selected) {
    const id = String(item.id ?? "");
    const result = writeExternalManifest(target.dir, item);
    if (result.ok) {
      written += 1;
      continue;
    }
    missing.push(id);
    rejected.push({ id: id.slice(0, 80), reason: result.reason });
  }
  return {
    ok: missing.length === 0 && rejected.length === 0,
    dir: target.dir,
    expected,
    written,
    missing,
    rejected,
  };
}

module.exports = {
  EXTENSION_ID_PATTERN,
  EXTERNAL_EXTENSIONS_DIR,
  DEFAULT_UPDATE_URL,
  MAX_SYNC_EXTENSIONS,
  PLATFORM_NOTE,
  isValidExtensionId,
  isValidExtensionVersion,
  resolveUpdateUrl,
  readInstalledExtensions,
  ensureExternalExtensionsDir,
  writeExternalManifest,
  syncExtensionsToProfile,
};
