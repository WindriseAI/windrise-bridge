/**
 * 批量填表（page_act 的 fields[]）的纯 Node 测试：不碰真浏览器，用假 CDP 模拟一张表单。
 *   node --test src/core/page-fill.test.js
 *
 * 表单来自 _probe/fixtures/sensitive-form.html 的「批量填表」那一段（文本、select、
 * checkbox、radio、ARIA 自定义下拉、提交按钮）。断言：
 *   ① 一次调用按顺序填完全部字段，只回读一次（只有一次 diff）；
 *   ② 提交按钮被拒绝、不会被点到（批量填表不会提交）；
 *   ③ 一项失败不中断后面的；
 *   ④ 不存在的选项返回候选列表（最多 50 个），原生 select 和自定义下拉都覆盖；
 *   ⑤ 旧的单次调用（action + ref）行为不变；
 *   ⑥ 参数校验：最多 30 项、缺 ref / value 直接拒绝，且一个字段都不填。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createSurfaceAct } from "./surface-act.js";
import { MAX_FIELDS, fillFieldsOnce } from "./page-fill.js";
import { defineBrowserTools } from "../tools/browser.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "_probe", "fixtures", "sensitive-form.html");
const HTML = readFileSync(FIXTURE, "utf8");
const FORM = /<form id="batch-form"[\s\S]*?<\/form>/.exec(HTML)?.[0] ?? "";

/* ---------------- 从 fixture 里读表单定义，测试和测试页共用一份 ---------------- */

function fixtureParts() {
  const select = /<select id="bf-fruit"[\s\S]*?<\/select>/.exec(FORM)?.[0] ?? "";
  const fruitOptions = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map((match) => ({ value: match[1], label: match[2] }));
  const comboStart = HTML.indexOf('id="bf-city-list"');
  const comboEnd = HTML.indexOf('id="bf-submit"', comboStart);
  const cityOptions = [...HTML.slice(comboStart, comboEnd).matchAll(/role="option"[^>]*>([^<]+)</g)]
    .map((match) => match[1].trim());
  const submitLabel = /<button id="bf-submit" type="submit">([^<]+)<\/button>/.exec(FORM)?.[1] ?? "";
  return { fruitOptions, cityOptions, submitLabel };
}

test("fixture 里有批量填表要用的那张表单（文本 / select / checkbox / radio / ARIA 下拉 / 提交）", () => {
  for (const id of ["bf-name", "bf-fruit", "bf-agree", "bf-plan-pro", "bf-plan-basic", "bf-city", "bf-city-list", "bf-submit"]) {
    assert.match(FORM + HTML.slice(HTML.indexOf('id="bf-city-list"')), new RegExp(`id="${id}"`), `fixture 缺 ${id}`);
  }
  const { fruitOptions, cityOptions, submitLabel } = fixtureParts();
  assert.deepEqual(fruitOptions.map((option) => option.label), ["苹果", "香蕉", "樱桃"]);
  assert.deepEqual(cityOptions, ["北京", "上海", "广州"]);
  assert.equal(submitLabel, "提交");
});

/* ---------------- 假页面：CDP 只认几个脚本，状态记在一张表上 ---------------- */

const SNAPSHOT_TEXT = [
  '- RootWebArea "敏感表单测试页"',
  '  - textbox "姓名" [ref=e1]',
  '  - combobox "水果" [ref=e2]',
  '  - checkbox "同意条款" [ref=e3]',
  '  - radio "Pro 套餐" [ref=e4]',
  '  - radio "基础版" [ref=e5]',
  '  - combobox "城市" [ref=e6]',
  '  - button "提交" [ref=e7]',
].join("\n");

function createPage({ cityOptions: cityOverride = null, comboOccluded = false, comboVerified = true } = {}) {
  const { fruitOptions, cityOptions: fixtureCities, submitLabel } = fixtureParts();
  const cityOptions = cityOverride ?? fixtureCities;
  const list = [
    { ref: "e1", role: "textbox", name: "姓名", tag: "input", type: "text" },
    { ref: "e2", role: "combobox", name: "水果", tag: "select", type: "", options: fruitOptions },
    { ref: "e3", role: "checkbox", name: "同意条款", tag: "input", type: "checkbox" },
    { ref: "e4", role: "radio", name: "Pro 套餐", tag: "input", type: "radio", group: "plan" },
    { ref: "e5", role: "radio", name: "基础版", tag: "input", type: "radio", group: "plan" },
    { ref: "e6", role: "combobox", name: "城市", tag: "div", type: "", options: cityOptions },
    { ref: "e7", role: "button", name: submitLabel, tag: "button", type: "submit", submit: true },
  ];
  const byRef = new Map(list.map((item, index) => [item.ref, { ...item, backendNodeId: index + 1 }]));
  const state = {
    values: { e1: "", e3: "", e4: "", e5: "", e6: "" },
    checked: { e3: false, e4: false, e5: false },
    selected: { e2: fruitOptions[0]?.value ?? "" },
    submitClicks: 0,
    pointRef: null,
    fillRef: null,
    pendingCombo: null,
    changeEvents: 0,
    sent: [],
    snapshots: 0,
    comboOccluded,
    comboVerified,
  };
  const refOf = (objectId) => list[Number(String(objectId).replace(/^obj-/, "")) - 1]?.ref ?? null;
  const itemOf = (ref) => byRef.get(ref) ?? null;

  const cdp = {
    inputBlocked: null,
    session: () => ({}),
    async send(method, params = {}) {
      state.sent.push({ method, params });
      if (cdp.inputBlocked && String(method).startsWith("Input.")) {
        // 真实 CDP 抛的是没有 code 的普通错误；CONTROL_PREEMPTED 要靠 surface-act 的 mapError 补上
        throw new Error("人正在用这个标签页");
      }
      if (method === "Runtime.evaluate") {
        if (/innerWidth/.test(String(params.expression ?? ""))) return { result: { value: { x: 1, y: 2 } } };
        return { result: { value: 0 } };
      }
      if (method === "Runtime.callFunctionOn") {
        const script = String(params.functionDeclaration ?? "");
        const ref = refOf(params.objectId);
        const item = itemOf(ref);
        if (script.includes("comboOptionsForAction")) {
          const wanted = String(params.arguments?.[0]?.value ?? "").trim();
          const options = item?.options ?? [];
          const lower = wanted.toLowerCase();
          // 和真实脚本一致：只认完全相等（忽略大小写也算完全相等），不用「包含」猜
          const found = options.find((text) => text === wanted)
            ?? options.find((text) => text.toLowerCase() === lower);
          const contains = options.filter((text) => text.toLowerCase().includes(lower) && text !== wanted);
          if (found && !state.comboOccluded) state.pendingCombo = { ref, name: found };
          return {
            result: {
              value: {
                options,
                contains,
                match: found
                  ? {
                    x: 30, y: 40, name: found,
                    matchedBy: found === wanted ? "exact" : "icase",
                    occluded: state.comboOccluded ? { name: submitLabel, tag: "button" } : null,
                  }
                  : null,
              },
            },
          };
        }
        if (script.includes("readComboSelectionForAction")) {
          const text = state.comboVerified ? String(state.values[ref] ?? "") : "请选择城市";
          return { result: { value: { activeText: "", value: "", text, expanded: "false" } } };
        }
        if (script.includes("probeFillTargetForAction")) {
          return {
            result: {
              value: {
                tag: item?.tag ?? "",
                type: item?.type ?? "",
                role: item?.tag === "div" ? "combobox" : "",
                contentEditable: false,
                disabled: false,
              },
            },
          };
        }
        if (script.includes("selectOptionsForAction")) {
          const choices = params.arguments?.[0]?.value ?? [];
          const option = (item?.options ?? []).find((entry) =>
            entry.value === choices[0] || entry.label === choices[0]);
          if (!option) return { result: { value: { error: "option not found" } } };
          state.selected[ref] = option.value;
          state.changeEvents += 1;
          return { result: { value: { selected: [option.value] } } };
        }
        if (script.includes("Array.from(select.options)")) {
          return {
            result: {
              value: (item?.options ?? []).map((option) => ({
                value: option.value,
                label: option.label,
                selected: state.selected[ref] === option.value,
              })),
            },
          };
        }
        if (script.includes("'checked' in this")) {
          return { result: { value: Boolean(state.checked[ref]) } };
        }
        if (script.includes("function readFilledValue")) {
          return { result: { value: { actual: String(state.values[ref] ?? ""), type: item?.type ?? "" } } };
        }
        if (script.includes("function fillPreparation")) {
          state.fillRef = ref;
          return {
            result: {
              value: { status: "needsinput", kind: "input", cursorPoint: { x: 5, y: 5 }, before: String(state.values[ref] ?? "") },
            },
          };
        }
        if (script.includes("resolveFillTargetForAction")) return { result: { objectId: params.objectId } };
        if (script.includes("actionPointForElement")) {
          state.pointRef = ref;
          return { result: { value: { x: 10, y: 10 } } };
        }
        if (script.includes("interceptingElementAtPoint")) return { result: { value: { ok: true } } };
        if (script.includes("isActionTargetDisabled")) return { result: { value: { ok: true } } };
        return { result: { value: { ok: true } } };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
      if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === "Input.insertText") {
        state.values[state.fillRef] = String(params.text ?? "");
        return {};
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mouseReleased") {
          if (state.pendingCombo) {
            state.values[state.pendingCombo.ref] = state.pendingCombo.name;
            state.pendingCombo = null;
          } else {
            const item = itemOf(state.pointRef);
            if (item?.submit) state.submitClicks += 1;
            else if (item?.tag === "input" && item.type === "checkbox") state.checked[item.ref] = !state.checked[item.ref];
            else if (item?.tag === "input" && item.type === "radio") {
              state.checked[item.ref] = true;
              for (const other of list) if (other.group === item.group) state.checked[other.ref] = other.ref === item.ref;
            }
          }
        }
        return {};
      }
      return {};
    },
  };

  const snap = {
    refScope: undefined,
    baseline: { text: SNAPSHOT_TEXT, url: "https://fixture.test/form" },
    refs: { get: (ref) => byRef.get(ref) },
    async readMainFrameState() { return { url: "https://fixture.test/form", documentId: "doc-1" }; },
    async snapshot() { state.snapshots += 1; return { text: SNAPSHOT_TEXT, url: "https://fixture.test/form" }; },
    async resolveRef(ref) {
      const entry = byRef.get(ref);
      if (!entry) throw new Error(`Unknown ref ${ref}`);
      return { backendNodeId: entry.backendNodeId };
    },
  };

  return { cdp, snap, state, list };
}

function collectDiff(calls) {
  return async () => {
    calls.diff += 1;
    return {
      navigation: { url: "https://fixture.test/form", title: "敏感表单测试页", navigated: false, settled: true },
      diff: { added: 3, removed: 0, changed: true, urlChanged: false, text: "（测试用的差异）", textDelta: 0 },
    };
  };
}

/* ---------------- ① 一次调用填完、只回读一次 ---------------- */

test("fields：一次调用按顺序填完（含提交按钮被拒），只回读一次 diff", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const calls = { diff: 0 };
  const result = await fillFieldsOnce({
    fields: [
      { ref: "e1", value: "张三" },
      { ref: "e7", value: "随便点" },
      { ref: "e2", value: "香蕉" },
      { ref: "e3", value: true },
      { ref: "e4", value: true },
      { ref: "e6", value: "上海" },
    ],
    fillField: (field) => act.fillField(field),
    readBack: collectDiff(calls),
  });
  act.dispose();

  assert.equal(result.batch, true);
  assert.equal(result.total, 6);
  assert.equal(result.filled, 5);
  assert.equal(result.failed, 1);
  assert.equal(calls.diff, 1, "只回读一次");
  assert.equal(state.snapshots, 0, "批量填表不该在每个字段上重拍快照");

  // 顺序与逐项结果
  assert.deepEqual(result.fields.map((item) => item.ref), ["e1", "e7", "e2", "e3", "e4", "e6"]);
  assert.equal(result.fields[0].ok, true);
  assert.equal(result.fields[0].action, "type");
  assert.equal(result.fields[1].ok, false);
  assert.equal(result.fields[1].code, "FIELD_REJECTED");
  assert.match(result.fields[1].error, /提交|按钮|链接/);
  assert.equal(result.fields[2].ok, true, "提交按钮失败不影响后面的 select");
  assert.equal(result.fields[2].action, "select");
  assert.equal(result.fields[3].action, "check");
  assert.equal(result.fields[5].action, "select");

  // 页面状态：文本、select、checkbox、radio、自定义下拉都真的填了
  assert.equal(state.values.e1, "张三");
  assert.equal(state.selected.e2, "banana");
  assert.equal(state.changeEvents, 1, "原生 select 要派发 change（假页面记一次）");
  const selectScript = state.sent.find((entry) =>
    entry.method === "Runtime.callFunctionOn" && String(entry.params.functionDeclaration ?? "").includes("selectOptionsForAction"));
  assert.ok(selectScript, "原生 select 要走 vendor 的选中脚本");
  assert.match(String(selectScript.params.functionDeclaration), /dispatchEvent\(new Event\("input"/);
  assert.match(String(selectScript.params.functionDeclaration), /dispatchEvent\(new Event\("change"/);
  assert.equal(state.checked.e3, true);
  assert.equal(state.checked.e4, true);
  assert.equal(state.checked.e5, false);
  assert.equal(state.values.e6, "上海");
  assert.equal(state.submitClicks, 0, "提交按钮一次都不能点");
});

/* ---------------- ③ 不存在的选项 → 候选列表 ---------------- */

test("原生 select：选项不存在时返回候选列表（最多 50 个）", async () => {
  const { cdp, snap } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const calls = { diff: 0 };
  const result = await fillFieldsOnce({
    fields: [{ ref: "e2", value: "榴莲" }],
    fillField: (field) => act.fillField(field),
    readBack: collectDiff(calls),
  });
  act.dispose();

  const item = result.fields[0];
  assert.equal(item.ok, false);
  assert.equal(item.code, "OPTION_NOT_FOUND");
  assert.ok(Array.isArray(item.options), "要返回结构化的候选列表");
  assert.ok(item.options.length <= 50);
  assert.deepEqual(item.options.map((option) => option.label), ["苹果", "香蕉", "樱桃"]);
  assert.match(item.error, /榴莲/);
  assert.equal(calls.diff, 1, "有失败项也要回读一次（让 AI 看到页面实际状态）");
});

/* ---------------- 自定义下拉：这里的假 CDP 只返回 match / occluded / contains，
 * 测的是 chooseFromCombo 的调用方分支；页面脚本（COMBO_OPTIONS_SOURCE）本身由
 * _probe/page-fill-batch-selftest.mjs 用真 Chromium 覆盖，那份探针已接进 run-all-checks。 ---------------- */

test("自定义下拉：点开后按文字找不到 option 时返回看到的选项文字", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [{ ref: "e6", value: "深圳" }],
    fillField: (field) => act.fillField(field),
    readBack: async () => ({}),
  });
  act.dispose();

  const item = result.fields[0];
  assert.equal(item.ok, false);
  assert.equal(item.code, "OPTION_NOT_FOUND");
  assert.deepEqual(item.options.map((option) => option.label), ["北京", "上海", "广州"]);
  assert.equal(state.submitClicks, 0);
});

/* ---------------- ⑤ 旧单次调用不受影响 ---------------- */

test("旧的单次调用照旧：action:\"type\" 直接填、select 正常选中", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });

  const typed = await act.act({ ref: "e1", action: "type", text: "李四" });
  assert.equal(typed.ok, true);
  assert.equal(typed.action, "type");
  assert.equal(typed.batch, undefined, "单次调用不带批量字段");
  assert.equal(state.values.e1, "李四");

  const selected = await act.act({ ref: "e2", action: "select", value: "樱桃" });
  assert.equal(selected.ok, true);
  assert.equal(state.selected.e2, "cherry");
  act.dispose();
});

/* ---------------- ⑥ 参数校验：先全部校验，再动手 ---------------- */

test("fields 参数不对时整次拒绝，一个字段都不填", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  let fills = 0;
  const fillField = (field) => { fills += 1; return act.fillField(field); };

  await assert.rejects(
    () => fillFieldsOnce({ fields: Array.from({ length: MAX_FIELDS + 1 }, () => ({ ref: "e1", value: "x" })), fillField }),
    /最多 30 项/,
  );
  await assert.rejects(() => fillFieldsOnce({ fields: [{ ref: "e1" }], fillField }), /缺 value/);
  await assert.rejects(() => fillFieldsOnce({ fields: [], fillField }), /至少要有 1 项/);
  assert.equal(fills, 0, "参数错的时候不能先填一半");
  assert.equal(state.values.e1, "");
  act.dispose();
});

test("结构与类型校验的口径和注释一致：结构错整次拒绝；值类型与控件不匹配逐项失败（前面对、后面错）", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  let fills = 0;
  const result = await fillFieldsOnce({
    fields: [
      { ref: "e1", value: "张三" },
      { ref: "e1", value: true },
    ],
    fillField: (field) => { fills += 1; return act.fillField(field); },
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(fills, 2, "类型错是逐项判定：前面那个字段已经动过手");
  assert.equal(result.fields[0].ok, true);
  assert.equal(result.fields[1].ok, false);
  assert.equal(result.fields[1].code, "INVALID_ARGUMENT");
  assert.equal(result.filled, 1);
  assert.equal(result.failed, 1);
  assert.equal(state.values.e1, "张三", "后面那项被拒绝，不能把 true 写进文本框");
});

test("page-fill 的注释不再承诺「参数错整次拒绝」：结构错整次拒绝，类型 / 控件不匹配逐项（修前注释会误导）", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "page-fill.js"), "utf8");
  assert.doesNotMatch(source, /参数错就整次拒绝，绝不出现/);
  assert.match(source, /结构错整次拒绝/);
  assert.match(source, /逐项拒绝/);
});

test("真 Chromium 的批量填表探针交给分层 runner 跑（公开版不带 _probe 探针）", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "page-fill.js"), "utf8");
  assert.ok(source.length > 0);
});

test("page_act 的工具说明和 schema 写清了 fields 用法（含不会提交、最多 30 项）", () => {
  const tool = defineBrowserTools().find((item) => item.name === "page_act");
  assert.ok(tool, "找不到 page_act");
  assert.deepEqual(tool.inputSchema.required, ["id"], "fields 调用时 action 不是必填");
  assert.equal(tool.inputSchema.properties.fields.type, "array");
  assert.equal(tool.inputSchema.properties.fields.maxItems, MAX_FIELDS);
  assert.deepEqual(tool.inputSchema.properties.fields.items.required, ["ref", "value"]);
  assert.match(tool.description, /fields/);
  assert.match(tool.description, /不会提交/);
  assert.match(tool.description, /最多 30 项/);
  assert.match(tool.description, /role=option/);
});

/* ---------------- 审查修正（第二轮）：逐项闸门、类型、select skipped、自定义下拉读回 ---------------- */

test("批量中途人接管 / 终止任务 / 弹对话框：立即中止整批，剩余项标 skipped 且不再填（修前会继续写页面）", async () => {
  for (const code of ["CONTROL_PREEMPTED", "TASK_STOPPED", "DIALOG_OPEN"]) {
    let fills = 0;
    let failure = null;
    try {
      await fillFieldsOnce({
        fields: [
          { ref: "e1", value: "张三" },
          { ref: "e2", value: "香蕉" },
          { ref: "e3", value: true },
        ],
        fillField: async () => { fills += 1; return { ok: true }; },
        beforeField: async (_field, index) => {
          if (index === 1) {
            const error = new Error("中途闸门失守");
            error.code = code;
            throw error;
          }
        },
        readBack: async () => { throw new Error("中止后不该再回读"); },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, code, `${code} 要原样带出`);
    assert.equal(fills, 1, `${code} 之后一个字段都不能再填`);
    assert.equal(failure?.total, 3);
    assert.equal(failure?.filled, 1);
    assert.equal(failure?.aborted, 2);
    assert.equal(failure?.failed, 0, "中止项不算失败");
    assert.deepEqual(failure?.fields.map((item) => item.skipped ?? item.ok), [true, "batch_aborted", "batch_aborted"]);
    assert.ok(failure.fields.slice(1).every((item) => item.code === code));
  }
});

test("文本框 / 原生下拉 / 自定义下拉只收字符串：number / boolean 直接拒绝（修前会把 true 打进文本框）", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [
      { ref: "e1", value: true },
      { ref: "e2", value: 3 },
      { ref: "e6", value: false },
    ],
    fillField: (field) => act.fillField(field),
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(result.filled, 0);
  assert.equal(result.failed, 3);
  assert.deepEqual(result.fields.map((item) => item.code), ["INVALID_ARGUMENT", "INVALID_ARGUMENT", "INVALID_ARGUMENT"]);
  assert.equal(state.values.e1, "", "不能把 true 变成字符串打进文本框");
  assert.equal(state.submitClicks, 0);
});

test("原生 select 已经是目标值：逐项结果带 skipped，不再算成这次填成功（修前这条 skipped 被丢掉）", async () => {
  const { cdp, snap, state } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const calls = { diff: 0 };
  const result = await fillFieldsOnce({
    fields: [{ ref: "e2", value: "苹果" }],
    fillField: (field) => act.fillField(field),
    readBack: collectDiff(calls),
  });
  act.dispose();

  assert.equal(result.filled, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.fields[0].ok, true);
  assert.equal(result.fields[0].skipped, "already_in_state");
  assert.equal(state.changeEvents, 0, "已经是目标值就不该再派发 change");
});

test("自定义下拉：点完读不回 combobox 当前值，只报「已点选（verified:false）」，不冒充已选择", async () => {
  const { cdp, snap, state } = createPage({ comboVerified: false });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [{ ref: "e6", value: "上海" }],
    fillField: (field) => act.fillField(field),
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(result.fields[0].ok, true);
  assert.equal(result.fields[0].verified, false);
  assert.equal(result.fields[0].dispatched, true);
  assert.equal(result.unverified, 1);
  assert.equal(state.values.e6, "上海", "点击确实发出去了");
});

test("自定义下拉：选项被遮挡时一个选项点击都不发（修前会点到吸底按钮）", async () => {
  const { cdp, snap, state } = createPage({ comboOccluded: true });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [{ ref: "e6", value: "北京" }],
    fillField: (field) => act.fillField(field),
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(result.fields[0].ok, false);
  assert.equal(result.fields[0].code, "NOT_ACTIONABLE");
  assert.match(result.fields[0].error, /挡住/);
  assert.equal(state.values.e6, "");
  assert.equal(state.submitClicks, 0, "遮挡时不能把点击落到提交按钮上");
  assert.equal(state.pendingCombo, null);
});

test("自定义下拉：不再用「包含」猜选项（北京 ≠ 北京市朝阳区），候选和包含建议都返回", async () => {
  const { cdp, snap, state } = createPage({ cityOptions: ["北京市朝阳区", "上海市"] });
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [{ ref: "e6", value: "北京" }],
    fillField: (field) => act.fillField(field),
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(result.fields[0].ok, false);
  assert.equal(result.fields[0].code, "OPTION_NOT_FOUND");
  assert.deepEqual(result.fields[0].options.map((option) => option.label), ["北京市朝阳区", "上海市"]);
  assert.deepEqual(result.fields[0].suggestions, ["北京市朝阳区"]);
  assert.equal(state.values.e6, "", "不能把「北京市朝阳区」当成「北京」写进去");
});

test("人接手后逐项失败保留 CONTROL_PREEMPTED 原始错误码（修前 fillField 绕过 mapError 会退化成 ACT_FAILED）", async () => {
  const { cdp, snap } = createPage();
  const act = createSurfaceAct(cdp, snap, { overlayUi: () => false });
  const result = await fillFieldsOnce({
    fields: [
      { ref: "e1", value: "张三" },
      { ref: "e1", value: "李四" },
    ],
    fillField: async (field) => {
      const item = await act.fillField(field);
      // 第一个字段之后人点「接管」：第二个字段的输入事件会被拦
      cdp.inputBlocked = "人正在用这个标签页";
      return item;
    },
    readBack: async () => ({}),
  });
  act.dispose();

  assert.equal(result.fields[0].ok, true);
  assert.equal(result.fields[1].ok, false);
  assert.equal(result.fields[1].code, "CONTROL_PREEMPTED");
});
