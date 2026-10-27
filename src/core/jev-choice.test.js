/**
 * page_choose / Jev 选元素的单元测试（纯 Node，假 fetch，不访问真实网络）：
 *   node --test src/core/jev-choice.test.js
 *
 * 覆盖：
 *   ① 候选抽取：只认带 [ref=eN] 的行、去掉列表符号和编号、保留提示名、同编号去重；
 *   ② 候选上限：超过 255 截断，截断发生在发给 Jev 的请求里；
 *   ③ ratio 计算：第一名 / 第二名、阈值决定 decided、只有一个候选时没得挑；
 *   ④ 没配 TYPESAFE_API_KEY 报 JEV_UNAVAILABLE，而且根本不发请求；
 *   ⑤ 密钥不出现在任何输出里：网络错误、上游回显、工具返回正文与 structuredContent 都不带；
 *   ⑥ page_choose 工具层：选中的 ref / 第二名 / next_step / 错误码，decided=false 的下一步文案。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JEV_ENDPOINT,
  JEV_MAX_CRITERIA,
  askJev,
  decideFromAnswer,
  extractChoices,
  redactKey,
} from "./jev-choice.js";
import { defineBrowserTools } from "../tools/browser.js";

const KEY = "ts-test-SECRET-abc123";

const SNAPSHOT = [
  '- RootWebArea "创作者中心"',
  '  - button "发布" [ref=e1]',
  '  - button "存草稿" [ref=e2]',
  '  - link "English" [ref=e3]',
  '  - generic "封面"',
  '    - clickable [ref=e5] [cursor=pointer] (提示: 上传封面)',
].join("\n");

/** 假响应：只需要 ok / status / text()。 */
function fakeResponse(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { ok, status, async text() { return text; } };
}

/** 假 fetch：记下每次调用的 url / options，按 handler 返回。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function answerBody(choice, probabilities, usage = { input_tokens: 123 }) {
  return { answers: { target: { choice, probabilities } }, usage };
}

/* ================= 1. 候选抽取 ================= */

test("候选抽取：只认带编号的行，标签去掉列表符号和编号，保留提示名", () => {
  const choices = extractChoices(SNAPSHOT);
  assert.deepEqual(choices, [
    { ref: "e1", label: 'button "发布"' },
    { ref: "e2", label: 'button "存草稿"' },
    { ref: "e3", label: 'link "English"' },
    { ref: "e5", label: "clickable [cursor=pointer] (提示: 上传封面)" },
  ]);
});

test("候选抽取：同一编号重复出现只算一次（find 模式会带出祖先行）", () => {
  const text = ['- generic "卡片" [ref=e7]', '  - link "详情" [ref=e7]', '- button "下一步" [ref=e8]'].join("\n");
  assert.deepEqual(extractChoices(text).map((c) => c.ref), ["e7", "e8"]);
});

test("候选抽取：标签截到 160 字，空标签丢掉，没有编号的文字一行都不要", () => {
  const long = `- button "${"很长的名字".repeat(40)}" [ref=e1]`;
  const choices = extractChoices([long, '- generic "正文"', "- [ref=e2]", "- button \"好\" [ref=e3]"].join("\n"));
  assert.equal(choices.length, 2);
  assert.equal(choices[0].label.length, 160);
  assert.equal(choices[1].ref, "e3");
});

test(`候选抽取：超过 ${JEV_MAX_CRITERIA} 个截断，保留文档顺序`, () => {
  const text = Array.from({ length: JEV_MAX_CRITERIA + 45 }, (_, index) => `- button "按钮 ${index}" [ref=e${index + 1}]`).join("\n");
  const choices = extractChoices(text);
  assert.equal(choices.length, JEV_MAX_CRITERIA);
  assert.equal(choices.at(-1).ref, `e${JEV_MAX_CRITERIA}`);
});

/* ================= 2. ratio / decided ================= */

test("ratio：第一名概率 / 第二名概率，阈值决定 decided", () => {
  const picked = decideFromAnswer({ choice: "e1", probabilities: { e1: 0.6, e2: 0.3, e3: 0.1 } }, { minRatio: 3 });
  assert.equal(picked.ref, "e1");
  assert.equal(picked.confidence, 0.6);
  assert.equal(picked.ratio, 2);
  assert.deepEqual(picked.second, { ref: "e2", p: 0.3 });
  assert.equal(picked.decided, false);
  assert.equal(decideFromAnswer({ choice: "e1", probabilities: { e1: 0.6, e2: 0.3 } }, { minRatio: 2 }).decided, true);
});

test("ratio：只有一个候选时没有第二名，ratio 为 null，decided 为 true", () => {
  const picked = decideFromAnswer({ choice: "e9", probabilities: { e9: 1 } });
  assert.equal(picked.ratio, null);
  assert.equal(picked.second, null);
  assert.equal(picked.decided, true);
});

test("ratio：第二名概率为 0 时按 1e-6 兜底，不至于算出 Infinity", () => {
  const picked = decideFromAnswer({ choice: "e1", probabilities: { e1: 0.9, e2: 0 } }, { minRatio: 3 });
  assert.equal(picked.ratio, 900000);
  assert.equal(picked.decided, true);
});

test("ratio：返回里缺 choice / probabilities 时明确报 JEV_UNAVAILABLE", () => {
  for (const answer of [{}, { choice: "" }, { choice: "e1" }, { choice: "e1", probabilities: {} }]) {
    assert.throws(() => decideFromAnswer(answer), (error) => error.code === "JEV_UNAVAILABLE");
  }
});

/* ================= 3. 问 Jev ================= */

test("没配 TYPESAFE_API_KEY：报 JEV_UNAVAILABLE，一个请求都不发", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("不该发请求");
  });
  await assert.rejects(
    askJev({ intent: "点发布", choices: [{ ref: "e1", label: "button 发布" }], apiKey: "", fetchImpl }),
    (error) => error.code === "JEV_UNAVAILABLE" && /TYPESAFE_API_KEY/.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("超过 255 个候选：请求体里的 criteria 只带前 255 个，state 带任务描述", async () => {
  const choices = Array.from({ length: JEV_MAX_CRITERIA + 20 }, (_, index) => ({ ref: `e${index + 1}`, label: `按钮 ${index + 1}` }));
  const fetchImpl = fakeFetch(() => fakeResponse(answerBody("e1", { e1: 0.9, e2: 0.05 })));
  const result = await askJev({ intent: "点发布", choices, apiKey: KEY, fetchImpl });

  const request = fetchImpl.calls[0];
  assert.equal(request.url, JEV_ENDPOINT);
  assert.equal(request.options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "jev-1.14.0");
  assert.match(body.state, /点发布/);
  assert.equal(body.questions.target.type, "choice");
  assert.equal(Object.keys(body.questions.target.criteria).length, JEV_MAX_CRITERIA);
  assert.equal(body.questions.target.criteria.e255, "按钮 255");
  assert.equal(body.questions.target.criteria.e256, undefined);
  assert.equal(result.answer.choice, "e1");
  assert.equal(typeof result.latencyMs, "number");
  // 原样返回里也不能把密钥带出来
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("网络失败：报 JEV_UNAVAILABLE，错误消息里的密钥被抹掉", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error(`connect ECONNREFUSED (authorization: Bearer ${KEY})`);
  });
  await assert.rejects(
    askJev({ intent: "点发布", choices: [{ ref: "e1", label: "button 发布" }], apiKey: KEY, fetchImpl }),
    (error) => error.code === "JEV_UNAVAILABLE"
      && /连不上/.test(error.message)
      && !error.message.includes(KEY)
      && error.message.includes("[REDACTED]"),
  );
});

test("上游 HTTP 错误回显密钥：错误消息里同样抹掉", async () => {
  const fetchImpl = fakeFetch(() => fakeResponse(`invalid token ${KEY}`, { ok: false, status: 401 }));
  await assert.rejects(
    askJev({ intent: "点发布", choices: [{ ref: "e1", label: "button 发布" }], apiKey: KEY, fetchImpl }),
    (error) => error.code === "JEV_UNAVAILABLE" && /HTTP 401/.test(error.message) && !error.message.includes(KEY),
  );
});

test("返回不是 JSON / 没有 answers.target：都归一成 JEV_UNAVAILABLE", async () => {
  for (const payload of ["<html>502</html>", { ok: true }]) {
    const fetchImpl = fakeFetch(() => fakeResponse(payload));
    await assert.rejects(
      askJev({ intent: "点发布", choices: [{ ref: "e1", label: "button 发布" }], apiKey: KEY, fetchImpl }),
      (error) => error.code === "JEV_UNAVAILABLE",
    );
  }
});

test("redactKey：没有密钥时原样返回，有密钥时全部替换", () => {
  assert.equal(redactKey("abc", ""), "abc");
  assert.equal(redactKey(`x ${KEY} y ${KEY}`, KEY), "x [REDACTED] y [REDACTED]");
});

/* ================= 4. page_choose 工具层 ================= */

function chooseTool({ snapshotText = SNAPSHOT, env = { TYPESAFE_API_KEY: KEY }, fetchImpl } = {}) {
  const tools = defineBrowserTools({
    snapshot: async () => ({ text: snapshotText, url: "https://creator.example.com/publish", title: "创作者中心" }),
    fetchImpl,
    env,
  });
  return tools.find((tool) => tool.name === "page_choose");
}

test("page_choose：返回选中的 ref / 标签 / 第二名 / 耗时，并把下一步指向 page_act", async () => {
  const fetchImpl = fakeFetch(() => fakeResponse(answerBody("e1", { e1: 0.9, e2: 0.03, e3: 0.02 })));
  const tool = chooseTool({ fetchImpl });
  assert.equal(tool.capability, "read");

  const out = await tool.handler({ id: "2", intent: "点发布按钮" });
  const result = out.structuredContent;
  assert.equal(result.ref, "e1");
  assert.equal(result.label, 'button "发布"');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.ratio, 30);
  assert.deepEqual(result.second, { ref: "e2", label: 'button "存草稿"', p: 0.03 });
  assert.equal(result.decided, true);
  assert.equal(result.candidates, 4);
  assert.equal(typeof result.latencyMs, "number");
  assert.match(result.next_step, /page_act/);
  assert.match(out.content[0].text, /把握够/);
  // 密钥不进任何输出：正文、结构化返回都不许出现
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test("page_choose：把握不大时 decided 为 false，next_step 写「请自己看快照判断」", async () => {
  const fetchImpl = fakeFetch(() => fakeResponse(answerBody("e1", { e1: 0.4, e2: 0.35 })));
  const out = await chooseTool({ fetchImpl }).handler({ id: "2", intent: "点发布按钮" });
  assert.equal(out.structuredContent.decided, false);
  assert.equal(out.structuredContent.next_step, "把握不大，请自己看快照判断");
  assert.match(out.content[0].text, /把握不够/);
});

test("page_choose：minRatio 能调低阈值", async () => {
  const fetchImpl = fakeFetch(() => fakeResponse(answerBody("e1", { e1: 0.4, e2: 0.35 })));
  const out = await chooseTool({ fetchImpl }).handler({ id: "2", intent: "点发布按钮", minRatio: 1 });
  assert.equal(out.structuredContent.decided, true);
});

test("page_choose：selector / find 原样交给快照，缩掉候选范围", async () => {
  const seen = [];
  const tools = defineBrowserTools({
    snapshot: async (params) => {
      seen.push(params);
      return { text: '- button "发布" [ref=e1]', url: "https://creator.example.com/publish", title: "创作者中心" };
    },
    fetchImpl: fakeFetch(() => fakeResponse(answerBody("e1", { e1: 1 }))),
    env: { TYPESAFE_API_KEY: KEY },
  });
  const out = await tools.find((tool) => tool.name === "page_choose").handler({ id: "2", space: "工作", intent: "点发布", selector: "main", find: "发布" });
  assert.deepEqual(seen[0], { id: "2", space: "工作", selector: "main", find: "发布" });
  assert.equal(out.structuredContent.decided, true);
});

test("page_choose：没有密钥时报 JEV_UNAVAILABLE，不影响别的工具，且不发请求", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("不该发请求");
  });
  const out = await chooseTool({ env: {}, fetchImpl }).handler({ id: "2", intent: "点发布按钮" });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "JEV_UNAVAILABLE");
  assert.match(out.content[0].text, /page_snapshot/);
  assert.equal(fetchImpl.calls.length, 0);
  // 其他 page_* 工具照常在清单里
  const names = defineBrowserTools().map((tool) => tool.name);
  for (const name of ["page_snapshot", "page_act", "page_read", "page_choose"]) assert.ok(names.includes(name), name);
});

test("page_choose：快照里没有带编号的元素时报 NOT_FOUND，不去问 Jev", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("不该发请求");
  });
  const out = await chooseTool({ snapshotText: '- generic "空页面"', fetchImpl }).handler({ id: "2", intent: "点发布按钮" });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "NOT_FOUND");
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(out.content[0].text, /下一步/);
});

test("page_choose：缺 intent 时报 INVALID_ARGUMENT，不发快照也不发请求", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("不该发请求");
  });
  const out = await chooseTool({ fetchImpl }).handler({ id: "2", intent: "   " });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "INVALID_ARGUMENT");
  assert.equal(fetchImpl.calls.length, 0);
});
