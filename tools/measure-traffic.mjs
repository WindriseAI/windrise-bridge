/**
 * 实测：一次工具调用到底跑多少流量。
 *
 * 为什么要实测：这是「1GB 够不够」的唯一可靠依据。
 * 估算容易差一个数量级，直接量 HTTP 响应体的字节数最实在。
 *
 * 量的东西：MCP 的完整响应（JSON-RPC 信封 + 内容），也就是隧道要搬的字节。
 */

import { stat } from "node:fs/promises";
import path from "node:path";

const BASE = `http://127.0.0.1:${process.argv[2] ?? "48272"}`;
const TOKEN = process.argv[3] ?? "REVOKED_OLD_ROUTE_TOKEN";
const MCP = `${BASE}/mcp/${TOKEN}`;
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

let sessionId = null;
let nextId = 1;

async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: sessionId ? { ...HEADERS, "mcp-session-id": sessionId } : HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const sid = response.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  // 量原始字节 —— 这才是隧道要搬的东西
  const raw = await response.arrayBuffer();
  const text = Buffer.from(raw).toString("utf8");
  return { bytes: raw.byteLength, text };
}

/** 响应可能是 JSON，也可能是 SSE（首行是 "event: message"，正文在 "data:" 行里），两种都要能读 */
function parse(text) {
  // 不能只看整段是否以 "data:" 开头 —— SSE 的首行是 event:，那样判断永远为假
  const dataLines = text.split(/\r?\n/).filter(l => l.startsWith("data:"));
  const body = dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(5) : text;
  try { return JSON.parse(body); } catch { return null; }
}

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const MB = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

const results = [];
async function measure(label, tool, args, note = "") {
  try {
    const { bytes, text } = await rpc("tools/call", { name: tool, arguments: args });
    const parsed = parse(text);
    const isError = parsed?.result?.isError === true;
    const content = parsed?.result?.content ?? [];
    const imagePart = content.find((c) => c.type === "image");
    const textPart = content.find((c) => c.type === "text");

    results.push({ label, bytes, isError, imageBytes: imagePart ? Math.round(imagePart.data.length * 3 / 4) : 0, note });
    console.log(`  ${label}`);
    console.log(`    响应体 ${KB(bytes)}${imagePart ? `（其中图片约 ${KB(Math.round(imagePart.data.length * 3 / 4))}）` : ""}${isError ? "  ← 报错了" : ""}`);
    if (textPart && note !== "quiet") console.log(`    ${String(textPart.text).split("\n")[0].slice(0, 110)}`);
  } catch (error) {
    console.log(`  ${label}\n    失败：${error.message}`);
    results.push({ label, bytes: 0, error: error.message });
  }
}

/* ---------- 建会话 ---------- */
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "measure", version: "1" } });
console.log(`会话建立：${parse(init.text)?.result?.serverInfo?.name ?? "?"}\n`);

console.log("=".repeat(76));
console.log("一、小操作（这决定「正常用」的流量）");
console.log("=".repeat(76));
await measure("列目录 list_directory", "list_directory", { path: "." });
await measure("读 package.json", "read_files", { paths: ["package.json"] });
await measure("读一个源文件", "read_files", { paths: ["src/core/tunnel.js"] });
await measure("搜代码 search_files", "search_files", { pattern: "context-bus", glob: "src/**/*.js" });
await measure("跑命令 run_command", "run_command", { command: "node --version" });

console.log("");
console.log("=".repeat(76));
console.log("二、图片（这是流量的大头）");
console.log("=".repeat(76));

// 先看看手上有哪些图片，各自多大
const images = ["dist/smoke-window.png", "dist/verify-cdp.png", "dist/verify-window.png"];
for (const file of images) {
  const info = await stat(file).catch(() => null);
  if (info) console.log(`  本地文件 ${file}  ${KB(info.size)}`);
}
console.log("");

for (const file of images) {
  const info = await stat(file).catch(() => null);
  if (!info) continue;
  await measure(`read_image ${path.basename(file)}（本地 ${KB(info.size)}）`, "read_image", { path: file }, "quiet");
}

console.log("");
console.log("=".repeat(76));
console.log("三、边界：上限是多少");
console.log("=".repeat(76));
await measure("read_files 读图片（按文本读，会读成乱码）", "read_files", { paths: ["dist/smoke-window.png"] }, "quiet");
await measure("read_image 读一个不存在的图", "read_image", { path: "no-such-file.png" }, "quiet");

/* ---------- 汇总 ---------- */
console.log("");
console.log("=".repeat(76));
console.log("汇总");
console.log("=".repeat(76));
console.log(`  ${"操作".padEnd(42)} ${"响应字节".padStart(12)}`);
console.log(`  ${"-".repeat(42)} ${"-".repeat(12)}`);
let totalSmall = 0, smallCount = 0;
for (const r of results) {
  if (r.error) { console.log(`  ${r.label.slice(0, 42).padEnd(42)} ${"失败".padStart(12)}`); continue; }
  console.log(`  ${r.label.slice(0, 42).padEnd(42)} ${KB(r.bytes).padStart(12)}`);
  if (!/read_image|截图|读图片/.test(r.label) && !r.isError) { totalSmall += r.bytes; smallCount++; }
}
console.log("");
console.log(`  小操作平均：${KB(Math.round(totalSmall / Math.max(1, smallCount)))}（${smallCount} 个样本）`);
console.log("");
console.log("  注意：上面是**响应体**的字节。隧道还要搬请求体（很小，几百字节）+ TLS/HTTP 头开销。");

/* ---------- 断言：别让哪个工具偷偷返回一大堆数据 ---------- */
/*
 * 为什么要断言：
 *   工具响应大小直接决定用户的流量账单（ngrok 免费版 1GB/月）。
 *   有人不小心让某个工具返回整个文件、或者忘了截断搜索结果，
 *   用户那边就是「莫名其妙流量超了」，而且完全看不出原因。
 *   所以把「单次响应不超过 512 KB」定成硬约束。
 */
const avgSmall = Math.round(totalSmall / Math.max(1, smallCount));
const LIMIT = 512 * 1024;
const oversized = results.filter((r) => !r.error && r.bytes > LIMIT);

console.log("");
console.log("=".repeat(76));
const errored = results.filter((r) => r.error);
if (oversized.length) {
  console.log(`失败：有 ${oversized.length} 个操作的响应超过 ${KB(LIMIT)}`);
  for (const r of oversized) console.log(`  ${r.label}  ${KB(r.bytes)}`);
  process.exit(1);
} else if (errored.length) {
  console.log(`失败：有 ${errored.length} 个操作报错`);
  for (const r of errored) console.log(`  ${r.label}  ${r.error}`);
  process.exit(1);
} else if (avgSmall > 64 * 1024) {
  console.log(`失败：小操作平均 ${KB(avgSmall)} 偏大（应低于 64 KB）`);
  process.exit(1);
}

console.log(`通过 ${results.length}/${results.length}`);
console.log(`单次响应都在 ${KB(LIMIT)} 以内，小操作平均 ${KB(avgSmall)}。`);
console.log("");
console.log("  对照 ngrok 免费版额度（1 GB / 20000 请求 每月）：");
console.log(`    纯小操作：约 ${Math.round((1024 * 1024 * 1024) / avgSmall).toLocaleString()} 次`);
console.log(`    纯截图：  约 ${Math.round((1024 * 1024 * 1024) / (175 * 1024)).toLocaleString()} 张`);
console.log(`    请求数上限折算：每天 ${Math.round(20000 / 30)} 次调用 —— 正常用是它先撞上，不是流量`);
process.exit(0);
