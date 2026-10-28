#!/usr/bin/env node
/**
 * Bridge 扩展能力 —— 端到端自检（真的起服务、真的走 MCP 协议、真的读写文件）。
 *
 * 运行：node src/bridge-extras-selftest.mjs
 *
 * 覆盖：
 *   ① summarizeArgs：敏感键隐藏、长字符串截断、数组 / 对象 / 数字 / 布尔摘要
 *   ② 调用日志：小工具调用后多一行，字段齐全，客户端名与版本、会话 ID 正确，密码被隐藏
 *   ③ 大结果：超过 resultLimitBytes 后返回句柄 + 前 4000 字，完整内容落盘
 *   ④ read_result：分几段读回，拼起来与原文一致；不存在的句柄返回 isError
 *   ⑤ 健康三态：全通过 ready / 宽限期内 starting / 超过宽限期 degraded
 *   ⑥ 探针超时：超过 3 秒算失败，health() 不会被挂住的探针拖过 4 秒
 *
 * 纪律：所有结论都来自实际运行输出；跑不通就如实打 FAIL，不粉饰。
 * 副作用隔离：数据写在系统临时目录，不碰真实的 ~/.bridge-replica。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { BridgeServer } from "./core/bridge.js";
import { summarizeArgs } from "./core/call-log.js";
import { registerTool, unregisterTool } from "./core/registry.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* ================================================================== *
 * ① 参数摘要
 * ================================================================== */
console.log("\n=== ① 参数摘要 ===");
{
  const long = "x".repeat(200);
  const summary = summarizeArgs({
    password: "hunter2",
    token: "tok_123",
    Cookie: "session=abc",
    apiKey: "sk-xxx",
    userSecret: "s",
    note: "hello",
    long,
    list: [1, 2, 3],
    object: { a: 1, b: 2 },
    count: 42,
    enabled: true,
  });
  const hiddenKeys = ["password", "token", "Cookie", "apiKey", "userSecret"];
  check(
    "密码 / 令牌 / Cookie 等键被隐藏",
    hiddenKeys.every(key => summary[key] === "[已隐藏]"),
    hiddenKeys.map(key => `${key}=${summary[key]}`).join("；"),
  );
  check(
    "长字符串截到 80 字并写明总长",
    summary.long === `${"x".repeat(80)}…（共 200 字）`,
    summary.long,
  );
  check("数组按项数摘要", summary.list === "[3 项]", summary.list);
  check("对象按键名摘要", summary.object === "{a,b}", summary.object);
  check("数字和布尔原样", summary.count === 42 && summary.enabled === true, `count=${summary.count} enabled=${summary.enabled}`);
  check("普通字符串不截断", summary.note === "hello", summary.note);
  // page_act 往密码框里打字时键名就是 text，只能按「输入内容」整体只记长度
  const typed = summarizeArgs({ ref: "e12", action: "type", text: "hunter2" });
  check("往网页输入的内容只记长度", typed.text === "[输入内容，7 字]" && typed.ref === "e12", JSON.stringify(typed));
  // flow_replay 的 vars：键名是用户起的变量名，值一个都不能进日志（secret 只放内存）
  const replay = summarizeArgs({ name: "登录", vars: { 姓名: "张三", 密码: "SuperSecret42" } });
  const replayText = JSON.stringify(replay);
  check(
    "流程重放的变量表只记个数，值不进日志",
    replay.vars === "[2 个变量，值不记]" && !replayText.includes("SuperSecret42") && !replayText.includes("张三"),
    replayText,
  );
}

/* ================================================================== *
 * ② 起一个真的 BridgeServer，注册两个测试工具
 * ================================================================== */
console.log("\n=== ② 启动 BridgeServer 并走 MCP 协议 ===");
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bridge-extras-"));
const dataHome = path.join(tmpRoot, "data");
process.env.BRIDGE_SHARED_DATA_HOME = path.join(tmpRoot, "shared");

const SMALL_TOOL = "extra_small";
const BIG_TOOL = "extra_big";
const smallText = "小结果：一切正常";
const bigText = "0123456789".repeat(600); // 6000 字节，远大于测试用的 2000 上限

registerTool({
  name: SMALL_TOOL,
  title: "小结果",
  description: "自检用：返回一小段文本",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  handler: async () => ({ content: [{ type: "text", text: smallText }], structuredContent: { code: "OK" } }),
});
registerTool({
  name: BIG_TOOL,
  title: "大结果",
  description: "自检用：返回超过上限的长文本",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  handler: async () => ({ content: [{ type: "text", text: bigText }], structuredContent: { code: "BIG" } }),
});

const server = new BridgeServer({
  routeToken: randomBytes(16).toString("hex"),
  dataHome,
  port: 0,
  resultLimitBytes: 2000,
  startupGraceMs: 60_000,
});
await server.start();
const url = server.localUrl;

/** 最小 MCP 客户端（和 src/external-mcp-selftest.mjs 里的一样走 HTTP 端点）。 */
function mcpClient(endpoint) {
  let sessionId = null;
  let id = 0;
  const post = async (method, params) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!sessionId) sessionId = response.headers.get("mcp-session-id");
    const body = await response.json();
    if (body.error) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    initialize: () => post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-extras-selftest", version: "1" } }),
    listTools: async () => (await post("tools/list", {}))?.tools ?? [],
    call: (name, args) => post("tools/call", { name, arguments: args ?? {} }),
    text: (result) => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "",
    get sessionId() { return sessionId; },
  };
}

const client = mcpClient(url);
await client.initialize();
const tools = await client.listTools();
check("tools/list 里有 read_result", tools.some(tool => tool.name === "read_result"), tools.map(tool => tool.name).join(", "));
check("tools/list 里有只读的 session_stats", tools.some(tool => tool.name === "session_stats" && tool.annotations?.readOnlyHint === true), tools.map(tool => tool.name).join(", "));

/* ================================================================== *
 * ③ 小工具 + 调用日志
 * ================================================================== */
console.log("\n=== ③ 小结果与调用日志 ===");
const small = await client.call(SMALL_TOOL, { password: "hunter2", note: "hello" });
check("小结果原样返回", !small.isError && client.text(small) === smallText, client.text(small));

const logsDir = path.join(dataHome, "logs");
function readLogLines() {
  const names = readdirSync(logsDir).filter(name => /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const lines = [];
  for (const name of names) {
    for (const line of readFileSync(path.join(logsDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
    }
  }
  return lines;
}
async function findLog(tool) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = readLogLines().find(line => line.tool === tool);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

const smallLog = await findLog(SMALL_TOOL);
check("调用日志里多了一行", Boolean(smallLog), smallLog ? `文件：${readdirSync(logsDir).join(", ")}` : "2 秒内没出现");
const requiredFields = ["at", "sessionId", "client", "tool", "args", "ok", "code", "durationMs", "resultBytes", "stored"];
check(
  "日志字段齐全",
  Boolean(smallLog) && requiredFields.every(key => key in smallLog),
  smallLog ? Object.keys(smallLog).join(", ") : "",
);
check(
  "日志带会话 ID 和客户端名字 / 版本",
  smallLog?.sessionId === client.sessionId && smallLog?.client?.name === "bridge-extras-selftest" && smallLog?.client?.version === "1",
  `sessionId=${smallLog?.sessionId} client=${JSON.stringify(smallLog?.client)}`,
);
check(
  "日志里密码被隐藏、普通参数保留",
  smallLog?.args?.password === "[已隐藏]" && smallLog?.args?.note === "hello",
  JSON.stringify(smallLog?.args),
);
check(
  "日志 ok / code / resultBytes / stored 正确",
  smallLog?.ok === true && smallLog?.code === "OK" && smallLog?.resultBytes === Buffer.byteLength(smallText, "utf8") && smallLog?.stored === null && typeof smallLog?.durationMs === "number",
  `ok=${smallLog?.ok} code=${smallLog?.code} bytes=${smallLog?.resultBytes} stored=${smallLog?.stored}`,
);

/* ================================================================== *
 * ④ 大结果落盘 + read_result 分段读回
 * ================================================================== */
console.log("\n=== ④ 大结果存文件与 read_result ===");
const big = await client.call(BIG_TOOL, {});
const bigOutput = client.text(big);
const handle = big.structuredContent?.handle;
check(
  "大结果返回句柄说明与前 4000 字提示",
  /^结果太大（约 \d+ KB），已存成句柄 [A-Za-z0-9-]+。前 4000 字如下；要看后面用 read_result 分段读。/.test(bigOutput),
  bigOutput.slice(0, 120),
);
check(
  "structuredContent 标记截断并带总字节 / 总字数",
  big.structuredContent?.truncated === true && big.structuredContent?.totalBytes === 6000 && big.structuredContent?.textLength === bigText.length,
  JSON.stringify(big.structuredContent),
);
check("句柄只含字母数字和 -", typeof handle === "string" && /^[A-Za-z0-9-]+$/.test(handle), handle);
const resultFile = path.join(dataHome, "results", `${handle}.json`);
check("results 目录下有落盘文件", existsSync(resultFile), resultFile);
check("返回文本末尾是前 4000 字", bigOutput.endsWith(bigText.slice(0, 4000)), `返回长度=${bigOutput.length}`);

let assembled = "";
let offset = 0;
let chunks = 0;
let lastPage = null;
for (; chunks < 20; chunks++) {
  const page = await client.call("read_result", { handle, offset, length: 1500 });
  if (page.isError) break;
  const meta = page.structuredContent ?? {};
  const raw = client.text(page);
  assembled += raw.slice(0, meta.length ?? 0);
  lastPage = { raw, meta };
  if (meta.done) break;
  offset = meta.nextOffset;
}
check(
  "read_result 分几段读回，拼起来和原文一致",
  chunks >= 2 && assembled === bigText,
  `段数=${chunks} 拼回=${assembled.length}/${bigText.length}`,
);
check(
  "read_result 说明总长和下一段 offset",
  /总长 6000 字/.test(lastPage?.raw ?? "") && lastPage?.meta?.done === true && lastPage?.meta?.nextOffset === bigText.length,
  lastPage?.raw?.slice(-60),
);

const missing = await client.call("read_result", { handle: "no-such-handle" });
check(
  "不存在的句柄返回 isError 和过期说明",
  missing.isError === true && /句柄不存在或已过期（只保留 1 小时）/.test(client.text(missing)),
  client.text(missing),
);
const traversal = await client.call("read_result", { handle: "../outside" });
check("含路径穿越字符的句柄被拒", traversal.isError === true, client.text(traversal));

const bigLog = await findLog(BIG_TOOL);
check(
  "大结果日志记录原字节数和句柄",
  bigLog?.stored === handle && bigLog?.resultBytes === 6000 && bigLog?.code === "BIG",
  `stored=${bigLog?.stored} bytes=${bigLog?.resultBytes} code=${bigLog?.code}`,
);

/* ================================================================== *
 * ⑤ 健康三态
 * ================================================================== */
console.log("\n=== ⑤ 健康检查三态 ===");
const okProbe = { name: "always-ok", run: async () => ({ ok: true, detail: "一切正常" }) };
const failProbe = { name: "always-fail", run: async () => ({ ok: false, detail: "故意失败" }) };

server.startupGraceMs = 60_000;
server.healthProbes = [okProbe, failProbe];
let health = await server.health();
check(
  "有探针失败且在宽限期内 → starting",
  health.readiness === "starting" && health.components["always-fail"]?.ok === false,
  `readiness=${health.readiness} components=${JSON.stringify(health.components)}`,
);

server.startupGraceMs = 0;
health = await server.health();
check("超过宽限期仍有失败 → degraded", health.readiness === "degraded", `readiness=${health.readiness}`);

server.healthProbes = [okProbe];
health = await server.health();
check(
  "全部探针通过 → ready",
  health.readiness === "ready" && health.components["always-ok"]?.ok === true,
  `readiness=${health.readiness}`,
);

const response = await fetch(server.healthUrl());
const overHttp = await response.json();
check(
  "/healthz 照样返回 200 且带 readiness / components",
  response.status === 200 && overHttp.readiness === "ready" && typeof overHttp.components === "object",
  `HTTP ${response.status} readiness=${overHttp.readiness}`,
);
check(
  "原有健康字段还在",
  overHttp.ok === true && overHttp.service === "windrise" && overHttp.state === "running" && typeof overHttp.tools === "number" && typeof overHttp.calls === "number",
  `ok=${overHttp.ok} service=${overHttp.service} state=${overHttp.state} tools=${overHttp.tools}`,
);

/* ================================================================== *
 * ⑥ 探针超时
 * ================================================================== */
console.log("\n=== ⑥ 探针超时 ===");
server.healthProbes = [{
  name: "hang",
  run: () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: true, detail: "其实好了" }), 10_000);
    timer.unref?.();
  }),
}];
server.startupGraceMs = 0;
const started = Date.now();
health = await server.health();
const elapsed = Date.now() - started;
check(
  "超过 3 秒没返回的探针算失败",
  health.components.hang?.ok === false && /超时/.test(health.components.hang?.detail ?? ""),
  health.components.hang?.detail,
);
check("health() 不会被挂住的探针拖过 4 秒", elapsed < 4000, `${elapsed}ms`);

/* ================================================================== *
 * 收尾
 * ================================================================== */
await server.stop();
unregisterTool(SMALL_TOOL);
unregisterTool(BIG_TOOL);
rmSync(tmpRoot, { recursive: true, force: true });

const failed = results.filter(item => !item.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
