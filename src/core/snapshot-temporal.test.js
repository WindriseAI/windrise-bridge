/**
 * 时间 / 日期框的值：真浏览器里 `input[type=time]` 在无障碍树里只有两个 spinbutton，
 * 值只能从 DOM property 读。这里覆盖「扫描 → 收集 → 标进快照文字」这条真实路径。
 *
 *   node --test src/core/snapshot-temporal.test.js
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RefMap } from "../vendor/browseros/core/snapshot/refs.js";
import { annotateTemporalValues, findTemporalValues, scanTemporalInFrame } from "./snapshot-temporal.js";

/** 假 CDP 会话：形状和 TargetSurface 的 session('') 一样（Runtime / DOM）。 */
function fakeSession({ value = "12:30", backendNodeId = 42 } = {}) {
  return {
    Runtime: {
      evaluate: async () => ({ result: { objectId: "scan-root" } }),
      getProperties: async ({ objectId }) => (objectId === "scan-root"
        ? { result: [{ name: "nodes", value: { objectId: "nodes" } }, { name: "meta", value: { objectId: "meta" } }] }
        : { result: [{ name: "0", value: { objectId: "el-0" } }] }),
      callFunctionOn: async () => ({ result: { value: [{ type: "time", value, name: "时间:" }] } }),
      releaseObject: async () => ({}),
    },
    DOM: {
      describeNode: async () => ({ node: { backendNodeId } }),
    },
  };
}

test("findTemporalValues：从 DOM property 读出时间值（空值也要带上）", async () => {
  const values = await findTemporalValues(fakeSession({ value: "" }));
  assert.equal(values.size, 1);
  assert.deepEqual([...values.values()], [{ type: "time", value: "", name: "时间:" }]);
});

test("scanTemporalInFrame：收集时把 objectId 换成 backendNodeId", async () => {
  const scan = await scanTemporalInFrame(fakeSession({ value: "12:30", backendNodeId: 77 }));
  const collected = await scan.collect(fakeSession({ value: "12:30", backendNodeId: 77 }));
  assert.deepEqual([...collected.entries()], [[77, { type: "time", value: "12:30", name: "时间:" }]]);
});

test("annotateTemporalValues：宿主 input 有编号时，值写在宿主行尾", () => {
  const refs = new RefMap();
  const ref = refs.mint({ backendNodeId: 10, role: "InputTime", name: "时间" });
  const text = `- InputTime "时间" [ref=${ref}]`;
  const out = annotateTemporalValues(text, refs, new Map([[10, { type: "time", value: "12:30" }]]));
  assert.equal(out, `- InputTime "时间" [ref=${ref}] [value="12:30"]`);
});

test("annotateTemporalValues：宿主不在无障碍树里时，补一个可操作的编号并写上行内值", () => {
  const refs = new RefMap();
  const text = [
    '- InputTime "Preferred delivery time:"',
    '  - spinbutton "小时 小时" [ref=e11]',
    '  - spinbutton "分钟 分钟" [ref=e12]',
  ].join("\n");
  const out = annotateTemporalValues(text, refs, new Map([[11, { type: "time", value: "12:30" }]]), { documentId: "doc-1" });
  assert.match(out, /- InputTime "Preferred delivery time:" \[ref=e\d+\] \[value="12:30"\]\n  - spinbutton/);
  // 宿主终于有编号了：page_act 可以直接把值填给宿主 input
  const ref = /InputTime "Preferred delivery time:" \[ref=(e\d+)\]/.exec(out)?.[1];
  assert.ok(ref);
  assert.equal(refs.get(ref)?.backendNodeId, 11);
  assert.equal(refs.get(ref)?.role, "InputTime");
});

test("annotateTemporalValues：同一个 documentId 下宿主的编号在两次快照间保持不变", () => {
  const refs = new RefMap();
  const text = '- InputTime "时间:"\n  - spinbutton "小时" [ref=e11]';
  const first = annotateTemporalValues(text, refs, new Map([[11, { type: "time", value: "" }]]), { documentId: "doc-1" });
  const firstRef = /InputTime "时间:" \[ref=(e\d+)\]/.exec(first)?.[1];
  const next = refs.forkForSnapshot();
  const second = annotateTemporalValues(text.replace("[ref=e11]", "[ref=e12]"), next, new Map([[11, { type: "time", value: "12:30" }]]), { documentId: "doc-1" });
  const secondRef = /InputTime "时间:" \[ref=(e\d+)\]/.exec(second)?.[1];
  assert.equal(secondRef, firstRef);
});

test("annotateTemporalValues：页面有多个时间框时按各自的名字挂值，不都挂到第一个", () => {
  const text = [
    '- InputTime "起床时间:"',
    '  - spinbutton "小时 小时" [ref=e11]',
    '- InputTime "睡觉时间:"',
    '  - spinbutton "分钟 分钟" [ref=e12]',
  ].join("\n");
  const values = new Map([
    [10, { type: "time", value: "07:00", name: "起床时间:" }],
    [20, { type: "time", value: "23:30", name: "睡觉时间:" }],
  ]);
  const out = annotateTemporalValues(text, new RefMap(), values, { documentId: "doc-1" });
  assert.match(out, /InputTime "起床时间:".*\[value="07:00"\]/);
  assert.match(out, /InputTime "睡觉时间:".*\[value="23:30"\]/);
});

test("annotateTemporalValues：空值也写出来（diff 才能看见从 12:30 清空）", () => {
  const text = '- InputTime "时间"\n  - spinbutton "小时" [ref=e11]';
  const out = annotateTemporalValues(text, new RefMap(), new Map([[11, { type: "time", value: "" }]]));
  // 宿主不在无障碍树里时补一行 time-value（同时给宿主发编号，方便 page_act 直接填）
  assert.match(out, /- InputTime "时间" \[ref=e\d+\] \[value=""\]/);
});

test("annotateTemporalValues：宿主本来就没有 InputTime 行时，才退回补 time-value 行", () => {
  const text = '- spinbutton "小时" [ref=e11]\n- spinbutton "分钟" [ref=e12]';
  const out = annotateTemporalValues(text, new RefMap(), new Map([[11, { type: "time", value: "12:30" }]]));
  assert.match(out, /- time-value "小时" \[value="12:30"\]/);
});
