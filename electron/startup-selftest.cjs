/**
 * 托盘化启动流程自测（纯 Node，不启动 Electron / 浏览器）：
 *   node electron/startup-selftest.cjs
 *
 * 覆盖：
 *   1. shouldOpenGridOnStart：用户手动开默认开格子 1、openGridOnStart=false 关；
 *      开机自启默认不开（openGridOnAutostart=false）、开了才开；
 *   2. resolveGrid1：没有账号按命名规则建「格子 1」（启动地址 Google）、有「格子 1」就开它、
 *      有别的账号但没「格子 1」也建「格子 1」、命名规则照 browseros-profiles 的 #nextGridName；
 *   3. gridNameFor：首选编号被占往后找、没有首选取最小空号；
 *   4. openGrid1Flow：没账号 → createProfile（格子 1 + Google）→ openWindow → focusWindow；
 *      有账号 → 不建、只开 + 聚焦；focusWindow 没有就不调；
 *   5. secondInstancePlan：账号管理器没就绪 → 记账；就绪 → 直接开；
 *   6. trayStatusLine：已连接 / 未连接 + 域名；不带口令、不带路径。
 */

const { shouldOpenGridOnStart, resolveGrid1, gridNameFor, openGrid1Flow, secondInstancePlan, trayStatusLine } = require("./startup-flow.cjs");

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

(async () => {
  /* 1. 启动决策 */
  await check("s1", "用户手动开：默认自动开格子 1", () => {
    assert(shouldOpenGridOnStart({}) === true, "空设置应为开");
    assert(shouldOpenGridOnStart({ openGridOnStart: true }) === true, "显式开应为开");
    assert(shouldOpenGridOnStart({ openGridOnStart: false }) === false, "显式关应为关");
    return "默认开；false 关";
  });
  await check("s2", "开机自启：默认不开格子（openGridOnAutostart=false）", () => {
    assert(shouldOpenGridOnStart({}, { autostart: true }) === false, "默认应为不开");
    assert(shouldOpenGridOnStart({ openGridOnAutostart: false }, { autostart: true }) === false, "显式关应为关");
    assert(shouldOpenGridOnStart({ openGridOnAutostart: true }, { autostart: true }) === true, "显式开应为开");
    return "默认不开；true 开";
  });
  await check("s3", "开机自启时不看 openGridOnStart（两个开关分开）", () => {
    assert(shouldOpenGridOnStart({ openGridOnStart: true, openGridOnAutostart: false }, { autostart: true }) === false, "自启时 openGridOnStart=true 也不该开");
    return "openGridOnStart=true 但自启时仍不开";
  });

  /* 2+3. 格子 1 解析 + 命名 */
  await check("s4", "没有账号：按命名规则建「格子 1」，启动地址 Google", () => {
    const plan = resolveGrid1([]);
    assert(plan.kind === "create", plan.kind);
    assert(plan.name === "格子 1", plan.name);
    assert(plan.startUrl === "https://www.google.com/", plan.startUrl);
    return JSON.stringify(plan);
  });
  await check("s5", "有「格子 1」就开它（不新建）", () => {
    const plan = resolveGrid1([{ id: "abc", name: "格子 1", startUrl: "https://www.google.com/" }]);
    assert(plan.kind === "open" && plan.id === "abc", JSON.stringify(plan));
    return JSON.stringify(plan);
  });
  await check("s6", "有别的账号但没「格子 1」：开最近用过的那个主账号，不新建（老用户的主账号可能叫别的名字）", () => {
    const plan = resolveGrid1([
      { id: "old", name: "窗口 2", lastOpenedAt: 100 },
      { id: "xyz", name: "google.com 账号 1", startUrl: "https://example.com/", lastOpenedAt: 200 },
      { id: "new", name: "格子 1" },
    ]);
    assert(plan.kind === "open" && plan.id === "xyz", JSON.stringify(plan));
    const never = resolveGrid1([{ id: "a", name: "窗口 1" }, { id: "b", name: "格子 1" }]);
    assert(never.kind === "open" && never.id === "b", JSON.stringify(never));
    return JSON.stringify(plan);
  });
  await check("s7", "命名规则：首选编号被占往后找（回到最小空号），没首选取最小空号", () => {
    const profiles = [{ name: "格子 1" }, { name: "格子 3" }];
    assert(gridNameFor(1, profiles) === "格子 2", gridNameFor(1, profiles));
    assert(gridNameFor(2, profiles) === "格子 2", gridNameFor(2, profiles));
    // 首选「格子 3」被占：和 browseros-profiles 的 #nextGridName 一样回落到最小空号
    assert(gridNameFor(3, profiles) === "格子 2", gridNameFor(3, profiles));
    assert(gridNameFor(null, profiles) === "格子 2", gridNameFor(null, profiles));
    assert(gridNameFor(1, []) === "格子 1", gridNameFor(1, []));
    return "格子 2 / 格子 2 / 格子 1";
  });

  /* 4. 开格子 1 流程 */
  await check("s8", "没有账号：先建（格子 1 + Google）再开再聚焦", async () => {
    const calls = [];
    const result = await openGrid1Flow({
      profiles: [],
      createProfile: async (input) => { calls.push(["create", input]); return { id: "new1" }; },
      openWindow: async (id) => { calls.push(["open", id]); },
      focusWindow: async (id) => { calls.push(["focus", id]); },
    });
    assert(result.kind === "create" && result.id === "new1", JSON.stringify(result));
    assert(calls.length === 3, JSON.stringify(calls));
    assert(calls[0][0] === "create" && calls[0][1].name === "格子 1" && calls[0][1].startUrl === "https://www.google.com/", JSON.stringify(calls[0]));
    assert(calls[1][0] === "open" && calls[1][1] === "new1", JSON.stringify(calls[1]));
    assert(calls[2][0] === "focus" && calls[2][1] === "new1", JSON.stringify(calls[2]));
    return JSON.stringify(calls);
  });
  await check("s9", "有「格子 1」：不新建，只开 + 聚焦", async () => {
    const calls = [];
    const result = await openGrid1Flow({
      profiles: [{ id: "g1", name: "格子 1" }],
      createProfile: async () => { calls.push(["create"]); return { id: "bad" }; },
      openWindow: async (id) => { calls.push(["open", id]); },
      focusWindow: async (id) => { calls.push(["focus", id]); },
    });
    assert(result.kind === "open" && result.id === "g1", JSON.stringify(result));
    assert(!calls.some((c) => c[0] === "create"), JSON.stringify(calls));
    assert(calls.some((c) => c[0] === "open" && c[1] === "g1") && calls.some((c) => c[0] === "focus" && c[1] === "g1"), JSON.stringify(calls));
    return JSON.stringify(calls);
  });
  await check("s10", "没有 focusWindow 就不调（不炸）", async () => {
    const result = await openGrid1Flow({
      profiles: [{ id: "g1", name: "格子 1" }],
      createProfile: async () => ({ id: "bad" }),
      openWindow: async () => {},
    });
    assert(result.kind === "open" && result.id === "g1", JSON.stringify(result));
    return "focusWindow 缺省，流程照常";
  });

  /* 5. second-instance */
  await check("s11", "second-instance：账号管理器没就绪 → 记账（等就绪再开）", () => {
    assert(secondInstancePlan({ profilesReady: false }).action === "queue", "应为 queue");
    return "queue";
  });
  await check("s12", "second-instance：就绪 → 直接打开 / 聚焦格子 1", () => {
    assert(secondInstancePlan({ profilesReady: true }).action === "open", "应为 open");
    return "open";
  });

  /* 6. 托盘连接状态文字 */
  await check("s13", "连接状态行：已连接 / 未连接 + 域名（不显示口令）", () => {
    assert(trayStatusLine({ level: "connected", host: "abc.trycloudflare.com" }) === "已连接 · abc.trycloudflare.com", trayStatusLine({ level: "connected", host: "abc.trycloudflare.com" }));
    assert(trayStatusLine({ level: "stopped", host: "" }) === "未连接", trayStatusLine({ level: "stopped", host: "" }));
    const line = trayStatusLine({ level: "error", host: "abc.trycloudflare.com" });
    assert(line === "未连接 · abc.trycloudflare.com", line);
    assert(!line.includes("/mcp/") && !line.includes("假令牌"), line);
    return line;
  });

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n通过 ${passed}/${results.length}（Node ${process.versions.node}，未加载 Electron）`);
  process.exit(passed === results.length ? 0 : 1);
})();
