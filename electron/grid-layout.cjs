/**
 * 格子布局引擎（纯函数，不 require electron）。
 *
 * 这里只算「每个格子该摆在哪」，不碰窗口、不碰浏览器：
 *   - computeLayout(workArea, layout)：把一块工作区按 1x1 / 1x2 / 2x2 / 3x3 切开；
 *   - defaultWindowBounds(workArea)：默认小窗口的位置（居中，宽 60%、高 70%）；
 *   - planLayoutChange(...)：人点了某个格子、选了布局以后，谁补到第几格、还要新建几个、哪几个要收起。
 *
 * 几条硬要求：
 *   1. 坐标一律整数像素；按行编号，左上角是 1。
 *   2. 格子之间不能重叠，合起来正好铺满工作区（宽高除不尽时把余数分给后面几格）。
 *   3. 纯 Node 可测，不 require electron —— 工作区由调用方（Electron 的 screen 或测试里的假函数）给。
 */

"use strict";

/** 支持的布局：行列数固定。1x2 是左右两格，不是上下两格。 */
const LAYOUTS = Object.freeze({
  "1x1": Object.freeze({ rows: 1, cols: 1 }),
  "1x2": Object.freeze({ rows: 1, cols: 2 }),
  "2x2": Object.freeze({ rows: 2, cols: 2 }),
  "3x3": Object.freeze({ rows: 3, cols: 3 }),
});

const LAYOUT_NAMES = Object.keys(LAYOUTS);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 工作区校验：缺 x / y 按 0 算；宽高必须是正数。小数先四舍五入成整数像素。 */
function normalizeWorkArea(workArea) {
  if (!workArea || typeof workArea !== "object") {
    throw codedError("INVALID_WORK_AREA", "computeLayout 需要一个工作区对象 {x, y, width, height}");
  }
  const width = Math.round(numberOr(workArea.width, NaN));
  const height = Math.round(numberOr(workArea.height, NaN));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw codedError("INVALID_WORK_AREA", `工作区的宽高必须是正数（收到 width=${String(workArea.width)}、height=${String(workArea.height)}）`);
  }
  return {
    x: Math.round(numberOr(workArea.x, 0)),
    y: Math.round(numberOr(workArea.y, 0)),
    width,
    height,
  };
}

/** 布局名规范化：认大小写、全角乘号、空格；别的值直接报错，别悄悄回落到 1x1。 */
function normalizeLayout(layout) {
  const text = String(layout ?? "")
    .trim()
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/\s+/g, "");
  if (!Object.prototype.hasOwnProperty.call(LAYOUTS, text)) {
    throw codedError("INVALID_LAYOUT", `不认识的布局「${String(layout)}」；只能是 ${LAYOUT_NAMES.join(" / ")}`);
  }
  return text;
}

function layoutCapacity(layout) {
  const { rows, cols } = LAYOUTS[normalizeLayout(layout)];
  return rows * cols;
}

/**
 * 把工作区按布局切开。
 *
 * 边界算法：用「总宽 × 列号 / 总列数」向下取整算每条竖线的位置，下一格从上一格的右边界开始。
 * 这样宽高是奇数（例如 1919 / 3）时也不会出现 1 像素的空隙或重叠，最后一格的右边正好是工作区右边。
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {"1x1"|"1x2"|"2x2"|"3x3"|string} layout
 * @returns {{slot:number,x:number,y:number,width:number,height:number}[]}
 */
function computeLayout(workArea, layout) {
  const area = normalizeWorkArea(workArea);
  const key = normalizeLayout(layout);
  const { rows, cols } = LAYOUTS[key];
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const top = area.y + Math.floor((area.height * row) / rows);
    const bottom = area.y + Math.floor((area.height * (row + 1)) / rows);
    for (let col = 0; col < cols; col += 1) {
      const left = area.x + Math.floor((area.width * col) / cols);
      const right = area.x + Math.floor((area.width * (col + 1)) / cols);
      cells.push({
        slot: row * cols + col + 1,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    }
  }
  return cells;
}

/**
 * 默认小窗口：工作区居中，宽 60%、高 70%。
 * 只给「开一个新格子时摆哪儿」用；调用方要把它换成 Browser.setWindowBounds 的 left / top。
 */
function defaultWindowBounds(workArea) {
  const area = normalizeWorkArea(workArea);
  const width = Math.max(1, Math.round(area.width * 0.6));
  const height = Math.max(1, Math.round(area.height * 0.7));
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

/** 原 slot 排序：没编号（隐藏过、还没排过）的放最后，同号按输入顺序，保证结果稳定。 */
function slotOrder(item, index) {
  const slot = Number(item?.slot);
  return {
    slot: Number.isFinite(slot) && slot > 0 ? slot : Number.MAX_SAFE_INTEGER,
    index,
  };
}

/**
 * 点了一个格子、选了一个布局以后，算出怎么排。
 *
 * 规则（需求原文）：
 *   - 被点的格子变 slot 1；
 *   - 其它已开格子按原来的 slot 顺序补 2、3、4……（隐藏但还开着的格子也算，切回大布局时能摆回来）；
 *   - 不够的 create 几个（由调用方去建账号、开窗口）；
 *   - 超过这个布局容量的 hide（不关进程，只挪走）。
 *
 * bounds 不在这里算：调用方拿到 assign 以后按实际显示器的工作区去切。
 *
 * @param {{openGrids?: {id:any,slot?:number|null,hidden?:boolean}[], clickedId:any, layout:string}} input
 * @returns {{assign:{id:any,slot:number}[], create:number, hide:any[]}}
 */
function planLayoutChange({ openGrids = [], clickedId, layout } = {}) {
  const key = normalizeLayout(layout);
  const capacity = LAYOUTS[key].rows * LAYOUTS[key].cols;

  const seen = new Set();
  const grids = [];
  for (const item of Array.isArray(openGrids) ? openGrids : []) {
    if (!item || item.id === undefined || item.id === null) continue;
    const marker = String(item.id);
    if (seen.has(marker)) continue;
    seen.add(marker);
    grids.push({ id: item.id, slot: item.slot, hidden: Boolean(item.hidden) });
  }

  if (clickedId === undefined || clickedId === null || String(clickedId) === "") {
    throw codedError("INVALID_ARGUMENT", "planLayoutChange 需要 clickedId（人点的是哪个格子）");
  }
  const clicked = grids.find((item) => String(item.id) === String(clickedId));
  if (!clicked) {
    throw codedError("UNKNOWN_CLICKED_GRID", `点击的格子 ${String(clickedId)} 不在已开格子名单里`);
  }

  const others = grids
    .filter((item) => item !== clicked)
    .map((item, index) => ({ item, ...slotOrder(item, index) }))
    .sort((a, b) => (a.slot - b.slot) || (a.index - b.index))
    .map((entry) => entry.item);

  const ordered = [clicked, ...others];
  const kept = ordered.slice(0, capacity);
  const overflow = ordered.slice(capacity);

  return {
    assign: kept.map((item, index) => ({ id: item.id, slot: index + 1 })),
    create: Math.max(0, capacity - ordered.length),
    hide: overflow.map((item) => item.id),
  };
}

module.exports = {
  LAYOUTS,
  LAYOUT_NAMES,
  normalizeLayout,
  normalizeWorkArea,
  layoutCapacity,
  computeLayout,
  defaultWindowBounds,
  planLayoutChange,
};
