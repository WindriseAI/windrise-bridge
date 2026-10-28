/**
 * 流程定位打分与草稿读写的纯 Node 单测（不需要浏览器 / 不用起 Bridge）：
 *   node --test src/core/flow-locate.test.js
 *
 * 覆盖 c7b 的定位误匹配修正：
 *   ① 不再反向包含（「提交」不该命中「提交订单记录」这种更长的名字；被包含的名字至少 4 个字才算）；
 *   ② 多个同分最佳候选 → 判失败并列出候选（不瞎挑第一个）；
 *   ③ 部分匹配（靠包含命中）记为脆弱，干跑报告能真列出来；
 *   ④ 名字挨着的不算同分（唯一命中照常成功）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bestMatch, isFragile, locateAll } from "./flow-locate.js";

test("定位：不再反向包含，「提交」不命中更长的「提交订单记录」", () => {
  const text = [
    '- button "提交订单记录" [ref=e1]',
    '- button "提交" [ref=e2]',
  ].join("\n");
  const match = bestMatch([{ kind: "label", value: "提交" }], text);
  assert.equal(match?.ref, "e2");
  assert.equal(match?.how, "label");
  // 只有更长的那个名字时：短名字被包含 → 允许，但记成部分匹配（脆弱）
  const onlyLong = bestMatch([{ kind: "label", value: "提交" }], '- button "提交订单记录" [ref=e1]');
  assert.equal(onlyLong?.ref, "e1");
  assert.equal(onlyLong?.partial, true);
});

test("定位：被包含的短名字不足 4 个字时不算命中", () => {
  const text = '- button "删" [ref=e1]\n- button "删除" [ref=e2]';
  // 「删除」不命中「删」（被包含的名字只有 1 个字）
  const match = bestMatch([{ kind: "label", value: "删除" }], text);
  assert.equal(match?.ref, "e2");
  assert.ok(!match?.partial);
  // 「删除」不该把「删」当成候选
  const all = locateAll([{ kind: "label", value: "删除" }], text);
  assert.deepEqual(all.map((item) => item.ref), ["e2"]);
});

test("定位：多个同分最佳候选判失败并列出候选", () => {
  const text = [
    '- button "删除" [ref=e1]',
    '- button "删除" [ref=e2]',
  ].join("\n");
  const match = bestMatch([{ kind: "label", value: "删除" }], text);
  assert.equal(match, null);
  const all = locateAll([{ kind: "label", value: "删除" }], text);
  assert.equal(all.length, 2);
  assert.ok(all.every((item) => item.partial === false));
  assert.deepEqual(all.map((item) => item.ref).sort(), ["e1", "e2"]);
});

test("定位：同分候选只有一个时照常成功", () => {
  const text = '- button "提交" [ref=e2]';
  const match = bestMatch([{ kind: "label", value: "提交" }], text);
  assert.equal(match?.ref, "e2");
  assert.equal(match?.partial, false);
});

test("脆弱：靠包含命中的（部分匹配）记为脆弱，精确命中不算", () => {
  const exact = bestMatch([{ kind: "label", value: "提交" }], '- button "提交" [ref=e2]');
  assert.equal(exact.partial, false);
  assert.equal(isFragile(exact.score, exact.partial), false);
  const partial = bestMatch([{ kind: "label", value: "收货人" }], '- textbox "收货人姓名" [ref=e1]');
  assert.equal(partial.partial, true);
  assert.equal(isFragile(partial.score, partial.partial), true);
  // 「收货人」和「收货人姓名」是包含关系、只有两个不同名字，所以不算同分并列
  assert.equal(partial.ref, "e1");
});
