/**
 * 侧边栏：把 panelState 画出来，把按钮动作交给插件后台（白名单）再转主程序。
 * 复制公网地址在本地用 navigator.clipboard 做，不经过主程序。
 *
 * 钉住（快速访问）：
 *   数据在 chrome.storage.local（键 windrise.pins，见 pins.js），侧边栏是插件页面，直接读写，不经过主程序；
 *   校验和 sw.js 共用同一套（pins.js 里的纯函数）。
 *   当前空间 = 当前活动标签页所在标签组对应的 AI 空间；不在任何 AI 组里就是「我的」（home）。
 *   渲染一律 textContent，不拼 HTML；不往外发请求（图标是首字母方块，不是 favicon）。
 *
 * Cookie 导入：
 *   只认用户自己用 Cookie 导出插件生成的文件；选文件 → 预览 → 人点「确认导入」后才逐条 chrome.cookies.set。
 *   cookie 值不写日志、不进 chrome.storage、不显示在界面（只显示条数和域名）。
 */

(() => {
  "use strict";

  const Dashboard = window.WindriseDashboard;
  const Pins = window.__windrisePins || null;
  const CookieImport = window.__windriseCookieImport || null;
  const PINS_KEY = Pins ? Pins.PINS_KEY : "windrise.pins";
  const hint = document.getElementById("action-hint");
  let currentState = null;
  // 当前空间：AI 空间 id（活动标签页在它的标签组里）或 "home"（「我的」）
  let currentSpaceId = "home";
  // 当前活动标签页是不是 http / https（钉住当前页要 http/https 才行）
  let activeTabHttp = false;
  // 预览好的 Cookie 计划只在内存里，确认前不写任何地方
  let pendingCookieImport = null;
  let cookieBusy = false;
  // 连续选文件时只认最后一次读取，避免旧文件的预览盖掉新文件
  let cookiePreviewSeq = 0;

  function setHint(text) {
    if (hint) hint.textContent = text;
  }

  const spaceById = (id) => ((Array.isArray(currentState?.spaces) ? currentState.spaces : [])).find((space) => space?.id === id) || null;
  const spaceName = (id) => spaceById(id)?.name || id;

  /** 看当前活动标签页在哪个标签组里，对回空间清单，定出「当前空间」 */
  async function resolveActive() {
    let groupId = null;
    let url = "";
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      if (tab) {
        if (typeof tab.groupId === "number" && tab.groupId >= 0) groupId = tab.groupId;
        url = typeof tab.url === "string" ? tab.url : "";
      }
    } catch {
      /* 拿不到活动标签页：按「我的」处理 */
    }
    activeTabHttp = /^https?:/i.test(url);
    const spaces = Array.isArray(currentState?.spaces) ? currentState.spaces : [];
    const hit = spaces.find((space) => space.owner === "ai" && typeof space.groupId === "number" && space.groupId === groupId);
    currentSpaceId = hit ? hit.id : "home";
  }

  /* ---------------- 钉住区 ---------------- */

  function renderPins(pins) {
    const node = document.getElementById("pin-list");
    if (!node) return;
    node.textContent = "";
    const space = document.getElementById("pin-space-name");
    if (space) space.textContent = spaceName(currentSpaceId);
    if (!Array.isArray(pins) || !pins.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "这个空间还没有钉住。点上面的「钉住当前页」，或让 AI 用 pin_add 钉。";
      node.appendChild(empty);
      return;
    }
    for (const pin of pins) {
      const row = document.createElement("div");
      row.className = "pin-row";

      const icon = document.createElement("span");
      icon.className = "pin-icon";
      const title = typeof pin?.title === "string" ? pin.title : "";
      const letter = title.trim().charAt(0) || "?";
      icon.textContent = /[a-z]/i.test(letter) ? letter.toUpperCase() : letter;

      const open = document.createElement("button");
      open.type = "button";
      open.className = "pin-open";
      if (typeof pin?.url === "string" && pin.url) open.dataset.pinUrl = pin.url;
      open.title = typeof pin?.url === "string" ? pin.url : "";

      const name = document.createElement("span");
      name.className = "pin-title";
      name.textContent = title || "（没有标题）";
      open.appendChild(name);

      if (pin?.by === "ai") {
        const tag = document.createElement("span");
        tag.className = "tag ai";
        tag.textContent = "AI";
        open.appendChild(tag);
      }

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pin-del";
      del.title = "取消钉住";
      del.textContent = "×";
      if (typeof pin?.id === "string" && pin.id) del.dataset.pinId = pin.id;

      row.append(icon, open, del);
      node.appendChild(row);
    }
  }

  function updatePinButton() {
    const button = document.getElementById("btn-pin-current");
    if (button) button.disabled = !activeTabHttp;
  }

  async function refreshPins() {
    if (!Pins) {
      renderPins([]);
      updatePinButton();
      return;
    }
    let pins = [];
    try {
      const result = await Pins.pinList({ space: currentSpaceId });
      pins = result?.ok ? (result.pins ?? []) : [];
    } catch {
      pins = [];
    }
    renderPins(pins);
    updatePinButton();
  }

  /** 点一条钉住：在当前窗口新开标签页；当前空间是 AI 空间就把新标签页并进它的标签组（人点的，可以切前台） */
  async function openPinned(url) {
    if (!/^https?:/i.test(String(url || ""))) {
      setHint("这条钉住的网址不是 http / https，不打开。");
      return;
    }
    const space = spaceById(currentSpaceId);
    const groupId = space && space.owner === "ai" && typeof space.groupId === "number" && space.groupId >= 0 ? space.groupId : null;
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      if (groupId !== null && tab && typeof tab.id === "number") {
        try {
          await chrome.tabs.group({ groupId, tabIds: [tab.id] });
        } catch {
          /* 并不进标签组就算了：网页已经打开了，别因为分组失败搞得像没打开 */
        }
      }
      setHint("已在当前窗口打开。");
    } catch (error) {
      setHint(`没打开：${error?.message || "没给原因"}`);
    }
  }

  /** × 取消一条钉住 */
  async function removePin(pinId) {
    if (!Pins) return;
    try {
      const result = await Pins.pinRemove({ space: currentSpaceId, pinId });
      if (result?.ok) setHint("已取消钉住。");
      else setHint(`没删掉：${result?.error || "没给原因"}`);
    } catch (error) {
      setHint(`没删掉：${error?.message || "没给原因"}`);
    }
    void refreshPins();
  }

  /** 钉住当前页：当前活动标签页，http/https 才行，by=human */
  async function pinCurrentTab() {
    if (!Pins) return;
    if (!activeTabHttp) {
      setHint("当前标签页不是 http / https 网页，钉不了。");
      return;
    }
    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = Array.isArray(tabs) ? tabs[0] : null;
    } catch {
      tab = null;
    }
    if (!tab || typeof tab.url !== "string") {
      setHint("拿不到当前标签页，没钉成。");
      return;
    }
    try {
      const result = await Pins.pinAdd({
        space: currentSpaceId,
        url: tab.url,
        title: typeof tab.title === "string" ? tab.title : "",
        by: "human",
      });
      if (result?.ok) setHint(`已钉进「${spaceName(currentSpaceId)}」。`);
      else setHint(`没钉住：${result?.error || "没给原因"}`);
    } catch (error) {
      setHint(`没钉住：${error?.message || "没给原因"}`);
    }
    void refreshPins();
  }

  /* ---------------- Cookie 导入 ---------------- */

  function setCookieText(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function setCookieStatus(text, tone) {
    const node = document.getElementById("cookie-status");
    if (!node) return;
    node.textContent = text;
    node.className = tone === "ok" ? "hint ok-text" : tone === "bad" ? "hint bad-text" : "hint";
  }

  function clearCookiePreview() {
    const preview = document.getElementById("cookie-preview");
    if (preview) preview.hidden = true;
    setCookieText("cookie-count", "—");
    setCookieText("cookie-domain-count", "—");
    setCookieText("cookie-skip", "");
    const domains = document.getElementById("cookie-domains");
    if (domains) domains.textContent = "";
    const confirm = document.getElementById("btn-cookie-confirm");
    if (confirm) confirm.disabled = true;
  }

  function resetCookieImport(message) {
    cookiePreviewSeq += 1;
    pendingCookieImport = null;
    cookieBusy = false;
    clearCookiePreview();
    const input = document.getElementById("cookie-file");
    if (input) input.value = "";
    const fileButton = document.getElementById("btn-cookie-file");
    if (fileButton) fileButton.disabled = false;
    if (message) setCookieStatus(message);
  }

  function readFileText(file) {
    if (file && typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("读取失败"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsText(file);
    });
  }

  function renderCookiePreview(plan) {
    const cookies = Array.isArray(plan?.cookies) ? plan.cookies : [];
    const domains = (Array.isArray(plan?.domains) ? plan.domains : []).slice(0, 20);
    const domainCount = Number(plan?.domainCount) || 0;
    setCookieText("cookie-count", `${cookies.length} 条`);
    setCookieText("cookie-domain-count", domainCount ? `${domainCount} 个网站` : "—");

    const domainBox = document.getElementById("cookie-domains");
    if (domainBox) {
      domainBox.textContent = "";
      for (const domain of domains) {
        const chip = document.createElement("span");
        chip.className = "tag";
        chip.textContent = String(domain);
        domainBox.appendChild(chip);
      }
      if (domainCount > domains.length) {
        const more = document.createElement("span");
        more.className = "tag";
        more.textContent = `另有 ${domainCount - domains.length} 个`;
        domainBox.appendChild(more);
      }
    }

    const skipped = [];
    if (Number(plan?.expired) > 0) skipped.push(`过期 ${plan.expired} 条`);
    if (Number(plan?.badLines) > 0) skipped.push(`坏行 ${plan.badLines} 条`);
    if (Number(plan?.overLimit) > 0) skipped.push(`超过上限 ${plan.overLimit} 条`);
    setCookieText("cookie-skip", skipped.length ? `跳过：${skipped.join("、")}。` : "没有跳过。");

    const preview = document.getElementById("cookie-preview");
    if (preview) preview.hidden = false;
    const confirm = document.getElementById("btn-cookie-confirm");
    if (confirm) confirm.disabled = cookies.length === 0 || cookieBusy;
  }

  /** 选完文件先预览：只统计条数和域名，cookie 值不进界面、不进 storage */
  async function previewCookieFile(file) {
    if (cookieBusy) return;
    const seq = ++cookiePreviewSeq;
    pendingCookieImport = null;
    clearCookiePreview();
    if (!file) return;
    // 清空 input 的选中值：同一个文件再选一次也能触发 change；File 对象仍可读
    const fileInput = document.getElementById("cookie-file");
    if (fileInput) fileInput.value = "";
    if (!CookieImport) {
      setCookieStatus("导入模块没加载，没法导入。", "bad");
      return;
    }
    if (file.size > CookieImport.FILE_MAX_BYTES) {
      setCookieStatus(`文件超过 5 MB 上限（${file.size} 字节），没有读取。`, "bad");
      return;
    }
    setCookieStatus("正在读取文件…");
    let text;
    try {
      text = await readFileText(file);
    } catch (error) {
      if (seq === cookiePreviewSeq) setCookieStatus(`读文件失败：${error?.message || "没给原因"}`, "bad");
      return;
    }
    if (seq !== cookiePreviewSeq) return;
    let plan;
    try {
      plan = CookieImport.parseCookieText(text);
    } catch (error) {
      if (seq === cookiePreviewSeq) setCookieStatus(`没读懂这个文件：${error?.message || "没给原因"}`, "bad");
      return;
    }
    if (seq !== cookiePreviewSeq) return;
    if (!plan?.ok) {
      setCookieStatus(`没读懂这个文件：${plan?.error || "格式不对"}`, "bad");
      return;
    }
    renderCookiePreview(plan);
    if (!plan.cookies.length) {
      setCookieStatus("没有可导入的 Cookie。", "bad");
      return;
    }
    pendingCookieImport = plan;
    setCookieStatus("预览好了。确认后才会写入这一格。", "ok");
  }

  /** 只有人点了「确认导入」才会走到这里：逐条 chrome.cookies.set 到当前格子 */
  async function confirmCookieImport() {
    if (cookieBusy) return;
    const plan = pendingCookieImport;
    if (!plan || !Array.isArray(plan.cookies) || !plan.cookies.length) return;
    if (!CookieImport) {
      setCookieStatus("导入模块没加载，没法导入。", "bad");
      return;
    }
    cookiePreviewSeq += 1;
    cookieBusy = true;
    const confirm = document.getElementById("btn-cookie-confirm");
    const cancel = document.getElementById("btn-cookie-cancel");
    const fileButton = document.getElementById("btn-cookie-file");
    if (confirm) confirm.disabled = true;
    if (cancel) cancel.disabled = true;
    if (fileButton) fileButton.disabled = true;
    setCookieStatus(`正在写入这一格：${plan.cookies.length} 条…`);

    let result;
    try {
      result = await CookieImport.importCookies(plan.cookies);
    } catch (error) {
      result = { ok: false, error: error?.message || "没给原因" };
    }
    cookieBusy = false;
    if (cancel) cancel.disabled = false;
    if (fileButton) fileButton.disabled = false;
    pendingCookieImport = null;
    clearCookiePreview();
    const input = document.getElementById("cookie-file");
    if (input) input.value = "";
    if (result?.ok) {
      setCookieStatus(`导入完成：成功 ${result.success} 条，失败 ${result.failed} 条。`, result.failed > 0 ? "bad" : "ok");
    } else {
      setCookieStatus(`没导入：${result?.error || "没给原因"}`, "bad");
    }
  }

  /* ---------------- 插件区 ---------------- */

  /**
   * 列出本格子装的插件（chrome.management.getAll 里 installType=normal 的商店插件，
   * 加上共享库加载进来的 development 按 id 对回来；我们自己和浏览器自带组件一律不列），
   * 每个标「已在所有格子」（在共享库里）/「只在这个格子」，给「装到所有格子」/「从所有格子移除」按钮。
   * 渲染一律 textContent，不拼 HTML；数据来自插件自己的页面权限，不发任何网络请求。
   */
  function renderExtensionRows(node, list, sharedIds) {
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "这个格子还没有从商店装的插件。装一个后会出现在这里，并按开关默认同步给其他格子。";
      node.appendChild(empty);
      return;
    }
    for (const ext of list) {
      const row = document.createElement("div");
      row.className = "ext-row";

      const name = document.createElement("span");
      name.className = "ext-name";
      name.textContent = typeof ext?.name === "string" && ext.name ? ext.name : (ext?.id || "（没有名字的插件）");

      const ver = document.createElement("span");
      ver.className = "ext-version";
      ver.textContent = typeof ext?.version === "string" && ext.version ? `v${ext.version}` : "";

      const tag = document.createElement("span");
      const shared = sharedIds.has(ext?.id);
      tag.className = shared ? "tag ok" : "tag warn";
      tag.textContent = shared ? "已在所有格子" : "只在这个格子";

      const button = document.createElement("button");
      button.type = "button";
      if (shared) {
        button.textContent = "从所有格子移除";
        button.dataset.extUnshare = ext.id;
      } else {
        button.textContent = "装到所有格子";
        button.dataset.extShare = ext.id;
      }

      row.append(name, ver, tag, button);
      node.appendChild(row);
    }
  }

  function renderExtensions() {
    const node = document.getElementById("ext-list");
    if (!node) return;
    const box = document.getElementById("ext-autosync");
    const state = currentState?.extensions || {};
    if (box) box.checked = state.autoSync !== false;
    const hintNode = document.getElementById("ext-hint");
    if (hintNode) {
      hintNode.textContent = state.restartNeeded === true
        ? "有插件改动要重开这个格子才生效：关掉这个格子再打开一次。"
        : "从 Chrome 应用商店装的插件会列在这里。装到所有格子只复制插件本身，不复制插件里的登录和数据。";
    }
    const sharedIds = new Set((Array.isArray(state.shared) ? state.shared : []).map((item) => item?.id).filter(Boolean));
    node.textContent = "";
    try {
      chrome.management.getAll().then((all) => {
        const ours = chrome.runtime.id;
        const list = (Array.isArray(all) ? all : []).filter((ext) =>
          ext && ext.id && ext.id !== ours && (ext.installType === "normal" || sharedIds.has(ext.id)));
        renderExtensionRows(node, list, sharedIds);
      }).catch(() => renderExtensionRows(node, [], sharedIds));
    } catch {
      renderExtensionRows(node, [], sharedIds);
    }
  }

  /* ---------------- 面板 ---------------- */

  async function refresh() {
    const state = await Dashboard.readState();
    currentState = state;
    await resolveActive();
    Dashboard.render(state, { showSelf: true, showFacts: true, showRecent: true, currentSpace: currentSpaceId });
    await refreshPins();
    renderExtensions();
  }

  async function send(action) {
    const reply = await Dashboard.sendGridAction(action);
    if (reply?.ok) {
      setHint("已交给主程序处理。");
      return true;
    }
    setHint(`没执行：${reply?.error || "主程序没接收"}`);
    return false;
  }

  document.addEventListener("click", async (event) => {
    // 只认真人点击：脚本伪造的 click（isTrusted=false）一律不动
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target) return;

    if (target.id === "btn-copy-url") {
      const url = currentState?.connection?.publicUrl || "";
      if (!url) return;
      const ok = await Dashboard.copyText(url);
      setHint(ok ? "公网地址已复制（不含口令）。" : "复制失败：请手动选中地址复制。");
      return;
    }

    // Cookie 导入：选文件 → 预览 → 确认后才写入
    if (target.id === "btn-cookie-file") {
      document.getElementById("cookie-file")?.click();
      return;
    }
    if (target.id === "btn-cookie-confirm") {
      void confirmCookieImport();
      return;
    }
    if (target.id === "btn-cookie-cancel") {
      if (!cookieBusy) resetCookieImport("已取消，没有写入。");
      return;
    }

    // 钉住区：点条目开新标签页，点 × 取消钉住，点「钉住当前页」把活动标签页钉进当前空间
    if (target.id === "btn-pin-current") {
      void pinCurrentTab();
      return;
    }
    if (target.dataset.pinUrl) {
      void openPinned(target.dataset.pinUrl);
      return;
    }
    if (target.dataset.pinId) {
      void removePin(target.dataset.pinId);
      return;
    }

    // 插件区：装到所有格子 / 从所有格子移除（只有人能在侧边栏点，AI 没有这类工具）
    if (target.dataset.extShare) {
      const id = target.dataset.extShare;
      setHint("正在装到所有格子…");
      const ok = await send(`ext-share:${id}`);
      if (ok) setHint("已让主程序把插件装到所有格子（只复制插件，不复制登录和数据）。");
      return;
    }
    if (target.dataset.extUnshare) {
      const id = target.dataset.extUnshare;
      setHint("正在从所有格子移除…");
      const ok = await send(`ext-unshare:${id}`);
      if (ok) setHint("已让主程序从共享库移除这个插件（这个格子里商店装的那一份不动）。");
      return;
    }

    const grid = target.dataset.grid;
    if (grid) {
      setHint("正在打开格子…");
      const ok = await send(`grid-open:${grid}`);
      if (ok) setHint(`已让主程序打开格子 ${grid}。`);
      return;
    }

    const action = target.dataset.action;
    if (!action) return;
    if (action === "show-settings") {
      setHint("正在打开主程序设置…");
      const ok = await send(action);
      if (!ok) setHint("打不开设置：确认 Windrise 主程序还在运行。");
      return;
    }
    if (action.startsWith("layout:")) {
      const layout = action.slice("layout:".length);
      setHint(`正在换成 ${layout.replace("x", "×")} 布局…`);
      const ok = await send(action);
      if (ok) setHint(`已让主程序换成 ${layout.replace("x", "×")} 布局。`);
      return;
    }
    if (action === "hide-self") {
      setHint("正在收起这一格…");
      const ok = await send(action);
      if (ok) setHint("已收起这一格；进程和登录态还在。");
      return;
    }
    if (action === "onboarding-open") {
      setHint("正在打开初次设置…");
      const ok = await send(action);
      if (ok) setHint("已在这一格打开初次设置引导页。");
      return;
    }
    if (action.startsWith("space-focus:")) {
      setHint("正在切到那个空间…");
      const ok = await send(action);
      if (ok) setHint("已让主程序切到那个空间的主标签页。");
      return;
    }
    await send(action);
  });

  Dashboard.watchState(() => { void refresh(); });
  // 钉住清单变了（本侧边栏或 AI 钉的）就只刷钉住区
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[PINS_KEY]) return;
      void refreshPins();
    });
  } catch {
    /* 没有 onChanged 就算了，15 秒一次的兜底刷新还在 */
  }
  // 商店里的插件装上 / 卸掉 / 启停：插件区跟着变
  try {
    chrome.management?.onInstalled?.addListener?.(() => { void refresh(); });
    chrome.management?.onUninstalled?.addListener?.(() => { void refresh(); });
    chrome.management?.onEnabled?.addListener?.(() => { void refresh(); });
    chrome.management?.onDisabled?.addListener?.(() => { void refresh(); });
  } catch {
    /* 这个构建没有 management：插件区只按面板状态显示 */
  }
  // 「新装的插件自动装到所有格子」开关
  try {
    const extBox = document.getElementById("ext-autosync");
    extBox?.addEventListener?.("change", (event) => {
      if (!event.isTrusted) return;
      void send(`ext-autosync:${extBox.checked ? "on" : "off"}`);
    });
  } catch {
    /* 挂不上就算了 */
  }
  // Cookie 文件选择：只读本地文件，选完先预览
  try {
    const cookieFile = document.getElementById("cookie-file");
    cookieFile?.addEventListener?.("change", (event) => {
      if (!event.isTrusted) return;
      const file = cookieFile.files && cookieFile.files[0];
      if (file) void previewCookieFile(file);
    });
  } catch {
    /* 挂不上就算了 */
  }
  // 人切了标签页 / 页面加载完：当前空间和「钉住当前页」按钮都跟着变
  try {
    chrome.tabs.onActivated?.addListener?.(() => { void refresh(); });
    chrome.tabs.onUpdated?.addListener?.((tabId, info) => {
      if (info?.status === "complete") void refresh();
    });
  } catch {
    /* 监听挂不上就算了 */
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  setInterval(() => { void refresh(); }, 15_000);
  void refresh();
})();
