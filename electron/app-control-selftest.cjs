/**
 * app-control 状态自测（纯 node，不启动 Electron、不连网络）。
 *
 *   node electron/app-control-selftest.cjs
 *
 * 覆盖：describePublicCheck 的五种情况（隧道没通 / 还没测 / 通过 / 没延迟 / 没通过），
 * 时间一律用本地时间构造并断言 HH:MM:SS；
 * 假依赖调 status() 时带上 publicCheck.summary，且摘要里不出现 MCP 路径和令牌；
 * 没有 publicCheckSnapshot 时 publicCheck 为 null。
 * 另覆盖 describeActivity 的五种情况，以及 status() 带出 activity / edge。
 */

const { createAppControl, describePublicCheck, describeActivity } = require("./app-control.cjs");

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

/* 本地时间构造：09:05:07 和 09:00:03 */
const at = new Date(2026, 9, 24, 9, 5, 7).getTime();
const lastOkAt = new Date(2026, 9, 24, 9, 0, 3).getTime();

/* ① describePublicCheck 的五种情况 */
const describe = async () => {
  await check("a1", "隧道没打通时不测", () => {
    const text = describePublicCheck({ ok: true, at, latencyMs: 100 }, { hasPublicUrl: false });
    assert(text === "隧道没打通，不测", text);
    return text;
  });
  await check("a2", "没有快照或 at 为 0 时是还没测", () => {
    const empty = describePublicCheck(null, { hasPublicUrl: true });
    assert(empty === "还没测", `null → ${empty}`);
    const missing = describePublicCheck(undefined, { hasPublicUrl: true });
    assert(missing === "还没测", `undefined → ${missing}`);
    const zero = describePublicCheck({ ok: false, at: 0, failures: 0 }, { hasPublicUrl: true });
    assert(zero === "还没测", `at=0 → ${zero}`);
    return `${empty}（null / undefined / at=0）`;
  });
  await check("a3", "通过时给出本地时间和延迟", () => {
    const text = describePublicCheck({ ok: true, at, latencyMs: 120 }, { hasPublicUrl: true });
    assert(text === "09:05:07 通过（延迟 120 毫秒）", text);
    return text;
  });
  await check("a4", "通过但没测出延迟时不带括号", () => {
    const text = describePublicCheck({ ok: true, at, latencyMs: null }, { hasPublicUrl: true });
    assert(text === "09:05:07 通过", text);
    return text;
  });
  await check("a5", "没通过时给出连续次数、原因和上次通过时间", () => {
    const text = describePublicCheck({ ok: false, at, failures: 3, lastError: "HTTP 502", lastOkAt }, { hasPublicUrl: true });
    assert(text === "09:05:07 没通过，连续 3 次：HTTP 502；上次通过 09:00:03", text);
    const noReason = describePublicCheck({ ok: false, at, failures: 1, lastError: null, lastOkAt: 0 }, { hasPublicUrl: true });
    assert(noReason === "09:05:07 没通过，连续 1 次：原因不明", noReason);
    return text;
  });
};

/* ② 假依赖调 status() */
const fakeState = {
  profiles: { list: async () => [], openCount: 0 },
  roots: ["C:\\work"],
  app: { server: { localUrl: "http://127.0.0.1:1234/mcp/本机令牌", healthSummary: () => ({ sessions: 0, lastRequestAt: null, lastTunnelRequestAt: null }) } },
  tunnel: { status: () => ({ readyConnections: null }) },
};
const deps = (overrides = {}) => ({
  state: fakeState,
  app: { getVersion: () => "9.9.9" },
  APP_NAME: "Windrise Bridge",
  DATA_HOME: "C:\\data",
  connectionStatus: () => ({ level: "connected", label: "已连接", publicMcpUrl: "https://demo.trycloudflare.com/mcp/假令牌abc" }),
  ...overrides,
});

/* ② describeActivity 的五种情况（now 固定） */
const activityDescribe = async () => {
  const now = new Date(2026, 9, 24, 12, 5, 7).getTime();
  await check("c1", "summary 为空时是桥没在运行", () => {
    const empty = describeActivity(null, { now });
    assert(empty === "桥没在运行", `null → ${empty}`);
    const missing = describeActivity(undefined, { now });
    assert(missing === "桥没在运行", `undefined → ${missing}`);
    return empty;
  });
  await check("c2", "没有经公网请求时说明会话数", () => {
    const text = describeActivity({ sessions: 3, lastRequestAt: now, lastTunnelRequestAt: null }, { now });
    assert(text === "当前会话 3 个；还没有经公网的请求", text);
    return text;
  });
  await check("c3", "不到 60 秒是刚刚", () => {
    const text = describeActivity({ sessions: 2, lastTunnelRequestAt: now - 30_000 }, { now });
    assert(text === "当前会话 2 个；最后一次经公网的请求 12:04:37（刚刚）", text);
    return text;
  });
  await check("c4", "不到 60 分钟按分钟向下取整", () => {
    const text = describeActivity({ sessions: 2, lastTunnelRequestAt: now - 5 * 60_000 - 20_000 }, { now });
    assert(text === "当前会话 2 个；最后一次经公网的请求 11:59:47（5 分钟前）", text);
    return text;
  });
  await check("c5", "超过 60 分钟按小时向下取整", () => {
    const text = describeActivity({ sessions: 2, lastTunnelRequestAt: now - 3 * 60 * 60_000 - 30_000 }, { now });
    assert(text === "当前会话 2 个；最后一次经公网的请求 09:04:37（3 小时前）", text);
    return text;
  });
};

/* ③ 假依赖调 status() */
const statusCases = async () => {
  await check("b1", "status() 带上 publicCheck.summary，且摘要不带路径和令牌", async () => {
    const handle = createAppControl(deps({
      publicCheckSnapshot: () => ({ ok: false, at, lastOkAt, failures: 2, lastError: "HTTP 502", latencyMs: 900 }),
    }));
    const s = await handle("status", {});
    assert(s.publicCheck && typeof s.publicCheck.summary === "string", JSON.stringify(s.publicCheck));
    assert(s.publicCheck.summary === "09:05:07 没通过，连续 2 次：HTTP 502；上次通过 09:00:03", s.publicCheck.summary);
    assert(!s.publicCheck.summary.includes("/mcp/"), `摘要带路径：${s.publicCheck.summary}`);
    assert(!s.publicCheck.summary.includes("假令牌abc"), `摘要带令牌：${s.publicCheck.summary}`);
    assert(!("notion" in s), "状态里还带 notion 字段");
    return `${s.publicCheck.summary}；快照字段 ${Object.keys(s.publicCheck).sort().join(",")}`;
  });
  await check("b2", "成功时 summary 也只给时间和延迟", async () => {
    const handle = createAppControl(deps({
      publicCheckSnapshot: () => ({ ok: true, at, lastOkAt: at, failures: 0, lastError: null, latencyMs: 85 }),
    }));
    const s = await handle("status", {});
    assert(s.publicCheck.summary === "09:05:07 通过（延迟 85 毫秒）", s.publicCheck.summary);
    assert(!s.publicCheck.summary.includes("/mcp/") && !s.publicCheck.summary.includes("假令牌abc"), s.publicCheck.summary);
    return s.publicCheck.summary;
  });
  await check("b3", "不传 publicCheckSnapshot 时 publicCheck 为 null", async () => {
    const handle = createAppControl(deps());
    const s = await handle("status", {});
    assert(s.publicCheck === null, JSON.stringify(s.publicCheck));
    return "publicCheck=null";
  });
  await check("b4", "status() 带出 activity.summary 和 edge.readyConnections", async () => {
    const requestedAt = Date.now() - 30_000;
    const state = {
      ...fakeState,
      app: { server: { localUrl: "http://127.0.0.1:1234/mcp/本机令牌", healthSummary: () => ({ sessions: 2, lastRequestAt: requestedAt, lastTunnelRequestAt: requestedAt }) } },
      tunnel: { status: () => ({ readyConnections: 3 }) },
    };
    const handle = createAppControl(deps({ state }));
    const s = await handle("status", {});
    assert(s.activity && s.activity.sessions === 2, JSON.stringify(s.activity));
    assert(s.activity.lastRequestAt === requestedAt && s.activity.lastTunnelRequestAt === requestedAt, JSON.stringify(s.activity));
    assert(s.activity.summary.startsWith("当前会话 2 个；最后一次经公网的请求 "), s.activity.summary);
    assert(s.activity.summary.endsWith("（刚刚）"), s.activity.summary);
    assert(s.edge.readyConnections === 3, JSON.stringify(s.edge));
    return `${s.activity.summary}；边缘连接 ${s.edge.readyConnections} 条`;
  });
  await check("b5", "没有隧道模块时 edge.readyConnections 为 null 且不抛错", async () => {
    const state = { ...fakeState, tunnel: undefined };
    const handle = createAppControl(deps({ state }));
    const s = await handle("status", {});
    assert(s.edge.readyConnections === null, JSON.stringify(s.edge));
    return "edge.readyConnections=null";
  });
};

(async () => {
  await describe();
  await activityDescribe();
  await statusCases();

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n通过 ${passed}/${results.length}（Electron 未加载，Node ${process.versions.node}）`);
  process.exit(passed === results.length ? 0 : 1);
})();
