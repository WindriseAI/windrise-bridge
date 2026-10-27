/**
 * 快照切块 / 查找 / 长页面差异的单元测试（纯 Node）：
 *   node --test src/core/snapshot-query.test.js
 *
 * 覆盖：
 *   ① paginateSnapshot：offset / maxChars / nextOffset / totalChars，截断提示里写明还有多少字；
 *   ② findInSnapshot：不区分大小写、只返回命中行 + 祖先行、命中上限；
 *   ③ diffActionable：长页面上给出新出现 / 消失的可操作元素，而不是只给行数；
 *   ④ subtreeAxNodes / pruneAxNodes：selector 只拍子树、viewportOnly 只留视口内的节点。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ancestorsOf,
  augmentLargeDiff,
  diffActionable,
  findInSnapshot,
  formatActionableDiff,
  paginateSnapshot,
  pruneAxNodes,
  subtreeAxNodes,
} from "./snapshot-query.js";

const TREE = [
  '- RootWebArea "维基百科"',
  '  - link "English" [ref=e1]',
  '  - button "269种语言" [ref=e2]',
  '  - generic "正文"',
  '    - link "新加坡" [ref=e3]',
  '    - link "English 条目" [ref=e4]',
  '  - searchbox "搜索维基百科" [ref=e5]',
].join("\n");

test("paginateSnapshot：从头切一段，带上 nextOffset 和总字数", () => {
  const page = paginateSnapshot("0123456789", { offset: 0, maxChars: 4 });
  assert.equal(page.text.split("\n")[0], "0123");
  assert.equal(page.offset, 0);
  assert.equal(page.nextOffset, 4);
  assert.equal(page.totalChars, 10);
  assert.equal(page.remaining, 6);
  assert.match(page.text, /还有 6 字没返回；用 offset=4 继续/);
});

test("paginateSnapshot：用 nextOffset 接着读，能读到尾部", () => {
  const text = "x".repeat(10);
  const first = paginateSnapshot(text, { offset: 0, maxChars: 4 });
  const second = paginateSnapshot(text, { offset: first.nextOffset, maxChars: 4 });
  const third = paginateSnapshot(text, { offset: second.nextOffset, maxChars: 4 });
  assert.equal(second.text.split("\n")[0], "xxxx");
  assert.equal(third.text, "xx");
  assert.equal(third.nextOffset, null);
  assert.equal(third.truncated, false);
  assert.doesNotMatch(third.text, /已截断/);
});

test("paginateSnapshot：offset 超界 / 负数 / 非数字都不炸", () => {
  assert.equal(paginateSnapshot("abc", { offset: 99 }).nextOffset, null);
  assert.equal(paginateSnapshot("abc", { offset: -5 }).text, "abc");
  assert.equal(paginateSnapshot("abc", { offset: "x" }).offset, 0);
});

test("findInSnapshot：不区分大小写，每处命中都带祖先行", () => {
  const found = findInSnapshot(TREE, "english");
  assert.equal(found.count, 2);
  const first = found.matches[0];
  assert.equal(first.line.trim(), '- link "English" [ref=e1]');
  assert.deepEqual(first.ancestors, ['- RootWebArea "维基百科"']);
  const second = found.matches[1];
  assert.equal(second.line.trim(), '- link "English 条目" [ref=e4]');
  assert.deepEqual(second.ancestors.map((line) => line.trim()), ['- RootWebArea "维基百科"', '- generic "正文"']);
  assert.match(found.text, /- generic "正文"\n\s*- link "English 条目"/);
});

test("findInSnapshot：命中超过上限时截断并说清总数", () => {
  const text = Array.from({ length: 30 }, (_, index) => `- link "项 ${index}"`).join("\n");
  const found = findInSnapshot(text, "项", { maxMatches: 5 });
  assert.equal(found.matches.length, 5);
  assert.equal(found.count, 30);
  assert.equal(found.truncated, true);
});

test("findInSnapshot：空关键字不返回任何东西", () => {
  assert.equal(findInSnapshot(TREE, "").count, 0);
  assert.equal(findInSnapshot(TREE, "   ").text, "");
});

test("ancestorsOf：缩进每 2 个空格一级，逐级往上找", () => {
  const lines = TREE.split("\n");
  assert.deepEqual(ancestorsOf(lines, 5), [lines[0], lines[3]]);
  assert.deepEqual(ancestorsOf(lines, 0), []);
});

test("diffActionable：长页面上列出新出现 / 消失的可操作元素", () => {
  const before = [
    '- RootWebArea "页"',
    '  - button "269种语言" [ref=e2]',
    '  - link "中文" [ref=e3]',
  ].join("\n");
  const after = [
    '- RootWebArea "页"',
    '  - button "269种语言" [ref=e2]',
    '  - link "English" [ref=e9]',
    '  - link "Deutsch" [ref=e10]',
  ].join("\n");
  const diff = diffActionable(before, after);
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.removedCount, 1);
  assert.deepEqual(diff.added.map((line) => line.trim()), ['- link "English" [ref=e9]', '- link "Deutsch" [ref=e10]']);
  assert.deepEqual(diff.removed.map((line) => line.trim()), ['- link "中文" [ref=e3]']);
  const text = formatActionableDiff(diff);
  assert.match(text, /新出现的可操作元素（2 个）：/);
  assert.match(text, /\+ - link "English" \[ref=e9\]/);
  assert.match(text, /消失的可操作元素（1 个）：/);
  assert.match(text, /- - link "中文" \[ref=e3\]/);
});

test("diffActionable：最多各 40 条，说清总数", () => {
  const before = '- RootWebArea "页"';
  const after = ['- RootWebArea "页"', ...Array.from({ length: 50 }, (_, index) => `  - button "按钮 ${index}" [ref=e${index + 2}]`)].join("\n");
  const diff = diffActionable(before, after);
  assert.equal(diff.added.length, 40);
  assert.equal(diff.addedCount, 50);
  assert.equal(diff.truncated, true);
  assert.match(formatActionableDiff(diff), /只列前 40 个/);
});

test("diffActionable：同一段文字出现两次时按次数算", () => {
  const before = '- RootWebArea "页"\n  - button "编辑" [ref=e2]';
  const after = '- RootWebArea "页"\n  - button "编辑" [ref=e2]\n  - button "编辑" [ref=e7]';
  const diff = diffActionable(before, after);
  assert.equal(diff.addedCount, 1);
  assert.deepEqual(diff.added.map((line) => line.trim()), ['- button "编辑" [ref=e7]']);
});

test("augmentLargeDiff：逐行 diff 被跳过时换成可操作元素清单，没跳过就原样返回", () => {
  const skipped = { text: "Snapshot changed substantially: 3315 lines before, 3309 lines after.", added: 3309, removed: 3315, changed: true, lineDiffSkipped: true };
  const before = '- RootWebArea "页"\n  - link "中文" [ref=e4]';
  const after = '- RootWebArea "页"\n  - link "English" [ref=e9]';
  const fixed = augmentLargeDiff(skipped, before, after);
  assert.match(fixed.text, /新出现的可操作元素（1 个）：/);
  assert.match(fixed.text, /1\. \+ - link "English" \[ref=e9\]/);
  assert.match(fixed.text, /1\. - - link "中文" \[ref=e4\]/);
  assert.deepEqual(fixed.actionable.added, ['  - link "English" [ref=e9]']);
  assert.equal(fixed.lineDiffSkipped, true);
  const normal = { text: "x", added: 1, removed: 0, changed: true };
  assert.equal(augmentLargeDiff(normal, before, after), normal);
});

test("subtreeAxNodes：只留根的子树，根排最前", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
    { nodeId: "2", role: { value: "generic" }, backendDOMNodeId: 100, childIds: ["4"] },
    { nodeId: "3", role: { value: "button" }, backendDOMNodeId: 200 },
    { nodeId: "4", role: { value: "link" }, backendDOMNodeId: 300 },
  ];
  const kept = subtreeAxNodes(nodes, 100);
  assert.deepEqual(kept.map((node) => node.nodeId), ["2", "4"]);
  assert.deepEqual(subtreeAxNodes(nodes, 999), []);
});

test("pruneAxNodes：只留视口内的节点和它们的祖先，摘掉不在视口的兄弟", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
    { nodeId: "2", role: { value: "link" }, backendDOMNodeId: 10 },
    { nodeId: "3", role: { value: "generic" }, backendDOMNodeId: 20, childIds: ["4", "5"] },
    { nodeId: "4", role: { value: "link" }, backendDOMNodeId: 30 },
    { nodeId: "5", role: { value: "link" }, backendDOMNodeId: 40 },
  ];
  const kept = pruneAxNodes(nodes, new Set([40]));
  assert.deepEqual(kept.map((node) => node.nodeId), ["1", "3", "5"]);
  assert.deepEqual(kept.find((node) => node.nodeId === "3").childIds, ["5"]);
});

test("pruneAxNodes：一个视口命中都没有时只留根（不返回空树）", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
    { nodeId: "2", role: { value: "link" }, backendDOMNodeId: 10 },
  ];
  assert.deepEqual(pruneAxNodes(nodes, new Set()).map((node) => node.nodeId), ["1"]);
});
