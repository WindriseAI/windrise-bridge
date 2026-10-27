/**
 * 隧道 OAuth（默认关闭）的单元 / HTTP 集成测试。
 *   node --test src/core/oauth.test.js
 *
 * 覆盖：
 *   ① PKCE：错 verifier 拒绝、plain 拒绝；
 *   ② audience：resource 不符拒绝、隧道换地址后旧令牌 401；
 *   ③ 过期：access token 过期拒绝，refresh 还能换新；
 *   ④ 吊销：/revoke 和本机按 client 吊销都立即拒绝；
 *   ⑤ DCR：按 IP 限速、客户端总数上限、redirect_uri / auth method 校验；
 *   ⑥ 401：WWW-Authenticate 指向 PRM，PRM / AS metadata 字段齐全；
 *   ⑦ 关闭时端点不存在，老路径令牌和请求头口令照常；
 *   ⑧ 作用域映射到 tool-policy：默认 read+navigate，越权 NOT_ALLOWED，审计有 client_id / 名字；
 *   ⑨ 令牌只存哈希（oauth.json 里没有明文）。
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeServer } from "./bridge.js";
import { ConnectorStore, connectorsFile } from "./connectors.js";
import { OwnerAuthStore, ownerAuthFile } from "./bearer-auth.js";
import { registerTool, unregisterTool } from "./registry.js";

const PUBLIC_BASE = "https://bridge.example";
const CALLBACK = "https://client.example/callback";
const ROUTE_TOKEN = "route-token-for-oauth-test";

const FIXTURES = [
  {
    name: "oauth_read_tool",
    capability: "read",
    handler: async () => ({ content: [{ type: "text", text: "read ok" }] }),
  },
  {
    name: "browser_navigate",
    capability: "execute",
    handler: async (input) => ({ content: [{ type: "text", text: `navigate ${input.url}` }] }),
  },
  {
    name: "page_act",
    capability: "execute",
    handler: async (input) => ({ content: [{ type: "text", text: `act ${input.id}` }] }),
  },
  {
    name: "run_command",
    capability: "execute",
    handler: async () => ({ content: [{ type: "text", text: "ran" }] }),
  },
];
for (const fixture of FIXTURES) registerTool({ title: fixture.name, description: "OAuth 测试用的假工具", ...fixture });
test.after(() => {
  for (const fixture of FIXTURES) unregisterTool(fixture.name);
});

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "oauth-test-"));
}

async function startServer({ dataHome = tempHome(), oauth = {}, connectors = null, ownerAuth = null } = {}) {
  const oauthConfig = oauth === null
    ? null
    : { enabled: true, publicBaseUrl: PUBLIC_BASE, ...oauth };
  const server = new BridgeServer({
    routeToken: ROUTE_TOKEN,
    dataHome,
    connectors,
    ownerAuth,
    oauth: oauthConfig,
    port: 0,
    jsonResponse: true,
  });
  await server.start();
  return { server, dataHome, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer({ server }, ...dirs) {
  await server.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function makeVerifier() {
  return randomBytes(32).toString("base64url");
}

function challengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function rpc(url, body, { sid = null, headers = {} } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { response, body: parsed, sid: response.headers.get("mcp-session-id") };
}

async function initialize(base, token) {
  return rpc(`${base}/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "1" } },
  }, { headers: { authorization: `Bearer ${token}` } });
}

async function registerClient(base, overrides = {}) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT 测试",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...overrides,
    }),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { response, body };
}

async function beginAuthorization(base, {
  clientId,
  redirectUri = CALLBACK,
  verifier,
  scope,
  resource = `${PUBLIC_BASE}/mcp`,
  challengeMethod = "S256",
} = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challengeFor(verifier),
    code_challenge_method: challengeMethod,
    state: "state-1",
  });
  if (resource !== null && resource !== undefined) params.set("resource", resource);
  if (scope !== undefined) params.set("scope", scope);
  const response = await fetch(`${base}/authorize?${params}`, { redirect: "manual" });
  return { response, params };
}

/** 打开配对页，拿到 requestId 和配对码（模拟用户在远程浏览器里看到的页面）。 */
async function openPairing(base, options) {
  const { response } = await beginAuthorization(base, options);
  assert.equal(response.status, 303, `authorize 期望 303，实际 ${response.status}：${await response.text()}`);
  const location = response.headers.get("location");
  assert.match(location ?? "", /^\/authorize\?request=/);
  const page = await fetch(`${base}${location}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  const pairingCode = /class="code">([A-Z0-9-]{9})</.exec(html)?.[1];
  assert.ok(pairingCode, "授权页没有显示配对码");
  assert.match(html, /请在电脑上的 Windrise Bridge 确认/);
  const pendingBody = await (await fetch(`${base}/oauth/local/pending`)).json();
  const pending = (pendingBody.pending ?? []).find((item) => item.pairingCode === pairingCode);
  assert.ok(pending, "本机待确认列表里找不到这个配对码");
  return { html, requestId: pending.requestId, pairingCode, pending };
}

async function approve(base, requestId, groups) {
  const payload = groups === undefined ? { requestId } : { requestId, groups };
  const response = await fetch(`${base}/oauth/local/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

async function approveAndGetCode(base, requestId) {
  const response = await fetch(`${base}/authorize?request=${encodeURIComponent(requestId)}`, { redirect: "manual" });
  assert.equal(response.status, 302, `批准后刷新授权页期望 302，实际 ${response.status}：${await response.text()}`);
  const location = response.headers.get("location");
  const url = new URL(location);
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    iss: url.searchParams.get("iss"),
    location,
  };
}

async function exchange(base, params) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { response, body };
}

async function issueTokens(base, options = {}) {
  const clientId = options.clientId ?? (await registerClient(base)).body.client_id;
  const verifier = options.verifier ?? makeVerifier();
  const flow = await openPairing(base, { ...options, clientId, verifier });
  const approval = await approve(base, flow.requestId, options.groups);
  assert.equal(approval.response.status, 200, JSON.stringify(approval.body));
  const grant = await approveAndGetCode(base, flow.requestId);
  const tokenResult = await exchange(base, {
    grant_type: "authorization_code",
    code: grant.code,
    client_id: clientId,
    redirect_uri: options.redirectUri ?? CALLBACK,
    code_verifier: verifier,
    ...(options.tokenResource ? { resource: options.tokenResource } : {}),
  });
  return { clientId, verifier, flow, grant, tokenResult, tokens: tokenResult.body };
}

function waitForLog(dataHome, predicate, timeoutMs = 3000) {
  const dir = path.join(dataHome, "logs");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const lines = [];
      for (const name of readdirSync(dir).filter((file) => /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))) {
        for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try { lines.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
        }
      }
      const found = lines.find(predicate);
      if (found) return resolve(found);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

function readLogs(dataHome) {
  const dir = path.join(dataHome, "logs");
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => readFileSync(path.join(dir, file), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * ① PKCE
 * ------------------------------------------------------------------ */
test("PKCE：错 verifier 拒绝，plain 方法拒绝，正确 verifier 才发令牌", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home });
  try {
    const registered = await registerClient(ctx.base);
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
    const clientId = registered.body.client_id;
    const verifier = makeVerifier();
    const flow = await openPairing(ctx.base, { clientId, verifier });
    await approve(ctx.base, flow.requestId);
    const grant = await approveAndGetCode(ctx.base, flow.requestId);
    assert.ok(grant.code, "授权码为空");
    assert.equal(grant.state, "state-1");
    assert.equal(grant.iss, PUBLIC_BASE);

    const wrong = await exchange(ctx.base, {
      grant_type: "authorization_code",
      code: grant.code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: makeVerifier(),
    });
    assert.equal(wrong.response.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    assert.match(wrong.body.error_description, /PKCE/);

    const good = await exchange(ctx.base, {
      grant_type: "authorization_code",
      code: grant.code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.equal(good.response.status, 200, JSON.stringify(good.body));
    assert.match(good.body.access_token, /^wro_/);
    assert.match(good.body.refresh_token, /^wrr_/);
    assert.equal(good.body.token_type, "Bearer");
    assert.equal(good.body.scope, "read navigate");

    const plain = await beginAuthorization(ctx.base, { clientId, verifier: makeVerifier(), challengeMethod: "plain" });
    assert.equal(plain.response.status, 400);
    const missing = await beginAuthorization(ctx.base, { clientId, verifier: makeVerifier(), challengeMethod: "" });
    assert.equal(missing.response.status, 400);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ② audience
 * ------------------------------------------------------------------ */
test("audience：resource 不符拒绝，隧道换地址后旧令牌 401", async () => {
  const home = tempHome();
  let publicBase = "https://a.example";
  const ctx = await startServer({ dataHome: home, oauth: { publicBaseUrl: () => publicBase } });
  try {
    const registered = await registerClient(ctx.base);
    const clientId = registered.body.client_id;

    const badAuthorize = await beginAuthorization(ctx.base, { clientId, verifier: makeVerifier(), resource: "https://evil.example/mcp" });
    assert.equal(badAuthorize.response.status, 400);

    const issued = await issueTokens(ctx.base, { clientId, resource: `${publicBase}/mcp` });
    assert.equal(issued.tokenResult.response.status, 200, JSON.stringify(issued.tokens));
    const accessToken = issued.tokens.access_token;

    const ok = await initialize(ctx.base, accessToken);
    assert.equal(ok.response.status, 200);

    // 换码时 resource 与授权时不一致
    const issued2 = await issueTokens(ctx.base, {
      clientId,
      resource: `${publicBase}/mcp`,
      tokenResource: "https://evil.example/mcp",
    });
    assert.equal(issued2.tokenResult.response.status, 400);
    assert.equal(issued2.tokens.error, "invalid_target");

    publicBase = "https://b.example";
    const rejected = await initialize(ctx.base, accessToken);
    assert.equal(rejected.response.status, 401);
    const header = rejected.response.headers.get("www-authenticate") ?? "";
    assert.match(header, /error="invalid_token"/);
    assert.match(header, /resource_metadata="https:\/\/b\.example\/\.well-known\/oauth-protected-resource"/);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ③ 过期 + refresh
 * ------------------------------------------------------------------ */
test("过期：access token 过期 401，refresh 换新后可用，旧 refresh 轮换失效", async () => {
  const home = tempHome();
  let now = Date.now();
  const ctx = await startServer({
    dataHome: home,
    oauth: {
      publicBaseUrl: PUBLIC_BASE,
      now: () => now,
      accessTokenTtlSeconds: 60,
      refreshTokenTtlSeconds: 3600,
    },
  });
  try {
    const issued = await issueTokens(ctx.base);
    assert.equal(issued.tokenResult.response.status, 200, JSON.stringify(issued.tokens));
    const { access_token: accessToken, refresh_token: refreshToken } = issued.tokens;

    now += 61_000;
    const expired = await initialize(ctx.base, accessToken);
    assert.equal(expired.response.status, 401);
    assert.match(expired.response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

    const refreshed = await exchange(ctx.base, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: issued.clientId,
    });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.access_token, accessToken);
    assert.notEqual(refreshed.body.refresh_token, refreshToken);
    assert.equal(refreshed.body.scope, "read navigate");

    const ok = await initialize(ctx.base, refreshed.body.access_token);
    assert.equal(ok.response.status, 200);

    const reused = await exchange(ctx.base, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: issued.clientId,
    });
    assert.equal(reused.response.status, 400);
    assert.equal(reused.body.error, "invalid_grant");

    now += 3_601_000;
    const expiredRefresh = await exchange(ctx.base, {
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: issued.clientId,
    });
    assert.equal(expiredRefresh.response.status, 400);
    assert.equal(expiredRefresh.body.error, "invalid_grant");
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ④ 吊销
 * ------------------------------------------------------------------ */
test("吊销：/revoke 后立即 401，本机按 client_id 吊销也立即 401", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home });
  try {
    const issued = await issueTokens(ctx.base);
    const accessToken = issued.tokens.access_token;

    const before = await initialize(ctx.base, accessToken);
    assert.equal(before.response.status, 200);

    const revokeResponse = await fetch(`${ctx.base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    });
    assert.equal(revokeResponse.status, 200);

    const after = await initialize(ctx.base, accessToken);
    assert.equal(after.response.status, 401);
    assert.match(after.response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

    // 同一个客户端再授权一把，然后按 client_id 从本机吊销
    const second = await issueTokens(ctx.base, { clientId: issued.clientId });
    assert.equal(second.tokenResult.response.status, 200);
    const localRevoke = await fetch(`${ctx.base}/oauth/local/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: issued.clientId }),
    });
    assert.equal(localRevoke.status, 200);
    const afterLocal = await initialize(ctx.base, second.tokens.access_token);
    assert.equal(afterLocal.response.status, 401);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ⑤ DCR 限速 / 校验
 * ------------------------------------------------------------------ */
test("DCR：按 IP 限速、客户端数量上限、redirect_uri 与 auth method 校验", async () => {
  const home = tempHome();
  const ctx = await startServer({
    dataHome: home,
    oauth: { registrationLimit: 2, registrationWindowSeconds: 3600, maxClients: 50 },
  });
  try {
    assert.equal((await registerClient(ctx.base)).response.status, 201);
    assert.equal((await registerClient(ctx.base)).response.status, 201);
    const limited = await registerClient(ctx.base);
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
    assert.equal(limited.body.error, "temporarily_unavailable");
  } finally {
    await stopServer(ctx, home);
  }

  const capHome = tempHome();
  const cap = await startServer({
    dataHome: capHome,
    oauth: { registrationLimit: 100, maxClients: 1 },
  });
  try {
    assert.equal((await registerClient(cap.base)).response.status, 201);
    const capped = await registerClient(cap.base);
    assert.equal(capped.response.status, 429);
    assert.equal(capped.body.error, "temporarily_unavailable");
  } finally {
    await stopServer(cap, capHome);
  }

  const validationHome = tempHome();
  const validation = await startServer({ dataHome: validationHome });
  try {
    const badRedirect = await registerClient(validation.base, { redirect_uris: ["http://evil.example/cb"] });
    assert.equal(badRedirect.response.status, 400);
    assert.equal(badRedirect.body.error, "invalid_redirect_uri");

    const badMethod = await registerClient(validation.base, { token_endpoint_auth_method: "client_secret_basic" });
    assert.equal(badMethod.response.status, 400);
    assert.equal(badMethod.body.error, "invalid_client_metadata");

    const badGrant = await registerClient(validation.base, { grant_types: ["implicit"] });
    assert.equal(badGrant.response.status, 400);
    assert.equal(badGrant.body.error, "invalid_client_metadata");

    const ok = await registerClient(validation.base);
    assert.equal(ok.response.status, 201);
    assert.match(ok.body.client_id, /^wrc_/);
  } finally {
    await stopServer(validation, validationHome);
  }
});

/* ------------------------------------------------------------------ *
 * ⑥ 401 / 元数据
 * ------------------------------------------------------------------ */
test("401 带 WWW-Authenticate 指向 PRM；PRM 与 AS metadata 字段齐全", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home });
  try {
    const unauthorized = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(
      unauthorized.headers.get("www-authenticate"),
      `Bearer resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource"`,
    );

    const prm = await (await fetch(`${ctx.base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, `${PUBLIC_BASE}/mcp`);
    assert.deepEqual(prm.authorization_servers, [PUBLIC_BASE]);
    assert.deepEqual(prm.scopes_supported, ["read", "navigate", "write", "admin"]);
    assert.deepEqual(prm.bearer_methods_supported, ["header"]);

    const prmPath = await (await fetch(`${ctx.base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prmPath.resource, `${PUBLIC_BASE}/mcp`);

    const metadata = await (await fetch(`${ctx.base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, PUBLIC_BASE);
    assert.equal(metadata.authorization_endpoint, `${PUBLIC_BASE}/authorize`);
    assert.equal(metadata.token_endpoint, `${PUBLIC_BASE}/token`);
    assert.equal(metadata.registration_endpoint, `${PUBLIC_BASE}/register`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(metadata.client_id_metadata_document_supported, false);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);

    const invalidOauth = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer wro_${"A".repeat(43)}` },
      body: "{}",
    });
    assert.equal(invalidOauth.status, 401);
    const header = invalidOauth.headers.get("www-authenticate") ?? "";
    assert.match(header, /resource_metadata="https:\/\/bridge\.example\/\.well-known\/oauth-protected-resource"/);
    assert.match(header, /error="invalid_token"/);

    // 老口令格式错了仍然是 404，不能因为开了 OAuth 就变成 401
    const badLegacy = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer wrb_${"A".repeat(43)}` },
      body: "{}",
    });
    assert.equal(badLegacy.status, 404);
    const randomBearer = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-token" },
      body: "{}",
    });
    assert.equal(randomBearer.status, 404);

    // 本机调试入口不能被隧道转发头访问
    const remoteLocal = await fetch(`${ctx.base}/oauth/local/pending`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(remoteLocal.status, 404);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ⑦ 关闭时端点不存在 + 老入口不受影响
 * ------------------------------------------------------------------ */
test("OAuth 关闭时端点全部 404，老路径令牌照常工作", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home, oauth: null });
  try {
    for (const [method, pathname] of [
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["POST", "/register"],
      ["GET", "/authorize"],
      ["POST", "/token"],
      ["POST", "/revoke"],
      ["GET", "/oauth/local/pending"],
    ]) {
      const response = await fetch(`${ctx.base}${pathname}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(response.status, 404, `${method} ${pathname} 期望 404，实际 ${response.status}`);
    }
    const noAuth = await rpc(`${ctx.base}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(noAuth.response.status, 404);

    const oldPath = await rpc(`${ctx.base}/mcp/${ROUTE_TOKEN}`, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } },
    });
    assert.equal(oldPath.response.status, 200);
  } finally {
    await stopServer(ctx, home);
  }
});

test("OAuth 打开时老路径令牌、主口令、连接器令牌都照常", async () => {
  const home = tempHome();
  const ownerAuth = new OwnerAuthStore({ file: ownerAuthFile(home) });
  const ownerKey = ownerAuth.addKey("老主口令").key;
  const connectors = new ConnectorStore({ file: connectorsFile(home) });
  const connector = connectors.create("老连接器");
  const ctx = await startServer({ dataHome: home, ownerAuth, connectors });
  try {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } };
    assert.equal((await rpc(`${ctx.base}/mcp/${ROUTE_TOKEN}`, init)).response.status, 200);
    assert.equal((await rpc(`${ctx.base}/mcp`, init, { headers: { authorization: `Bearer ${ownerKey}` } })).response.status, 200);
    assert.equal((await rpc(`${ctx.base}/mcp/${connector.token}`, init)).response.status, 200);
    assert.equal((await rpc(`${ctx.base}/mcp`, init)).response.status, 401);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ⑧ 作用域映射 + 审计
 * ------------------------------------------------------------------ */
test("作用域映射到 tool-policy：默认 read+navigate，越权 NOT_ALLOWED，审计有 client_id / 名字", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home });
  try {
    const issued = await issueTokens(ctx.base);
    assert.equal(issued.tokenResult.response.status, 200, JSON.stringify(issued.tokens));
    assert.equal(issued.tokens.scope, "read navigate");
    const accessToken = issued.tokens.access_token;
    const auth = { authorization: `Bearer ${accessToken}` };

    const init = await initialize(ctx.base, accessToken);
    assert.equal(init.response.status, 200);
    const sid = init.sid;
    const listed = await rpc(`${ctx.base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sid, headers: auth });
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes("oauth_read_tool"), names.join(", "));
    assert.ok(names.includes("browser_navigate"), names.join(", "));
    assert.ok(names.includes("read_result"), names.join(", "));
    assert.ok(!names.includes("page_act"), names.join(", "));
    assert.ok(!names.includes("run_command"), names.join(", "));

    const navigate = await rpc(`${ctx.base}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { id: "p1", url: "https://example.com" } },
    }, { sid, headers: auth });
    assert.notEqual(navigate.body?.result?.isError, true, navigate.body?.result?.content?.[0]?.text);

    const denied = await rpc(`${ctx.base}/mcp`, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "page_act", arguments: { id: "p1" } },
    }, { sid, headers: auth });
    assert.equal(denied.body?.result?.isError, true);
    assert.equal(denied.body?.result?.structuredContent?.code, "NOT_ALLOWED");
    assert.match(denied.body?.result?.content?.[0]?.text ?? "", /write/);

    const log = await waitForLog(home, (line) => line.tool === "browser_navigate");
    assert.ok(log, "没有写审计日志");
    assert.equal(log.decision, "allow");
    assert.equal(log.group, "navigate");
    assert.equal(log.client.tokenKind, "oauth");
    assert.equal(log.client.tokenId, issued.clientId);
    assert.equal(log.client.tokenName, "ChatGPT 测试");
    assert.equal(log.client.oauthClientId, issued.clientId);
    assert.equal(log.client.oauthClientName, "ChatGPT 测试");

    const rawLogs = readLogs(home);
    assert.ok(!rawLogs.includes(accessToken), "审计日志里出现了 access token");
    assert.ok(!rawLogs.includes(issued.tokens.refresh_token), "审计日志里出现了 refresh token");
    const oauthFile = readFileSync(path.join(home, "oauth.json"), "utf8");
    assert.ok(!oauthFile.includes(accessToken), "oauth.json 里出现了 access token 明文");
    assert.ok(!oauthFile.includes(issued.tokens.refresh_token), "oauth.json 里出现了 refresh token 明文");
    assert.match(oauthFile, /"hash": "[a-f0-9]{64}"/);
  } finally {
    await stopServer(ctx, home);
  }
});

/* ------------------------------------------------------------------ *
 * ⑨ 自定义授权分组
 * ------------------------------------------------------------------ */
test("本机确认可以改分组：显式给 write 后 page_act 可用，admin 仍不行", async () => {
  const home = tempHome();
  const ctx = await startServer({ dataHome: home });
  try {
    const issued = await issueTokens(ctx.base, { groups: ["read", "write"] });
    assert.equal(issued.tokenResult.response.status, 200, JSON.stringify(issued.tokens));
    assert.equal(issued.tokens.scope, "read write");

    const init = await initialize(ctx.base, issued.tokens.access_token);
    assert.equal(init.response.status, 200);
    const sid = init.sid;
    const auth = { authorization: `Bearer ${issued.tokens.access_token}` };
    const listed = await rpc(`${ctx.base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sid, headers: auth });
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes("page_act"), names.join(", "));
    assert.ok(names.includes("oauth_read_tool"), names.join(", "));
    assert.ok(!names.includes("browser_navigate"), names.join(", "));
    assert.ok(!names.includes("run_command"), names.join(", "));

    const act = await rpc(`${ctx.base}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "page_act", arguments: { id: "p1" } },
    }, { sid, headers: auth });
    assert.notEqual(act.body?.result?.isError, true, act.body?.result?.content?.[0]?.text);
  } finally {
    await stopServer(ctx, home);
  }
});

