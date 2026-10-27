/**
 * 工具权限（口令作用域 + 工具分组 + 参数谓词 + 审计）的单元测试。
 *   node --test src/core/tool-policy.test.js
 *
 * 覆盖：
 *   ① 每个工具都有合法分组：内置 / 浏览器 / 共享上下文 / 软件控制 / 自定义工具管理员；
 *   ② 作用域规范化：分组、格子、域名（含通配符）；空数组 / 缺字段的语义；
 *   ③ 域名谓词：只查带 url 的导航工具，裸域名包含子域名，不允许后缀伪装；
 *   ④ cwd 谓词：相对 / 绝对路径都按授权工作区判；
 *   ⑤ 网关：带作用域的口令按分组过滤 tools/list，越权调用返回 NOT_ALLOWED；
 *   ⑥ 老口令兼容：没有 scope 的连接器和主口令行为与以前一致；
 *   ⑦ 审计：client 里是口令名字 / 指纹，group / decision / reason 齐全，且没有口令原文。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeServer } from "./bridge.js";
import { ConnectorStore, connectorsFile } from "./connectors.js";
import { OwnerAuthStore, ownerAuthFile } from "./bearer-auth.js";
import { registerTool, unregisterTool } from "./registry.js";
import { defineAppTools } from "../tools/app.js";
import { defineBrowserTools } from "../tools/browser.js";
import { defineContextTools } from "../tools/context.js";
import { defineCustomToolAdmin } from "../tools/custom.js";
import { defineBuiltinTools } from "../tools/toolset.js";
import {
  TOOL_GROUPS,
  ToolGroup,
  checkCwdAllowed,
  checkToolArguments,
  checkUrlAllowed,
  domainAllowed,
  groupForTool,
  normalizeScope,
  scopeAllowsGroup,
  scopeAllowsProfile,
  scopeAllowsTool,
} from "./tool-policy.js";

const FIXTURES = [
  { name: "policy_read", capability: "read", handler: async () => ({ content: [{ type: "text", text: "read ok" }] }) },
  {
    name: "page_snapshot",
    capability: "read",
    scope: "profile",
    handler: async (input) => ({ content: [{ type: "text", text: `snapshot ${input.id}` }] }),
  },
  {
    name: "browser_navigate",
    capability: "execute",
    scope: "profile",
    handler: async (input) => ({ content: [{ type: "text", text: `navigate ${input.url}` }] }),
  },
  {
    name: "page_act",
    capability: "execute",
    scope: "profile",
    handler: async (input) => ({ content: [{ type: "text", text: `act ${input.id}` }] }),
  },
  {
    name: "run_command",
    capability: "execute",
    handler: async (input) => ({ content: [{ type: "text", text: `run in ${input.cwd ?? "(default)"}` }] }),
  },
];

for (const fixture of FIXTURES) {
  registerTool({ title: fixture.name, description: "作用域单测用的假工具", ...fixture });
}
test.after(() => {
  for (const fixture of FIXTURES) unregisterTool(fixture.name);
});

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "tool-policy-"));
}

async function startServer({ dataHome, connectors = null, ownerAuth = null, workspaceRoots = [] }) {
  const server = new BridgeServer({
    routeToken: "route-token-for-test",
    dataHome,
    connectors,
    ownerAuth,
    workspaceRoots,
    port: 0,
    jsonResponse: true,
  });
  await server.start();
  return server;
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function rpc(url, body, { sid, headers = {} } = {}) {
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
  return { response, body: text ? JSON.parse(text) : null, sid: response.headers.get("mcp-session-id") };
}

async function connect(url, headers = {}) {
  const init = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-policy-test", version: "1" } },
  }, { headers });
  assert.equal(init.response.status, 200);
  const sid = init.sid;
  const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sid, headers });
  return { sid, headers, names: (listed.body?.result?.tools ?? []).map((tool) => tool.name) };
}

async function call(url, session, name, args) {
  const result = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, session);
  return result.body?.result ?? null;
}

async function waitForLog(dataHome, predicate, timeoutMs = 3000) {
  const dir = path.join(dataHome, "logs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = [];
    for (const name of readdirSync(dir).filter((file) => /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))) {
      for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
      }
    }
    const found = lines.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/** ????????????????????????????? */
async function stopAndRemove(server, ...dirs) {
  await server.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function logText(dataHome) {
  const dir = path.join(dataHome, "logs");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => readFileSync(path.join(dir, file), "utf8"))
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * ① 工具分组
 * ------------------------------------------------------------------ */
test("每个工具都有合法分组，关键工具按风险分组", () => {
  const definitions = [
    ...defineBuiltinTools({ control: {}, terminal: {}, guard: { roots: [] }, mcpConfigPath: "", externalMcp: {}, broker: {} }),
    ...defineBrowserTools(),
    ...defineContextTools({ bus: {} }),
    ...defineAppTools(),
    ...defineCustomToolAdmin({ dataHome: path.join(os.tmpdir(), "tool-policy-catalog") }),
  ];
  assert.ok(definitions.length > 50, `工具定义太少：${definitions.length}`);
  for (const definition of definitions) {
    const group = groupForTool(definition);
    assert.ok(TOOL_GROUPS.includes(group), `${definition.name} 的分组不合法：${group}`);
  }
  const expected = {
    page_snapshot: ToolGroup.READ,
    page_read: ToolGroup.READ,
    page_act: ToolGroup.WRITE,
    browser_navigate: ToolGroup.NAVIGATE,
    browser_nav: ToolGroup.NAVIGATE,
    browser_open: ToolGroup.NAVIGATE,
    browser_click: ToolGroup.WRITE,
    browser_type: ToolGroup.WRITE,
    apply_patch: ToolGroup.WRITE,
    run_command: ToolGroup.ADMIN,
    admin_run: ToolGroup.ADMIN,
    admin_confirm: ToolGroup.ADMIN,
    configure_mcp: ToolGroup.ADMIN,
    custom_tool_save: ToolGroup.ADMIN,
    set_todos: ToolGroup.READ,
  };
  for (const [name, group] of Object.entries(expected)) {
    const definition = definitions.find((item) => item.name === name);
    assert.ok(definition, `缺少工具 ${name}`);
    assert.equal(groupForTool(definition), group, `${name} 应该属于 ${group}`);
  }
  // 外部 MCP 转发工具无法判断真实行为，默认最危险的 admin；未知能力也按 admin
  assert.equal(groupForTool({ name: "ext__x__y", source: "external:x", capability: "read" }), ToolGroup.ADMIN);
  assert.equal(groupForTool({ name: "mystery", capability: "unknown" }), ToolGroup.ADMIN);
  // 注册表真正存下来的分组
  const registered = registerTool({ name: "policy_registered", title: "注册分组", description: "", handler: async () => ({}) });
  try {
    assert.equal(registered.group, ToolGroup.READ);
  } finally {
    unregisterTool("policy_registered");
  }
});

/* ------------------------------------------------------------------ *
 * ② 作用域与谓词（纯函数）
 * ------------------------------------------------------------------ */
test("作用域规范化：缺字段 / 空数组 / 域名通配符", () => {
  assert.equal(normalizeScope(null), null);
  assert.equal(normalizeScope({}), null);
  assert.equal(normalizeScope({ groups: [], profiles: [], domains: [] }).groups.length, 0);
  assert.deepEqual(normalizeScope({ groups: ["READ", "admin", "bad"], profiles: ["p1", "p1", ""], domains: ["Example.com", ".sub.example.com", "*.wild.example.com", "https://port.example.com:8443/x", "bad domain"] }), {
    groups: ["read", "admin"],
    profiles: ["p1"],
    domains: ["example.com", "sub.example.com", "*.wild.example.com", "port.example.com"],
  });
  assert.deepEqual(normalizeScope({ groups: ["admin"], domains: [] }), { groups: ["admin"], profiles: null, domains: [] });
  assert.equal(scopeAllowsGroup({ groups: [] }, ToolGroup.READ), false);
  assert.equal(scopeAllowsGroup({ groups: ["read"] }, ToolGroup.WRITE), false);
  assert.equal(scopeAllowsGroup(null, ToolGroup.ADMIN), true);
  assert.equal(scopeAllowsTool({ groups: ["navigate"] }, { name: "browser_navigate", capability: "execute" }), true);
  assert.equal(scopeAllowsTool({ groups: ["navigate"] }, { name: "run_command", capability: "execute" }), false);
  assert.equal(scopeAllowsProfile({ profiles: ["p1"] }, "p2"), false);
  assert.equal(scopeAllowsProfile({ profiles: null }, "p2"), true);
});

test("域名谓词：裸域名包含子域名，通配符只匹配子域名，后缀伪装被拒", () => {
  assert.equal(domainAllowed("example.com", ["example.com"]), true);
  assert.equal(domainAllowed("a.b.example.com", ["example.com"]), true);
  assert.equal(domainAllowed("example.com.evil.com", ["example.com"]), false);
  assert.equal(domainAllowed("example.com", ["*.example.com"]), false);
  assert.equal(domainAllowed("a.example.com", ["*.example.com"]), true);
  assert.equal(domainAllowed("EXAMPLE.COM.", ["example.com"]), true);

  const scope = normalizeScope({ groups: ["navigate"], domains: ["example.com"] });
  assert.equal(checkUrlAllowed("browser_navigate", { url: "https://sub.example.com/x" }, scope).ok, true);
  assert.equal(checkUrlAllowed("browser_navigate", { url: "https://evil.com/x" }, scope).ok, false);
  assert.equal(checkUrlAllowed("browser_navigate", { url: "javascript:alert(1)" }, scope).ok, false);
  assert.equal(checkUrlAllowed("browser_navigate", { url: "not a url" }, scope).ok, false);
  // page_act 没有 url 参数，不做域名检查；没配置 domains 时也不查
  assert.equal(checkUrlAllowed("page_act", { url: "https://evil.com" }, scope).ok, true);
  assert.equal(checkUrlAllowed("browser_navigate", { url: "https://evil.com" }, normalizeScope({ groups: ["navigate"] })).ok, true);
  // 给了空数组 / 全是非法域名：一个都不放行（宁可拦错，也不静默取消限制）
  assert.equal(checkUrlAllowed("browser_navigate", { url: "https://example.com" }, normalizeScope({ groups: ["navigate"], domains: [] })).ok, false);
  assert.equal(checkUrlAllowed("browser_navigate", { url: "https://example.com" }, normalizeScope({ groups: ["navigate"], domains: ["bad domain"] })).ok, false);
});

test("cwd 谓词：相对路径按第一个工作区解析，越界拒绝", () => {
  const root = path.resolve(os.tmpdir(), "policy-workspace");
  assert.equal(checkCwdAllowed(undefined, [root]).ok, true);
  assert.equal(checkCwdAllowed(".", [root]).ok, true);
  assert.equal(checkCwdAllowed(path.join(root, "sub"), [root]).ok, true);
  assert.equal(checkCwdAllowed(path.dirname(root), [root]).ok, false);
  assert.equal(checkCwdAllowed(root, []).ok, false);
  const scope = normalizeScope({ groups: ["admin", "navigate"] });
  assert.equal(checkToolArguments({ tool: { name: "run_command" }, args: { cwd: path.dirname(root) }, scope, workspaceRoots: [root] }).ok, false);
  assert.equal(checkToolArguments({ tool: { name: "run_command" }, args: { cwd: path.join(root, "src") }, scope, workspaceRoots: [root] }).ok, true);
  // 没写 cwd 时按终端当前目录判：终端被 cd 到工作区外后，scoped 口令不能装不知道
  assert.equal(checkToolArguments({ tool: "run_command", args: {}, scope, workspaceRoots: [root], currentCwd: () => root }).ok, true);
  assert.equal(checkToolArguments({ tool: "run_command", args: {}, scope, workspaceRoots: [root], currentCwd: () => path.dirname(root) }).ok, false);
  // 老口令（scope 为 null）不做谓词
  assert.equal(checkToolArguments({ tool: { name: "run_command" }, args: { cwd: path.dirname(root) }, scope: null, workspaceRoots: [root] }).ok, true);
});

/* ------------------------------------------------------------------ *
 * ⑤ 网关：带作用域的连接器
 * ------------------------------------------------------------------ */
test("带作用域的连接器：tools/list 过滤，越权调用 NOT_ALLOWED，审计不含口令", async () => {
  const dataHome = tempHome();
  const store = new ConnectorStore({ file: connectorsFile(dataHome) });
  const connector = store.create("Claude 只读");
  store.grant(connector.id, "p1");
  store.setScope(connector.id, { groups: ["read"] });
  const server = await startServer({ dataHome, connectors: store });
  try {
    const url = `${baseUrl(server)}/mcp/${connector.token}`;
    const session = await connect(url);
    assert.ok(session.names.includes("policy_read"));
    assert.ok(session.names.includes("page_snapshot"));
    assert.ok(session.names.includes("read_result"));
    assert.ok(!session.names.includes("browser_navigate"), session.names.join(", "));
    assert.ok(!session.names.includes("page_act"), session.names.join(", "));
    assert.ok(!session.names.includes("run_command"), session.names.join(", "));

    const denied = await call(url, session, "browser_navigate", { id: "p1", url: "https://example.com" });
    assert.equal(denied?.isError, true);
    assert.equal(denied?.structuredContent?.code, "NOT_ALLOWED");
    assert.match(denied?.content?.[0]?.text ?? "", /没有 navigate 分组/);
    assert.match(denied?.structuredContent?.reason ?? "", /read/);

    const allowed = await call(url, session, "page_snapshot", { id: "p1" });
    assert.notEqual(allowed?.isError, true);
    assert.match(allowed?.content?.[0]?.text ?? "", /snapshot p1/);

    const denyLog = await waitForLog(dataHome, (line) => line.tool === "browser_navigate");
    assert.equal(denyLog?.decision, "deny");
    assert.equal(denyLog?.group, "navigate");
    assert.match(denyLog?.reason ?? "", /read/);
    assert.equal(denyLog?.client?.tokenName, "Claude 只读");
    assert.equal(denyLog?.client?.tokenId, connector.id);
    assert.equal(denyLog?.client?.tokenKind, "connector");
    const raw = logText(dataHome);
    assert.ok(!raw.includes(connector.token), "审计日志里出现了口令原文");
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("带作用域的主口令：分组 + 格子 + 域名三个谓词都生效", async () => {
  const dataHome = tempHome();
  const ownerAuth = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  const created = ownerAuth.addKey("浏览器客户端", { scope: { groups: ["navigate"], profiles: ["p1"], domains: ["example.com"] } });
  const server = await startServer({ dataHome, ownerAuth });
  try {
    const url = `${baseUrl(server)}/mcp`;
    const headers = { authorization: `Bearer ${created.key}` };
    const session = await connect(url, headers);
    assert.ok(session.names.includes("browser_navigate"));
    assert.ok(!session.names.includes("policy_read"), session.names.join(", "));
    assert.ok(!session.names.includes("read_result"), session.names.join(", "));

    const ok = await call(url, session, "browser_navigate", { id: "p1", url: "https://sub.example.com/page" });
    assert.notEqual(ok?.isError, true, ok?.content?.[0]?.text);

    const badDomain = await call(url, session, "browser_navigate", { id: "p1", url: "https://evil.com" });
    assert.equal(badDomain?.structuredContent?.code, "NOT_ALLOWED");
    assert.match(badDomain?.structuredContent?.reason ?? "", /evil\.com/);

    const badGrid = await call(url, session, "browser_navigate", { id: "p2", url: "https://example.com" });
    assert.equal(badGrid?.structuredContent?.code, "NOT_ALLOWED");
    assert.match(badGrid?.structuredContent?.reason ?? "", /p2/);

    const allowLog = await waitForLog(dataHome, (line) => line.tool === "browser_navigate" && line.decision === "allow");
    assert.equal(allowLog?.group, "navigate");
    assert.equal(allowLog?.client?.tokenName, "浏览器客户端");
    assert.equal(allowLog?.client?.tokenId, created.id);
    assert.equal(allowLog?.client?.tokenKind, "owner-key");
    const denyLog = await waitForLog(dataHome, (line) => line.tool === "browser_navigate" && line.decision === "deny");
    assert.ok(denyLog?.reason, "拒绝日志必须带原因");
    assert.equal(denyLog?.group, "navigate");
    const raw = logText(dataHome);
    assert.ok(!raw.includes(created.key), "审计日志里出现了主口令原文");
    assert.ok(!raw.includes("/mcp/"), "审计日志里出现了带令牌的地址");
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("run_command 的 cwd 谓词：作用域口令拒绝工作区外，老口令照旧", async () => {
  const dataHome = tempHome();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "policy-workdir-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "policy-outside-"));
  const ownerAuth = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  const scoped = ownerAuth.addKey("命令客户端", { scope: { groups: ["admin"] } });
  const legacy = ownerAuth.addKey("老客户端");
  const server = await startServer({ dataHome, ownerAuth, workspaceRoots: [workspace] });
  try {
    const url = `${baseUrl(server)}/mcp`;
    const scopedSession = await connect(url, { authorization: `Bearer ${scoped.key}` });
    const legacySession = await connect(url, { authorization: `Bearer ${legacy.key}` });

    const inside = await call(url, scopedSession, "run_command", { command: "echo hi", cwd: path.join(workspace, "sub") });
    assert.notEqual(inside?.isError, true, inside?.content?.[0]?.text);

    const outsideCall = await call(url, scopedSession, "run_command", { command: "echo hi", cwd: outside });
    assert.equal(outsideCall?.structuredContent?.code, "NOT_ALLOWED");
    assert.match(outsideCall?.structuredContent?.reason ?? "", /不在授权工作区/);

    const legacyOutside = await call(url, legacySession, "run_command", { command: "echo hi", cwd: outside });
    assert.notEqual(legacyOutside?.isError, true, "老口令不应受新的 cwd 谓词影响");

    assert.ok(!scopedSession.names.includes("policy_read"));
    assert.ok(scopedSession.names.includes("run_command"));
    assert.ok(legacySession.names.includes("policy_read"));
    assert.ok(legacySession.names.includes("run_command"));
  } finally {
    await stopAndRemove(server, workspace, outside, dataHome);
  }
});

/* ------------------------------------------------------------------ *
 * ⑥ 老口令兼容
 * ------------------------------------------------------------------ */
test("老连接器（没有作用域）：仍然只能碰分给它的窗口工具", async () => {
  const dataHome = tempHome();
  const store = new ConnectorStore({ file: connectorsFile(dataHome) });
  const connector = store.create("老连接器");
  store.grant(connector.id, "p1");
  const server = await startServer({ dataHome, connectors: store });
  try {
    const url = `${baseUrl(server)}/mcp/${connector.token}`;
    const session = await connect(url);
    assert.ok(session.names.includes("page_snapshot"));
    assert.ok(session.names.includes("read_result"));
    // 老连接器的规则是「所有 profile 工具 + browser_profiles」，所以浏览器写工具也在
    assert.ok(session.names.includes("browser_navigate"));
    assert.ok(session.names.includes("page_act"));
    assert.ok(!session.names.includes("policy_read"), session.names.join(", "));

    const ok = await call(url, session, "page_snapshot", { id: "p1" });
    assert.notEqual(ok?.isError, true, ok?.content?.[0]?.text);

    const denied = await call(url, session, "policy_read", {});
    assert.equal(denied?.structuredContent?.code, "NOT_ALLOWED");
    const log = await waitForLog(dataHome, (line) => line.tool === "policy_read");
    assert.equal(log?.decision, "deny");
    assert.ok(log?.reason);
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("老主口令（没有作用域）：行为和以前一样，全部工具可列", async () => {
  const dataHome = tempHome();
  const ownerAuth = new OwnerAuthStore({ file: ownerAuthFile(dataHome) });
  const legacy = ownerAuth.addKey("老主口令");
  const server = await startServer({ dataHome, ownerAuth });
  try {
    const url = `${baseUrl(server)}/mcp`;
    const session = await connect(url, { authorization: `Bearer ${legacy.key}` });
    assert.ok(session.names.includes("policy_read"));
    assert.ok(session.names.includes("browser_navigate"));
    assert.ok(session.names.includes("run_command"));
    assert.ok(session.names.includes("page_act"));
    assert.ok(session.names.includes("read_result"));
    const ok = await call(url, session, "policy_read", {});
    assert.notEqual(ok?.isError, true);
    const log = await waitForLog(dataHome, (line) => line.tool === "policy_read");
    assert.equal(log?.decision, "allow");
    assert.equal(log?.group, "read");
    assert.equal(log?.client?.tokenName, "老主口令");
  } finally {
    await stopAndRemove(server, dataHome);
  }
});
