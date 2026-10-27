#!/usr/bin/env node
/**
 * 格子布局引擎自测（纯 Node，不需要浏览器、不开端口、不写文件）：
 *   node src/grid-layout-selftest.mjs
 *
 * 验 electron/grid-layout.cjs：
 *   - 1x1 / 1x2 / 2x2 / 3x3 的格子数量、编号顺序、整数像素、互不重叠、正好铺满；
 *   - 宽高是奇数、坐标是负数（副显示器在左边）时也不留缝；
 *   - 默认小窗口居中、宽 60%、高 70%；
 *   - 点某个格子换布局时：被点的变 slot 1，其它按原编号补位，不够的 create，多余的 hide。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LAYOUTS,
  computeLayout,
  defaultWindowBounds,
  planLayoutChange,
  layoutCapacity,
} = require("../electron/grid-layout.cjs");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  —— ${detail}` : ""}`);
};
const throwsCode = (fn, code) => {
  try {
    fn();
    return false;
  } catch (error) {
    return error.code === code;
  }
};

const area = { x: 100, y: 50, width: 1920, height: 1040 };

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const areaOf = (cell) => cell.width * cell.height;

/* ---------------- 1. 各布局的数量、铺满、不重叠 ---------------- */

for (const [layout, shape] of Object.entries(LAYOUTS)) {
  const cells = computeLayout(area, layout);
  const count = shape.rows * shape.cols;
  const allInteger = cells.every((c) => [c.x, c.y, c.width, c.height].every((n) => Number.isInteger(n)));
  const nonNegative = cells.every((c) => c.width > 0 && c.height > 0);
  const sum = cells.reduce((n, c) => n + areaOf(c), 0);
  const pairwise = cells.every((a, i) => cells.every((b, j) => i === j || !overlaps(a, b)));
  check(`${layout}：${count} 个格子，从 1 连续编号`, cells.length === count && cells.every((c, i) => c.slot === i + 1), cells.map((c) => c.slot).join(","));
  check(`${layout}：整数像素、宽高为正`, allInteger && nonNegative, JSON.stringify(cells[0]));
  check(`${layout}：面积合起来正好等于工作区，且互不重叠`, sum === areaOf(area) && pairwise, `sum=${sum} area=${areaOf(area)}`);
}

/* ---------------- 2. 编号顺序：左上为 1，按行排 ---------------- */

{
  const [left, right] = computeLayout(area, "1x2");
  check("1x2 是左右两格：slot 1 在左、slot 2 在右", left.x === area.x && right.x === area.x + area.width / 2 && left.y === right.y && left.width === right.width,
    JSON.stringify({ left, right }));
}
{
  const cells = computeLayout(area, "2x2");
  check("2x2 按行编号：1 左上、2 右上、3 左下、4 右下",
    cells[0].x === area.x && cells[0].y === area.y
    && cells[1].x > cells[0].x && cells[1].y === cells[0].y
    && cells[2].x === area.x && cells[2].y > cells[0].y
    && cells[3].x > cells[2].x && cells[3].y === cells[2].y,
    JSON.stringify(cells.map((c) => [c.slot, c.x, c.y])));
}
{
  const cells = computeLayout({ x: 0, y: 0, width: 1000, height: 1000 }, "3x3");
  check("3x3 第一行 slot 1/2/3 从左到右", cells.slice(0, 3).every((c, i) => c.y === 0 && (i === 0 || c.x > cells[i - 1].x)));
}

/* ---------------- 3. 奇数像素与副显示器坐标 ---------------- */

for (const [width, height] of [[1919, 1057], [1001, 667], [999, 1001]]) {
  for (const layout of ["1x2", "2x2", "3x3"]) {
    const odd = { x: -1920, y: 37, width, height };
    const cells = computeLayout(odd, layout);
    const rows = LAYOUTS[layout].rows;
    const cols = LAYOUTS[layout].cols;
    let exact = true;
    for (let row = 0; row < rows; row += 1) {
      const rowCells = cells.slice(row * cols, row * cols + cols);
      if (rowCells[0].x !== odd.x) exact = false;
      if (rowCells.at(-1).x + rowCells.at(-1).width !== odd.x + odd.width) exact = false;
      for (let i = 1; i < rowCells.length; i += 1) {
        if (rowCells[i].x !== rowCells[i - 1].x + rowCells[i - 1].width) exact = false;
      }
    }
    for (let col = 0; col < cols; col += 1) {
      const sameColumn = cells.filter((c, i) => i % cols === col);
      if (sameColumn[0].y !== odd.y) exact = false;
      if (sameColumn.at(-1).y + sameColumn.at(-1).height !== odd.y + odd.height) exact = false;
      for (let i = 1; i < sameColumn.length; i += 1) {
        if (sameColumn[i].y !== sameColumn[i - 1].y + sameColumn[i - 1].height) exact = false;
      }
    }
    check(`奇数像素 ${width}x${height} + 副显示器坐标，${layout} 仍然严丝合缝`,
      exact && cells.every((c) => Number.isInteger(c.x) && Number.isInteger(c.width) && Number.isInteger(c.y) && Number.isInteger(c.height)),
      JSON.stringify(cells.map((c) => [c.x, c.y, c.width, c.height])));
  }
}

/* ---------------- 4. 默认窗口 ---------------- */

{
  const bounds = defaultWindowBounds(area);
  check("默认窗口：宽约 60%、高约 70%",
    Math.abs(bounds.width - area.width * 0.6) <= 1 && Math.abs(bounds.height - area.height * 0.7) <= 1,
    JSON.stringify(bounds));
  check("默认窗口：在工作区里居中（左右、上下留白相差不超过 1 像素）",
    Math.abs((bounds.x - area.x) - (area.x + area.width - bounds.x - bounds.width)) <= 1
    && Math.abs((bounds.y - area.y) - (area.y + area.height - bounds.y - bounds.height)) <= 1,
    JSON.stringify(bounds));
  check("默认窗口：整数像素、不越出工作区",
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger)
    && bounds.x >= area.x && bounds.y >= area.y
    && bounds.x + bounds.width <= area.x + area.width
    && bounds.y + bounds.height <= area.y + area.height,
    JSON.stringify(bounds));
}
{
  const oddArea = { x: -1919, y: 3, width: 1919, height: 1057 };
  const bounds = defaultWindowBounds(oddArea);
  check("默认窗口：奇数像素、负坐标也不越界",
    bounds.x >= oddArea.x && bounds.y >= oddArea.y
    && bounds.x + bounds.width <= oddArea.x + oddArea.width
    && bounds.y + bounds.height <= oddArea.y + oddArea.height,
    JSON.stringify(bounds));
}

/* ---------------- 5. 换布局计划 ---------------- */

const grid = (id, slot, hidden = false) => ({ id, slot, hidden });

{
  const plan = planLayoutChange({
    openGrids: [grid("a", 1), grid("b", 2), grid("c", 3), grid("d", 4), grid("e", 5)],
    clickedId: "c",
    layout: "2x2",
  });
  check("2x2、5 个格子点 c：c 变 slot 1，其余按原编号补位",
    JSON.stringify(plan.assign) === JSON.stringify([{ id: "c", slot: 1 }, { id: "a", slot: 2 }, { id: "b", slot: 3 }, { id: "d", slot: 4 }]),
    JSON.stringify(plan.assign));
  check("2x2、5 个格子：不新建，第 5 个收起", plan.create === 0 && JSON.stringify(plan.hide) === JSON.stringify(["e"]), JSON.stringify({ create: plan.create, hide: plan.hide }));
}

{
  const plan = planLayoutChange({ openGrids: [grid("only", 1)], clickedId: "only", layout: "2x2" });
  check("2x2、只开 1 个：create 3 个", plan.assign.length === 1 && plan.create === 3 && plan.hide.length === 0,
    JSON.stringify(plan));
}

{
  const plan = planLayoutChange({
    openGrids: [grid("a", 1), grid("b", 2), grid("c", 3), grid("d", 4)],
    clickedId: "b",
    layout: "1x1",
  });
  check("1x1、4 个格子点 b：b 铺满 slot 1，其余按 1/3/4 的顺序收起",
    JSON.stringify(plan.assign) === JSON.stringify([{ id: "b", slot: 1 }])
    && JSON.stringify(plan.hide) === JSON.stringify(["a", "c", "d"])
    && plan.create === 0,
    JSON.stringify(plan));
}

{
  const plan = planLayoutChange({
    openGrids: [grid("a", 1), grid("b", 2), grid("c", 3)],
    clickedId: "c",
    layout: "1x2",
  });
  check("1x2、3 个格子点 c：c 在左、a 在右，b 收起",
    JSON.stringify(plan.assign) === JSON.stringify([{ id: "c", slot: 1 }, { id: "a", slot: 2 }])
    && JSON.stringify(plan.hide) === JSON.stringify(["b"]),
    JSON.stringify(plan));
}

{
  const plan = planLayoutChange({
    openGrids: [grid("a", 1), grid("b", 2, true), grid("c", 3), grid("d", 4, true)],
    clickedId: "c",
    layout: "1x1",
  });
  check("隐藏的格子也算已开：收起时仍按原 slot 顺序排（a、b、d）",
    JSON.stringify(plan.hide) === JSON.stringify(["a", "b", "d"]),
    JSON.stringify(plan.hide));
}

{
  const plan = planLayoutChange({
    openGrids: [grid("a", 1), grid("b", 2), grid("c", 3), grid("d", 4)],
    clickedId: "d",
    layout: "2x2",
  });
  check("已经正好装满 2x2：d 变 slot 1，其余按 1/2/3 补位，没有新建和收起",
    JSON.stringify(plan.assign) === JSON.stringify([{ id: "d", slot: 1 }, { id: "a", slot: 2 }, { id: "b", slot: 3 }, { id: "c", slot: 4 }])
    && plan.create === 0 && plan.hide.length === 0,
    JSON.stringify(plan));
}

{
  const plan = planLayoutChange({
    openGrids: [grid("a", null), grid("b", null), grid("clicked", null)],
    clickedId: "clicked",
    layout: "1x2",
  });
  check("都没 slot 时也能排：被点的在前，其余按名单顺序",
    JSON.stringify(plan.assign) === JSON.stringify([{ id: "clicked", slot: 1 }, { id: "a", slot: 2 }])
    && JSON.stringify(plan.hide) === JSON.stringify(["b"]),
    JSON.stringify(plan));
}

{
  check("不认识的布局直接报 INVALID_LAYOUT",
    throwsCode(() => computeLayout(area, "4x4"), "INVALID_LAYOUT")
    && throwsCode(() => planLayoutChange({ openGrids: [grid("a", 1)], clickedId: "a", layout: "2x3" }), "INVALID_LAYOUT"));
  check("点击的格子不在名单里报 UNKNOWN_CLICKED_GRID",
    throwsCode(() => planLayoutChange({ openGrids: [grid("a", 1)], clickedId: "zzz", layout: "1x1" }), "UNKNOWN_CLICKED_GRID"));
  check("工作区宽高不是正数报 INVALID_WORK_AREA",
    throwsCode(() => computeLayout({ x: 0, y: 0, width: 0, height: 100 }, "1x1"), "INVALID_WORK_AREA"));
  check("布局容量：1x1=1、1x2=2、2x2=4、3x3=9",
    layoutCapacity("1x1") === 1 && layoutCapacity("1×2") === 2 && layoutCapacity("2x2") === 4 && layoutCapacity("3x3") === 9);
}

/* ---------------- 汇总 ---------------- */

const failed = results.filter((item) => !item.ok);
console.log("");
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}/${results.length} 项${failed.length ? `，失败 ${failed.length} 项` : ""}`);
if (failed.length) {
  for (const item of failed) console.log(`  FAIL ${item.name}${item.detail ? `  —— ${item.detail}` : ""}`);
  process.exit(1);
}
console.log("格子布局引擎自测全部通过。");
