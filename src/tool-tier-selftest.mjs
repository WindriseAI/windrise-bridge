#!/usr/bin/env node
/**
 * 工具档位（basic / full）—— 自检（真的起 BridgeServer、真的走 MCP tools/list）。
 *
 * 运行：node src/tool-tier-selftest.mjs
 *
 * 覆盖：
 *   ① 过滤函数：basic 放行 builtin / custom / external:*windows* / external:*browseros*，
 *     挡住 chatcut / memos；严格档，没有「找不到 windows 就全放行」的兜底。
 *   ② 基础档 tools/list：有内置、自定义、ext__windows_mcp__ 和 read_result；
 *     没有 ext__chatcut__ / ext__memos__。
 *   ③ 基础档 tools/call：被藏起来的私人外接工具按「未知工具」处理，绕不过 tools/list。
 *   ④ 完整档 tools/list：全部都在。
 *
 * 副作用隔离：数据写在系统临时目录；注册的测试工具跑完就摘掉。
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeServer, toolVisibleInTier } from "./core/bridge.js";
import { registerTool, unregisterTool } from "./core/registry.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const FIXTURES = [
  { name: "tier_builtin_tool", source: "builtin" },
  { name: "tier_custom_tool", source: "custom" },
  { name: "ext__chatcut__private_tool", source: "external:chatcut" },
  { name: "ext__memos__private_note", source: "external:memos" },
  { name: "ext__windows_mcp__mouse_click", source: "external:windows_mcp" },
];

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "tool-tier-selftest-"));
const dataHome = path.join(tmpRoot, "data");
const routeToken = randomBytes(16).toString("hex");
const BASE_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-tier-selftest", version: "1" } };

const post = (url, body, sid) => fetch(url, {
  method: "POST",
  headers: { ...BASE_HEADERS, ...(sid ? { "mcp-session-id": sid } : {}) },
  body: JSON.stringify(body),
});

/** SSE / JSON 两种响应都读；BridgeServer 默认 JSON，但 sse 模式也要能跑。 */
async function readMcp(response) {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json();
  const text = await response.text();
  const lines = text.split(/\r?\n/).filter(line => line.startsWith("data:"));
  return lines.length ? JSON.parse(lines[lines.length - 1].slice(5)) : JSON.parse(text);
}

async function namesForTier(tier) {
  const server = new BridgeServer({ routeToken, dataHome, port: 0, toolTier: tier });
  await server.start();
  try {
    const initResponse = await post(server.localUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
    await readMcp(initResponse);
    const sid = initResponse.headers.get("mcp-session-id");
    const listed = await readMcp(await post(server.localUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid));
    const names = (listed?.result?.tools ?? []).map(tool => tool.name);
    const call = await readMcp(await post(server.localUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ext__chatcut__private_tool", arguments: {} },
    }, sid));
    return { names, call };
  } finally {
    await server.stop();
  }
}

for (const fixture of FIXTURES) {
  registerTool({
    name: fixture.name,
    source: fixture.source,
    title: fixture.name,
    description: "工具档位自检用的假工具",
    handler: async () => ({ content: [{ type: "text", text: `${fixture.name} ok` }] }),
  });
}

try {
  console.log("\n=== ① 过滤函数 ===");
  check(
    "basic 放行 builtin / custom / external:windows",
    ["builtin", "custom", "external:windows_mcp"].every(source => toolVisibleInTier({ source }, "basic")),
  );
  check(
    "basic 放行浏览器适配 external:browseros_neo",
    toolVisibleInTier({ source: "external:browseros_neo" }, "basic"),
  );
  check(
    "basic 挡住 external:chatcut / external:memos",
    !toolVisibleInTier({ source: "external:chatcut" }, "basic") &&
      !toolVisibleInTier({ source: "external:memos" }, "basic"),
  );
  check(
    "严格档：没有 windows 外接时 chatcut 照样挡住（不会因外接掉线就变样）",
    !toolVisibleInTier({ source: "external:chatcut" }, "basic", { windowsServerPresent: false }),
  );
  check("没有 source 的工具（异常数据）按自带放行", toolVisibleInTier({}, "basic"));
  check("full 档全部放行", ["builtin", "custom", "external:chatcut", "external:memos", "external:windows_mcp"].every(source => toolVisibleInTier({ source }, "full")));

  console.log("\n=== ② 基础档 tools/list ===");
  const basic = await namesForTier("basic");
  check("有内置工具", basic.names.includes("tier_builtin_tool"), basic.names.join(", "));
  check("有自定义工具", basic.names.includes("tier_custom_tool"), basic.names.join(", "));
  check("有 windows 鼠标兜底", basic.names.includes("ext__windows_mcp__mouse_click"), basic.names.join(", "));
  check("有桥自带的 read_result", basic.names.includes("read_result"), basic.names.join(", "));
  check("有只读的 session_stats", basic.names.includes("session_stats"), basic.names.join(", "));
  check("没有 chatcut 私人工具", !basic.names.some(name => name.startsWith("ext__chatcut__")), basic.names.join(", "));
  check("没有 memos 私人工具", !basic.names.some(name => name.startsWith("ext__memos__")), basic.names.join(", "));
  check(
    "基础档直接调被藏起来的工具 → 未知工具",
    basic.call?.result?.isError === true && /未知工具/.test(basic.call?.result?.content?.[0]?.text ?? ""),
    basic.call?.result?.content?.[0]?.text ?? "",
  );

  console.log("\n=== ③ 完整档 tools/list ===");
  const full = await namesForTier("full");
  check("全部 5 个测试工具都在", FIXTURES.every(tool => full.names.includes(tool.name)), full.names.join(", "));
  check("chatcut / memos 也在", full.names.includes("ext__chatcut__private_tool") && full.names.includes("ext__memos__private_note"), full.names.join(", "));
} finally {
  for (const fixture of FIXTURES) unregisterTool(fixture.name);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
}

const failed = results.filter(result => !result.ok);
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
process.exit(failed.length ? 1 : 0);
