/**
 * 共享插件库（产品计划 2026-10-26「插件装到所有格子」）：
 * 一个格子里从 Chrome 应用商店装的插件，复制一份插件文件放到这里，别的格子开窗时一起加载。
 *
 * 它管什么：
 *   - 共享插件库的目录和清单：<dataHome>\shared-extensions\<插件id>\（插件文件的一份拷贝）
 *     和 <dataHome>\shared-extensions.json（清单：[{id, name, version, addedAt, fromProfile, enabled}]）；
 *   - 从某个格子的安装目录把插件拷进来：只拷 <格子资料目录>\Default\Extensions\<id>\<版本>\ 下的文件，
 *     绝不碰 Local Extension Settings / IndexedDB / Sync Extension Settings 这些数据目录；
 *   - 拷贝前后的校验：id 只允许 [a-p]{32}（Chrome 插件 id 格式）、源路径必须在那个格子的 Extensions
 *     目录里、路径上任何一层是符号链接/联接点就拒绝、单个插件总大小上限 200MB、manifest.json 必须带
 *     key 字段（商店装的都有；没有 key 的插件 --load-extension 加载出来 id 会变，装到别的格子对不上）；
 *   - 更新覆盖：同一个 id 再拷一次就是「商店版升级了」，整个目标目录换新、清单里的版本更新。
 *
 * 它不管什么：
 *   - 怎么把目录喂给 --load-extension（browseros-engine.cjs）；
 *   - 运行中的格子怎么装卸（browseros-profiles.cjs 经 CDP 的 Extensions.loadUnpacked / uninstall）；
 *   - 面板怎么显示（panel-state.cjs 只透传 id / name / version / enabled，不给路径）。
 *
 * 安全规矩（需求点名）：
 *   - 所有文件操作都在 dataHome 里；路径只从校验过的 id 拼，绝不信任插件后台传来的路径；
 *   - 拷贝前后都校验；日志只打印 id / 名字 / 版本，不打印插件文件内容；
 *   - 这份模块不发任何网络请求。
 */

const fs = require("node:fs");
const path = require("node:path");

/** Chrome 插件 id 的格式：32 位小写 a~p */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
/** 单个插件总大小上限 */
const MAX_EXTENSION_BYTES = 200 * 1024 * 1024;
/** 共享库目录名（在 dataHome 下面） */
const EXTENSIONS_DIR = "shared-extensions";
/** 清单文件名（在 dataHome 下面） */
const EXTENSIONS_FILE = "shared-extensions.json";
/** 插件的安装目录相对于格子资料目录的位置 */
const INSTALL_RELATIVE = ["Default", "Extensions"];

/** 目标 id 是不是合法 Chrome 插件 id（32 位 a~p） */
function isValidExtensionId(id) {
  return typeof id === "string" && EXTENSION_ID_PATTERN.test(id);
}

/** child 在不在 parent 下面（含相等）。只做路径形状判断，不要求路径存在 */
function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(String(parent)), path.resolve(String(child)));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** 读清单。文件没有 / 读坏了都当空表（不清、不删、不报错，调用方按「还没有共享插件」处理） */
function readSharedExtensions(dataHome) {
  const file = path.join(path.resolve(String(dataHome ?? "")), EXTENSIONS_FILE);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.extensions) ? parsed.extensions : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? "");
    if (!isValidExtensionId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof item.name === "string" ? item.name.slice(0, 200) : "",
      version: typeof item.version === "string" ? item.version.slice(0, 40) : "",
      addedAt: Number(item.addedAt) > 0 ? Number(item.addedAt) : null,
      fromProfile: typeof item.fromProfile === "string" ? item.fromProfile.slice(0, 64) : "",
      enabled: item.enabled !== false,
    });
  }
  return out;
}

/** 写清单（原子：临时文件 + rename；只收 id 合法的条目） */
async function writeSharedExtensions(dataHome, list) {
  const dir = path.resolve(String(dataHome ?? ""));
  const file = path.join(dir, EXTENSIONS_FILE);
  const clean = (Array.isArray(list) ? list : []).filter((record) => record && isValidExtensionId(record.id));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `建不了数据目录：${error.message}` };
  }
  const payload = `${JSON.stringify({ version: 1, extensions: clean }, null, 2)}\n`;
  const tmp = path.join(dir, `.${EXTENSIONS_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件也删不掉就算了 */ }
    return { ok: false, error: error.message };
  }
  return { ok: true, file };
}

/**
 * 在格子的资料目录里找这个插件「现在装的那个版本」的目录。
 * 只认 <udd>\Default\Extensions\<id>\<版本>\（版本目录里必须有 manifest.json），
 * 有多个版本目录时取最新改动的；路径上任何一层是符号链接/联接点就拒绝。
 * @returns {{ok: true, dir: string}|{ok: false, error: string}}
 */
function findInstalledExtensionVersion(userDataDir, id) {
  if (!isValidExtensionId(id)) return { ok: false, error: `插件 id 不合法（要 32 位小写 a~p）：${String(id).slice(0, 40)}` };
  const root = path.resolve(String(userDataDir ?? ""));
  const extRoot = path.join(root, ...INSTALL_RELATIVE, id);
  for (const p of [root, path.join(root, ...INSTALL_RELATIVE), extRoot]) {
    let st = null;
    try { st = fs.lstatSync(p); } catch { return { ok: false, error: `找不到路径：${p}` }; }
    if (st.isSymbolicLink()) return { ok: false, error: `路径是符号链接/联接点，不动它：${p}` };
    if (!st.isDirectory()) return { ok: false, error: `不是目录：${p}` };
  }
  let names = [];
  try { names = fs.readdirSync(extRoot); } catch { return { ok: false, error: `读不了插件目录：${extRoot}` }; }
  const candidates = [];
  for (const name of names) {
    const dir = path.join(extRoot, name);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
    candidates.push({ dir, mtimeMs: Number(st.mtimeMs) || 0 });
  }
  if (!candidates.length) {
    return { ok: false, error: `插件目录里没有带 manifest.json 的版本目录（这个插件没在这个格子里装，或数据目录是空的）：${extRoot}` };
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, dir: candidates[0].dir };
}

/**
 * 通读一个插件安装目录：路径上不许有符号链接/联接点、总大小不许超上限、
 * manifest.json 必须是合法 JSON 对象。
 * @returns {{ok: true, manifest: object, totalBytes: number, fileCount: number}|{ok: false, error: string}}
 */
function inspectExtensionDir(sourceDir, { maxBytes = MAX_EXTENSION_BYTES } = {}) {
  const root = path.resolve(String(sourceDir ?? ""));
  let rootStat = null;
  try { rootStat = fs.lstatSync(root); } catch { return { ok: false, error: `找不到插件目录：${root}` }; }
  if (rootStat.isSymbolicLink()) return { ok: false, error: `插件目录是符号链接/联接点，拒绝：${root}` };
  if (!rootStat.isDirectory()) return { ok: false, error: `不是目录：${root}` };

  const manifestFile = path.join(root, "manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (error) {
    return { ok: false, error: `manifest.json 读不了或不是合法 JSON：${error.message}` };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, error: "manifest.json 不是 JSON 对象" };
  }

  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_EXTENSION_BYTES;
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (error) { return { ok: false, error: `读不了 ${dir}：${error.message}` }; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st = null;
      try { st = fs.lstatSync(full); } catch (error) { return { ok: false, error: `看不了 ${full}：${error.message}` }; }
      if (st.isSymbolicLink()) {
        return { ok: false, error: `插件里有符号链接/联接点，拒绝（不跟随）：${full}` };
      }
      if (st.isDirectory()) { stack.push(full); continue; }
      totalBytes += Number(st.size) || 0;
      fileCount += 1;
      if (totalBytes > limit) {
        return { ok: false, error: `插件太大：已经 ${totalBytes} 字节，上限 ${limit} 字节（200MB）` };
      }
    }
  }
  return { ok: true, manifest, totalBytes, fileCount };
}

/** 这个 id 在共享库里的目录（只拼路径，不保证存在） */
function extensionDirOf(dataHome, id) {
  if (!isValidExtensionId(id)) return null;
  return path.join(path.resolve(String(dataHome ?? "")), EXTENSIONS_DIR, id);
}

/**
 * 开格子时喂给 --load-extension 的共享插件目录清单：
 * 只收清单里 enabled 的、目录真实存在且带 manifest.json 的、路径不是联接点的。
 */
function extensionDirsForLaunch(dataHome) {
  const root = path.resolve(String(dataHome ?? ""));
  const dirs = [];
  for (const record of readSharedExtensions(root)) {
    if (!record.enabled) continue;
    const dir = path.join(root, EXTENSIONS_DIR, record.id);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
    dirs.push(dir);
  }
  return dirs;
}

/**
 * 把一个插件从格子的安装目录拷进共享库（同一个 id 再拷一次 = 商店版升级，整个覆盖）。
 * @param {{dataHome: string, userDataDir: string, id: string, fromProfile?: string, maxBytes?: number}} options
 * @returns {Promise<{ok: true, record: object, updated: boolean}|{ok: false, error: string}>}
 */
async function copyExtensionToShared({ dataHome, userDataDir, id, fromProfile, maxBytes } = {}) {
  if (!isValidExtensionId(id)) {
    return { ok: false, error: `插件 id 不合法（要 32 位小写 a~p）：${String(id).slice(0, 40)}` };
  }
  const dataRoot = path.resolve(String(dataHome ?? ""));
  if (!dataRoot) return { ok: false, error: "没有数据目录，算不出共享库位置" };
  const udd = path.resolve(String(userDataDir ?? ""));
  // 安全边界：格子的资料目录必须落在数据目录里（路径都从校验过的 id 拼，这里再兜一层）
  if (!udd || !isPathInside(dataRoot, udd)) {
    return { ok: false, error: "格子的资料目录不在数据目录里，拒绝复制" };
  }

  const found = findInstalledExtensionVersion(udd, id);
  if (!found.ok) return found;
  const inspected = inspectExtensionDir(found.dir, { maxBytes });
  if (!inspected.ok) return inspected;

  // 商店装的插件 manifest 里都有 key（保证 --load-extension 加载出来 id 和商店版一致）；
  // 没有 key 的插件同步过去 id 会变，体验不对，直接拒绝并说原因
  if (typeof inspected.manifest.key !== "string" || !inspected.manifest.key.trim()) {
    return {
      ok: false,
      error: "manifest.json 里没有 key 字段：只有商店装的插件带 key。没有 key 的插件同步后 id 会变，登录和设置对不上，所以拒绝同步",
    };
  }

  const dest = path.join(dataRoot, EXTENSIONS_DIR, id);
  const parent = path.join(dataRoot, EXTENSIONS_DIR);
  try {
    if (fs.existsSync(parent)) {
      if (fs.lstatSync(parent).isSymbolicLink()) {
        return { ok: false, error: `共享库目录是符号链接/联接点，拒绝写入：${parent}` };
      }
    }
  } catch (error) {
    return { ok: false, error: `看不了共享库目录：${error.message}` };
  }

  // 更新覆盖：整个目标目录换新
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: `清不掉旧的共享插件目录：${error.message}` };
  }
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (error) {
    return { ok: false, error: `建不了共享库目录：${error.message}` };
  }
  // mkdir 之后再查一次：目录可能本来就是别人放好的联接点
  try {
    if (fs.lstatSync(parent).isSymbolicLink()) {
      return { ok: false, error: `共享库目录是符号链接/联接点，拒绝写入：${parent}` };
    }
  } catch { /* 查不了就不写 */ }
  try {
    fs.cpSync(found.dir, dest, { recursive: true, dereference: false, force: true });
  } catch (error) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 清理不了就算了 */ }
    return { ok: false, error: `复制失败：${error.message}` };
  }

  // 拷完再核对一遍：大小、manifest 都过关才算数
  const verified = inspectExtensionDir(dest, { maxBytes });
  if (!verified.ok) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 同上 */ }
    return { ok: false, error: `拷完核对失败，已清掉：${verified.error}` };
  }

  const existing = await readSharedExtensions(dataRoot);
  const previous = existing.find((record) => record.id === id) || null;
  const record = {
    id,
    name: typeof inspected.manifest.name === "string" ? inspected.manifest.name.slice(0, 200) : id,
    version: typeof inspected.manifest.version === "string" ? inspected.manifest.version.slice(0, 40) : "",
    addedAt: previous?.addedAt || Date.now(),
    fromProfile: String(fromProfile ?? "").slice(0, 64) || previous?.fromProfile || "",
    enabled: previous ? previous.enabled !== false : true,
  };
  const wrote = await writeSharedExtensions(dataRoot, [...existing.filter((item) => item.id !== id), record]);
  if (!wrote.ok) {
    return { ok: false, error: `复制好了但清单写不进去：${wrote.error}` };
  }
  return { ok: true, record, updated: Boolean(previous) };
}

/**
 * 把插件从共享库里删掉（目录 + 清单条目）。
 * 只删共享库里的那一份；商店原装的（在各自格子的资料目录里）一个都不动。
 */
async function removeSharedExtension(dataHome, id) {
  if (!isValidExtensionId(id)) return { removed: false, error: "插件 id 不合法" };
  const root = path.resolve(String(dataHome ?? ""));
  const dir = path.join(root, EXTENSIONS_DIR, id);
  const parent = path.join(root, EXTENSIONS_DIR);
  try {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
      return { removed: false, error: `共享库目录是符号链接/联接点，不动它：${parent}` };
    }
  } catch { /* 查不了就继续 */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, error: `删不掉共享插件目录 ${dir}：${error.message}` };
  }
  const existing = await readSharedExtensions(root);
  const hit = existing.find((record) => record.id === id) || null;
  if (hit) {
    const wrote = await writeSharedExtensions(root, existing.filter((record) => record.id !== id));
    if (!wrote.ok) return { removed: true, record: hit, error: `目录删了但清单没更新：${wrote.error}` };
  }
  return { removed: true, record: hit };
}

module.exports = {
  EXTENSION_ID_PATTERN,
  MAX_EXTENSION_BYTES,
  EXTENSIONS_DIR,
  EXTENSIONS_FILE,
  isValidExtensionId,
  readSharedExtensions,
  writeSharedExtensions,
  findInstalledExtensionVersion,
  inspectExtensionDir,
  extensionDirOf,
  extensionDirsForLaunch,
  copyExtensionToShared,
  removeSharedExtension,
  isPathInside,
};
