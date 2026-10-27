#!/usr/bin/env node
/**
 * 失效会话返回 404 —— 端到端自检（真的起 Bridge、真的走 MCP 协议）。
 *
 * 运行：node src/session-404-selftest.mjs
 *
 * 为什么要有（2026-10-24 诊断，见 docs/research/bridge-disconnect-2026-10-24.md）：
 *   桥一重启、或会话被清掉，远端 AI 拿旧会话号来请求，原来回 400「Server not initialized」。
 *   MCP 规范要求回 404，客户端看到 404 才会重新 initialize；回 400 它就一直报错，像是「桥断了」。
 *
 * 覆盖：重启后旧会话 POST / GET / DELETE 都是 404 且带 JSON-RPC 错误；带旧会话号的 initialize 能开新会话；
 *      没带会话号的 GET 仍是 400；健康检查里能看到被拒次数。
 * 副作用隔离：数据写在系统临时目录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "session-404-selftest-"));
const dataHome = path.join(tmpRoot, "data");
const routeToken = randomBytes(16).toString("hex");
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
/** 模拟「只认 JSON」的客户端：GET 时不带 text/event-stream，老行为应该是 400 missing_session */
const JSON_ONLY = { "content-type": "application/json", accept: "application/json" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-404-selftest", version: "1" } };

const send = (url, { method = "POST", sid, body } = {}) => fetch(url, {
  method,
  headers: { ...HEADERS, ...(sid ? { "mcp-session-id": sid } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async (response) => response.json().catch(() => null);

let first = null;
let second = null;
try {
  first = new BridgeServer({ routeToken, dataHome, port: 0 });
  await first.start();
  const init = await send(first.localUrl, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT } });
  const oldSid = init.headers.get("mcp-session-id");
  const listed = await send(first.localUrl, { sid: oldSid, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
  check("正常会话：initialize 拿到会话号，tools/list 成功", Boolean(oldSid) && listed.status === 200, `会话号 ${oldSid ? "有" : "没有"}，HTTP ${listed.status}`);

  // 模拟「软件重启 / 断开再连接」：停掉这个桥，同一把令牌再起一个
  await first.stop();
  first = null;
  second = new BridgeServer({ routeToken, dataHome, port: 0 });
  await second.start();
  const url = second.localUrl;

  const stalePost = await send(url, { sid: oldSid, body: { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} } });
  const stalePostBody = await json(stalePost);
  check(
    "重启后拿旧会话号 POST：404，JSON-RPC 错误 -32001，id 原样带回",
    stalePost.status === 404 && stalePostBody?.error?.code === -32001 && stalePostBody?.id === 7,
    `HTTP ${stalePost.status} ${JSON.stringify(stalePostBody)}`,
  );
  check("被拒的请求没有在桥上留下会话", second.sessions.size === 0, `会话 ${second.sessions.size} 个`);

  const staleGet = await send(url, { method: "GET", sid: oldSid });
  check("重启后拿旧会话号 GET：404", staleGet.status === 404, `HTTP ${staleGet.status}`);
  const staleDelete = await send(url, { method: "DELETE", sid: oldSid });
  check("重启后拿旧会话号 DELETE：404", staleDelete.status === 404, `HTTP ${staleDelete.status}`);

  const reinit = await send(url, { sid: oldSid, body: { jsonrpc: "2.0", id: 8, method: "initialize", params: INIT } });
  const newSid = reinit.headers.get("mcp-session-id");
  check("带着旧会话号重新 initialize：开出新会话", reinit.status === 200 && Boolean(newSid) && newSid !== oldSid, `HTTP ${reinit.status}，新会话号 ${newSid ? "有" : "没有"}`);
  const afterReinit = await send(url, { sid: newSid, body: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} } });
  check("新会话能正常用", afterReinit.status === 200, `HTTP ${afterReinit.status}`);

  const bareGet = await fetch(url, { method: "GET", headers: JSON_ONLY });
  const bareGetBody = await json(bareGet);
  check("没带会话号的 GET 仍是 400 missing_session（规范如此）", bareGet.status === 400 && bareGetBody?.error === "missing_session", `HTTP ${bareGet.status} ${JSON.stringify(bareGetBody)}`);

  /*
   * 只支持 SSE 的旧客户端（通义灵码 IDE / ChatWise 旧服务器）会把 /mcp 当 SSE 端点：GET + Accept: text/event-stream、
   * 没有会话头。这时要回 405 并告诉它换 /sse/<口令>，而不是 400「请先 POST」这种它看不懂的提示。
   */
  const sseStyleGet = await fetch(url, { headers: { accept: "text/event-stream" } });
  const sseStyleBody = await json(sseStyleGet);
  check(
    "GET + Accept: text/event-stream 无会话号：405 且提示改用 /sse",
    sseStyleGet.status === 405 && sseStyleBody?.error === "method_not_allowed" && /只支持 SSE/.test(sseStyleBody?.message ?? ""),
    `HTTP ${sseStyleGet.status} ${JSON.stringify(sseStyleBody)}`,
  );

  const health = await (await fetch(second.healthUrl())).json();
  check("健康检查里记下了被拒的失效会话请求（3 次）", health.staleSessions === 3, `staleSessions=${health.staleSessions}`);
} catch (error) {
  check("自检跑完没有异常", false, error?.stack || String(error));
} finally {
  // 调用日志是排队异步写的：先等它排完再删临时目录，免得出现 ENOENT 的干扰信息
  await first?.callLog?.flush?.().catch(() => {});
  await second?.callLog?.flush?.().catch(() => {});
  await first?.stop().catch(() => {});
  await second?.stop().catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - failed.length}/${results.length}`);
// 用 exitCode 而不是 process.exit()：让调用日志的排队写入和 socket 收尾自然跑完，
// 强退会触发 libuv 的 UV_HANDLE_CLOSING 断言噪音（不影响结果，但看着像出错）
process.exitCode = failed.length ? 1 : 0;
