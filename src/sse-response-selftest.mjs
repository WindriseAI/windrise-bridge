#!/usr/bin/env node
/**
 * SSE 边跑边回 —— 端到端自检（真的起 Bridge、真的走 MCP 协议看响应头什么时候到）。
 *
 * 运行：node src/sse-response-selftest.mjs
 *
 * 为什么要有：
 *   JSON 一次性响应要等工具跑完才回响应头，超过约 100 秒 Cloudflare 隧道就回 524，
 *   客户端以为桥断了。SSE 模式立刻回响应头、按 keepAliveMs 发 `: keepalive` 注释行，
 *   长调用就不会被掐。这个自检把「头是立刻回的」「心跳真的在发」「结果没丢」都跑一遍。
 *
 * 覆盖：SSE 下 initialize / tools/call 的响应类型与内容、结果前的 keepalive 行数、响应头耗时；
 *      JSON 模式回归；Node 的 keepAliveTimeout / headersTimeout；respondJson 遇到已发头不抛错。
 * 副作用隔离：数据写在系统临时目录，不碰真实的 ~/.bridge-replica。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";
import { registerTool, unregisterTool } from "./core/registry.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sse-response-selftest-"));
const dataHome = path.join(tmpRoot, "data");
const routeToken = randomBytes(16).toString("hex");
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sse-response-selftest", version: "1" } };

/** 慢工具：等 1200ms 才回，够 keepalive（200ms）发好几轮 */
const SLOW_TOOL = "sse_slow";
const SLOW_MS = 1200;
registerTool({
  name: SLOW_TOOL,
  title: "慢工具",
  description: "自检用：等一会儿再回 done",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  handler: async () => {
    await new Promise(resolve => setTimeout(resolve, SLOW_MS));
    return { content: [{ type: "text", text: "done" }] };
  },
});

const post = (url, body, sid) => fetch(url, {
  method: "POST",
  headers: { ...HEADERS, ...(sid ? { "mcp-session-id": sid } : {}) },
  body: JSON.stringify(body),
});

/**
 * 把 SSE 响应体拆成消息，并记录每条消息之前出现过几行 `: keepalive`。
 * SDK 的心跳就是一行注释，不是 event，所以只能按行数。
 */
function parseSse(text) {
  const messages = [];
  let keepAlives = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === ": keepalive") { keepAlives++; continue; }
    if (!line.startsWith("data: ")) continue;
    try {
      messages.push({ keepAlivesBefore: keepAlives, payload: JSON.parse(line.slice("data: ".length)) });
    } catch {
      // 不是 JSON 的 data 行与本自检无关，跳过
    }
  }
  return messages;
}

let sseServer = null;
let jsonServer = null;
try {
  /* ---------------------------------------------------------------- *
   * a1：SSE 模式握手
   * ---------------------------------------------------------------- */
  console.log("\n=== a1 SSE 模式握手 ===");
  sseServer = new BridgeServer({ routeToken, dataHome, port: 0, jsonResponse: false, sseKeepAliveMs: 200 });
  await sseServer.start();
  const url = sseServer.localUrl;

  const initRes = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  const initType = initRes.headers.get("content-type") ?? "";
  const sid = initRes.headers.get("mcp-session-id");
  const initMessages = parseSse(await initRes.text());
  const initPayload = initMessages.find(item => item.payload?.id === 1)?.payload;

  check("a1 initialize 回 text/event-stream", initType.includes("text/event-stream"), initType);
  check(
    "a1 initialize 结果能从 SSE data 行解析出来",
    initPayload?.result?.protocolVersion === INIT.protocolVersion,
    initPayload?.result ? `protocolVersion=${initPayload.result.protocolVersion}` : "没解析到结果",
  );
  check("a1 拿到 mcp-session-id", Boolean(sid), sid ? `会话号 ${sid.slice(0, 8)}…` : "没有会话号");

  const notified = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  check("a1 notifications/initialized 被接受", notified.status < 400, `HTTP ${notified.status}`);

  /* ---------------------------------------------------------------- *
   * a2：慢工具调用 —— 头立刻回、心跳在发、结果还在
   * ---------------------------------------------------------------- */
  console.log("\n=== a2 慢工具调用（SSE 心跳）===");
  const startedAt = Date.now();
  const callRes = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: SLOW_TOOL, arguments: {} } }, sid);
  const headersMs = Date.now() - startedAt;
  const callType = callRes.headers.get("content-type") ?? "";
  const callMessages = parseSse(await callRes.text());
  const totalMs = Date.now() - startedAt;
  const callEntry = callMessages.find(item => item.payload?.id === 2);

  check("a2 慢工具也回 text/event-stream", callType.includes("text/event-stream"), callType);
  check(
    "a2 响应头立刻回（不等人跑完）",
    headersMs < 600,
    `响应头 ${headersMs}ms（整个过程 ${totalMs}ms）`,
  );
  check(
    "a2 结果 data 行之前至少 3 行 : keepalive",
    (callEntry?.keepAlivesBefore ?? 0) >= 3,
    `${callEntry?.keepAlivesBefore ?? 0} 行`,
  );
  check(
    "a2 结果内容正确（done，id 对得上）",
    callEntry?.payload?.result?.content?.[0]?.text === "done" && callEntry?.payload?.id === 2,
    callEntry?.payload ? `id=${callEntry.payload.id} text=${callEntry.payload.result?.content?.[0]?.text}` : "没解析到结果",
  );

  /* ---------------------------------------------------------------- *
   * a3：JSON 模式回归
   * ---------------------------------------------------------------- */
  console.log("\n=== a3 JSON 模式回归 ===");
  jsonServer = new BridgeServer({ routeToken: randomBytes(16).toString("hex"), dataHome, port: 0, jsonResponse: true });
  await jsonServer.start();
  const jsonUrl = jsonServer.localUrl;

  const jsonInit = await post(jsonUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  const jsonSid = jsonInit.headers.get("mcp-session-id");
  await jsonInit.text();
  const jsonCall = await post(jsonUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: SLOW_TOOL, arguments: {} } }, jsonSid);
  const jsonType = jsonCall.headers.get("content-type") ?? "";
  const jsonBody = await jsonCall.json();

  check("a3 jsonResponse: true 回 application/json", jsonType.includes("application/json"), jsonType);
  check(
    "a3 JSON 模式下结果正确",
    jsonBody?.id === 2 && jsonBody?.result?.content?.[0]?.text === "done",
    `id=${jsonBody?.id} text=${jsonBody?.result?.content?.[0]?.text}`,
  );

  /* ---------------------------------------------------------------- *
   * a4：连接的存活参数
   * ---------------------------------------------------------------- */
  console.log("\n=== a4 连接存活参数 ===");
  check(
    "a4 keepAliveTimeout = 120000",
    sseServer.httpServer.keepAliveTimeout === 120000,
    String(sseServer.httpServer.keepAliveTimeout),
  );
  check(
    "a4 headersTimeout 比 keepAliveTimeout 大",
    sseServer.httpServer.headersTimeout > sseServer.httpServer.keepAliveTimeout,
    `${sseServer.httpServer.headersTimeout} > ${sseServer.httpServer.keepAliveTimeout}`,
  );

  /* ---------------------------------------------------------------- *
   * a5：SSE 已开始写之后 respondJson 不能再写头
   * ---------------------------------------------------------------- */
  console.log("\n=== a5 已发响应头时的 respondJson ===");
  const fakeRes = {
    headersSent: true,
    ended: 0,
    writeHeadCalls: 0,
    end() { this.ended++; },
    writeHead() { this.writeHeadCalls++; },
  };
  let threw = null;
  try {
    sseServer.respondJson(fakeRes, 500, { error: "boom" });
  } catch (error) {
    threw = error;
  }
  check("a5 headersSent 时不抛错", threw === null, threw ? String(threw.code ?? threw.message) : "没有抛");
  check(
    "a5 只调 end()、不再 writeHead",
    fakeRes.ended === 1 && fakeRes.writeHeadCalls === 0,
    `end=${fakeRes.ended} writeHead=${fakeRes.writeHeadCalls}`,
  );
} catch (error) {
  check("自检跑完没有异常", false, error?.stack || String(error));
} finally {
  await sseServer?.stop().catch(() => {});
  await jsonServer?.stop().catch(() => {});
  unregisterTool(SLOW_TOOL);
  rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter(item => !item.ok);
console.log(`\n结果：通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
