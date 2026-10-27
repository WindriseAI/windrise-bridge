/**
 * BridgeServer.stop() 的回归测试。
 *   node --test src/core/bridge-stop.test.js
 *
 * stop() 会等每个会话的 handleRequest 真正收尾（否则 SSE 响应句柄还在，进程退出会碰 libuv 断言）。
 * 但隧道半开 / 客户端不读 body 时那个 promise 可能永远不 resolve，所以必须带上限：
 * 任何一个会话不收尾都不能把「停止 Bridge」和退出流程永久挂住。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeServer } from "./bridge.js";

test("会话的 requestDone 永不收尾时，stop() 也要在超时内返回", { timeout: 15000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "bridge-stop-"));
  const server = new BridgeServer({ routeToken: "stop-timeout-test-token", dataHome: home, port: 0, jsonResponse: true });
  await server.start();
  // 造一个「响应写不出去」的会话：transport.close 正常，但 handleRequest 永远不 resolve
  server.sessions.sessions.set("hung-session", {
    transport: { close: () => {} },
    requestDone: new Promise(() => {}),
    lastActivity: Date.now(),
  });
  const startedAt = Date.now();
  try {
    const stopped = await Promise.race([
      server.stop().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
    ]);
    assert.equal(stopped, true, "stop() 不能在等待会话收尾时永久挂住");
    assert.ok(Date.now() - startedAt < 6000, `stop() 用了 ${Date.now() - startedAt}ms`);
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 清理失败无所谓 */ }
  }
});