#!/usr/bin/env node
/**
 * 换主路径令牌 —— 自检（route-token.js 的 loadOrCreateRouteToken / rotateRouteToken）。
 *
 * 运行：node src/route-token-rotate-selftest.mjs
 *
 * 覆盖：首次生成、换令牌后读回、文件内容与残留检查、连续换 5 次、文件不存在时直接换；
 *      以及端到端（旧令牌桥 → 换令牌 → 新令牌桥，旧地址立即 404）和 session-open 事件。
 * 副作用隔离：数据写在系统临时目录。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";
import { loadOrCreateRouteToken, rotateRouteToken, routeTokenFile } from "./core/route-token.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "route-token-rotate-selftest-"));
const tokenHome = path.join(tmpRoot, "tokens");
const freshHome = path.join(tmpRoot, "fresh");
const e2eHome = path.join(tmpRoot, "e2e");
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "route-token-rotate-selftest", version: "1" } };

const send = (url, { method = "POST", sid, body } = {}) => fetch(url, {
  method,
  headers: { ...HEADERS, ...(sid ? { "mcp-session-id": sid } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const readToken = (root) => JSON.parse(readFileSync(routeTokenFile(root), "utf8"));
const tempLeftovers = (root) => readdirSync(root).filter((name) => name.endsWith(".tmp"));
const short = (token) => (token ? `${token.slice(0, 8)}…` : "（无）");

let first = null;
let second = null;
try {
  // 1. 首次生成 → 换令牌 → 再读，读到的必须是新令牌
  const created = await loadOrCreateRouteToken(tokenHome);
  check(
    "第一次 loadOrCreateRouteToken：生成 32 位十六进制令牌，created=true",
    created.created === true && TOKEN_PATTERN.test(created.token),
    `created=${created.created} token=${short(created.token)}`,
  );
  const oldToken = created.token;

  const rotated = await rotateRouteToken(tokenHome);
  check(
    "rotateRouteToken：新令牌也是 32 位十六进制，且和旧的不同",
    TOKEN_PATTERN.test(rotated.token) && rotated.token !== oldToken,
    `旧 ${short(oldToken)} 新 ${short(rotated.token)}`,
  );
  check(
    "rotateRouteToken 返回的 file 就是令牌文件",
    rotated.file === routeTokenFile(tokenHome),
    rotated.file,
  );

  const reloaded = await loadOrCreateRouteToken(tokenHome);
  check(
    "换完再 loadOrCreateRouteToken：读到新令牌，created=false",
    reloaded.token === rotated.token && reloaded.created === false,
    `created=${reloaded.created} 一致=${reloaded.token === rotated.token}`,
  );

  // 2. 文件里只留新令牌；目录里不留临时文件
  const raw = readFileSync(routeTokenFile(tokenHome), "utf8");
  const stored = readToken(tokenHome);
  check(
    "令牌文件里只有新令牌、没有旧令牌",
    stored.token === rotated.token && !raw.includes(oldToken),
    `文件里的 token=${short(stored.token)}，含旧令牌=${raw.includes(oldToken)}`,
  );
  const leftovers = tempLeftovers(tokenHome);
  check(
    "令牌目录里没有 .tmp 残留",
    leftovers.length === 0,
    leftovers.length ? leftovers.join(", ") : "无",
  );

  // 3. 连换 5 次，5 个令牌互不相同（顺带和换之前那把也比）
  const seen = new Set([rotated.token]);
  const freshTokens = [];
  let duplicate = "";
  for (let i = 0; i < 5; i++) {
    const next = await rotateRouteToken(tokenHome);
    if (!TOKEN_PATTERN.test(next.token) || seen.has(next.token)) {
      duplicate = `第 ${i + 1} 次得到 ${short(next.token)}${TOKEN_PATTERN.test(next.token) ? "（重复）" : "（格式不对）"}`;
      break;
    }
    seen.add(next.token);
    freshTokens.push(next.token);
  }
  check(
    "连换 5 次：5 个新令牌互不相同且都是 32 位十六进制",
    !duplicate && freshTokens.length === 5 && seen.size === 6,
    duplicate || `${freshTokens.map(short).join(" ")}（含换之前那把共 ${seen.size} 个不同）`,
  );

  // 4. 文件不存在时直接换，也能生成新文件
  const fresh = await rotateRouteToken(freshHome);
  check(
    "文件不存在时直接 rotateRouteToken：生成 32 位十六进制令牌和新文件",
    TOKEN_PATTERN.test(fresh.token) && existsSync(routeTokenFile(freshHome)),
    `token=${short(fresh.token)} 文件=${existsSync(routeTokenFile(freshHome))}`,
  );
  const freshReload = await loadOrCreateRouteToken(freshHome);
  check(
    "直接换出来的令牌能被 loadOrCreateRouteToken 读回（created=false）",
    freshReload.token === fresh.token && freshReload.created === false,
    `created=${freshReload.created} 一致=${freshReload.token === fresh.token}`,
  );

  // 5. 端到端：旧令牌起桥 → 停桥换令牌 → 新令牌起新桥；旧地址必须立刻 404
  const e2eCreated = await loadOrCreateRouteToken(e2eHome);
  const e2eOld = e2eCreated.token;
  const events = [];

  first = new BridgeServer({
    routeToken: e2eOld,
    dataHome: e2eHome,
    port: 0,
    onActivity: (event) => events.push(event),
  });
  await first.start();
  const oldInit = await send(first.localUrl, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT } });
  const oldSid = oldInit.headers.get("mcp-session-id");
  check("旧令牌起桥：initialize 200 并拿到会话号", oldInit.status === 200 && Boolean(oldSid), `HTTP ${oldInit.status}，会话号 ${oldSid ? "有" : "没有"}`);
  const oldOpen = events.find((event) => event.kind === "session-open");
  check(
    "onActivity 收到 session-open：via 为 path",
    Boolean(oldOpen) && oldOpen.via === "path" && Boolean(oldOpen.sessionId) && Number.isFinite(oldOpen.at),
    JSON.stringify(oldOpen ?? null).replaceAll(e2eOld, short(e2eOld)),
  );
  await first.stop();
  first = null;

  const e2eRotated = await rotateRouteToken(e2eHome);
  const e2eNew = e2eRotated.token;
  check(
    "同一 dataHome 换令牌：文件里是新令牌，和旧的不同",
    e2eNew !== e2eOld && readToken(e2eHome).token === e2eNew,
    `旧 ${short(e2eOld)} 新 ${short(e2eNew)}`,
  );

  events.length = 0;
  second = new BridgeServer({
    routeToken: e2eNew,
    dataHome: e2eHome,
    port: 0,
    onActivity: (event) => events.push(event),
  });
  await second.start();
  const newInit = await send(second.localUrl, { body: { jsonrpc: "2.0", id: 2, method: "initialize", params: INIT } });
  const newSid = newInit.headers.get("mcp-session-id");
  check("新令牌起新桥：新地址 initialize 200", newInit.status === 200 && Boolean(newSid), `HTTP ${newInit.status}，会话号 ${newSid ? "有" : "没有"}`);
  const newOpen = events.find((event) => event.kind === "session-open");
  check(
    "新桥 onActivity 的 session-open 也带 via: \"path\"",
    Boolean(newOpen) && newOpen.via === "path" && Boolean(newOpen.sessionId) && Number.isFinite(newOpen.at),
    JSON.stringify(newOpen ?? null).replaceAll(e2eNew, short(e2eNew)),
  );

  const oldUrl = second.localUrl.replace(e2eNew, e2eOld);
  const staleInit = await send(oldUrl, { body: { jsonrpc: "2.0", id: 3, method: "initialize", params: INIT } });
  check("旧地址 /mcp/<旧令牌>：404", staleInit.status === 404, `HTTP ${staleInit.status}`);
  const staleHealth = await fetch(second.healthUrl().replace(e2eNew, e2eOld));
  check("/healthz/<旧令牌>：404", staleHealth.status === 404, `HTTP ${staleHealth.status}`);
  const newHealth = await fetch(second.healthUrl());
  check("/healthz/<新令牌>：200", newHealth.status === 200, `HTTP ${newHealth.status}`);
} catch (error) {
  check("自检跑完没有异常", false, error?.stack || String(error));
} finally {
  await first?.stop().catch(() => {});
  await second?.stop().catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
