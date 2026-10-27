/**
 * 新标签页仪表盘：搜索框 + 连接状态 + 打开的格子 + 推荐位。
 * 不显示任何口令；格子点击走插件后台白名单，再转主程序。
 */

(() => {
  "use strict";

  const Dashboard = window.WindriseDashboard;
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const hint = document.getElementById("search-hint");

  function render(state) {
    Dashboard.render(state, { showSelf: false, showFacts: false, showRecent: false });
  }

  async function refresh() {
    render(await Dashboard.readState());
  }

  function setHint(text) {
    if (hint) hint.textContent = text;
  }

  /** 网址就打开；不像网址就用 Google 搜。只放行 http/https。 */
  function targetOf(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        return /^https?:$/.test(url.protocol) ? url.href : null;
      } catch {
        return null;
      }
    }
    if (/^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) {
      return `http://${text}`;
    }
    if (/^[^\s/]+\.[^\s/]+/.test(text)) return `https://${text}`;
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.isTrusted) return;
    const target = targetOf(input?.value);
    if (!target) {
      setHint("只打开 http / https 地址；要搜索就直接输入关键词。");
      return;
    }
    setHint("正在打开…");
    window.location.assign(target);
  });

  document.addEventListener("click", async (event) => {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target.closest("button[data-grid]") : null;
    if (!target) return;
    const slot = target.dataset.grid;
    if (!slot) return;
    const reply = await Dashboard.sendGridAction(`grid-open:${slot}`);
    const footer = document.getElementById("updated");
    if (footer) footer.textContent = reply?.ok ? `已让主程序打开格子 ${slot}。` : `没打开：${reply?.error || "主程序没接收"}`;
  });

  Dashboard.watchState(render);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  setInterval(() => { void refresh(); }, 15_000);
  void refresh();
  input?.focus();
})();
