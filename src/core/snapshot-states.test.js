/**
 * 快照要能看清控件状态（纯 Node，假 AX 树）：
 *   node --test src/core/snapshot-states.test.js
 *
 * 覆盖（对应测试员报的「snapshot 不显示 checkbox / radio 的 checked 状态、select 的当前值」）：
 *   ① checkbox / radio / switch 的 checked 为 true → [checked]，为 false → [unchecked]（两头都写）；
 *   ② indeterminate 单独写 [indeterminate]，不冒充 checked；
 *   ③ 下拉框（combobox / listbox）的当前值写成 [value="…"]，和状态位并排；
 *   ④ 状态变化能被 diff 看见（勾上 / 取消 / 换选项之后差异非空）；
 *   ⑤ 敏感下拉框打码后不会靠 [value] 把选中项漏出去（脱敏层仍按原规则抹掉 value）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RefMap } from "../vendor/browseros/core/snapshot/refs.js";
import { renderSnapshot } from "../vendor/browseros/core/snapshot/render.js";
import { diffSnapshots } from "../vendor/browseros/core/snapshot/diff.js";

/** 造一个 AX 节点：role + 名字 + 可选状态。 */
function ax(nodeId, role, { name, properties = [], value, children, backendDOMNodeId } = {}) {
  const node = { nodeId, role: { type: "role", value: role }, childIds: children };
  if (name !== undefined) node.name = { type: "computedString", value: name };
  if (properties.length) node.properties = properties;
  if (value !== undefined) node.value = { type: "string", value };
  if (backendDOMNodeId !== undefined) node.backendDOMNodeId = backendDOMNodeId;
  return node;
}

/** CDP 的 properties 形状：{ name, value: { type, value } } */
function prop(name, value) {
  return { name, value: { type: typeof value, value } };
}

function render(nodes) {
  return renderSnapshot(nodes, { refs: new RefMap() }).text;
}

test("checkbox / radio / switch：checked 为 true 写 [checked]，为 false 写 [unchecked]", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2", "3", "4"] }),
    ax("2", "checkbox", { name: "Bacon", backendDOMNodeId: 10, properties: [prop("checked", true)] }),
    ax("3", "checkbox", { name: "Medium", backendDOMNodeId: 11, properties: [prop("checked", false)] }),
    ax("4", "switch", { name: "深色模式", backendDOMNodeId: 12, properties: [prop("checked", false)] }),
  ]);
  assert.match(text, /- checkbox "Bacon" \[checked\] \[ref=e\d+\]/);
  assert.match(text, /- checkbox "Medium" \[unchecked\] \[ref=e\d+\]/);
  assert.match(text, /- switch "深色模式" \[unchecked\] \[ref=e\d+\]/);
});

test("radio：选中与未选中都能一眼看出来", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2", "3"] }),
    ax("2", "radio", { name: "微信", backendDOMNodeId: 20, properties: [prop("checked", true)] }),
    ax("3", "radio", { name: "小红书", backendDOMNodeId: 21, properties: [prop("checked", false)] }),
  ]);
  assert.match(text, /- radio "微信" \[checked\]/);
  assert.match(text, /- radio "小红书" \[unchecked\]/);
});

test("真浏览器 CDP 的 checked 是字符串 true / false，也要认（否则快照一个状态都没有）", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2", "3", "4"] }),
    ax("2", "checkbox", { name: "Bacon", backendDOMNodeId: 13, properties: [prop("checked", "true")] }),
    ax("3", "checkbox", { name: "Medium", backendDOMNodeId: 14, properties: [prop("checked", "false")] }),
    ax("4", "radio", { name: "Large", backendDOMNodeId: 15, properties: [prop("checked", "true")] }),
  ]);
  assert.match(text, /- checkbox "Bacon" \[checked\]/);
  assert.match(text, /- checkbox "Medium" \[unchecked\]/);
  assert.match(text, /- radio "Large" \[checked\]/);
});

test("真浏览器 CDP 的 expanded 也是字符串 true / false，也要认（否则展开状态永远不出现）", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2", "3"] }),
    ax("2", "treeitem", { name: "已展开", backendDOMNodeId: 16, properties: [prop("expanded", "true")] }),
    ax("3", "treeitem", { name: "已收起", backendDOMNodeId: 17, properties: [prop("expanded", "false")] }),
  ]);
  assert.match(text, /- treeitem "已展开" \[expanded\]/);
  assert.match(text, /- treeitem "已收起" \[collapsed\]/);
});

test("indeterminate 单独写出来，不冒充 checked", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2"] }),
    ax("2", "checkbox", { name: "全选", backendDOMNodeId: 30, properties: [prop("checked", "mixed")] }),
  ]);
  assert.match(text, /- checkbox "全选" \[indeterminate\]/);
  assert.ok(!/\[checked\]/.test(text), "mixed 不能写成 checked");
});

test("下拉框当前值写成 [value=\"…\"]，listbox（多选 select）也有", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2", "3"] }),
    ax("2", "combobox", { name: "数量", backendDOMNodeId: 40, value: "2" }),
    ax("3", "listbox", { name: "标签", backendDOMNodeId: 41, value: "红色 蓝色" }),
  ]);
  assert.match(text, /- combobox "数量" \[ref=e\d+\] \[value="2"\]/);
  assert.match(text, /- listbox "标签" \[ref=e\d+\] \[value="红色 蓝色"\]/);
});

test("文本框的 value 仍写在行尾，不变成 [value]", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2"] }),
    ax("2", "textbox", { name: "搜索", backendDOMNodeId: 50, value: "关键字" }),
  ]);
  assert.match(text, /- textbox "搜索" \[ref=e\d+\]: "关键字"/);
  assert.ok(!/\[value=/.test(text), "文本框不该用 [value=] 形式");
});

test("状态和编号的顺序稳定：状态在前、ref 在后、值最后", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2"] }),
    ax("2", "combobox", {
      name: "城市",
      backendDOMNodeId: 60,
      value: "北京",
      properties: [prop("disabled", false), prop("expanded", false)],
    }),
  ]);
  assert.equal(text, '- combobox "城市" [collapsed] [ref=e1] [value="北京"]');
});

test("勾选 / 取消 / 换选项之后，diff 能看见（不再报「没有变化」）", () => {
  const before = render([
    ax("1", "RootWebArea", { children: ["2", "3"] }),
    ax("2", "checkbox", { name: "Bacon", backendDOMNodeId: 70, properties: [prop("checked", false)] }),
    ax("3", "combobox", { name: "数量", backendDOMNodeId: 71, value: "1" }),
  ]);
  const after = render([
    ax("1", "RootWebArea", { children: ["2", "3"] }),
    ax("2", "checkbox", { name: "Bacon", backendDOMNodeId: 70, properties: [prop("checked", true)] }),
    ax("3", "combobox", { name: "数量", backendDOMNodeId: 71, value: "2" }),
  ]);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.changed, true, "状态变了，diff 必须是 changed");
  assert.match(diff.text, /\+.*checkbox "Bacon" \[checked\]/);
  assert.match(diff.text, /-.*checkbox "Bacon" \[unchecked\]/);
  assert.match(diff.text, /\[value="2"\]/);
});

test("只有 checked 属性没有 value 的控件：不会被当成下拉框乱写 [value]", () => {
  const text = render([
    ax("1", "RootWebArea", { children: ["2"] }),
    ax("2", "checkbox", { name: "同意", backendDOMNodeId: 80, properties: [prop("checked", false)] }),
  ]);
  assert.ok(!/\[value=/.test(text));
  assert.match(text, /\[unchecked\]/);
});
