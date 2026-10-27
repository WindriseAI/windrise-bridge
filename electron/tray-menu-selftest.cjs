/**
 * 托盘菜单模板自测（纯 Node，用假 Tray / Menu：不碰 Electron）：
 *   node electron/tray-menu-selftest.cjs
 *
 * 覆盖（2026-10-26 产品计划第 3 步的菜单结构，中文）：
 *   1. 顺序和标签：打开 Windrise / 新建格子 / 所有格子（子菜单）/ — / 连接状态（只读）/
 *      复制 MCP 地址 / — / 设置与教程 / 开机启动（勾选）/ — / 退出；
 *   2. 连接状态一行只读、只有「已连接 / 未连接 + 域名」；
 *   3. 复制 MCP 地址：没连上不可点，连上可点且 click 触发复制；
 *   4. 所有格子：按名单顺序列子菜单，点了调 openGrid(id)；没有格子是置灰一行；
 *   5. 开机启动勾选状态跟着 autostartEnabled，click 把翻转后的值交给 toggleAutostart；
 *   6. 各项 click 都触发对应回调；回调抛错不炸菜单（safeRun 兜住）。
 */

const { buildTrayTemplate } = require("./tray-menu.cjs");

const results = [];
const record = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${name}${detail ? `\n        ${detail}` : ""}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const check = async (id, name, fn) => {
  try { record(id, name, true, (await fn()) || ""); }
  catch (error) { record(id, name, false, error.message); }
};

/** 假 Menu.buildFromTemplate：验一遍每个条目都是 Electron 菜单认识的形状 */
function fakeMenuBuild(template) {
  for (const item of template) {
    assert(item && typeof item === "object", "条目必须是对象");
    if (item.type === "separator") continue;
    if (item.type === "checkbox") {
      assert(typeof item.label === "string" && typeof item.checked === "boolean" && typeof item.click === "function", `checkbox 形状不对：${JSON.stringify(item)}`);
      continue;
    }
    assert(typeof item.label === "string", `label 必须是字符串：${JSON.stringify(item)}`);
    if ("enabled" in item) assert(typeof item.enabled === "boolean", `enabled 必须是布尔：${JSON.stringify(item)}`);
    if (item.submenu) {
      assert(Array.isArray(item.submenu), "submenu 必须是数组");
      fakeMenuBuild(item.submenu);
    } else if ("click" in item) {
      assert(typeof item.click === "function", `click 必须是函数：${JSON.stringify(item)}`);
    }
  }
  return template;
}

const noop = () => {};

(async () => {
  await check("t1", "结构顺序与标签（全中文）", () => {
    const template = buildTrayTemplate({});
    fakeMenuBuild(template);
    const shapes = template.map((item) => item.type === "separator" ? "—" : (item.type === "checkbox" ? `☑${item.label}` : item.label));
    assert(shapes.join(" | ") === "打开 Windrise | 新建格子 | 所有格子 | — | 连接状态：未连接 | 复制 MCP 地址 | — | 设置与教程 | ☑开机启动 | — | 退出", shapes.join(" | "));
    return shapes.join(" | ");
  });
  await check("t2", "连接状态一行只读、文字带状态和域名", () => {
    const template = buildTrayTemplate({ statusLine: "已连接 · abc.trycloudflare.com" });
    const item = template[4];
    assert(item.label === "连接状态：已连接 · abc.trycloudflare.com", item.label);
    assert(item.enabled === false, "状态行必须置灰（只读）");
    assert(item.click === undefined, "状态行不该有 click");
    return item.label;
  });
  await check("t3", "复制 MCP 地址：没连上置灰，连上可点且触发复制", () => {
    const calls = [];
    const off = buildTrayTemplate({ copyMcpEnabled: false, copyMcp: () => calls.push("copy") });
    assert(off[5].enabled === false, "没连上应为置灰");
    off[5].click();   // 置灰也点了不该触发（Electron 层面 disabled 不触发 click，这里再守一道）
    assert(calls.length === 0, `置灰不该触发复制：${calls.length}`);
    const on = buildTrayTemplate({ copyMcpEnabled: true, copyMcp: () => calls.push("copy") });
    assert(on[5].enabled === true, "连上应为可点");
    on[5].click();
    assert(calls.length === 1, `该触发一次复制：${calls.length}`);
    return calls.join(",");
  });
  await check("t4", "所有格子：按名单顺序列子菜单，点了调 openGrid(id)", () => {
    const opened = [];
    const template = buildTrayTemplate({
      grids: [{ id: "a", name: "格子 1" }, { id: "b", name: "格子 2" }, { id: "c", name: "工作号" }],
      openGrid: (id) => opened.push(id),
    });
    const submenu = template[2].submenu;
    assert(submenu.map((i) => i.label).join(",") === "格子 1,格子 2,工作号", submenu.map((i) => i.label).join(","));
    submenu[0].click(); submenu[2].click();
    assert(opened.join(",") === "a,c", opened.join(","));
    return `子菜单 ${submenu.length} 项，点了 ${opened.join(",")}`;
  });
  await check("t5", "没有格子：子菜单一行置灰", () => {
    const template = buildTrayTemplate({ grids: [] });
    const submenu = template[2].submenu;
    assert(submenu.length === 1 && submenu[0].enabled === false && submenu[0].label === "（还没有格子）", JSON.stringify(submenu));
    return submenu[0].label;
  });
  await check("t6", "开机启动勾选：状态跟着 autostartEnabled，click 交翻转后的值", () => {
    const toggles = [];
    const on = buildTrayTemplate({ autostartEnabled: true, toggleAutostart: (v) => toggles.push(v) });
    assert(on[8].type === "checkbox" && on[8].checked === true, JSON.stringify(on[8]));
    on[8].click({ checked: false });
    assert(toggles.join(",") === "false", toggles.join(","));
    const off = buildTrayTemplate({ autostartEnabled: false, toggleAutostart: (v) => toggles.push(v) });
    assert(off[8].checked === false, JSON.stringify(off[8]));
    off[8].click({ checked: true });
    assert(toggles.join(",") === "false,true", toggles.join(","));
    return toggles.join(",");
  });
  await check("t7", "各项 click 触发对应回调（打开 / 新建 / 设置 / 退出）", () => {
    const calls = [];
    const template = buildTrayTemplate({
      openWindrise: () => calls.push("open"),
      newGrid: () => calls.push("new"),
      settings: () => calls.push("settings"),
      quit: () => calls.push("quit"),
    });
    template[0].click(); template[1].click(); template[7].click(); template[10].click();
    assert(calls.join(",") === "open,new,settings,quit", calls.join(","));
    return calls.join(",");
  });
  await check("t8", "回调抛错不炸菜单（safeRun 兜住）", () => {
    const template = buildTrayTemplate({
      openWindrise: () => { throw new Error("boom"); },
    });
    template[0].click();   // 不抛就过
    return "抛错被兜住，菜单不炸";
  });

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n通过 ${passed}/${results.length}（Node ${process.versions.node}，未加载 Electron）`);
  process.exit(passed === results.length ? 0 : 1);
})();
