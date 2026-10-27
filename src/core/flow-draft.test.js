/**
 * 流程草稿抽取的纯 Node 单测（不需要浏览器 / 不用起 Bridge）：
 *   node --test src/core/flow-draft.test.js
 *
 * 覆盖：
 *   ① 从 jsonl 抽出操作序列：只留成功步骤，failed / unknown 剔除；
 *   ② 「成功后又重试并失败」的那次成功也剔除；
 *   ③ 连续重复的快照读取合并成一步；
 *   ④ 脱敏：type 的输入值只留 {{varN}} + 长度，原文绝不出现在草稿里；URL 去掉 token / code / session / hash；
 *   ⑤ target 用可访问名，不用快照编号（e12 不能出现在草稿里）；
 *   ⑥ 落盘路径 flows/drafts/<site>/<时间戳>.json，flow_list_drafts 能列出来；
 *   ⑦ 多个会话时取最新的那次，空间过滤生效。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildFlowDraft,
  draftFromCalls,
  listFlowDrafts,
  parseBoundary,
  redactUrl,
  saveFlowDraft,
} from "./flow-draft.js";
import { defineFlowTools } from "../tools/flow.js";

/** 一行调用日志。字段和 core/call-log.js 完全对齐。 */
function line(overrides = {}) {
  return JSON.stringify({
    at: "2026-10-27T10:00:00.000Z",
    sessionId: "s1",
    client: { name: "test", version: "1" },
    connector: null,
    tool: "page_snapshot",
    args: {},
    ok: true,
    code: null,
    durationMs: 12,
    resultBytes: 100,
    stored: null,
    ...overrides,
  });
}

const FIXTURE = [
  // 开空间：没有 space 参数，但属于同一个会话，应该保留
  line({ at: "2026-10-27T10:00:01.000Z", tool: "space_open", args: { name: "ai-1" } }),
  // 跳转：token / code / session 必须被删掉，普通参数保留，hash 去掉
  line({
    at: "2026-10-27T10:00:02.000Z",
    tool: "browser_navigate",
    args: { id: "p1", space: "ai-1", url: "https://shop.example.com/orders?token=SECRET123&session_id=abc&code=xyz&page=2#frag" },
    actionClass: null,
    outcome: null,
    target: null,
  }),
  // 连续两次快照 → 合并成一步
  line({ at: "2026-10-27T10:00:03.000Z", tool: "page_snapshot", args: { id: "p1", space: "ai-1" }, actionClass: "READ" }),
  line({ at: "2026-10-27T10:00:04.000Z", tool: "page_snapshot", args: { id: "p1", space: "ai-1" }, actionClass: "READ" }),
  // 成功点击：target 用可访问名「搜索」，快照编号 e12 只在 args.ref 里
  line({
    at: "2026-10-27T10:00:05.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e12", action: "click", expect: "结果列表" },
    actionClass: "MUTATING",
    outcome: "dispatched",
    target: "搜索",
  }),
  // 输入：日志里已经是「[输入内容，3 字]」，原文（张三 + 手机号）只在旧日志里出现过
  line({
    at: "2026-10-27T10:00:06.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e14", action: "type", text: "张三13800001111" },
    actionClass: "MUTATING",
    outcome: "confirmed",
    target: "收货人",
  }),
  // 成功点击后同一目标又重试并失败 → 这次成功不算
  line({
    at: "2026-10-27T10:00:07.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e20", action: "click" },
    actionClass: "MUTATING",
    outcome: "dispatched",
    target: "提交订单",
  }),
  line({
    at: "2026-10-27T10:00:08.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e20", action: "click" },
    ok: false,
    actionClass: "MUTATING",
    outcome: "failed",
    target: "提交订单",
  }),
  // 纯失败 / unknown：都不进草稿
  line({
    at: "2026-10-27T10:00:09.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e30", action: "click" },
    ok: false,
    actionClass: "MUTATING",
    outcome: "failed",
    target: "失效按钮",
  }),
  line({
    at: "2026-10-27T10:00:10.000Z",
    tool: "page_act",
    args: { id: "p1", space: "ai-1", ref: "e31", action: "type", text: "[输入内容，6 字]" },
    ok: false,
    actionClass: "MUTATING",
    outcome: "unknown",
    target: "支付密码",
  }),
  // 别的空间：明确写了别的 space，必须剔除
  line({ at: "2026-10-27T10:00:11.000Z", tool: "page_snapshot", args: { id: "p1", space: "other" }, actionClass: "READ" }),
].join("\n");

async function makeLogDir(lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flow-draft-"));
  await mkdir(path.join(dir, "logs"), { recursive: true });
  await writeFile(path.join(dir, "logs", "mcp-calls-2026-10-27.jsonl"), `${lines}\n`, "utf8");
  return dir;
}

const NOW = new Date("2026-10-27T12:00:00.000Z");

test("从调用记录抽出步骤：成功留下、失败剔除、快照合并", async () => {
  const dataHome = await makeLogDir(FIXTURE);
  const { draft } = await buildFlowDraft({
    logDir: path.join(dataHome, "logs"),
    space: "ai-1",
    version: "9.9.9",
    now: NOW,
  });

  assert.equal(draft.source, "auto");
  assert.equal(draft.windrise_version, "9.9.9");
  assert.equal(draft.created_at, NOW.toISOString());
  assert.equal(draft.site, "shop.example.com");
  assert.equal(draft.name, "ai-1 流程");

  const targets = draft.steps.map((step) => step.target).filter(Boolean);
  assert.deepEqual(targets, ["搜索", "收货人"]);
  // 失败 / unknown / 失败重试的那次成功都不能出现
  for (const gone of ["提交订单", "失效按钮", "支付密码"]) {
    assert.ok(!targets.includes(gone), `${gone} 不该进草稿`);
  }

  // 连续两张快照合并成一张；space_open 和跳转各一步
  assert.equal(draft.steps.filter((step) => step.action === "snapshot").length, 1);
  assert.equal(draft.steps[0].tool, "space_open");
  assert.equal(draft.steps[1].tool, "browser_navigate");
  assert.equal(draft.steps[1].url_pattern, "https://shop.example.com/orders?page=2");
  // 后续步骤沿用最近一次已知地址
  assert.equal(draft.steps[2].url_pattern, "https://shop.example.com/orders?page=2");
  assert.equal(draft.steps[3].expect, "结果列表");
});

test("脱敏：输入值原文、快照编号、令牌参数都不出现在草稿里", async () => {
  const dataHome = await makeLogDir(FIXTURE);
  const { draft } = await buildFlowDraft({ logDir: path.join(dataHome, "logs"), space: "ai-1", now: NOW });
  const text = JSON.stringify(draft);

  for (const secret of ["张三13800001111", "SECRET123", "session_id=abc", "code=xyz", "#frag", "e12", "e14"]) {
    assert.ok(!text.includes(secret), `草稿里不该出现 ${secret}`);
  }
  // 变量只记名字 + 长度（原文 13 个字符）
  assert.deepEqual(draft.variables, [{ name: "var1", length: 13 }]);
  const typed = draft.steps.find((step) => step.action === "type");
  assert.equal(typed.value, "{{var1}}");
  assert.equal(typed.target, "收货人");
});

test("redactUrl：只删敏感参数，保留普通参数", () => {
  assert.equal(
    redactUrl("https://a.example.com/p?access_token=t&code=c&sid=s&state=x&keep=1#f"),
    "https://a.example.com/p?keep=1",
  );
  // 日志里被截断的 URL：先剥掉标记再脱敏
  assert.equal(
    redactUrl("https://a.example.com/p?token=t…（共 120 字）"),
    "https://a.example.com/p",
  );
  assert.equal(redactUrl(""), "");
});

test("落盘与列表：flows/drafts/<site>/<时间戳>.json", async () => {
  const dataHome = await makeLogDir(FIXTURE);
  const { draft } = await buildFlowDraft({ logDir: path.join(dataHome, "logs"), space: "ai-1", now: NOW });
  const { path: file } = await saveFlowDraft({ dataHome, draft });

  assert.equal(path.dirname(file), path.join(dataHome, "flows", "drafts", "shop.example.com"));
  assert.match(path.basename(file), /^2026-10-27T12-00-00-000Z\.json$/);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.steps.length, draft.steps.length);

  // 同一时间戳再存一次不覆盖
  const second = await saveFlowDraft({ dataHome, draft });
  assert.notEqual(second.path, file);
  assert.equal((await readdir(path.dirname(file))).length, 2);

  const listed = await listFlowDrafts({ dataHome });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].site, "shop.example.com");
  assert.equal(listed[0].steps, draft.steps.length);
  assert.equal(listed[0].variables, 1);
});

test("多会话：取最新的那次；时间边界按本地整天算", async () => {
  const lines = [
    line({ at: "2026-10-26T09:00:00.000Z", sessionId: "old", tool: "page_snapshot", args: { space: "ai-1" }, actionClass: "READ" }),
    line({ at: "2026-10-27T09:00:00.000Z", sessionId: "new", tool: "page_snapshot", args: { space: "ai-1" }, actionClass: "READ" }),
    line({ at: "2026-10-27T09:01:00.000Z", sessionId: "new", tool: "page_act", args: { space: "ai-1", action: "click" }, actionClass: "MUTATING", outcome: "confirmed", target: "下一步" }),
    line({ at: "2026-10-27T09:02:00.000Z", sessionId: "new", tool: "page_snapshot", args: { space: "ai-9" }, actionClass: "READ" }),
  ].join("\n");
  const dataHome = await makeLogDir(lines);
  const { draft, sessionCount } = await buildFlowDraft({
    logDir: path.join(dataHome, "logs"),
    space: "ai-1",
    since: "2026-10-27",
    until: "2026-10-27",
    now: NOW,
  });
  assert.equal(sessionCount, 1);
  assert.deepEqual(draft.steps.map((step) => step.target).filter(Boolean), ["下一步"]);
  assert.ok(draft.steps.every((step) => !JSON.stringify(step).includes("ai-9")));

  assert.equal(parseBoundary("2026-10-27"), new Date(2026, 9, 27, 0, 0, 0, 0).getTime());
  assert.equal(parseBoundary("2026-10-27", { endOfDay: true }), new Date(2026, 9, 27, 23, 59, 59, 999).getTime());
});

test("没有成功步骤时给出可照做的错误", () => {
  assert.throws(
    () => draftFromCalls({ entries: [{ tool: "page_act", ok: false, actionClass: "MUTATING", outcome: "failed", target: "提交" }], space: "ai-1", now: NOW }),
    (error) => error.code === "NO_CALLS" && /ai-1/.test(error.message),
  );
});

test("MCP 工具层：flow_save_draft + flow_list_drafts", async () => {
  const dataHome = await makeLogDir(FIXTURE);
  const tools = defineFlowTools({ dataHome });
  const save = tools.find((tool) => tool.name === "flow_save_draft");
  const list = tools.find((tool) => tool.name === "flow_list_drafts");

  const saved = await save.handler({ space: "ai-1", name: "下单流程" });
  assert.ok(!saved.isError, saved.content?.[0]?.text);
  assert.equal(saved.structuredContent.draft.name, "下单流程");
  assert.ok(saved.structuredContent.path.startsWith(path.join(dataHome, "flows", "drafts")));
  assert.ok(!JSON.stringify(saved.structuredContent.draft).includes("张三13800001111"));

  const listed = await list.handler({});
  assert.ok(!listed.isError);
  assert.equal(listed.structuredContent.drafts.length, 1);
  assert.equal(listed.structuredContent.drafts[0].name, "下单流程");

  const empty = await save.handler({ space: "不存在的空间" });
  assert.equal(empty.isError, true);
  assert.equal(empty.structuredContent.code, "NO_CALLS");
});
