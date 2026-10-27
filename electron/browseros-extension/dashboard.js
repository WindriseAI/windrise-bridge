/**
 * 侧边栏 / 新标签页共用的只读渲染。
 *
 * 数据只来自 chrome.storage.session 的 panelState（主程序经插件后台写入）。
 * 这里不发任何网络请求，也不用 innerHTML 拼状态（账号名、工具名可能有尖括号）。
 */

(() => {
  "use strict";

  const STATE_KEY = "panelState";
  const TUNNEL_LABELS = {
    cloudflare: "Cloudflare 快速隧道（临时地址）",
    "cloudflare-named": "Cloudflare 命名隧道（自己的域名）",
    ngrok: "ngrok",
  };
  const TIER_LABELS = { basic: "基础", full: "完整" };

  const $ = (id) => document.getElementById(id);

  function setText(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
  }

  function setBadge(id, text, tone) {
    const node = $(id);
    if (!node) return;
    node.textContent = text;
    node.className = "badge";
    if (tone) node.classList.add(tone);
  }

  function clock(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "--:--:--";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function readState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(STATE_KEY, (got) => {
          void chrome.runtime.lastError;
          const value = got && got[STATE_KEY];
          resolve(value && typeof value === "object" ? value : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function watchState(handler) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "session" || !changes[STATE_KEY]) return;
        const value = changes[STATE_KEY].newValue;
        handler(value && typeof value === "object" ? value : null);
      });
    } catch {
      /* 没有 onChanged 就只在打开页面时读一次 */
    }
  }

  /** 把面板动作交给插件后台：后台再按白名单转给主程序。extra 只认 tab（show-settings 跳转页） */
  function sendGridAction(action, extra = {}) {
    return new Promise((resolve) => {
      try {
        const message = { type: "grid-action", action };
        if (typeof extra?.tab === "string" && extra.tab) message.tab = extra.tab;
        chrome.runtime.sendMessage(message, (reply) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message });
          else resolve(reply || { ok: false, error: "主程序没有回应" });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 侧边栏偶尔没有剪贴板权限：退回到临时 textarea
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function renderEmptyList(id, text) {
    const node = $(id);
    if (!node) return;
    node.textContent = "";
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = text;
    node.appendChild(empty);
  }

  function renderGrids(state) {
    const node = $("grid-list");
    if (!node) return;
    const grids = Array.isArray(state?.grids) ? state.grids : [];
    if (!grids.length) {
      renderEmptyList("grid-list", "还没有打开的格子。打开一个账号后，它会出现在这里。");
      return;
    }
    const selfSlot = Number(state?.self?.slot);
    node.textContent = "";
    for (const item of grids) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "grid-item";
      const slot = Number(item?.slot);
      const hasSlot = Number.isInteger(slot) && slot > 0;
      row.disabled = !hasSlot;
      if (hasSlot) row.dataset.grid = String(slot);

      const slotText = document.createElement("span");
      slotText.className = "grid-slot";
      slotText.textContent = hasSlot ? `格子 ${slot}` : "格子 —";

      const name = document.createElement("span");
      name.className = "grid-name";
      name.textContent = typeof item?.name === "string" && item.name ? item.name : "（没有账号名）";

      row.append(slotText, name);

      if (hasSlot && slot === selfSlot && item?.hidden !== true) {
        const here = document.createElement("span");
        here.className = "tag here";
        here.textContent = "本格";
        row.appendChild(here);
      }
      if (item?.hidden === true) {
        const tag = document.createElement("span");
        tag.className = "tag hidden";
        tag.textContent = "已收起";
        row.appendChild(tag);
      }
      node.appendChild(row);
    }
  }

  function renderSpaces(state, currentSpaceId) {
    const node = $("space-list");
    if (!node) return;
    const spaces = Array.isArray(state?.spaces) ? state.spaces : [];
    if (!spaces.length) {
      renderEmptyList("space-list", "这个格子还没有空间。AI 开的空间会出现在这里。");
      return;
    }
    node.textContent = "";
    for (const item of spaces) {
      const row = document.createElement(item.owner === "ai" ? "button" : "div");
      row.className = item.owner === "ai" ? "grid-item space-item" : "space-item";
      if (item.owner === "ai") {
        row.type = "button";
        row.dataset.action = `space-focus:${item.id}`;
        row.title = "切到这个空间的主标签页";
      }

      const name = document.createElement("span");
      name.className = "space-name";
      name.textContent = typeof item?.name === "string" && item.name ? item.name : "（没名字的空间）";

      const tag = document.createElement("span");
      tag.className = item.owner === "ai" ? "tag ai" : "tag human";
      tag.textContent = item.owner === "ai" ? "AI" : "人";

      row.append(name, tag);

      // 当前空间：当前活动标签页所在标签组对应的 AI 空间；不在任何 AI 组里就是「我的」（由侧边栏算好传进来）
      if (currentSpaceId && item?.id === currentSpaceId) {
        const current = document.createElement("span");
        current.className = "tag here";
        current.textContent = "当前";
        row.appendChild(current);
      }

      if (item?.tabCount === 0) {
        const closed = document.createElement("span");
        closed.className = "tag closed";
        closed.textContent = "标签页没开";
        row.appendChild(closed);
      }
      node.appendChild(row);
    }
  }

  function renderRecent(state) {
    const node = $("recent-list");
    if (!node) return;
    const rows = Array.isArray(state?.recentActions) ? state.recentActions : [];
    if (!rows.length) {
      renderEmptyList("recent-list", "最近没有 AI 操作。");
      return;
    }
    node.textContent = "";
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "recent-row";

      const time = document.createElement("span");
      time.className = "recent-time";
      time.textContent = clock(item?.at);

      const tool = document.createElement("span");
      tool.className = "recent-tool";
      tool.title = typeof item?.tool === "string" ? item.tool : "";
      tool.textContent = typeof item?.tool === "string" ? item.tool : "（未知工具）";

      const result = document.createElement("span");
      result.className = item?.ok === true ? "ok-text" : "bad-text";
      result.textContent = item?.ok === true ? "成功" : "失败";

      row.append(time, tool, result);
      node.appendChild(row);
    }
  }

  function renderRecommendation(state) {
    const recommendation = state?.recommendation || {};
    const link = $("recommend-link");
    setText("recommend-title", recommendation.title || "暂无推荐");
    setText("recommend-desc", recommendation.description || "");
    if (link) {
      if (recommendation.url) {
        link.href = recommendation.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.removeAttribute("aria-disabled");
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
      }
    }
  }

  function renderFacts(state) {
    const provider = state?.tunnel?.provider || state?.connection?.provider || "";
    setText("tunnel-type", TUNNEL_LABELS[provider] || (provider ? String(provider) : "还没选连接方式"));
    setText("tool-tier", TIER_LABELS[state?.toolTier] || "基础");
    setText("broker-state", state?.adminBroker?.running === true ? "在运行" : "没在运行");
    setText("context-state", state?.sharedContext?.enabled === true ? "已开启" : "未开启");
  }

  function renderSelf(state) {
    const self = state?.self || {};
    const slot = Number(self.slot);
    const hasSlot = Number.isInteger(slot) && slot > 0;
    const name = typeof self.name === "string" && self.name ? self.name : "";
    setText("self-line", hasSlot ? `格子 ${slot}${name ? ` · ${name}` : ""}` : (name || "这个账号"));
    setText(
      "self-note",
      self.hidden === true
        ? "当前已收起（浏览器进程和登录态都还在）"
        : (hasSlot ? "正在屏幕内显示" : "现在没有位置编号"),
    );
  }

  function renderConnection(state) {
    const connection = state?.connection || {};
    const connected = connection.connected === true || connection.level === "connected";
    const label = connection.label || (connected ? "已连接" : "未连接");
    // 仅本机 / 连接中都用黄色：它们不是「坏了」，只是公网还没通
    const tone = connected ? "ok" : (connection.level === "connecting" || connection.level === "local" ? "warn" : "bad");
    setBadge("conn-badge", label, tone);
    setText("conn-level", connected ? `${label}（外部 AI 可以连进来）` : `${label}（外部 AI 现在连不进来）`);
    setText("conn-url", connection.publicUrl || "未打通，只有本机能用");
    const tokenCount = Number(connection.tokenCount) || 0;
    setText("token-count", tokenCount > 0 ? `已设置 ${tokenCount} 把` : "还没有设置口令");
    const copy = $("btn-copy-url");
    if (copy) copy.disabled = !connection.publicUrl;
    renderLicense(state);
  }

  /** 授权状态：只显示「已激活 / 未激活 + 到期日期」，激活码 / 设备密钥 / 许可证不会出现在 panelState 里 */
  function renderLicense(state) {
    const license = state?.license || {};
    const date = license.expiresAt ? new Date(license.expiresAt) : null;
    const when = date && !Number.isNaN(date.getTime())
      ? `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : null;
    const days = Number.isInteger(license.daysLeft) ? license.daysLeft : null;
    let text;
    if (license.activated === true) {
      text = "已激活";
      if (when) text += ` · 到 ${when}`;
      if (days != null) text += ` · 剩 ${days} 天`;
    } else {
      text = "未激活";
      if (when) text += `（已到期 ${when}）`;
    }
    setText("conn-license", text);
    // 未激活：显示「隧道需要激活」+ 打开设置按钮（复用 show-settings 动作，主程序窗口切到设置页）
    const row = $("license-activate-row");
    if (row) row.hidden = license.activated === true;
  }

  function renderUpdated(state) {
    const at = Number(state?.updatedAt);
    if (!Number.isFinite(at) || at <= 0) {
      setText("updated", "主程序还没推送状态。");
      return;
    }
    const stale = Date.now() - at > 20_000;
    setText("updated", `状态更新于 ${clock(at)}${stale ? "（可能已过期，确认主程序是否还在运行）" : ""}`);
  }

  /**
   * 把状态画进当前页面。页面里没有的元素会自动跳过（新标签页没有“最近操作”等区块）。
   *
   * @param {any} state panelState
   * @param {{showSelf?: boolean, showFacts?: boolean, showRecent?: boolean, currentSpace?: string|null}} [options]
   */
  function render(state, options = {}) {
    const showSelf = options.showSelf !== false;
    const showFacts = options.showFacts !== false;
    const showRecent = options.showRecent !== false;
    const currentSpace = typeof options.currentSpace === "string" ? options.currentSpace : null;
    if (!state) {
      if (showSelf) {
        setText("self-line", "等待主程序状态");
        setText("self-note", "打开一个格子后，主程序会自动推送。");
      }
      setBadge("conn-badge", "等待状态", "warn");
      setText("conn-level", "主程序还没推送状态");
      setText("conn-url", "—");
      setText("token-count", "—");
      setText("conn-license", "—");
      const licenseRow = $("license-activate-row");
      if (licenseRow) licenseRow.hidden = true;
      if (showFacts) {
        setText("tunnel-type", "—");
        setText("tool-tier", "—");
        setText("broker-state", "—");
        setText("context-state", "—");
      }
      renderEmptyList("grid-list", "等待状态。");
      if (showRecent) renderEmptyList("recent-list", "等待状态。");
      renderRecommendation(null);
      setText("updated", "主程序还没推送状态。");
      const copy = $("btn-copy-url");
      if (copy) copy.disabled = true;
      return;
    }
    if (showSelf) renderSelf(state);
    renderConnection(state);
    if (showFacts) renderFacts(state);
    renderGrids(state);
    renderSpaces(state, currentSpace);
    if (showRecent) renderRecent(state);
    renderRecommendation(state);
    renderUpdated(state);
  }

  window.WindriseDashboard = {
    STATE_KEY,
    readState,
    watchState,
    sendGridAction,
    copyText,
    clock,
    render,
  };
})();
