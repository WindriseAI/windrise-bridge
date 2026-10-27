#!/usr/bin/env node
/**
 * 激活 / 付费门槛 / 本机 MCP 防绕过 —— 纯 Node 自检。
 *
 *   node src/activation-selftest.mjs
 *
 * 不联网（用假 fetch 模拟激活服务器，不真的去调 api.secrethq.shop）、不启动 Electron、
 * 不碰 data/、不碰真实数据目录（全部写在系统临时目录）。
 *
 * 覆盖：
 *   ① 开发开关 devLicenseBypass：只在非打包运行时认 WINDRISE_DEV_NO_LICENSE=1；
 *   ② 激活码格式与校验位；客户端 status / ensure / activate / renew（假服务器）；
 *   ③ 三种隧道共用的门槛：没激活 ensure 抛 NOT_ACTIVATED、tunnelSeal 拦「还没有激活」、
 *      已激活放行；篡改许可证后全部拦（三种隧道是同一道门，不按 provider 区分）；
 *   ④ 本机 MCP 防绕过：各种转发头 / Host 组合，隧道请求在激活与否、隧道通断下的放行与拒绝；
 *   ⑤ 面板状态：license 只带「已激活 / 到期」，激活码 / 设备密钥 / 许可证字段一律进不了输出。
 *
 * 许可证用本机现生成的测试密钥对签名（公钥经自检注入口传给 ActivationClient / tunnelSeal /
 * bridge 的 gateCheck），生产路径用的内置正式公钥一字未动。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { ActivationClient, ActivationError, parseActivationCode, devLicenseBypass } from "./core/activation.js";
import { generateLicenseKeyPair, issueLicenseToken } from "./core/license.js";
import { BridgeServer, gateCheck, LOCAL_ONLY_MESSAGE, GATE_STARTING_MESSAGE } from "./core/bridge.js";
import { tunnelSeal } from "./core/tunnel.js";
import { isRemoteRequest, isLocalHostHeader } from "./core/bearer-auth.js";

const require = createRequire(import.meta.url);
const { buildPanelState } = require("../electron/panel-state.cjs");

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "wr-activation-selftest-"));
const cleanup = () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on("exit", cleanup);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

/* ================================================================== *
 * ① 开发开关
 * ================================================================== */
console.log("\n=== ① 开发开关 WINDRISE_DEV_NO_LICENSE ===");
{
  check("开关：非打包 + 环境变量=1 → 跳过门槛", devLicenseBypass({ env: { WINDRISE_DEV_NO_LICENSE: "1" }, isPackaged: false }) === true);
  check("开关：非打包但没有环境变量 → 不跳过", devLicenseBypass({ env: {}, isPackaged: false }) === false);
  check("开关：非打包 + 别的值 → 不跳过", devLicenseBypass({ env: { WINDRISE_DEV_NO_LICENSE: "0" }, isPackaged: false }) === false);
  check("开关：打包版本即使设了环境变量也不跳过", devLicenseBypass({ env: { WINDRISE_DEV_NO_LICENSE: "1" }, isPackaged: true }) === false);
}

/* ================================================================== *
 * ② 激活码格式
 * ================================================================== */
console.log("\n=== ② 激活码格式 ===");
{
  const CODE = "WRM-7K3Q-9XHD-2PRT-Z8NK";
  const valid = parseActivationCode(CODE.replace(/-/g, ""));
  check("格式：合法码通过，带类型和规范写法", Boolean(valid) && valid.kind === "M" && valid.pretty === CODE, valid?.pretty);
  check("格式：错校验位 / 乱写 / 空值都不认", parseActivationCode("WRM-AAAA-BBBB-CCCC-DDDD") === null && parseActivationCode("abc") === null && parseActivationCode("") === null && parseActivationCode(null) === null);
}

/* ================================================================== *
 * ③ 客户端 + 假服务器：激活 / 续期 / 篡改 / 换设备 / 回拨时间
 * ================================================================== */
console.log("\n=== ③ 客户端激活链路（假服务器，不联网） ===");
const pair = generateLicenseKeyPair();
const home = path.join(tmpRoot, "client");
mkdirSync(home, { recursive: true });

/** 假激活服务器：用测试私钥签「绑定请求里 deviceId」的许可证；renew 认 secret；另含支付宝下单假接口。 */
function fakeServer({ overrides = {} } = {}) {
  const state = { blocked: false, payOrders: new Map(), orderStatus: {}, ...overrides };
  const planDays = { D: 1, M: 30, Y: 365 };
  const planPrices = { D: 100, M: 2900, Y: 19900 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === "GET" && u.pathname === "/api/pay/plans") {
      return json({ plans: state.plans ?? [
        { kind: "D", name: "天卡", days: 1, price: 0, available: false },
        { kind: "M", name: "月卡", days: 30, price: 0, available: false },
        { kind: "Y", name: "年卡", days: 365, price: 0, available: false },
      ] });
    }
    if (method === "POST" && u.pathname === "/api/pay/orders") {
      if (state.payError) return json({ message: state.payError.message, error: state.payError.code }, state.payError.status ?? 400);
      if (!planDays[body.kind]) return json({ message: "套餐类型不对", error: "BAD_KIND" }, 400);
      const orderId = `BRTEST${state.payOrders.size + 1}${Date.now()}`;
      state.payOrders.set(orderId, { kind: body.kind, deviceId: body.deviceId });
      return json({
        orderId, qrCode: "data:image/png;base64,FAKEQR", amount: planPrices[body.kind],
        expiresAt: Date.now() + 30 * 60_000, kind: body.kind, name: body.kind, days: planDays[body.kind],
      });
    }
    if (method === "GET" && u.pathname.startsWith("/api/pay/orders/")) {
      const orderId = decodeURIComponent(u.pathname.slice("/api/pay/orders/".length));
      const order = state.payOrders.get(orderId);
      if (!order) return json({ message: "订单不存在", error: "ORDER_NOT_FOUND" }, 404);
      const status = state.orderStatus[orderId] ?? "pending";
      if (status === "paid") {
        const now = Date.now();
        const expires = now + planDays[order.kind] * 864e5;
        const license = issueLicenseToken({
          privateKeyPem: pair.privateKeyPem, issuer: "https://api.secrethq.shop", audience: "bridge-replica-desktop",
          subject: `device:${order.deviceId}`, installationId: order.deviceId, features: ["bridge"],
          ttlSeconds: 7 * 86400, entitlementExpiresAt: expires,
        });
        return json({
          orderId, status, kind: order.kind, amount: planPrices[order.kind], expiresAt: expires,
          activation: { license, expiresAt: expires, serverTime: now, secret: "paid-secret", addedDays: planDays[order.kind], kind: order.kind, again: false },
        });
      }
      return json({ orderId, status, kind: order.kind, amount: planPrices[order.kind], expiresAt: Date.now() + 30 * 60_000 });
    }
    if (u.pathname === "/api/activate") {
      if (state.activateError) {
        const e = state.activateError;
        return new Response(JSON.stringify({ message: e.message, error: e.code, expiresAt: e.expiresAt ?? undefined }), { status: e.status, headers: { "content-type": "application/json" } });
      }
      const now = Date.now();
      const expires = now + 30 * 864e5;
      const license = issueLicenseToken({
        privateKeyPem: pair.privateKeyPem, issuer: "https://api.secrethq.shop", audience: "bridge-replica-desktop",
        subject: `device:${body.deviceId}`, installationId: body.deviceId, features: ["bridge"],
        ttlSeconds: 7 * 86400, entitlementExpiresAt: expires,
      });
      return new Response(JSON.stringify({ license, expiresAt: expires, serverTime: now, secret: "test-secret", addedDays: 30, kind: "M", again: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname === "/api/activate/renew") {
      if (state.blocked) return new Response(JSON.stringify({ message: "这台电脑已被停用，请联系卖家", error: "DEVICE_BLOCKED" }), { status: 403, headers: { "content-type": "application/json" } });
      if (body.secret !== "test-secret" && body.secret !== "paid-secret") return new Response(JSON.stringify({ message: "本机的激活信息对不上，请重新输入激活码", error: "DEVICE_AUTH" }), { status: 401, headers: { "content-type": "application/json" } });
      const now = Date.now();
      const expires = state.expiresAt ?? now + 30 * 864e5;
      const license = issueLicenseToken({
        privateKeyPem: pair.privateKeyPem, issuer: "https://api.secrethq.shop", audience: "bridge-replica-desktop",
        subject: `device:${body.deviceId}`, installationId: body.deviceId, features: ["bridge"],
        ttlSeconds: 7 * 86400, entitlementExpiresAt: expires,
      });
      return new Response(JSON.stringify({ license, expiresAt: expires, serverTime: now }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
}

const serverState = {};
const client = new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer({ overrides: serverState }), publicKeyPem: pair.publicKeyPem });

{
  const st = await client.status();
  check("没激活：status 报 NOT_ACTIVATED，不带店铺地址（购买入口改在软件内，店铺入口已去掉）", st.activated === false && st.code === "NOT_ACTIVATED" && !("shopUrl" in st), JSON.stringify({ activated: st.activated, code: st.code }));
  let threw = null;
  try { await client.ensure(); } catch (e) { threw = e; }
  check("没激活：ensure 抛 NOT_ACTIVATED（三种隧道共用这一道，不分 provider）", threw instanceof ActivationError && threw.code === "NOT_ACTIVATED" && /激活/.test(threw.message), threw?.message);
  check("没激活：tunnelSeal 拦「还没有激活」", (await tunnelSeal(home, { keyPem: pair.publicKeyPem })) === "还没有激活");

  const code = parseActivationCode("WRM-7K3Q-9XHD-2PRT-Z8NK".replace(/-/g, ""))?.code ?? "";
  const r = await client.activate(code);
  check("输入月卡：激活成功 +30 天", r.addedDays === 30 && r.kindName === "月卡" && r.status.activated === true && r.status.daysLeft === 30, JSON.stringify({ addedDays: r.addedDays, daysLeft: r.status.daysLeft }));
  await client.ensure();
  check("已激活：ensure 放行", true);
  check("已激活：tunnelSeal 放行", (await tunnelSeal(home, { keyPem: pair.publicKeyPem })) === null);

  const renewed = await client.renew({ force: true });
  check("在线续期照常", renewed.activated === true, renewed.code);
}

{
  const file = path.join(home, "activation.json");
  const original = readFileSync(file, "utf8");
  const data = JSON.parse(original);
  const [h, p, s] = data.token.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  claims.entitlement_exp += 365 * 86400; claims.exp += 365 * 86400;
  data.token = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
  writeFileSync(file, JSON.stringify(data));
  const st = await new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer(), publicKeyPem: pair.publicKeyPem }).status();
  check("改许可证里的到期时间：验签失败，客户端拦", st.activated === false && st.code === "LICENSE_INVALID", st.code);
  check("改许可证：tunnelSeal 也拦「激活信息无效」", (await tunnelSeal(home, { keyPem: pair.publicKeyPem })) === "激活信息无效");
  writeFileSync(file, original);
}

{
  const file = path.join(home, "activation.json");
  const original = readFileSync(file, "utf8");
  const device = await client.device();
  const other = issueLicenseToken({
    privateKeyPem: pair.privateKeyPem, issuer: "https://api.secrethq.shop", audience: "bridge-replica-desktop",
    subject: "device:other", installationId: "c".repeat(32), features: ["bridge"],
    ttlSeconds: 7 * 86400, entitlementExpiresAt: Date.now() + 30 * 864e5,
  });
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), token: other }));
  const st = await new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer(), publicKeyPem: pair.publicKeyPem }).status();
  check("许可证是别的设备的：DEVICE_MISMATCH", st.code === "DEVICE_MISMATCH" && st.activated === false, `device=${device.id.slice(0, 8)}… code=${st.code}`);
  check("换设备的许可证：tunnelSeal 拦「不是这台电脑」", (await tunnelSeal(home, { keyPem: pair.publicKeyPem })) === "激活信息不是这台电脑的");
  writeFileSync(file, original);
}

{
  const file = path.join(home, "activation.json");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), seen: Date.now() + 40 * 864e5 }));
  const st = await new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer(), publicKeyPem: pair.publicKeyPem }).status();
  check("见过的最晚时间在 40 天后（时间被往回调过）：按到期处理", st.activated === false && st.clockBack === true && st.code === "EXPIRED", `clockBack=${st.clockBack} code=${st.code}`);
  check("回拨时间：tunnelSeal 拦「激活已到期」", (await tunnelSeal(home, { keyPem: pair.publicKeyPem })) === "激活已到期");
  writeFileSync(file, original);
}

{
  serverState.blocked = true;
  const st = await new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer({ overrides: serverState }), publicKeyPem: pair.publicKeyPem }).renew({ force: true });
  check("服务器停用这台电脑：续期后本地也失效", st.activated === false && st.code === "DEVICE_BLOCKED", st.code);
  serverState.blocked = false;
  const back = await new ActivationClient({ apiBase: "https://fake.local", dataHome: home, fetchImpl: fakeServer({ overrides: serverState }), publicKeyPem: pair.publicKeyPem }).renew({ force: true });
  check("解除停用后续期恢复", back.activated === true, back.code);
}

/* ================================================================== *
 * ③b 软件内支付宝购买（假 fetch：价目 / 下单 / 轮询 / 过期 / paid 后激活）
 * ================================================================== */
console.log("\n=== ③b 软件内支付宝购买（假服务器，不联网） ===");
{
  const payHome = path.join(tmpRoot, "pay");
  mkdirSync(payHome, { recursive: true });
  const payState = {
    orderStatus: {},
    payOrders: new Map(),
    plans: [
      { kind: "D", name: "天卡", days: 1, price: 0, available: false },
      { kind: "M", name: "月卡", days: 30, price: 2900, available: true },
      { kind: "Y", name: "年卡", days: 365, price: 0, available: false },
    ],
  };
  const payFetch = (url, init) => fakeServer({ overrides: payState })(url, init);
  const payClient = new ActivationClient({ apiBase: "https://fake.local", dataHome: payHome, fetchImpl: payFetch, publicKeyPem: pair.publicKeyPem });

  const plans = await payClient.plans();
  check("价目：拿得到三档，价格 0 / 参数没配的档位标记为不可购买",
    plans.plans.length === 3 && plans.plans[1].price === 2900 && plans.plans[1].available === true
    && plans.plans[0].available === false && plans.plans[2].available === false,
    JSON.stringify(plans.plans.map((plan) => [plan.kind, plan.price, plan.available])));

  payState.payError = { status: 400, code: "PRICE_NOT_SET", message: "这个套餐还没定价，暂未开放购买" };
  await assert.rejects(payClient.createOrder("M"), (error) => error.code === "PRICE_NOT_SET");
  check("价格未设：createOrder 抛出 PRICE_NOT_SET", true);
  payState.payError = null;

  const order = await payClient.createOrder("M");
  check("下单：返回订单号和 data:image/png 二维码",
    /^BR/.test(order.orderId) && /^data:image\/png;base64,/.test(order.qrCode) && order.amount === 2900,
    JSON.stringify({ orderId: order.orderId, amount: order.amount }));

  const pending = await payClient.pollOrder(order.orderId);
  check("轮询：pending 时不变更本地激活状态", pending.status === "pending" && pending.activated === false && (await payClient.status()).activated === false);

  payState.orderStatus[order.orderId] = "expired";
  const expired = await payClient.pollOrder(order.orderId);
  check("轮询：expired 显示原因，本地仍未激活", expired.status === "expired" && expired.activated === false && (await payClient.status()).activated === false);

  const dayOrder = await payClient.createOrder("D");
  payState.orderStatus[dayOrder.orderId] = "paid";
  const paid = await payClient.pollOrder(dayOrder.orderId);
  check("轮询：paid 后走现有保存流程，激活状态变已激活",
    paid.activated === true && paid.status === "paid" && paid.addedDays === 1
    && paid.activationStatus?.activated === true && paid.activationStatus?.daysLeft === 1,
    JSON.stringify({ status: paid.status, daysLeft: paid.activationStatus?.daysLeft, addedDays: paid.addedDays }));
  check("paid 结果不回传许可证 / 设备密钥（只留在本地激活文件里）",
    !("license" in paid) && !("secret" in paid) && !("activation" in paid));
  const stored = JSON.parse(readFileSync(path.join(payHome, "activation.json"), "utf8"));
  check("paid 后许可证和设备密钥已落盘", Boolean(stored.token) && stored.secret === "paid-secret");
  const renewed = await payClient.renew({ force: true });
  check("paid 拿到的设备密钥可用于续期", renewed.activated === true, renewed.code);
}

/* ================================================================== *
 * ④ 本机 MCP 防绕过（各种头 / Host 组合）
 * ================================================================== */
console.log("\n=== ④ 本机 MCP 防绕过 ===");
{
  check("判定：7 个转发头任一存在都算「不像本机」", ["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "x-forwarded-for", "x-forwarded-host", "forwarded"].every((name) => isRemoteRequest({ [name]: "1.2.3.4" })));
  check("判定：不带转发头、Host 是本机名 → 本机", !isRemoteRequest({ host: "127.0.0.1:48272" }));
  check("判定：Host 兼容 localhost / [::1] / 带端口", isLocalHostHeader("localhost:123") && isLocalHostHeader("127.0.0.1") && isLocalHostHeader("[::1]:9999") && !isLocalHostHeader("evil.example.com"));
}

const gateHome = path.join(tmpRoot, "gate");
mkdirSync(gateHome, { recursive: true });
const gateClient = new ActivationClient({ apiBase: "https://fake.local", dataHome: gateHome, fetchImpl: fakeServer(), publicKeyPem: pair.publicKeyPem });
/** 桥 ④ 的独立验签：自检注入测试公钥（生产路径用内置正式公钥，一字未动） */
const gateCheckWithTestKey = (home) => gateCheck(home, { key: createPublicKey(pair.publicKeyPem) });

async function startBridge(remoteGate, ttl = 0) {
  const server = new BridgeServer({ routeToken: "t".repeat(32), dataHome: gateHome, port: 0, remoteGate, remoteGateTtlMs: ttl });
  await server.start();
  return server;
}
const BASE = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "activation-selftest", version: "1" } };
const initBody = () => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
const send = (url, headers = {}) => fetch(url, { method: "POST", headers: { ...BASE, ...headers }, body: JSON.stringify(initBody()) });
const readMessage = async (res) => (await res.json()).message ?? "";
/** Node 的 fetch（undici）会强制用 URL 里的 Host，测试非本机 Host 必须走裸 http.request。 */
function rawPost(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(initBody());
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: `/mcp/${"t".repeat(32)}`,
      headers: { ...BASE, host: hostHeader, "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let message = "";
        try { message = JSON.parse(text).message ?? ""; } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, message });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/* 4a. 没挂 remoteGate（standalone / 老自测）：行为与从前完全一样 */
{
  const server = await startBridge(null);
  const viaTunnel = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  check("4a 没挂 remoteGate：带 cf-ray 的请求照常（向后兼容）", viaTunnel.status === 200, `HTTP ${viaTunnel.status}`);
  await server.stop();
}

/* 4b. 挂了 remoteGate、没激活：本地请求照常，远程请求一律 403 */
{
  const up = { value: false };
  const server = await startBridge({ tunnelUp: () => up.value, check: (home) => gateCheckWithTestKey(home) });
  const local = await send(server.localUrl);
  check("4b 没激活：本机直连照常 200（本机 MCP 免费）", local.status === 200, `HTTP ${local.status}`);
  const remoteHeaders = [
    ["cf-ray", { "cf-ray": "8f00000000000000-SIN" }],
    ["cf-connecting-ip", { "cf-connecting-ip": "203.0.113.9" }],
    ["cf-visitor", { "cf-visitor": JSON.stringify({ scheme: "https" }) }],
    ["cf-ipcountry", { "cf-ipcountry": "US" }],
    ["x-forwarded-for", { "x-forwarded-for": "203.0.113.9" }],
    ["x-forwarded-host", { "x-forwarded-host": "demo.example.com" }],
    ["forwarded", { forwarded: "for=203.0.113.9;host=demo.example.com" }],
  ];
  for (const [name, headers] of remoteHeaders) {
    const res = await send(server.localUrl, headers);
    const message = await readMessage(res);
    check(`4b 没激活：${name} → 403，带激活指引、不带店铺地址`, res.status === 403 && /激活/.test(message) && !message.includes("16688"), `HTTP ${res.status}：${message.slice(0, 60)}`);
  }
  const badHost = await rawPost(new URL(server.localUrl).port, "evil.example.com");
  check("4b 没激活：Host 不是本机名 → 403", badHost.status === 403 && /激活/.test(badHost.message), `HTTP ${badHost.status}：${badHost.message.slice(0, 60)}`);
  const port = new URL(server.localUrl).port;
  for (const host of [`127.0.0.1:${port}`, "localhost", "localhost:3000", "[::1]", "[::1]:8888"]) {
    const res = await rawPost(port, host);
    check(`4b Host ${host}：算本机，照常处理`, res.status === 200, `HTTP ${res.status}`);
  }
  await server.stop();
}

/* 4c. 已激活 + 隧道通着：隧道请求照常放行；隧道没通：403 本机专用话术 */
{
  await gateClient.activate(parseActivationCode("WRM-7K3Q-9XHD-2PRT-Z8NK".replace(/-/g, ""))?.code ?? "");
  const up = { value: true };
  const server = await startBridge({ tunnelUp: () => up.value, check: (home) => gateCheckWithTestKey(home) });
  const viaTunnel = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  check("4c 已激活 + 隧道通：cf-ray 请求照常 200", viaTunnel.status === 200, `HTTP ${viaTunnel.status}`);
  const viaNgrok = await send(server.localUrl, { "x-forwarded-for": "203.0.113.9" });
  check("4c 已激活 + 隧道通：x-forwarded-for（ngrok）照常 200", viaNgrok.status === 200, `HTTP ${viaNgrok.status}`);
  const viaPublicHost = await rawPost(new URL(server.localUrl).port, "bridge-abc.trycloudflare.com");
  check("4c 已激活 + 隧道通：公网 Host 照常 200", viaPublicHost.status === 200, `HTTP ${viaPublicHost.status}`);
  const health = await fetch(server.healthUrl(), { headers: { "cf-ray": "8f00000000000000-SIN" } });
  check("4c 已激活 + 隧道通：公网实测的 /healthz 照常 200", health.status === 200, `HTTP ${health.status}`);
  up.value = false;
  const blocked = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  const blockedMsg = await readMessage(blocked);
  check("4c 激活有效但隧道没通（别人自己转发的）：403 本机专用话术", blocked.status === 403 && blockedMsg === LOCAL_ONLY_MESSAGE, `HTTP ${blocked.status}：${blockedMsg}`);
  const local = await send(server.localUrl);
  check("4c 隧道没通也不影响本机直连", local.status === 200, `HTTP ${local.status}`);
  await server.stop();
}

/* 4d. 已激活后把许可证改坏：隧道请求又被拦（激活这道门独立于隧道状态） */
{
  const file = path.join(gateHome, "activation.json");
  const original = readFileSync(file, "utf8");
  const data = JSON.parse(original);
  const [h, p, s] = data.token.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  claims.exp = 1;
  data.token = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
  writeFileSync(file, JSON.stringify(data));
  const server = await startBridge({ tunnelUp: () => true, check: (home) => gateCheckWithTestKey(home) });
  const res = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  const msg = await readMessage(res);
  check("4d 许可证被改成过期：隧道请求 403，带激活指引", res.status === 403 && /激活/.test(msg), `HTTP ${res.status}：${msg.slice(0, 60)}`);
  await server.stop();
  writeFileSync(file, original);
}

/* 4e. 启动时序：状态没就绪 → 503 + Retry-After；就绪后已激活 200、未激活 403 */
{
  const ready = { value: false };
  const up = { value: true };
  const server = await startBridge({ ready: () => ready.value, tunnelUp: () => up.value, check: (home) => gateCheckWithTestKey(home) });
  const during = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  const duringBody = await during.json().catch(() => null);
  const retryAfter = during.headers.get("retry-after");
  check(
    "4e 启动期（ready=false）：远程请求 503 + Retry-After: 5 + 明确话术，不是 403",
    during.status === 503 && retryAfter === "5" && duringBody?.error?.message === GATE_STARTING_MESSAGE && duringBody?.message === GATE_STARTING_MESSAGE,
    `HTTP ${during.status} retry-after=${retryAfter}：${duringBody?.message}`,
  );
  const localDuring = await send(server.localUrl);
  check("4e 启动期：本机直连照常 200（不受就绪状态影响）", localDuring.status === 200, `HTTP ${localDuring.status}`);

  // 状态就绪：不用调 resetRemoteGate，启动期的 503 本来就不进缓存
  ready.value = true;
  const afterReady = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  check("4e 就绪后已激活 + 隧道通：同一个桥立刻 200（503 没被缓存）", afterReady.status === 200, `HTTP ${afterReady.status}`);

  // 就绪但隧道没通：回到 403 本机专用话术
  up.value = false;
  const noTunnel = await send(server.localUrl, { "cf-ray": "8f00000000000000-SIN" });
  const noTunnelMsg = await readMessage(noTunnel);
  check("4e 就绪但隧道没通：403 本机专用话术（不再回 503）", noTunnel.status === 403 && noTunnelMsg === LOCAL_ONLY_MESSAGE, `HTTP ${noTunnel.status}：${noTunnelMsg}`);
  await server.stop();
}

/* 4f. 启动时序：就绪但没激活 → 403（不是 503） */
{
  const freshHome = path.join(tmpRoot, "gate-unactivated");
  mkdirSync(freshHome, { recursive: true });
  const server = new BridgeServer({
    routeToken: "t".repeat(32), dataHome: freshHome, port: 0,
    remoteGate: { ready: () => true, tunnelUp: () => true, check: (home) => gateCheckWithTestKey(home) },
    remoteGateTtlMs: 0,
  });
  await server.start();
  const res = await fetch(server.localUrl, { method: "POST", headers: { ...BASE, "cf-ray": "8f00000000000000-SIN" }, body: JSON.stringify(initBody()) });
  const msg = await readMessage(res);
  check("4f 就绪但没激活：403 + 激活指引（确认没就绪才 503，确认拦截才 403）", res.status === 403 && /激活/.test(msg), `HTTP ${res.status}：${msg.slice(0, 60)}`);
  await server.stop();
}

console.log("\n=== ⑤ 面板状态不含敏感字段 ===");
{
  const state = buildPanelState({
    license: {
      activated: true,
      expiresAt: 1_790_000_000_000,
      daysLeft: 27,
      reason: null,
      // 故意塞进来的敏感字段：白名单构造器不该把它们带出去
      code: "ACTIVATION-CODE-SECRET",
      token: "LICENSE-TOKEN-SECRET",
      secret: "DEVICE-SECRET",
      deviceId: "d".repeat(32),
      shopUrl: "https://shop.example.test/buy",
    },
  });
  const license = state.license;
  check("面板 license 只有 activated / expiresAt / daysLeft / reason", Object.keys(license).sort().join(",") === "activated,daysLeft,expiresAt,reason", Object.keys(license).join(","));
  const text = JSON.stringify(state);
  check("激活码 / 设备密钥 / 许可证 / 设备 ID 都没进面板", !text.includes("SECRET") && !text.includes("d".repeat(32)), text.includes("SECRET") ? "泄了" : "干净");
  check("到期日期给 ISO 形式", Number.isFinite(Date.parse(license.expiresAt)) && license.daysLeft === 27 && license.activated === true);
  const empty = buildPanelState({});
  check("没有 license 输入时输出空对象（幂等）", empty.license.activated === false && empty.license.expiresAt === null && empty.license.daysLeft === null && JSON.stringify(buildPanelState(empty).license) === JSON.stringify(empty.license));
}

/* ================================================================== *
 * 收尾
 * ================================================================== */
const failed = results.filter((item) => !item.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ""}`);
}
cleanup();
process.exit(failed.length ? 1 : 0);
