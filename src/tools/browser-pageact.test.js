/**
 * page_act 的 MCP 侧（src/tools/browser.js）：批量正文和错误字段不能再被这一层丢掉。
 *   node --test src/tools/browser-pageact.test.js
 *
 * 用本地假控制服务 + 临时 BRIDGE_DATA_HOME（os.tmpdir()，本仓库下就是 .tmp/），
 * 不碰真浏览器、不读写用户目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataHome = mkdtempSync(path.join(os.tmpdir(), "windrise-browser-tool-"));
process.env.BRIDGE_DATA_HOME = dataHome;

/** 假控制服务：/status 永远活着，page/act 按 reply 原样回 */
function fakeControl(reply) {
  const state = { posts: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (String(req.url).endsWith("/status")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: {} }));
      return;
    }
    state.posts.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(reply));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      writeFileSync(path.join(dataHome, "browser-control.json"), JSON.stringify({
        url: `http://127.0.0.1:${port}/control/test-token`,
        pid: process.pid,
        startedAt: Date.now(),
      }), "utf8");
      resolve({ server, state, port });
    });
  });
}

function cleanup(...servers) {
  for (const server of servers) { try { server?.close(); } catch { /* 已经关了 */ } }
}

mkdirSync(dataHome, { recursive: true });
test.after(() => {
  try { rmSync(dataHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test("MCP page_act 批量正文：读回确认失败的项写「已点选」，不冒充「已选择」", async () => {
  const { server } = await fakeControl({
    ok: true,
    result: {
      batch: true,
      total: 2,
      filled: 1,
      skipped: 1,
      failed: 0,
      aborted: 0,
      unverified: 1,
      outcome: "dispatched",
      diff: null,
      fields: [
        { ref: "e1", ok: true, action: "type", target: "姓名" },
        {
          ref: "e2", ok: true, action: "select", selected: "上海", target: "城市",
          verified: false, dispatched: true,
        },
        { ref: "e3", ok: true, action: "select", selected: "香蕉", target: "水果", skipped: "already_in_state" },
      ],
    },
  });
  try {
    const { defineBrowserTools } = await import("../tools/browser.js");
    const tool = defineBrowserTools().find((item) => item.name === "page_act");
    const answer = await tool.handler({ id: "1", fields: [{ ref: "e1", value: "张三" }, { ref: "e2", value: "上海" }] });
    const text = answer.content?.[0]?.text ?? "";
    assert.match(text, /已点选「上海」/);
    assert.match(text, /没能读回确认/);
    assert.doesNotMatch(text, /已选择「上海」/, "没读回确认不能说成已选择");
    assert.match(text, /结果：dispatched/);
    assert.equal(answer.structuredContent?.unverified, 1);
    assert.equal(answer.structuredContent?.fields?.length, 3);
  } finally {
    cleanup(server);
  }
});

test("MCP page_act 错误：options / fields / aborted 原样进 structuredContent（修前被 callControl 白名单丢掉）", async () => {
  const { server } = await fakeControl({
    ok: false,
    code: "OPTION_NOT_FOUND",
    error: "选项里没有「榴莲」，可选：苹果、香蕉",
    options: [{ value: "apple", label: "苹果" }, { value: "banana", label: "香蕉" }],
    optionsTotal: 2,
    optionsTruncated: false,
    retryable: true,
  });
  try {
    const { defineBrowserTools } = await import("../tools/browser.js");
    const tool = defineBrowserTools().find((item) => item.name === "page_act");
    const answer = await tool.handler({ id: "1", ref: "e2", action: "select", value: "榴莲" });
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent?.code, "OPTION_NOT_FOUND");
    assert.deepEqual(answer.structuredContent?.options?.map((option) => option.value), ["apple", "banana"]);
    assert.equal(answer.structuredContent?.optionsTotal, 2);
    assert.match(answer.structuredContent?.next_step ?? "", /options/);
  } finally {
    cleanup(server);
  }
});

test("MCP page_act 中止错误：fields / filled / aborted 带得回来", async () => {
  const { server } = await fakeControl({
    ok: false,
    code: "TASK_STOPPED",
    error: "这个标签页的任务被用户终止了",
    filled: 1,
    aborted: 2,
    total: 3,
    fields: [
      { ref: "e1", ok: true, action: "type" },
      { ref: "e2", ok: false, skipped: "batch_aborted", code: "TASK_STOPPED", error: "任务被终止" },
      { ref: "e3", ok: false, skipped: "batch_aborted", code: "TASK_STOPPED", error: "任务被终止" },
    ],
  });
  try {
    const { defineBrowserTools } = await import("../tools/browser.js");
    const tool = defineBrowserTools().find((item) => item.name === "page_act");
    const answer = await tool.handler({ id: "1", fields: [{ ref: "e1", value: "a" }, { ref: "e2", value: "b" }] });
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent?.code, "TASK_STOPPED");
    assert.equal(answer.structuredContent?.filled, 1);
    assert.equal(answer.structuredContent?.aborted, 2);
    assert.equal(answer.structuredContent?.fields?.length, 3);
    assert.equal(answer.structuredContent?.fields?.[1]?.skipped, "batch_aborted");
  } finally {
    cleanup(server);
  }
});