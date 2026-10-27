#!/usr/bin/env node
/**
 * 口令入口（Bearer）—— 端到端自检（真的起 Bridge、真的走 MCP 协议）。
 *
 * 运行：node src/bearer-auth-selftest.mjs
 * 方案：docs/research/bearer-auth-2026-10-25.md
 *
 * 覆盖：口令生成只存哈希；/mcp + 对的口令能 initialize / tools/list；错口令、没带、Basic、乱格式一律 404；
 *      口令会话和路径会话不能串用；换口令后旧口令 404、旧会话断开；路径令牌对公网关掉后经隧道 404、本机照常、健康检查照常；
 *      没口令时不许关路径；撤口令恢复路径；连接器切口令模式后旧路径令牌 404、切回后发新令牌、旧令牌不复活；
 *      坏文件按默认运行并留备份；重启后设置还在。
 * 副作用隔离：数据写在系统临时目录。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";
import { ConnectorStore, connectorsFile } from "./core/connectors.js";
import { OwnerAuthStore, ownerAuthFile, readBearerKey, newBearerKey } from "./core/bearer-auth.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bearer-auth-selftest-"));
const dataHome = path.join(tmpRoot, "data");
mkdirSync(dataHome, { recursive: true });
const routeToken = randomBytes(16).toString("hex");
const BASE_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bearer-auth-selftest", version: "1" } };
const initBody = (id = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: INIT });
const listBody = (id = 2) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });

const send = (url, { method = "POST", sid, body, headers = {} } = {}) => fetch(url, {
  method,
  headers: { ...BASE_HEADERS, ...(sid ? { "mcp-session-id": sid } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const TUNNEL = { "cf-ray": "8f00000000000000-SIN" };

let server = null;
try {
  console.log("\n=== ① 口令生成与存储 ===");
  const ownerStore = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  const connectors = new ConnectorStore({ file: connectorsFile(dataHome) });
  server = new BridgeServer({ routeToken, dataHome, port: 0, connectors, ownerAuth: ownerStore });
  await server.start();
  const origin = new URL(server.localUrl).origin;
  const bearerUrl = `${origin}/mcp`;
  const pathUrl = server.localUrl;
  const healthUrl = `${origin}/healthz/${routeToken}`;

  const before = await send(bearerUrl, { body: initBody(), headers: bearer(newBearerKey()) });
  check("还没生成口令：/mcp 带任何口令都 404", before.status === 404, `HTTP ${before.status}`);

  const generated = ownerStore.generate(); server.ownerAuthChanged();
  const key1 = generated.key;
  check("口令格式 wrb_ + 43 位 base64url", /^wrb_[A-Za-z0-9_-]{43}$/.test(key1));
  const fileText = readFileSync(ownerAuthFile(dataHome), "utf8");
  check("磁盘上没有口令明文，只有哈希", !fileText.includes(key1) && !fileText.includes(key1.slice(4)) && /"hash": "[a-f0-9]{64}"/.test(fileText) && /"version": 2/.test(fileText));
  check("状态里不带哈希，只带末 4 位", !("bearerHash" in ownerStore.status()) && ownerStore.status().bearerHint === key1.slice(-4));

  console.log("\n=== ② 口令入口 ===");
  const init = await send(bearerUrl, { body: initBody(), headers: bearer(key1) });
  const sid1 = init.headers.get("mcp-session-id");
  const listed = await send(bearerUrl, { sid: sid1, body: listBody(), headers: bearer(key1) });
  check("对的口令：initialize 拿到会话号、tools/list 200", init.status === 200 && Boolean(sid1) && listed.status === 200, `init ${init.status} list ${listed.status}`);
  const lower = await send(bearerUrl, { body: initBody(), headers: { authorization: `bearer ${key1}` } });
  check("Bearer 大小写不敏感", lower.status === 200, `HTTP ${lower.status}`);

  const wrong = await send(bearerUrl, { body: initBody(), headers: bearer(newBearerKey()) });
  const none = await send(bearerUrl, { body: initBody() });
  const basic = await send(bearerUrl, { body: initBody(), headers: { authorization: `Basic ${Buffer.from(`x:${key1}`).toString("base64")}` } });
  const junk = await send(bearerUrl, { body: initBody(), headers: { authorization: `Bearer ${key1}x` } });
  const routeAsKey = await send(bearerUrl, { body: initBody(), headers: bearer(routeToken) });
  check("错口令 / 没带 / Basic / 多一位 / 拿路径令牌当口令：全部 404",
    [wrong, none, basic, junk, routeAsKey].every((r) => r.status === 404),
    [wrong, none, basic, junk, routeAsKey].map((r) => r.status).join(","));
  const keyInPath = await send(`${origin}/mcp/${key1}`, { body: initBody() });
  check("口令放进路径不认（只能放请求头）", keyInPath.status === 404, `HTTP ${keyInPath.status}`);
  check("readBearerKey 不认两段式 / 空值", readBearerKey({ authorization: `Bearer ${key1} extra` }) === null && readBearerKey({}) === null);

  console.log("\n=== ③ 会话不能串入口 ===");
  const crossToPath = await send(pathUrl, { sid: sid1, body: listBody(3) });
  check("口令会话拿到路径入口用：404", crossToPath.status === 404, `HTTP ${crossToPath.status}`);
  const pInit = await send(pathUrl, { body: initBody(4) });
  const pSid = pInit.headers.get("mcp-session-id");
  const crossToBearer = await send(bearerUrl, { sid: pSid, body: listBody(5), headers: bearer(key1) });
  check("路径会话拿到口令入口用：404", pInit.status === 200 && crossToBearer.status === 404, `init ${pInit.status} cross ${crossToBearer.status}`);

  console.log("\n=== ④ 换口令 ===");
  const key2 = ownerStore.generate().key; server.ownerAuthChanged();
  const oldKey = await send(bearerUrl, { body: initBody(6), headers: bearer(key1) });
  check("换口令后旧口令 404", oldKey.status === 404, `HTTP ${oldKey.status}`);
  check("换口令后旧的口令会话已断开", !server.sessions.get(sid1));
  check("路径会话不受换口令影响", Boolean(server.sessions.get(pSid)));
  const newKey = await send(bearerUrl, { body: initBody(7), headers: bearer(key2) });
  check("新口令能用", newKey.status === 200, `HTTP ${newKey.status}`);

  console.log("\n=== ⑤ 路径令牌对公网关掉 ===");
  const tunnelInit = await send(pathUrl, { body: initBody(8), headers: TUNNEL });
  const tunnelSid = tunnelInit.headers.get("mcp-session-id");
  ownerStore.setPathEnabled(false); server.ownerAuthChanged();
  const viaTunnel = await send(pathUrl, { body: initBody(9), headers: TUNNEL });
  const viaNgrok = await send(pathUrl, { body: initBody(10), headers: { "x-forwarded-for": "203.0.113.9" } });
  const local = await send(pathUrl, { body: initBody(11) });
  const health = await fetch(healthUrl, { headers: TUNNEL });
  const bearerTunnel = await send(bearerUrl, { body: initBody(12), headers: { ...bearer(key2), ...TUNNEL } });
  check("经 Cloudflare / ngrok 的路径请求 404", viaTunnel.status === 404 && viaNgrok.status === 404, `${viaTunnel.status},${viaNgrok.status}`);
  check("本机直连路径照常", local.status === 200, `HTTP ${local.status}`);
  check("健康检查照常（公网实测在用）", health.status === 200, `HTTP ${health.status}`);
  check("经隧道的口令请求照常", bearerTunnel.status === 200, `HTTP ${bearerTunnel.status}`);
  check("关路径时，经隧道开的旧路径会话已断开、本机路径会话还在", tunnelInit.status === 200 && !server.sessions.get(tunnelSid) && Boolean(server.sessions.get(pSid)));

  console.log("\n=== ⑥ 撤口令 / 防锁死 ===");
  const revoked = ownerStore.revoke(); server.ownerAuthChanged();
  const afterRevoke = await send(bearerUrl, { body: initBody(13), headers: bearer(key2) });
  const tunnelAgain = await send(pathUrl, { body: initBody(14), headers: TUNNEL });
  check("撤口令后口令 404、路径入口自动恢复", afterRevoke.status === 404 && revoked.pathEnabled === true && tunnelAgain.status === 200, `${afterRevoke.status},${tunnelAgain.status}`);
  let threw = false;
  try { ownerStore.setPathEnabled(false); } catch { threw = true; }
  check("没口令时不许关路径令牌", threw && ownerStore.pathEnabled());

  console.log("\n=== ⑦ 连接器口令模式 ===");
  const conn = connectors.create("测试连接器");
  const connPathUrl = `${origin}/mcp/${conn.token}`;
  const cBefore = await send(connPathUrl, { body: initBody(15) });
  const cSidPath = cBefore.headers.get("mcp-session-id");
  const { key: cKey, connector: cAfter } = connectors.setBearer(conn.id);
  const cOldPath = await send(connPathUrl, { body: initBody(16) });
  const cBearer = await send(bearerUrl, { body: initBody(17), headers: bearer(cKey) });
  check("切口令模式前路径令牌能用", cBefore.status === 200, `HTTP ${cBefore.status}`);
  check("切口令模式后旧路径令牌 404、旧会话断开", cOldPath.status === 404 && !server.sessions.get(cSidPath), `HTTP ${cOldPath.status}`);
  check("连接器口令能用，且身份是这个连接器", cBearer.status === 200 && server.sessions.get(cBearer.headers.get("mcp-session-id"))?.connectorId === conn.id, `HTTP ${cBearer.status}`);
  check("对外列表不带口令哈希、带 authMode", !("bearerHash" in cAfter) && cAfter.authMode === "bearer" && cAfter.bearerEnabled === true);
  const diskConn = readFileSync(connectorsFile(dataHome), "utf8");
  check("连接器文件里没有口令明文", !diskConn.includes(cKey));
  const ownerKeyNow = ownerStore.generate().key; server.ownerAuthChanged();
  const ownerKeySession = await send(bearerUrl, { body: initBody(18), headers: bearer(ownerKeyNow) });
  check("主口令和连接器口令互不串身份", server.sessions.get(ownerKeySession.headers.get("mcp-session-id"))?.connectorId == null);

  const back = connectors.setPathMode(conn.id);
  const cOldBearer = await send(bearerUrl, { body: initBody(19), headers: bearer(cKey) });
  const cOldToken = await send(connPathUrl, { body: initBody(20) });
  const cNewToken = await send(`${origin}/mcp/${back.token}`, { body: initBody(21) });
  check("切回路径模式：口令 404、最早的旧令牌不复活、新令牌能用",
    cOldBearer.status === 404 && cOldToken.status === 404 && cNewToken.status === 200 && back.token !== conn.token,
    `${cOldBearer.status},${cOldToken.status},${cNewToken.status}`);

  console.log("\n=== ⑧ 落盘与坏文件 ===");
  ownerStore.setPathEnabled(false);
  const reloaded = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  check("重启后口令和路径开关都还在", reloaded.matches(ownerKeyNow) && reloaded.pathEnabled() === false);
  const brokenDir = path.join(tmpRoot, "broken");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(ownerAuthFile(brokenDir), "{ not json", "utf8");
  const broken = new OwnerAuthStore({ file: ownerAuthFile(brokenDir) });
  check("坏文件：按「没口令、路径开」运行，并另存备份",
    broken.status().bearerEnabled === false && broken.pathEnabled() && readdirSync(brokenDir).some((f) => f.includes(".broken-")));
  const sneaky = path.join(tmpRoot, "sneaky");
  mkdirSync(sneaky, { recursive: true });
  writeFileSync(ownerAuthFile(sneaky), JSON.stringify({ version: 1, bearerHash: null, pathEnabled: false }), "utf8");
  check("文件里手写「关路径」但没口令：不认，路径照开", new OwnerAuthStore({ file: ownerAuthFile(sneaky) }).pathEnabled());

  console.log("\n=== ⑨ 多把主口令 ===");
  const legacyDir = path.join(tmpRoot, "legacy");
  mkdirSync(legacyDir, { recursive: true });
  const legacyKey = newBearerKey();
  const { hashBearerKey } = await import("./core/bearer-auth.js");
  writeFileSync(ownerAuthFile(legacyDir), JSON.stringify({ version: 1, bearerHash: hashBearerKey(legacyKey), bearerHint: legacyKey.slice(-4), bearerCreatedAt: "2026-10-25T04:03:00.000Z", pathEnabled: true }), "utf8");
  const legacy = new OwnerAuthStore({ file: ownerAuthFile(legacyDir) });
  const ls = legacy.status();
  check("v1 文件迁成一把叫「酥酥」的口令，老口令照样能用", ls.keys.length === 1 && ls.keys[0].label === "酥酥" && Boolean(legacy.matches(legacyKey)));

  server.ownerAuth.revoke(); server.ownerAuthChanged();
  const a = ownerStore.addKey("酥酥");
  const b = ownerStore.addKey("Claude");
  server.ownerAuthChanged();
  check("两把口令各自有 id、名字、末 4 位，状态里不带哈希",
    a.id !== b.id && ownerStore.status().keys.map((k) => k.label).join(",") === "酥酥,Claude" && !JSON.stringify(ownerStore.status()).includes(hashBearerKey(a.key)));
  const sa = await send(bearerUrl, { body: initBody(30), headers: bearer(a.key) });
  const sb = await send(bearerUrl, { body: initBody(31), headers: bearer(b.key) });
  const sidA = sa.headers.get("mcp-session-id"), sidB = sb.headers.get("mcp-session-id");
  check("两把都能连，会话各自记着自己那把", sa.status === 200 && sb.status === 200 && server.sessions.get(sidA)?.keyId === a.id && server.sessions.get(sidB)?.keyId === b.id);
  const crossKey = await send(bearerUrl, { sid: sidA, body: listBody(32), headers: bearer(b.key) });
  check("拿 Claude 的口令用酥酥的会话号：404", crossKey.status === 404, `HTTP ${crossKey.status}`);

  const c = ownerStore.addKey("临时"); server.ownerAuthChanged();
  check("新增一把不断别人的会话", Boolean(server.sessions.get(sidA)) && Boolean(server.sessions.get(sidB)));

  const b2 = ownerStore.rotateKey(b.id); server.ownerAuthChanged();
  const oldB = await send(bearerUrl, { body: initBody(33), headers: bearer(b.key) });
  const newB = await send(bearerUrl, { body: initBody(34), headers: bearer(b2.key) });
  check("换 Claude 那把：旧的 404、新的能用、名字不变", oldB.status === 404 && newB.status === 200 && ownerStore.status().keys.some((k) => k.id === b2.id && k.label === "Claude"), `${oldB.status},${newB.status}`);
  check("换 Claude 那把只断 Claude 的旧会话，酥酥的还在", !server.sessions.get(sidB) && Boolean(server.sessions.get(sidA)));

  ownerStore.revokeKey(c.id); server.ownerAuthChanged();
  const gone = await send(bearerUrl, { body: initBody(35), headers: bearer(c.key) });
  check("撤掉「临时」：它 404，酥酥还能用", gone.status === 404 && Boolean(ownerStore.matches(a.key)) && Boolean(server.sessions.get(sidA)), `HTTP ${gone.status}`);

  ownerStore.setPathEnabled(false);
  ownerStore.revokeKey(a.id); ownerStore.revokeKey(b2.id); server.ownerAuthChanged();
  check("一把不剩时路径入口自动恢复", ownerStore.pathEnabled() && ownerStore.status().keys.length === 0);

  let tooMany = false;
  try { for (let i = 0; i < 9; i += 1) ownerStore.addKey(`k${i}`); } catch { tooMany = true; }
  check("最多 8 把", tooMany && ownerStore.status().keys.length === 8);
  check("名字去掉控制字符、截到 32 字", ownerStore.revoke() && ownerStore.addKey("a\u0000b\n" + "x".repeat(50)).keys[0].label === "ab" + "x".repeat(30));
} catch (error) {
  check("自测没有异常", false, error.stack);
} finally {
  await server?.stop().catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
