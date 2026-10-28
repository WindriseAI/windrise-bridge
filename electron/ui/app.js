/**
 * 渲染层 —— 只管界面，所有真实动作都通过 window.bridge 发到主进程。
 * 没有 window.bridge（例如在纯浏览器里打开）时自动降级成演示模式，方便调样式。
 */

import { GUIDES, GUIDE_ORDER, LEVELS, GUIDE_FOR_PROVIDER, guideForError } from "./guides.js";
import { pickClientCopy, renderClientConfigMode, renderClientGroupList } from "./client-config-view.js";

const api = window.bridge ?? createStubApi();
/** 取元素；页面改版后万一某个 id 不存在，返回一个游离元素而不是让整个脚本崩掉 */
const $ = (id) => document.getElementById(id) ?? (console.warn(`[ui] 缺少元素 #${id}`), document.createElement("div"));
const state = { profiles: [], tools: [], logs: [], tunnelProvider: null, snapshot: null, context: null, linkPickerFor: null };

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/**
 * 提示条：右下角堆叠，按内容自动分成功/失败/提醒三种颜色。
 * 失败类停留更久（用户要时间读错误信息），同屏最多 4 条。
 */
/** 工作区编辑状态（放最前面：renderSnapshot 很早就会用到） */
var rootsDirty = false;
var wsDraft = [];

function toast(message, kind) {
  const text = String(message ?? "");
  kind ??= /失败|错误|异常|无法|不能|连不上|拒绝/.test(text) ? "err"
    : /还差|还需要|先|请|未开通|过期/.test(text) ? "warn"
    : /成功|已|完成|🎉/.test(text) ? "ok" : "info";
  let stack = document.querySelector(".toast-stack");
  if (!stack) { stack = document.createElement("div"); stack.className = "toast-stack"; stack.setAttribute("role", "status"); stack.setAttribute("aria-live", "polite"); document.body.appendChild(stack); }
  const el = document.createElement("div");
  el.className = `toast-item ${kind}`;
  el.textContent = text;
  el.title = "点击关闭";
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  el.addEventListener("click", close);
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  const life = kind === "err" ? 6000 : 2800;
  el.style.setProperty("--life", `${life}ms`);
  setTimeout(close, life);
}

/* ---------- 主题：跟随系统 / 浅色 / 深色 ---------- */
const THEMES = ["system", "light", "dark"];
const THEME_NAME = { system: "跟随系统", light: "浅色", dark: "深色" };
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(mode = localStorage.getItem("theme") || "system") {
  const dark = mode === "dark" || (mode === "system" && darkQuery.matches);
  // 切主题时临时关闭所有过渡，避免整页颜色一起“抹”过去（better-ui：Suppress transitions on theme switch）
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(freeze);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  void getComputedStyle(document.documentElement).opacity;
  requestAnimationFrame(() => requestAnimationFrame(() => freeze.remove()));
  const button = document.getElementById("btn-theme");
  if (button) { button.title = `主题：${THEME_NAME[mode]}（点击切换）`; button.dataset.mode = mode; }
  window.bridge?.setTheme?.(mode);
}
darkQuery.addEventListener("change", () => applyTheme());
applyTheme();
document.getElementById("btn-theme")?.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(localStorage.getItem("theme") || "system") + 1) % THEMES.length];
  localStorage.setItem("theme", next);
  const button = document.getElementById("btn-theme");
  (window.__motion?.withThemeTransition ?? ((fn) => fn()))(() => applyTheme(next), button);
  toast(`主题：${THEME_NAME[next]}`, "info");
});

/* ---------- 侧栏收起 ---------- */
const appEl = document.querySelector(".app");
if (localStorage.getItem("sidebar") === "collapsed") appEl.classList.add("collapsed");
document.getElementById("btn-collapse")?.addEventListener("click", () => {
  const collapsed = !appEl.classList.contains("collapsed") && !(window.innerWidth <= 1000 && !appEl.classList.contains("expanded"));
  appEl.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("expanded", !collapsed);
  localStorage.setItem("sidebar", collapsed ? "collapsed" : "expanded");
});

/** 隐藏地址里的令牌：只留前 4 位和后 4 位，复制时仍然是完整地址 */
function maskUrl(url) {
  if (!url || typeof url !== "string" || url.startsWith("（")) return url;
  return url.replace(/\/([A-Za-z0-9_-]{16,})(?=\/|\?|#|$)/g, (_, t) => "/" + t.slice(0, 4) + "*".repeat(10) + t.slice(-4));
}

/** 公网地址去掉路径令牌：https://xxx/mcp/<令牌> → https://xxx/mcp */
function publicMcpBaseUrl(url) {
  if (!url || typeof url !== "string" || url.startsWith("（")) return url;
  return url.replace(/\/mcp\/[^/?#]+\/?$/, "/mcp");
}

/** 当前该交给客户端的地址：路径入口开着就用带令牌地址，否则用不带令牌的 /mcp */
function connectionTarget(snap = state.snapshot) {
  const url = snap?.status?.publicMcpUrl;
  if (!url) return null;
  return snap?.ownerAuth?.pathEnabled === true ? url : publicMcpBaseUrl(url);
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function shortTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function setChip(el, text, kind) {
  el.textContent = text;
  el.className = `chip${kind ? ` chip-${kind}` : ""}`;
}

/* ------------------------------------------------------------------ *
 * 标签页切换
 * ------------------------------------------------------------------ */

const TITLES = { bridge: "Bridge", browser: "多开浏览器", tools: "工具", context: "共享上下文", account: "激活", settings: "设置" };

document.querySelectorAll(".rail-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rail-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${tab}`));
    $("page-title").textContent = TITLES[tab] ?? tab;
    if (tab === "tools") { refreshTools(); refreshCustomTools(); }
    if (tab === "browser") { refreshProfiles(); refreshSites(); }
    if (tab === "context") { refreshContext(); refreshMemosStatus(); }
    if (tab === "account") { refreshActivation(); loadPayPlans(); }
    if (tab === "settings") {
      refreshConnectors().catch(() => {});
      refreshOwnerAuth().catch(() => {});
    } else {
      // 口令明文只在设置页里待着：切走就清掉，变量也置空
      hideOwnerSecret();
    }
  });
});

/* Ctrl+1…6 切页（快捷键提示显示在侧栏按钮上） */
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const index = Number(event.key) - 1;
  const buttons = document.querySelectorAll(".rail-btn");
  if (index >= 0 && index < buttons.length) { event.preventDefault(); buttons[index].click(); }
});

/* ------------------------------------------------------------------ *
 * Bridge 页
 * ------------------------------------------------------------------ */

const LEVEL_TITLE = { stopped: "未启动", local: "本机就绪，未打通", connecting: "正在打通…", connected: "已连接", error: "打通失败" };
const LEVEL_CHIP = { stopped: "Bridge 未启动", local: "仅本机可用", connecting: "隧道连接中", connected: "隧道已连通", error: "隧道没连通" };
/** 右上角状态胶囊的悬停说明：一眼知道是哪里的问题、该去哪处理 */
const LEVEL_TIP = {
  stopped: "Bridge 还没启动：去 Bridge 页点「一键连接」",
  local: "本机能用，但外部 AI 还连不进来：去 Bridge 页点「一键连接」打通隧道",
  connecting: "正在打通隧道，通常 5–15 秒",
  connected: "隧道已打通，外部 AI 可以连进来",
  error: "隧道没打通，外部 AI 连不进来",
};

/** 公网最后验证时间：只认 lastOkAt，没验过（或者老主进程没这个字段）就不显示 */
function publicVerifiedSuffix(publicCheck) {
  const at = Number(publicCheck?.lastOkAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return ` · 公网 ${hh}:${mm} 已验证`;
}

/** 最后一次经公网进来的 MCP 请求：没收到过（或者老主进程没这个字段）就不显示 */
function publicRequestSuffix(health) {
  const at = Number(health?.lastTunnelRequestAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return ` · 外部请求 ${hh}:${mm}`;
}

/** 状态行只在「 · 」处换行：段内空格换成不换行空格（配合 CSS keep-all，「外部请求」不会被拆成两行） */
function keepSegments(text) {
  return text.split(" · ").map((part) => part.replace(/ /g, " ")).join(" · ");
}

function renderSnapshot(snap) {
  // 已连接时，隧道卡片跟着实际在用的类型走（配了固定地址时「快速隧道」会自动变成命名隧道）
  const live = snap?.status?.level === "connected" ? snap.status.provider : null;
  // 用户没选过时才跟着当前连接走；选过就以用户的选择为准（切换中两者可能暂时不同）
  if (live && live !== state.tunnelProvider && !snap?.settings?.connectChoice) selectProvider(live).catch(() => {});
  if (!snap) return;
  state.snapshot = snap;
  const running = snap.running;
  const status = snap.status ?? { level: running ? "local" : "stopped" };
  const level = status.level;
  const tunnel = snap.tunnel ?? {};
  const connected = level === "connected";
  const health = snap.health ?? {};

  // 顶栏状态胶囊 + 侧栏
  const pill = $("chip-state");
  pill.dataset.level = level;
  pill.querySelector("span") ? (pill.querySelector("span").textContent = LEVEL_CHIP[level]) : (pill.textContent = LEVEL_CHIP[level]);
  pill.title = `${LEVEL_TIP[level] ?? ""}${level === "error" && (status.error || tunnel.lastError) ? `\n原因：${status.error || tunnel.lastError}` : ""}\n（点击回到 Bridge 页）`;

  // 主卡片：只有真正打通才算「已连接」，没打通前不会显示“运行中”
  const hero = $("hero");
  if (hero.dataset.level !== level) {
    hero.dataset.level = level;
    $("hero-title").textContent = LEVEL_TITLE[level];
    $("hero-title").classList.remove("swap"); void $("hero-title").offsetWidth; $("hero-title").classList.add("swap");
  }
  hero.classList.toggle("on", connected);
  const toggle = $("btn-toggle");
  if (!toggle.classList.contains("loading")) {
    toggle.textContent = connected ? "断开" : level === "connecting" ? "取消" : level === "error" ? "重试" : "一键连接";
    toggle.className = `btn btn-lg ${connected || level === "connecting" ? "btn-quiet" : "btn-primary"}`;
  }
  $("health-dot").className = `dot ${connected ? "on" : level === "connecting" ? "busy" : level === "error" ? "err" : running ? "idle" : "off"}`;
  $("health-text").textContent = connected
    ? keepSegments(`${TUNNEL_LABELS[status.provider || tunnel.provider] ?? "隧道"} · ${health.tools ?? 0} 个工具 · ${health.sessions ?? 0} 个会话${publicVerifiedSuffix(snap.publicCheck)}${publicRequestSuffix(health)}`)
    : level === "connecting" ? (status.detail || "等待隧道注册到边缘节点，通常 5–15 秒")
    : level === "error" ? (status.error || tunnel.lastError || "隧道没连上，看「隧道」卡片的提示")
    : running ? `端口 ${snap.port ?? "?"} · ${health.tools ?? 0} 个工具 · 外部 AI 还连不上`
    : "一键连接后，外部 AI 就能用这台电脑";
  // 快照里的激活摘要（主进程算好的）：只画 banner 和锁，不动激活页文案
  if (snap.license) {
    act.status = { ...(act.status ?? {}), ...snap.license };
    renderBannerAndLocks();
  }
  // 没激活：隧道根本不会起，别把「打通失败 / 连接中」之类的次生错误摆给用户，直接说该做什么
  if (act.status && !act.status.activated && act.status.code !== "NEED_ONLINE" && !connected) {
    $("hero-title").textContent = act.status.code === "EXPIRED" ? "激活已到期" : "请先输入激活码";
    $("health-text").textContent = act.status.code === "EXPIRED" ? "输入新的激活码后才能连接" : "还没有激活，先到「激活」页输入激活码，再点一键连接";
  }
  const errGuide = $("btn-error-guide");
  errGuide.hidden = level !== "error" || Boolean(act.status && !act.status.activated);
  if (level === "error") {
    const g = guideForError(status.error || tunnel.lastError, status.provider || tunnel.provider || state.tunnelProvider);
    errGuide.dataset.guide = g.id;
    errGuide.dataset.guideStep = g.step ?? "";
  }
  const auto = $("auto-connect");
  if (document.activeElement !== auto) auto.checked = Boolean(snap.settings?.autoConnect);

  // 已连接卡片：默认给不带令牌的地址 + 口令请求头；路径入口仍开着时保持原来的带令牌地址
  $("card-connected").hidden = !connected;
  if (connected) {
    const pathEnabled = snap.ownerAuth?.pathEnabled === true;
    const target = connectionTarget(snap);
    const field = $("public-mcp");
    const shown = pathEnabled ? maskUrl(target) : target;
    if (field.value !== shown) field.value = shown || "";
    $("connected-sub").textContent = `${TUNNEL_LABELS[status.provider || tunnel.provider] ?? "隧道"} · 把下面的地址交给任意 MCP 客户端`;
    $("connected-path-note").hidden = !pathEnabled;
    const count = snap.ownerAuth?.count;
    $("connected-key-count").textContent = Number.isInteger(count)
      ? (count > 0 ? `已设置 ${count} 把口令` : "还没有口令")
      : "口令状态读取中…";
    $("btn-manage-keys").textContent = count === 0 ? "新增口令" : "管理口令";
  }

  $("mcp-url").value = maskUrl(snap.mcpUrl) ?? "（未启动）";
  $("health-url").value = snap.healthUrl ?? "（未启动）";
  $("public-url").value = connectionTarget(snap)
    ? (snap.ownerAuth?.pathEnabled === true ? maskUrl(connectionTarget(snap)) : connectionTarget(snap))
    : (level === "connecting" ? "（正在打通…）" : "（未打通）");

  $("stat-tools").textContent = health.calls ?? 0;
  $("stat-avg").textContent = health.averageDurationMs != null ? `${health.averageDurationMs} ms` : "—";
  $("stat-fail").textContent = health.failures ?? 0;
  $("stat-rate").textContent = health.successRate != null ? `${health.successRate}%` : "—";

  setChip($("chip-tunnel"), connected ? "已打通" : level === "connecting" ? "连接中" : level === "error" ? "失败" : "未打通", connected ? "ok" : level === "connecting" ? "warn" : level === "error" ? "err" : null);

  // 侧栏底部状态
  $("rail-status").className = `rail-dot ${running ? "on" : ""}`;
  $("ss-bridge").textContent = running ? `:${snap.port ?? "?"}` : "已停止";
  $("ss-tunnel").textContent = connected ? (() => { try { return new URL(tunnel.publicUrl).hostname.split(".")[0]; } catch { return "已打通"; } })() : level === "connecting" ? "连接中…" : "未打通";
  $("ss-tunnel").title = tunnel.publicUrl ?? "";
  $("ss-tunnel-dot").className = `rail-dot ${connected ? "on" : level === "connecting" ? "busy" : level === "error" ? "err" : ""}`;
  $("ss-calls").textContent = health.calls ?? 0;
  renderQuickstart(running, connected, level);

  // 设置页
  // 用户正在编辑（有没保存的改动）时不要用状态推送覆盖掉
  if (!rootsDirty) $("roots").value = (snap.roots ?? []).join("\n");
  renderWsRow(snap);
  $("data-home").textContent = snap.dataHome ?? "—";
  $("token-file").textContent = snap.tokenFile ?? "—";
  $("hub-root").textContent = snap.hubRoot ?? "—";
  $("opt-approve").checked = snap.options?.approve === true;
  $("opt-readonly").checked = snap.options?.readonlyAuto !== false;
  $("opt-jsonresp").checked = snap.options?.jsonResponse !== false;
  $("opt-agent-cursor").checked = snap.options?.agentCursor !== false;
  renderStartupSettings(snap);

  if (snap.logs) {
    state.logs = snap.logs;
    renderLogs();
  }
}

/** 快捷步骤：启动 Bridge → 打通隧道 */
function renderQuickstart(running, connected, level) {
  const steps = [running, connected];
  const current = steps.indexOf(false);
  document.querySelectorAll(".qs-step").forEach((el, i) => {
    el.classList.toggle("done", steps[i]);
    el.classList.toggle("current", i === current);
  });
  $("qs-1").textContent = running ? `端口 ${state.snapshot?.port ?? "?"}` : "";
  $("qs-2").textContent = connected ? "已打通" : level === "connecting" ? "连接中…" : "";
}

/** 一键连接 / 断开 / 取消 —— 主按钮根据状态切换含义 */
$("btn-toggle").addEventListener("click", async () => {
  const level = state.snapshot?.status?.level ?? "stopped";
  const button = $("btn-toggle");
  if (level === "connected" || level === "connecting") {
    button.classList.add("loading");
    try { await api.disconnect(); toast(level === "connected" ? "已断开" : "已取消"); }
    finally { button.classList.remove("loading"); renderSnapshot(await api.snapshot()); }
    return;
  }
  await connectFlow();
});

$("auto-connect").addEventListener("change", async (event) => {
  const on = event.target.checked;
  if (on && !state.tunnelProvider) { event.target.checked = false; toast("先选一种连接方式"); openConnModal(); return; }
  const patch = on ? { autoConnect: true, autoStartBridge: true, connectChoice: state.tunnelProvider, connectChoiceDone: true } : { autoConnect: false };
  const result = await api.settingsSet(patch);
  if (result?.ok === false) { event.target.checked = !on; return toast(`保存失败：${result.error}`); }
  toast(on ? `已开启：打开软件自动连接（${TUNNEL_LABELS[state.tunnelProvider] ?? "快速隧道"}）` : "已关闭自动连接", "ok");
  renderSnapshot(await api.snapshot());
});

$("chip-state").addEventListener("click", () => gotoTab("bridge"));

async function copyWithFeedback(button, text, message) {
  if (!text) return toast("还没有地址");
  await api.copy(text);
  button?.classList.add("copied");
  setTimeout(() => button?.classList.remove("copied"), 1400);
  toast(message, "ok");
}

$("btn-copy-mcp").addEventListener("click", (e) => {
  const value = state.snapshot?.mcpUrl;
  if (!value) return toast("还没有地址");
  copyWithFeedback(e.currentTarget, value, "本机 MCP 地址已复制");
});
$("btn-copy-health").addEventListener("click", (e) => {
  const value = $("health-url").value;
  if (!value || value.startsWith("（")) return toast("还没有地址");
  copyWithFeedback(e.currentTarget, value, "健康检查地址已复制");
});
$("btn-copy-public").addEventListener("click", (e) => {
  const value = connectionTarget();
  if (!value) return toast("隧道还没打通");
  copyWithFeedback(e.currentTarget, value, "公网 MCP 地址已复制");
});
$("btn-copy-mcp-prefix")?.addEventListener("click", (e) => copyWithFeedback(e.currentTarget, "使用 MCP，", "已复制「使用 MCP，」，粘到问题最前面"));
$("btn-copy-public-mcp").addEventListener("click", (e) => {
  const value = connectionTarget();
  if (!value) return toast("隧道还没打通");
  copyWithFeedback(e.currentTarget, value, state.snapshot?.ownerAuth?.pathEnabled === true ? "公网路径地址已复制" : "公网 MCP 地址已复制");
});

/* ---------- 按客户端复制远程 MCP 配置 ---------- */
let clientConfigGroups = [];
async function renderClientConfigGroups() {
  if (!api.clientConfigGroups) return { ok: false, error: "当前版本不支持按客户端复制" };
  let result;
  try { result = await api.clientConfigGroups(); }
  catch { return { ok: false, error: "读取客户端配置失败" }; }
  if (!result?.ok) return { ok: false, error: result?.error || "还没有可复制的地址" };
  clientConfigGroups = result.groups || [];
  $("client-config-groups").innerHTML = renderClientGroupList(clientConfigGroups);
  $("client-config-mode").textContent = renderClientConfigMode({ hasToken: result.hasToken === true, pathToken: result.pathToken !== false });
  return { ok: true };
}

$("btn-client-config").addEventListener("click", async () => {
  const result = await renderClientConfigGroups();
  if (!result.ok) return toast(result.error || "隧道还没打通");
  $("client-config-modal").hidden = false;
});
$("btn-client-config-close").addEventListener("click", () => { $("client-config-modal").hidden = true; });
$("client-config-modal").addEventListener("click", (event) => {
  if (event.target === $("client-config-modal")) $("client-config-modal").hidden = true;
});
$("client-config-groups").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-client-details-toggle]");
  if (toggle) {
    const key = toggle.dataset.clientDetailsToggle;
    const list = $("client-config-groups");
    const details = list.querySelector(`[data-client-details="${CSS.escape(key)}"]`);
    const variants = list.querySelectorAll(`[data-client-variant-of="${CSS.escape(key)}"]`);
    const open = details ? details.hidden : false;
    if (details) details.hidden = !open;
    variants.forEach((row) => { row.hidden = !open; });
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "收起" : "步骤";
    return;
  }
  const clientButton = e.target.closest("[data-client-config]");
  const variantButton = e.target.closest("[data-client-variant]");
  if (!clientButton && !variantButton) return;
  const [key, variantIndex] = String(clientButton ? clientButton.dataset.clientConfig : variantButton.dataset.clientVariant).split(":");
  const picked = pickClientCopy(clientConfigGroups, { key, variantIndex: variantButton ? variantIndex : undefined });
  if (!picked) return;
  if (picked.unsupported) return toast(picked.message, "warn");
  copyWithFeedback(variantButton || clientButton, picked.text, picked.message);
});
$("btn-manage-keys").addEventListener("click", () => {
  const count = state.snapshot?.ownerAuth?.count;
  gotoTab("settings");
  setTimeout(() => {
    $("card-owner-auth")?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (count === 0) $("btn-owner-auth-add-key")?.focus();
  }, 80);
});

api.onStatus?.((snap) => renderSnapshot(snap));
api.onConnected?.(() => {
  toast("隧道已打通", "ok");
  gotoTab("bridge");
  $("card-connected").scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  // 第一次打通：引导选 AI 能访问的文件夹（默认只有「文档」，很多人的项目不在那里）
  if (!state.snapshot?.workspaceConfirmed) setTimeout(openWsModal, 600);
});

/* ------------------------------------------------------------------ *
 * 隧道
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 一键打通：还差什么、怎么补
 *
 * 设计原则：**缺什么就在这儿补**，不让用户去官网翻文档、手动下二进制、配 PATH。
 * 每次切隧道类型都重算一遍，装完客户端立刻能看到进度消失。
 * ------------------------------------------------------------------ */

const TUNNEL_LABELS = {
  cloudflare: "Cloudflare 快速隧道",
  "cloudflare-named": "Cloudflare 命名隧道",
  ngrok: "ngrok",
};

const CLIENT_LABELS = { cloudflared: "cloudflared", ngrok: "ngrok" };

/**
 * 缓存一份客户端状态。
 *
 * 为什么要缓存：探测要起进程跑 --version，慢（两个客户端加起来一秒多），
 * 而面板会随切换隧道反复重算。
 *
 * 为什么要有有效期：用户可能在程序外面自己装了一个客户端，
 * 或者把文件挪走了。缓存不过期的话面板永远看不到变化 ——
 * 实测踩过：把 ngrok 挪走后，面板还是显示「已装」。
 */
const CLIENTS_CACHE_TTL_MS = 30000;
let clientsCache = null;
let clientsCachedAt = 0;

async function loadClients({ force = false } = {}) {
  const fresh = clientsCache && Date.now() - clientsCachedAt < CLIENTS_CACHE_TTL_MS;
  if (fresh && !force) return clientsCache;
  const result = await api.clients?.status?.();
  clientsCache = result?.ok ? result.status : null;
  clientsCachedAt = Date.now();
  return clientsCache;
}

/**
 * 算出「还差什么」。
 * 返回的每一项要么带一个按钮（自动装），要么带一个输入框（填凭据）。
 */
async function checkReadiness(provider) {
  if (!provider) {
    return { ready: false, provider: null, blockers: [{ id: "choose", title: "先选一种连接方式", hint: "在上面选「快速隧道」「命名隧道（固定地址）」或「ngrok」，选哪种由你决定。" }] };
  }
  const saved = (await api.settingsGet())?.settings ?? {};
  const tunnel = saved.tunnel ?? {};
  const clients = await loadClients();
  const blockers = [];

  /* ① 客户端装了吗 */
  const clientName = provider === "ngrok" ? "ngrok" : "cloudflared";
  const client = clients?.[clientName];
  if (!client?.found) {
    blockers.push({
      id: "client",
      title: `还没装 ${CLIENT_LABELS[clientName]}`,
      hint: "点右边自动下载。装在程序自己的目录里，不动系统、不写 PATH，卸载就是删一个文件夹。",
      action: { kind: "install", name: clientName, label: "自动安装" },
    });
  }

  /* ② 各隧道自己的凭据 */
  if (provider === "cloudflare-named") {
    if (!tunnel.hostname) {
      blockers.push({
        id: "hostname",
        title: "还没填公网域名",
        hint: "比如 mcp.你的域名.com。域名要在你的 Cloudflare 账号里。",
        action: { kind: "input", field: "hostname", placeholder: "mcp.你的域名.com" },
        guide: { id: "named", step: "zone" },
      });
    }
    if (!tunnel.token && !tunnel.tunnelId) {
      // 有 Cloudflare API 权限的话可以直接一键建，否则引导去填
      const cf = await api.cloudflare?.status?.().catch(() => null);
      blockers.push({
        id: "credentials",
        title: "还没有隧道凭据",
        hint: cf?.ok
          ? "下面「一键开通固定地址」可以直接建隧道 + 配 DNS，建完这里就自动齐了。"
          : "在 Cloudflare 后台建一条隧道，把它的令牌填到「设置 → 隧道令牌」。点「看教程」一步步来，大约 10 分钟。",
        action: cf?.ok
          ? { kind: "scroll", target: "btn-cf-preview", label: "去一键开通" }
          : { kind: "link", href: "https://one.dash.cloudflare.com/", label: "打开 Cloudflare" },
        guide: { id: "named", step: "tunnel" },
      });
    }
  }

  if (provider === "ngrok") {
    if (!tunnel.ngrokAuthtoken) {
      blockers.push({
        id: "authtoken",
        title: "还没填 ngrok 令牌",
        hint: "ngrok v3 必须给令牌才能用。点右边打开 ngrok 后台复制，粘到下面。",
        action: { kind: "input", field: "ngrokAuthtoken", placeholder: "2abc…一长串", secret: true },
        link: { href: "https://dashboard.ngrok.com/get-started/your-authtoken", label: "去复制令牌" },
        guide: { id: "ngrok", step: "token" },
      });
    }
    /*
     * 就算齐了也说清免费版的额度 —— 不然用户跑到一半突然不通，
     * 会以为是程序坏了。这条**不挡开通**，只是提前告知。
     *
     * 下面的换算是实测的（tools/measure-traffic.mjs），不是拍脑袋估的：
     *   小操作平均 13.7 KB，截图默认尺寸 150-190 KB。
     * 早先我按「一张截图 1.5MB」估，比实测大了 8 倍 —— 那种估算会把用户吓跑。
     */
    blockers.push({
      id: "ngrok-limits",
      informational: true,
      title: "ngrok 免费版的额度（不挡开通，先知道一下）",
      hint: "每月 1GB 流量、2 万次请求。实测换算：1GB ≈ 5000 张截图，或 7 万次读文件；" +
        "2 万次请求 ≈ 每天 666 次调用。日常用很难超。" +
        "真超了 ngrok 会断开、等下一月重置；那时候换成 Cloudflare 命名隧道（要个域名，但流量不限）。",
    });
  }

  // 只有「带操作」的才是真的挡住开通，说明性的不算
  const blocking = blockers.filter((b) => !b.informational);
  return { ready: blocking.length === 0, blockers, provider };
}

/** 把「还差什么」画出来 */
function renderReadiness(result) {
  const box = $("tunnel-readiness");
  if (!box) return;
  box.hidden = false;

  const blocking = result.blockers.filter((b) => !b.informational);
  const info = result.blockers.filter((b) => b.informational);

  // 说明性的条目：单独画在下面，不进「还差 N 样」的计数
  const infoHtml = info.map((b) => `<div class="rd-item rd-info">
      <div class="rd-text">ℹ ${esc(b.title)}<span class="rd-hint">${esc(b.hint)}</span></div>
    </div>`).join("");

  if (result.ready) {
    box.className = "readiness ready";
    box.innerHTML = `<div class="rd-title">✓ ${esc(TUNNEL_LABELS[result.provider])}需要的都齐了</div>
      <div style="font-size:13.5px">点上方「一键连接」即可。</div>${infoHtml}`;
    return;
  }

  box.className = "readiness blocked";
  const items = blocking.map((b, i) => {
    let control = "";
    if (b.action?.kind === "install") {
      control = `<button class="btn" data-install="${esc(b.action.name)}">${esc(b.action.label)}</button>`;
    } else if (b.action?.kind === "input") {
      control = `<input class="input mono" data-field="${esc(b.action.field)}" type="${b.action.secret ? "password" : "text"}" placeholder="${esc(b.action.placeholder ?? "")}" />`;
    } else if (b.action?.kind === "link") {
      control = `<button class="btn" data-open="${esc(b.action.href)}">${esc(b.action.label)}</button>`;
    } else if (b.action?.kind === "scroll") {
      control = `<button class="btn" data-scroll="${esc(b.action.target)}">${esc(b.action.label)}</button>`;
    }
    const link = b.link ? `<button class="btn" data-open="${esc(b.link.href)}">${esc(b.link.label)}</button>` : "";
    const guide = b.guide ? `<button class="btn btn-plain" data-guide="${esc(b.guide.id)}" data-guide-step="${esc(b.guide.step ?? "")}">看教程</button>` : "";
    return `<div class="rd-item">
      <div class="rd-text">${i + 1}. ${esc(b.title)}<span class="rd-hint">${esc(b.hint)}</span></div>
      ${control}${link}${guide}
    </div>`;
  }).join("");

  box.innerHTML = `<div class="rd-title">还需要补 ${blocking.length} 样东西</div>${items}${infoHtml}`;
}

/** 当前隧道的「还差什么」，一键打通要用它决定下一步 */
let readinessCache = null;

async function refreshReadiness({ force = false } = {}) {
  const result = await checkReadiness(state.tunnelProvider);
  readinessCache = result;
  renderReadiness(result);
  return result;
}

/* ---------- 面板里的按钮 ---------- */

$("tunnel-readiness")?.addEventListener("click", async (event) => {
  const target = event.target;

  // 自动安装客户端
  const installName = target.dataset?.install;
  if (installName) {
    target.disabled = true;
    target.textContent = "安装中…";
    const box = $("tunnel-readiness");
    const progressHost = document.createElement("div");
    progressHost.innerHTML = `<div class="rd-progress"><i></i></div><div class="rd-progress-text">准备下载…</div>`;
    box.appendChild(progressHost);

    const bar = progressHost.querySelector("i");
    const text = progressHost.querySelector(".rd-progress-text");

    // 订阅进度（装完记得退订，不然重复安装会叠一堆监听）
    const unsubscribe = api.clients.onProgress((p) => {
      if (p.name !== installName) return;
      if (p.phase === "download") {
        if (bar && p.percent !== null) bar.style.width = `${p.percent}%`;
        if (text) text.textContent = p.percent !== null
          ? `正在下载 ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB（${p.percent}%）`
          : "正在下载…";
      } else if (text) {
        text.textContent = p.label ?? p.phase;
      }
    });

    const result = await api.clients.install(installName);
    unsubscribe?.();

    if (result.ok === false) {
      if (text) text.textContent = `失败：${result.error}`;
      target.disabled = false;
      target.textContent = "重试";
      return toast(`安装失败：${result.error}`);
    }
    toast(result.alreadyInstalled ? `${installName} 已经装好了` : `${installName} 装好了（${result.version}）`);
    await loadClients({ force: true });
    await refreshReadiness();
    return;
  }

  // 打开外部链接（ngrok 令牌页、Cloudflare 令牌页）
  const href = target.dataset?.open;
  if (href) {
    await api.openPath(href);
    return;
  }

  // 跳到「一键开通固定地址」
  const scrollTo = target.dataset?.scroll;
  if (scrollTo) {
    document.getElementById(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("cf-hostname")?.focus();
  }
});

/** 面板里的输入框：改完存进设置（失焦时存，避免每敲一个字写一次盘） */
$("tunnel-readiness")?.addEventListener("change", async (event) => {
  const field = event.target.dataset?.field;
  if (!field) return;
  const value = event.target.value.trim();
  await api.settingsSet({ tunnel: { [field]: value } });
  if (field === "hostname") $("named-hostname").value = value;
  toast("已保存");
  await refreshReadiness();
});

/* ---------- 选隧道 ---------- */

/** 选中某种连接方式（只改界面；save=true 时记成用户的选择） */
async function selectProvider(provider, { save = false } = {}) {
  document.querySelectorAll(".tunnel").forEach(l => l.classList.toggle("active", l.dataset.provider === provider));
  const radio = document.querySelector(`input[name="tunnel"][value="${provider}"]`);
  if (radio) radio.checked = true;
  state.tunnelProvider = provider || null;
  $("tunnel-extra").style.display = provider && provider !== "cloudflare" ? "flex" : "none";
  if (save && provider) await api.settingsSet({ connectChoice: provider, connectChoiceDone: true });
  await refreshReadiness();
}

document.querySelectorAll(".tunnel").forEach(label => {
  label.addEventListener("click", async (event) => {
    event.preventDefault();
    const next = label.dataset.provider;
    if (next === state.tunnelProvider) return;
    const prev = state.tunnelProvider;
    const level = state.snapshot?.status?.level;
    const name = TUNNEL_LABELS[next] ?? next;
    // 正连着别的方式：问一下要不要现在就切过去
    if (prev && (level === "connected" || level === "connecting")) {
      if (!confirm(`现在用的是「${TUNNEL_LABELS[prev] ?? prev}」。要切换到「${name}」吗？\n切换会重新连接，远程地址可能会变。`)) return;
      await selectProvider(next, { save: true });
      // 新方式还缺东西（没装客户端 / 没填令牌 / 没开通固定地址）：先不动现在的连接
      if (!readinessCache?.ready) {
        toast(`已选择${name}，但还需要补齐隧道卡片里列出的内容，补齐后点「只打通隧道」完成切换（现在的连接先保留）`);
        $("tunnel-readiness").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      toast(`正在切换到${name}…`, "info");
      const r = await api.tunnelStart(next);
      if (r?.code === "NOT_ACTIVATED") { toast("还没有激活，先输入激活码"); return gotoTab("account"); }
      if (r?.ok === false) toast(`切换失败：${r.error}`);
      renderSnapshot(await api.snapshot());
      return;
    }
    await selectProvider(next, { save: true });
    toast(`已选择：${name}`, "ok");
  });
});

/* ---------- 选择连接方式（首次打开 / 还没选时点连接） ---------- */

function openConnModal() {
  const current = state.tunnelProvider || state.snapshot?.settings?.tunnel?.lastProvider || "";
  document.querySelectorAll('input[name="cc-provider"]').forEach(r => { r.checked = r.value === current; });
  const s = state.snapshot?.settings ?? {};
  $("cc-auto").checked = Boolean(s.connectChoiceDone && s.autoConnect);
  $("cc-modal").hidden = false;
}
function closeConnModal() { $("cc-modal").hidden = true; }

async function saveConnChoice() {
  const picked = document.querySelector('input[name="cc-provider"]:checked')?.value;
  if (!picked) { toast("先选一种连接方式"); return null; }
  const auto = $("cc-auto").checked;
  const result = await api.settingsSet({ connectChoice: picked, connectChoiceDone: true, autoConnect: auto, ...(auto ? { autoStartBridge: true } : {}) });
  if (result?.ok === false) { toast(`保存失败：${result.error}`); return null; }
  closeConnModal();
  await selectProvider(picked);
  renderSnapshot(await api.snapshot());
  return picked;
}

$("btn-cc-later").addEventListener("click", closeConnModal);
$("btn-cc-save").addEventListener("click", async () => {
  const picked = await saveConnChoice();
  if (picked) toast(`已选择：${TUNNEL_LABELS[picked] ?? picked}。需要时点「一键连接」`, "ok");
});
$("btn-cc-connect").addEventListener("click", async () => {
  if (await saveConnChoice()) await connectFlow();
});
$("cc-modal").addEventListener("click", (event) => { if (event.target === $("cc-modal")) closeConnModal(); });

/* ---------- 一键打通 ---------- */

/**
 * 连接流程（主按钮 / 「只打通隧道」共用）：
 * 先查「还差什么」，没齐就把缺的摆出来而不是硬起（硬起只会得到看不懂的报错）。
 */
async function connectFlow({ tunnelOnly = false } = {}) {
  if (!state.tunnelProvider) { openConnModal(); return; }
  const readiness = readinessCache ?? await refreshReadiness();
  if (!readiness.ready) {
    const blocking = readiness.blockers.filter((b) => !b.informational);
    const installable = blocking.filter((b) => b.action?.kind === "install");
    toast(installable.length === 1 && blocking.length === 1 ? `还差一步：点「${installable[0].action.label}」` : `还需要补 ${blocking.length} 样东西，看隧道卡片里的提示`);
    $("tunnel-readiness").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (state.tunnelProvider === "cloudflare-named") {
    const saved = (await api.settingsGet())?.settings ?? {};
    if (!saved.tunnel?.token && !saved.tunnel?.tunnelId) {
      toast("还没有隧道，先到「设置 → 一键开通固定地址」建一条");
      return gotoTab("settings");
    }
  }
  const button = tunnelOnly ? $("btn-tunnel-start") : $("btn-toggle");
  button.classList.add("loading");
  button.disabled = true;
  try {
    const result = tunnelOnly ? await api.tunnelStart(state.tunnelProvider) : await api.connect(state.tunnelProvider);
    if (result?.code === "NO_PROVIDER") { openConnModal(); return; }
    if (result?.code === "NOT_ACTIVATED") {
      toast("还没有激活，先输入激活码");
      return gotoTab("account");
    }
    if (result?.ok === false) return toast(`连接失败：${result.error}`);
    toast("正在打通，通常 5–15 秒…", "info");
  } finally {
    button.classList.remove("loading");
    button.disabled = false;
    renderSnapshot(await api.snapshot());
  }
}

$("btn-tunnel-start").addEventListener("click", () => connectFlow({ tunnelOnly: true }));

$("btn-tunnel-stop").addEventListener("click", async () => {
  await api.tunnelStop();
  toast("隧道已断开");
  renderSnapshot(await api.snapshot());
});

$("btn-tunnel-probe").addEventListener("click", async () => {
  await loadClients({ force: true });
  await refreshReadiness();
  const clients = await loadClients();
  const parts = Object.entries(clients ?? {}).map(([name, info]) =>
    info.found ? `${name} ${info.version ?? "已装"}` : `${name} 未装`
  );
  toast(parts.join("　·　") || "检测不出结果");
});

/* ------------------------------------------------------------------ *
 * 激活（激活码：天卡 / 月卡 / 年卡）
 * 隧道是付费功能：三种隧道都要激活才能打通；浏览器和本机 MCP 免费。
 * ------------------------------------------------------------------ */

const act = { status: null, busy: false };
const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");

/** 隧道卡片上的「🔒」标记：没激活时三种方式都上锁 */
function renderLocks() {
  const locked = act.status ? !act.status.activated : false;
  document.querySelectorAll("[data-lock]").forEach((el) => { el.hidden = !locked; });
}

/** Bridge 页顶部提示 + 隧道锁：renderSnapshot 高频调用时只画这两样，不动激活页文案 */
function renderBannerAndLocks() {
  const st = act.status;
  const banner = $("act-banner");
  const on = Boolean(st?.activated);
  banner.hidden = on || !st;
  if (st && !on) {
    $("act-banner-text").textContent = st.code === "EXPIRED"
      ? "激活已到期：隧道打不通，远程 AI 的请求会被拒绝。输入新的激活码就能继续用。"
      : st.code === "NEED_ONLINE"
        ? "离线太久了，需要联网核对一次激活信息。"
        : "还没有激活：打通隧道、让远程 AI 用这台电脑之前，需要先输入激活码。";
  }
  renderLocks();
}

function renderActivation(st) {
  act.status = st;
  renderBannerAndLocks();
  const card = $("act-card");
  const on = Boolean(st?.activated);
  const stateName = !st ? "none" : on ? (st.daysLeft !== null && st.daysLeft <= 3 ? "soon" : "on") : st.code === "EXPIRED" ? "expired" : "none";
  card.dataset.state = stateName;
  const title = !st ? "读取不到激活状态" : on ? "已激活" : st.code === "EXPIRED" ? "激活已到期" : st.code === "NEED_ONLINE" ? "需要联网核对" : "还没有激活";
  $("act-title").textContent = title;
  const reason = st?.reason && !st.reason.includes(title) ? st.reason : "";
  $("act-sub").textContent = !st ? "请重启软件再试" : on
    ? (st.daysLeft !== null && st.daysLeft <= 3 ? `还剩 ${st.daysLeft} 天，记得续期：再输入一个激活码，天数会接着往后加。` : "可以打通隧道、让远程 AI 使用这台电脑了。浏览器和本机 MCP 免费。")
    : reason || "输入激活码后，就能打通隧道、让远程 AI 使用这台电脑。浏览器和本机 MCP 免费，不受影响。";
  $("act-days").textContent = on && st.daysLeft !== null ? `${st.daysLeft} 天` : st?.code === "EXPIRED" ? "0 天" : "—";
  $("act-exp").textContent = st?.expiresAt ? fmtDateTime(st.expiresAt) : "—";
  $("act-device").textContent = st?.deviceId ? `${st.deviceId.slice(0, 4)}…${st.deviceId.slice(-4)}` : "—";
  $("act-device").title = st ? `${st.deviceName ?? ""}\n设备 ID：${st.deviceId ?? ""}` : "";
  $("btn-act-go").textContent = on ? "续期" : "激活";
  if (st?.clockBack) setActMsg("电脑时间比之前早了很多，请把系统时间调准，否则可能被判定为到期。", "warn");
}

function setActMsg(text, kind = "") {
  $("act-msg").textContent = text || "";
  $("act-msg").dataset.kind = kind;
}

async function refreshActivation() {
  const r = await api.license?.status?.();
  if (!r?.ok) { renderActivation(null); return; }
  renderActivation(r.status);
  // 第一次打开发现没激活：直接带到「激活」页并聚焦输入框（只跳一次，之后用首页提示条）
  const st = r.status;
  if (st && !st.activated && st.code !== "NEED_ONLINE" && !act.jumped) {
    act.jumped = true;
    gotoTab("account");
    setTimeout(() => $("act-code").focus(), 120);
  }
}

/** 输入框：自动转大写、按 WRX-XXXX-XXXX-XXXX-XXXX 分组 */
$("act-code").addEventListener("input", (event) => {
  const el = event.target;
  const raw = el.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 19);
  const groups = [raw.slice(0, 3), raw.slice(3, 7), raw.slice(7, 11), raw.slice(11, 15), raw.slice(15, 19)].filter(Boolean);
  const next = groups.join("-");
  if (next !== el.value) el.value = next;
  setActMsg("");
});
$("act-code").addEventListener("keydown", (event) => { if (event.key === "Enter") $("btn-act-go").click(); });

$("btn-act-go").addEventListener("click", async () => {
  const code = $("act-code").value.trim();
  if (!code) { $("act-code").focus(); return setActMsg("先把激活码粘进来", "warn"); }
  if (act.busy) return;
  act.busy = true;
  const button = $("btn-act-go");
  button.classList.add("loading"); button.disabled = true;
  setActMsg("正在激活…");
  try {
    const r = await api.license.activate(code);
    if (!r?.ok) return setActMsg(r?.error ?? "激活失败", "err");
    renderActivation(r.status);
    $("act-code").value = "";
    const msg = r.again ? "这个激活码之前已经在本机用过，已重新取回激活信息。" : `激活成功：${r.kindName ?? ""} +${r.addedDays} 天，到期时间 ${fmtDateTime(r.status?.expiresAt)}。`;
    setActMsg(msg, "ok");
    toast(r.again ? "已取回激活信息" : "激活成功", "ok");
  } finally {
    act.busy = false;
    button.classList.remove("loading"); button.disabled = false;
  }
});

$("btn-act-refresh").addEventListener("click", async () => {
  const button = $("btn-act-refresh");
  button.classList.add("loading"); button.disabled = true;
  try {
    const r = await api.license.refresh();
    if (!r?.ok) { setActMsg(r?.error ?? "核对失败", "err"); return refreshActivation(); }
    renderActivation(r.status);
    setActMsg(r.status?.activated ? "已和激活服务器核对过，一切正常。" : r.status?.reason ?? "", r.status?.activated ? "ok" : "warn");
  } finally { button.classList.remove("loading"); button.disabled = false; }
});
$("btn-act-banner").addEventListener("click", () => { gotoTab("account"); setTimeout(() => $("act-code").focus(), 80); });
api.license?.onChanged?.((e) => { refreshActivation(); if (e?.reason) toast(`${e.reason}，隧道已断开`); });
api.license?.onStatus?.((st) => renderActivation(st));
refreshActivation().catch(() => {});

/* ---- 软件内购买：支付宝扫码（二维码由服务器返回 PNG data URL） ---- */
const PAY_LABELS = { D: "天卡", M: "月卡", Y: "年卡" };
const pay = { plans: [], active: null, timer: null, busy: false };

function setPayMsg(text, kind = "") {
  $("pay-msg").textContent = text || "";
  $("pay-msg").dataset.kind = kind;
}

function renderPayButtons() {
  const plans = Array.isArray(pay.plans) ? pay.plans : [];
  let any = false;
  document.querySelectorAll("[data-pay-kind]").forEach((button) => {
    const kind = button.dataset.payKind;
    const plan = plans.find((item) => item?.kind === kind);
    const price = Number(plan?.price);
    const available = plan?.available === true && Number.isFinite(price) && price > 0;
    const name = plan?.name || PAY_LABELS[kind];
    if (available) any = true;
    button.textContent = available ? `${name} ¥${(price / 100).toFixed(2)}` : `${name} · 暂未开放`;
    button.disabled = !available || pay.busy || Boolean(pay.active);
    button.title = available ? `支付宝扫码购买${name}（${plan.days} 天）` : "暂未开放（价格未定或支付宝参数未配置）";
  });
  $("act-buy-hint").textContent = any
    ? "支付宝扫码下单，付款成功后自动激活这台电脑；天数会接着现有到期时间往后加。"
    : "暂未开放：价格还没定或支付宝参数没配置。已有激活码的可以直接在上面输入。";
}

async function loadPayPlans() {
  try {
    const r = await api.license?.plans?.();
    pay.plans = r?.ok && Array.isArray(r.plans) ? r.plans : [];
  } catch { pay.plans = []; }
  renderPayButtons();
}

function stopPayPoll() {
  if (pay.timer) clearInterval(pay.timer);
  pay.timer = null;
}

async function pollPay() {
  if (!pay.active || pay.busy) return;
  pay.busy = true;
  try {
    const r = await api.license?.pollOrder?.(pay.active.orderId);
    if (!r?.ok) { setPayMsg(r?.error ?? "查单失败，正在重试…", "warn"); return; }
    if (r.status === "paid" && r.activated) {
      stopPayPoll();
      pay.active = null;
      $("pay-qr-wrap").hidden = true;
      setPayMsg(`激活成功：+${r.addedDays ?? 0} 天，到期时间 ${fmtDateTime(r.activationStatus?.expiresAt)}。`, "ok");
      renderActivation(r.activationStatus);
      refreshActivation().catch(() => {});
      toast("支付成功，已激活", "ok");
      return;
    }
    if (r.status === "expired" || r.status === "failed") {
      stopPayPoll();
      pay.active = null;
      $("pay-qr-wrap").hidden = true;
      setPayMsg(r.status === "expired" ? "订单已过期，请重新下单。" : "支付失败，请重试。", "err");
      return;
    }
    setPayMsg("等待支付宝到账…");
  } finally {
    pay.busy = false;
    renderPayButtons();
  }
}

async function startPay(kind) {
  if (pay.busy || pay.active) return;
  pay.busy = true;
  pay.active = null;
  stopPayPoll();
  renderPayButtons();
  $("pay-modal").hidden = false;
  $("pay-qr-wrap").hidden = true;
  $("pay-qr").removeAttribute("src");
  $("pay-amount").textContent = "";
  setPayMsg("正在创建支付宝订单…");
  try {
    const r = await api.license?.createOrder?.(kind);
    if (!r?.ok) { setPayMsg(r?.error ?? "下单失败，请稍后再试", "err"); return; }
    pay.active = { orderId: r.orderId };
    if (r.qrCode) $("pay-qr").src = String(r.qrCode);
    $("pay-qr-wrap").hidden = !r.qrCode;
    const amount = Number(r.amount);
    $("pay-amount").textContent = Number.isFinite(amount)
      ? `¥${(amount / 100).toFixed(2)} · ${r.name ?? PAY_LABELS[kind]}${r.days ? `（${r.days} 天）` : ""}`
      : "";
    setPayMsg("请用支付宝扫码支付，付款后会自动到账。");
    pay.timer = setInterval(() => { void pollPay(); }, 3000);
  } catch (error) {
    setPayMsg(error.message || "下单失败，请稍后再试", "err");
  } finally {
    pay.busy = false;
    renderPayButtons();
  }
}

document.querySelectorAll("[data-pay-kind]").forEach((button) => {
  button.addEventListener("click", () => { void startPay(button.dataset.payKind); });
});
$("btn-pay-close").addEventListener("click", () => { $("pay-modal").hidden = true; });
loadPayPlans().catch(() => {});

/* ------------------------------------------------------------------ *
 * 多开浏览器
 * ------------------------------------------------------------------ */

async function refreshProfiles() {
  const result = await api.profilesList();
  state.profiles = result?.profiles ?? [];
  // 顺便拉一次分组，这样窗口卡片上能显示「已链接到哪几组」
  if (!state.context) await refreshContext({ silent: true });
  renderProfiles();
}

/** 某个窗口属于哪些分组（用于卡片上显示小标签）。 */
function groupsOfProfile(profileId) {
  const groups = state.context?.groups ?? [];
  return groups.filter(g => (g.members ?? []).includes(profileId));
}

function renderProfiles() {
  const list = $("profile-list");
  const running = state.profiles.filter(p => p.running).length;
  $("chip-browser-count").textContent = running ? `${running} / ${state.profiles.length}` : String(state.profiles.length);
  $("chip-browser-count").title = `${running} 个在运行，共 ${state.profiles.length} 个账号`;

  if (!state.profiles.length) {
    list.innerHTML = `<div class="empty">点上面的网站卡片，就会新建一个独立账号</div>`;
    return;
  }

  list.innerHTML = state.profiles.map(p => {
    const linked = groupsOfProfile(p.id);
    const pickerOpen = state.linkPickerFor === p.id;
    const allGroups = state.context?.groups ?? [];
    const picker = pickerOpen
      ? `<div class="link-picker">
           ${allGroups.length
             ? allGroups.map(g => {
                 const already = (g.members ?? []).includes(p.id);
                 return `<button class="btn btn-sm" data-act="toggle-group" data-group="${escapeHtml(g.id)}">${already ? "移出 " : "加入 "}${escapeHtml(g.name)}</button>`;
               }).join("")
             : `<span>还没有分组，去「共享上下文」建一个</span>`}
           <button class="btn btn-sm btn-ghost" data-act="close-picker">完成</button>
         </div>`
      : "";
    const primary = p.running ? "聚焦" : "打开";
    let host = "";
    try { host = new URL(p.currentUrl || p.startUrl).host; } catch { host = p.currentUrl || p.startUrl || ""; }

    return `
    <div class="profile" data-id="${p.id}">
      <div class="profile-avatar" style="--c:${escapeHtml(p.color || "#007aff")}">${escapeHtml((p.name || "?").slice(0, 1))}${p.running ? '<i class="live"></i>' : ""}</div>
      <div class="profile-main">
        <div class="profile-name">
          <span class="pn">${escapeHtml(p.name)}</span>
          ${p.running ? '<span class="state-pill on">运行中</span>' : ""}
          ${p.proxy ? '<span class="tag">代理</span>' : ""}
          ${linked.map(g => `<span class="tag" title="已链接到此分组">⇄ ${escapeHtml(g.name)}</span>`).join("")}
        </div>
        <div class="profile-sub" title="${escapeHtml(p.currentUrl || p.startUrl || "")}">${escapeHtml(host || "空白页")}</div>
        ${picker}
      </div>
      <div class="profile-actions">
        <button class="btn btn-sm ${p.running ? "" : "btn-tinted"}" data-act="open">${primary}</button>
        <button class="icon-btn more" data-act="more" title="更多" aria-label="更多操作"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg></button>
      </div>
    </div>
  `;
  }).join("");

  list.querySelectorAll(".profile").forEach(row => {
    const id = row.dataset.id;
    row.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", (event) => {
        const act = btn.dataset.act;
        if (act === "toggle-group") return toggleGroupMembership(btn.dataset.group, id);
        if (act === "close-picker") { state.linkPickerFor = null; renderProfiles(); return; }
        if (act === "more") return openRowMenu(btn, id);
        handleProfileAction(id, act);
      });
    });
    row.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input")) handleProfileAction(id, "open"); });
  });
}

/** 行尾「⋯」菜单：低频操作收起来，列表更干净 */
function openRowMenu(anchor, id) {
  document.querySelector(".pop-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "pop-menu";
  const items = [
    ["link", "链接到分组"], ["cookies", "查看 Cookie 数"], ["edit", "编辑…"], ["-"], ["remove", "移除…", "danger"],
  ];
  menu.innerHTML = items.map(([act, label, cls]) => act === "-" ? '<hr />' : `<button data-act="${act}" class="${cls ?? ""}">${label}</button>`).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 6 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc, true); };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc, true); });
  menu.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (!act) return;
    close();
    if (act === "link") { state.linkPickerFor = state.linkPickerFor === id ? null : id; renderProfiles(); return; }
    handleProfileAction(id, act);
  });
}

/** 把窗口加入/移出某个分组。 */
async function toggleGroupMembership(groupId, profileId) {
  const group = (state.context?.groups ?? []).find(g => g.id === groupId);
  if (!group) return;
  const already = (group.members ?? []).includes(profileId);
  const result = already
    ? await api.context.unlink(groupId, [profileId])
    : await api.context.link(groupId, [profileId]);
  if (result?.ok === false) { toast(result.error || "操作失败"); return; }
  toast(already ? "已移出分组" : "已加入分组");
  state.linkPickerFor = null;
  await refreshContext({ silent: true });
  renderProfiles();
}

async function handleProfileAction(id, action) {
  const profile = state.profiles.find(p => p.id === id);
  if (!profile) return;

  if (action === "open") {
    const result = await api.profileOpen(id);
    if (result?.ok === false) return toast(`打开失败：${result.error}`);
    if (!profile.running) toast(`「${profile.name}」已打开`, "ok");
  }

  if (action === "cookies") {
    const result = await api.profileCookies(id);
    if (result?.ok === false) return toast(result.error);
    toast(`该分区有 ${result.count} 条 Cookie${result.domains?.length ? `（${result.domains.slice(0, 3).join(", ")}…）` : ""}`);
  }

  if (action === "edit") {
    const name = prompt("新名称：", profile.name);
    if (name === null) return;
    const url = prompt("启动网址：", profile.startUrl);
    if (url === null) return;
    const proxy = prompt("代理（留空表示不用）：", profile.proxy || "");
    if (proxy === null) return;
    const result = await api.profileUpdate(id, { name, startUrl: url, proxy });
    if (result?.ok === false) return toast(result.error);
    toast("已保存");
  }

  if (action === "remove") {
    // 删除是危险操作：默认只从列表移除，磁盘数据保留；要清数据必须显式再确认一次
    const purge = confirm(
      `移除窗口「${profile.name}」？\n\n` +
      `点「确定」→ 同时清空该账号的 Cookie 和登录态（不可恢复）\n` +
      `点「取消」→ 只从列表移除，磁盘上的登录态保留`
    );
    const result = await api.profileRemove(id, purge);
    if (result?.ok === false) return toast(result.error);
    toast(purge ? "已移除并清空该账号数据" : "已从列表移除（数据保留）");
  }

  await refreshProfiles();
}

/* ------------------------------------------------------------------ *
 * 一键打开网站：用户自定义（每点一次 = 新建一个独立账号）
 * ------------------------------------------------------------------ */
state.sites = [];
async function refreshSites() {
  const result = await api.sitesList?.();
  if (result?.ok === false) return;
  state.sites = result?.sites ?? [];
  renderSites();
}

function siteHost(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

function renderSites() {
  const grid = $("site-grid");
  grid.innerHTML = state.sites.map(site => `
    <button class="site-tile" data-key="${escapeHtml(site.key)}" title="新建一个独立的 ${escapeHtml(site.name)} 账号并打开">
      <span class="site-icon" style="--c:${escapeHtml(site.color || "#1d1d1f")}">${escapeHtml((site.name || "?").slice(0, 1).toUpperCase())}</span>
      <span class="site-text"><span class="site-name">${escapeHtml(site.name)}</span><span class="site-host">${site.accounts ? `${site.accounts} 个账号` : escapeHtml(siteHost(site.url))}</span></span>
      ${site.builtin ? "" : `<span class="site-x" data-remove="${escapeHtml(site.key)}" title="删除这个网站（已建的账号保留）" role="button" aria-label="删除">×</span>`}
    </button>`).join("") + `
    <button class="site-tile site-new" id="btn-site-new" title="添加常用网站">
      <span class="site-icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg></span>
      <span class="site-text"><span class="site-name">添加网站</span><span class="site-host">自定义一键打开</span></span>
    </button>`;
}

$("site-grid").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    event.stopPropagation();
    const site = state.sites.find(s => s.key === remove.dataset.remove);
    if (!confirm(`删除「${site?.name ?? ""}」？已经建好的账号不会删除。`)) return;
    const result = await api.siteRemove(remove.dataset.remove);
    if (result?.ok === false) return toast(result.error);
    state.sites = result.sites ?? []; renderSites();
    return;
  }
  if (event.target.closest("#btn-site-new")) {
    $("site-add").hidden = false;
    $("site-url").focus();
    return;
  }
  const tile = event.target.closest(".site-tile[data-key]");
  if (!tile || tile.disabled) return;
  tile.disabled = true;
  tile.classList.add("busy");
  try {
    const result = await api.profileQuickOpen(tile.dataset.key);
    if (result?.ok === false) return toast(`打开失败：${result.error}`);
    toast(`已打开「${result.profile?.name}」，在新窗口登录即可`, "ok");
    await Promise.all([refreshProfiles(), refreshSites()]);
  } finally { tile.disabled = false; tile.classList.remove("busy"); }
});

$("site-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("site-url").value.trim();
  if (!url) return toast("先填网址");
  const result = await api.siteAdd({ name: $("site-name").value.trim(), url });
  if (result?.ok === false) return toast(result.error);
  $("site-name").value = ""; $("site-url").value = ""; $("site-add").hidden = true;
  state.sites = result.sites ?? []; renderSites();
  toast(`已添加「${result.site?.name}」，点卡片即可一键打开`, "ok");
});
$("btn-site-cancel").addEventListener("click", () => { $("site-add").hidden = true; });

$("btn-create-toggle").addEventListener("click", () => {
  const box = $("create-box");
  box.hidden = !box.hidden;
  if (!box.hidden) $("new-name").focus();
});

$("btn-create-profile").addEventListener("click", async () => {
  const name = $("new-name").value.trim();
  if (!name) return toast("先给窗口起个名字");
  const result = await api.profileCreate({
    name,
    startUrl: $("new-url").value.trim() || "about:blank",
    proxy: $("new-proxy").value.trim(),
    userAgent: $("new-ua").value.trim(),
  });
  if (result?.ok === false) return toast(`创建失败：${result.error}`);
  $("new-name").value = "";
  $("create-box").hidden = true;
  toast(`「${name}」已创建，点「打开」即可登录`, "ok");
  await refreshProfiles();
});

$("btn-refresh-profiles").addEventListener("click", async () => { await refreshProfiles(); toast("已刷新"); });

/* ------------------------------------------------------------------ *
 * 共享上下文页
 * ------------------------------------------------------------------ */

async function refreshContext({ silent = false } = {}) {
  const snap = await api.context.snapshot();
  state.context = snap;
  if (!silent) renderContext();
  return snap;
}

function renderContext() {
  const snap = state.context;
  const groupList = $("group-list");

  if (!snap?.available) {
    setChip($("chip-context-stats"), "不可用");
    groupList.innerHTML = `<div class="empty">共享上下文没起来：${escapeHtml(snap?.error ?? "未知原因")}</div>`;
    return;
  }

  const stats = snap.stats ?? {};
  setChip(
    $("chip-context-stats"),
    `${stats.groups ?? 0} 组 · ${stats.items ?? 0} 条记忆${stats.bytes ? ` · ${(stats.bytes / 1024).toFixed(1)} KB` : ""}`
  );

  const groups = snap.groups ?? [];
  if (!groups.length) {
    groupList.innerHTML = `<div class="empty">还没有分组。上面起个名字点「新建分组」。</div>`;
  } else {
    groupList.innerHTML = groups.map((g, index) => {
      const color = ["#2f6feb", "#16a34a", "#e8720c", "#7c3aed", "#0891b2", "#db2777"][index % 6];
      const members = g.memberNames ?? [];
      const items = g.items ?? [];
      return `
        <div class="group" data-id="${escapeHtml(g.id)}">
          <div class="group-head">
            <div class="group-swatch" style="background:${color}"></div>
            <div class="group-head-main">
              <div class="group-title">${escapeHtml(g.name)}</div>
              <div class="group-note">${escapeHtml(g.note || "无备注")} · ${members.length} 个窗口 · ${items.length} 条记忆</div>
            </div>
            <div class="group-actions">
              <button class="btn btn-sm" data-act="rename">改名</button>
              <button class="btn btn-sm btn-danger" data-act="delete">删除</button>
            </div>
          </div>
          <div class="group-body">
            <p class="group-label">成员窗口</p>
            <div class="member-chips">
              ${members.length
                ? members.map(m => `
                    <span class="member-chip">
                      <span class="dot-mini" style="background:${m.running === false ? "#c3c8d0" : "#16a34a"}"></span>
                      ${escapeHtml(m.name)}
                      <button class="x" data-act="unlink" data-profile="${escapeHtml(m.id)}" title="移出分组">×</button>
                    </span>`).join("")
                : `<span class="group-note">还没有窗口。去「多开浏览器」页，点窗口上的「链接」加进来。</span>`}
            </div>

            <p class="group-label">共享记忆（${items.length} 条）</p>
            <div class="item-list">
              ${items.length
                ? items.map(it => `
                    <div class="item">
                      <div class="item-top">
                        <span class="item-key">${escapeHtml(it.key || "(无键)")}</span>
                        <span>${escapeHtml(shortTime(it.at ?? Date.now()))}</span>
                        <span class="item-src">来自 ${escapeHtml(it.sourceName ?? "?")}</span>
                        <button class="x" data-act="forget" data-key="${escapeHtml(it.key ?? "")}" data-profile="${escapeHtml(it.sourceProfileId ?? "")}" title="删除这条">×</button>
                      </div>
                      <div class="item-value">${escapeHtml(String(it.value ?? "").slice(0, 800))}</div>
                      ${(it.tags ?? []).length
                        ? `<div class="item-tags">${it.tags.map(t => `<span class="item-tag">${escapeHtml(t)}</span>`).join("")}</div>`
                        : ""}
                    </div>`).join("")
                : `<div class="empty" style="padding:8px">这组还没有共享记忆。Agent 用 context_share 写进来。</div>`}
            </div>
          </div>
        </div>`;
    }).join("");
  }

  groupList.querySelectorAll(".group").forEach(row => {
    const groupId = row.dataset.id;
    row.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", () => handleContextAction(groupId, btn.dataset.act, btn.dataset));
    });
  });

  // 消息页的「以谁的身份读」下拉
  const inboxSelect = $("inbox-as");
  const profiles = snap.profiles ?? [];
  const previous = inboxSelect.value;
  inboxSelect.innerHTML = profiles.length
    ? profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")
    : `<option value="">（没有窗口）</option>`;
  if (previous && profiles.some(p => p.id === previous)) inboxSelect.value = previous;
}

async function handleContextAction(groupId, action, data) {
  if (action === "rename") {
    const group = (state.context?.groups ?? []).find(g => g.id === groupId);
    const name = prompt("新的分组名：", group?.name ?? "");
    if (!name || name === group?.name) return;
    const result = await api.context.updateGroup(groupId, { name });
    if (result?.ok === false) { toast(result.error || "改名失败"); return; }
    toast("已改名");
  } else if (action === "delete") {
    const group = (state.context?.groups ?? []).find(g => g.id === groupId);
    if (!confirm(`删除分组「${group?.name ?? groupId}」？\n\n组里的共享记忆会一起删掉。窗口本身不受影响。`)) return;
    const result = await api.context.deleteGroup(groupId);
    if (result?.ok === false) { toast(result.error || "删除失败"); return; }
    toast("已删除分组");
  } else if (action === "unlink") {
    const result = await api.context.unlink(groupId, [data.profile]);
    if (result?.ok === false) { toast(result.error || "移出失败"); return; }
    toast("已移出分组");
  } else if (action === "forget") {
    const result = await api.context.forget({ groupId, key: data.key, sourceProfileId: data.profile });
    if (result?.ok === false) { toast(result.error || "删除失败"); return; }
    toast("已删除这条记忆");
  }
  await refreshContext();
}

/** 读某个窗口的收件箱。 */
async function loadInbox() {
  const profileId = $("inbox-as").value;
  const box = $("msg-list");
  if (!profileId) { box.innerHTML = `<div class="empty">先建一个窗口。</div>`; return; }

  const result = await api.context.inbox({ profileId, limit: 30 });
  if (result?.ok === false) { box.innerHTML = `<div class="empty">读取失败：${escapeHtml(result.error)}</div>`; return; }

  const messages = result.result ?? [];
  if (!messages.length) {
    box.innerHTML = `<div class="empty">这个窗口还没有收到消息。</div>`;
    return;
  }

  const nameOf = new Map((state.context?.profiles ?? []).map(p => [p.id, p.name]));
  box.innerHTML = messages.map(m => `
    <div class="msg ${m.read ? "" : "msg-unread"}">
      <div class="msg-top">
        <span class="msg-from">${escapeHtml(nameOf.get(m.from) ?? m.from ?? "?")}</span>
        <span>→ ${escapeHtml(m.to ? (nameOf.get(m.to) ?? m.to) : "全组广播")}</span>
        <span class="log-ms">${escapeHtml(shortTime(m.at ?? Date.now()))}</span>
        ${m.read ? "" : '<span class="item-tag">未读</span>'}
      </div>
      <div>${escapeHtml(m.text ?? "")}</div>
    </div>
  `).join("");

  // 顺手标已读
  const unread = messages.filter(m => !m.read).map(m => m.id);
  if (unread.length) await api.context.markRead({ profileId, messageIds: unread });
}

/* ------------------------------------------------------------------ *
 * 工具页
 * ------------------------------------------------------------------ */

async function refreshTools() {
  const result = await api.listTools();
  if (result?.ok === false) return;
  state.tools = result.tools ?? [];
  $("chip-toolcount").textContent = `${state.tools.length} 个`;
  $("tool-list").innerHTML = state.tools.map(t => `
    <div class="tool-row">
      <span class="tool-name">${escapeHtml(t.name)}</span>
      <span class="tool-title">${escapeHtml(t.title)}${t.source === "user" ? ' <span class="tag tag-user">自定义</span>' : ""}</span>
      <span class="cap ${escapeHtml(t.capability)}">${escapeHtml(t.capability)}</span>
    </div>
  `).join("") || `<div class="empty">没有工具</div>`;
}

/* ---- 自定义工具 ---- */
const CT_PRESETS = [
  { label: "查天气", spec: { type: "http", name: "get_weather", title: "查天气", description: "查询某个城市的实时天气，返回一行简短描述", method: "GET", url: "https://wttr.in/{{city}}?format=3&lang=zh", params: [{ name: "city", description: "城市名，如 Beijing", required: true }] } },
  { label: "Git 日志", spec: { type: "command", name: "git_recent_log", title: "最近提交", description: "查看某个仓库最近 10 条提交记录", command: "git -C {{repo}} log --oneline -10", timeoutSec: 30, params: [{ name: "repo", description: "仓库路径", required: true }] } },
  { label: "团队规范", spec: { type: "text", name: "team_guidelines", title: "团队规范", description: "写代码前先读：团队的代码规范和提交约定", text: "1. 提交信息用中文，格式「类型: 简述」\n2. 新功能必须带测试\n3. 不要提交密钥和 .env", params: [] } },
];
const ct = { specs: [], editing: null, type: "http" };

function ctParamRow(p = {}) {
  const row = document.createElement("div");
  row.className = "param-row";
  row.innerHTML = `
    <input class="input mono p-name" placeholder="参数名" maxlength="40" value="${escapeHtml(p.name ?? "")}" />
    <input class="input p-desc" placeholder="说明（给 AI 看）" maxlength="300" value="${escapeHtml(p.description ?? "")}" />
    <label class="p-req" title="必填"><input type="checkbox" class="switch switch-sm" ${p.required ? "checked" : ""} /><span>必填</span></label>
    <button class="icon-btn p-del" type="button" title="删除参数" aria-label="删除参数">×</button>`;
  row.querySelector(".p-del").addEventListener("click", () => { row.remove(); ctRenderTestArgs(); });
  row.querySelector(".p-name").addEventListener("input", () => ctRenderTestArgs());
  $("ct-params").append(row);
}

function ctParams() {
  return [...$("ct-params").querySelectorAll(".param-row")].map(r => ({
    name: r.querySelector(".p-name").value.trim(),
    description: r.querySelector(".p-desc").value.trim(),
    required: r.querySelector(".p-req input").checked,
  })).filter(p => p.name);
}

function ctRenderTestArgs() {
  const box = $("ct-test-args");
  const old = Object.fromEntries([...box.querySelectorAll("input")].map(i => [i.dataset.name, i.value]));
  box.innerHTML = "";
  for (const p of ctParams()) {
    const input = document.createElement("input");
    input.className = "input mono";
    input.dataset.name = p.name;
    input.placeholder = p.name + (p.required ? "（必填）" : "");
    input.value = old[p.name] ?? "";
    box.append(input);
  }
}

function ctSetType(type, instant = false) {
  ct.type = type;
  $("ct-type").querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.type === type)));
  document.querySelectorAll("#tool-editor .te-section").forEach(s => { s.hidden = s.dataset.for !== type; });
  placeThumb($("ct-type"), instant);
}

function ctFill(spec = {}) {
  $("ct-name").value = spec.name ?? "";
  $("ct-title").value = spec.title ?? "";
  $("ct-desc").value = spec.description ?? "";
  $("ct-method").value = spec.method ?? "GET";
  $("ct-url").value = spec.url ?? "";
  $("ct-headers").value = spec.headers ?? "";
  $("ct-body").value = spec.body ?? "";
  $("ct-command").value = spec.command ?? "";
  $("ct-cwd").value = spec.cwd ?? "";
  $("ct-timeout").value = spec.timeoutSec ?? 60;
  $("ct-text").value = spec.text ?? "";
  $("ct-params").innerHTML = "";
  for (const p of spec.params ?? []) ctParamRow(p);
  $("ct-output").hidden = true;
  ctSetType(spec.type ?? "http", true);
  ctRenderTestArgs();
}

function ctCollect() {
  const enabled = ct.editing ? ct.specs.find(s => s.name === ct.editing)?.enabled !== false : true;
  return {
    type: ct.type, name: $("ct-name").value.trim(), title: $("ct-title").value.trim(), description: $("ct-desc").value.trim(),
    params: ctParams(), enabled,
    method: $("ct-method").value, url: $("ct-url").value.trim(), headers: $("ct-headers").value, body: $("ct-body").value,
    command: $("ct-command").value.trim(), cwd: $("ct-cwd").value.trim(), timeoutSec: Number($("ct-timeout").value) || 60,
    text: $("ct-text").value,
  };
}

function ctOpen(spec = null) {
  ct.editing = spec?.name ?? null;
  $("tool-editor").hidden = false;
  $("ct-presets").hidden = Boolean(spec);
  ctFill(spec ?? { type: "http", params: [] });
  $("btn-new-tool").hidden = true;
  $("ct-name").focus();
}
function ctClose() {
  $("tool-editor").hidden = true;
  $("btn-new-tool").hidden = false;
  ct.editing = null;
}

$("ct-presets").innerHTML = `<span class="label-hint">示例：</span>` + CT_PRESETS.map((p, i) => `<button class="btn btn-ghost btn-sm" type="button" data-preset="${i}">${escapeHtml(p.label)}</button>`).join("");
$("ct-presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (b) ctFill(CT_PRESETS[Number(b.dataset.preset)].spec);
});
$("ct-type").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-type]");
  if (b) ctSetType(b.dataset.type);
});
$("btn-new-tool").addEventListener("click", () => ctOpen());
$("btn-ct-cancel").addEventListener("click", ctClose);
$("btn-add-param").addEventListener("click", () => { ctParamRow(); ctRenderTestArgs(); $("ct-params").lastElementChild?.querySelector(".p-name").focus(); });

$("btn-ct-test").addEventListener("click", async () => {
  const args = Object.fromEntries([...$("ct-test-args").querySelectorAll("input")].map(i => [i.dataset.name, i.value]));
  const out = $("ct-output");
  const btn = $("btn-ct-test");
  btn.disabled = true; out.hidden = false; out.className = "te-output"; out.textContent = "运行中…";
  try {
    const r = await api.customTools.test(ctCollect(), args);
    if (r?.ok === false) { out.classList.add("err"); out.textContent = r.error; return; }
    out.classList.toggle("err", r.isError);
    out.textContent = `${r.isError ? "出错" : "成功"} · ${r.ms} ms\n\n${r.text || "（无输出）"}`;
  } finally { btn.disabled = false; }
});

$("btn-ct-save").addEventListener("click", async () => {
  const r = await api.customTools.save(ctCollect(), ct.editing ?? "");
  if (r?.ok === false) return toast(r.error);
  toast(r.live ? "已保存，外部 AI 马上就能用" : "已保存，启动 Bridge 后生效", "ok");
  ctClose();
  await refreshCustomTools();
  refreshTools();
});

$("custom-list").addEventListener("click", async (e) => {
  const row = e.target.closest("[data-name]");
  if (!row) return;
  const name = row.dataset.name;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "edit") ctOpen(ct.specs.find(s => s.name === name));
  else if (act === "del") {
    if (!confirm(`删除自定义工具「${name}」？`)) return;
    const r = await api.customTools.remove(name);
    if (r?.ok === false) return toast(r.error);
    toast("已删除");
    await refreshCustomTools(); refreshTools();
  }
});
$("custom-list").addEventListener("change", async (e) => {
  const input = e.target.closest("input[data-toggle]");
  if (!input) return;
  const r = await api.customTools.toggle(input.dataset.toggle, input.checked);
  if (r?.ok === false) { input.checked = !input.checked; return toast(r.error); }
  await refreshCustomTools(); refreshTools();
});

/* ---- 让 AI 一键添加：用户只写一句话，复制成提示词交给 Agent（Agent 调 custom_tool_save 完成） ---- */
const AI_ADD_EXAMPLES = [
  ["查天气", "帮我加一个查天气的工具：输入城市名，返回今天的天气"],
  ["汇率换算", "帮我加一个汇率换算的工具：输入金额和两种货币，返回换算结果（用免费公开接口）"],
  ["团队规范", "帮我加一个「团队规范」工具，内容是：提交信息用中文；新功能要带测试；不要提交密钥"],
  ["网页摘要", "帮我加一个工具：输入网址，抓取网页内容并返回纯文本"],
];
function aiAddPrompt(wish) {
  return [
    `请用 Windrise Bridge 的 custom_tool_save 工具帮我添加一个自定义工具。我的需求是：${wish}`,
    "要求：先调 custom_tool_list 看看有没有重名；能用 http 或 text 类型就别用 command；工具名用英文小写加下划线，title 和 description 用中文写清楚什么时候用。",
    "建好后用一两句话告诉我它叫什么、怎么用，并试调用一次给我看结果。",
  ].join("\n");
}
$("ai-add-examples").innerHTML = AI_ADD_EXAMPLES.map(([label, text]) => `<button class="btn btn-sm btn-ghost" type="button" data-wish="${escapeHtml(text)}">${escapeHtml(label)}</button>`).join("");
$("ai-add-examples").addEventListener("click", (event) => {
  const b = event.target.closest("[data-wish]");
  if (!b) return;
  $("ai-add-text").value = b.dataset.wish;
  $("ai-add-text").focus();
});
$("btn-ai-add").addEventListener("click", (event) => {
  const wish = $("ai-add-text").value.trim();
  if (!wish) { $("ai-add-text").focus(); return toast("先写一句你想要什么工具，或点一个示例"); }
  copyWithFeedback(event.currentTarget, aiAddPrompt(wish), "已复制：粘贴到 AI 对话里发送就行");
});

const CT_TYPE_LABEL = { http: "HTTP", command: "命令", text: "文字" };
async function refreshCustomTools() {
  const r = await api.customTools?.list();
  if (!r || r.ok === false) return;
  ct.specs = r.specs ?? [];
  $("chip-custom-count").textContent = String(ct.specs.length);
  $("custom-list").innerHTML = ct.specs.map(s => {
    const detail = s.type === "http" ? `${s.method ?? "GET"} ${s.url ?? ""}` : s.type === "command" ? s.command ?? "" : (s.text ?? "").split("\n")[0];
    return `
    <div class="custom-row${s.enabled === false ? " off" : ""}" data-name="${escapeHtml(s.name)}">
      <span class="ct-badge ${escapeHtml(s.type)}">${CT_TYPE_LABEL[s.type] ?? s.type}</span>
      <div class="custom-text">
        <div class="custom-title">${escapeHtml(s.title || s.name)} <span class="mono custom-name">${escapeHtml(s.name)}</span></div>
        <div class="custom-detail mono">${escapeHtml(detail)}</div>
      </div>
      <input type="checkbox" class="switch" data-toggle="${escapeHtml(s.name)}" ${s.enabled === false ? "" : "checked"} title="启用" aria-label="启用 ${escapeHtml(s.name)}" />
      <button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>
      <button class="icon-btn" data-act="del" title="删除" aria-label="删除">×</button>
    </div>`;
  }).join("") || (ct.editing === null && $("tool-editor").hidden ? `<div class="empty">还没有自定义工具。在上面写一句需求交给 AI，它会帮你建好。</div>` : "");
}

function renderLogs() {
  const log = $("call-log");
  if (!state.logs.length) { log.innerHTML = `<div class="empty">等待调用…</div>`; return; }
  log.innerHTML = state.logs.slice(-120).map(l => `
    <div class="log-line">
      <span class="log-time">${shortTime(l.at)}</span>
      <span class="log-name">${escapeHtml(l.kind ?? "log")}</span>
      <span class="${l.level === "err" ? "log-err" : l.level === "ok" ? "log-ok" : ""}">${escapeHtml(l.text ?? "")}</span>
    </div>
  `).join("");
  log.scrollTop = log.scrollHeight;
}

$("btn-clear-log").addEventListener("click", () => { state.logs = []; renderLogs(); });

/* ------------------------------------------------------------------ *
 * 设置页
 * ------------------------------------------------------------------ */

$("roots").addEventListener("input", () => { rootsDirty = true; });

async function saveRoots(roots) {
  const result = await api.setRoots(roots);
  if (result?.ok === false) { toast(result.error); return false; }
  rootsDirty = false;
  if (result?.missing?.length) toast(`已保存。注意这些文件夹不存在：${result.missing.join("、")}`);
  else toast("已保存，立即生效（不用重新连接）", "ok");
  renderSnapshot(result?.state ?? await api.snapshot());
  return true;
}

$("btn-save-roots").addEventListener("click", async () => {
  await saveRoots($("roots").value.split("\n").map(s => s.trim()).filter(Boolean));
});

$("btn-add-cwd").addEventListener("click", async () => {
  const picked = await api.pickFolder();
  if (!picked?.ok || !picked.path) return;
  const current = $("roots").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!current.includes(picked.path)) current.push(picked.path);
  $("roots").value = current.join("\n");
  await saveRoots(current);
});

/* ---------- 连接器：每个 AI 一把钥匙 ---------- */

/** 左侧「设置」按钮上的小红点：有连接器在等批准时出现，和 Bridge 页的角标同一套写法 */
function renderConnectorBadge(count) {
  const railBtn = document.querySelector('.rail-btn[data-tab="settings"]');
  if (!railBtn) return;
  let badge = railBtn.querySelector(".badge");
  if (count && !badge) {
    badge = document.createElement("span");
    badge.className = "badge";
    railBtn.insertBefore(badge, railBtn.querySelector(".rail-kbd"));
  }
  if (!badge) return;
  if (count) {
    // 小红点不显示数字，数量放在 title 里，和「有个东西等你点」的直觉一致
    badge.textContent = "";
    badge.title = `${count} 条连接器待批准`;
  } else {
    badge.remove();
  }
}

/* ------------------------------------------------------------------ *
 * 口令入口：主身份口令 + 连接器改用口令
 * 口令明文只放在这个变量里（不写 localStorage），切走设置页或点「隐藏」就置 null。
 * ------------------------------------------------------------------ */

let ownerAuthInfo = null;
let ownerSecretText = null;
let ownerSecretKeyId = null;

function ownerAuthTime(ts) {
  // 核心给的是 ISO 字符串，界面演示桩给的是毫秒数，两种都认
  if (ts === null || ts === undefined || ts === "") return "";
  const d = new Date(typeof ts === "number" ? ts : String(ts));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 清掉界面上的一次性口令（明文变量一起清） */
function hideOwnerSecret() {
  ownerSecretText = null;
  ownerSecretKeyId = null;
  const box = $("owner-auth-secret");
  if (box) box.hidden = true;
  const value = $("owner-auth-secret-value");
  if (value) value.textContent = "";
  const title = $("owner-auth-secret-title");
  if (title) title.textContent = "新口令（只显示这一次）";
}

/** 显示一次口令明文：主口令和连接器口令都走这里，标题说明是谁的 */
function showOwnerSecret(key, title, keyId) {
  if (!key) return;
  ownerSecretText = String(key);
  ownerSecretKeyId = keyId ?? null;
  $("owner-auth-secret-title").textContent = title || "新口令（只显示这一次）";
  $("owner-auth-secret-value").textContent = ownerSecretText;
  $("owner-auth-secret").hidden = false;
}

function renderOwnerAuth(info) {
  // 明文只留在 ownerSecretText 一个地方：状态对象里把 key 摘掉
  if (info) { ownerAuthInfo = { ...info }; delete ownerAuthInfo.key; } else { ownerAuthInfo = null; }
  if (!$("owner-auth-status")) return;
  const keys = Array.isArray(info?.keys) ? info.keys : [];
  const enabled = info?.bearerEnabled === true || keys.length > 0;
  const localUrl = info?.localUrl ?? null;
  const publicUrl = info?.publicUrl ?? null;
  const legacyHint = info?.bearerHint ? ` · 末 4 位 ${info.bearerHint}` : "";
  const legacyAt = ownerAuthTime(info?.bearerCreatedAt);
  // 列表有内容时只报总数；老核心没有 keys 时才退回单把口令的摘要
  $("owner-auth-status").textContent = keys.length
    ? `已设置 ${keys.length} 把口令`
    : enabled ? `已设置${legacyHint}${legacyAt ? ` · 生成时间 ${legacyAt}` : ""}` : "未设置";
  $("owner-auth-key-list").innerHTML = keys.length
    ? keys.map((key) => {
        const id = key?.id ?? "";
        const label = key?.label || "未命名口令";
        const meta = `${key?.hint ? `末 4 位 ${key.hint}` : "末 4 位 —"} · 生成时间 ${ownerAuthTime(key?.createdAt) || "—"}`;
        return `<div class="list-row" data-owner-key="${escapeHtml(id)}">
          <div>
            <div class="item-key">${escapeHtml(label)}</div>
            <div class="sub">${escapeHtml(meta)}</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-sm" data-owner-key-rotate="${escapeHtml(id)}">换</button>
            <button class="btn btn-sm btn-danger" data-owner-key-revoke="${escapeHtml(id)}">撤</button>
          </div>
        </div>`;
      }).join("")
    : `<div class="hint">还没有口令</div>`;
  $("owner-auth-local").textContent = localUrl ? maskUrl(localUrl) : "（Bridge 未启动）";
  $("owner-auth-local").title = localUrl ?? "";
  $("btn-owner-auth-copy-local").disabled = !localUrl;
  $("owner-auth-public").textContent = publicUrl ? maskUrl(publicUrl) : "（隧道未连接）";
  $("owner-auth-public").title = publicUrl ?? "";
  $("btn-owner-auth-copy-public").disabled = !publicUrl;
  const path = $("owner-auth-path-enabled");
  path.checked = info?.pathEnabled === true;
  path.disabled = !enabled;
  $("owner-auth-path-hint").hidden = enabled;
  setChip($("owner-auth-chip"), enabled ? "已设置口令" : "还没设口令", enabled ? "ok" : "");
}

async function refreshOwnerAuth() {
  if (!api.ownerAuth?.status) return;
  const result = await api.ownerAuth.status();
  if (result?.ok === false) {
    renderOwnerAuth(null);
    $("owner-auth-status").textContent = result.error || "读取失败";
    hideOwnerSecret();
    return;
  }
  renderOwnerAuth(result);
}

$("btn-owner-auth-add-key").addEventListener("click", async () => {
  if (!api.ownerAuth?.addKey) return;
  const input = prompt("给这把口令起个名字（比如 Claude、酥酥）");
  if (input === null) return;
  const label = input.trim();
  if (!label) return toast("先给这把口令起个名字");
  const button = $("btn-owner-auth-add-key");
  button.disabled = true;
  button.classList.add("loading");
  try {
    const result = await api.ownerAuth.addKey(label);
    if (result?.ok === false) return toast(result.error || "新增失败");
    renderOwnerAuth(result);
    showOwnerSecret(result.key, `${label}的口令`, result.id);
    toast("口令已新增，复制下来填进客户端", "ok");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
});

$("owner-auth-key-list").addEventListener("click", async (event) => {
  const rotate = event.target.closest("[data-owner-key-rotate]");
  if (rotate) {
    if (!api.ownerAuth?.rotateKey) return;
    const id = rotate.dataset.ownerKeyRotate;
    const label = rotate.closest("[data-owner-key]")?.querySelector(".item-key")?.textContent || "这把口令";
    if (!confirm(`换「${label}」的口令？用这把口令的客户端会断开，要填新口令。`)) return;
    rotate.disabled = true;
    rotate.classList.add("loading");
    try {
      const result = await api.ownerAuth.rotateKey(id);
      if (result?.ok === false) return toast(result.error || "换口令失败");
      renderOwnerAuth(result);
      showOwnerSecret(result.key, `${label}的口令`, result.id);
      toast("已换好，新口令只显示这一次，复制下来填进客户端", "ok");
    } finally {
      rotate.disabled = false;
      rotate.classList.remove("loading");
    }
    return;
  }

  const revoke = event.target.closest("[data-owner-key-revoke]");
  if (!revoke) return;
  if (!api.ownerAuth?.revokeKey) return;
  const id = revoke.dataset.ownerKeyRevoke;
  const label = revoke.closest("[data-owner-key]")?.querySelector(".item-key")?.textContent || "这把口令";
  if (!confirm(`撤掉「${label}」？用这把口令的客户端会断开，要填新口令（可以先用「新增口令」加一把）。`)) return;
  revoke.disabled = true;
  revoke.classList.add("loading");
  try {
    const result = await api.ownerAuth.revokeKey(id);
    if (result?.ok === false) return toast(result.error || "撤销失败");
    renderOwnerAuth(result);
    if (ownerSecretKeyId === id) hideOwnerSecret();
    toast("口令已撤销", "ok");
  } finally {
    revoke.disabled = false;
    revoke.classList.remove("loading");
  }
});

$("owner-auth-path-enabled").addEventListener("change", async (event) => {
  if (!api.ownerAuth?.setPath) return;
  const box = event.target;
  const want = box.checked;
  if (!want && !confirm("关掉后，只能用路径地址的客户端（比如 Claude 网页版）会连不上。本机不受影响。")) {
    box.checked = true;
    return;
  }
  const result = await api.ownerAuth.setPath(want);
  if (result?.ok === false) {
    box.checked = !want;
    return toast(result.error || "保存失败");
  }
  renderOwnerAuth(result);
  toast(want ? "公网又能用路径地址连了" : "公网路径地址已关闭，只有口令能连", "ok");
});

$("btn-owner-auth-rotate-path").addEventListener("click", async () => {
  if (!api.ownerAuth?.rotatePath) return;
  const tip = ownerAuthInfo?.bearerEnabled
    ? "换路径令牌？旧的 /mcp/<令牌> 地址马上作废：还在用路径地址的客户端要换成新地址；用口令连的客户端不受影响。隧道会断开几秒。"
    : "还没设口令：换了以后，所有客户端（包括 Muse）都要换成新地址。建议先新增口令、让 Muse 改用口令，再换。确定现在就换？";
  if (!confirm(tip)) return;
  const button = $("btn-owner-auth-rotate-path");
  button.disabled = true;
  button.classList.add("loading");
  try {
    const result = await api.ownerAuth.rotatePath();
    if (result?.ok === false) return toast(result.error || "换令牌失败");
    renderOwnerAuth(result);
    toast("路径令牌已换。新地址在主界面「公网 MCP」里，复制给还在用路径地址的客户端", "ok");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
});

$("btn-owner-auth-copy-local").addEventListener("click", (event) => {
  copyWithFeedback(event.currentTarget, ownerAuthInfo?.localUrl, "本机口令入口地址已复制");
});
$("btn-owner-auth-copy-public").addEventListener("click", (event) => {
  copyWithFeedback(event.currentTarget, ownerAuthInfo?.publicUrl, "公网口令入口地址已复制");
});
$("btn-owner-auth-secret-copy").addEventListener("click", (event) => {
  copyWithFeedback(event.currentTarget, ownerSecretText, "口令已复制");
});
$("btn-owner-auth-secret-hide").addEventListener("click", () => hideOwnerSecret());

async function refreshConnectors() {
  if (!api.connectors?.list) return;
  const [data, profilesResult] = await Promise.all([
    api.connectors.list(),
    api.profilesList().catch(() => null),
  ]);
  if (data?.ok === false) return;
  const connectors = data?.connectors ?? [];
  const pending = data?.pending ?? [];
  const profiles = profilesResult?.profiles ?? state.profiles ?? [];
  const profileName = new Map(profiles.map((profile) => [profile.id, profile.name]));

  renderConnectorBadge(pending.length);

  // 一个窗口同一时间只归一个连接器：先算出当前归属，批准和勾选时都提前说明「会从谁那里移走」
  const ownerOf = new Map();
  for (const connector of connectors) {
    for (const profileId of connector.profiles ?? []) ownerOf.set(profileId, connector);
  }

  // 待批准：人点了「允许」才会 grant；点了「拒绝」10 分钟内不再重复排队。
  // 允许给的是整个窗口、一直有效，不只是触发申请的那一个工具，所以文字照实写
  $("connector-pending").hidden = pending.length === 0;
  $("connector-pending-list").innerHTML = pending.map((request) => {
    const owner = ownerOf.get(request.profileId);
    const moving = owner && owner.id !== request.connectorId ? owner.name : "";
    return `
    <div class="list-row" data-moving-from="${escapeHtml(moving)}">
      <div>
        <div class="mono">${escapeHtml(request.connectorName)} 想长期使用窗口「${escapeHtml(profileName.get(request.profileId) ?? request.profileId)}」：能看页面、点击、输入、跳转</div>
        <div class="sub">允许后一直有效，可在下面取消勾选收回${moving ? `；这个窗口现在归 ${escapeHtml(moving)}，允许会从那边移走` : ""} · 由 ${escapeHtml(request.tool)} 触发 · ${escapeHtml(shortTime(request.at))}</div>
      </div>
      <div class="btn-row" style="margin:0">
        <button class="btn btn-sm btn-primary" data-approve-connector="${escapeHtml(request.id)}">允许</button>
        <button class="btn btn-sm btn-danger" data-deny-connector="${escapeHtml(request.id)}">拒绝</button>
      </div>
    </div>`;
  }).join("");

  const rows = connectors.map((connector) => {
    const localMasked = connector.localUrl ? maskUrl(connector.localUrl) : "（Bridge 未启动）";
    const publicMasked = connector.publicUrl ? maskUrl(connector.publicUrl) : "（隧道未连接）";
    const windows = profiles.map((profile) => {
      const yours = (connector.profiles ?? []).includes(profile.id);
      const owner = ownerOf.get(profile.id);
      const note = yours ? "" : owner ? `现在归 ${owner.name}，勾上会移过来` : "";
      return `<label class="switch-row">
        <input type="checkbox" data-grant-profile="${escapeHtml(profile.id)}" ${yours ? "checked" : ""} />
        <span>${escapeHtml(profile.name)} <span class="sub">id=${escapeHtml(profile.id)}</span>${note ? ` <span class="sub">${escapeHtml(note)}</span>` : ""}</span>
      </label>`;
    }).join("") || `<div class="empty">还没有多开窗口，先去「多开浏览器」建一个。</div>`;

    return `<div class="item" data-connector="${escapeHtml(connector.id)}">
      <div class="item-top">
        <div class="item-key">${escapeHtml(connector.name)}</div>
        <span class="tag">${(connector.profiles ?? []).length} 个窗口</span>
        <span class="item-src">${escapeHtml(new Date(connector.createdAt).toLocaleDateString())}</span>
        <button class="btn btn-sm btn-danger" data-remove-connector="${escapeHtml(connector.id)}">删除</button>
      </div>
      <div class="kv">
        <span>本机地址</span>
        <code title="${escapeHtml(localMasked)}">${escapeHtml(localMasked)}</code>
        ${connector.localUrl ? `<button class="btn btn-sm" data-copy-connector="${escapeHtml(connector.localUrl)}">复制</button>` : ""}
      </div>
      <div class="kv">
        <span>公网地址</span>
        <code title="${escapeHtml(publicMasked)}">${escapeHtml(publicMasked)}</code>
        ${connector.publicUrl ? `<button class="btn btn-sm" data-copy-connector="${escapeHtml(connector.publicUrl)}">复制</button>` : ""}
      </div>
      <div class="kv">
        <span>方式</span>
        <code>${connector.authMode === "bearer" ? "口令（请求头里带 Bearer）" : "路径令牌（地址里带令牌）"}</code>
        ${connector.authMode === "bearer"
          ? `<button class="btn btn-sm" data-connector-path="${escapeHtml(connector.id)}">改回路径令牌</button>`
          : `<button class="btn btn-sm" data-connector-bearer="${escapeHtml(connector.id)}">改用口令</button>`}
      </div>
      <div class="group-label">能用的窗口</div>
      ${windows}
    </div>`;
  }).join("");

  $("connector-list").innerHTML = rows || `<div class="empty">还没有连接器。给每个 AI 建一把自己的钥匙，它就只能碰你勾选的窗口。</div>`;
}

$("connector-list").addEventListener("change", async (event) => {
  const box = event.target.closest("[data-grant-profile]");
  if (!box) return;
  const item = box.closest("[data-connector]");
  if (!item) return;
  const connectorId = item.dataset.connector;
  const profileId = box.dataset.grantProfile;
  const result = box.checked
    ? await api.connectors.grant(connectorId, profileId)
    : await api.connectors.revoke(connectorId, profileId);
  if (result?.ok === false) {
    toast(result.error || "操作失败");
    await refreshConnectors();
    return;
  }
  await refreshConnectors();
});

$("connector-list").addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy-connector]");
  if (copy) {
    await copyWithFeedback(copy, copy.dataset.copyConnector, "地址已复制，填进 AI 客户端的 MCP 配置里");
    return;
  }
  const toBearer = event.target.closest("[data-connector-bearer]");
  if (toBearer) {
    const item = toBearer.closest("[data-connector]");
    const name = item?.querySelector(".item-key")?.textContent ?? "这个连接器";
    if (!confirm(`「${name}」改用口令？地址会变成不带令牌的 /mcp，客户端要改成在请求头里填 Authorization: Bearer 加口令。旧的路径地址会在换好后失效。`)) return;
    const result = await api.connectors.setBearer(toBearer.dataset.connectorBearer);
    if (result?.ok === false) return toast(result.error || "改用口令失败");
    // 先显示口令再刷列表：刷新失败也不会把只出现一次的明文弄丢
    showOwnerSecret(result.key, `连接器「${name}」的新口令（只显示这一次）`);
    await refreshConnectors();
    toast("已改用口令。口令显示在上面的「口令入口」里，只出现这一次，复制下来填进客户端", "ok");
    return;
  }
  const toPath = event.target.closest("[data-connector-path]");
  if (toPath) {
    const item = toPath.closest("[data-connector]");
    const name = item?.querySelector(".item-key")?.textContent ?? "这个连接器";
    if (!confirm(`「${name}」改回路径令牌？地址里会重新带上令牌，客户端要换回新的路径地址。`)) return;
    const result = await api.connectors.setPathMode(toPath.dataset.connectorPath);
    if (result?.ok === false) return toast(result.error || "改回路径令牌失败");
    await refreshConnectors();
    toast("已改回路径令牌，复制新地址填进客户端", "ok");
    return;
  }
  const remove = event.target.closest("[data-remove-connector]");
  if (remove) {
    const item = remove.closest("[data-connector]");
    const name = item?.querySelector(".item-key")?.textContent ?? "这个连接器";
    if (!confirm(`删除连接器「${name}」？它手里的地址会立刻失效，已经连上的会话也会断开。`)) return;
    const result = await api.connectors.remove(remove.dataset.removeConnector);
    if (result?.ok === false) return toast(result.error || "删除失败");
    toast("已删除连接器", "ok");
    await refreshConnectors();
  }
});

$("connector-pending-list").addEventListener("click", async (event) => {
  const allow = event.target.closest("[data-approve-connector]");
  const deny = event.target.closest("[data-deny-connector]");
  if (allow) {
    const movingFrom = allow.closest("[data-moving-from]")?.dataset.movingFrom;
    if (movingFrom && !confirm(`这个窗口现在归「${movingFrom}」。允许以后会从它那里移走，它再用就要重新申请。确定吗？`)) return;
    const result = await api.connectors.approve(allow.dataset.approveConnector);
    if (result?.ok === false) return toast(result.error || "批准失败");
    toast("已允许。让 AI 用同样的参数再调一次即可", "ok");
  }
  if (deny) {
    const result = await api.connectors.deny(deny.dataset.denyConnector);
    if (result?.ok === false) return toast(result.error || "拒绝失败");
    toast("已拒绝。10 分钟内重复请求不会再打扰你");
  }
  if (allow || deny) await refreshConnectors();
});

$("btn-connector-create").addEventListener("click", async () => {
  const input = $("connector-name");
  const name = input.value.trim();
  if (!name) return toast("先给连接器起个名字");
  const result = await api.connectors.create(name);
  if (result?.ok === false) return toast(result.error || "新建失败");
  input.value = "";
  toast(`已新建「${name}」。把地址填进 AI 客户端，再在下面勾选它只能用的窗口`, "ok");
  await refreshConnectors();
});

$("connector-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("btn-connector-create").click();
});

api.connectors?.onChanged?.(() => { refreshConnectors().catch(() => {}); });

/* ---------- 工作区引导：隧道打通后告诉用户「AI 能访问哪些文件夹」 ---------- */

function shortPath(p, home) {
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) return `~${p.slice(home.length)}`;
  return p;
}

function renderWsRow(snap) {
  const roots = snap?.roots ?? [];
  const el = $("ws-list");
  if (!el) return;
  el.textContent = roots.length ? roots.map(r => shortPath(r, snap.homeDir)).join("、") : "—";
  el.title = roots.join("\n");
}

function renderWsItems(fresh) {
  const list = $("ws-items");
  if (!wsDraft.length) { list.innerHTML = `<li class="ws-empty">还没有文件夹，点下面「添加文件夹…」</li>`; return; }
  list.innerHTML = wsDraft.map((p, i) => `<li${p === fresh ? ' class="ws-new"' : ""}><span class="ws-ico" aria-hidden="true"></span><span class="ws-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span><button data-ws-remove="${i}" title="移除">×</button></li>`).join("");
}

function openWsModal(event) {
  const manual = Boolean(event?.type);   // 点「添加 / 修改」打开 vs 隧道打通后自动弹出
  $("ws-sub").textContent = manual
    ? "AI 只能读写下面这些文件夹。添加、移除都会立即保存并生效，不用重新连接。"
    : "隧道已打通。AI 只能读写下面这些文件夹，把你的项目、资料所在的文件夹加进来。以后可在 Bridge 页「添加 / 修改」随时调整，立即生效。";
  wsDraft = [...(state.snapshot?.roots ?? [])];
  renderWsItems();
  $("ws-modal").hidden = false;
}

function closeWsModal() { $("ws-modal").hidden = true; }

$("ws-items").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-ws-remove]");
  if (!btn) return;
  if (wsDraft.length <= 1) return toast("至少保留一个文件夹");
  const prev = [...wsDraft];
  wsDraft.splice(Number(btn.dataset.wsRemove), 1);
  renderWsItems();
  saveRoots(wsDraft).then(ok => { if (!ok) { wsDraft = prev; renderWsItems(); } });
});
$("btn-ws-add").addEventListener("click", async () => {
  const picked = await api.pickFolder({ defaultPath: wsDraft[wsDraft.length - 1] || state.snapshot?.homeDir });
  if (!picked?.ok || !picked.path) return;
  const p = picked.path, norm = (x) => x.replace(/[\\/]+$/, "").toLowerCase();
  const sep = p.includes("\\") ? "\\" : "/";
  if (wsDraft.some(r => norm(r) === norm(p))) { renderWsItems(wsDraft.find(r => norm(r) === norm(p))); return toast("这个文件夹已经在列表里了"); }
  const parent = wsDraft.find(r => norm(p).startsWith(norm(r) + sep));
  if (parent) { renderWsItems(parent); return toast(`已包含在「${parent}」里，不用重复添加`, "ok"); }
  const prev = [...wsDraft];
  wsDraft = wsDraft.filter(r => !norm(r).startsWith(norm(p) + sep));   // 新加的是父文件夹：合并掉子文件夹
  wsDraft.push(p);
  renderWsItems(p);
  if (!(await saveRoots(wsDraft))) { wsDraft = prev; renderWsItems(); }
});
$("btn-ws-done").addEventListener("click", async () => {
  if (!wsDraft.length) return toast("至少保留一个文件夹");
  const same = JSON.stringify(wsDraft) === JSON.stringify(state.snapshot?.roots ?? []);
  if ((same && state.snapshot?.workspaceConfirmed) || await saveRoots(wsDraft)) closeWsModal();
});
$("btn-ws-later").addEventListener("click", closeWsModal);
$("ws-modal").addEventListener("click", (event) => { if (event.target === $("ws-modal")) closeWsModal(); });
$("btn-ws-edit").addEventListener("click", openWsModal);

$("btn-open-data").addEventListener("click", async () => {
  const snap = state.snapshot;
  if (snap?.dataHome) await api.openPath(snap.dataHome);
});

for (const [id, key] of [["opt-approve", "approve"], ["opt-readonly", "readonlyAuto"], ["opt-jsonresp", "jsonResponse"], ["opt-agent-cursor", "agentCursor"]]) {
  $(id).addEventListener("change", async () => {
    await api.setOptions({ [key]: $(id).checked });
    toast(key === "jsonResponse" ? "已保存（下次启动 Bridge 生效）" : "已保存，立即生效", "ok");
  });
}

// 流程回放执行开关：默认关（只预演）；打开后 flow_replay 带 execute:true 才真的点页面
$("opt-flow-replay-execute").addEventListener("change", async () => {
  const result = await api.settingsSet({ flowReplayExecute: $("opt-flow-replay-execute").checked });
  if (result?.ok === false) return toast(`保存失败：${result.error}`);
  toast($("opt-flow-replay-execute").checked ? "已打开：重启 Bridge 后可真正执行流程回放" : "已关闭：流程回放只做预演", "ok");
});

// 工具档位：存进设置，Bridge 启动时按它过滤 tools/list
$("set-tool-tier").addEventListener("change", async () => {
  const tier = $("set-tool-tier").value === "full" ? "full" : "basic";
  const result = await api.settingsSet({ toolTier: tier });
  if (result?.ok === false) return toast(`保存失败：${result.error}`);
  toast("已保存（重启 Bridge 后生效）", "ok");
});

// AI 空间自动收摊的空闲时间：5 / 10 / 30 / 0=永不；改完立即生效（定时器每拍读一次设置）
$("set-idle-minutes").addEventListener("change", async () => {
  const minutes = Number($("set-idle-minutes").value);
  const result = await api.settingsSet({ idleMinutes: minutes });
  if (result?.ok === false) return toast(`保存失败：${result.error}`);
  toast("已保存，立即生效", "ok");
});

/* ------------------------------------------------------------------ *
 * 启动与公网地址
 * ------------------------------------------------------------------ */

/**
 * 把设置填进输入框。
 *
 * 关键：**正在编辑的输入框不要覆盖**。这个函数会被日志事件频繁调用
 * （每来一条日志就重渲染一次），如果无脑覆盖，用户打字打到一半就被冲掉了。
 */
function renderStartupSettings(snap) {
  const saved = snap.settings ?? {};
  const tunnel = saved.tunnel ?? {};

  const fill = (id, value) => {
    const el = $(id);
    if (!el) return;
    if (document.activeElement === el) return; // 用户正在这里打字，别动
    const next = value ?? "";
    if (el.value !== String(next)) el.value = String(next);
  };

  fill("set-port", saved.port ?? 0);
  fill("set-tunnel-host", tunnel.hostname ?? "");
  fill("set-tunnel-id", tunnel.tunnelId ?? "");
  fill("set-tunnel-cred", tunnel.credentials ?? "");
  fill("set-tunnel-token", tunnel.token ?? "");
  fill("set-ngrok-token", tunnel.ngrokAuthtoken ?? "");
  fill("set-ngrok-domain", tunnel.ngrokDomain ?? "");
  fill("set-cf-token", saved.cloudflare?.apiToken ?? "");
  const tierEl = $("set-tool-tier");
  if (tierEl && document.activeElement !== tierEl) tierEl.value = saved.toolTier === "full" ? "full" : "basic";
  const idleEl = $("set-idle-minutes");
  if (idleEl && document.activeElement !== idleEl) {
    const minutes = Number(saved.idleMinutes);
    idleEl.value = String([0, 5, 10, 30].includes(minutes) ? minutes : 10);
  }

  const check = (id, value) => {
    const el = $(id);
    if (!el) return;
    if (document.activeElement === el) return;
    el.checked = Boolean(value);
  };
  check("set-tunnel-auto", tunnel.autoStart);
  check("opt-flow-replay-execute", saved.flowReplayExecute === true);
  check("set-auto-bridge", saved.autoStartBridge !== false);
  check("set-autolaunch", saved.autoLaunch);
  check("set-auto-connect", saved.autoConnect);
  check("set-close-tray", saved.closeToTray !== false);

  // 端口被占用时会实际换一个，这里如实显示
  const portEl = $("set-port");
  if (portEl && document.activeElement !== portEl && snap.running && snap.port) {
    portEl.dataset.actual = String(snap.port);
  }

  const urlEl = $("set-public-url");
  if (urlEl) {
    const tunnelStatus = snap.tunnel ?? {};
    const running = tunnelStatus.state === "running" && tunnelStatus.publicUrl;
    urlEl.textContent = running
      ? (snap.ownerAuth?.pathEnabled === true ? `${tunnelStatus.publicUrl}/mcp/<令牌>` : `${tunnelStatus.publicUrl}/mcp`)
      : tunnelStatus.hostname
        ? `${tunnelStatus.hostname}（未连接）`
        : "（未配置）";
  }
}

/** 收集界面上的启动设置 */
function collectStartupSettings() {
  const port = Number($("set-port").value.trim());
  return {
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
    autoStartBridge: $("set-auto-bridge").checked,
    ...($("set-auto-connect") ? { autoConnect: $("set-auto-connect").checked } : {}),
    ...($("set-close-tray") ? { closeToTray: $("set-close-tray").checked } : {}),
    tunnel: {
      hostname: $("set-tunnel-host").value.trim(),
      tunnelId: $("set-tunnel-id").value.trim(),
      credentials: $("set-tunnel-cred").value.trim(),
      token: $("set-tunnel-token").value.trim(),
      ngrokAuthtoken: $("set-ngrok-token").value.trim(),
      ngrokDomain: $("set-ngrok-domain").value.trim(),
      autoStart: $("set-tunnel-auto").checked,
    },
    cloudflare: {
      apiToken: $("set-cf-token").value.trim(),
    },
  };
}

async function saveStartupSettings({ silent = false } = {}) {
  const patch = collectStartupSettings();
  const result = await api.settingsSet(patch);
  if (result?.ok === false) { toast(`保存失败：${result.error}`); return false; }
  if (!silent) toast("已保存");
  renderSnapshot(await api.snapshot());
  return true;
}

$("btn-save-startup").addEventListener("click", () => saveStartupSettings());

$("btn-restart-bridge").addEventListener("click", async () => {
  if (!(await saveStartupSettings({ silent: true }))) return;
  toast("正在按新端口重启 Bridge…");
  await api.stop();
  const result = await api.start();
  if (result?.ok === false) return toast(result.error);
  const snap = await api.snapshot();
  renderSnapshot(snap);
  const actual = snap.port;
  const wanted = snap.settings?.port;
  toast(wanted && actual !== wanted ? `Bridge 已启动，但 ${wanted} 被占用，实际用了 ${actual}` : `Bridge 已在端口 ${actual} 启动`);
});

$("btn-start-tunnel").addEventListener("click", async () => {
  if (!(await saveStartupSettings({ silent: true }))) return;
  toast("正在连隧道…");
  if (!state.tunnelProvider) { openConnModal(); return; }
  const result = await api.tunnelStart(state.tunnelProvider);
  if (result?.code === "NO_PROVIDER") { openConnModal(); return; }
  if (result?.ok === false) return toast(result.error);
  const snap = result.state ?? (await api.snapshot());
  renderSnapshot(snap);
  const url = snap.tunnel?.publicUrl;
  toast(url ? `隧道已就绪：${url}` : "隧道已启动");
});

$("btn-stop-tunnel").addEventListener("click", async () => {
  const result = await api.tunnelStop();
  renderSnapshot(result?.state ?? (await api.snapshot()));
  toast("已断开隧道");
});

// 开机自启：勾选就直接写注册表（不跟「保存」按钮走，因为它是系统级状态，
// 写失败要立刻告诉用户，不能等点了保存才发现没生效）
$("set-autolaunch").addEventListener("change", async () => {
  const want = $("set-autolaunch").checked;
  const result = await api.autostartSet(want);
  if (result?.ok === false) {
    $("set-autolaunch").checked = !want; // 回滚界面状态，别让用户以为成功了
    return toast(`设置开机自启失败：${result.error}`);
  }
  toast(want ? "已开启开机自启" : "已关闭开机自启");
});

// ngrok 令牌那一行的小链接：直接开后台页面，省得用户去搜
$("link-ngrok-token")?.addEventListener("click", (event) => {
  event.preventDefault();
  api.openPath("https://dashboard.ngrok.com/get-started/your-authtoken");
});

/* ---------- 一键开通固定地址 ---------- */

/** 缓存的预览结果。确认创建时要用它，而且必须和用户看到的是同一份。 */
let cfPreviewCache = null;

function renderCfPreview(html, { warning = false, kind = "preview" } = {}) {
  const box = $("cf-preview");
  if (!box) return;
  box.hidden = false;
  box.className = `cf-preview${warning ? " has-warning" : ""}`;
  box.dataset.kind = kind;
  box.innerHTML = html;
}

/** 元素转义 —— 域名和错误信息都可能来自外部，别直接塞进 innerHTML */
function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refreshCfStatus() {
  const statusEl = $("cf-cred-status");
  const zonesEl = $("cf-zones");
  if (!statusEl) return;
  statusEl.textContent = "检查中…";
  const result = await api.cloudflare?.status?.();
  if (!result) { statusEl.textContent = "（这个版本没有这个功能）"; return; }
  if (result.ok === false) {
    statusEl.textContent = `不可用：${result.error}`;
    zonesEl.textContent = "—";
    return;
  }
  statusEl.textContent = result.tokenStatus === "active"
    ? `可用（${result.source}）`
    : `令牌状态异常：${result.tokenStatus}${result.tokenError ? ` ${result.tokenError}` : ""}`;
  zonesEl.textContent = (result.zones ?? []).join("、") || "（账号里没有域名）";
}

$("btn-cf-preview")?.addEventListener("click", async () => {
  const hostname = $("cf-hostname").value.trim();
  if (!hostname) return toast("先填一个域名");
  cfPreviewCache = null;
  $("btn-cf-provision").disabled = true;
  renderCfPreview(`<div class="cf-title">正在检查…</div>`);

  const result = await api.cloudflare.preview({ hostname });
  if (result.ok === false) {
    renderCfPreview(
      `<div class="cf-title">检查没过</div><div class="cf-err">${esc(result.error)}</div>` +
      (result.availableZones ? `<div class="cf-warn">账号里可用的域名：${esc(result.availableZones.join("、"))}</div>` : "")
    );
    return;
  }

  cfPreviewCache = result;
  $("btn-cf-provision").disabled = false;

  const steps = result.steps.map((s) => `<li>${esc(s.describe)}</li>`).join("");
  const warnings = result.steps.filter((s) => s.warning)
    .map((s) => `<div class="cf-warn">⚠ ${esc(s.warning)}</div>`).join("");

  renderCfPreview(
    `<div class="cf-title">会做这三件事（现在还没做）：</div><ol>${steps}</ol>${warnings}`,
    { warning: result.hasWarning }
  );
  toast(result.hasWarning ? "检查完了 —— 注意有会覆盖已有配置的地方" : "检查完了，没有会覆盖的东西");
});

$("btn-cf-provision")?.addEventListener("click", async () => {
  if (!cfPreviewCache) return toast("先点上面的「检查」");
  const { hostname, tunnelName } = cfPreviewCache;

  // 二次确认：这一步会在用户的 Cloudflare 账号里真的建东西
  const lines = cfPreviewCache.steps.map((s) => `· ${s.describe}`).join("\n");
  const warnings = cfPreviewCache.steps.filter((s) => s.warning).map((s) => `⚠ ${s.warning}`).join("\n");
  const ok = confirm(
    `确认要在你的 Cloudflare 账号里执行下面这些操作吗？\n\n${lines}` +
    (warnings ? `\n\n${warnings}` : "") +
    `\n\n（会用到账号的 API 权限。已有的隧道会被复用，不会重复建。）`
  );
  if (!ok) return;

  $("btn-cf-provision").disabled = true;
  renderCfPreview(`<div class="cf-title">正在创建…</div>`);

  const result = await api.cloudflare.provision({ hostname, tunnelName, confirm: true });

  if (result.ok === false) {
    renderCfPreview(
      `<div class="cf-title">创建失败</div><div class="cf-err">${esc(result.error)}</div>` +
      `<div class="cf-warn">已经建好的部分不会回滚。可以在 Cloudflare 后台看到并手动清理。</div>`
    );
    $("btn-cf-provision").disabled = false;
    return;
  }

  renderCfPreview(
    `<div class="cf-title">创建完成</div>` +
    `<div class="cf-done">${result.done.map((d) => `✓ ${esc(d)}`).join("<br>")}</div>` +
    `<div class="cf-done" style="margin-top:10px">公网地址：<code>https://${esc(result.hostname)}/mcp/&lt;令牌&gt;</code></div>`,
    { kind: "done" }
  );
  cfPreviewCache = null;
  toast("开通完成，隧道已经用新配置重启了");
  renderSnapshot(await api.snapshot());
  await refreshCfStatus();
});

/* ---------- 共享上下文页的按钮 ---------- */

$("btn-create-group").addEventListener("click", async () => {
  const name = $("new-group-name").value.trim();
  if (!name) { toast("先起个分组名"); return; }
  const result = await api.context.createGroup({ name, note: $("new-group-note").value.trim() });
  if (result?.ok === false) { toast(result.error || "新建失败"); return; }
  $("new-group-name").value = "";
  $("new-group-note").value = "";
  toast("分组已建立");
  await refreshContext();
});

$("btn-context-refresh").addEventListener("click", async () => {
  await refreshContext();
  toast("已刷新");
});

$("btn-context-prune").addEventListener("click", async () => {
  const result = await api.context.prune();
  if (result?.ok === false) { toast(result.error || "清理失败"); return; }
  const removed = result.result?.removed ?? 0;
  toast(removed ? `清掉了 ${removed} 条过期记忆` : "没有过期的记忆");
  await refreshContext();
});

$("btn-inbox-load").addEventListener("click", loadInbox);

/* ---------- MemOS 云端记忆（可选，Key 只进外部 MCP 配置） ---------- */

const MEMOS_STATUS_TEXT = {
  running: "已连接",
  connecting: "连接中…",
  error: "连接失败",
  stopped: "未连接（Bridge 未启动或还没连上）",
  disabled: "已断开",
  "not-configured": "未配置",
};

function renderMemosStatus(status) {
  const configured = status?.configured === true;
  const keyEl = $("set-memos-key");
  if (keyEl && document.activeElement !== keyEl) keyEl.value = "";
  if (keyEl) keyEl.placeholder = configured ? "•••••••• 已配置（留空不修改）" : "MemOS API Key";
  const text = MEMOS_STATUS_TEXT[status?.status] ?? "未知状态";
  $("memos-state").textContent = configured ? text : (status?.status === "error" ? "配置读取失败" : "未配置");
  const disconnect = $("btn-disconnect-memos");
  if (disconnect) disconnect.disabled = !configured || status?.status === "disabled";
}

async function refreshMemosStatus() {
  try {
    const result = await api.memos?.status?.();
    if (result?.ok === false) { $("memos-state").textContent = "读取失败"; return; }
    renderMemosStatus(result);
  } catch {
    $("memos-state").textContent = "读取失败";
  }
}

$("btn-save-memos-key")?.addEventListener("click", async () => {
  const button = $("btn-save-memos-key");
  const key = $("set-memos-key").value.trim();
  const url = $("set-memos-url").value.trim();
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "连接中…";
  try {
    const result = await api.memos?.save?.({ key, url });
    if (result?.ok === false) { toast(`保存失败：${result.error}`); return; }
    renderMemosStatus(result);
    if (result?.status === "error") toast("Key 已保存，但 MemOS 没连上；请检查 Key 和 MCP 地址", "warn");
    else if (result?.status === "running") toast("MemOS 已连接", "ok");
    else toast(result?.reloaded ? "Key 已保存，正在连接 MemOS" : "Key 已保存，Bridge 启动后自动连接", "ok");
  } catch {
    toast("保存失败：主进程没有响应");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

$("btn-disconnect-memos")?.addEventListener("click", async () => {
  const button = $("btn-disconnect-memos");
  button.disabled = true;
  try {
    const result = await api.memos?.disconnect?.();
    if (result?.ok === false) { toast(`断开失败：${result.error}`); return; }
    renderMemosStatus(result);
    toast("已断开 MemOS（条目已禁用，Key 仍保留）", "ok");
  } catch {
    toast("断开失败：主进程没有响应");
  } finally {
    await refreshMemosStatus();
  }
});

refreshMemosStatus();

/* ------------------------------------------------------------------ *
 * 启动（顶层 await 在 Electron 渲染层不可用，所以包一层）
 * ------------------------------------------------------------------ */

/* ---------------- 让其他 AI 操作本软件 ---------------- */
let aiClients = null;
async function refreshAiClients() {
  if (!api.aiClientsStatus) return;
  const r = await api.aiClientsStatus();
  if (!r?.ok) { $("ai-client-list").innerHTML = `<div class="lg-row"><span class="ai-state">读取失败：${esc(r?.error)}</span></div>`; return; }
  aiClients = r;
  $("ai-client-list").innerHTML = r.clients.map((c) => `
    <div class="lg-row ai-row">
      <span class="ai-name">${esc(c.name)}</span>
      <span class="ai-state${c.configured ? " on" : ""}" title="${esc(c.file)}">${c.configured ? "已写入" : c.detected ? "已安装，未写入" : "没检测到"}</span>
      <button class="btn btn-sm${c.configured ? " btn-ghost" : ""}" data-ai-install="${esc(c.key)}">${c.configured ? "重新写入" : "一键写入"}</button>
    </div>`).join("") + `
    <div class="lg-row ai-row">
      <span class="ai-name">命令行 windrise</span>
      <span class="ai-state${r.cli.installed && r.cli.current ? " on" : ""}" title="${esc(r.cli.file)}">${r.cli.installed ? (r.cli.current ? "已安装" : "已安装（软件位置变了，建议重新安装）") : "未安装"}</span>
    </div>`;
  $("btn-cli-install").textContent = r.cli.installed ? "重新安装命令行" : "安装命令行";
}

$("ai-client-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-ai-install]");
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await api.aiClientsInstall(btn.dataset.aiInstall);
    if (!r?.ok) return toast(r?.error || "写入失败", "err");
    toast(`已写入 ${r.name}。${r.restart}`, "ok");
    await refreshAiClients();
  } finally { btn.disabled = false; }
});

$("btn-cli-install").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await api.aiClientsInstallCli();
    if (!r?.ok) return toast(r?.error || "安装失败", "err");
    toast(r.cli.onPath ? "命令行已安装：新开一个终端，输入 windrise status 试试" : `已写入 ${r.cli.file}，但这个目录不在系统路径里，需要手动加入`, "ok");
    await refreshAiClients();
  } finally { btn.disabled = false; }
});

$("btn-ai-prompt").addEventListener("click", async (e) => {
  await refreshAiClients().catch(() => {});
  copyWithFeedback(e.currentTarget, aiClients?.prompt, "提示词已复制，粘贴给 AI 即可");
});
$("btn-ai-config").addEventListener("click", (e) => copyWithFeedback(e.currentTarget, aiClients?.config, "通用 MCP 配置已复制，可粘贴到其他 AI 客户端"));

async function bootstrap() {
  api.onLog?.((record) => {
    state.logs.push(record);
    if (state.logs.length > 200) state.logs.shift();
    if ($("page-tools").classList.contains("active")) renderLogs();
    // AI 通过 custom_tool_save 改了工具 → 列表跟着刷新
    if (record?.kind === "custom-tools") refreshCustomTools().catch(() => {});
  });

  renderSnapshot(await api.snapshot());
  await refreshContext({ silent: true });
  await refreshProfiles();
  await refreshConnectors().catch(() => {});
  await refreshTools();
  refreshSites?.().catch(() => {});
  // 只用用户自己选过的连接方式；没选过就不预选，弹窗让用户选
  const snap0 = await api.snapshot();
  const choice = snap0?.settings?.connectChoice;
  const live0 = snap0?.status?.level === "connected" ? snap0.status.provider : null;
  if (choice || live0) await selectProvider(live0 || choice);
  if (!snap0?.settings?.connectChoiceDone && !live0) setTimeout(openConnModal, 500);
  await refreshCfStatus();
  await refreshReadiness();
  refreshAiClients().catch(() => {});
  setInterval(async () => { renderSnapshot(await api.snapshot()); }, 3000);
}

bootstrap().catch((error) => {
  console.error("初始化失败", error);
  toast(`初始化失败：${error.message}`);
});

/* ------------------------------------------------------------------ *
 * 演示模式（没有 Electron 时的降级，方便调样式）
 * ------------------------------------------------------------------ */

window.bridge?.onGoto?.((tab) => (tab === "choose-connection" ? (gotoTab("bridge"), openConnModal()) : gotoTab(tab)));
function gotoTab(tab) {
  document.querySelector(`.rail-btn[data-tab="${tab}"]`)?.click();
}

document.querySelectorAll("[data-ext]").forEach((a) => a.addEventListener("click", (event) => {
  event.preventDefault();
  api.account.openExternal(a.dataset.ext);
}));

/* ---------- 命令审批 ---------- */

async function refreshApprovals() {
  const r = await api.approvals.list();
  const items = r?.items ?? [];
  $("card-approvals").hidden = items.length === 0;
  setChip($("chip-approvals"), String(items.length), items.length ? "warn" : "");
  const railBtn = document.querySelector('.rail-btn[data-tab="bridge"]');
  let badge = railBtn.querySelector(".badge");
  if (items.length && !badge) { badge = document.createElement("span"); badge.className = "badge"; railBtn.insertBefore(badge, railBtn.querySelector(".rail-kbd")); }
  if (badge) { if (items.length) badge.textContent = String(items.length); else badge.remove(); }
  $("approval-list").innerHTML = items.map((a) => `<div class="list-row">
      <div><div class="mono">${escapeHtml(a.command)}</div><div class="sub">风险：${escapeHtml(a.risk ?? "未知")} · ${escapeHtml(shortTime(a.at))}</div></div>
      <div class="btn-row" style="margin:0"><button class="btn btn-sm btn-primary" data-approve="${escapeHtml(a.id)}">批准</button>
      <button class="btn btn-sm btn-danger" data-reject="${escapeHtml(a.id)}">拒绝</button></div></div>`).join("");
}

$("approval-list").addEventListener("click", async (event) => {
  const ok = event.target.closest("[data-approve]"), no = event.target.closest("[data-reject]");
  if (ok) { await api.approvals.approve(ok.dataset.approve); toast("已批准，让 AI 重新执行这条命令即可"); }
  if (no) { await api.approvals.reject(no.dataset.reject); toast("已拒绝"); }
  refreshApprovals();
});

api.approvals.onRequest(() => { refreshApprovals(); toast("有一条命令等你批准（Bridge 页）"); });
refreshApprovals();


function createStubApi() {
  const stubProfiles = [
    { id: "a1b2c3d4", name: "店铺A", startUrl: "https://example.com", running: true, partition: "persist:profile-a1b2c3d4", currentUrl: "https://example.com/dashboard", color: "#2f6feb", proxy: "socks5://127.0.0.1:1080" },
    { id: "e5f6a7b8", name: "小号1", startUrl: "https://example.com", running: false, partition: "persist:profile-e5f6a7b8", currentUrl: null, color: "#16a34a", proxy: "" },
  ];
  const demoLevel = new URLSearchParams(location.search).get("demo") || "connected";
  const stubSites = [{ key: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", builtin: true }, { key: "u1", name: "飞书文档", url: "https://www.feishu.cn/", builtin: false }];
  const stubTools = [{ name: "get_weather", type: "http", title: "查天气", description: "查询城市天气", method: "GET", url: "https://wttr.in/{{city}}?format=3", params: [{ name: "city", description: "城市", required: true }], enabled: true },
    { name: "team_guidelines", type: "text", title: "团队规范", text: "提交信息用中文", params: [], enabled: false }];
  const demoStatus = { level: demoLevel, provider: "cloudflare", publicMcpUrl: demoLevel === "connected" ? "https://demo-words-here.trycloudflare.com/mcp/6f1a9c2e4b7d8a3f5e0c1b2d4a6f8e9c" : "", error: demoLevel === "error" ? "cloudflared 连不上边缘节点（网络被拦截？）" : "" };
  let demoOwnerPathEnabled = true;
  let demoOwnerSeq = 2;
  const demoOwnerKeys = [
    { id: "k-demo-1", label: "Claude", hint: "9f2c", createdAt: Date.now() - 3600000 },
    { id: "k-demo-2", label: "酥酥", hint: "4d7e", createdAt: Date.now() - 1200000 },
  ];
  const demoOwnerStatus = () => ({
    ok: true,
    bearerEnabled: demoOwnerKeys.length > 0,
    bearerHint: demoOwnerKeys[0]?.hint ?? "",
    bearerCreatedAt: demoOwnerKeys[0]?.createdAt ?? null,
    keys: demoOwnerKeys.map((key) => ({ ...key })),
    pathEnabled: demoOwnerPathEnabled,
    localUrl: "http://127.0.0.1:48272/mcp",
    publicUrl: "https://demo-words-here.trycloudflare.com/mcp",
  });
  return {
    status: async () => demoStatus,
    connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }),
    onStatus: () => () => {}, onConnected: () => () => {},
    license: {
      status: async () => ({ ok: true, status: { activated: true, daysLeft: 27, expiresAt: Date.now() + 27 * 864e5, deviceId: "d".repeat(32), deviceName: "DESKTOP-DEMO · me" } }),
      activate: async () => ({ ok: false, error: "演示模式不能激活" }),
      refresh: async () => ({ ok: true, status: { activated: true, daysLeft: 27, expiresAt: Date.now() + 27 * 864e5, deviceId: "d".repeat(32) } }),
      plans: async () => ({ ok: true, plans: [
        { kind: "D", name: "天卡", days: 1, price: 0, available: false },
        { kind: "M", name: "月卡", days: 30, price: 0, available: false },
        { kind: "Y", name: "年卡", days: 365, price: 0, available: false },
      ] }),
      createOrder: async () => ({ ok: false, error: "演示模式不能购买" }),
      pollOrder: async () => ({ ok: false, error: "演示模式不能购买" }),
      onChanged: () => () => {}, onStatus: () => () => {},
    },
    connectors: {
      list: async () => ({ ok: true, connectors: [], pending: [] }),
      create: async () => ({ ok: true }), remove: async () => ({ ok: true }), rename: async () => ({ ok: true }),
      grant: async () => ({ ok: true }), revoke: async () => ({ ok: true }),
      approve: async () => ({ ok: true }), deny: async () => ({ ok: true }),
      setBearer: async () => ({ ok: true, key: "wrb_demo_only_not_a_real_key", connector: { id: "demo", name: "演示连接器", createdAt: Date.now(), profiles: [] } }),
      setPathMode: async () => ({ ok: true, connector: { id: "demo", name: "演示连接器", createdAt: Date.now(), profiles: [] } }),
      onChanged: () => () => {},
    },
    ownerAuth: {
      status: async () => demoOwnerStatus(),
      generate: async () => {
        demoOwnerKeys.length = 0;
        const key = { id: `k-demo-${++demoOwnerSeq}`, label: "主口令", hint: "a1b2", createdAt: Date.now() };
        demoOwnerKeys.push(key);
        return { ...demoOwnerStatus(), key: "wrb_demo_only_not_a_real_key", id: key.id };
      },
      revoke: async () => {
        demoOwnerKeys.length = 0;
        return demoOwnerStatus();
      },
      addKey: async (label) => {
        const key = { id: `k-demo-${++demoOwnerSeq}`, label: String(label ?? "").trim() || "未命名口令", hint: "a1b2", createdAt: Date.now() };
        demoOwnerKeys.push(key);
        return { ...demoOwnerStatus(), key: "wrb_demo_only_not_a_real_key", id: key.id };
      },
      rotateKey: async (id) => {
        const index = demoOwnerKeys.findIndex((key) => key.id === id);
        if (index < 0) return { ok: false, error: "没找到这把口令" };
        const next = { ...demoOwnerKeys[index], id: `k-demo-${++demoOwnerSeq}`, hint: "c3d4", createdAt: Date.now() };
        demoOwnerKeys[index] = next;
        return { ...demoOwnerStatus(), key: "wrb_demo_only_not_a_real_key", id: next.id };
      },
      revokeKey: async (id) => {
        const index = demoOwnerKeys.findIndex((key) => key.id === id);
        if (index < 0) return { ok: false, error: "没找到这把口令" };
        demoOwnerKeys.splice(index, 1);
        return demoOwnerStatus();
      },
      rotatePath: async () => demoOwnerStatus(),
      setPath: async (enabled) => {
        demoOwnerPathEnabled = Boolean(enabled);
        return demoOwnerStatus();
      },
    },
    sitesList: async () => ({ ok: true, sites: stubSites }), siteAdd: async () => ({ ok: true }), siteRemove: async () => ({ ok: true }),
    customTools: {
      list: async () => ({ ok: true, specs: stubTools }), save: async () => ({ ok: true, live: true }),
      remove: async () => ({ ok: true }), toggle: async () => ({ ok: true }),
      test: async () => ({ ok: true, isError: false, text: "Beijing: ☀️ +21°C", ms: 412 }),
    },
    snapshot: async () => ({
      status: demoStatus, appName: "Windrise Bridge",
      running: demoLevel !== "stopped", mcpUrl: "http://127.0.0.1:51823/mcp/6f1a9c2e4b7d8a3f5e0c1b2d4a6f8e9c",
      healthUrl: "http://127.0.0.1:51823/healthz/6f1a9c2e4b7d8a3f5e0c1b2d4a6f8e9c",
      health: { calls: 535, failures: 28, successRate: 94.8, averageDurationMs: 5900, tools: 18, sessions: 1, uptimeMs: 360000 },
      tunnel: demoLevel === "connected" ? { state: "running", provider: "cloudflare", publicUrl: "https://demo-words-here.trycloudflare.com", phase: "connected", connected: true } : demoLevel === "connecting" ? { state: "running", provider: "cloudflare", phase: "connecting" } : { state: "stopped" },
      roots: ["D:\\work"], dataHome: "D:\\Apps\\Windrise Bridge\\data",
      tokenFile: "D:\\Apps\\Windrise Bridge\\data\\route-token.json", hubRoot: "D:\\Apps\\Windrise Bridge\\data\\shared\\workspace-hub",
      options: { approve: true, readonlyAuto: true, jsonResponse: true },
      ownerAuth: { count: demoOwnerKeys.length, pathEnabled: demoOwnerPathEnabled },
      license: { activated: true, daysLeft: 27, expiresAt: Date.now() + 27 * 864e5 },
      port: 48272,
      settingsFile: "D:\\Apps\\Windrise Bridge\\data\\settings.json",
      settings: {
        port: 48272, autoLaunch: false, autoStartBridge: true, autoConnect: true, closeToTray: true,
        tunnel: { hostname: "mcp.example.com", tunnelId: "c2c-458730eb78e3", credentials: "", token: "", autoStart: true },
      },
      logs: [
        { at: Date.now() - 5000, kind: "bridge", text: "Bridge 已启动，工具 18 个", level: "ok" },
        { at: Date.now() - 3000, kind: "session-open", text: "客户端已连接" },
      ],
    }),
    start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    listTools: async () => ({ ok: true, tools: [
      ["read_files", "读取文件", "read"], ["apply_patch", "应用补丁", "write"], ["run_command", "执行命令", "execute"],
      ["set_todos", "设置任务卡", "control"], ["search_files", "搜索内容", "read"], ["list_directory", "列目录", "read"],
    ].map(([name, title, capability]) => ({ name, title, capability })).concat([{ name: "get_weather", title: "查天气", capability: "read", source: "user" }]) }),
    setRoots: async () => ({ ok: true }), setOptions: async () => ({ ok: true }),
    settingsGet: async () => ({ ok: true, settings: {}, file: "D:\\Apps\\Windrise Bridge\\data\\settings.json" }),
    settingsSet: async () => ({ ok: true }),
    memos: {
      status: async () => ({ ok: true, configured: false, status: "not-configured" }),
      save: async () => ({ ok: true, configured: true, status: "running", reloaded: true }),
      disconnect: async () => ({ ok: true, configured: true, status: "disabled", reloaded: true }),
    },
    autostartGet: async () => ({ ok: true, enabled: false, command: '"C:\\path\\Windrise Bridge.exe"' }),
    autostartSet: async () => ({ ok: true, enabled: true }),
    cloudflare: {
      status: async () => ({
        ok: true,
        source: "C:\\Users\\me\\.cloudflared\\cert.pem（cloudflared 登录时留下的凭据，账号级权限）",
        tokenStatus: "active",
        zones: ["example.com"],
      }),      preview: async () => ({
        ok: true,
        zone: { id: "z1", name: "example.com" },
        tunnel: { name: "bridge-mcp-abc123", existing: false },
        dns: { existing: false },
        hasWarning: false,
        tunnelName: "bridge-mcp-abc123",
        localPort: 48272,
        steps: [
          { action: "create-tunnel", describe: "新建隧道「bridge-mcp-abc123」" },
          { action: "set-ingress", describe: "把 mcp.example.com 的流量转到本机 http://127.0.0.1:48272" },
          { action: "create-dns", describe: "新建 DNS 记录：CNAME mcp.example.com → <隧道>.cfargotunnel.com" },
        ],
      }),
      provision: async () => ({ ok: true, hostname: "mcp.example.com", done: ["已建隧道", "已配转发", "已建 DNS 记录"] }),
    },
    clients: {
      status: async () => ({
        ok: true,
        status: {
          cloudflared: { found: true, source: "系统 PATH", version: "cloudflared version 2026.10.0", label: "Cloudflare cloudflared" },
          ngrok: { found: false, error: "没找到 ngrok", canInstall: true, label: "ngrok", homepage: "https://ngrok.com/download" },
        },
      }),
      install: async () => ({ ok: true, installed: true, version: "ngrok version 3.39.11" }),
      onProgress: () => () => {},
    },
    tunnelStart: async () => ({ ok: true }), tunnelStop: async () => ({ ok: true }), tunnelProbe: async () => ({ ok: true, result: { installed: true, binary: "cloudflared", version: "cloudflared version 2026.10.0" } }),
    profilesList: async () => ({ ok: true, profiles: stubProfiles }),
profileCreate: async () => ({ ok: true }), profileQuickOpen: async () => ({ ok: true, profile: { name: "示例账号 1" } }), profileOpen: async () => ({ ok: true, reused: false }),
    profileClose: async () => ({ ok: true }), profileUpdate: async () => ({ ok: true }), profileRemove: async () => ({ ok: true }),
    profileCookies: async () => ({ ok: true, count: 12, domains: ["example.com"] }), profileNavigate: async () => ({ ok: true }),
    openPath: async () => ({ ok: true }), pickFolder: async () => ({ ok: false }), copy: async () => ({ ok: true }),
    context: {
      snapshot: async () => ({
        available: true,
        profiles: stubProfiles.map(p => ({ id: p.id, name: p.name, running: p.running })),
        stats: { groups: 1, items: 3, bytes: 2048 },
        groups: [{
          id: "grp-demo", name: "演示分组", note: "演示模式下是假数据", createdAt: Date.now(),
          members: [stubProfiles[0].id],
          memberNames: [{ id: stubProfiles[0].id, name: stubProfiles[0].name, running: true }],
          items: [
            { id: "i1", key: "登录页-验证码", value: "验证码在 iframe 里，id=cap-frame，要先切进去再填", tags: ["登录", "踩坑"], sourceProfileId: stubProfiles[0].id, sourceName: stubProfiles[0].name, at: Date.now() - 60000 },
            { id: "i2", key: "接口-限速", value: "列表接口每分钟 60 次，超了返回 429 并封 5 分钟", tags: ["接口"], sourceProfileId: stubProfiles[0].id, sourceName: stubProfiles[0].name, at: Date.now() - 30000 },
          ],
        }],
      }),
      createGroup: async () => ({ ok: true }), updateGroup: async () => ({ ok: true }), deleteGroup: async () => ({ ok: true }),
      link: async () => ({ ok: true }), unlink: async () => ({ ok: true }),
      share: async () => ({ ok: true }), recall: async () => ({ ok: true, result: [] }), forget: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      inbox: async () => ({ ok: true, result: [
        { id: "m1", from: stubProfiles[0].id, to: stubProfiles[1].id, text: "A 组的登录页已经通了，验证码那段我写进共享记忆了", at: Date.now() - 20000, read: false },
      ] }),
      markRead: async () => ({ ok: true }), stats: async () => ({ ok: true, result: {} }),
      prune: async () => ({ ok: true, result: { removed: 0 } }), groupsFor: async () => ({ ok: true, result: [] }),
    },
    approvals: {
      list: async () => ({ ok: true, items: [{ id: "ap1", command: "Remove-Item -Recurse .\\dist", risk: "dangerous", at: Date.now() }] }),
      approve: async () => ({ ok: true }), reject: async () => ({ ok: true }), onRequest: () => () => {},
    },
    account: { openExternal: async () => {} },
    onLog: () => () => {},
  };
}


/* =====================================================================
 * 图文教程（内容在 guides.js）：侧栏手风琴 + 放大弹窗（左边目录，可全屏）
 * ===================================================================== */
function guideVars() {
  const snap = state.snapshot ?? {};
  return {
    port: snap.port ?? snap.settings?.port ?? "端口",
    url: connectionTarget(snap) || "",
    hostname: snap.settings?.tunnel?.hostname || "mcp.你的域名.com",
    root: (snap.roots ?? [])[0] || "",
  };
}
function fillVars(text, vars) {
  return String(text ?? "").replace(/\{(port|url|hostname|root)\}/g, (_m, k) => vars[k] || (k === "url" ? "（隧道打通后这里会显示地址）" : k === "root" ? "D:\\你的文件夹" : ""));
}
function guideButton(action, vars, cls = "btn btn-sm") {
  const attrs = Object.entries(action).filter(([k]) => k !== "label").map(([k, v]) => `data-ga-${k}="${escapeHtml(fillVars(v, vars))}"`).join(" ");
  return `<button class="${cls}" ${attrs}>${escapeHtml(action.label)}</button>`;
}
function levelTag(g) {
  const lv = LEVELS[g.level] ?? LEVELS[1];
  return `<span class="lv ${lv.cls}">${lv.name}</span>`;
}
/** 一步的 HTML（侧栏和弹窗共用，侧栏是紧凑版） */
function stepHtml(st, i, vars, { compact = false, focus } = {}) {
  const code = st.code !== undefined ? fillVars(st.code, vars) : null;
  const hasCode = code && !(st.code === "{url}" && !vars.url);
  return `<li class="guide-step${st.id === focus ? " focus" : ""}" data-step="${escapeHtml(st.id)}">
    <span class="gs-num">${i + 1}</span>
    <div class="gs-body">
      <b>${escapeHtml(st.title)}</b>
      <p>${escapeHtml(fillVars(st.text, vars))}</p>
      ${code !== null ? `<div class="gs-code"><code>${escapeHtml(maskUrl(code))}</code>${hasCode ? `<button class="btn btn-sm" data-ga-copy="${escapeHtml(code)}">复制</button>` : ""}</div>` : ""}
      ${st.warn ? `<p class="gs-warn">${escapeHtml(st.warn)}</p>` : ""}
      ${st.actions?.length ? `<div class="gs-actions">${st.actions.map((a) => guideButton(a, vars, compact ? "btn btn-sm btn-ghost" : "btn btn-sm")).join("")}</div>` : ""}
    </div>
  </li>`;
}

/* ---------- 原理图：AI → MCP → 隧道 → 电脑（点在线上流动，去程紫色、回程绿色） ---------- */
const FLOW_IC = {
  ai: '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z" /><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />',
  mcp: '<path d="M9 3v5M15 3v5" /><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z" /><path d="M12 17v4" />',
  tunnel: '<circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5M12 3.5C9.6 5.9 8.6 8.8 8.6 12s1 6.1 3.4 8.5" />',
  pc: '<rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" />',
};
function flowHtml(vertical = false) {
  const node = (k, name, sub) => `<div class="fl-node fl-${k}"><span class="fl-ic"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">${FLOW_IC[k]}</svg></span><span class="fl-tx"><b>${name}</b><small>${sub}</small></span></div>`;
  const link = (k) => `<div class="fl-link" style="--k:${k}" aria-hidden="true"><i class="fl-line"></i><i class="fl-dot"></i><i class="fl-dot back"></i></div>`;
  return `<div class="flow${vertical ? " v" : ""}" role="img" aria-label="AI 助手经 MCP 地址和隧道连到你的电脑">
    ${node("ai", "AI 助手", "Claude · ChatGPT")}${link(0)}${node("mcp", "MCP 地址", "https://…/mcp")}${link(1)}${node("tunnel", "隧道", "Cloudflare · ngrok")}${link(2)}${node("pc", "你的电脑", "允许的文件夹")}
    <div class="fl-legend"><span><i class="go"></i>指令</span><span><i class="bk"></i>结果</span></div>
  </div>`;
}

/* ---------- 侧栏：从易到难，点开展开 ---------- */
const railGuide = { open: localStorage.getItem("railGuideOpen") ?? "" };
function renderRailGuides() {
  const vars = guideVars();
  $("rg-list").innerHTML = GUIDE_ORDER.map((id, index) => {
    const g = GUIDES[id];
    const open = railGuide.open === id;
    // 内容始终渲染，靠 .open 切换：这样展开 / 收起可以做高度过渡
    return `<div class="rg-item${open ? " open" : ""}" data-rg="${id}" style="--i:${index}">
      <button class="rg-row" data-rg-toggle="${id}" aria-expanded="${open}" aria-controls="rg-body-${id}">
        <span class="rg-no">${String(index + 1).padStart(2, "0")}</span>${levelTag(g)}<span class="rg-name">${escapeHtml(g.short ?? g.title.split("：")[0])}</span>
        <span class="rg-min">${g.minutes} 分钟</span>
        <svg class="i rg-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div class="rg-fold" id="rg-body-${id}"${open ? "" : " inert"}><div class="rg-body">
        <p class="rg-intro">${escapeHtml(g.intro)}</p>${g.diagram ? flowHtml(true) : ""}
        <ol class="guide-steps compact">${g.steps.map((st, i) => stepHtml(st, i, vars, { compact: true })).join("")}</ol>
        <div class="rg-foot"><button class="btn btn-sm" data-rg-big="${id}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6" /> <path d="m21 3-7 7" /> <path d="m3 21 7-7" /> <path d="M9 21H3v-6" /></svg>放大看${g.tips?.length ? `（含 ${g.tips.length} 条常见问题）` : ""}</button></div>
      </div></div>
    </div>`;
  }).join("");
}
/** 原地展开 / 收起（不重绘），一次只开一个 */
function setRailGuideOpen(id) {
  railGuide.open = id;
  localStorage.setItem("railGuideOpen", id);
  $("rg-list").querySelectorAll(".rg-item").forEach((item) => {
    const on = item.dataset.rg === id;
    item.classList.toggle("open", on);
    item.querySelector(".rg-row").setAttribute("aria-expanded", String(on));
    item.querySelector(".rg-fold").inert = !on;
  });
}
$("rg-list").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-rg-toggle]");
  if (toggle) {
    const id = toggle.dataset.rgToggle;
    setRailGuideOpen(railGuide.open === id ? "" : id);
    if (railGuide.open) setTimeout(() => $("rg-list").querySelector(`[data-rg="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 280);
    return;
  }
  const big = event.target.closest("[data-rg-big]");
  if (big) return openGuide(big.dataset.rgBig);
  const b = event.target.closest("button");
  if (b) runGuideAction(b, { fromRail: true });
});
$("btn-guides-expand").addEventListener("click", () => openGuide(railGuide.open || GUIDE_ORDER[0]));
renderRailGuides();

/* ---------- 放大弹窗 ---------- */
let guideCurrent = null;
function openGuide(id, step) {
  const g = GUIDES[id];
  if (!g) return;
  const switching = !$("guide-modal").hidden && guideCurrent !== id;
  guideCurrent = id;
  const vars = guideVars();
  $("guide-nav").innerHTML = `<div class="gn-title">全部教程</div>` + [1, 2, 3].map((lv) => {
    const ids = GUIDE_ORDER.filter((k) => GUIDES[k].level === lv);
    return `<div class="gn-group"><div class="gn-level">${LEVELS[lv].name}</div>${ids.map((k) => `<button class="gn-item${k === id ? " active" : ""}" data-ga-guide="${k}"><i class="gn-no">${GUIDE_ORDER.indexOf(k) + 1}</i>${escapeHtml(GUIDES[k].short ?? GUIDES[k].title.split("：")[0])}<span>${GUIDES[k].minutes} 分钟</span></button>`).join("")}</div>`;
  }).join("");
  $("guide-title").textContent = g.title;
  $("guide-meta").innerHTML = `${levelTag(g)}<span>约 ${g.minutes} 分钟 · ${g.steps.length} 步</span>`;
  $("guide-intro").textContent = g.intro;
  $("guide-diagram").innerHTML = g.diagram ? flowHtml() : "";
  $("guide-diagram").hidden = !g.diagram;
  $("guide-steps").innerHTML = g.steps.map((st, i) => stepHtml(st, i, vars, { focus: step })).join("");
  $("guide-tips").innerHTML = g.tips?.length ? `<div class="gt-title">常见问题</div><ul>${g.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : "";
  $("guide-tips").hidden = !g.tips?.length;
  $("guide-foot").innerHTML = `${(g.footer ?? []).map((a) => guideButton(a, vars)).join("")}<span class="ws-spacer"></span><button class="btn btn-primary" data-ga-close="1">知道了</button>`;
  $("guide-modal").hidden = false;
  if (switching) window.__motion?.replay?.(document.querySelector(".guide-main"), "swap");
  const focus = step && $("guide-steps").querySelector(`[data-step="${CSS.escape(step)}"]`);
  requestAnimationFrame(() => { if (focus) focus.scrollIntoView({ block: "center" }); else $("guide-scroll").scrollTop = 0; });
}
function closeGuide() { $("guide-modal").hidden = true; }
function setGuideFull(on) {
  $("guide-modal").classList.toggle("full", on);
  $("btn-guide-full").textContent = on ? "还原" : "全屏";
  localStorage.setItem("guideFull", on ? "1" : "");
}
setGuideFull(localStorage.getItem("guideFull") === "1");

/** 教程里的按钮：打开网页 / 复制 / 跳教程 / 切连接方式 / 跳到输入框 / 替用户点按钮 */
function runGuideAction(b, { fromRail = false } = {}) {
  const d = b.dataset;
  const leave = () => { if (!fromRail) closeGuide(); };
  if (d.gaOpen) return api.account.openExternal(d.gaOpen);
  if (d.gaCopy) return copyWithFeedback(b, d.gaCopy, "已复制");
  if (d.gaGuide) {
    if (fromRail) { setRailGuideOpen(d.gaGuide); return; }
    return openGuide(d.gaGuide);
  }
  if (d.gaProvider) {
    leave();
    gotoTab("bridge");
    document.querySelector(`.tunnel[data-provider="${CSS.escape(d.gaProvider)}"]`)?.click();
    return;
  }
  if (d.gaFocus || d.gaClick) {
    leave();
    if (d.gaTab) gotoTab(d.gaTab);
    const el = $(d.gaFocus || d.gaClick);
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      if (d.gaClick) el.click(); else el.focus?.();
      el.classList.remove("guide-flash"); void el.offsetWidth; el.classList.add("guide-flash");
    }, 120);
  }
}

$("guide-modal").addEventListener("click", (event) => {
  if (event.target === $("guide-modal")) return closeGuide();
  const b = event.target.closest("button");
  if (!b) return;
  if (b.id === "btn-guide-close" || b.dataset.gaClose) return closeGuide();
  if (b.id === "btn-guide-full") return setGuideFull(!$("guide-modal").classList.contains("full"));
  runGuideAction(b);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("guide-modal").hidden) closeGuide(); });
/** 页面上任何带 data-guide 的按钮都能打开教程（准备度、错误提示等） */
document.addEventListener("click", (event) => {
  const b = event.target.closest?.("[data-guide]");
  if (!b || !b.dataset.guide) return;
  event.preventDefault();
  openGuide(b.dataset.guide, b.dataset.guideStep || undefined);
});
$("btn-tunnel-guide").addEventListener("click", () => openGuide(GUIDE_FOR_PROVIDER[state.tunnelProvider] ?? "quick"));


/* ------------------------------------------------------------------ *
 * 网络检测（首页卡片）
 * ------------------------------------------------------------------ */
const netUi = { running: false, lastAt: 0, connectingSince: 0, lastLevel: "" };
const NET_WARN = new Set(["clock", "proxy-blocked", "dns", "network-blocked"]);

function renderNet(res, { auto }) {
  const card = $("card-net"), status = $("net-status"), extra = $("net-extra");
  extra.replaceChildren();
  extra.hidden = true;
  if (!res?.ok) {
    card.dataset.level = "warn";
    status.hidden = false; status.textContent = `检测没完成：${res?.error ?? "未知错误"}`;
    return;
  }
  const v = res.verdict ?? {};
  const warn = NET_WARN.has(v.code);
  if (auto && !warn) { card.dataset.level = "ok"; status.hidden = false; status.textContent = "网络正常"; return; }
  card.dataset.level = warn ? "warn" : "ok";
  status.hidden = false;
  status.textContent = v.text ?? "";
  if (v.code === "proxy-blocked") {
    extra.hidden = false;
    for (const line of v.options ?? []) { const p = document.createElement("span"); p.textContent = `• ${line}`; extra.append(p); }
    if (v.rules?.length) {
      const pre = document.createElement("pre");
      pre.textContent = [...v.rules.map((r) => `- ${r}`), ...(v.fakeIpFilter?.length ? ["", "# fake-ip-filter：", ...v.fakeIpFilter] : [])].join("\n");
      const btn = document.createElement("button");
      btn.className = "btn btn-sm"; btn.textContent = "复制规则";
      btn.addEventListener("click", async () => { try { await navigator.clipboard.writeText(pre.textContent); toast("规则已复制", "ok"); } catch { toast("复制失败，请手动选中复制"); } });
      extra.append(pre, btn);
    }
  } else if (v.code === "clock") {
    extra.hidden = false;
    const p = document.createElement("span"); p.textContent = "• 把系统时间调准（开启自动同步）后重试。"; extra.append(p);
  }
}

async function runNetCheck({ auto = false } = {}) {
  if (!api.net?.diagnose || netUi.running) return;
  netUi.running = true; netUi.lastAt = Date.now();
  const btn = $("btn-net-check");
  btn.disabled = true; btn.textContent = "检测中…";
  if (!auto) { $("net-status").hidden = false; $("net-status").textContent = "正在检测，通常 1–8 秒…"; $("card-net").dataset.level = "idle"; }
  try { renderNet(await api.net.diagnose({ force: !auto }), { auto }); }
  catch (error) { renderNet({ ok: false, error: error.message }, { auto }); }
  finally { netUi.running = false; btn.disabled = false; btn.textContent = "检测网络"; }
}

$("btn-net-check").addEventListener("click", () => runNetCheck());
$("btn-net-guide").addEventListener("click", () => openGuide("proxy"));
setTimeout(() => runNetCheck({ auto: true }), 3000);
// 出错，或「连接中」超过 40 秒：自动查一次原因（两次自动检查至少隔 30 秒）
api.onStatus?.((snap) => {
  const level = snap?.status?.level ?? "";
  if (level === "connecting" && netUi.lastLevel !== "connecting") netUi.connectingSince = Date.now();
  const stuck = level === "connecting" && Date.now() - netUi.connectingSince > 40_000;
  const failed = level === "error" && netUi.lastLevel !== "error";
  netUi.lastLevel = level;
  if ((stuck || failed) && Date.now() - netUi.lastAt > 30_000) runNetCheck({ auto: false });
});

/* ------------------------------------------------------------------ *
 * 自动更新（首页横幅 + 设置页）
 * ------------------------------------------------------------------ */
const upd = { st: null, hidden: "" };

function fmtMB(n) { return `${(n / 1048576).toFixed(1)} MB`; }

function renderUpdate(st) {
  upd.st = st;
  if (!st) return;
  const banner = $("update-banner"), text = $("update-text");
  const main = $("btn-update-main"), later = $("btn-update-later"), skip = $("btn-update-skip");
  banner.querySelector(".upd-bar")?.remove();
  const v = st.latest?.version;
  const forced = Boolean(st.latest?.mandatory);
  const hiddenNow = upd.hidden === v && !forced;
  let show = false, label = "", mainLabel = "", mainAct = "";
  if (v && st.status === "available") {
    show = true; mainAct = "download"; mainLabel = "立即更新";
    label = `${forced ? "必须更新：" : "发现新版本 "}${v}（${fmtMB(st.latest.size)}）${st.latest.notes ? `　${st.latest.notes.split("\n")[0]}` : ""}`;
  } else if (v && st.status === "downloading") {
    show = true; const p = st.progress; const pct = p?.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
    label = `正在下载 ${v}：${pct}%`;
    const bar = document.createElement("span"); bar.className = "upd-bar"; bar.innerHTML = `<i style="width:${pct}%"></i>`;
    text.after(bar);
  } else if (v && st.status === "ready") {
    show = true; mainAct = "install"; mainLabel = st.canInstall ? "重启并安装" : "已下载";
    label = st.canInstall ? `${v} 已下载好，重启后完成更新` : `${v} 已下载好（开发模式不会自动安装）`;
  } else if (v && st.status === "error" && st.error) {
    show = true; mainAct = "download"; mainLabel = "重试"; label = `更新失败：${st.error}`;
  }
  banner.hidden = !show || (hiddenNow && st.status === "available");
  text.textContent = label;
  main.hidden = !mainAct || (mainAct === "install" && !st.canInstall); main.dataset.act = mainAct; main.textContent = mainLabel;
  later.hidden = !(st.status === "available") || forced;
  skip.hidden = later.hidden;

  // 设置页
  $("upd-version").textContent = st.current ?? "—";
  const when = st.lastCheckAt ? new Date(st.lastCheckAt).toLocaleString() : "";
  $("upd-status").textContent = st.status === "checking" ? "正在检查…"
    : st.status === "downloading" ? label
    : st.status === "available" ? `有新版本 ${v}`
    : st.status === "ready" ? `${v} 已下载，等待重启安装`
    : st.status === "error" ? `出错：${st.error}`
    : st.lastCheckAt ? `已是最新版本（${when} 检查）` : "还没检查过";
  $("btn-upd-check").disabled = st.status === "checking" || st.status === "downloading";
}

$("btn-update-main").addEventListener("click", async () => {
  const act = $("btn-update-main").dataset.act;
  if (act === "download") renderUpdate((await api.update.download())?.state ?? upd.st);
  else if (act === "install") { const r = await api.update.install(); if (!r?.ok) toast(r?.error || "安装失败"); }
});
$("btn-update-later").addEventListener("click", () => { upd.hidden = upd.st?.latest?.version ?? ""; renderUpdate(upd.st); });
$("btn-update-skip").addEventListener("click", async () => { const r = await api.update.skip(); if (!r?.ok) toast(r?.error || "不能跳过"); });
$("btn-upd-check").addEventListener("click", async () => {
  const r = await api.update.check();
  renderUpdate(r?.state ?? upd.st);
  if (r?.state?.status === "idle") toast("已是最新版本", "ok");
});
$("upd-auto").addEventListener("change", (e) => api.settingsSet({ autoUpdate: e.target.checked }));
if (api.update) {
  api.update.onState(renderUpdate);
  api.update.state().then((r) => renderUpdate(r?.state)).catch(() => {});
  api.settingsGet?.().then((r) => { $("upd-auto").checked = r?.settings?.autoUpdate !== false; }).catch(() => {});
}
