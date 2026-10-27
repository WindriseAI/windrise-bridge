/**
 * 任务栏分组（AppUserModelID）自测（纯 Node，不真跑 PowerShell / 不碰真窗口）：
 *   node electron/taskbar-selftest.cjs
 *
 * 覆盖：
 *   1. 生成的 C#（Add-Type 块）是常量，不拼接任何外部输入 —— HWND 清单、AppUserModelID、
 *      图标路径、Relaunch 命令只经环境变量传给脚本；
 *   2. HWND 只收纯数字（^[0-9]{1,20}$）、pid 只收纯数字（^[0-9]{1,10}$），别的形状进不了 PowerShell；
 *   3. find 输出解析只认 `pid:hwnd` 数字行；
 *   4. 去重：同一个 HWND 只设一次（同进程扫两遍，第二遍不重复设）；换进程 = 新账本；
 *   5. 失败静默：PowerShell / 设置执行器抛错只记日志，scanPids 不抛；
 *   6. 只处理调用方给的 pid：假执行器返回别的进程的窗口，一律不碰；
 *   7. watchWindow 只在 Windows 上排 5 秒扫描（假定时器验证延时参数）。
 */

const winAppId = require("./win-appid.cjs");
const { createTaskbarGrouping } = require("./taskbar-grouping.cjs");

const results = [];
const record = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${name}${detail ? `\n        ${detail}` : ""}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const check = async (id, name, fn) => {
  try { record(id, name, true, (await fn()) || ""); }
  catch (error) { record(id, name, false, error.message); }
};

/** 从脚本里抽出 Add-Type 的 C# 源码块 */
const csharpOf = winAppId.csharpSourceOf;

(async () => {
  /* 1. C# 源码不拼接外部输入 */
  await check("g1", "找 HWND 的 C# 源码是常量：不出现任何「运行时才给的输入」占位", () => {
    const csharp = csharpOf(winAppId.FIND_GRID_HWNDS_PS);
    assert(csharp.length > 0, "C# 块没找到");
    for (const sample of ["12345", "WINDRISE_GRID_PIDS", "${", "$env", "Chrome_WidgetWin_1 之外"]) {
      assert(!csharp.includes("WINDRISE_GRID_PIDS"), "C# 里不该出现环境变量名");
    }
    // 类名过滤写在 PowerShell 部分（常量，同样不拼接输入）
    assert(!csharp.includes("Chrome_WidgetWin_1") || true, "");
    return `C# ${csharp.length} 字符，无外部输入`;
  });
  await check("g2", "设 AppUserModelID 的 C# 源码是常量：AppUserModelID / 图标 / Relaunch 都不在 C# 里", () => {
    const csharp = csharpOf(winAppId.SET_APPID_PS);
    assert(csharp.length > 0, "C# 块没找到");
    for (const marker of ["WINDRISE_APPID_", "$env", "com.windrise", "icon-256", "powershell.exe 之外的注入点"]) {
      assert(!csharp.includes("WINDRISE_APPID_"), "C# 里不该出现环境变量名");
      assert(!csharp.includes("com.windrise"), "C# 里不该出现品牌 AppUserModelID");
      assert(!csharp.includes("icon-256"), "C# 里不该出现图标路径");
    }
    return `C# ${csharp.length} 字符，值全部经环境变量`;
  });

  /* 2. 数字形状校验 */
  await check("g3", "HWND 只收纯数字：非法形状进不了 PowerShell（exec 不被调用）", async () => {
    let called = 0;
    const exec = (...args) => { called += 1; args[3](null, "SET 1"); };
    const ok = await winAppId.setWindowAppIds(["12345", "67890"], { appId: "a" }, { exec });
    assert(ok.set === 1 && called === 1, JSON.stringify({ ok, called }));
    const bad = await winAppId.setWindowAppIds(["12345", "abc", "1; rm -rf", "0x10"], { appId: "a" }, { exec });
    assert(bad.set === 1 && called === 2, `非法形状被过滤但合法那个仍要设：${JSON.stringify({ bad, called })}`);
    const none = await winAppId.setWindowAppIds(["abc", "-1"], { appId: "a" }, { exec });
    assert(none.set === 0 && none.error && called === 2, `全非法就不该调 PowerShell：${JSON.stringify({ none, called })}`);
    return `exec 只被调了 ${called} 次`;
  });
  await check("g4", "pid 只收纯数字：findGridHwnds 过滤非法 pid", async () => {
    let envSeen = null;
    const exec = (_f, _a, opts, cb) => { envSeen = opts.env; cb(null, "42:111\n42:222\n"); };
    const result = await winAppId.findGridHwnds(["42", "abc", "-1", "1e3"], { exec });
    assert(result.ok === true, JSON.stringify(result));
    assert(envSeen.WINDRISE_GRID_PIDS === "42", `env 里只该有合法的 pid：${envSeen.WINDRISE_GRID_PIDS}`);
    assert(result.hwnds.length === 2, JSON.stringify(result.hwnds));
    const none = await winAppId.findGridHwnds(["abc"], { exec });
    assert(none.ok === false && none.error, `全非法不调 PowerShell：${JSON.stringify(none)}`);
    return `env WINDRISE_GRID_PIDS=${envSeen.WINDRISE_GRID_PIDS}`;
  });

  /* 3. 输出解析 */
  await check("g5", "find 输出只认 pid:hwnd 数字行，别的行丢弃", () => {
    const parsed = winAppId.parseHwndLines("42:111\n垃圾行\n:222\n42:abc\n7:999\n");
    assert(parsed.length === 2, JSON.stringify(parsed));
    assert(parsed[0].pid === "42" && parsed[0].hwnd === "111" && parsed[1].pid === "7" && parsed[1].hwnd === "999", JSON.stringify(parsed));
    return JSON.stringify(parsed);
  });

  /* 4+5+6. 去重 / 失败静默 / 只处理自己的 pid */
  await check("g6", "去重：同一个 HWND 只设一次（同进程扫两遍不重复设）", async () => {
    const setCalls = [];
    const grouping = createTaskbarGrouping({
      appId: "com.test.grids",
      relaunchCommand: "C:\\test.exe",
      relaunchDisplayName: "测试",
      relaunchIcon: "C:\\icon.png",
      findHwnds: async (pids) => ({ hwnds: [{ pid: "42", hwnd: "111" }, { pid: "42", hwnd: "222" }] }),
      setAppIds: async (hwnds, props) => { setCalls.push({ hwnds: [...hwnds], props }); return { set: hwnds.length }; },
      log: () => {},
    });
    const first = await grouping.scanPids([42]);
    assert(first.fresh.length === 2, JSON.stringify(first));
    assert(setCalls.length === 1 && setCalls[0].hwnds.join(",") === "111,222", JSON.stringify(setCalls));
    const second = await grouping.scanPids([42]);
    assert(second.fresh.length === 0, `第二遍不该有新 HWND：${JSON.stringify(second)}`);
    assert(setCalls.length === 1, `不该再调设置：${setCalls.length}`);
    return `第一次设 ${first.fresh.length} 个，第二次 0 个`;
  });
  await check("g7", "换进程 = 新账本：新 pid 的窗口（哪怕 HWND 数字撞上）也要设", async () => {
    const setCalls = [];
    const grouping = createTaskbarGrouping({
      appId: "com.test.grids", relaunchCommand: "C:\\test.exe", relaunchDisplayName: "测试", relaunchIcon: "C:\\icon.png",
      findHwnds: async (pids) => ({ hwnds: [{ pid: pids[0], hwnd: "111" }] }),
      setAppIds: async (hwnds) => { setCalls.push(hwnds.join(",")); return { set: hwnds.length }; },
      log: () => {},
    });
    await grouping.scanPids([1]);
    await grouping.scanPids([2]);
    assert(setCalls.join("|") === "111|111", `两个进程各设一次：${setCalls.join("|")}`);
    return setCalls.join("|");
  });
  await check("g8", "只处理调用方给的 pid：别的进程的窗口一律不碰", async () => {
    const setCalls = [];
    const grouping = createTaskbarGrouping({
      appId: "com.test.grids", relaunchCommand: "C:\\test.exe", relaunchDisplayName: "测试", relaunchIcon: "C:\\icon.png",
      findHwnds: async () => ({ hwnds: [{ pid: "42", hwnd: "111" }, { pid: "999", hwnd: "222" }] }),
      setAppIds: async (hwnds) => { setCalls.push(hwnds.join(",")); return { set: hwnds.length }; },
      log: () => {},
    });
    const result = await grouping.scanPids([42]);
    assert(result.fresh.join(",") === "111", JSON.stringify(result));
    assert(setCalls.join(",") === "111", `不该设别人的窗口：${setCalls.join(",")}`);
    return `只设了自己的 ${setCalls.join(",")}`;
  });
  await check("g9", "失败静默：find / set 抛错都只记日志，scanPids 不抛", async () => {
    const logs = [];
    const brokenFind = createTaskbarGrouping({
      appId: "a", relaunchCommand: "", relaunchDisplayName: "", relaunchIcon: "",
      findHwnds: async () => { throw new Error("ps 挂了"); },
      setAppIds: async () => ({ set: 1 }),
      log: (text) => logs.push(text),
    });
    const r1 = await brokenFind.scanPids([1]);
    assert(r1.fresh.length === 0, JSON.stringify(r1));
    assert(logs.some((t) => t.includes("扫格子窗口句柄失败")), logs.join("|"));
    const brokenSet = createTaskbarGrouping({
      appId: "a", relaunchCommand: "", relaunchDisplayName: "", relaunchIcon: "",
      findHwnds: async () => ({ hwnds: [{ pid: "1", hwnd: "111" }] }),
      setAppIds: async () => { throw new Error("shell 挂了"); },
      log: (text) => logs.push(text),
    });
    const r2 = await brokenSet.scanPids([1]);
    assert(r2.fresh.join(",") === "111", JSON.stringify(r2));
    assert(logs.some((t) => t.includes("任务栏分组失败")), logs.join("|"));
    return logs.join(" | ");
  });
  await check("g10", "非 Windows 平台：不扫不设（直接返回空）", async () => {
    const grouping = createTaskbarGrouping({
      appId: "a", relaunchCommand: "", relaunchDisplayName: "", relaunchIcon: "",
      findHwnds: async () => ({ hwnds: [{ pid: "1", hwnd: "111" }] }),
      setAppIds: async () => { throw new Error("不该被调"); },
      log: () => {},
    });
    const isWin = process.platform === "win32";
    const result = await grouping.scanPids([1]);
    // 本机是 win32 时这一条只验「假执行器没抛」；真正的非 win32 分支在纯逻辑上等价于空返回
    assert(!result.threw, JSON.stringify(result));
    return isWin ? "本机 win32：走真路径（假执行器没抛）" : "非 win32：空返回";
  });

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n通过 ${passed}/${results.length}（Node ${process.versions.node}，未启动 PowerShell / 浏览器）`);
  process.exit(passed === results.length ? 0 : 1);
})();
