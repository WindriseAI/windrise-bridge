/**
 * 页面左下角的格子按钮（content script）。
 *
 * 它只做三件事：显示「格子 N」、鼠标移上去弹面板、把布局 / 收起动作交给插件后台。
 *
 * 三条硬规矩（需求点名）：
 *   1. 用 closed Shadow DOM：页面脚本拿不到 shadowRoot，改不了也读不到按钮里的内容；
 *   2. 不读取页面 DOM 内容：除了把自己那个 host 节点挂到 documentElement，不查页面文字、不查元素；
 *   3. 位置固定在网页区域左下角（距左 8px、距底 8px），不碰右侧滚动条。
 *
 * 编号和账号名由 service worker 经 chrome.storage.session 下发；这里只读这一项。
 */

(() => {
  "use strict";

  if (globalThis.__windriseGridContentInstalled) return;
  globalThis.__windriseGridContentInstalled = true;

  const BUTTON_TEXT = "格子";
  const PANEL_HIDE_MS = 400;
  const LAYOUT_ACTIONS = [
    { action: "layout:1x1", label: "1×1" },
    { action: "layout:1x2", label: "1×2" },
    { action: "layout:2x2", label: "2×2" },
    { action: "layout:3x3", label: "3×3" },
  ];

  const state = { slot: 0, name: "" };
  let host = null;
  let shadow = null;
  let button = null;
  let panel = null;
  let slotLine = null;
  let nameLine = null;
  let hintLine = null;
  let hideTimer = null;
  /** 当前窗口号：打开侧边栏要在用户手势里同步调用 chrome.sidePanel.open */
  let currentWindowId = null;

  function render() {
    if (!button) return;
    const label = state.slot > 0 ? `${BUTTON_TEXT} ${state.slot}` : BUTTON_TEXT;
    button.textContent = label;
    button.title = state.slot > 0 ? `格子 ${state.slot}${state.name ? ` · ${state.name}` : ""}` : "账号格子";
    if (slotLine) slotLine.textContent = state.slot > 0 ? `格子 ${state.slot}` : "格子";
    if (nameLine) nameLine.textContent = state.name || (state.slot > 0 ? "（账号名还没拿到）" : "（编号还没拿到）");
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    // host 自己也要挡住页面样式：有些站点会给 div 加全局样式，把位置顶跑
    host.style.cssText = [
      "position:fixed!important",
      "left:8px!important",
      "bottom:8px!important",
      "z-index:2147483647!important",
      "display:block!important",
      "width:auto!important",
      "height:auto!important",
      "margin:0!important",
      "padding:0!important",
      "border:0!important",
      "background:transparent!important",
      "pointer-events:auto!important",
    ].join(";");
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .wrap { position: relative; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2328; }
      button { font: inherit; cursor: pointer; }
      .tab {
        display: inline-flex; align-items: center; gap: 4px;
        min-height: 24px; padding: 4px 10px; border-radius: 12px;
        border: 1px solid rgba(0,0,0,.18); background: rgba(255,255,255,.94);
        color: #1f2328; box-shadow: 0 2px 8px rgba(0,0,0,.16);
        user-select: none; white-space: nowrap;
      }
      .tab:hover { background: #fff; }
      .panel {
        position: absolute; left: 0; bottom: 34px; width: 210px;
        box-sizing: border-box; padding: 10px; border-radius: 10px;
        border: 1px solid rgba(0,0,0,.16); background: #fff;
        box-shadow: 0 8px 28px rgba(0,0,0,.22);
      }
      .panel[hidden] { display: none; }
      .slot { font-weight: 600; font-size: 13px; }
      .name { margin-top: 2px; color: #57606a; word-break: break-all; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
      .layout {
        padding: 6px 0; border-radius: 6px; border: 1px solid #d0d7de;
        background: #f6f8fa; color: #1f2328;
      }
      .layout:hover { background: #eaeef2; }
      .hide {
        width: 100%; margin-top: 8px; padding: 6px 0; border-radius: 6px;
        border: 1px solid #d0d7de; background: #fff; color: #b42318;
      }
      .hide:hover { background: #fff5f4; }
      .more {
        width: 100%; margin-top: 6px; padding: 6px 0; border-radius: 6px;
        border: 1px solid #d0d7de; background: #fff; color: #0969da; text-align: left;
        padding-left: 8px;
      }
      .more:hover { background: #f6f8fa; }
      .hint { margin-top: 6px; color: #8c959f; font-size: 11px; }
    `;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.setAttribute("aria-label", "账号格子");

    panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;

    slotLine = document.createElement("div");
    slotLine.className = "slot";
    nameLine = document.createElement("div");
    nameLine.className = "name";

    const grid = document.createElement("div");
    grid.className = "grid";
    for (const item of LAYOUT_ACTIONS) {
      const layoutButton = document.createElement("button");
      layoutButton.type = "button";
      layoutButton.className = "layout";
      layoutButton.textContent = item.label;
      layoutButton.dataset.action = item.action;
      grid.appendChild(layoutButton);
    }

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "hide";
    hideButton.dataset.action = "hide-self";
    hideButton.textContent = "收起这一格";

    const moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.className = "more";
    moreButton.dataset.action = "open-side-panel";
    moreButton.textContent = "更多 → 打开侧边栏";

    hintLine = document.createElement("div");
    hintLine.className = "hint";
    hintLine.textContent = "只作用于这个账号窗口";

    panel.append(slotLine, nameLine, grid, hideButton, moreButton, hintLine);
    wrap.append(button, panel);
    shadow.append(style, wrap);

    const clearHideTimer = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const showPanel = () => {
      clearHideTimer();
      panel.hidden = false;
    };
    const scheduleHide = () => {
      clearHideTimer();
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (panel) panel.hidden = true;
      }, PANEL_HIDE_MS);
    };

    host.addEventListener("mouseenter", () => {
      showPanel();
      // 每次鼠标移上来都重新问一次编号：页面加载时后台可能还没把编号推过来（真机踩到按钮只显示「格子」）
      try { chrome.runtime.sendMessage({ type: "get-grid-info" }, (reply) => { void chrome.runtime.lastError; applyInfo(reply?.gridInfo); }); } catch { /* 插件不在就算了 */ }
    });
    host.addEventListener("mouseleave", scheduleHide);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (panel.hidden) showPanel(); else scheduleHide();
    });
    panel.addEventListener("click", (event) => {
      // 只认真人点击：网页脚本伪造的 click（dispatchEvent / element.click()）isTrusted 为 false，一律不发动作
      if (!event.isTrusted) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.getAttribute("data-action");
      if (!action) return;
      if (action === "open-side-panel") {
        openSidePanel();
      } else {
        sendAction(action);
      }
      panel.hidden = true;
    });

    // 侧边栏只能由用户手势打开：先在这里把窗口号问好，点击时同步调 open（不要再 await）
    try {
      chrome.windows?.getCurrent?.((win) => {
        if (Number.isInteger(win?.id) && win.id >= 0) currentWindowId = win.id;
      });
    } catch {
      /* 拿不到窗口号：退回让后台用 sender.tab.windowId 打开 */
    }

    (document.documentElement || document.body).appendChild(host);
    render();
  }

  /** 只发动作，不读页面；后台会再校验白名单，主程序还会校验第二次 */
  function sendAction(action) {
    try {
      chrome.runtime.sendMessage({ type: "grid-action", action }, () => {
        // 读取 lastError 防止未处理的回调错误；取值本身没有用
        void chrome.runtime.lastError;
      });
    } catch {
      /* 插件被禁用 / 页面正在卸载：不弹任何东西 */
    }
  }

  /**
   * 打开侧边栏。优先在 content script 里直接调（用户手势还在）；
   * 这个构建没给 content script 暴露 sidePanel 时，退回后台，带上 sender.tab.windowId。
   */
  function openSidePanel() {
    try {
      if (typeof chrome.sidePanel?.open === "function") {
        const options = Number.isInteger(currentWindowId) ? { windowId: currentWindowId } : {};
        const result = chrome.sidePanel.open(options);
        result?.catch?.(() => sendOpenSidePanelMessage());
        return;
      }
    } catch {
      /* 走后台兜底 */
    }
    sendOpenSidePanelMessage();
  }

  function sendOpenSidePanelMessage() {
    try {
      chrome.runtime.sendMessage({ type: "open-side-panel" }, (reply) => {
        const error = chrome.runtime.lastError;
        if ((error || !reply?.ok) && hintLine) {
          hintLine.textContent = "打不开侧边栏：点工具栏上的 Windrise 图标";
        }
      });
    } catch {
      if (hintLine) hintLine.textContent = "打不开侧边栏：点工具栏上的 Windrise 图标";
    }
  }

  function applyInfo(value) {
    if (!value || typeof value !== "object") return;
    const slot = Number(value.slot);
    state.slot = Number.isInteger(slot) && slot > 0 ? slot : 0;
    state.name = typeof value.name === "string" ? value.name : "";
    render();
  }

  function readInfo() {
    try {
      if (chrome.storage?.session?.get) {
        chrome.storage.session.get("gridInfo").then((got) => applyInfo(got?.gridInfo)).catch(() => {
          chrome.runtime.sendMessage({ type: "get-grid-info" }, (reply) => applyInfo(reply?.gridInfo));
        });
      } else {
        chrome.runtime.sendMessage({ type: "get-grid-info" }, (reply) => applyInfo(reply?.gridInfo));
      }
    } catch {
      /* 拿不到编号也照样显示「格子」按钮 */
    }
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === "session" && changes.gridInfo) applyInfo(changes.gridInfo.newValue);
      });
    } catch {
      /* 没有 storage.onChanged 就算了，下次加载会重新读 */
    }
  }

  function start() {
    build();
    readInfo();
  }

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
