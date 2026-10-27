#!/usr/bin/env node
/**
 * 扩展一键装到所有格子（extension_sync）自测（纯 Node，不启动 Electron、不开浏览器、不联网）。
 *   node electron/extension-sync-selftest.cjs
 *
 * 覆盖：
 *   1. 从源格子的 Preferences / Secure Preferences 里只挑「用户自己从商店装的」插件，组件扩展 / 未打包 /
 *      命令行加载 / Windrise 自带 / 坏 id / 坏版本 / 带 .. 的路径 / 符号链接路径全部排除；
 *   2. 目标格子只多出 `External Extensions/<id>.json` 一份清单，插件登录、Local Extension Settings、
 *      IndexedDB、Extension State、Extension Cookies 和 Preferences 一个字节都不动；
 *   3. 四道校验挡得住坏 id、坏版本、非 http(s) update_url、`..` 路径、External Extensions 是联接点、
 *      同名目录挡路，且不会在目标目录外面落任何文件；
 *   4. BrowserOsProfiles.extensionSync：默认同步到除源格子外的所有格子、to / ids 过滤、开着的格子只提示
 *      「重开生效」而不碰进程、未知格子 / 没启动过的格子明确报错。
 *
 * 所有文件都写在系统临时目录，不碰 data/ 和 ~/.bridge-replica，跑完删掉。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sync = require("./browseros-extension-sync.cjs");
const { BrowserOsProfiles } = require("./browseros-profiles.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "windrise-extsync-"));
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push([name, true, detail]);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}  — ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    const detail = await fn();
    results.push([name, true, detail]);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}  — ${error.message}`);
  }
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const id = (letter) => letter.repeat(32);
const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true });

/** 目录快照：相对路径 -> 「文件内容 / 目录」；用来证明同步只多了一份清单，别的一个字节没动 */
function snapshotTree(base) {
  const out = new Map();
  const walk = (dir, rel = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        out.set(`${relPath}/@link`, fs.readlinkSync(full));
        continue;
      }
      if (stat.isDirectory()) {
        out.set(`${relPath}/@dir`, "");
        walk(full, relPath);
        continue;
      }
      out.set(relPath, fs.readFileSync(full).toString("base64"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out;
}

function diffTrees(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(key);
    else if (before.get(key) !== value) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return { added, removed, changed };
}

/** 给一个格子写一份 Preferences（可选 Secure Preferences） */
function writeProfile(userDataDir, settings, secureSettings = null) {
  const profileDir = path.join(userDataDir, "Default");
  mkdir(profileDir);
  fs.writeFileSync(path.join(profileDir, "Preferences"), JSON.stringify({ extensions: { settings } }, null, 2), "utf8");
  if (secureSettings) {
    fs.writeFileSync(path.join(profileDir, "Secure Preferences"), JSON.stringify({ extensions: { settings: secureSettings } }, null, 2), "utf8");
  }
}

/** 造一个「已安装版本目录」（只为让源路径校验通过） */
function makeInstalledDir(userDataDir, extId, version = "1.0") {
  const dir = path.join(userDataDir, "Default", "Extensions", extId, version);
  mkdir(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: extId, version }), "utf8");
  return dir;
}

const STORE_A = id("a");      // 正常商店插件，用默认 update_url
const STORE_B = id("b");      // 只在 Secure Preferences 里，带自己的 update_url
const COMPONENT_C = id("c");  // 组件扩展
const UNPACKED_D = id("d");   // 开发者未打包
const CMDLINE_E = id("e");    // 命令行加载
const BUILTIN_F = id("f");    // Windrise 自带
const BADVER_G = id("g");
const ESCAPE_H = id("h");     // 路径跑出资料目录
const SYMLINK_I = id("i");    // 安装路径是联接点
const DOTDOT_J = id("j");     // 路径里有 ..
const BADURL_K = id("k");     // update_url 是 javascript:

let sourceDir = "";
let targetDir = "";
let readResult = null;

async function main() {
  /* ---------------- 1. 读源格子 ---------------- */
  sourceDir = path.join(root, "profiles", "src");
  targetDir = path.join(root, "profiles", "dst");
  mkdir(sourceDir);
  mkdir(targetDir);
  const aDir = makeInstalledDir(sourceDir, STORE_A, "1.2.3");
  makeInstalledDir(sourceDir, STORE_B, "2.0");
  makeInstalledDir(sourceDir, BADVER_G);
  makeInstalledDir(sourceDir, ESCAPE_H);
  makeInstalledDir(sourceDir, DOTDOT_J);
  makeInstalledDir(sourceDir, BADURL_K);

  // 联接点：装出来的目录其实是别处的
  const linkTarget = path.join(root, "link-target");
  mkdir(linkTarget);
  const linkPath = path.join(sourceDir, "Default", "Extensions", SYMLINK_I, "1.0");
  mkdir(path.dirname(linkPath));
  fs.symlinkSync(linkTarget, linkPath, "junction");

  writeProfile(sourceDir, {
    [STORE_A]: {
      state: 1,
      location: 1,
      path: aDir,
      manifest: { name: "商店插件甲", version: "1.2.3" },
    },
    [COMPONENT_C]: { location: 5, manifest: { name: "组件扩展", version: "1.0" } },
    [UNPACKED_D]: { location: 4, manifest: { name: "未打包", version: "1.0" } },
    [CMDLINE_E]: { location: 8, manifest: { name: "命令行加载", version: "1.0" } },
    [BUILTIN_F]: { location: 1, manifest: { name: "Windrise 助手", version: "1.8.0" } },
    "ZZZZ": { location: 1, manifest: { name: "坏 id", version: "1.0" } },
    [BADVER_G]: { location: 1, path: path.join(sourceDir, "Default", "Extensions", BADVER_G, "1.0"), manifest: { name: "坏版本", version: "1.2.3.4.5" } },
    [ESCAPE_H]: { location: 1, path: path.join(root, "..", "evil"), manifest: { name: "跑出去了", version: "1.0" } },
    [DOTDOT_J]: { location: 1, path: `${path.join(sourceDir, "Default", "Extensions")}${path.sep}..${path.sep}${DOTDOT_J}${path.sep}1.0`, manifest: { name: "路径带 ..", version: "1.0" } },
    [SYMLINK_I]: { location: 1, path: linkPath, manifest: { name: "联接点", version: "1.0" } },
    [BADURL_K]: { location: 1, path: path.join(sourceDir, "Default", "Extensions", BADURL_K, "1.0"), manifest: { name: "坏更新地址", version: "1.0", update_url: "javascript:alert(1)" } },
  }, {
    [STORE_B]: {
      state: 0,
      location: 1,
      path: path.join(sourceDir, "Default", "Extensions", STORE_B, "2.0"),
      manifest: { name: "自建更新源", version: "2.0", update_url: "https://updates.example.test/service/update2/crx" },
    },
  });

  readResult = sync.readInstalledExtensions(sourceDir);
  check("读源格子：只留用户自己从商店装的插件（Secure Preferences 也读）", () => {
    assert.equal(readResult.ok, true);
    assert.deepEqual(readResult.extensions.map((item) => item.id).sort(), [STORE_A, STORE_B].sort());
    const a = readResult.extensions.find((item) => item.id === STORE_A);
    const b = readResult.extensions.find((item) => item.id === STORE_B);
    assert.equal(a.updateUrl, sync.DEFAULT_UPDATE_URL);
    assert.equal(a.updateUrlSource, "default");
    assert.equal(a.enabled, true);
    assert.equal(b.updateUrl, "https://updates.example.test/service/update2/crx");
    assert.equal(b.updateUrlSource, "manifest");
    assert.equal(b.enabled, false);
    return `${readResult.extensions.length} 个可用 / ${readResult.skipped.length} 个被排除`;
  });

  check("读源格子：组件 / 未打包 / 命令行 / 自带 / 坏 id / 坏版本 / .. / 联接点 / 坏 update_url 全被挡下", () => {
    const reasons = new Map(readResult.skipped.map((item) => [item.id, item.reason]));
    for (const [extId, pattern] of [
      [COMPONENT_C, /组件/],
      [UNPACKED_D, /未打包/],
      [CMDLINE_E, /命令行/],
      [BUILTIN_F, /自带插件/],
      [BADVER_G, /版本号不合法/],
      [ESCAPE_H, /跑出了格子的资料目录/],
      [DOTDOT_J, /含 \.\./],
      [SYMLINK_I, /符号链接|联接点/],
      [BADURL_K, /http\(s\)/],
    ]) {
      assert.ok(reasons.has(extId), `应该被排除：${extId}`);
      assert.match(reasons.get(extId), pattern, `${extId} 的原因不对：${reasons.get(extId)}`);
    }
    assert.ok([...reasons.keys()].some((key) => key.startsWith("ZZZZ")), "坏 id 应该被排除");
    return `${reasons.size} 条排除原因`;
  });

  /* ---------------- 2. 只写清单，不碰数据目录 ---------------- */
  // 目标格子里先摆好各种「扩展数据」哨兵：同步后必须一个字节都不变
  const dstProfile = path.join(targetDir, "Default");
  mkdir(dstProfile);
  fs.writeFileSync(path.join(targetDir, "Default", "Preferences"), JSON.stringify({ extensions: { settings: {} } }, null, 2), "utf8");
  const sentinels = [
    "Local Extension Settings/" + STORE_A + "/000001.ldb",
    "Sync Extension Settings/" + STORE_A + "/000002.ldb",
    "Managed Extension Settings/" + STORE_A + "/data",
    "Extension State/" + STORE_A,
    "Extension Cookies",
    "IndexedDB/https_www.example.test_0.indexeddb.leveldb/LOG",
    "Service Worker/CacheStorage/x",
  ];
  for (const rel of sentinels) {
    const file = path.join(dstProfile, rel);
    mkdir(path.dirname(file));
    fs.writeFileSync(file, `sentinel:${rel}`, "utf8");
  }
  const before = snapshotTree(targetDir);

  let writeResult = null;
  check("写目标格子：清单 2/2，missing 为空", () => {
    writeResult = sync.syncExtensionsToProfile(targetDir, readResult.extensions);
    assert.equal(writeResult.ok, true, writeResult.error || JSON.stringify(writeResult.rejected));
    assert.equal(writeResult.expected, 2);
    assert.equal(writeResult.written, 2);
    assert.deepEqual(writeResult.missing, []);
    assert.deepEqual(writeResult.rejected, []);
    return writeResult.dir;
  });

  check("清单内容：只有 external_update_url 一行", () => {
    const aFile = path.join(targetDir, "External Extensions", `${STORE_A}.json`);
    const bFile = path.join(targetDir, "External Extensions", `${STORE_B}.json`);
    assert.deepEqual(readJson(aFile), { external_update_url: sync.DEFAULT_UPDATE_URL });
    assert.deepEqual(readJson(bFile), { external_update_url: "https://updates.example.test/service/update2/crx" });
    const dirEntries = fs.readdirSync(path.join(targetDir, "External Extensions")).sort();
    assert.deepEqual(dirEntries, [`${STORE_A}.json`, `${STORE_B}.json`].sort(), "目录里不该有临时文件");
    return dirEntries.join("、");
  });

  check("数据隔离：只有 External Extensions 多了清单，插件数据 / Preferences 一个字节没动", () => {
    const after = snapshotTree(targetDir);
    const diff = diffTrees(before, after);
    const expectedAdded = [
      "External Extensions/@dir",
      `External Extensions/${STORE_A}.json`,
      `External Extensions/${STORE_B}.json`,
    ];
    assert.deepEqual(diff.added.sort(), expectedAdded.sort(), `多出来的东西不对：${diff.added.join("、")}`);
    assert.deepEqual(diff.removed, [], `不该删东西：${diff.removed.join("、")}`);
    assert.deepEqual(diff.changed, [], `不该改东西：${diff.changed.join("、")}`);
    // 明确点名最要命的那几个：登录数据目录和 Preferences
    for (const rel of sentinels) {
      assert.equal(fs.readFileSync(path.join(dstProfile, rel), "utf8"), `sentinel:${rel}`);
    }
    assert.deepEqual(readJson(path.join(dstProfile, "Preferences")), { extensions: { settings: {} } });
    return `哨兵 ${sentinels.length} 个全部原样`;
  });

  /* ---------------- 3. 校验挡坏东西 ---------------- */
  check("坏 id / 坏版本 / 非 http(s) update_url 不落盘", () => {
    const dir = path.join(root, "validation-target");
    mkdir(dir);
    const result = sync.syncExtensionsToProfile(dir, [
      { id: "../../escape", version: "1.0", updateUrl: sync.DEFAULT_UPDATE_URL },
      { id: "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", version: "1.0", updateUrl: sync.DEFAULT_UPDATE_URL },
      { id: STORE_A, version: "1.2.3.4.5", updateUrl: sync.DEFAULT_UPDATE_URL },
      { id: STORE_B, version: "2.0", updateUrl: "javascript:alert(1)" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.written, 0);
    assert.equal(result.missing.length, 4);
    assert.equal(result.rejected.length, 4);
    assert.deepEqual(fs.readdirSync(path.join(dir, "External Extensions")), [], "一个清单都不该写");
    assert.ok(!fs.existsSync(path.join(root, "escape.json")), "不能写到 External Extensions 外面");
    return result.rejected.map((item) => item.reason).join(" / ").slice(0, 120);
  });

  check("External Extensions 是联接点：拒绝写入，联接目标里不多东西", () => {
    const outside = path.join(root, "outside-target");
    mkdir(outside);
    const dir = path.join(root, "junction-target");
    mkdir(dir);
    fs.symlinkSync(outside, path.join(dir, "External Extensions"), "junction");
    const result = sync.syncExtensionsToProfile(dir, [{ id: STORE_A, version: "1.2.3", updateUrl: sync.DEFAULT_UPDATE_URL }]);
    assert.equal(result.ok, false);
    assert.equal(result.written, 0);
    assert.match(result.error, /符号链接|联接点/);
    assert.deepEqual(fs.readdirSync(outside), [], "联接点指向的目录不该被写");
    return result.error;
  });

  check("同名目录挡住清单文件：拒绝，不删别人的目录", () => {
    const dir = path.join(root, "blocked-target");
    mkdir(path.join(dir, "External Extensions", `${STORE_A}.json`), { recursive: true });
    const result = sync.syncExtensionsToProfile(dir, [{ id: STORE_A, version: "1.2.3", updateUrl: sync.DEFAULT_UPDATE_URL }]);
    assert.equal(result.ok, false);
    assert.equal(result.written, 0);
    assert.match(result.rejected[0].reason, /同名目录/);
    assert.ok(fs.statSync(path.join(dir, "External Extensions", `${STORE_A}.json`)).isDirectory(), "目录不能被删");
    return result.rejected[0].reason;
  });

  check("资料目录不存在：明确报错，不自己建目录", () => {
    const missing = path.join(root, "no-such-profile");
    const result = sync.syncExtensionsToProfile(missing, [{ id: STORE_A, version: "1.2.3", updateUrl: sync.DEFAULT_UPDATE_URL }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /资料目录不存在/);
    assert.equal(fs.existsSync(missing), false);
    return result.error;
  });

  check("没有 Preferences 的格子：读出来是失败，不假装没插件", () => {
    const empty = path.join(root, "never-launched");
    mkdir(path.join(empty, "Default"));
    const read = sync.readInstalledExtensions(empty);
    assert.equal(read.ok, false);
    assert.match(read.error, /Preferences/);
    return read.error.slice(0, 60);
  });

  /* ---------------- 4. BrowserOsProfiles.extensionSync ---------------- */
  await checkAsync("extensionSync：默认同步到除源格子外的所有格子，源格子不动", async () => {
    const dataHome = path.join(root, "home");
    const engineCalls = [];
    // 除「算资料目录」外的任何引擎调用都算违规：extension_sync 不许开 / 关 / 重启格子
    const engine = new Proxy({}, {
      get(_target, prop) {
        if (prop === "defaultUserDataDir") {
          return (home, profileId) => {
            engineCalls.push(`defaultUserDataDir:${profileId}`);
            return path.join(home, "browseros", "profiles", profileId);
          };
        }
        return () => {
          engineCalls.push(`unexpected:${String(prop)}`);
          throw new Error(`extension_sync 不该调引擎的 ${String(prop)}`);
        };
      },
    });
    const accounts = [
      { id: "aaa", name: "格子 1" },
      { id: "bbb", name: "格子 2" },
      { id: "ccc", name: "格子 3" },
    ];
    const backend = new BrowserOsProfiles({ dataHome, engine, listProfiles: () => accounts });
    const src = backend.userDataDirOf("aaa");
    const bDir = backend.userDataDirOf("bbb");
    const cDir = backend.userDataDirOf("ccc");
    mkdir(src);
    mkdir(bDir);
    mkdir(cDir);
    makeInstalledDir(src, STORE_A, "1.2.3");
    writeProfile(src, {
      [STORE_A]: { state: 1, location: 1, path: path.join(src, "Default", "Extensions", STORE_A, "1.2.3"), manifest: { name: "商店插件甲", version: "1.2.3" } },
    });

    engineCalls.length = 0;
    const result = await backend.extensionSync({ from: "格子 1" });
    assert.equal(result.from.id, "aaa");
    assert.equal(result.autoInstallOnNextLaunch, true);
    assert.equal(result.sourceHint, null);
    assert.match(result.platformNote, /External Extensions/);
    assert.match(result.note, /下次启动时浏览器会自己安装/);
    assert.deepEqual(result.grids.map((grid) => grid.id).sort(), ["bbb", "ccc"]);
    for (const grid of result.grids) {
      assert.equal(grid.expected, 1);
      assert.equal(grid.written, 1);
      assert.deepEqual(grid.missing, []);
      assert.equal(grid.ok, true);
    }
    assert.ok(fs.existsSync(path.join(bDir, "External Extensions", `${STORE_A}.json`)));
    assert.ok(fs.existsSync(path.join(cDir, "External Extensions", `${STORE_A}.json`)));
    assert.equal(fs.existsSync(path.join(src, "External Extensions")), false, "源格子不该被写");
    // 只有算资料目录的调用，没有任何「打开 / 关掉 / 重启」的引擎动作
    assert.ok(engineCalls.every((call) => call.startsWith("defaultUserDataDir:")), `意外调了引擎：${engineCalls.join("、")}`);
    assert.deepEqual([...new Set(engineCalls.map((call) => call.split(":")[1]))].sort(), ["aaa", "bbb", "ccc"]);
    return `${result.grids.length} 个格子各写 1 份清单`;
  });

  await checkAsync("extensionSync：开着的格子只提示「重开生效」，不重启；关着的格子不给提示", async () => {
    const dataHome = path.join(root, "home2");
    const engine = { defaultUserDataDir: (home, profileId) => path.join(home, "browseros", "profiles", profileId) };
    const accounts = [{ id: "aaa", name: "格子 1" }, { id: "bbb", name: "格子 2" }, { id: "ccc", name: "格子 3" }];
    const backend = new BrowserOsProfiles({ dataHome, engine, listProfiles: () => accounts });
    const src = backend.userDataDirOf("aaa");
    for (const acc of accounts) mkdir(backend.userDataDirOf(acc.id));
    makeInstalledDir(src, STORE_A, "1.2.3");
    writeProfile(src, {
      [STORE_A]: { state: 1, location: 1, path: path.join(src, "Default", "Extensions", STORE_A, "1.2.3"), manifest: { name: "商店插件甲", version: "1.2.3" } },
    });
    // 只登记「开着」，不碰真浏览器
    backend.entriesMap.set("aaa", { id: "aaa", slot: 1, profile: { name: "格子 1" } });
    backend.entriesMap.set("bbb", { id: "bbb", slot: 2, profile: { name: "格子 2" } });
    const result = await backend.extensionSync({ from: "aaa" });
    assert.match(result.sourceHint, /Preferences/);
    const running = result.grids.find((grid) => grid.id === "bbb");
    const closed = result.grids.find((grid) => grid.id === "ccc");
    assert.equal(running.running, true);
    assert.equal(running.slot, 2);
    assert.match(running.restartHint, /重开这个格子后/);
    assert.equal(closed.running, false);
    assert.equal(closed.restartHint, null);
    return "bbb 开着（只提示）/ ccc 关着";
  });

  await checkAsync("extensionSync：to 与 ids 过滤、未知插件与坏 id 如实报出来", async () => {
    const dataHome = path.join(root, "home3");
    const engine = { defaultUserDataDir: (home, profileId) => path.join(home, "browseros", "profiles", profileId) };
    const accounts = [{ id: "aaa", name: "格子 1" }, { id: "bbb", name: "格子 2" }, { id: "ccc", name: "格子 3" }];
    const backend = new BrowserOsProfiles({ dataHome, engine, listProfiles: () => accounts });
    const src = backend.userDataDirOf("aaa");
    for (const acc of accounts) mkdir(backend.userDataDirOf(acc.id));
    makeInstalledDir(src, STORE_A, "1.2.3");
    writeProfile(src, {
      [STORE_A]: { state: 1, location: 1, path: path.join(src, "Default", "Extensions", STORE_A, "1.2.3"), manifest: { name: "商店插件甲", version: "1.2.3" } },
    });
    const result = await backend.extensionSync({ from: "aaa", to: ["ccc"], ids: [STORE_A, id("n")] });
    assert.deepEqual(result.grids.map((grid) => grid.id), ["ccc"]);
    assert.deepEqual(result.badIds, []);
    assert.deepEqual(result.notInSource, [id("n")]);
    assert.ok(fs.existsSync(path.join(backend.userDataDirOf("ccc"), "External Extensions", `${STORE_A}.json`)));
    assert.equal(fs.existsSync(path.join(backend.userDataDirOf("bbb"), "External Extensions")), false);

    const bad = await backend.extensionSync({ from: "aaa", to: ["有没有这个格子"], ids: ["not-an-extension-id"] });
    assert.deepEqual(bad.targetIssues.map((item) => item.target), ["有没有这个格子"]);
    assert.deepEqual(bad.badIds, ["not-an-extension-id"]);
    assert.deepEqual(bad.grids, []);
    return "to / ids / targetIssues 都对";
  });

  await checkAsync("extensionSync：源格子不存在 / 没启动过浏览器都明确报错", async () => {
    const dataHome = path.join(root, "home4");
    const engine = { defaultUserDataDir: (home, profileId) => path.join(home, "browseros", "profiles", profileId) };
    const accounts = [{ id: "aaa", name: "格子 1" }, { id: "bbb", name: "格子 2" }];
    const backend = new BrowserOsProfiles({ dataHome, engine, listProfiles: () => accounts });
    for (const acc of accounts) mkdir(backend.userDataDirOf(acc.id));
    await assert.rejects(() => backend.extensionSync({ from: "不存在" }), (error) => error.code === "INVALID_ARGUMENT");
    await assert.rejects(() => backend.extensionSync({ from: "aaa" }), (error) => error.code === "EXTENSION_READ_FAILED" && /Preferences/.test(error.message));
    return "INVALID_ARGUMENT / EXTENSION_READ_FAILED";
  });
}

main()
  .catch((error) => {
    results.push(["未捕获异常", false, error.stack || error.message]);
    console.log(`FAIL  未捕获异常  — ${error.stack || error.message}`);
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log("");
    const failed = results.filter(([, ok]) => !ok);
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    process.exit(failed.length ? 1 : 0);
  });
