/**
 * 动作之后的「等页面稳下来」：导航要带新 URL / 标题，SPA 后退要等稳定再拍（纯 Node，假 CDP）。
 *   node --test src/core/page-settle.test.js
 *
 * 覆盖：
 *   ① 点击后换了页：等到新文档 readyState 完成，报 navigated:true + 新 URL / 标题；
 *   ② 没换页：过了宽限期就收工，不为一次普通点击白等满超时；
 *   ③ SPA 后退：URL 先变、DOM 后变，要等 DOM 安静下来才算稳（否则拍到空壳）；
 *   ④ 一直不安静：超时返回 settled:false + reason，如实上报而不是假装稳了；
 *   ⑤ 页面没了 / 会话断了：立刻返回，不再空等；
 *   ⑥ 对话框开着：reason 是 dialog（不让调用方以为是普通超时）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForNavigationSettle } from "./page-settle.js";

/**
 * 假 CDP：按剧本给出页面状态。
 *   states：每次 Runtime.evaluate 依次返回的 { url, title, readyState, lastAt }
 *   lastAt 是「最后一次 DOM 变动时间」，用 Date.now() 的相对值控制「安静了多久」
 */
function fakeCdp(states, { error = null } = {}) {
  let index = 0;
  const sent = [];
  return {
    sent,
    async send(method, params = {}) {
      sent.push({ method, params });
      if (error) throw error;
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return { result: { value: { lastAt: 0, ...state } } };
    },
  };
}

test("点击后换了页：等到新页面就绪，报 navigated + 新 URL / 标题", async () => {
  const cdp = fakeCdp([
    { url: "https://a.test/login", title: "登录", readyState: "complete" },
    { url: "https://a.test/secure", title: "安全区", readyState: "complete" },
    { url: "https://a.test/secure", title: "安全区", readyState: "complete" },
  ]);
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/login",
    expectChange: true,
    graceMs: 0,
    pollMs: 1,
  });
  assert.equal(result.settled, true);
  assert.equal(result.navigated, true);
  assert.equal(result.url, "https://a.test/secure");
  assert.equal(result.title, "安全区");
});

test("没换页：过了宽限期就收工（普通点击不白等满超时）", async () => {
  const cdp = fakeCdp([{ url: "https://a.test/form", title: "表单", readyState: "complete" }]);
  const started = Date.now();
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/form",
    expectChange: false,
    graceMs: 20,
    timeoutMs: 5_000,
    pollMs: 5,
  });
  assert.equal(result.settled, true);
  assert.equal(result.navigated, false);
  assert.equal(result.url, "https://a.test/form");
  assert.ok(Date.now() - started < 1_000, "不该等满 5 秒");
});

test("普通点击的默认参数：页面本来就稳时在观察窗口内返回，不卡 5 秒（t5 报过每次点击都卡 5 秒）", async () => {
  const cdp = fakeCdp([{ url: "https://a.test/form", title: "表单", readyState: "complete" }]);
  const started = Date.now();
  const result = await waitForNavigationSettle(cdp, { previousUrl: "https://a.test/form", graceMs: 400, windowMs: 700 });
  const elapsed = Date.now() - started;
  assert.equal(result.settled, true);
  assert.equal(result.navigated, false);
  assert.ok(elapsed >= 600 && elapsed < 1_800, `应在观察窗口附近返回，实际 ${elapsed}ms`);
});

test("观察窗口内稍晚才开始的导航：也能抓到（点「登录」后跳转常有延迟）", async () => {
  let index = 0;
  const cdp = {
    async send() {
      index += 1;
      // 前两拍还在原页面，第三拍起换了页
      const url = index <= 2 ? "https://a.test/login" : "https://a.test/secure";
      return { result: { value: { url, title: url.includes("secure") ? "安全区" : "登录", readyState: "complete", lastAt: 0 } } };
    },
  };
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/login",
    graceMs: 400,
    windowMs: 700,
    pollMs: 20,
  });
  assert.equal(result.navigated, true);
  assert.equal(result.url, "https://a.test/secure");
});

test("长轮询页面 readyState 一直 interactive、但 DOM 安静：也算稳（能收工）", async () => {
  const cdp = {
    async send() {
      return { result: { value: { url: "https://a.test/live", title: "直播", readyState: "interactive", lastAt: Date.now() - 5_000 } } };
    },
  };
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/live",
    graceMs: 20,
    timeoutMs: 3_000,
    pollMs: 10,
  });
  assert.equal(result.settled, true);
  assert.equal(result.reason, "stable");
});

test("SPA 后退：URL 先变、DOM 后变，等 DOM 安静下来才算稳", async () => {
  // 第一次：URL 已经变了，但 DOM 刚动过（lastAt = 现在）→ 还没稳
  // 之后：DOM 安静够久 → 稳
  let index = 0;
  const cdp = {
    async send() {
      index += 1;
      if (index === 1) {
        return { result: { value: { url: "https://a.test/list", title: "列表", readyState: "interactive", lastAt: Date.now() } } };
      }
      return { result: { value: { url: "https://a.test/list", title: "列表", readyState: "complete", lastAt: Date.now() - 5_000 } } };
    },
  };
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/detail",
    expectChange: true,
    graceMs: 0,
    quietMs: 300,
    pollMs: 1,
  });
  assert.equal(result.settled, true);
  assert.equal(result.navigated, true);
  assert.equal(result.url, "https://a.test/list");
  assert.ok(index >= 2, "第一拍没稳，要再看一拍");
});

test("一直不安静：超时返回 settled:false + reason，不假装稳了", async () => {
  const cdp = {
    async send() {
      // 每一拍 DOM 都在动（长轮询页面），而且还在加载
      return { result: { value: { url: "https://a.test/busy", title: "忙", readyState: "loading", lastAt: Date.now() } } };
    },
  };
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/busy",
    expectChange: false,
    graceMs: 0,
    timeoutMs: 60,
    pollMs: 10,
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "timeout");
});

test("要求换页但一直没换：reason 是 no-navigation（和「换页了但没稳」分开）", async () => {
  const cdp = fakeCdp([{ url: "https://a.test/stay", title: "停在这", readyState: "complete" }]);
  const result = await waitForNavigationSettle(cdp, {
    previousUrl: "https://a.test/stay",
    expectChange: true,
    graceMs: 0,
    timeoutMs: 40,
    pollMs: 10,
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "no-navigation");
  assert.equal(result.navigated, false);
});

test("页面已经没了（TARGET_CLOSED）：立刻返回，不再空等", async () => {
  const cdp = fakeCdp([], { error: Object.assign(new Error("标签页被关掉了"), { code: "TARGET_CLOSED" }) });
  const started = Date.now();
  const result = await waitForNavigationSettle(cdp, { previousUrl: "https://a.test/", timeoutMs: 5_000, pollMs: 10 });
  assert.equal(result.settled, false);
  assert.equal(result.blockedBy, "TARGET_CLOSED");
  assert.match(result.reason, /不在了/);
  assert.ok(Date.now() - started < 500, "不能等满超时");
});

test("对话框开着：reason 是 dialog，调用方据此提示先关对话框", async () => {
  const cdp = fakeCdp([], { error: Object.assign(new Error("页面开着 confirm 对话框"), { code: "DIALOG_OPEN" }) });
  const result = await waitForNavigationSettle(cdp, { previousUrl: "https://a.test/", timeoutMs: 40, pollMs: 10 });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "dialog");
  assert.equal(result.blockedBy, "DIALOG_OPEN");
});
