/**
 * 初次设置引导页（8 步）。数据只来自面板状态（chrome.storage.session 的 panelState，
 * 主程序推的只读状态），动作走插件后台白名单再转主程序。
 *
 * 安全规矩：
 *   - 渲染一律 textContent，不拼 HTML；不发起任何网络请求（外链由用户自己点开）；
 *   - 口令明文只出现在「生成一把新口令」之后的那一次展示里（主程序经插件后台推一次）；
 *   - 关掉页面（含右上角「跳过」）都记 onboardingDone，下次格子 1 打开不再自动弹。
 */

(() => {
  "use strict";

  const Dashboard = window.WindriseDashboard;
  const STEPS = 8;
  const STEP_NAMES = ["欢迎", "打通隧道", "连 AI", "工具", "共享上下文", "多 AI 协作", "导入", "完成"];

  let currentState = null;
  let currentStep = 1;
  let clientIndex = 0;
  let keySent = false;      // 引导完成只记一次（pagehide 兜底也走这里）
  let payPort = null;
  let payRequestId = "";
  let payBusy = false;
  const KIND_LABEL = { D: "天卡", M: "月卡", Y: "年卡" };

  const $ = (id) => document.getElementById(id);
  const setText = (id, text) => { const node = $(id); if (node) node.textContent = text; };
  const setHint = (text) => setText("onb-hint", text);

  /* ---------------- 工具函数 ---------------- */

  function makeButton(className, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function sendAction(action, tab) {
    return Dashboard.sendGridAction(action, tab ? { tab } : {});
  }

  /** 关掉这个标签页（引导页以标签页形式开在格子里） */
  function closeSelf() {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab && typeof tab.id === "number") chrome.tabs.remove(tab.id);
        else window.close();
      });
    } catch {
      window.close();
    }
  }

  /** 记引导完成（幂等；关闭页面时也补一次） */
  function markDone() {
    if (keySent) return;
    keySent = true;
    try {
      chrome.runtime.sendMessage({ type: "grid-action", action: "onboarding-done" }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* 主程序不在线也照样关页面 */
    }
  }

  /** 右上角「跳过」：记完成 + 关页面 */
  function skipAndClose() {
    markDone();
    closeSelf();
  }

  /* ---------------- 步骤条 / 翻页 ---------------- */

  function renderStepBar() {
    const bar = $("step-bar");
    if (!bar) return;
    bar.textContent = "";
    for (let step = 1; step <= STEPS; step += 1) {
      const button = makeButton("onb-step", `${step} ${STEP_NAMES[step - 1]}`, () => goTo(step));
      if (step === currentStep) button.classList.add("active");
      else if (step < currentStep) button.classList.add("done");
      bar.appendChild(button);
    }
  }

  function goTo(step) {
    currentStep = Math.max(1, Math.min(STEPS, Number(step) || 1));
    document.querySelectorAll("[data-step]").forEach((section) => {
      section.hidden = Number(section.dataset.step) !== currentStep;
    });
    renderStepBar();
    $("btn-prev").disabled = currentStep <= 1;
    $("btn-next").textContent = currentStep === STEPS ? "完成" : "下一步";
    renderCurrentStep();
    setHint("");
  }

  function renderCurrentStep() {
    if (currentStep === 2) renderStep2();
    if (currentStep === 3) renderStep3();
    if (currentStep === 4) renderStep4();
    if (currentStep === 5) renderStep5();
    if (currentStep === 8) renderStep8();
  }

  /* ---------------- 第 2 步：隧道 / 激活 ---------------- */

  function renderStep2() {
    const license = currentState?.license || {};
    const activated = license.activated === true;
    const date = license.expiresAt ? new Date(license.expiresAt) : null;
    let text = activated ? "已激活" : "未激活";
    if (date && !Number.isNaN(date.getTime())) {
      text += `（到 ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (Number.isInteger(license.daysLeft)) text += `，剩 ${license.daysLeft} 天`;
      text += "）";
    }
    setText("onb-license", text);
    $("row-activate").hidden = activated;
    $("row-buy").hidden = activated;
    $("row-connect").hidden = !activated;
    renderPayButtons();
  }

  /** 购买区：价格从面板状态里的 payPlans 来（主程序从 /api/pay/plans 拉）；拿不到就暂未开放 */
  function renderPayButtons() {
    const plans = Array.isArray(currentState?.payPlans) ? currentState.payPlans : [];
    for (const kind of ["D", "M", "Y"]) {
      const button = $(`btn-buy-${kind}`);
      if (!button) continue;
      const plan = plans.find((item) => item?.kind === kind);
      const price = Number(plan?.price);
      const available = plan?.available === true && Number.isFinite(price) && price > 0;
      const name = plan?.name || KIND_LABEL[kind];
      button.textContent = available ? `${name} ¥${(price / 100).toFixed(2)}` : `${name} · 暂未开放`;
      button.disabled = !available || payBusy;
      button.title = available ? `支付宝扫码购买${name}（${plan.days} 天）` : "暂未开放（价格未定或支付宝参数未配置）";
    }
  }

  function setPayStatus(text, orderId = "") {
    setText("onb-pay-status", text);
    setText("onb-pay-order", orderId || "—");
  }

  function closePayPort() {
    if (!payPort) return;
    try { payPort.disconnect(); } catch { /* 已断开 */ }
    payPort = null;
  }

  /** 引导页自己开一条只属于这一单的长连接；二维码和状态只经这条连接回推 */
  function startPay(kind) {
    if (payBusy) return;
    closePayPort();
    payBusy = true;
    payRequestId = String(crypto.randomUUID()).replace(/-/g, "");
    const requestId = payRequestId;
    renderPayButtons();
    $("onb-pay-box").hidden = false;
    $("onb-pay-qr-wrap").hidden = true;
    setPayStatus("正在创建支付宝订单…");

    let port;
    try { port = chrome.runtime.connect({ name: "pay-order" }); }
    catch (error) {
      payBusy = false;
      renderPayButtons();
      setPayStatus(`连不上插件后台：${error.message}`);
      return;
    }
    payPort = port;
    port.onMessage.addListener((message) => {
      if (requestId !== payRequestId) return;
      if (message?.type !== "pay-order-update" || message?.requestId !== requestId) return;
      if (message.ok === false || message.error) {
        payBusy = false;
        renderPayButtons();
        $("onb-pay-qr-wrap").hidden = true;
        setPayStatus(message.error || "购买失败，请重试", message.orderId || "");
        closePayPort();
        return;
      }
      if (message.orderId) setText("onb-pay-order", message.orderId);
      if (message.qrCode) {
        $("onb-pay-qr").src = String(message.qrCode);
        $("onb-pay-qr-wrap").hidden = false;
        const amount = Number(message.amount);
        setPayStatus(Number.isFinite(amount) && amount > 0 ? `请用支付宝扫码支付 ¥${(amount / 100).toFixed(2)}` : "请用支付宝扫码支付");
      }
      if (message.status === "paid") {
        payBusy = false;
        renderPayButtons();
        $("onb-pay-qr-wrap").hidden = true;
        setPayStatus("支付成功，已激活", message.orderId || "");
        setHint("激活成功，正在刷新状态…");
        setTimeout(() => { void refresh(); }, 300);
        closePayPort();
      } else if (message.status === "expired" || message.status === "failed") {
        payBusy = false;
        renderPayButtons();
        $("onb-pay-qr-wrap").hidden = true;
        setPayStatus(message.error || (message.status === "expired" ? "订单已过期，请重新下单" : "支付失败，请重试"), message.orderId || "");
        closePayPort();
      }
    });
    port.onDisconnect.addListener(() => {
      if (requestId !== payRequestId) return;
      payPort = null;
      if (!payBusy) return;
      payBusy = false;
      renderPayButtons();
      if ($("onb-pay-box").hidden === false) setPayStatus("支付连接断开了，请重新下单");
    });
    try {
      port.postMessage({ action: `pay-order:${kind}`, requestId });
    } catch (error) {
      payBusy = false;
      renderPayButtons();
      setPayStatus(`下单失败：${error.message}`);
      closePayPort();
    }
  }

  function bindPayButtons() {
    for (const kind of ["D", "M", "Y"]) {
      $(`btn-buy-${kind}`)?.addEventListener("click", () => startPay(kind));
    }
  }

  /* ---------------- 第 3 步：连 AI ---------------- */

  function bearerSnippet(publicUrl) {
    return `${publicUrl || "<公网 MCP 地址>"}\n请求头：Authorization: Bearer <你的口令>`;
  }

  function renderClientTabs() {
    const tabs = $("client-tabs");
    if (!tabs) return;
    const clients = Array.isArray(currentState?.aiClients) ? currentState.aiClients : [];
    if (!clients.length) {
      setText("client-detail", "");
      return;
    }
    clientIndex = Math.min(clientIndex, clients.length - 1);
    tabs.textContent = "";
    clients.forEach((client, index) => {
      const tab = makeButton("onb-tab", client.name, () => {
        clientIndex = index;
        renderClientTabs();
      });
      if (index === clientIndex) tab.classList.add("active");
      tabs.appendChild(tab);
    });
    renderClientDetail();
  }

  function renderClientDetail() {
    const detail = $("client-detail");
    if (!detail) return;
    const clients = Array.isArray(currentState?.aiClients) ? currentState.aiClients : [];
    const client = clients[clientIndex];
    if (!client) { detail.textContent = ""; return; }
    const publicUrl = currentState?.connection?.publicUrl || "";

    const lines = [];
    if (client.kind === "local") {
      lines.push("本机客户端：在 Windrise 主程序设置里点「一键写入」，不用手动填地址和口令。");
    } else {
      lines.push("远程客户端填这两样：");
      lines.push(`1. MCP 地址：${publicUrl || "（先回第 2 步打通隧道）"}`);
      lines.push("2. 请求头：Authorization: Bearer 你的口令");
    }
    if (client.hint) lines.push(client.hint);

    detail.textContent = "";
    const title = document.createElement("div");
    title.className = "self-line";
    title.textContent = client.name;
    const kindTag = document.createElement("span");
    kindTag.className = "tag";
    kindTag.style.marginLeft = "8px";
    kindTag.textContent = client.kind === "local" ? "本机" : "远程";
    title.appendChild(kindTag);
    detail.appendChild(title);

    for (const line of lines) {
      const node = document.createElement("div");
      node.className = "hint";
      node.textContent = line;
      detail.appendChild(node);
    }

    const snippet = document.createElement("div");
    snippet.className = "codebox";
    snippet.textContent = client.kind === "local"
      ? "（本机客户端不用填这些）"
      : bearerSnippet(publicUrl);
    detail.appendChild(snippet);

    if (client.kind === "remote") {
      detail.appendChild(makeButton("", "一键复制这段填法", () => {
        void copyHint(snippet.textContent);
      }));
    }
  }

  function renderStep3() {
    const publicUrl = currentState?.connection?.publicUrl || "";
    setText("onb-public-url", publicUrl || "还没打通隧道：回第 2 步点「打通隧道」");
    $("btn-copy-url").disabled = !publicUrl;
    renderClientTabs();
  }

  async function copyHint(text) {
    const ok = await Dashboard.copyText(text);
    setHint(ok ? "已复制到剪贴板。" : "复制失败，请手动选中复制。");
  }

  /** 生成一把新口令：口令明文只随这一次响应回来 */
  function sendOwnerKeyNew() {
    return new Promise((resolve) => {
      const requestId = String(crypto.randomUUID()).replace(/-/g, "");
      try {
        chrome.runtime.sendMessage({ type: "grid-action", action: "owner-key-new", requestId }, (reply) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message });
          else resolve(reply || { ok: false, error: "主程序没有回应" });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  /* ---------------- 第 4 步：工具 ---------------- */

  function renderStep4() {
    const tier = currentState?.toolTier === "full" ? "full" : "basic";
    const basic = $("tier-basic");
    const full = $("tier-full");
    basic.classList.toggle("active", tier === "basic");
    full.classList.toggle("active", tier === "full");

    const tools = Array.isArray(currentState?.tools) ? currentState.tools : [];
    const list = $("tool-list");
    list.textContent = "";
    if (!tools.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "工具清单还没就绪（Bridge 起来后主程序会从注册表推过来）。";
      list.appendChild(empty);
    } else {
      for (const tool of tools) {
        const row = document.createElement("div");
        row.className = "tool-row";
        const name = document.createElement("span");
        name.className = "tool-name";
        name.textContent = tool.name;
        const desc = document.createElement("span");
        desc.className = "tool-desc";
        desc.textContent = tool.description || tool.title || "";
        row.append(name, desc);
        list.appendChild(row);
      }
    }

    setText("onb-broker", currentState?.adminBroker?.running === true ? "已安装并在运行" : "没在运行");
    $("row-broker").hidden = currentState?.adminBroker?.running === true;
  }

  /* ---------------- 第 5 步：共享上下文 ---------------- */

  function renderStep5() {
    const dir = currentState?.sharedContext?.dir || "";
    setText("onb-context-dir", dir || "（还没拿到路径，稍后重试）");
    const enabled = currentState?.sharedContext?.enabled !== false;
    setText("onb-memos", currentState?.memos?.configured === true ? "已配置" : "还没配置");
    $("row-memos").hidden = currentState?.memos?.configured === true;
    if (!enabled) setHint("共享上下文现在是关的，可以在 Windrise 设置里打开。");
  }

  /* ---------------- 第 8 步：完成 ---------------- */

  function renderStep8() {
    const recommendation = currentState?.recommendation || {};
    setText("onb-recommend-title", recommendation.title || "暂无推荐");
    setText("onb-recommend-desc", recommendation.description || "");
    const link = $("onb-recommend");
    if (link) {
      if (recommendation.url) {
        link.href = recommendation.url;
        link.removeAttribute("aria-disabled");
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
      }
    }
  }

  /* ---------------- 状态刷新 ---------------- */

  function applyState(state) {
    currentState = state;
    renderCurrentStep();
  }

  async function refresh() {
    applyState(await Dashboard.readState());
  }

  /* ---------------- 事件 ---------------- */

  $("btn-prev").addEventListener("click", () => { if (currentStep > 1) goTo(currentStep - 1); });
  $("btn-next").addEventListener("click", () => {
    if (currentStep < STEPS) goTo(currentStep + 1);
    else { markDone(); closeSelf(); }
  });
  $("btn-skip").addEventListener("click", skipAndClose);
  $("btn-start").addEventListener("click", () => { markDone(); closeSelf(); });

  $("link-domain-guide").addEventListener("click", (event) => {
    event.preventDefault();
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL("domain-guide.html"), active: true }).catch(() => setHint("没打开教程页，请手动打开侧边栏里的教程入口。"));
    } catch {
      setHint("没打开教程页，请手动打开侧边栏里的教程入口。");
    }
  });

  bindPayButtons();

  $("btn-activate").addEventListener("click", async () => {
    setHint("正在打开设置窗口的「激活」页…");
    const reply = await sendAction("show-settings", "account");
    if (!reply?.ok) setHint(`打不开设置窗口：${reply?.error || "主程序没回应"}`);
  });

  $("btn-tunnel-connect").addEventListener("click", async () => {
    setHint("已交给主程序打通隧道；状态变化会显示在这页和侧边栏里…");
    const reply = await sendAction("tunnel-connect");
    if (!reply?.ok) setHint(`没执行：${reply?.error || "主程序没回应"}`);
  });

  $("btn-copy-url").addEventListener("click", async () => {
    const url = currentState?.connection?.publicUrl || "";
    if (!url) return;
    await copyHint(url);
  });

  $("btn-copy-header").addEventListener("click", () => copyHint("Authorization: Bearer <你的口令>"));

  $("btn-copy-key").addEventListener("click", () => {
    const key = $("onb-key-text").textContent || "";
    if (key) void copyHint(key);
  });

  $("btn-new-key").addEventListener("click", async () => {
    const button = $("btn-new-key");
    const box = $("onb-key-box");
    box.hidden = true;
    setText("onb-key-text", "");
    button.disabled = true;
    setHint("正在生成口令…");
    const result = await Promise.race([
      sendOwnerKeyNew(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "生成口令超时，请重试" }), 30_000)),
    ]);
    button.disabled = false;
    if (!result?.ok || typeof result.key !== "string" || !result.key) {
      setHint(`没有生成：${result?.error || "主程序没回应"}`);
      return;
    }
    setText("onb-key-text", result.key);
    box.hidden = false;
    setHint("新口令已生成。只显示这一次，请立刻复制保存。");
  });

  $("tier-basic").addEventListener("click", async () => {
    setHint("正在切到基础档…");
    const reply = await sendAction("tool-tier:basic");
    if (reply?.ok) setHint("已切到基础档（重启 Bridge 后生效）。");
    else setHint(`没执行：${reply?.error || "主程序没回应"}`);
  });

  $("tier-full").addEventListener("click", async () => {
    setHint("正在切到完整档…");
    const reply = await sendAction("tool-tier:full");
    if (reply?.ok) setHint("已切到完整档（重启 Bridge 后生效）。");
    else setHint(`没执行：${reply?.error || "主程序没回应"}`);
  });

  $("btn-broker-install").addEventListener("click", async () => {
    setHint("正在打开设置窗口（安装入口在那里，会弹一次 Windows 权限确认）…");
    const reply = await sendAction("show-settings", "settings");
    if (!reply?.ok) setHint(`打不开设置窗口：${reply?.error || "主程序没回应"}`);
  });

  $("btn-memos-config").addEventListener("click", async () => {
    setHint("正在打开设置窗口的「共享上下文」页…");
    const reply = await sendAction("show-settings", "context");
    if (!reply?.ok) setHint(`打不开设置窗口：${reply?.error || "主程序没回应"}`);
  });

  $("btn-import-page").addEventListener("click", async () => {
    setHint("正在试着打开浏览器的导入页…");
    try {
      await chrome.tabs.create({ url: "chrome://settings/importData", active: true });
      setHint("已在新标签页打开导入页；如果没开出来，用下面的「复制导入页地址」在地址栏手动打开。");
    } catch {
      setHint("浏览器不让插件直接打开这个页面：请复制下面的地址，粘到新标签页的地址栏回车。");
    }
  });

  $("btn-copy-import-url").addEventListener("click", () => copyHint("chrome://settings/importData"));

  /* 关掉页面（点 ×、导航走、整窗关闭）都补记一次引导完成 —— 幂等，主程序那头只存 true */
  window.addEventListener("pagehide", markDone);
  window.addEventListener("pagehide", closePayPort);

  Dashboard.watchState(applyState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  setInterval(() => { void refresh(); }, 10_000);

  goTo(1);
  void refresh();
})();
