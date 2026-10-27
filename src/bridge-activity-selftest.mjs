#!/usr/bin/env node
/**
 * 外部活动时间 —— 端到端自检（真的起 Bridge、真的走 HTTP / MCP 协议）。
 *
 * 运行：node src/bridge-activity-selftest.mjs
 *
 * 为什么要有：隧道断了以后，用户和 AI 都看不出「外面最后一次连进来是几点」。
 * 状态里要显示当前会话数和最后一次经公网（Cloudflare 隧道 / ngrok）进来的 MCP 请求时间；
 * 公网实测只打 /healthz，不能把这两个时间刷成刚刚。
 *
 * 覆盖：/healthz 不影响 lastRequestAt；不带 cf-ray 的 initialize 只更新 lastRequestAt；
 *      带 cf-ray 的请求同时更新 lastTunnelRequestAt；错令牌的 404 路径两个值都不动；
 *      只带 x-forwarded-for（ngrok）也算经公网。
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

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bridge-activity-selftest-"));
const dataHome = path.join(tmpRoot, "data");
const routeToken = randomBytes(16).toString("hex");
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-activity-selftest", version: "1" } };

const send = (url, { method = "POST", headers = {}, body } = {}) => fetch(url, {
  method,
  headers: { ...HEADERS, ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let bridge = null;
try {
  bridge = new BridgeServer({ routeToken, dataHome, port: 0 });
  await bridge.start();

  const healthResponse = await fetch(bridge.healthUrl());
  const health = await healthResponse.json();
  const afterHealth = bridge.healthSummary();
  check(
    "GET /healthz 不算 MCP 请求：lastRequestAt 仍是 null",
    healthResponse.status === 200 && afterHealth.lastRequestAt === null && afterHealth.lastTunnelRequestAt === null,
    `HTTP ${healthResponse.status}，lastRequestAt=${afterHealth.lastRequestAt}，lastTunnelRequestAt=${afterHealth.lastTunnelRequestAt}，/healthz 里 lastRequestAt=${health.lastRequestAt}`,
  );

  const localInit = await send(bridge.localUrl, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT } });
  const afterLocal = bridge.healthSummary();
  check(
    "不带 cf-ray 的 initialize：更新 lastRequestAt，lastTunnelRequestAt 仍为 null",
    localInit.status === 200 && Number.isFinite(afterLocal.lastRequestAt) && afterLocal.lastRequestAt > 0 && afterLocal.lastTunnelRequestAt === null,
    `HTTP ${localInit.status}，lastRequestAt=${afterLocal.lastRequestAt}，lastTunnelRequestAt=${afterLocal.lastTunnelRequestAt}`,
  );

  await new Promise(resolve => setTimeout(resolve, 5));
  const tunnelInit = await send(bridge.localUrl, { headers: { "cf-ray": "test-123" }, body: { jsonrpc: "2.0", id: 2, method: "initialize", params: INIT } });
  const afterTunnel = bridge.healthSummary();
  check(
    "带 cf-ray 的 initialize：lastTunnelRequestAt 有值，且不早于 lastRequestAt",
    tunnelInit.status === 200 && Number.isFinite(afterTunnel.lastTunnelRequestAt) && afterTunnel.lastTunnelRequestAt > 0 && afterTunnel.lastTunnelRequestAt >= afterTunnel.lastRequestAt,
    `HTTP ${tunnelInit.status}，lastRequestAt=${afterTunnel.lastRequestAt}，lastTunnelRequestAt=${afterTunnel.lastTunnelRequestAt}`,
  );

  const beforeWrong = { ...bridge.healthSummary() };
  const address = bridge.address();
  const wrongUrl = `http://127.0.0.1:${address.port}/mcp/${randomBytes(8).toString("hex")}`;
  const wrong = await send(wrongUrl, { body: { jsonrpc: "2.0", id: 3, method: "initialize", params: INIT } });
  const afterWrong = bridge.healthSummary();
  check(
    "错令牌的 404 路径不改这两个时间",
    wrong.status === 404 && afterWrong.lastRequestAt === beforeWrong.lastRequestAt && afterWrong.lastTunnelRequestAt === beforeWrong.lastTunnelRequestAt,
    `HTTP ${wrong.status}，lastRequestAt ${beforeWrong.lastRequestAt}→${afterWrong.lastRequestAt}，lastTunnelRequestAt ${beforeWrong.lastTunnelRequestAt}→${afterWrong.lastTunnelRequestAt}`,
  );

  await new Promise(resolve => setTimeout(resolve, 5));
  const beforeNgrok = { ...bridge.healthSummary() };
  const ngrokInit = await send(bridge.localUrl, { headers: { "x-forwarded-for": "203.0.113.7" }, body: { jsonrpc: "2.0", id: 6, method: "initialize", params: INIT } });
  const afterNgrok = bridge.healthSummary();
  check(
    "只带 x-forwarded-for（ngrok）的 initialize：更新 lastTunnelRequestAt",
    ngrokInit.status === 200 && afterNgrok.lastTunnelRequestAt > beforeNgrok.lastTunnelRequestAt && afterNgrok.lastTunnelRequestAt >= afterNgrok.lastRequestAt,
    `HTTP ${ngrokInit.status}，lastRequestAt=${afterNgrok.lastRequestAt}，lastTunnelRequestAt=${afterNgrok.lastTunnelRequestAt}`,
  );
} catch (error) {
  check("自检跑完没有异常", false, error?.stack || String(error));
} finally {
  await bridge?.stop().catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
