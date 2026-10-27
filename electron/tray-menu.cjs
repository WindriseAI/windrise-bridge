/**
 * 托盘菜单模板（纯函数，不碰 Electron）：
 * main.cjs 用 Menu.buildFromTemplate(buildTrayTemplate(...)) 组装真菜单，
 * 自测直接检查返回的模板结构（不用真 Tray / Menu）。
 *
 * 结构（2026-10-26 产品计划第 3 步「托盘化」，中文）：
 *   打开 Windrise / 新建格子 / 所有格子（子菜单）/ — / 连接状态（只读）/ 复制 MCP 地址 /
 *   — / 设置与教程 / 开机启动（勾选）/ — / 退出
 */

/** 点菜单不抛错：托盘菜单的 click 里抛错会打断菜单，这里兜住只交给调用方看 */
function safeRun(handler, label, ...args) {
  try {
    const result = typeof handler === "function" ? handler(...args) : null;
    return result;
  } catch (error) {
    if (typeof console !== "undefined") {
      try { console.log(`[tray-menu] 「${label}」执行失败（忽略）：${error.message}`); } catch { /* 忽略 */ }
    }
    return null;
  }
}

/**
 * @param {{
 *   statusLine?: string,        // 「连接状态」一行的文字（已连接 / 未连接 + 域名），build 时算好
 *   grids?: Array<{id: string, name: string}>,  // 所有格子（账号）名单，照顺序列进子菜单
 *   autostartEnabled?: boolean, // 开机启动勾选状态
 *   copyMcpEnabled?: boolean,   // 复制 MCP 地址可不可点（连上了才可点）
 *   openWindrise?: () => void,  // 打开 / 聚焦格子 1
 *   newGrid?: () => void,       // 新建格子
 *   openGrid?: (id: string) => void,  // 打开 / 聚焦某个格子
 *   copyMcp?: () => void,       // 复制公网 MCP 地址
 *   settings?: () => void,      // 打开设置与教程（原来的管理窗口）
 *   toggleAutostart?: (enabled: boolean) => void,  // 开机启动勾选变化（Electron 已先把 checked 翻好）
 *   quit?: () => void,          // 退出
 * }} deps
 * @returns {Array<object>} 直接交给 Menu.buildFromTemplate 的模板
 */
function buildTrayTemplate(deps = {}) {
  const {
    statusLine = "未连接",
    grids = [],
    autostartEnabled = false,
    copyMcpEnabled = false,
    openWindrise, newGrid, openGrid, copyMcp, settings, toggleAutostart, quit,
  } = deps;
  const list = Array.isArray(grids) ? grids : [];
  return [
    { label: "打开 Windrise", click: () => safeRun(openWindrise, "打开 Windrise") },
    { label: "新建格子", click: () => safeRun(newGrid, "新建格子") },
    {
      label: "所有格子",
      submenu: list.length
        ? list.map((grid) => ({
          label: String(grid?.name || grid?.id || "未命名"),
          click: () => safeRun(openGrid, "打开格子", grid?.id),
        }))
        : [{ label: "（还没有格子）", enabled: false }],
    },
    { type: "separator" },
    { label: `连接状态：${statusLine}`, enabled: false },
    { label: "复制 MCP 地址", enabled: copyMcpEnabled === true, click: () => { if (copyMcpEnabled !== true) return; safeRun(copyMcp, "复制 MCP 地址"); } },
    { type: "separator" },
    { label: "设置与教程", click: () => safeRun(settings, "设置与教程") },
    { type: "checkbox", label: "开机启动", checked: autostartEnabled === true, click: (item) => safeRun(toggleAutostart, "开机启动", Boolean(item?.checked)) },
    { type: "separator" },
    { label: "退出", click: () => safeRun(quit, "退出") },
  ];
}

module.exports = { buildTrayTemplate };
