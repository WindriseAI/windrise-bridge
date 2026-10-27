#!/usr/bin/env node
/**
 * 连接器 —— 端到端自检（真的读写文件、真的起 Bridge、真的走 MCP 协议）。
 *
 * 运行：node src/connectors-selftest.mjs
 *
 * 覆盖：
 *   ① ConnectorStore：建 / 读回 / 移交 / 撤销 / 删除 / 待批准去重 / 批准 / 拒绝冷却
 *   ② BridgeServer：主令牌照旧全通；连接器只能碰分给它的窗口；越权先排队；
 *      会话绑定连接器；删连接器后地址和会话一起失效；日志带 connector 字段
 *
 * 纪律：所有结论都来自实际运行输出；跑不通就如实打 FAIL，不粉饰。
 * 副作用隔离：数据写在系统临时目录，不碰真实的 ~/.bridge-replica。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";
import { ConnectorStore, connectorsFile } from "./core/connectors.js";
import { registerTool, unregisterTool } from "./core/registry.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "connectors-selftest-"));
const dataHome = path.join(tmpRoot, "data");
const file = connectorsFile(dataHome);

/* ================================================================== *
 * ① ConnectorStore
 * ================================================================== */
console.log("\n=== ① ConnectorStore ===");
const store = new ConnectorStore({ file });
const a = store.create("  写作助手  ");
check("create 的名字去掉首尾空白", a.name === "写作助手", a.name);
check("id 是 c- 加 12 位十六进制", /^c-[0-9a-f]{12}$/.test(a.id), a.id);
check("token 只含 base64url 字符、长度 32", /^[A-Za-z0-9_-]{32}$/.test(a.token), `${a.token.length} 位：${a.token}`);
check("新连接器默认什么窗口都碰不到", Array.isArray(a.profiles) && a.profiles.length === 0, JSON.stringify(a.profiles));

const reloaded = new ConnectorStore({ file });
check("重新 new 一个读同一文件能读回", reloaded.list().length === 1 && reloaded.findByToken(a.token)?.id === a.id, `<${reloaded.list().length}> 个`);

const b = store.create("写作助手B");
store.grant(a.id, "p1");
check("grant 后 canUse 为真", store.canUse(store.get(a.id), "p1"), JSON.stringify(store.get(a.id).profiles));
store.grant(b.id, "p1");
check(
  "一个窗口只归一个连接器：grant B 后 A 没有了",
  !store.canUse(store.get(a.id), "p1") && store.canUse(store.get(b.id), "p1"),
  `A=${JSON.stringify(store.get(a.id).profiles)} B=${JSON.stringify(store.get(b.id).profiles)}`,
);
store.revoke(b.id, "p1");
check("revoke 后不能再用", !store.canUse(store.get(b.id), "p1"), JSON.stringify(store.get(b.id).profiles));

const removed = store.create("要被删掉");
const removedToken = removed.token;
check("remove 返回成功", store.remove(removed.id) === true);
check("remove 后 findByToken 找不到", store.findByToken(removedToken) === null);

const c = store.create("待批准");
const firstRequest = store.requestApproval({ connectorId: c.id, profileId: "p2", tool: "fake_page" });
const secondRequest = store.requestApproval({ connectorId: c.id, profileId: "p2", tool: "fake_page" });
check(
  "同一连接器同一窗口 requestApproval 两次只排一条",
  Boolean(firstRequest?.id) && firstRequest.id === secondRequest?.id && store.pending().length === 1,
  `id=${firstRequest?.id} / ${secondRequest?.id}，pending=${store.pending().length}`,
);
store.approve(firstRequest.id);
check("approve 后 canUse 为真", store.canUse(store.get(c.id), "p2"), JSON.stringify(store.get(c.id).profiles));
check("approve 后待批准清空", store.pending().length === 0, `pending=${store.pending().length}`);

const d = store.create("会被拒绝");
const deniedRequest = store.requestApproval({ connectorId: d.id, profileId: "p3", tool: "fake_page" });
store.deny(deniedRequest.id);
const deniedAgain = store.requestApproval({ connectorId: d.id, profileId: "p3", tool: "fake_page" });
check(
  "deny 后 10 分钟内再请求返回 denied 且不排队",
  deniedAgain?.denied === true && store.pending().length === 0,
  `${JSON.stringify(deniedAgain)}，pending=${store.pending().length}`,
);

// 2026-10-24 审查补的几条
const e = store.create("勾选清待批准");
store.requestApproval({ connectorId: e.id, profileId: "p4", tool: "fake_page" });
store.grant(e.id, "p4");
check("在设置页直接勾选窗口，对应的待批准一并清掉", !store.pending().some((item) => item.connectorId === e.id), JSON.stringify(store.pending()));

const f = store.create("刷待批准");
const flood = ["p10", "p11", "p12", "p13", "p14", "p15"].map((profileId) => store.requestApproval({ connectorId: f.id, profileId, tool: "fake_page" }));
check(
  "每个连接器最多排 5 条待批准，第 6 条返回 limited",
  flood.slice(0, 5).every((item) => item?.id) && flood[5]?.limited === true && store.pending().filter((item) => item.connectorId === f.id).length === 5,
  JSON.stringify(flood[5]),
);
check("超长的窗口 id 不排队", store.requestApproval({ connectorId: f.id, profileId: "x".repeat(100), tool: "fake_page" }) === null);

const outside = store.get(e.id);
outside.profiles.push("偷偷加的");
check("get() 给的是拷贝，改它不影响内部", !store.canUse(store.findByToken(e.token), "偷偷加的"), JSON.stringify(store.get(e.id).profiles));

const reopened = new ConnectorStore({ file });
check(
  "grant / revoke / remove 都写进了文件：重新读回一致",
  JSON.stringify(reopened.list().map((item) => [item.id, item.profiles])) === JSON.stringify(store.list().map((item) => [item.id, item.profiles])),
  `${reopened.list().length} 个`,
);

const brokenFile = path.join(tmpRoot, "broken", "connectors.json");
mkdirSync(path.dirname(brokenFile), { recursive: true });
writeFileSync(brokenFile, "{ 这不是 json");
const fromBroken = new ConnectorStore({ file: brokenFile });
const backups = readdirSync(path.dirname(brokenFile)).filter((name) => name.startsWith("connectors.json.broken-"));
check("坏文件先另存一份再当空表，不会被之后的写入盖掉", fromBroken.list().length === 0 && backups.length === 1, backups.join(","));

const dirtyFile = path.join(tmpRoot, "dirty", "connectors.json");
mkdirSync(path.dirname(dirtyFile), { recursive: true });
const goodToken = randomBytes(24).toString("base64url");
writeFileSync(dirtyFile, JSON.stringify({ version: 1, connectors: [
  { id: "c-short", name: "短令牌", token: "abc", profiles: [] },
  { id: "c-good", name: "正常", token: goodToken, profiles: ["w1"] },
  { id: "c-dup", name: "同一把令牌", token: goodToken, profiles: [] },
  { id: "c-other", name: "抢同一个窗口", token: randomBytes(24).toString("base64url"), profiles: ["w1"] },
] }));
const fromDirty = new ConnectorStore({ file: dirtyFile });
check(
  "读文件时丢掉短令牌、重复令牌；一个窗口只留给第一个连接器",
  JSON.stringify(fromDirty.list().map((item) => [item.id, item.profiles])) === JSON.stringify([["c-good", ["w1"]], ["c-other", []]]),
  JSON.stringify(fromDirty.list().map((item) => [item.id, item.profiles])),
);

/* ================================================================== *
 * ② BridgeServer：主令牌 / 连接器 / 越权 / 会话归属
 * ================================================================== */
console.log("\n=== ② BridgeServer 与 MCP 协议 ===");
const FAKE_PAGE = "fake_page";
const FAKE_PLAIN = "fake_plain";
let handlerCalls = 0;

registerTool({
  name: FAKE_PAGE,
  title: "假页面工具",
  description: "自检用：返回调用方身份，便于验证连接器归属",
  scope: "profile",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, context) => {
    handlerCalls++;
    return {
      content: [{ type: "text", text: `ok ${args.id}` }],
      structuredContent: { connector: context?.connector ?? null },
    };
  },
});
const FAKE_BIG = "fake_big";
registerTool({
  name: FAKE_BIG,
  title: "假的大结果",
  description: "自检用：返回超过上限的大文本，验证 read_result 按调用方隔离",
  scope: "profile",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  handler: async (args) => ({ content: [{ type: "text", text: `${args.id}:` + "大".repeat(3000) }] }),
});
registerTool({
  name: FAKE_PLAIN,
  title: "不带 scope 的假工具",
  description: "自检用：代表 windrise_status、run_command 这类不带窗口的工具，连接器不能用",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  handler: async (_args, context) => ({
    content: [{ type: "text", text: "plain ok" }],
    structuredContent: { connector: context?.connector ?? null },
  }),
});

// 给 A 重新分一个窗口（前面移交 / 撤销测试用掉了）
store.grant(a.id, "p1");

const server = new BridgeServer({
  routeToken: randomBytes(16).toString("hex"),
  dataHome,
  port: 0,
  connectors: store,
  resultLimitBytes: 2000,
  // 这台「电脑」上只有这几个窗口；别的 id 当成不存在，不排队
  profileExists: (id) => ["p1", "p2", "p3"].includes(id),
});
await server.start();
const port = server.address()?.port;
const ownerUrl = server.localUrl;
const urlA = `http://127.0.0.1:${port}/mcp/${a.token}`;
const urlB = `http://127.0.0.1:${port}/mcp/${b.token}`;

/** 最小 MCP 客户端：每个实例自己维持一个会话 id。 */
function mcpClient(endpoint) {
  let sessionId = null;
  let id = 0;
  const post = async (method, params) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!sessionId) sessionId = response.headers.get("mcp-session-id");
    const body = await response.json();
    if (body.error) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    initialize: () => post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connectors-selftest", version: "1" } }),
    call: (name, args) => post("tools/call", { name, arguments: args ?? {} }),
    list: async () => (await post("tools/list", {}))?.tools ?? [],
    text: (result) => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "",
    get sessionId() { return sessionId; },
  };
}

const ownerClient = mcpClient(ownerUrl);
await ownerClient.initialize();
const mainCall = await ownerClient.call(FAKE_PAGE, { id: "p2" });
check(
  "主令牌调 fake_page id=p2 成功",
  !mainCall.isError && mainCall.structuredContent?.connector === null,
  `isError=${mainCall.isError} connector=${JSON.stringify(mainCall.structuredContent?.connector)}`,
);

const clientA = mcpClient(urlA);
await clientA.initialize();
const aP1 = await clientA.call(FAKE_PAGE, { id: "p1" });
check(
  "连接器 A 调自己的 p1 成功，context.connector.id 是 A",
  !aP1.isError && aP1.structuredContent?.connector?.id === a.id,
  JSON.stringify(aP1.structuredContent?.connector),
);

const beforeDenied = handlerCalls;
const aP2 = await clientA.call(FAKE_PAGE, { id: "p2" });
check(
  "连接器 A 调没有分给它的 p2 返回 NEEDS_APPROVAL",
  aP2.isError === true && aP2.structuredContent?.code === "NEEDS_APPROVAL" && aP2.structuredContent?.reason === "space" && aP2.structuredContent?.retryable === true,
  aP2.content?.[0]?.text,
);
check("越权时 handler 没有被调用", handlerCalls === beforeDenied, `handlerCalls=${handlerCalls}`);
check(
  "待批准里有 1 条，再调一次仍然只有 1 条",
  store.pending().filter((item) => item.connectorId === a.id && item.profileId === "p2").length === 1,
  JSON.stringify(store.pending()),
);
await clientA.call(FAKE_PAGE, { id: "p2" });
check(
  "重复请求不会重复排队",
  store.pending().filter((item) => item.connectorId === a.id && item.profileId === "p2").length === 1,
  `pending=${store.pending().length}`,
);

const approval = store.pending().find((item) => item.connectorId === a.id && item.profileId === "p2");
store.approve(approval.id);
const aP2AfterApprove = await clientA.call(FAKE_PAGE, { id: "p2" });
check(
  "approve 之后 A 用同样的参数再调，p2 成功",
  !aP2AfterApprove.isError && aP2AfterApprove.structuredContent?.connector?.id === a.id,
  JSON.stringify(aP2AfterApprove.structuredContent?.connector),
);

store.grant(b.id, "p2");
const aP2AfterTransfer = await clientA.call(FAKE_PAGE, { id: "p2" });
check(
  "B grant p2 后，A 调 p2 又返回 NEEDS_APPROVAL",
  aP2AfterTransfer.isError === true && aP2AfterTransfer.structuredContent?.code === "NEEDS_APPROVAL",
  aP2AfterTransfer.content?.[0]?.text,
);

const transferRequest = store.pending().find((item) => item.connectorId === a.id && item.profileId === "p2");
store.deny(transferRequest.id);
const deniedCall = await clientA.call(FAKE_PAGE, { id: "p2" });
check(
  "deny 一条以后，10 分钟内再调 reason=denied、retryable=false",
  deniedCall.isError === true && deniedCall.structuredContent?.reason === "denied" && deniedCall.structuredContent?.retryable === false,
  JSON.stringify(deniedCall.structuredContent),
);
check(
  "被拒之后不会重新排队",
  store.pending().filter((item) => item.connectorId === a.id && item.profileId === "p2").length === 0,
  `pending=${store.pending().length}`,
);

// 2026-10-24 审查：连接器默认全不放行，不带窗口的工具（软件状态里带主令牌地址、跑命令、读文件）一律不给
const plainCall = await clientA.call(FAKE_PLAIN, {});
check(
  "连接器调不带 scope 的工具返回 NOT_ALLOWED",
  plainCall.isError === true && plainCall.structuredContent?.code === "NOT_ALLOWED",
  plainCall.content?.[0]?.text,
);
const ownerPlain = await ownerClient.call(FAKE_PLAIN, {});
check("主令牌照常能用不带 scope 的工具", !ownerPlain.isError && ownerPlain.structuredContent?.connector === null, JSON.stringify(ownerPlain.structuredContent));
const listedA = (await clientA.list()).map((tool) => tool.name);
const listedOwner = (await ownerClient.list()).map((tool) => tool.name);
check(
  "连接器的工具清单里只有窗口工具和 read_result，看不到不带 scope 的工具",
  listedA.includes(FAKE_PAGE) && listedA.includes("read_result") && !listedA.includes(FAKE_PLAIN) && listedOwner.includes(FAKE_PLAIN),
  `连接器看到 ${listedA.length} 个：${listedA.join(",")}`,
);
check(
  "连接器的清单里没有软件控制、命令、文件工具",
  !listedA.some((name) => /^(windrise_|run_command|read_files|write_file|apply_patch|configure_mcp|custom_tool)/.test(name)),
  listedA.join(","),
);

const pendingBefore = store.pending().length;
const unknownWindow = await clientA.call(FAKE_PAGE, { id: "随便编的窗口" });
check(
  "申请一个不存在的窗口：返回 INVALID_ARGUMENT，不排队、不弹通知",
  unknownWindow.isError === true && unknownWindow.structuredContent?.code === "INVALID_ARGUMENT" && store.pending().length === pendingBefore,
  unknownWindow.content?.[0]?.text,
);

const ownerBig = await ownerClient.call(FAKE_BIG, { id: "p1" });
const ownerHandle = ownerBig.structuredContent?.handle;
const stolen = await clientA.call("read_result", { handle: ownerHandle });
const ownRead = await ownerClient.call("read_result", { handle: ownerHandle });
check(
  "主令牌存下的大结果，连接器拿着句柄也读不到；主令牌自己能读",
  Boolean(ownerHandle) && stolen.isError === true && !ownRead.isError,
  `handle=${ownerHandle} 连接器 isError=${stolen.isError} 主令牌 isError=${ownRead.isError}`,
);

const sessionsOf = (connectorId) => [...server.sessions.sessions.values()].filter((entry) => (entry.connectorId ?? null) === connectorId).length;
const floodClients = [];
for (let i = 0; i < 10; i++) { const client = mcpClient(urlB); await client.initialize(); floodClients.push(client); }
const ownerStill = await ownerClient.call(FAKE_PAGE, { id: "p2" });
check(
  "一个连接器开再多会话也最多占 8 个，挤不掉主令牌的会话",
  sessionsOf(b.id) === 8 && !ownerStill.isError,
  `B 的会话 ${sessionsOf(b.id)} 个，主令牌调用 isError=${ownerStill.isError}`,
);

const missing = await fetch(`http://127.0.0.1:${port}/mcp/not-a-real-token`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: "{}",
});
check("不存在的 token 返回 404", missing.status === 404, `HTTP ${missing.status}`);

const connectorHealth = await fetch(`http://127.0.0.1:${port}/healthz/${a.token}`);
check("连接器 token 访问 /healthz 返回 404", connectorHealth.status === 404, `HTTP ${connectorHealth.status}`);

const mismatch = await fetch(urlB, {
  method: "DELETE",
  headers: { accept: "application/json, text/event-stream", "mcp-session-id": clientA.sessionId },
});
const mismatchBody = await mismatch.json().catch(() => null);
// 2026-10-24：失效会话改按 MCP 规范回 404（客户端据此重新 initialize），和真不存在的会话完全一样
check(
  "用 A 的地址建的会话 id，拿去 B 的地址发请求，被当成会话不存在（404 Session not found）",
  mismatch.status === 404 && mismatchBody?.error?.code === -32001,
  `HTTP ${mismatch.status} ${JSON.stringify(mismatchBody)}`,
);

store.remove(a.id);
const afterRemove = await fetch(urlA, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
});
check("remove A 以后，A 的地址返回 404", afterRemove.status === 404, `HTTP ${afterRemove.status}`);

const oldSession = await fetch(urlA, {
  method: "DELETE",
  headers: { accept: "application/json, text/event-stream", "mcp-session-id": clientA.sessionId },
});
check("remove A 以后，A 原来的会话也用不了", oldSession.status === 404, `HTTP ${oldSession.status}`);
check("remove A 以后，会话表里真的没有 A 的会话了（不是只靠 404）", sessionsOf(a.id) === 0, `剩 ${sessionsOf(a.id)} 个`);

/* ================================================================== *
 * ③ 调用日志
 * ================================================================== */
console.log("\n=== ③ 调用日志 ===");
const logsDir = path.join(dataHome, "logs");
function readLogLines() {
  const names = readdirSync(logsDir).filter(name => /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const lines = [];
  for (const name of names) {
    for (const line of readFileSync(path.join(logsDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
    }
  }
  return lines;
}
async function waitForLog(predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const found = readLogLines().find(predicate);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

const ownerLog = await waitForLog((line) => line.tool === FAKE_PAGE && line.connector === "owner");
check("调用日志里有 connector 字段，主令牌那行是 owner", ownerLog?.connector === "owner", `connector=${ownerLog?.connector}`);
const connectorLog = await waitForLog((line) => line.tool === FAKE_PAGE && line.connector === a.id);
check("连接器调用的日志记的是连接器 id", connectorLog?.connector === a.id, `connector=${connectorLog?.connector}`);

/* ================================================================== *
 * 收尾
 * ================================================================== */
await server.stop();
unregisterTool(FAKE_PAGE);
unregisterTool(FAKE_PLAIN);
unregisterTool(FAKE_BIG);
rmSync(tmpRoot, { recursive: true, force: true });

const failed = results.filter(item => !item.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
