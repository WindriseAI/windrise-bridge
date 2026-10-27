/**
 * 旧式 SSE 端点（GET /sse/<口令> + POST /messages/<口令>?sessionId=…）的端到端测试。
 *
 * 跑法：node --test src/core/sse-endpoint.test.js（也挂在 tools/run-clickable-tests.mjs 里）
 *
 * 为什么要有：通义灵码 IDE、ChatWise 旧服务器这类客户端只会发 GET + Accept: text/event-stream，
 * 见到 /mcp 只有 405。这个测试真的起一个本地 Bridge，用官方 SDK 的 SSEClientTransport 连上去，
 * 把「能握手、能列工具、能调只读工具、错口令 404、断开后服务端清理」都跑一遍，
 * 顺便确认 /mcp 的 GET 误用提示和原来的 /mcp POST 行为都没被改坏。
 *
 * 第二轮审查后补的（对应审查第 1 / 2 / 3 / 4 / 5 条）：
 *   · 连接器令牌连 SSE：握手成功、工具只有自己分组的、返回里不出现主路径令牌；
 *   · 跨身份串号：用 A 的口令 POST B 的会话号必须 404；
 *   · 连接器 SSE 会话到 CONNECTOR_MAX_SESSIONS 时最老的被关掉；
 *   · 流上有心跳（: ping）、SSE 请求会计入 lastRequestAt / lastTunnelRequestAt；
 *   · 空闲会话靠定时器回收，不再只在「有新会话进来」时才回收。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { BridgeServer, SessionRegistry } from "./bridge.js";
import { OwnerAuthStore, ownerAuthFile } from "./bearer-auth.js";
import { ConnectorStore, connectorsFile } from "./connectors.js";
import { registerTool, unregisterTool } from "./registry.js";
import { printBanner } from "../standalone.js";


const READ_TOOL = "sse_selftest_read";
const READ_TEXT = "只读工具返回：ok";
const ADMIN_TOOL = "sse_selftest_admin";

registerTool({
  name: READ_TOOL,
  title: "SSE 测试只读工具",
  description: "旧式 SSE 端点测试用：返回一小段文本，没有副作用",
  group: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "SSE 测试只读工具", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ content: [{ type: "text", text: READ_TEXT }], structuredContent: { code: "OK" } }),
});

/** 只给「admin」分组：用来证明连接器的分组过滤在 SSE 上也生效（默认连接器一个工具都拿不到） */
registerTool({
  name: ADMIN_TOOL,
  title: "SSE 测试管理工具",
  description: "旧式 SSE 端点测试用：admin 分组，连接器不该看见它",
  group: "admin",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "SSE 测试管理工具", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ content: [{ type: "text", text: "不该被调到" }] }),
});

/** 起一个只在这条测试里用的本地桥；数据目录放在 .tmp 下的临时目录，不碰真实数据 */
async function startBridge(t, extra = {}) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const routeToken = randomBytes(16).toString("hex");
  const server = new BridgeServer({ routeToken, dataHome: mkdirSync(path.join(tmpRoot, "data"), { recursive: true }), port: 0, ...extra });
  await server.start();
  t.after(async () => {
    /*
     * 调用日志是排队异步写的，日志里那句 ENOENT 就是 tmp 目录被提前删掉、它还排着队。
     * 停桥前先等它把队列排完（拿不到队列时用 sleep 兜底），免得测试输出里出现误导性的报错。
     */
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await new Promise(resolve => setTimeout(resolve, 60));
    await server.stop().catch(() => {});
    // 审查第 6 条：临时目录每跑一次留一个，必须自己删（只删这条测试自己建的那一个）
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const port = server.address().port;
  return { server, tmpRoot, routeToken, base: `http://127.0.0.1:${port}` };
}

/** 起一个带连接器的桥（连接器 store 落在同一个临时数据目录里） */
async function startBridgeWithConnectors(t, { scope, name = "测试连接器" } = {}) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const dataHome = mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
  const routeToken = randomBytes(16).toString("hex");
  const connectors = new ConnectorStore({ file: connectorsFile(dataHome) });
  const connector = connectors.create(name, scope === undefined ? {} : { scope });
  const server = new BridgeServer({ routeToken, dataHome, port: 0, connectors });
  await server.start();
  t.after(async () => {
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await new Promise(resolve => setTimeout(resolve, 60));
    await server.stop().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const port = server.address().port;
  return { server, connectors, connector, tmpRoot, routeToken, base: `http://127.0.0.1:${port}` };
}

/** 用 SDK 的 SSEClientTransport 连 /sse/<口令>，返回已经 initialize 好的 client */
async function connectSse(t, url) {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client({ name: "sse-endpoint-test", version: "1" });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); });
  return { client, transport };
}

/** 直接用 node:http 发 GET 拿状态码和正文（fetch 读 SSE 流会一直挂着） */
function getStatuses(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; if (text.length > 4096) response.destroy(); });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
      response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("error", reject);
    request.setTimeout(3000, () => { request.destroy(); resolve({ status: 0, headers: {}, text: "" }); });
  });
}

/**
 * 开一条 SSE 流并自己拿着句柄（可以随时中断、也可以观察服务端何时关流）。
 * 返回 { status, headers, text(), closed, endpoint, abort() }。
 * text() 是当前已收到的全部字节；closed 是个 Promise，服务端关流 / 连接被中断时 resolve。
 */
function openStream(url, { headers = { accept: "text/event-stream" } } = {}) {
  let text = "";
  let closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const request = http.get(url, { headers }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => closedResolve());
    response.on("close", () => closedResolve());
    handle.status = response.statusCode;
    handle.headers = response.headers;
  });
  const handle = {
    status: 0,
    headers: {},
    text: () => text,
    closed,
    abort: () => request.destroy(),
    /** endpoint 事件里给出的收消息地址（还没收到就返回 null） */
    endpoint: () => {
      const match = /event: endpoint\ndata: ([^\n]+)\n\n/.exec(text);
      return match ? new URL(match[1], url) : null;
    },
  };
  request.on("error", () => closedResolve());
  return handle;
}


/** 读 SSE 流若干毫秒，把收到的所有字节拼起来返回（用来抓心跳 / endpoint 事件） */
function readStream(url, { ms = 800, headers = { accept: "text/event-stream" } } = {}) {
  return new Promise((resolve, reject) => {
    let text = "";
    const request = http.get(url, { headers }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
    });
    request.on("error", reject);
    const timer = setTimeout(() => { request.destroy(); resolve(text); }, ms);
    request.on("close", () => { clearTimeout(timer); resolve(text); });
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 等条件成立，最多等 timeoutMs（服务端清理是异步的，不能立刻断言） */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return Boolean(await predicate());
}

test("旧式 SSE：initialize / tools/list / 调只读工具都成功", async (t) => {
  const { server, routeToken, base } = await startBridge(t);
  const { client } = await connectSse(t, `${base}/sse/${routeToken}`);

  const info = client.getServerVersion();
  assert.equal(info?.name, "windrise", "serverInfo 应该是 windrise");

  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes(READ_TOOL), `tools/list 里应该有 ${READ_TOOL}，实际：${names.join(", ")}`);

  const result = await client.callTool({ name: READ_TOOL, arguments: {} });
  assert.equal(result.content?.find(part => part.type === "text")?.text, READ_TEXT);
  assert.equal(result.isError ?? false, false);

  // 调用要记进同一个调用日志 / 统计：这条会话确实算进 /mcp 那套会话表
  assert.ok(server.sessionCount >= 1, "SSE 会话要计入 sessionCount");
  await waitFor(() => server.stats.calls >= 1);
  assert.ok(server.stats.calls >= 1, "工具调用要计入 stats.calls");
});

test("旧式 SSE：错口令 404（装作不存在）", async (t) => {
  const { base } = await startBridge(t);
  const wrong = randomBytes(16).toString("hex");
  const sse = await getStatuses(`${base}/sse/${wrong}`, { accept: "text/event-stream" });
  assert.equal(sse.status, 404, `/sse/<错口令> 应该 404，实际 ${sse.status}`);
  assert.ok(!sse.headers["content-type"]?.includes("text/event-stream"), "错口令不能开 SSE 流");

  // /messages 同理，带不带 sessionId 都是 404
  const messages = await getStatuses(`${base}/messages/${wrong}?sessionId=whatever`);
  assert.equal(messages.status, 404, `/messages/<错口令> 应该 404，实际 ${messages.status}`);
});

test("旧式 SSE：会话断开后服务端清理", async (t) => {
  const { server, routeToken, base } = await startBridge(t);
  const transport = new SSEClientTransport(new URL(`${base}/sse/${routeToken}`));
  const client = new Client({ name: "sse-endpoint-test", version: "1" });
  await client.connect(transport);
  assert.ok(await waitFor(() => server.sessionCount === 1), `连上后应该只有 1 个会话，实际 ${server.sessionCount}`);

  // 拿到服务端会话号：SDK 的 SSE 会话号只走 /messages 的查询串，客户端内部有 _endpoint
  const endpoint = new URL(transport._endpoint);
  const sessionId = endpoint.searchParams.get("sessionId");
  assert.ok(sessionId, "服务端应该在 endpoint 事件里给出 sessionId");
  // 审查第 1 条：endpoint 里给的是这次请求那把口令，不是写死的主路径令牌
  assert.equal(endpoint.pathname, `/messages/${routeToken}`, `endpoint 应该指向 /messages/<本次口令>，实际 ${endpoint.pathname}`);

  await client.close();
  const cleaned = await waitFor(() => server.sessionCount === 0 && !server.sessions.get(sessionId));
  assert.ok(cleaned, `客户端断开后会话应该被清掉，实际还剩 ${server.sessionCount} 个`);

  // 清理之后用旧会话号发消息一律 404
  const stale = await fetch(`http://127.0.0.1:${server.address().port}/messages/${routeToken}?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(stale.status, 404, "已断开的会话号再发消息应该 404");
});

/*
 * 审查第 1 条（高）：endpoint 事件原来写死主路径令牌 —— 连接器客户端 POST 回来会 404，
 * 而且主路径令牌被明文交给了受限客户端。修之前这条连 initialize 都过不去。
 */
test("审查1：连接器令牌连 SSE 能用，工具只有自己分组的，返回里不出现主路径令牌", async (t) => {
  const { connector, base, routeToken } = await startBridgeWithConnectors(t, { scope: { groups: ["read"] } });

  const transport = new SSEClientTransport(new URL(`${base}/sse/${connector.token}`));
  const client = new Client({ name: "sse-endpoint-test-connector", version: "1" });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); });

  // endpoint 必须指向连接器自己的口令
  const endpoint = new URL(transport._endpoint);
  assert.equal(endpoint.pathname, `/messages/${connector.token}`, `连接器的 endpoint 应该用连接器令牌，实际 ${endpoint.pathname}`);
  assert.ok(!String(endpoint).includes(routeToken), `endpoint 里不能出现主路径令牌：${String(endpoint)}`);

  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes(READ_TOOL), `有 read 分组，应该能看见 ${READ_TOOL}，实际：${names.join(", ")}`);
  assert.ok(!names.includes(ADMIN_TOOL), `只有 read 分组，不该看见 admin 分组的 ${ADMIN_TOOL}，实际：${names.join(", ")}`);
  assert.ok(!names.includes("run_command"), `不该看见 admin 分组的 run_command，实际：${names.join(", ")}`);

  // 越权调用要被拒（和 /mcp 同一套 tool-policy 判定），返回里也不能带主路径令牌
  const denied = await client.callTool({ name: ADMIN_TOOL, arguments: {} });
  assert.equal(denied.isError, true, "连接器调 admin 分组的工具应该被拒");
  assert.ok(!JSON.stringify(denied).includes(routeToken), "拒绝原因里不能出现主路径令牌");

  const ok = await client.callTool({ name: READ_TOOL, arguments: {} });
  assert.equal(ok.content?.find(part => part.type === "text")?.text, READ_TEXT);
  assert.ok(!JSON.stringify(ok).includes(routeToken), "工具返回里不能出现主路径令牌");
});

/* 审查第 5 条：跨身份串号 —— 用 B 的口令 POST A 的会话号必须 404 */
test("审查5：A 的连接器会话号，用 B 的口令发消息必须 404（跨身份串号）", async (t) => {
  const { connectors, connector, base, routeToken } = await startBridgeWithConnectors(t, { scope: { groups: ["read"] } });
  const other = connectors.create("另一个连接器", { scope: { groups: ["read"] } });

  const transport = new SSEClientTransport(new URL(`${base}/sse/${connector.token}`));
  const client = new Client({ name: "sse-endpoint-test-a", version: "1" });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); });
  const sidA = new URL(transport._endpoint).searchParams.get("sessionId");
  assert.ok(sidA, "A 应该拿到会话号");

  const post = (token) => fetch(`${base}/messages/${token}?sessionId=${sidA}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  // 别的连接器令牌：身份不同 → 404
  const crossConnector = await post(other.token);
  assert.equal(crossConnector.status, 404, `用 B 的口令发 A 的会话号必须 404，实际 ${crossConnector.status}`);

  // 主路径令牌：身份不同（connectorId 对不上）→ 404
  const crossMain = await post(routeToken);
  assert.equal(crossMain.status, 404, `用主路径令牌发连接器会话号必须 404，实际 ${crossMain.status}`);

  // 对照：用 A 自己的口令发是同一条会话，应当正常受理
  const own = await post(connector.token);
  assert.equal(own.status, 202, `用 A 自己的口令发消息应该 202，实际 ${own.status}`);
});

test("审查5：同一连接器的 SSE 会话到上限时，最老的被关掉", async (t) => {
  // CONNECTOR_MAX_SESSIONS = 8：开 9 条，第一条要被关掉，总数不再增长
  const { server, connector, base } = await startBridgeWithConnectors(t, { scope: { groups: ["read"] } });
  const transports = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
  });
  for (let index = 0; index < 9; index++) {
    const transport = new SSEClientTransport(new URL(`${base}/sse/${connector.token}`));
    const client = new Client({ name: `sse-endpoint-test-cap-${index}`, version: "1" });
    await client.connect(transport);
    transports.push(transport);
    clients.push(client);
  }
  assert.ok(await waitFor(() => server.sessionCount === 8), `连接器会话数应该封顶在 8，实际 ${server.sessionCount}`);

  const first = new URL(transports[0]._endpoint).searchParams.get("sessionId");
  assert.ok(!server.sessions.get(first), "最老的那条连接器会话应该被挤掉");
  const last = new URL(transports[8]._endpoint).searchParams.get("sessionId");
  assert.ok(server.sessions.get(last), "最后进来的那条要留着");

  // 被挤掉的那条再用旧会话号发消息：404
  const stale = await fetch(`${base}/messages/${connector.token}?sessionId=${first}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(stale.status, 404, "被挤掉的会话号再发消息应该 404");
});

/* 审查第 2 条：SSE 流没有心跳，经隧道空闲会被掐断 */
test("审查2：SSE 流有 : ping 心跳（间隔取 sseKeepAliveMs）", async (t) => {
  const { routeToken, base } = await startBridge(t, { sseKeepAliveMs: 50 });
  const text = await readStream(`${base}/sse/${routeToken}`, { ms: 500 });
  assert.match(text, /event: endpoint/, "流开头应该有 endpoint 事件");
  assert.ok(/: ping\n\n/.test(text), `应该收到心跳注释行，实际收到：${JSON.stringify(text.slice(0, 200))}`);
  assert.ok((text.match(/: ping/g) ?? []).length >= 2, "500ms 内、50ms 间隔应该收到不止一条心跳");
});

/* 审查第 3 条：SSE 流量不进 stats 和活动流 */
test("审查3：带 cf-ray 的 SSE 请求会计入 lastRequestAt / lastTunnelRequestAt 和活动流", async (t) => {
  const events = [];
  const { routeToken, base } = await startBridge(t, { onActivity: (event) => events.push(event) });
  // 建流是 GET /sse/<口令>；带 cf-ray 代表经隧道进来
  const text = await readStream(`${base}/sse/${routeToken}`, { ms: 300, headers: { accept: "text/event-stream", "cf-ray": "test-sse" } });
  assert.match(text, /event: endpoint/, "SSE 流要真的建起来");

  // healthz 本身不刷这两个时间，所以这里看到的值只可能来自刚才那次 SSE 请求
  const health = await (await fetch(`${base}/healthz/${routeToken}`)).json();
  assert.ok(health.lastRequestAt > 0, `SSE 请求要计入 lastRequestAt，实际 ${health.lastRequestAt}`);
  assert.ok(health.lastTunnelRequestAt > 0, `带 cf-ray 的 SSE 请求要计入 lastTunnelRequestAt，实际 ${health.lastTunnelRequestAt}`);
  assert.ok(
    await waitFor(() => events.some(event => event.kind === "request" && event.method === "GET")),
    `活动流里要有这次 GET 请求，实际：${JSON.stringify(events.map(event => event.kind))}`,
  );
});

/* 审查第 4 条：空闲会话只在「有新会话进来」时才回收 */
test("审查4：SessionRegistry 有定期回收的 unref 定时器，start/stop 成对", async () => {
  const registry = new SessionRegistry({ maxSessions: 4, idleMs: 10 });
  const closed = [];
  const entry = (id) => ({ lastActivity: Date.now(), transport: { close: async () => { closed.push(id); } }, server: { close: async () => {} } });
  registry.add("keep", entry("keep"));
  assert.ok(registry.timer === null, "没 start 之前不该有定时器");
  const timer = registry.start(20);
  assert.equal(registry.timer, timer, "start 要记下定时器");
  assert.equal(timer.hasRef?.(), false, "定时器必须 unref，不能拖住进程退出");

  // 会话先放进去、之后才变空闲：期间没有任何 add()（= 没有新会话进来）也必须被回收
  registry.get("keep").lastActivity = Date.now() - 1000;
  assert.ok(await waitFor(() => closed.includes("keep"), 2000), "没有新会话进来，空闲会话也要被定时器回收掉");
  registry.stop();
  assert.equal(registry.timer, null, "stop 要清掉定时器");
});

/* 审查第 4 条的另一半：桥启动时就要把这个定时器挂上，stop() 时要摘掉 */
test("审查4：BridgeServer.start 会启动会话回收定时器，stop 会停掉", async (t) => {
  const { server } = await startBridge(t);
  assert.ok(server.sessions.timer, "start() 之后会话回收定时器要在跑");
  assert.equal(server.sessions.timer.hasRef?.(), false, "定时器必须 unref，不拖住进程退出");
  await server.stop();
  assert.equal(server.sessions.timer, null, "stop() 要停掉定时器");
});

/* 审查第 6 条：测试自己的假注释 —— 这里真的测「没会话的普通 GET 是 400 missing_session」 */
test("/mcp 收到 SSE 式 GET 时回 405 并提示改用 /sse", async (t) => {
  const { base, routeToken } = await startBridge(t);
  const response = await fetch(`${base}/mcp/${routeToken}`, { headers: { accept: "text/event-stream" } });
  // fetch 可能自动跟随流，这里只关心状态码和正文；405 时没有流
  assert.equal(response.status, 405, `应该 405，实际 ${response.status}`);
  const body = await response.json();
  assert.match(body.message ?? "", /只支持 SSE/, "body 里要用中文提示改用 SSE");
  assert.equal(body.sse_endpoint, `/sse/${routeToken}`, "要告诉客户端正确的 /sse 地址");
});

/* 审查第 1 条第 3 点：/mcp/<连接器令牌> 的 405 不能把主路径令牌交出去 */
test("审查1：连接器令牌打 /mcp 的 405 提示里不出现主路径令牌", async (t) => {
  const { connector, base, routeToken } = await startBridgeWithConnectors(t, { scope: { groups: ["read"] } });
  const connectorResponse = await fetch(`${base}/mcp/${connector.token}`, { headers: { accept: "text/event-stream" } });
  assert.equal(connectorResponse.status, 405);
  const connectorBody = await connectorResponse.text();
  assert.ok(!connectorBody.includes(routeToken), `连接器的 405 里不能出现主路径令牌：${connectorBody}`);

  // 主路径令牌自己要照常给出可用地址（对照）
  const mainResponse = await fetch(`${base}/mcp/${routeToken}`, { headers: { accept: "text/event-stream" } });
  assert.equal((await mainResponse.json()).sse_endpoint, `/sse/${routeToken}`);
});

test("/mcp 原有行为不变：JSON 模式 initialize / tools/call 照常", async (t) => {
  const { base, routeToken } = await startBridge(t, { jsonResponse: true });
  const url = `${base}/mcp/${routeToken}`;
  const init = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sse-endpoint-test", version: "1" } } }),
  });
  assert.equal(init.status, 200);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid, "initialize 要回 mcp-session-id");
  assert.equal((await init.json()).result?.serverInfo?.name, "windrise");

  const call = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: READ_TOOL, arguments: {} } }),
  });
  const body = await call.json();
  assert.equal(body.id, 2);
  assert.equal(body.result?.content?.[0]?.text, READ_TEXT);

  // 没有任何会话的普通 GET（只认 JSON 的客户端）仍然是 400 missing_session，老行为不变
  const plainGet = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  const plainBody = await plainGet.json();
  assert.equal(plainGet.status, 400, `没会话号的普通 GET 应该 400，实际 ${plainGet.status}`);
  assert.equal(plainBody.error, "missing_session", `应该回 missing_session，实际 ${JSON.stringify(plainBody)}`);
});

/* 审查第 7 条：--tunnel 模式要打印启动信息（那段现在是 printBanner，同一条用例在下面真调它） */
test("审查7：standalone 的启动信息在 if/else 之后统一打印（--tunnel 也有）", () => {
  const source = readFileSync(new URL("../standalone.js", import.meta.url), "utf8");
  const tunnelIndex = source.indexOf('args.has("--tunnel")');
  const bannerIndex = source.indexOf("printBanner(app);");
  assert.ok(tunnelIndex > 0 && bannerIndex > 0, "两段代码都要在");
  assert.ok(bannerIndex > tunnelIndex, "启动信息要排在 --tunnel 分支之后（否则隧道模式看不到）");
  const bannerBody = source.slice(source.indexOf("export function printBanner"), source.indexOf("export function printBanner") + 900);
  assert.match(bannerBody, /健康检查/, "启动信息里要有健康检查地址");
});

/*
 * 审查 E 第 1 处缺口（上一轮残留）：bearer / OAuth 身份打 /mcp 的 405 也要测。
 * 这两个入口本来就没有可用的 /sse 地址，405 里绝对不能给出 sse_endpoint —— 更不能出现主路径令牌。
 * 「网页能写的属性不能用来放行安全判断」在这里的具体含义：口令 / OAuth 令牌都只从 Authorization 头拿，
 * 路径写成 /sse/<主路径令牌> 也换不来主身份以外的任何东西，反过来也不能让受限身份拿到主口令。
 */
test("审查E：bearer 口令和 OAuth 令牌打 /mcp 的 405 都不给 sse_endpoint、不泄露主路径令牌", async (t) => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const dataHome = mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
  const routeToken = randomBytes(16).toString("hex");
  const ownerAuth = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  const mainKey = ownerAuth.generate("主口令").key;
  const scopedKey = ownerAuth.addKey("只读口令", { scope: { groups: ["read"] } }).key;
  // OAuth：固定公网 base，令牌 audience 就是 <base>/mcp；状态文件里只存令牌哈希
  const publicBase = "https://sse-test.example";
  const oauthClientId = "wrc_" + randomBytes(16).toString("base64url");
  const oauthToken = "wro_" + randomBytes(30).toString("base64url");
  writeFileSync(path.join(dataHome, "oauth.json"), JSON.stringify({
    version: 1,
    clients: [{ clientId: oauthClientId, clientName: "SSE 测试客户端", redirectUris: ["https://client.example/cb"], createdAt: Date.now() }],
    accessTokens: [{
      id: "at-sse-test",
      hash: createHash("sha256").update(oauthToken).digest("hex"),
      clientId: oauthClientId,
      clientName: "SSE 测试客户端",
      groups: ["read"],
      audience: `${publicBase}/mcp`,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      lastUsedAt: 0,
    }],
    refreshTokens: [],
    revoked: [],
  }));

  const server = new BridgeServer({
    routeToken,
    dataHome,
    ownerAuth,
    oauth: { enabled: true, publicBaseUrl: publicBase },
    port: 0,
  });
  await server.start();
  t.after(async () => {
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await sleep(60);
    await server.stop().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const probe = async (label, headers) => {
    const response = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream", ...headers } });
    const text = await response.text();
    assert.equal(response.status, 405, `${label} 打 /mcp 应该 405，实际 ${response.status}：${text}`);
    const body = JSON.parse(text);
    assert.ok(!("sse_endpoint" in body), `${label} 没有可用的 SSE 地址，405 里不能给 sse_endpoint：${text}`);
    assert.ok(!text.includes(routeToken), `${label} 的 405 里不能出现主路径令牌：${text}`);
    assert.match(body.message ?? "", /没有可用的 SSE 地址/, `${label} 的提示要说清楚这个入口没有 SSE，实际：${text}`);
  };

  await probe("主口令", { authorization: `Bearer ${mainKey}` });
  await probe("只读口令", { authorization: `Bearer ${scopedKey}` });
  await probe("OAuth 令牌", { authorization: `Bearer ${oauthToken}` });
});

/*
 * 审查 E 第 3 处缺口：原来 --tunnel 那条只做源码字符串断言，证明不了「真的会打印」。
 * 现在 standalone 把启动信息抽成了 printBanner(app)，这里真的调一次，检查输出内容。
 */
test("审查E：printBanner() 真的打印本机地址 / 健康检查 / 工作区 / 共享目录 / 工具数量", async (t) => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.log = original; });

  printBanner({
    server: { localUrl: "http://127.0.0.1:1234/mcp/abc", healthUrl: () => "http://127.0.0.1:1234/healthz/abc" },
    snapshot: { workspace: { name: "测试工作区", kind: "folder" } },
    hub: { root: "G:/wr/wt-k2/.tmp/hub" },
  });

  const text = lines.join("\n");
  assert.match(text, /Bridge 已启动/);
  assert.match(text, /MCP 地址\s*:\s*http:\/\/127\.0\.0\.1:1234\/mcp\/abc/, `要打印 MCP 地址，实际：${text}`);
  assert.match(text, /健康检查\s*:\s*http:\/\/127\.0\.0\.1:1234\/healthz\/abc/, `要打印健康检查地址，实际：${text}`);
  assert.match(text, /工作区\s*:\s*测试工作区/, `要打印工作区，实际：${text}`);
  assert.match(text, /共享目录\s*:\s*G:\/wr\/wt-k2\/\.tmp\/hub/, `要打印共享目录，实际：${text}`);
  assert.match(text, /工具数量\s*:\s*\d+/, `要打印工具数量，实际：${text}`);
});

/*
 * 审查 E 第 1 处缺口（新问题 A 的立足点）：桥上的 SSE 会话被空闲回收时，
 * 客户端和登记表分别是什么状态。这里用桥自己的 SessionRegistry 走真实 prune。
 */
test("审查E：桥上只连不发的 SSE 会话被空闲回收时，登记表和客户端流都被收掉", async (t) => {
  const ctx = await openBridgeStream(t, { sseKeepAliveMs: 60_000 });
  const { server, stream, endpoint } = ctx;
  const sid = endpoint.searchParams.get("sessionId");
  // 关掉心跳续命的效果：把空闲线压到 0，再推一次真实 prune
  server.sessions.idleMs = -1;
  server.sessions.prune();
  assert.equal(server.sessions.get(sid), undefined, "过了空闲线就该从登记表里删掉");
  assert.equal(server.sessionCount, 0, "会话总数要回到 0");
  const closed = await Promise.race([stream.closed.then(() => true), sleep(2000).then(() => false)]);
  assert.equal(closed, true, "登记表删掉的同时，客户端那条流也要被关掉（不能留一条没人管的流）");
  const status = await postMessage(endpoint.href, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(status, 404, `已回收的会话 POST 必须 404，实际 ${status}`);
});

/* ================= 第三轮审查（rev2-k2）新问题 ================= */

/**
 * 用原始 http 往 /messages 发一条 MCP 消息，返回状态码。
 * 走的是和 SDK 客户端同一套链路（真 HTTP、真 transport），只是这里要方便并行 / 断言状态码。
 */
async function postMessage(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

/** 起桥并用原始 http 开一条 SSE 流，等到 endpoint 事件（= 服务端会话已经开到流上）再返回 */
async function openBridgeStream(t, extra = {}) {
  const ctx = await startBridge(t, extra);
  const stream = openStream(`${ctx.base}/sse/${ctx.routeToken}`);
  t.after(() => stream.abort());
  const ok = await waitFor(() => stream.endpoint() !== null);
  assert.ok(ok, `应该收到 endpoint 事件，实际收到：${JSON.stringify(stream.text().slice(0, 200))}`);
  return { ...ctx, stream, endpoint: stream.endpoint() };
}

/*
 * 新问题 A（中）：SSE 长连接空闲 30 分钟会被定时器掐断（心跳只写字节、不续命）。
 * 修前：idleMs 很小 + prune 一跑，只发了心跳、没发过消息的会话就被 #close 掉，流被服务端关。
 * 修后：心跳写成功即视为活跃，流一直开着；POST 照常能收。
 * 反过来还要确认「真断开的会话仍然会被回收」——不能为了保住空闲会话把回收整个关掉。
 */
test("审查A：只有心跳、不发消息的 SSE 会话不会被空闲回收掐断", async (t) => {
  const { server, stream, endpoint } = await openBridgeStream(t, { sseKeepAliveMs: 30 });
  const sid = endpoint.searchParams.get("sessionId");
  const entry = server.sessions.get(sid);
  // 装成「已经很久没发过 POST」：超过空闲上限，下一次 prune 本该把它回收
  const idleLine = () => Date.now() - server.sessions.idleMs;
  entry.lastActivity = idleLine() - 1000;
  // 心跳（30ms 一次）写成功后，lastActivity 会被推到现在
  assert.ok(await waitFor(() => entry.lastActivity > idleLine()), "心跳写成功要把 lastActivity 推后");
  // 此刻跑一次 prune：心跳还成功写着的会话不该被关（修前 lastActivity 从没被心跳推后，这里必被回收）
  server.sessions.prune();
  assert.ok(server.sessions.get(sid), "心跳写成功就是还活着，空闲回收不能掐掉它");

  // 再等几轮心跳：一直续命，会话一直在
  await sleep(150);
  assert.ok(server.sessions.get(sid), "若干轮心跳之后会话仍然在");
  assert.ok(entry.lastActivity > Date.now() - 60_000, "心跳写成功要把 lastActivity 推后");
  assert.equal(stream.headers["content-type"], "text/event-stream", "流没被服务端关掉");
  assert.match(stream.text(), /: ping/, "流上确实一直在写心跳");

  // 会话还能收消息（没有变成僵尸）
  const status = await postMessage(endpoint.href, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(status, 202, `心跳续命的会话 POST 应该 202，实际 ${status}`);
});

test("审查A：客户端真的断开后，服务端会话仍然会被回收（不会为了保活漏回收）", async (t) => {
  const { server, stream, endpoint } = await openBridgeStream(t, { sseKeepAliveMs: 30 });
  const sid = endpoint.searchParams.get("sessionId");
  stream.abort();
  const cleaned = await waitFor(() => !server.sessions.get(sid));
  assert.ok(cleaned, `客户端断开后会话应该被清掉，实际还剩 ${server.sessionCount} 个`);
});

/*
 * 新问题 B（中低）：transport.onclose 被整层覆盖，SDK 的 _onclose() 永远不执行。
 * 修前：sdkOnClose 在 connect() 之前取（必然 undefined），之后又把 onclose 整个换成 cleanup，
 * 客户端在工具调用中途断开时服务端不会中止调用、也不会拒掉挂起的响应。
 * 修后：connect() 之后才取 SDK 那层包装函数，cleanup 里调它 → _onclose() 真的会跑。
 */
test("审查B：SSE 断开时 SDK 的 onclose 那一层会被执行（进行中的请求被中止）", async (t) => {
  const { server, stream, endpoint } = await openBridgeStream(t);
  const sid = endpoint.searchParams.get("sessionId");
  const mcp = server.sessions.get(sid).server;

  // 模拟「有一个工具调用正在进行」：SDK 的 _onclose() 会把这张表里的 controller 全部 abort 再清空
  const aborted = new Promise(resolve => { mcp._requestHandlerAbortControllers.set("in-flight", { abort: () => resolve(true) }); });

  stream.abort();
  const result = await Promise.race([aborted, sleep(3000).then(() => false)]);
  assert.equal(result, true, "断开后 SDK 的 _onclose() 要中止进行中的调用；没被中止说明那一层被覆盖掉了");
  assert.equal(mcp._requestHandlerAbortControllers.size, 0, "SDK 中止后要清空进行中的调用表");
});

/*
 * 新问题 C（低）：心跳可能在 writeHead 之前写字节，把整条流写坏。
 * 修前：心跳不判 headersSent。只要有一轮心跳落在 connect()（内部才 writeHead）之前，
 * res.write 会隐式发出一个没有 text/event-stream 头的 200，随后 start() 的 writeHead 抛
 * ERR_HTTP_HEADERS_SENT；catch 里因为 headersSent 为 true 连 500 都不回，会话还留在登记表里。
 *
 * 怎么稳定复现：把 Server.prototype.connect 用一道闸门拖住（事件循环正常流动，心跳照常触发），
 * 等心跳先写过几轮再放行；res 用最小替身，语义和 node:http 一致（第一次 write 时隐式写头）。
 */
test("审查C：心跳先于 writeHead 触发时，流头和 endpoint 事件仍然正确", async (t) => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const routeToken = randomBytes(16).toString("hex");
  const server = new BridgeServer({ routeToken, dataHome: mkdirSync(path.join(tmpRoot, "data"), { recursive: true }), port: 0, sseKeepAliveMs: 5 });
  await server.start();
  let releaseConnect = () => {};
  const gate = new Promise(resolve => { releaseConnect = resolve; });
  const originalConnect = Server.prototype.connect;
  Server.prototype.connect = async function gated(transport) {
    await gate;
    return originalConnect.call(this, transport);
  };
  t.after(async () => {
    Server.prototype.connect = originalConnect;
    releaseConnect();
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await sleep(60);
    await server.stop().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  class FakeResponse {
    constructor() {
      this.headersSent = false;
      this.writableEnded = false;
      this.destroyed = false;
      this.chunks = [];
      this.events = [];
      this.listeners = new Map();
    }
    setHeader() { return this; }
    writeHead(status, headers) {
      if (this.headersSent) {
        this.events.push("writeHead:error");
        throw Object.assign(new Error("Cannot write headers after they are sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      }
      this.headersSent = true;
      this.status = status;
      this.headers = headers;
      this.events.push("writeHead");
      return this;
    }
    write(chunk) {
      // 和 node:http 一样：还没写头就先隐式发一个 200（这一份不带 Content-Type）
      if (!this.headersSent) {
        this.headersSent = true;
        this.status = 200;
        this.headers = {};
        this.implicit = true;
        this.events.push("implicit-200");
      }
      this.chunks.push(String(chunk));
      return true;
    }
    end() { this.writableEnded = true; }
    on(event, handler) { this.listeners.set(event, handler); }
  }

  const res = new FakeResponse();
  const pending = server.handle(
    { method: "GET", url: `/sse/${routeToken}`, headers: { accept: "text/event-stream", host: "127.0.0.1" } },
    res,
  );
  // 5ms 一轮心跳，等 40ms：心跳一定已经先触发过；connect 还被闸门挡着
  await sleep(40);
  // 这条正是审查 C 的判据：修前这里已经有伪头写出去（implicit-200），修后一次都不该有
  assert.equal(res.implicit, undefined, `心跳不能抢在 writeHead 之前写字节（会隐式发出没有 SSE 头的 200），实际事件：${JSON.stringify(res.events)}`);
  assert.ok(!res.headersSent, `connect 还没放行，就不该有任何字节写出去，实际事件：${JSON.stringify(res.events)}`);
  releaseConnect();
  await pending;
  await sleep(20);

  assert.equal(res.implicit, undefined, `心跳不能抢在 writeHead 之前写字节（会隐式发出没有 SSE 头的 200），实际事件：${JSON.stringify(res.events)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream", "流的第一段响应头必须是 text/event-stream");
  assert.ok(res.chunks.some(chunk => /event: endpoint/.test(chunk)), "endpoint 事件不能丢");
  assert.equal(server.sessionCount, 1, "握手成功就应该正好留一个会话");
});

/*
 * 新问题 D（低）：先登记会话、后开流的淘汰竞态。
 *
 * 真实时序是 handleLegacySse 里 sessions.add() 在 await server.connect() 之前，connect() 中间会
 * 让出事件循环，这期间别的请求可能已经把这条刚登记的会话挤掉；那时 transport 还没 start()，
 * close() 什么也关不掉，若不管它，connect() 之后照样开出一条「能收事件、但每个 POST 都 404」的流。
 *
 * 怎么稳定复现：把 Server.prototype.connect 用闸门拖住（相当于让出事件循环），先让两条都登记进表；
 * 再让会话表走「真实的空闲回收」——用假时钟把 prune 那一跳的时间推到 30 分钟之后，第一条就在
 * 「登记之后、start 之前」被淘汰掉了。两条请求都直接走 BridgeServer.handle（真实 HTTP 处理链路，
 * 只是 res 用替身），不 mock 中间层。
 */
test("审查D：登记之后、开流之前被淘汰的 SSE 流不会留成僵尸", async (t) => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const routeToken = randomBytes(16).toString("hex");
  const server = new BridgeServer({ routeToken, dataHome: mkdirSync(path.join(tmpRoot, "data"), { recursive: true }), port: 0 });
  await server.start();
  let releaseConnect = () => {};
  const gate = new Promise(resolve => { releaseConnect = resolve; });
  const originalConnect = Server.prototype.connect;
  Server.prototype.connect = async function gated(transport) {
    await gate;
    return originalConnect.call(this, transport);
  };
  t.after(async () => {
    Server.prototype.connect = originalConnect;
    releaseConnect();
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await sleep(60);
    await server.stop().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // 上限压到 1：第二条一登记就会把第一条挤掉
  server.sessions.max = 1;

  /*
   * 关键：sessions.add() 要发生在两条请求真正 HTTP 往返之前。这里直接调服务器的 handle，
   * 用两个 res 替身（语义和 node:http 一致：第一次 write 才隐式写头）。
   * 两条请求都停在 await connect() 上时，事件循环照常流动，会话表自己的 60 秒定时器会跳
   * （这里用假时钟把那一跳的时间推到 30 分钟之后）——第一条就从「登记了、还没 start」变成死会话。
   */
  const first = fakeRes();
  const firstPending = server.handle({ method: "GET", url: `/sse/${routeToken}`, headers: { accept: "text/event-stream", host: "127.0.0.1" } }, first);
  await sleep(5);
  const second = fakeRes();
  const secondPending = server.handle({ method: "GET", url: `/sse/${routeToken}`, headers: { accept: "text/event-stream", host: "127.0.0.1" } }, second);
  await sleep(5);
  assert.equal(server.sessionCount, 1, `上限是 1，只该留一条会话，实际 ${server.sessionCount}`);

  // 假时钟往前走 31 分钟，再触发一次定时器该做的事（prune）：两条都过了空闲线
  let fakeNow = Date.now();
  server.sessions.now = () => fakeNow;
  fakeNow += 31 * 60 * 1000;
  server.sessions.prune();
  assert.equal(server.sessionCount, 0, "两条都在空闲线上，prune 应该把它们都回收");
  fakeNow = Date.now();
  releaseConnect();
  await Promise.all([firstPending, secondPending]);
  await sleep(30);

  /*
   * 第一条、第二条在 connect() 放行之前就都被淘汰了（transport 还没 start，close() 关不掉任何东西）。
   * 修前：connect() 之后照常开着流，endpoint 事件发出去、POST 却全 404（僵尸）。
   * 修后：connect() 之后发现不在表里就自己收摊（res.end()），流立刻结束。
   * 注意 endpoint 事件是 SDK 的 start() 自己写的，修前修后都会发；真正区分两者的是流有没有被收掉。
   */
  assert.ok(first.writableEnded, `被淘汰的第一条必须自己收摊（res.end()），实际：trace=${first.trace.join(" | ")}`);
  assert.equal(first.trace.at(-1), "end", `收摊应该是最后一个动作，实际：${first.trace.join(" | ")}`);
  assert.ok(second.writableEnded, `被淘汰的第二条也必须自己收摊，实际：trace=${second.trace.join(" | ")}`);

  // 客户端拿到的会话号确实已失效（POST 404），而且不该有一条「活着但 POST 不通」的流
  const firstEndpoint = /event: endpoint\ndata: ([^\n]+)\n\n/.exec(first.chunks.join(""))?.[1];
  if (firstEndpoint) {
    const status = await postMessage(new URL(firstEndpoint, `${base}/sse/${routeToken}`).href, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(status, 404, `已淘汰会话的 POST 必须 404，实际 ${status}`);
  }
});

/*
 * 同一条竞态的「不掐错人」对照：没到上限时，先登记、后被闸门拖住的那条放行之后必须照常可用，
 * 不能因为多了个 closed 判断就把正常会话也收掉。
 */
test("审查D：没有淘汰时，connect 被拖慢的流放行后照常可用", async (t) => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-endpoint-test-"));
  const routeToken = randomBytes(16).toString("hex");
  const server = new BridgeServer({ routeToken, dataHome: mkdirSync(path.join(tmpRoot, "data"), { recursive: true }), port: 0 });
  await server.start();
  let releaseConnect = () => {};
  const gate = new Promise(resolve => { releaseConnect = resolve; });
  const originalConnect = Server.prototype.connect;
  Server.prototype.connect = async function gated(transport) {
    await gate;
    return originalConnect.call(this, transport);
  };
  t.after(async () => {
    Server.prototype.connect = originalConnect;
    releaseConnect();
    if (server.callLog?.flush) await server.callLog.flush().catch(() => {});
    else await sleep(60);
    await server.stop().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const stream = openStream(`${base}/sse/${routeToken}`);
  t.after(() => stream.abort());
  assert.ok(await waitFor(() => server.sessionCount === 1), `会话应该先登记进表，实际 ${server.sessionCount}`);
  await sleep(50);
  releaseConnect();
  assert.ok(await waitFor(() => stream.endpoint() !== null, 2000), "放行后应该开出流并收到 endpoint 事件");
  const endpoint = stream.endpoint();
  assert.ok(endpoint && server.sessions.get(endpoint.searchParams.get("sessionId")), "会话要留在表里");
  const status = await postMessage(endpoint.href, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(status, 202, `正常会话 POST 应该 202，实际 ${status}`);
});

/** 最小 res 替身：语义和 node:http 一致（第一次 write 才隐式写头），用来观察写了什么、结尾没有 */
function fakeRes() {
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: [],
    trace: [],
    listeners: new Map(),
    setHeader() { return res; },
    writeHead(status, headers) {
      if (res.headersSent) {
        res.trace.push("writeHead:error");
        throw Object.assign(new Error("Cannot write headers after they are sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      }
      res.headersSent = true;
      res.status = status;
      res.headers = headers;
      res.trace.push("writeHead");
      return res;
    },
    write(chunk) {
      if (!res.headersSent) { res.headersSent = true; res.status = 200; res.headers = {}; res.trace.push("implicit-200"); }
      const text = String(chunk);
      res.chunks.push(text);
      res.trace.push("write:" + text.slice(0, 16).replace(/\n/g, "\\n"));
      return true;
    },
    end() { res.writableEnded = true; res.trace.push("end"); },
    on(event, handler) { res.listeners.set(event, handler); },
  };
  return res;
}


test.after(() => {
  unregisterTool(READ_TOOL);
  unregisterTool(ADMIN_TOOL);
});


