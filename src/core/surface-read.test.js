/**
 * 读页面正文的两条修复（纯 Node，假 CDP）：
 *   node --test src/core/surface-read.test.js
 *
 * 覆盖：
 *   ① selector 一个都匹配不上时报 NOT_FOUND，报错里带页面地址、标题，并提示可能是没加载完；
 *   ② selector 匹配得上就照常读，last 读最后一块；
 *   ③ 读之前先等页面就绪：readyState 为 complete，或者 DOM 连续 300ms 没动，最长等 5 秒；
 *   ④ 等不到也不失败（返回 reason=timeout），交给上层的 NOT_FOUND 说清原因。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readSurfaceContent, waitForPageReady } from "./surface-snapshot.js";

const PAGE = { url: "https://en.wikipedia.org/wiki/Singapore", title: "Singapore - Wikipedia" };

/**
 * 假 CDP：按表达式分派。
 *   matches：querySelectorAll(...).length 的返回值
 *   content：正文脚本返回的内容
 *   readyStates：readyState 依次返回（用完就重复最后一个）
 */
function fakeCdp({ matches = 0, content = "正文", readyStates = ["complete"], lastAt = () => Date.now(), identity = PAGE } = {}) {
  const sent = [];
  let readyIndex = 0;
  return {
    sent,
    async send(method, params = {}) {
      sent.push({ method, params });
      const expression = String(params.expression ?? "");
      if (method !== "Runtime.evaluate") return { result: { value: null } };
      if (/querySelectorAll\(.*\)\.length/.test(expression)) return { result: { value: matches } };
      if (/location\.href/.test(expression)) return { result: { value: identity } };
      if (/readyState/.test(expression) && /__windriseQuiet/.test(expression)) {
        const state = readyStates[Math.min(readyIndex, readyStates.length - 1)];
        readyIndex += 1;
        return { result: { value: { readyState: state, mutations: 0, lastAt: lastAt() } } };
      }
      if (/readyState/.test(expression)) {
        const state = readyStates[Math.min(readyIndex, readyStates.length - 1)];
        readyIndex += 1;
        return { result: { value: { readyState: state, lastAt: lastAt() } } };
      }
      if (/DOM_WALKER|querySelector|document\.body/.test(expression)) return { result: { value: content } };
      return { result: { value: content } };
    },
  };
}

/* ---------------- ① selector 没命中：NOT_FOUND ---------------- */

test("readSurfaceContent：selector 0 个匹配时抛 NOT_FOUND，带地址、标题和「可能没加载完」", async () => {
  const cdp = fakeCdp({ matches: 0 });
  const error = await readSurfaceContent(cdp, { selector: "#mw-content-text .mw-parser-output > p" }).catch((caught) => caught);
  assert.equal(error.code, "NOT_FOUND");
  assert.match(error.message, /NOT_FOUND：选择器没匹配到任何元素/);
  assert.match(error.message, /#mw-content-text/);
  assert.match(error.message, /https:\/\/en\.wikipedia\.org\/wiki\/Singapore/);
  assert.match(error.message, /Singapore - Wikipedia/);
  assert.match(error.message, /还没加载完/);
  assert.equal(error.url, PAGE.url);
  assert.equal(error.title, PAGE.title);
});

test("readSurfaceContent：selector 0 个匹配时绝不静默返回空串", async () => {
  const cdp = fakeCdp({ matches: 0 });
  const result = await readSurfaceContent(cdp, { selector: ".nope" }).catch(() => "threw");
  assert.notEqual(result, "", "不能返回空字符串");
});

/* ---------------- ② 命中就照常读 ---------------- */

test("readSurfaceContent：selector 命中时照常读正文", async () => {
  const cdp = fakeCdp({ matches: 3, content: "第一段正文" });
  const text = await readSurfaceContent(cdp, { selector: "#mw-content-text" });
  assert.equal(text, "第一段正文");
});

test("readSurfaceContent：selector + last 读最后一块（先标最后那个元素）", async () => {
  const cdp = fakeCdp({ matches: 2, content: "最新一条回答" });
  const sent = [];
  const original = cdp.send.bind(cdp);
  cdp.send = async (method, params = {}) => {
    sent.push(params.expression ?? "");
    if (/setAttribute\("data-windrise-read"/.test(String(params.expression ?? ""))) return { result: { value: 2 } };
    if (/querySelectorAll\(.*\)\.length/.test(String(params.expression ?? ""))) return { result: { value: 2 } };
    return original(method, params);
  };
  const text = await readSurfaceContent(cdp, { selector: ".answer", last: true });
  assert.equal(text, "最新一条回答");
  assert.ok(sent.some((expression) => /data-windrise-read/.test(expression)), "应该给最后一个匹配打了临时属性");
  assert.ok(sent.some((expression) => /removeAttribute/.test(expression)), "读完要摘掉临时属性");
});

/* ---------------- ③ 读之前先等页面就绪 ---------------- */

test("waitForPageReady：readyState 已经是 complete 就立刻返回", async () => {
  const cdp = fakeCdp({ readyStates: ["complete"] });
  const started = Date.now();
  const result = await waitForPageReady(cdp, { timeoutMs: 5000, quietMs: 300 });
  assert.equal(result.reason, "complete");
  assert.ok(Date.now() - started < 200, "不该白等");
});

test("waitForPageReady：loading 但 DOM 已经安静 300ms → dom-quiet", async () => {
  const quietAt = Date.now() - 1000;
  const cdp = fakeCdp({ readyStates: ["loading"], lastAt: () => quietAt });
  const result = await waitForPageReady(cdp, { timeoutMs: 2000, quietMs: 300 });
  assert.equal(result.reason, "dom-quiet");
});

test("waitForPageReady：loading 且 DOM 一直在动 → 超时返回，不抛错", async () => {
  const cdp = fakeCdp({ readyStates: ["loading"], lastAt: () => Date.now() });
  const started = Date.now();
  const result = await waitForPageReady(cdp, { timeoutMs: 300, quietMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(result.reason, "timeout");
  assert.ok(elapsed >= 250, `应该真的等了（${elapsed}ms）`);
});

test("waitForPageReady：页面还在导航（evaluate 抛错）时不炸，等到超时", async () => {
  let calls = 0;
  const cdp = {
    async send() {
      calls += 1;
      throw new Error("Execution context was destroyed");
    },
  };
  const result = await waitForPageReady(cdp, { timeoutMs: 200, quietMs: 100 });
  assert.equal(result.reason, "timeout");
  assert.ok(calls > 0);
});
