/**
 * 工具 meta（耗时 / 输出 token 估算）与会话统计的单元测试。
 *   node --test src/core/tool-meta.test.js
 *
 * 覆盖：
 *   ① estimateApproxTokens / countChars：中文按字、英文约 4 字符 1 token、空白不算；
 *      日文假名 / 谚文也按字算；图片按张数单独估；
 *   ② 会话累计：调用次数 / 总耗时 / 总输出 token，输出最多的 5 个工具按 token 排序；
 *      未知工具 / 被拒绝的调用只计次数、不建明细、不计输出；明细条数有上限；
 *   ③ 真起 BridgeServer：page_snapshot 返回 structuredContent.meta；只有文本的工具在末尾补 [meta …]；
 *      非 page_/browser_ 工具不带 meta；session_stats 的计数只属于当前 MCP 会话；
 *      未知工具刷不掉 session_stats；截图类输出算进 token；
 *   ④ 现有调用日志里有 meta 摘要，且不含网页正文；windrise_logs 的 tool-meta 事件同样不吐内容；
 *      meta 字段缺失时日志里是 null 而不是 0。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeServer } from "./bridge.js";
import { createCallLog, numOrNull } from "./call-log.js";
import { registerTool, unregisterTool } from "./registry.js";
import {
  attachToolMeta,
  countChars,
  countImages,
  createSessionMetrics,
  estimateApproxTokens,
  formatMetaLine,
  isMetaTool,
  OTHER_TOOL,
  TOOL_DETAIL_LIMIT,
} from "./session-metrics.js";

/* ------------------------------------------------------------------ *
 * ① 估算函数
 * ------------------------------------------------------------------ */

test("countChars 按 Unicode 码点数字符（emoji 不算两个）", () => {
  assert.equal(countChars(""), 0);
  assert.equal(countChars("中文a"), 3);
  assert.equal(countChars("a😀中"), 3);
});

test("estimateApproxTokens：中文按字，英文按 4 字符约 1 token，空白不算", () => {
  assert.equal(estimateApproxTokens(""), 0);
  assert.equal(estimateApproxTokens("abcdefgh"), 2);
  assert.equal(estimateApproxTokens("a"), 1);
  assert.equal(estimateApproxTokens("hello world"), 3);
  assert.equal(estimateApproxTokens("你好世界"), 4);
  assert.equal(estimateApproxTokens("中文，测试"), 5);
  assert.equal(estimateApproxTokens("你好 world"), 4);
});

test("只给 page_* / browser_* 加 meta", () => {
  assert.equal(isMetaTool("page_snapshot"), true);
  assert.equal(isMetaTool("browser_click"), true);
  assert.equal(isMetaTool("read_files"), false);
  assert.equal(isMetaTool("extension_sync"), false);
});

test("日文假名 / 谚文也按字估 token（不再被当成 4 字符 1 token）", () => {
  // 假名：以前走 other/4，5 个字只算 2
  assert.equal(estimateApproxTokens("こんにちは"), 5);
  assert.equal(estimateApproxTokens("カタカナ"), 4);
  assert.equal(estimateApproxTokens("안녕하세요"), 5);
  // 汉字仍然一字一 token，中英混排不受影响
  assert.equal(estimateApproxTokens("你好abc"), 3);
});

test("countImages 只数图片张数，不扫文本", () => {
  const images = countImages([
    { type: "text", text: "你好" },
    { type: "image", data: "A".repeat(100_000), mimeType: "image/png" },
    { type: "image", data: "B".repeat(10) },
  ]);
  assert.equal(images, 2);
  // 图片的 token 由 record() 按张数补上
  const metrics = createSessionMetrics();
  const textOnly = metrics.record({ sessionId: "s", tool: "browser_screenshot", ms: 5, text: "你好" });
  const withImages = metrics.record({ sessionId: "s", tool: "browser_screenshot", ms: 5, text: "你好", imageCount: images });
  assert.ok(withImages.approx_tokens >= textOnly.approx_tokens + 2000, "两张图必须明显更贵");
  assert.equal(JSON.stringify(images).includes("AAAA"), false, "不能把图片数据带出来");
});

test("countImages 不读文本内容（大文本不再为了数图片多扫一遍）", () => {
  const textPart = { type: "text" };
  Object.defineProperty(textPart, "text", { get() { throw new Error("不该读文本"); } });
  assert.equal(countImages([textPart, { type: "image", data: "x" }]), 1);
});

test("session_stats 的 meta 行：有图片时多一个 images 字段", () => {
  assert.equal(formatMetaLine({ action_id: 1, ms: 5, out_chars: 3, approx_tokens: 2 }), "[meta action=1 ms=5 out=3 tokens=2]");
  assert.match(formatMetaLine({ action_id: 1, ms: 5, out_chars: 3, approx_tokens: 1202, images: 1 }), /tokens=1202 images=1/);
});

/* ------------------------------------------------------------------ *
 * ② 会话累计
 * ------------------------------------------------------------------ */

test("按会话累计调用次数、耗时和输出 token，并给出输出最多的 5 个工具", () => {
  const metrics = createSessionMetrics();
  const first = metrics.record({ sessionId: "s1", tool: "page_snapshot", ms: 10, text: "你好world" });
  assert.deepEqual(first, { action_id: 1, ms: 10, out_chars: 7, approx_tokens: 4 });

  const second = metrics.record({ sessionId: "s1", tool: "browser_click", ms: 20, text: "ok" });
  assert.equal(second.action_id, 2);
  metrics.record({ sessionId: "s1", tool: "read_files", ms: 30, text: "abcdefgh" });

  const stats = metrics.stats("s1");
  assert.equal(stats.session_id, "s1");
  assert.equal(stats.calls, 3);
  assert.equal(stats.total_ms, 60);
  assert.equal(stats.out_chars, 7 + 2 + 8);
  assert.equal(stats.approx_tokens, 4 + 1 + 2);
  assert.equal(stats.top_tools[0].tool, "page_snapshot");
  assert.equal(stats.top_tools[0].approx_tokens, 4);

  const other = metrics.stats("s2");
  assert.equal(other.calls, 0);
  assert.deepEqual(other.top_tools, []);
});

test("action_id 只给带 meta 的工具自增：普通工具 / 未知工具 / 被拒调用都不占号", () => {
  const metrics = createSessionMetrics();
  assert.equal(metrics.record({ sessionId: "s", tool: "page_snapshot", ms: 1, text: "a" }).action_id, 1);
  // 非 page_/browser_ 的正常工具：算调用次数，但不推进 action_id
  metrics.record({ sessionId: "s", tool: "read_files", ms: 1, text: "b" });
  // 未知工具 / 被拒调用：detail:false，同样不占号
  metrics.record({ sessionId: "s", tool: "read_result", ms: 1, text: "", detail: false });
  metrics.record({ sessionId: "s", tool: "xzzzzz", ms: 1, text: "未知工具：xzzzzz", detail: false });
  assert.equal(metrics.record({ sessionId: "s", tool: "browser_click", ms: 1, text: "c" }).action_id, 2, "下一次带 meta 的调用要接着 #1");
  const stats = metrics.stats("s");
  assert.equal(stats.calls, 5, "调用次数仍然如实累计（含未知 / 被拒）");
});

test("top_tools 最多 5 个，按输出 token 从多到少", () => {
  const metrics = createSessionMetrics();
  for (let index = 0; index < 7; index += 1) {
    metrics.record({ sessionId: "s", tool: `tool_${index}`, ms: index, text: "字".repeat(index + 1) });
  }
  const stats = metrics.stats("s");
  assert.equal(stats.top_tools.length, 5);
  assert.deepEqual(stats.top_tools.map(row => row.approx_tokens), [7, 6, 5, 4, 3]);
});

test("cached 只在明确给出布尔值时出现在 meta 里", () => {
  const metrics = createSessionMetrics();
  assert.equal("cached" in metrics.record({ sessionId: "s", tool: "page_x", ms: 1, text: "a" }), false);
  assert.equal(metrics.record({ sessionId: "s", tool: "page_x", ms: 1, text: "a", cached: true }).cached, true);
});

test("detail:false（未知工具 / 拒绝）只计调用次数，不建明细、不计输出", () => {
  const metrics = createSessionMetrics();
  metrics.record({ sessionId: "s", tool: "page_read", ms: 5, text: "正文" });
  // 远端拿随机名字刷未知工具：错误返回里带着整张工具清单，这些字不能算成输出
  for (let index = 0; index < 50; index += 1) {
    const meta = metrics.record({ sessionId: "s", tool: `x${index}`, ms: 1, text: "未知工具：x。可用工具：a, b, c", detail: false });
    assert.equal(meta.out_chars, 0);
    assert.equal(meta.approx_tokens, 0);
  }
  const stats = metrics.stats("s");
  assert.equal(stats.calls, 51, "调用次数照常累计");
  assert.equal(stats.total_ms, 55);
  assert.equal(stats.out_chars, 2, "只有真实工具的正文计入输出");
  assert.deepEqual(stats.top_tools.map((row) => row.tool), ["page_read"], "假工具名不该出现在明细里");
});

test("单个会话的工具明细有上限，超出统一归到 (other)，内存不会被随机名字撑大", () => {
  const metrics = createSessionMetrics({ maxTools: 8 });
  for (let index = 0; index < 500; index += 1) {
    metrics.record({ sessionId: "s", tool: `fake${index}`, ms: 1, text: "字" });
  }
  const stats = metrics.stats("s");
  assert.equal(stats.calls, 500);
  // 最多 toolLimit 条真名 + 1 条 (other)：这里 8 条真名、第 9 个名字开始归到 (other)
  const other = stats.top_tools.find((row) => row.tool === OTHER_TOOL);
  assert.equal(other.calls, 492);
  assert.equal(stats.top_tools.length, 5, "top_tools 仍然最多 5 条");
  // 总调用次数不会因为汇总丢：8 条真名明细 + 492 次记在 (other) 上
  const otherRow = stats.top_tools.find((row) => row.tool === OTHER_TOOL);
  assert.equal(otherRow.calls, 492);
  assert.ok(TOOL_DETAIL_LIMIT >= 8);
});

test("超长工具名只留短前缀，不整段驻留内存", () => {
  const metrics = createSessionMetrics();
  const longName = `page_${"a".repeat(10_000)}`;
  metrics.record({ sessionId: "s", tool: longName, ms: 1, text: "x" });
  const [row] = metrics.stats("s").top_tools;
  assert.ok(row.tool.length <= 66, `工具名应该被截断，实际 ${row.tool.length} 字`);
  assert.ok(row.tool.startsWith("page_aaa"));
});

test("图片输出计入 token 与张数（截图不再被当成几乎免费）", () => {
  const metrics = createSessionMetrics();
  const text = metrics.record({ sessionId: "s", tool: "browser_screenshot", ms: 5, text: "截图完成" });
  const shot = metrics.record({ sessionId: "s", tool: "browser_screenshot", ms: 5, text: "截图完成", imageCount: 1 });
  assert.ok(shot.approx_tokens > text.approx_tokens, "带一张图必须比不带贵");
  assert.equal(shot.images, 1);
  const stats = metrics.stats("s");
  assert.equal(stats.images, 1);
  assert.equal(stats.top_tools[0].images, 1);
  assert.ok(stats.approx_tokens > 1000, "一张图至少按千级 token 估");
});

test("attachToolMeta：结构化结果放 structuredContent.meta，只有文本时末尾补一行", () => {
  const structured = attachToolMeta({ content: [{ type: "text", text: "正文" }], structuredContent: { title: "标题" } }, { action_id: 1, ms: 2, out_chars: 2, approx_tokens: 1 });
  assert.deepEqual(structured.structuredContent.title, "标题");
  assert.equal(structured.structuredContent.meta.action_id, 1);

  const textOnly = attachToolMeta({ content: [{ type: "text", text: "只有正文" }] }, { action_id: 2, ms: 3, out_chars: 4, approx_tokens: 1 });
  assert.match(textOnly.content[0].text, /只有正文\n\[meta /);
  assert.equal(formatMetaLine({ action_id: 2, ms: 3, out_chars: 4, approx_tokens: 1, cached: true }).endsWith(" cached]"), true);
});

/* ------------------------------------------------------------------ *
 * ③ 真起 BridgeServer 的集成测试
 * ------------------------------------------------------------------ */

const FIXTURES = [
  {
    name: "page_snapshot",
    capability: "read",
    handler: async () => ({
      content: [{ type: "text", text: "标题：演示页面\n- button \"发送\" [ref=e1]" }],
      structuredContent: { title: "演示页面", text: "标题：演示页面\n- button \"发送\" [ref=e1]" },
    }),
  },
  {
    name: "browser_cache_demo",
    capability: "read",
    handler: async () => ({ content: [{ type: "text", text: "缓存结果" }], structuredContent: { cached: true, value: "ok" } }),
  },
  {
    name: "browser_text_demo",
    capability: "read",
    handler: async () => ({ content: [{ type: "text", text: "只有文本" }] }),
  },
  {
    name: "browser_image_demo",
    capability: "read",
    // base64 用 "QUJD"（"ABC"）开头，方便断言图片数据没有漏进日志 / 事件
    handler: async () => ({
      content: [{ type: "text", text: "截图完成" }, { type: "image", data: "QUJDREVG", mimeType: "image/png" }],
      structuredContent: { ok: true },
    }),
  },
  {
    name: "other_tool",
    capability: "read",
    handler: async () => ({ content: [{ type: "text", text: "普通工具输出" }], structuredContent: { ok: true } }),
  },
];

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-meta-test", version: "1" } };

async function readMcp(response) {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json();
  const text = await response.text();
  const lines = text.split(/\r?\n/).filter(line => line.startsWith("data:"));
  return lines.length ? JSON.parse(lines[lines.length - 1].slice(5)) : JSON.parse(text);
}

function createClient(url) {
  let sid = null;
  let id = 0;
  const post = async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!sid) sid = response.headers.get("mcp-session-id");
    return readMcp(response);
  };
  return {
    initialize: () => post("initialize", initParams),
    list: async () => (await post("tools/list", {}))?.result?.tools ?? [],
    call: async (name, args = {}) => (await post("tools/call", { name, arguments: args }))?.result ?? null,
  };
}

function waitForLog(dir, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const names = readdirSync(dir).filter(name => /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
        const rows = [];
        for (const name of names) {
          for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
            if (!line.trim()) continue;
            try { rows.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
          }
        }
        const hit = rows.find(predicate);
        if (hit) return resolve(hit);
      } catch { /* 目录还没建好，继续等 */ }
      if (Date.now() > deadline) return reject(new Error("等待调用日志超时"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("page_snapshot 返回带 meta，session_stats 按会话累计，日志只有数字不含网页正文", async () => {
  for (const fixture of FIXTURES) {
    registerTool({ title: fixture.name, description: "工具 meta 单测用的假工具", ...fixture });
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "tool-meta-"));
  const activity = [];
  const server = new BridgeServer({ routeToken: "tool-meta-test-token", dataHome: home, port: 0, jsonResponse: true, onActivity: (event) => activity.push(event) });
  await server.start();
  try {
    const first = createClient(server.localUrl);
    await first.initialize();
    const names = (await first.list()).map(tool => tool.name);
    assert.ok(names.includes("session_stats"));
    assert.ok(names.includes("read_result"));

    const before = await first.call("session_stats");
    assert.equal(before.structuredContent.calls, 0);

    const snapshot = await first.call("page_snapshot", { id: "p1" });
    assert.equal(snapshot.structuredContent.title, "演示页面");
    const meta = snapshot.structuredContent.meta;
    assert.ok(meta, "page_snapshot 的结构化结果里应有 meta");
    assert.equal(meta.action_id, 1);
    assert.ok(Number.isFinite(meta.ms) && meta.ms >= 0);
    assert.equal(meta.out_chars, countChars("标题：演示页面\n- button \"发送\" [ref=e1]"));
    assert.ok(meta.approx_tokens > 0);
    assert.equal("cached" in meta, false);

    // 调一次 page_snapshot 后，session_stats 的调用次数正好加一
    const afterSnapshot = await first.call("session_stats");
    assert.equal(afterSnapshot.structuredContent.calls, 1);
    assert.equal(afterSnapshot.structuredContent.top_tools[0].tool, "page_snapshot");

    const cached = await first.call("browser_cache_demo");
    assert.equal(cached.structuredContent.meta.action_id, 2);
    assert.equal(cached.structuredContent.meta.cached, true);
    assert.equal(cached.structuredContent.cached, true);

    const plain = await first.call("other_tool");
    assert.equal("meta" in plain.structuredContent, false);

    const textOnly = await first.call("browser_text_demo");
    assert.match(textOnly.content[0].text, /^只有文本\n\[meta action=3 /);

    // 截图：返回里有 image part，图片不计字数但要计 token 和张数
    const shot = await first.call("browser_image_demo");
    assert.equal(shot.content[1].type, "image");
    assert.equal(shot.structuredContent.meta.action_id, 4);
    assert.equal(shot.structuredContent.meta.images, 1);
    assert.ok(shot.structuredContent.meta.approx_tokens > 1000, "一张图要按千级 token 估");

    const stats = await first.call("session_stats");
    assert.equal(stats.structuredContent.calls, 5);
    assert.ok(stats.structuredContent.total_ms >= 0);
    assert.ok(stats.structuredContent.approx_tokens > 0);
    assert.equal(stats.structuredContent.images, 1);
    assert.equal(stats.structuredContent.top_tools.length <= 5, true);
    assert.ok(stats.structuredContent.top_tools.some(row => row.tool === "page_snapshot"));
    assert.match(stats.content[0].text, /本会话工具调用 5 次/);

    // 远端拿随机名字刷未知工具：只计次数，不进明细、不计输出，top_tools 不被假名字刷满
    for (let index = 0; index < 40; index += 1) {
      const bogus = await first.call(`x${index}_${"z".repeat(2000)}`);
      assert.equal(bogus === null || bogus.isError === true, true);
    }
    const afterBogus = await first.call("session_stats");
    assert.equal(afterBogus.structuredContent.calls, 45);
    assert.equal(afterBogus.structuredContent.out_chars, stats.structuredContent.out_chars, "未知工具的错误清单不能算成输出");
    assert.equal(afterBogus.structuredContent.approx_tokens, stats.structuredContent.approx_tokens);
    assert.equal(afterBogus.structuredContent.top_tools.some(row => /^x\d+_/.test(row.tool)), false);

    // 另一个 MCP 会话从 0 开始，不会看到前一个会话的累计
    const second = createClient(server.localUrl);
    await second.initialize();
    const empty = await second.call("session_stats");
    assert.equal(empty.structuredContent.calls, 0);
    assert.deepEqual(empty.structuredContent.top_tools, []);

    // 现有调用日志：meta 只记数字；网页正文（"发送" / "演示页面"）不进日志
    const logRow = await waitForLog(path.join(home, "logs"), row => row.tool === "page_snapshot");
    assert.equal(logRow.meta.action_id, 1);
    assert.ok(logRow.meta.out_chars > 0);
    assert.ok(logRow.meta.approx_tokens > 0);
    assert.equal(JSON.stringify(logRow).includes("发送"), false);
    assert.equal(JSON.stringify(logRow).includes("演示页面"), false);

    // 截图那条日志：图片数据一个字都不进日志，只有张数
    const shotRow = await waitForLog(path.join(home, "logs"), row => row.tool === "browser_image_demo");
    assert.equal(shotRow.meta.images, 1);
    assert.equal(JSON.stringify(shotRow).includes("QUJD"), false, "图片 base64 不能进日志");

    // window.windrise_logs 的事件摘要：只有数字和工具名，不含网页内容
    const metaEvents = activity.filter(event => event.kind === "tool-meta");
    assert.ok(metaEvents.length >= 2);
    assert.equal(metaEvents[0].meta.tool, "page_snapshot");
    assert.equal(metaEvents[0].meta.action_id, 1);
    assert.ok(Number.isFinite(metaEvents[0].meta.ms));
    assert.equal(JSON.stringify(metaEvents).includes("发送"), false);
    assert.equal(JSON.stringify(metaEvents).includes("QUJD"), false);
  } finally {
    await server.stop();
    // 调用日志是排队异步写的：等它落完盘再删临时目录，避免 ENOENT 噪音
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const fixture of FIXTURES) unregisterTool(fixture.name);
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 清理失败无所谓 */ }
  }
});

/* ------------------------------------------------------------------ *
 * ④ read_result / 未知工具 / 被拒调用不推高 action_id
 * ------------------------------------------------------------------ */

test("read_result 与未知工具不占 action_id，桥自带工具也不进会话统计", { timeout: 20000 }, async () => {
  const fixture = FIXTURES.find((item) => item.name === "page_snapshot");
  registerTool({ title: fixture.name, description: "工具 meta 单测用的假工具", ...fixture });
  const home = mkdtempSync(path.join(os.tmpdir(), "tool-meta-action-"));
  const server = new BridgeServer({ routeToken: "tool-meta-action-token", dataHome: home, port: 0, jsonResponse: true });
  await server.start();
  try {
    const client = createClient(server.localUrl);
    await client.initialize();

    const first = await client.call("page_snapshot", { id: "p1" });
    assert.equal(first.structuredContent.meta.action_id, 1);

    // read_result：不存在的句柄。它是桥自带工具，不进统计、不占号（返回本身也没有 meta）
    const missing = await client.call("read_result", { handle: "nonexistent-handle" });
    assert.equal(missing.isError, true);
    assert.equal("meta" in (missing.structuredContent ?? {}), false);

    // 未知工具：算一次调用（审计要看得到有人乱试），但同样不占 action_id
    const bogus = await client.call("xzzzzz_not_a_tool");
    assert.equal(bogus.isError, true);

    const second = await client.call("page_snapshot", { id: "p2" });
    assert.equal(second.structuredContent.meta.action_id, 2, "未知工具 / read_result 不能把编号顶到 4");

    const stats = await client.call("session_stats");
    assert.equal(stats.structuredContent.calls, 3, "两次 page_snapshot + 一次未知工具；read_result 不算");
    assert.deepEqual(stats.structuredContent.top_tools.map((row) => row.tool), ["page_snapshot"]);
  } finally {
    await server.stop();
    unregisterTool(fixture.name);
    // 调用日志是排队异步写的：等它落完盘再删临时目录，避免 ENOENT 噪音
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 清理失败无所谓 */ }
  }
});

/* ------------------------------------------------------------------ *
 * ⑤ 调用日志里的 meta 数字：缺失必须是 null，不能写成 0
 * ------------------------------------------------------------------ */

test("numOrNull：undefined / null / 空串都记 null，不再被 Number() 变成 0", () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull("abc"), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull("12"), 12);
  assert.equal(numOrNull(3.5), 3.5);
});

test("调用日志的 meta 字段缺失时落盘是 null 而不是 0", async () => {  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-meta-log-"));
  try {
    const log = createCallLog({ dir });
    // 只有 action_id，其余字段缺失（以后给 meta 加可选字段时就是这种情形）
    await log.record({ tool: "page_snapshot", durationMs: null, resultBytes: "", meta: { action_id: 3 } });
    const row = await waitForLog(dir, item => item.tool === "page_snapshot");
    assert.equal(row.meta.action_id, 3);
    assert.equal(row.meta.ms, null, "缺失的 ms 不能记成 0");
    assert.equal(row.meta.out_chars, null);
    assert.equal(row.meta.approx_tokens, null);
    assert.equal("images" in row.meta, false, "没有图片就不写 images");
    assert.equal(row.durationMs, null);
    assert.equal(row.resultBytes, null);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 清理失败无所谓 */ }
  }
});