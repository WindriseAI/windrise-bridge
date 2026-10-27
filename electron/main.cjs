/**
 * Electron 主进程（CommonJS）—— 把 Bridge 服务、多开浏览器、控制面板串起来。
 *
 * 职责分工：
 *   - 主进程：跑 MCP 服务器（Node 侧）、管浏览器分区窗口、管隧道子进程
 *   - 渲染进程：只画界面，通过 preload 暴露的窄接口发指令
 *   - 之间不做 nodeIntegration，走 contextBridge + IPC
 */

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeTheme, Tray, Menu, nativeImage, Notification, net, powerMonitor, screen, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { createAppLog, collectSecrets } = require("./app-log.cjs");
const { newPublicCheck, healthTarget, judgeProbe, applyProbe, publicHost, alarmMessage, publicStatusOverride, settlesVerification, classifyProbeError, controlTarget, judgeWithControl, probeDue } = require("./public-check.cjs");
const { tidyTunnelLine, logText, addMetaCall, metaLogPlan } = require("./log-tidy.cjs");
const { buildPanelState, readRecentActions, brokerStatus } = require("./panel-state.cjs");
const memosBridge = require("./memos-bridge.cjs");
const { buildTrayTemplate } = require("./tray-menu.cjs");
const { shouldOpenGridOnStart, gridNameFor, trayStatusLine, openGrid1Flow, secondInstancePlan, GRID1_START_URL, shouldOpenOnboarding } = require("./startup-flow.cjs");
const { createTaskbarGrouping } = require("./taskbar-grouping.cjs");
/* ------------------------------------------------------------------ *
 * 品牌 + 数据目录（必须在 require 其它模块、app ready 之前定下来）
 *
 * 数据默认放在软件自己的目录里，不再默认写 C 盘用户目录：
 *   - 便携版：exe 所在目录\WindriseBridge-data
 *   - 安装版：安装目录\data（卸载 / 升级时保留，见 build/installer.nsh）
 *   - 开发运行：项目目录\data
 * 目录不可写（例如装进了 Program Files）才回退到用户目录。
 * 浏览器多开的登录态（Electron userData）也一起放进去。
 * ------------------------------------------------------------------ */
const APP_NAME = "Windrise Bridge";
const APP_ID = "com.windrise.bridge";
const LEGACY_HOME = path.join(os.homedir(), ".bridge-replica");

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

function resolveDataHome() {
  const explicit = process.env.WINDRISE_DATA_HOME?.trim();
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, "WindriseBridge-data"));
  // 只有 Windows 安装版放安装目录：macOS 的 .app 里不能写（会破坏签名、升级时整包替换会把数据冲掉）
  else if (app.isPackaged && process.platform === "win32") candidates.push(path.join(path.dirname(process.execPath), "data"));
  else if (app.isPackaged) { /* macOS / Linux：直接用下面的系统用户目录 */ }
  else candidates.push(path.join(__dirname, "..", "data"));
  candidates.push(path.join(app.getPath("appData"), APP_NAME));
  for (const dir of candidates) if (writableDir(dir)) return dir;
  return LEGACY_HOME;
}

/**
 * 一次性迁移：把旧版放在 C 盘的数据搬过来（复制，不删原件，出问题还能回退）。
 * 浏览器缓存不搬（可再生、体积大），登录态（Cookie / Local Storage / IndexedDB）照搬。
 */
const SKIP_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "CacheStorage", "ScriptCache", "Crashpad", "blob_storage"]);
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)) && !/browser-control(-\d+)?\.json$/.test(src) && !/\.(lock|tmp)$/i.test(src) && path.basename(src) !== "SingletonLock",
  });
}
function migrateLegacy(dataHome, userData) {
  const marker = path.join(dataHome, ".migrated");
  if (fs.existsSync(marker)) return null;
  const done = [];
  try {
    if (path.resolve(LEGACY_HOME) !== path.resolve(dataHome) && fs.existsSync(path.join(LEGACY_HOME, "settings.json")) && !fs.existsSync(path.join(dataHome, "settings.json"))) {
      copyTree(LEGACY_HOME, dataHome);
      done.push(LEGACY_HOME);
    }
    // 旧版浏览器登录态：%APPDATA%\Bridge Replica（打包版）或 %APPDATA%\bridge-replica（开发运行）
    const oldUserData = ["Bridge Replica", "bridge-replica"].map(n => path.join(app.getPath("appData"), n)).find(d => fs.existsSync(path.join(d, "Partitions")));
    if (oldUserData && path.resolve(oldUserData) !== path.resolve(userData) && !fs.existsSync(path.join(userData, "Partitions"))) {
      // 先复制到临时目录再改名：中途失败不会留下「半份」登录态而被当成已迁移
      const staging = path.join(userData, "Partitions.migrating");
      fs.rmSync(staging, { recursive: true, force: true });
      copyTree(path.join(oldUserData, "Partitions"), staging);
      fs.renameSync(staging, path.join(userData, "Partitions"));
      done.push(oldUserData);
    }
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), from: done }, null, 2));
  } catch (error) {
    return { error: error.message, from: done };
  }
  return done.length ? { from: done } : null;
}

app.setName(APP_NAME);
/*
 * macOS 从访达 / 启动台打开的程序拿不到终端里的 PATH（只有 /usr/bin:/bin:/usr/sbin:/sbin），
 * 用 Homebrew 装的 cloudflared、node 等都会「找不到」。这里补上常见目录，再尽量读一次登录 shell 的 PATH。
 */
if (process.platform === "darwin" || process.platform === "linux") {
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  try {
    const shellPath = require("node:child_process").execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "printf %s \"$PATH\""], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (shellPath && shellPath.includes("/")) extra.unshift(...shellPath.trim().split(":"));
  } catch { /* 读不到就只用常见目录 */ }
  const parts = [...new Set([...(process.env.PATH || "").split(":"), ...extra].filter(Boolean))];
  process.env.PATH = parts.join(":");
}
const DATA_HOME = resolveDataHome();
const USER_DATA = path.join(DATA_HOME, "electron");
/*
 * 预置数据（测试版用）：打包时把 build/seed/ 放进 resources/seed/，
 * 第一次运行、数据目录里还没有设置文件时整份复制过去（固定地址、路由令牌、隧道凭据……），
 * 装好打开就能直接用。已有设置时绝不覆盖。必须在迁移旧数据之前做，否则会被旧设置抢先。
 */
function applySeed(dataHome) {
  const seed = app.isPackaged ? path.join(process.resourcesPath, "seed") : null;
  if (!seed || !fs.existsSync(path.join(seed, "settings.json")) || fs.existsSync(path.join(dataHome, "settings.json"))) return false;
  try { fs.mkdirSync(dataHome, { recursive: true }); copyTree(seed, dataHome); fs.writeFileSync(path.join(dataHome, ".migrated"), JSON.stringify({ at: new Date().toISOString(), seed: true })); return true; }
  catch { return false; }
}
const SEEDED = applySeed(DATA_HOME);
const MIGRATION = migrateLegacy(DATA_HOME, USER_DATA);
try { app.setPath("userData", USER_DATA); } catch { /* ready 之后才会失败，这里一定在之前 */ }
// src/ 里各模块的默认路径都认这个环境变量（路由令牌、隧道客户端、外部 MCP 配置、浏览器控制发现文件……）
process.env.BRIDGE_DATA_HOME = DATA_HOME;
// 安装包里附带的 cloudflared（resources/bin）：装好就能用，不用再从 GitHub 下载
if (app.isPackaged) process.env.BRIDGE_BUNDLED_BIN ||= path.join(process.resourcesPath, "bin");
process.env.BRIDGE_SHARED_DATA_HOME ||= path.join(DATA_HOME, "shared");
/*
 * 同一台电脑上和原软件一起开的测试实例（tools/start-e45-sandbox.mjs 会设 WINDRISE_INSTANCE_LABEL）：
 * 任务栏单独一组、每个窗口标题带上标签，免得和原软件的窗口混在一起点错、登进原软件的账号窗口。
 */
const INSTANCE_LABEL = process.env.WINDRISE_INSTANCE_LABEL?.trim() || "";
if (process.platform === "win32") app.setAppUserModelId(INSTANCE_LABEL ? `${APP_ID}.sandbox` : APP_ID);
if (INSTANCE_LABEL) {
  const tag = ` · ${INSTANCE_LABEL}`;
  const withTag = (title) => (String(title || APP_NAME).endsWith(tag) ? String(title) : `${title || APP_NAME}${tag}`);
  app.on("browser-window-created", (_event, win) => {
    // 代码里也有直接 setTitle 的地方，一并套上
    const setTitle = win.setTitle.bind(win);
    win.setTitle = (title) => setTitle(withTag(title));
    win.on("page-title-updated", (event, title) => { event.preventDefault(); setTitle(withTag(title)); });
    setTitle(withTag(win.getTitle()));
  });
}

const { BrowserProfileManager } = require("./browser-profiles.cjs");
const { BrowserControlServer } = require("./browser-control.cjs");
const { createAppControl } = require("./app-control.cjs");
const aiClients = require("./ai-clients.cjs");
const { SettingsStore } = require("./settings.cjs");
const autostart = require("./autostart.cjs");

const SRC = (...parts) => pathToFileURL(path.join(__dirname, "..", "src", ...parts)).href;

/**
 * 隧道客户端的自动安装（cloudflared / ngrok）。
 * CJS 不能顶层 await，所以按需动态 import 一次并缓存 —— 它是个纯 ESM 模块。
 */
let tunnelClientsPromise = null;
function tunnelClients() {
  tunnelClientsPromise ??= import(SRC("core", "tunnel-clients.js")).then((mod) => {
    // 下载走 Chromium 网络栈（自动用系统代理）；只开系统代理的电脑上 Node 自带的 fetch 连不上 GitHub
    try { mod.setFetch((url, init) => require("electron").net.fetch(url, init)); } catch { /* 老版本 Electron 没有 net.fetch */ }
    return mod;
  });
  return tunnelClientsPromise;
}

/** 用户选过的连接方式（界面卡片 / 首次选择弹窗） */
function chosenProvider(saved = settings.all()) {
  return saved.connectChoice || "";
}

/* ------------------------------------------------------------------ *
 * 激活（激活码 → 服务器核销 → 绑定本机的签名许可证，见 src/core/activation.js）
 *
 * 多道独立检查，任何一道不过都不让远程访问这台电脑：
 *   ① 打通隧道前      activation.ensure()（src/core/activation.js）
 *   ② 隧道连上后      sealAfterConnect()（本文件，自己读文件、自己验签）
 *   ③ 定时巡检        sealPatrol()（本文件，另一套写法）
 *   ④ 每个远程请求前  src/core/bridge.js 的 remoteGate（带本机 MCP 防绕过）
 *   ⑤ 隧道进程启动前  src/core/tunnel.js 的 tunnelSeal（TunnelManager seal 选项）
 * ------------------------------------------------------------------ */
function readLicenseConfig() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(__dirname, "license-config.json"), "utf8")); } catch { /* 没有就用默认 */ }
  // 只有开发调试（BRIDGE_DEV=1）时才允许用环境变量改激活服务器地址；普通用户电脑里残留的 BRIDGE_API_BASE 一律忽略，避免激活连到本机测试地址失败
  if (process.env.BRIDGE_API_BASE && process.env.BRIDGE_DEV === "1") config.apiBase = process.env.BRIDGE_API_BASE;
  return config;
}
const LICENSE_CONFIG = readLicenseConfig();
const protect = {
  encrypt: (text) => (safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(text).toString("base64") : text),
  decrypt: (text) => (String(text).startsWith("enc:") ? safeStorage.decryptString(Buffer.from(String(text).slice(4), "base64")) : text),
};
let activationPromise = null;
function activation() {
  activationPromise ??= import(SRC("core", "activation.js")).then(({ ActivationClient }) => new ActivationClient({
    apiBase: LICENSE_CONFIG.apiBase,
    dataHome: DATA_HOME,
    protect,
    // 走 Chromium 网络栈（自动用系统代理）
    fetchImpl: (url, init) => { try { return require("electron").net.fetch(url, init); } catch { return fetch(url, init); } },
  }));
  return activationPromise;
}

/** 开发开关：WINDRISE_DEV_NO_LICENSE=1 时跳过全部付费门槛。判定逻辑在 src/core/activation.js（devLicenseBypass），打包版本一律不认。 */
let devNoLicensePromise = null;
function devNoLicense() {
  devNoLicensePromise ??= import(SRC("core", "activation.js")).then(({ devLicenseBypass }) => devLicenseBypass({ env: process.env, isPackaged: app.isPackaged }));
  return devNoLicensePromise;
}

/** ① 打通隧道前 */
async function assertChannel() {
  return (await activation()).ensure();
}

/* ②③ 用到的本机设备 ID（自己算，不问 activation.js） */
let sealDevice = null;
function sealDeviceId() {
  if (sealDevice) return sealDevice;
  let guid = null;
  try {
    const cp = require("node:child_process");
    if (process.platform === "win32") {
      const out = cp.execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 5000, encoding: "latin1" });
      guid = (/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out) || [])[1] || null;
    } else if (process.platform === "darwin") {
      const out = cp.execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000, encoding: "utf8" });
      guid = (/"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/.exec(out) || [])[1] || null;
    } else {
      guid = fs.readFileSync("/etc/machine-id", "utf8").trim() || null;
    }
  } catch { guid = null; }
  if (guid) guid = guid.toLowerCase();
  else { try { guid = JSON.parse(fs.readFileSync(path.join(DATA_HOME, "activation.json"), "utf8")).fallbackId || null; } catch { guid = null; } }
  if (!guid) return null;
  sealDevice = crypto.createHash("sha256").update("bridge-replica:" + guid).digest("hex").slice(0, 32);
  return sealDevice;
}

/** ② 隧道连上后：原始 32 字节公钥（base64）现拼 SPKI（老版本原样；开源版不再核对程序文件清单） */
function sealAfterConnect() {
  const raw = Buffer.from("/QDy5PBkvfYZaI1AW+5rel4DRqET9G5x4HLhkStj+lg=", "base64");
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  let file;
  try { file = JSON.parse(fs.readFileSync(path.join(DATA_HOME, "activation.json"), "utf8")); } catch { return "还没有激活"; }
  const parts = String(file.token || "").split(".");
  if (parts.length !== 3) return "还没有激活";
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url")); } catch { ok = false; }
  if (!ok) return "激活信息无效";
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return "激活信息无效"; }
  const now = Math.max(Date.now(), Number(file.seen) || 0);
  if (c.kind !== "license" || !(c.features || []).includes("bridge")) return "激活信息无效";
  if (c.installation_id !== sealDeviceId()) return "激活信息不是这台电脑的";
  if (!(c.exp * 1000 > now) || (c.entitlement_exp && !(c.entitlement_exp * 1000 > now))) return "激活已到期";
  return null;
}

/** ③ 定时巡检：JWK 形式的公钥 + 独立验签（老版本原样；开源版不再核对程序文件清单） */
function sealPatrol() {
  const jwk = { kty: "OKP", crv: "Ed25519", x: ["_QDy5PBkvfYZ", "aI1AW-5rel4D", "RqET9G5x4HLh", "kStj-lg"].join("") };
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  try {
    const file = JSON.parse(fs.readFileSync(path.join(DATA_HOME, "activation.json"), "utf8"));
    const [h, p, s] = String(file.token || "").split(".");
    if (!s || !crypto.verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return "还没有激活";
    const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const t = Math.max(Date.now(), Number(file.seen) || 0) / 1000;
    if (c.installation_id !== sealDeviceId() || c.aud !== "bridge-replica-desktop") return "激活信息不是这台电脑的";
    if (c.exp <= t || (c.entitlement_exp && c.entitlement_exp <= t)) return "激活已到期";
  } catch { return "还没有激活"; }
  return null;
}

/** 检查不过：断开隧道，告诉界面 */
async function licenseLost(reason, where) {
  pushLog({ kind: "license", text: `激活检查没通过（${where}）：${reason}`, level: "err" });
  if (state.tunnel) { await state.tunnel.stop().catch(() => {}); state.tunnel = null; }
  // 隧道停了：④ 缓存的「放行」结论立刻作废，下一个远程请求要重新判
  resetRemoteGate();
  state.tunnelError = `${reason}，隧道已断开。请到「激活」页处理`;
  void refreshStatus();
  sendPanel("license:changed", { reason });
}

/** 界面 / 面板 / windrise_status 共用的激活摘要：只给「是否激活 + 到期」，不含激活码、设备密钥、许可证。 */
function licenseSummary(st) {
  return {
    activated: Boolean(st?.activated),
    expiresAt: st?.expiresAt ?? null,
    daysLeft: st?.daysLeft ?? null,
    reason: st?.reason || null,
    code: st?.code || null,
  };
}
async function licenseStatus() {
  const st = await (await activation()).status();
  state.license = licenseSummary(st);
  return state.license;
}

const KIND_NAMES = { D: "天卡", M: "月卡", Y: "年卡" };

/** 激活码 / 支付宝到账共用的收尾：刷新摘要、清掉旧的激活错误、按设置补一次自动连接 */
async function activationSucceeded({ kindName = "", addedDays = 0, again = false } = {}) {
  pushLog({ kind: "license", text: again ? "激活码已在本机用过，已重新取回激活信息" : `激活成功：${kindName ? `${kindName}，` : ""}+${addedDays} 天`, level: "ok" });
  void licenseStatus();
  // 刚激活：④ 之前算出的「没激活」结论作废，下一个远程请求立刻按新状态判
  resetRemoteGate();
  if (state.tunnelError && /激活/.test(state.tunnelError)) { state.tunnelError = null; void refreshStatus(); }
  try {
    const s = settings.all();
    const provider = chosenProvider(s);
    if (s.autoConnect && s.connectChoiceDone && provider && state.app && !state.tunnel && !state.connecting) {
      pushLog({ kind: "tunnel", text: `激活成功，自动连接（${provider}）` });
      startTunnel(provider, "激活成功后自动连接").catch((error) => pushLog({ kind: "tunnel", text: `自动连接失败：${error.message}`, level: "err" }));
    }
  } catch { /* 补连失败不影响激活结果 */ }
}

/** 只读价目：插件引导页从面板状态读，主界面直接走 IPC 取最新的 */
async function refreshPayPlans() {
  try {
    const data = await (await activation()).plans();
    const list = Array.isArray(data?.plans) ? data.plans : [];
    state.payPlans = list.map((plan) => ({
      kind: plan?.kind === "D" || plan?.kind === "M" || plan?.kind === "Y" ? plan.kind : "",
      name: String(plan?.name ?? "").slice(0, 40),
      days: Math.max(1, Math.floor(Number(plan?.days) || 0)),
      price: Math.max(0, Math.floor(Number(plan?.price) || 0)),
      available: plan?.available === true,
    })).filter((plan) => plan.kind);
  } catch { /* 拿不到就沿用上一次的价目；界面会显示暂未开放 */ }
}

/**
 * 引导页发起支付宝下单：主程序下单 + 轮询，二维码和状态只经插件后台推回
 * 发起这一单的引导页（requestId 由页面生成，browseros-profiles 负责寻址）。
 */
async function purchaseForOnboarding(kind, deliver) {
  const send = (payload) => Promise.resolve(deliver(payload)).catch((error) => pushLog({ kind: "license", text: `推送支付状态失败：${error.message}`, level: "warn" }));
  let order;
  try {
    order = await (await activation()).createOrder(kind);
  } catch (error) {
    await send({ ok: false, error: error.message, code: error.code });
    return;
  }
  await send({
    ok: true, orderId: order.orderId, status: "pending", qrCode: order.qrCode,
    amount: order.amount, expiresAt: order.expiresAt, kind: order.kind, name: order.name, days: order.days,
  });
  const expiry = Number(order.expiresAt);
  // 比订单本身多留 2 分钟：到点前刚付的款，让服务端有机会查单 / 回调后再定状态
  const deadline = Math.min(Number.isFinite(expiry) && expiry > 0 ? expiry + 2 * 60_000 : Date.now() + 32 * 60_000, Date.now() + 35 * 60_000);
  let stopped = false;
  let busy = false;
  let timer = null;
  const finish = (payload) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    void send(payload);
  };
  const tick = async () => {
    if (stopped) return;
    if (Date.now() > deadline) return finish({ ok: false, orderId: order.orderId, status: "expired", error: "订单已过期，请重新下单" });
    if (busy) { timer = setTimeout(tick, 3000); timer.unref?.(); return; }
    busy = true;
    try {
      const result = await (await activation()).pollOrder(order.orderId);
      if (result.activated) {
        const status = result.activationStatus ?? {};
        finish({
          ok: true, orderId: order.orderId, status: "paid", kind: result.kind,
          addedDays: result.addedDays ?? 0, expiresAt: status.expiresAt ?? null, daysLeft: status.daysLeft ?? null,
        });
        await activationSucceeded({ kindName: KIND_NAMES[result.kind] ?? "", addedDays: result.addedDays ?? 0 });
        return;
      }
      if (result.status === "expired" || result.status === "failed") {
        finish({
          ok: false, orderId: order.orderId, status: result.status,
          error: result.status === "expired" ? "订单已过期，请重新下单" : "支付失败，请重试",
        });
        return;
      }
    } catch { /* 网络抖动：继续轮询，最多等到订单过期 */ }
    busy = false;
    timer = setTimeout(tick, 3000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 3000);
  timer.unref?.();
}

/** 定时巡检 + 在线续期：间隔带随机抖动，不好预测 */
function startLicensePatrol() {
  const tick = async () => {
    try {
      if (await devNoLicense()) return;
      const client = await activation();
      await client.renew().catch(() => {});
      const st = await client.status();
      state.license = licenseSummary(st);
      const why = sealPatrol() || (st.activated ? null : st.reason);
      if (why && state.tunnel) await licenseLost(why, "定时检查");
      sendPanel("license:status", st);
    } catch (error) { pushLog({ kind: "license", text: `激活巡检异常：${error.message}`, level: "warn" }); }
    setTimeout(tick, (6 + Math.random() * 6) * 60_000).unref?.();
  };
  setTimeout(tick, 20_000 + Math.random() * 20_000).unref?.();
}


/** 设置：启动时读一次，之后读写都走这个实例（内存缓存 + 落盘） */
const settings = new SettingsStore(DATA_HOME);

/** eval 是「把页面完全交出去」的操作，默认关闭；启动时加 --allow-eval 才开。 */
const ALLOW_EVAL = process.argv.includes("--allow-eval");

/** 任务栏分组调度：whenReady 里创建；退出时 stop */
let taskbarGrouping = null;

/** 运行时状态 */
const state = {
  app: null,
  tunnel: null,
  profiles: null,
  browserControl: null,
  connectors: null,
  contextBusInstance: null,
  contextBusLoading: null,
  // 打包版开机自启时 cwd 是安装目录甚至 System32，不能拿来当工作区
  roots: [app.isPackaged ? path.join(os.homedir(), "Documents") : process.cwd()],
  options: { approve: false, readonlyAuto: true, jsonResponse: false, agentCursor: settings.all().showAgentCursor !== false },
  logs: [],
  /**
   * 每个会话的页面动作小账本：窗口内累计 calls / ms / 字数 / token / 图片张数，30 秒到点输出再清零。
   * 只留 512 个会话，不占主日志的 500 条。
   */
  toolMetaLog: { buckets: new Map() },
  /** 公网实测状态（只放不带令牌的字段，snapshot 原样给界面） */
  publicCheck: newPublicCheck(),
  /** 公网实测的内部状态：正在跑 / 定时器 / 这次打通的时间 / 是否已经报过警 / 是否正在自动重连 */
  publicCheckBusy: false,
  publicCheckTimer: null,
  publicCheckSince: 0,
  publicCheckUrl: null,
  publicCheckAlerted: false,
  /** 本机网络问题（断网 / DNS 坏 / 代理连不上）的连续次数与「已经 warn 过」：不参与 failures / 重连 */
  publicCheckLocalFailures: 0,
  publicCheckLocalAlerted: false,
  publicCheckReconnecting: false,
  /** 重连完成、正在等下一次公网实测：这段显示「连接中」，不显示「公网不通」 */
  publicCheckVerifying: false,
  publicCheckGeneration: 0,
  /** 上一次打通的隧道实例与公网地址：同一个实例同一地址再打通 = 重连恢复，不重复通知 */
  lastConnectedTunnel: null,
  lastConnectedUrl: null,
  panel: null,
  tray: null,
  connecting: false,
  tunnelError: null,
  /** 激活摘要（licenseStatus() 更新）：只给「是否激活 + 到期」，不含激活码 / 设备密钥 / 许可证 */
  license: null,
  /** 只读价目（插件引导页用）：只有 kind / name / days / price / available，不含任何密钥 */
  payPlans: [],
  quitting: false,
  /** 账号管理器（BrowserProfileManager）是否已经就绪：second-instance 在它之前到就先记账 */
  profilesReady: false,
  /** second-instance 在账号管理器就绪前到：先记下，就绪后补开格子 1 */
  wantGrid1: false,
  /** 开机自启开关的当前状态（托盘勾选显示用） */
  autostartEnabled: false,
  /**
   * 开机流程走完了没有（autoStart：起 Bridge + 按设置起隧道）。
   * 没走完时 ④ 的远程请求一律回 503 + Retry-After：这段隧道可能还没登记，
   * 按「没开隧道」判 403 会误伤经隧道进来的客户端（见 tunnelGateReady）。
   */
  startupComplete: false,
};

/*
 * 日志落盘：和界面里的内存日志并行，互不影响。
 * 秘密值每次写盘前现取（换令牌、新建连接器后立刻生效），脱敏只作用于磁盘这一路。
 */
const appLog = createAppLog({
  dataHome: DATA_HOME,
  getSecrets: () => collectSecrets({
    dataHome: DATA_HOME,
    currentToken: state.app?.token ?? state.app?.server?.routeToken ?? null,
    settings,
    connectors: state.connectors,
  }),
});

function pushLog(entry) {
  const record = { at: Date.now(), ...entry };
  state.logs.push(record);
  if (state.logs.length > 500) state.logs.shift();
  // 先落盘再发界面：发界面偶尔会因为窗口正在销毁抛错，落盘这一路不能因此漏掉这条
  try { appLog.write(record); } catch { /* 写盘失败绝不影响界面和内存日志 */ }
  if (state.panel && !state.panel.isDestroyed()) state.panel.webContents.send("bridge:log", record);
}

/**
 * 页面动作（page_* / browser_*）的日志：每个会话最多 30 秒一行，汇总成累计口径。
 *
 * 以前每条都 pushLog，一轮长浏览器自动化几百次就能把内存里 500 条日志环占满，
 * 隧道断开 / 待批准命令这些真正要看的行反而被挤出去。明细仍然在调用日志
 * （mcp-calls-*.jsonl，带 meta）里，这里只是界面 / windrise_logs 的摘要。
 */
function noteToolMeta(event) {
  const sid = String(event.sessionId ?? "anonymous");
  const now = Number(event.at) || Date.now();
  const bucket = state.toolMetaLog.buckets.get(sid) ?? { lastAt: 0, totals: null };
  // 先累计这一次，再看要不要输出：30 秒内调用几百次也只出一行，但数字是全窗口的累计
  bucket.totals = addMetaCall(bucket.totals, event.meta);
  const plan = metaLogPlan(bucket.totals, event.sessionTag ?? "", now, bucket.lastAt);
  if (!plan) {
    state.toolMetaLog.buckets.set(sid, bucket);
    return;
  }
  // 输出后清零：下一条从这一个调用重新开始累计
  state.toolMetaLog.buckets.set(sid, { lastAt: now, totals: null });
  // 会话会不断新建，Map 不能无限涨：只留最近 512 个会话的记录
  if (state.toolMetaLog.buckets.size > 512) state.toolMetaLog.buckets.delete(state.toolMetaLog.buckets.keys().next().value);
  pushLog({ kind: "tool-meta", text: plan.text });
}

/**
 * 连接状态（界面 / 托盘 / 任务栏共用一套判断）：
 *   stopped 未启动 → local 仅本机可用 → connecting 正在打通 → connected 已打通（外部 AI 可连）
 * 隧道进程起来了不等于打通：要等 cloudflared 注册上边缘节点 / ngrok 拿到地址。
 */
function connectionStatus() {
  const running = Boolean(state.app);
  const tunnel = state.tunnel ? state.tunnel.status() : null;
  let publicMcpUrl = null;
  if (running && tunnel?.connected && tunnel.publicUrl) {
    try { publicMcpUrl = tunnel.publicUrl.replace(/\/+$/, "") + new URL(state.app.server.localUrl).pathname; } catch { /* 忽略 */ }
  }
  if (!running) return { level: state.connecting ? "connecting" : "stopped", label: state.connecting ? "启动中" : "未启动", publicMcpUrl };
  /*
   * 隧道自己在重连（tunnel.js 的 reconnect / noteWake / 网卡变化 / 掉线 60 秒）或公网实测在
   * 自动重连时，状态保持「连接中」，不要闪成「仅本机」；onConnected 也不会在这期间被触发。
   * reconnecting 是 tunnel.status() 的新字段，老版本没有时按 false。
   */
  if (tunnel?.reconnecting || state.publicCheckReconnecting) {
    return { level: "connecting", label: "连接中", detail: "正在重新连接…", publicMcpUrl };
  }
  if (publicMcpUrl) {
    /*
     * 隧道进程说连着，也要公网真能访问到桥才算「已连接」。
     * 连续失败达到阈值后先显示「公网不通」，publicMcpUrl 照常带上（客户端重连时还要用）；
     * 重连完成、还在等实测时显示「连接中」；第一次公网实测成功会把 failures 清零，状态自动回到 connected。
     */
    const override = publicStatusOverride({
      failures: state.publicCheck.failures,
      verifying: state.publicCheckVerifying,
    });
    if (override) return { ...override, publicMcpUrl };
    return { level: "connected", label: "已连接", publicMcpUrl, provider: tunnel.client?.mode === "named" ? "cloudflare-named" : tunnel.provider };
  }
  if (tunnel?.phase === "blocked") return { level: "error", label: "连接失败", error: tunnel.blocked?.verdict?.text || tunnel.lastError, publicMcpUrl, blocked: tunnel.blocked };
  if (state.connecting || tunnel?.state === "running" || tunnel?.restarting) {
    const detail = tunnel?.phase === "optimizing" ? "正在优化连接…" : tunnel?.restarting ? "正在重新连接…" : undefined;
    return { level: "connecting", label: "连接中", detail, publicMcpUrl };
  }
  if (state.tunnelError || tunnel?.lastError) return { level: "error", label: "连接失败", error: state.tunnelError || tunnel.lastError, publicMcpUrl };
  return { level: "local", label: "仅本机", publicMcpUrl };
}

/**
 * ④ 远程请求放行（src/core/bridge.js 的 remoteGate）用的两个钩子。
 *
 * 为什么需要 ready：Bridge 和隧道是两个先后启动的东西，而公网请求只有隧道通了才可能进来。
 * 启动初期 state.tunnel 还是 null / 刚 new 出来还没注册，tunnelUp 只能是 false，
 * 于是「我们的隧道还没登记」被误判成「没开隧道的远程请求」→ 403，并且这个 403 被缓存 90 秒，
 * 隧道真正打通后客户端还在继续吃 403，直到缓存过期（= 现象里的「头一分钟」）。
 *
 * 就绪 = 隧道状态已经定下来（没在启动 / 换线路 / 重连，也不是「进程在跑但还没注册」）。
 * 未就绪时桥回 503 + Retry-After，客户端 5 秒后重试，不判 403。
 */
function tunnelGateReady() {
  // 开机流程（起 Bridge + 按设置起隧道）还没走完：状态还没定下来，别急着判 403
  if (!state.startupComplete) return false;
  const tunnel = state.tunnel;
  // 还没有隧道实例：从没连过，或刚被停掉。这是确定状态，不是启动中。
  if (!tunnel) return true;
  let info = null;
  try { info = tunnel.status(); } catch { return true; }
  if (!info) return true;
  if (info.reconnecting) return false;
  /*
   * phase=connecting：进程刚拉起、还没注册上边缘（cloudflared 要几秒到几十秒）。
   * phase=optimizing：已经在换线路 / 重试，同样还没登记。
   * 这两段里隧道状态没定下来，远程请求回 503 让客户端重试，不能判 403。
   * blocked / stopped / connected 都是确定状态，照常判。
   */
  if (info.phase === "connecting" || info.phase === "optimizing") return false;
  if (state.connecting) return false;
  return true;
}

/** 隧道 / 激活状态变了：丢掉桥里缓存的 ④ 结论，下一个远程请求重新判 */
function resetRemoteGate() {
  try { state.app?.server?.resetRemoteGate?.(); } catch { /* 桥还没起 */ }
}

async function snapshot() {
  const running = Boolean(state.app);
  const health = running ? await state.app.server.health() : null;
  const saved = settings.all();
  return {
    running,
    status: connectionStatus(),
    appName: APP_NAME,
    migration: MIGRATION,
    mcpUrl: running ? state.app.server.localUrl : null,
    healthUrl: running ? state.app.server.healthUrl() : null,
    health,
    tunnel: state.tunnel ? state.tunnel.status() : { state: "stopped", provider: "cloudflare", publicUrl: null },
    roots: state.roots,
    workspaceConfirmed: Boolean(settings.all().workspaceConfirmed),
    homeDir: os.homedir(),
    dataHome: DATA_HOME,
    tokenFile: running ? state.app.tokenFile : path.join(DATA_HOME, "route-token.json"),
    hubRoot: running ? state.app.hub.root : null,
    options: state.options,
    /** 口令入口摘要：首页连接卡片显示口令数量 / 路径开关，不含口令明文 */
    ownerAuth: ownerAuthSummary(),
    /** 激活摘要：只给「是否激活 + 到期」，不含激活码 / 设备密钥 / 许可证（licenseStatus() 更新） */
    license: state.license,
    /** 端口：桥实际在用的（跑起来之后以实际为准，没跑就是设置里的值） */
    port: running ? (state.app.server.address()?.port ?? saved.port) : saved.port,
    settings: saved,
    settingsFile: settings.file,
    /** 公网实测：只给时间和原因，不带令牌、不带完整地址 */
    publicCheck: publicCheckSnapshot(),
    logs: state.logs.slice(-120),
  };
}

/* ------------------------------------------------------------------ *
 * 公网实测：隧道「显示连着」不等于公网真的能连进来。
 *
 * 背景见 docs/research/bridge-disconnect-2026-10-24.md：网卡闪断后 cloudflared 的
 * 边缘连接会「半死」，本机进程和日志都看不出异常。这里每 30 秒从公网地址打一次
 * /healthz/<令牌>，并核对返回的 uptimeMs 与本机一致（防止打到别的实例）。
 *
 * 只测「我们自己的隧道」（connectionStatus 里 publicMcpUrl 有值的路径）。
 * ------------------------------------------------------------------ */
function publicCheckSnapshot() {
  const check = state.publicCheck ?? {};
  return {
    ok: check.ok ?? null,
    at: check.at ?? 0,
    lastOkAt: check.lastOkAt ?? 0,
    failures: check.failures ?? 0,
    lastError: check.lastError ?? null,
    latencyMs: check.latencyMs ?? null,
  };
}

/** 首页连接卡片用的口令摘要：只给数量和路径开关，不带任何口令材料 */
function ownerAuthSummary() {
  const owner = state.app?.ownerAuth;
  if (!owner) return null;
  try {
    const info = owner.status();
    const count = Array.isArray(info.keys) ? info.keys.length : (info.bearerEnabled ? 1 : 0);
    return { count, pathEnabled: info.pathEnabled !== false };
  } catch { return null; }
}

/**
 * 侧边栏 / 新标签页的推荐位：先写死在主程序里。
 * 以后要改成读配置，只需要把 panelRecommendation() 换成读 settings（字段名可以叫 panelRecommendation），
 * 调用方（getPanelState）不用动。
 */
const PANEL_RECOMMENDATION = Object.freeze({
  title: "Muse 300 次 · 推荐",
  description: "官方渠道，¥88 起。AI 额度不够时可以直接补。",
  url: "https://www.16688.com.cn/goods/G75394034",
});

function panelRecommendation() {
  // TODO: 以后从 settings 里读（留的口子）；现在固定一条，不把用户没选的广告换进来。
  return PANEL_RECOMMENDATION;
}

/**
 * 引导页第 4 步要的工具清单：从工具注册表（src/core/registry.js）现取，只透
 * name / title / description / capability / source，其余（handler / inputSchema / args）在 panel-state 里裁。
 * getPanelState 是同步的，所以这里缓存一份；但 Bridge 启动、外接 MCP 接入都会在运行中往注册表里加工具，
 * 缓存不能只取一次（第一次面板推送可能早于 Bridge 起来）：每 15 秒后台刷新一次，下一次推送就带上新清单。
 */
const TOOLS_LIST_REFRESH_MS = 15_000;
let toolsListCache = { tools: [], at: 0 };
let toolsListLoading = null;
function panelTools() {
  const now = Date.now();
  // 清单空的时候（Bridge 还没起来）2 秒后就重试，别让引导页第 4 步一直空着
  const refreshMs = toolsListCache.tools.length ? TOOLS_LIST_REFRESH_MS : 2_000;
  if (!toolsListLoading && now - toolsListCache.at >= refreshMs) {
    toolsListLoading = import(SRC("core", "registry.js")).then(({ listTools }) => {
      toolsListCache = {
        tools: listTools().map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          capability: tool.capability,
          source: tool.source,
        })),
        at: Date.now(),
      };
    }).catch(() => {
      // 拿不到就保留上一次的清单；过 15 秒再试
      toolsListCache = { tools: toolsListCache.tools, at: Date.now() };
    }).finally(() => {
      toolsListLoading = null;
    });
  }
  return toolsListCache.tools;
}

/** MemOS 只读状态：configured / status，Key 不进返回值。 */
function memosStatusNow() {
  let health = [];
  try { health = state.app?.externalMcp?.snapshot?.() ?? []; } catch { health = []; }
  try { return memosBridge.memosStatus({ dataHome: DATA_HOME, health }); }
  catch { return { configured: false, status: "error" }; }
}

/**
 * 插件侧边栏 / 新标签页要的只读状态。
 * 这里只挑白名单字段交给 buildPanelState；口令明文和带令牌地址在那一层会被裁掉。
 */
function getPanelState(self = {}) {
  const status = connectionStatus();
  const saved = settings.all();
  const memos = memosStatusNow();
  const owner = ownerAuthSummary();
  let grids = [];
  try { grids = state.profiles?.panelGrids?.() ?? []; } catch { grids = []; }
  let spaces = [];
  try { spaces = state.profiles?.panelSpaces?.(self?.id) ?? []; } catch { spaces = []; }
  let broker = brokerStatus();
  if (!broker.running) {
    // 老安装可能把握手文件放在数据目录里：两条路都看，任一条有活进程就算在运行
    const legacy = brokerStatus({ handleFile: path.join(DATA_HOME, "broker-handle.json") });
    if (legacy.running) broker = legacy;
  }
  let tunnelStatus = null;
  try { tunnelStatus = state.tunnel?.status?.() ?? null; } catch { tunnelStatus = null; }
  // 插件区（装到所有格子）：共享库清单 + 自动同步开关 + 这个格子有没有要重开才生效的改动
  let extensions = null;
  try { extensions = state.profiles?.backend?.panelExtensions?.(self?.id) ?? null; } catch { extensions = null; }
  return buildPanelState({
    self: {
      slot: self?.slot ?? null,
      name: self?.name ?? "",
      hidden: self?.hidden === true,
    },
    grids,
    spaces,
    connection: {
      connected: status.level === "connected",
      level: status.level,
      label: status.label,
      publicMcpUrl: status.publicMcpUrl,
      tokenCount: owner?.count ?? 0,
      pathEnabled: owner?.pathEnabled !== false,
      provider: status.provider || null,
    },
    // 授权状态：只给「已激活 / 未激活 + 到期日期」，激活码 / 设备密钥 / 许可证一律不出主进程
    license: state.license,
    // 引导页购买区：只读价目（kind / name / days / price / available）
    payPlans: state.payPlans,
    tunnelProvider: status.provider
      || saved.tunnel?.lastProvider
      || saved.connectChoice
      || tunnelStatus?.provider
      || null,
    toolTier: saved.toolTier,
    brokerRunning: broker.running,
    // 共享上下文默认开；Bridge 跑起来之后按它真实的初始化结果报；dir 是本地共享文件夹
    sharedContext: state.app ? state.app.contextReady === true : true,
    sharedContextDir: process.env.BRIDGE_SHARED_DATA_HOME || path.join(DATA_HOME, "shared"),
    // MemOS：只报「配没配 + 连接状态」，API Key 不出主进程
    memosConfigured: memos.configured,
    memosStatus: memos.status,
    extensions,
    recentActions: readRecentActions(path.join(DATA_HOME, "logs"), 10),
    recommendation: panelRecommendation(),
    // 引导页：工具清单（注册表）+ 按客户端填法（ai-clients.cjs 复用一份数据）
    tools: panelTools(),
    aiClients: aiClients.clientGuides(),
  });
}

/** 外部客户端该用的连接地址：路径入口开着就给带令牌地址，否则给不带令牌的 /mcp */
function publicConnectionUrl(status = connectionStatus()) {
  if (!status.publicMcpUrl) return null;
  const pathEnabled = state.app?.ownerAuth ? state.app.ownerAuth.pathEnabled() : true;
  return pathEnabled ? status.publicMcpUrl : status.publicMcpUrl.replace(/\/mcp\/[^/?#]+\/?$/, "/mcp");
}

/**
 * 隧道停掉 / Bridge 停掉时清掉定时器；在跑的探测结果按 generation 作废。
 * 失败次数和「报过警」也一起清掉：接下来是一条新隧道，不能带着上一条的失败，
 * 否则手动重连后一打通就先显示「公网不通」，要等第一次实测成功才变回已连接。
 */
function stopPublicCheck() {
  if (state.publicCheckTimer) {
    clearInterval(state.publicCheckTimer);
    state.publicCheckTimer = null;
  }
  state.publicCheck = newPublicCheck();
  state.publicCheckAlerted = false;
  state.publicCheckLocalFailures = 0;
  state.publicCheckLocalAlerted = false;
  state.publicCheckBusy = false;
  state.publicCheckSince = 0;
  state.publicCheckUrl = null;
  state.publicCheckVerifying = false;
  state.publicCheckGeneration += 1;
}

/** 我们的隧道刚打通：从现在算 30 秒宽限，并且立刻先测一次 */
function startPublicCheck() {
  if (state.quitting || state.publicCheckTimer) return;
  state.publicCheckSince = Date.now();
  state.publicCheckTimer = setInterval(() => { void checkPublicNow(); }, 30_000);
  state.publicCheckTimer.unref?.();
  void checkPublicNow();
}

/**
 * 对照请求：同一个公网域名的 /cdn-cgi/trace，由 Cloudflare 边缘直接回，不进隧道。
 * 只用来区分「本机上不了 Cloudflare」和「隧道没把请求送到桥」，超时 5 秒，不带令牌。
 */
async function checkCloudflareReachable(publicMcpUrl) {
  const target = controlTarget(publicMcpUrl);
  if (!target) return { ok: false, error: new Error("没有可用的公网域名") };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  try {
    const response = await net.fetch(target.href, { signal: controller.signal });
    return { ok: Boolean(response), status: response?.status ?? null };
  } catch (error) {
    return { ok: false, timedOut, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 立刻做一次公网实测（正在跑就不叠加）。unlock-screen 和手动排查会直接调它。
 * 请求只带公网健康检查地址；超时 8 秒。
 */
async function checkPublicNow() {
  const status = connectionStatus();
  // 重连中不探测：否则「正在重连」会被当成又失败一次，触发新的重连（probeDue 是纯函数，自测覆盖）
  if (!state.app || !probeDue({
    publicMcpUrl: status.publicMcpUrl,
    busy: state.publicCheckBusy,
    reconnecting: state.publicCheckReconnecting,
    tunnelReconnecting: Boolean(state.tunnel?.status?.()?.reconnecting),
  })) return null;
  const target = healthTarget(status.publicMcpUrl);
  if (!target) return null;

  // 公网地址变了（重连后快速隧道换了域名）：宽限期重新算，但失败次数保留到真正成功一次
  if (state.publicCheckUrl !== status.publicMcpUrl) {
    state.publicCheckUrl = status.publicMcpUrl;
    state.publicCheckSince = Date.now();
  }

  state.publicCheckBusy = true;
  const generation = state.publicCheckGeneration;
  try {
    const startedAt = Date.now();
    let result;
    // 超时自己控制：net.fetch 被 abort 后的错误形状不稳定（AbortError / net::ERR_ABORTED / TypeError），靠 timedOut 标记分类
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    try {
      // 走 Chromium 网络栈（认系统代理）：隧道走代理中继的机器上，Node 自带的 fetch 连不出去
      const response = await net.fetch(target.href, { signal: controller.signal });
      const latencyMs = Date.now() - startedAt;
      // 非 200 不解析 body；JSON 坏了按「不是正常健康检查」处理；超时打断 body 时按超时算
      let body = null;
      if (response.ok) {
        try { body = await response.json(); } catch (error) { if (timedOut) throw error; }
      }
      result = judgeProbe({
        status: response.status,
        body,
        localUptimeMs: state.app?.server?.healthSummary()?.uptimeMs,
        latencyMs,
        // 桥在启动期回 503 + Retry-After：记下建议重试秒数，界面和日志能说清楚是在等桥起来
        retryAfter: response.status === 503 ? response.headers?.get?.("retry-after") ?? null : null,
      });
    } catch (error) {
      // 没拿到 HTTP 响应（超时或 net.fetch 抛错）：先用同一个 net.fetch 打一次对照地址再判。
      // 断网 / DNS 这类白名单错误不用打对照；对照也失败 = 本机现在上不了 Cloudflare，不算隧道故障；
      // 对照成功才算隧道没把请求送到桥。
      if (generation !== state.publicCheckGeneration || state.publicCheckUrl !== status.publicMcpUrl) return null;
      const quick = classifyProbeError(error, { timedOut });
      const control = quick.kind === "local-network" ? null : await checkCloudflareReachable(status.publicMcpUrl);
      result = { ...judgeWithControl({ probeError: error, timedOut, control }), latencyMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }

    // 探测期间隧道被停掉 / 换地址：这次结果作废，不能写到新状态上
    if (generation !== state.publicCheckGeneration) return null;
    if (state.publicCheckUrl !== status.publicMcpUrl) return null;

    const outcome = applyProbe(state.publicCheck, result, {
      at: Date.now(),
      connectedAt: state.publicCheckSince,
      alerted: state.publicCheckAlerted,
      localFailures: state.publicCheckLocalFailures,
      localAlerted: state.publicCheckLocalAlerted,
    });
    state.publicCheck = outcome.state;
    // 重连后的验证：成功、或计了数的失败才算做过；宽限期里的失败和本机网络问题不涨失败次数，不能就此显示「公网不通」
    if (settlesVerification(outcome, result)) state.publicCheckVerifying = false;
    state.publicCheckAlerted = outcome.alerted;
    state.publicCheckLocalFailures = outcome.localFailures;
    state.publicCheckLocalAlerted = outcome.localAlerted;

    if (outcome.recovered) {
      pushLog({ kind: "tunnel", text: "公网实测恢复，公网能访问到桥了", level: "ok" });
    } else if (outcome.localAlarm) {
      // 只记一次：连续 10 次（30 秒一次，约 5 分钟）本机都上不了公网；不重连隧道，网络恢复后自己清零
      pushLog({
        kind: "tunnel",
        text: `公网实测：${outcome.state.lastError}；已连续 ${outcome.localFailures} 次（约 5 分钟），不重连隧道`,
        level: "warn",
      });
    } else if (outcome.alarm) {
      // 日志只写域名：完整地址里有路由令牌
      const host = publicHost(status.publicMcpUrl);
      pushLog({
        kind: "tunnel",
        text: alarmMessage({ failures: outcome.state.failures, error: outcome.state.lastError, host }),
        level: "warn",
      });
      void reconnectPublicTunnel();
    }
    void refreshStatus();
    return outcome;
  } finally {
    if (generation === state.publicCheckGeneration) state.publicCheckBusy = false;
  }
}

/** 公网连续失败后的自动重连：优先用 tunnel.js 的 reconnect，老版本退回 stop + start */
async function reconnectPublicTunnel() {
  if (state.publicCheckReconnecting) return;
  state.publicCheckReconnecting = true;
  const source = "公网实测自动重连";
  try {
    if (typeof state.tunnel?.reconnect === "function") {
      await state.tunnel.reconnect(`公网连续 ${state.publicCheck.failures} 次访问不到`);
      // 重连成功了，但失败次数要等下一次实测才清零：这段显示「连接中」，别再说「正在自动重连」
      state.publicCheckVerifying = true;
      // 同一条隧道重连（失败次数没清零）：cloudflared 几秒就能重新注册，10 秒后补测一次，别等满 30 秒才变回已连接
      const recheck = setTimeout(() => { void checkPublicNow(); }, 10_000);
      recheck.unref?.();
    } else {
      const provider = state.pendingProvider || settings.all().tunnel.lastProvider || chosenProvider() || "cloudflare";
      await stopTunnel(source);
      await startTunnel(provider, source);
      state.publicCheckVerifying = true;
    }
  } catch (error) {
    pushLog({ kind: "tunnel", text: `公网实测自动重连失败：${error.message}`, level: "err" });
  } finally {
    state.publicCheckReconnecting = false;
  }
}

/* ------------------------------------------------------------------ *
 * Bridge 生命周期
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 健康探针：隧道 / 外部 MCP / 浏览器控制。
 * BridgeServer.health() 把它们合进 readiness 和 components；单项超过 3 秒
 * 在那边算失败，不会拖住 /healthz。
 * ------------------------------------------------------------------ */

/** tunnel.js 目前没给 cloudflared 开 metrics 端口；只有将来它提供 metricsUrl 时才读 /ready */
async function readTunnelMetrics(base) {
  try {
    const response = await fetch(new URL("/ready", base), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const data = await response.json();
    const count = data.readyConnections ?? data.ready_connections;
    return Number.isFinite(Number(count)) ? { readyConnections: Number(count) } : null;
  } catch {
    return null;
  }
}

const HEALTH_PROBES = [
  {
    name: "tunnel",
    async run() {
      // 没启用隧道 = 只在本机用，是正常状态，不是故障
      if (!state.tunnel) return { ok: true, detail: "没开隧道（仅本机可用）" };
      const info = state.tunnel.status();
      const kind = info.client?.name
        ? `${info.client.name}${info.client.mode ? `/${info.client.mode}` : ""}`
        : info.provider;
      const route = info.routeLabel ? `，通道：${info.routeLabel}` : "";
      // 只有 tunnel.js 真的给了 metrics 地址才读；没开 metrics 端口就不碰
      const metrics = state.tunnel.metricsUrl ? await readTunnelMetrics(state.tunnel.metricsUrl) : null;
      const ready = metrics?.readyConnections != null ? `，readyConnections=${metrics.readyConnections}` : "";
      if (info.connected && info.publicUrl) {
        return { ok: true, detail: `已连上（${kind}${route}${ready}），公网地址：${info.publicUrl}` };
      }
      const reason = info.lastError ? `：${info.lastError}` : "";
      return { ok: false, detail: `未连上（${kind}${route}，状态 ${info.phase}${reason}${ready}）` };
    },
  },
  {
    name: "external-mcp",
    run() {
      const rows = state.app?.externalMcp?.snapshot?.() ?? [];
      if (!rows.length) return { ok: true, detail: "没有配置外部 MCP 服务" };
      const nameOf = (row) => row.label || row.id || "未命名";
      const failed = rows.filter(row => row.state === "error");
      const ready = rows.filter(row => row.state === "ready");
      const mounted = ready.reduce((sum, row) => sum + (row.toolCount ?? 0), 0);
      if (!failed.length) {
        return { ok: true, detail: `已挂载 ${ready.length}/${rows.length} 个服务、共 ${mounted} 个工具（${rows.map(nameOf).join("、")}）` };
      }
      return {
        ok: false,
        detail: `失败 ${failed.length} 个：${failed.map(row => `${nameOf(row)}${row.error ? `（${row.error}）` : ""}`).join("、")}；其余 ${rows.length - failed.length} 个正常`,
      };
    },
  },
  {
    name: "browser-control",
    run() {
      const info = state.browserControl?.info?.();
      if (!info) return { ok: false, detail: "浏览器控制服务还没创建" };
      if (!info.running) return { ok: false, detail: "浏览器控制服务没有在跑" };
      return { ok: true, detail: `已启动（端口 ${info.port}，已处理 ${info.calls} 次调用）` };
    },
  },
];

/**
 * 同一时刻只启动一个 Bridge：并发调用共用同一个启动过程。
 * 2026-10-25 修：以前没有这道闸，启动中再被调一次就会建出第二套共享上下文总线和外部 MCP 连接。
 */
async function startBridge() {
  if (state.app) return await snapshot();
  if (!state.bridgeBooting) state.bridgeBooting = startBridgeInner().finally(() => { state.bridgeBooting = null; });
  return state.bridgeBooting;
}

async function startBridgeInner() {
  if (state.app) return await snapshot();
  const { boot } = await import(SRC("standalone.js"));
  const saved = settings.all();
  // 开发开关：WINDRISE_DEV_NO_LICENSE=1（且不是打包版）时桥不挂本机 MCP 防绕过这道门
  const devNoLicenseActive = await devNoLicense();
  /*
   * 端口从设置里读。为什么要有这个：
   *   接命名隧道时 cloudflared 的 ingress 规则里写的是死端口，
   *   桥每次随机换端口的话隧道永远指不到。所以给个可配的固定端口，
   *   0 表示随机（默认最安全，撞端口时系统会换一个）。
   */
  state.app = await boot({
    roots: state.roots,
    dataHome: DATA_HOME,
    // 和设置页用的是同一个实例：在这里建连接器，Bridge 里立刻就能用它的令牌
    connectors: state.connectors,
    // 连接器申请用某个窗口前，先确认这台电脑上真有这个窗口（窗口 id 是远端 AI 填的）
    profileExists: (id) => Boolean(state.profiles?.profiles?.some((item) => item.id === id)),
    port: saved.port,
    // 工具档位：设置页「对外暴露的工具」，默认基础档
    toolTier: saved.toolTier === "full" ? "full" : "basic",
    /*
     * 隧道 OAuth（默认关闭，settings.json 的 oauthEnabled）：
     * 打开后才挂 PRM / DCR / authorize / token 等端点；老的路径令牌和请求头口令完全不变。
     * audience 用当前隧道的公网地址（不带 /mcp）；隧道没通时为 null，由请求 Host 推断。
     */
    oauth: saved.oauthEnabled === true ? {
      enabled: true,
      publicBaseUrl: () => {
        // publicMcpUrl 是 https://<隧道域名>/mcp/<路径令牌>，OAuth 的 base 只要 origin
        const url = connectionStatus()?.publicMcpUrl;
        if (!url) return null;
        try { return new URL(url).origin; } catch { return null; }
      },
    } : null,
    /*
     * 本机 MCP 防绕过 + 远程请求放行（④）：
     *   「不像本机直连」的请求（cf-* / x-forwarded-* / forwarded 头，或 Host 不是本机名）进来时，
     *   桥先问 ready（隧道状态定下来了吗：没在启动 / 换线路 / 重连），没定下来回 503 + Retry-After；
     *   定下来才独立验 activation.json、再问「我们的隧道通着吗」——只有已激活且我们隧道真通着才放行。
     *   开发开关 WINDRISE_DEV_NO_LICENSE=1（且不是打包版）时不挂这道门。
     */
    ...(devNoLicenseActive ? {} : {
      remoteGate: {
        ready: tunnelGateReady,
        tunnelUp: () => Boolean(state.tunnel?.status?.()?.connected),
      },
    }),
    // 健康检查三态用：隧道 / 外部 MCP / 浏览器控制（探针只读现有状态，不额外连东西）
    healthProbes: HEALTH_PROBES,
    /*
     * 把「安全策略」里的两个开关传下去。
     * 之前没传，导致界面上那个「危险命令需要人工确认」是死的 ——
     * 勾没勾都一样，非白名单命令全被拦且无处批准。
     */
    options: {
      approveDangerous: saved.approveDangerous,
      autoAllowReadonly: saved.autoAllowReadonly,
      // 设置页的响应方式开关；没勾（默认）就是 SSE 边跑边回
      jsonResponse: saved.jsonResponse === true,
    },
    onLog: (event) => {
      if (event.kind === "approval-request") {
        pushLog({ kind: "approval", text: `待批准命令：${event.command}`, level: "warn" });
        if (state.panel && !state.panel.isDestroyed()) state.panel.webContents.send("bridge:approval", event);
        return;
      }
      // 页面动作的耗时 / 输出估算：按会话每 30 秒汇总一行，不占主日志的 500 条
      if (event.kind === "tool-meta") {
        noteToolMeta(event);
        return;
      }
      // MCP 会话断了：让浏览器控制服务给它的 AI 空间记上断开时间，满 2 分钟检查是否收摊
      if (event.kind === "session-close" && event.sessionId) {
        state.browserControl?.noteSessionClosed(event.sessionId);
      }
      if (event.kind !== "request") pushLog({ kind: event.kind, text: logText(event) });
    },
  });
  const health = await state.app.server.health();
  const actualPort = state.app.server.address()?.port;
  pushLog({
    kind: "bridge",
    text: `Bridge 已启动，端口 ${actualPort}，工具 ${health.tools} 个${saved.port && actualPort !== saved.port ? `（设置的是 ${saved.port}，被占用所以换了）` : ""}${saved.jsonResponse === true ? "，响应方式：JSON 一次性" : "，响应方式：边跑边回（15 秒心跳）"}`,
    level: "ok",
  });
  return await snapshot();
}

async function stopBridge(source) {
  if (!state.app) { stopPublicCheck(); return await snapshot(); }
  await state.app.stop();
  state.app = null;
  if (state.tunnel) { await state.tunnel.stop().catch(() => {}); state.tunnel = null; }
  stopPublicCheck();
  state.lastConnectedTunnel = null;
  state.lastConnectedUrl = null;
  pushLog({ kind: "bridge", text: `Bridge 已停止${source ? `（来源：${source}）` : ""}` });
  void refreshStatus();
  return await snapshot();
}

/* ------------------------------------------------------------------ *
 * 隧道生命周期
 * ------------------------------------------------------------------ */

/**
 * 起隧道。抽成函数是因为三个地方要用：界面按钮、启动时自动起、测试。
 *
 * 命名隧道需要的环境变量从设置里读 —— 之前只有「设系统环境变量」一条路，
 * 对普通用户太不友好（要重启终端才生效）。现在界面上填一次就行。
 */
async function startTunnel(provider, source) {
  if (source) pushLog({ kind: "tunnel", text: `启动隧道（来源：${source}）` });
  provider = provider || chosenProvider();
  if (!provider) {
    return { ok: false, code: "NO_PROVIDER", error: "还没选择连接方式（快速隧道 / 固定地址 / ngrok），请先在「隧道」里选一种" };
  }
  // 快速隧道一律不带固定地址的参数：用户选什么就用什么
  const forceQuick = provider === "cloudflare-quick" || provider === "cloudflare";
  if (forceQuick) provider = "cloudflare";
  state.connecting = true;
  state.tunnelError = null;
  void refreshStatus();
  try {
    if (!state.app) throw new Error("请先启动 Bridge");
    const saved = settings.all();
    const { TunnelManager } = await import(SRC("core", "tunnel.js"));

    // ① 激活检查：没激活 / 到期直接拦下，界面据 code 引导去「激活」页
    //    开发开关 WINDRISE_DEV_NO_LICENSE=1（且不是打包版）时跳过，见 devNoLicense()
    const sealed = !(await devNoLicense());
    if (sealed) await assertChannel();

    // 先停旧隧道，再清公网实测状态：反过来的话旧隧道还在跑的那一下会从「公网不通」变回
    // 「已连接」，触发一次假的 onConnected。新隧道打通后 onConnected 会重新起实测。
    if (state.tunnel) await state.tunnel.stop();
    stopPublicCheck();

    // 把设置里的命名隧道参数喂给 TunnelManager（它优先读环境变量，这里补上设置里的）
    const env = {};
    if (!forceQuick && saved.tunnel.hostname) env.BRIDGE_NAMED_HOSTNAME = saved.tunnel.hostname;
    if (!forceQuick && saved.tunnel.tunnelId) env.BRIDGE_NAMED_TUNNEL_ID = saved.tunnel.tunnelId;
    // 凭据文件可以写相对路径（相对数据目录），预置数据里就是这样，换台电脑也能找到
    if (!forceQuick && saved.tunnel.credentials) env.BRIDGE_NAMED_CREDENTIALS = path.isAbsolute(saved.tunnel.credentials) ? saved.tunnel.credentials : path.join(DATA_HOME, saved.tunnel.credentials);
    if (!forceQuick && saved.tunnel.token) env.BRIDGE_NAMED_TUNNEL_TOKEN = saved.tunnel.token;
    if (saved.tunnel.ngrokAuthtoken) env.BRIDGE_NGROK_AUTHTOKEN = saved.tunnel.ngrokAuthtoken;
    if (saved.tunnel.ngrokDomain) env.BRIDGE_NGROK_DOMAIN = saved.tunnel.ngrokDomain;
    // 边缘路线（auto | direct | proxy）与中继代理：只开系统代理、没开 TUN 的机器靠这个打通
    if (saved.tunnel.edgeRoute) env.BRIDGE_EDGE_ROUTE = saved.tunnel.edgeRoute;
    if (saved.tunnel.edgeProxy) env.BRIDGE_EDGE_PROXY = saved.tunnel.edgeProxy;
    // 上次打通用的路线（直连 / 中继…），下次先试它，省掉试错时间
    if (saved.tunnel.lastRoute) env.BRIDGE_EDGE_PREFERRED = saved.tunnel.lastRoute;

    // 客户端路径：优先用程序自己装的那个（用户没配 PATH 也能用）
    const clients = await tunnelClients();
    const binPaths = {};
    const cfBin = await clients.detect("cloudflared", { dataHome: DATA_HOME });
    if (cfBin.found) binPaths.cloudflared = cfBin.path;
    const ngrokBin = await clients.detect("ngrok", { dataHome: DATA_HOME });
    if (ngrokBin.found) binPaths.ngrok = ngrokBin.path;

    state.tunnel = new TunnelManager({
      localUrl: state.app.server.localUrl,
      dataHome: DATA_HOME,
      provider: provider || "cloudflare",
      // ⑤ 起隧道进程前的激活检查（tunnel.js 独立实现）；开发开关关着时才开
      seal: sealed,
      env: forceQuick ? { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BRIDGE_NAMED_"))), ...env } : { ...process.env, ...env },
      binPaths,
      onLog: (line) => {
        const kept = tidyTunnelLine(line);
        if (kept !== null) pushLog({ kind: "tunnel", text: kept });
      },
      onRoute: (route) => { try { settings.save({ tunnel: { lastRoute: route } }); } catch { /* 忽略 */ } },
      onBlocked: ({ diagnosis }) => { void refreshStatus(); notifyBlocked(diagnosis?.verdict); },
      onRecovered: ({ route }) => { void refreshStatus(); notifyRecovered(route); },
    });
    const started = await state.tunnel.start(provider || "cloudflare");
    state.pendingProvider = provider || "cloudflare";
    // 新隧道实例：④ 之前关于「隧道通没通」的结论作废（启动期还是 503，打通后 onConnected 会再清一次）
    resetRemoteGate();
    return { ok: true, state: await snapshot(), started };
  } catch (error) {
    state.tunnelError = error.message;
    pushLog({ kind: "tunnel", text: `隧道启动失败：${error.message}`, level: "err" });
    return { ok: false, error: error.message, code: error.code, feature: error.feature };
  } finally {
    state.connecting = false;
    void refreshStatus();
  }
}

/** 隧道被挡住：记一条日志（同一原因 10 分钟内只记一次），界面上的错误提示会带「怎么解决？」 */
function notifyBlocked(v) {
  if (!v) return;
  const now = Date.now();
  if (state.lastBlockNotice && state.lastBlockNotice.code === v.code && now - state.lastBlockNotice.at < 10 * 60_000) return;
  state.lastBlockNotice = { code: v.code, at: now };
  pushLog({ kind: "tunnel", text: `隧道暂时连不上：${v.text}。Bridge 会每 30 秒自动检查一次，网络一变就自动重连。`, level: "warn" });
}

function notifyRecovered(route) {
  if (!state.lastBlockNotice) return;
  state.lastBlockNotice = null;
  const label = { direct: "直连", "direct-tcp": "直连（备用方式）", relay: "代理中继" }[route] ?? route;
  pushLog({ kind: "tunnel", text: `隧道已恢复连接（${label}）`, level: "ok" });
}

async function stopTunnel(source) {
  if (source) pushLog({ kind: "tunnel", text: `停止隧道（来源：${source}）` });
  // 先停隧道再清公网实测：顺序反过来，旧隧道还没停的那一下会变回「已连接」
  if (state.tunnel) { await state.tunnel.stop().catch(() => {}); state.tunnel = null; }
  stopPublicCheck();
  // 隧道没了：④ 缓存的「放行」结论立刻作废，下一个远程请求要重新判
  resetRemoteGate();
  state.lastConnectedTunnel = null;
  state.lastConnectedUrl = null;
  state.tunnelError = null;
  void refreshStatus();
  return { ok: true, state: await snapshot() };
}

/** 一键连接：起 Bridge（没起的话）→ 用选中的 / 上次的隧道类型打通 */
async function connectAll(provider, source) {
  if (source) pushLog({ kind: "tunnel", text: `一键连接（来源：${source}）` });
  const saved = settings.all();
  const chosen = provider || chosenProvider(saved);
  if (!chosen) return { ok: false, code: "NO_PROVIDER", error: "还没选择连接方式（快速隧道 / 固定地址 / ngrok），请先选一种" };
  state.connecting = true;
  void refreshStatus();
  try {
    await startBridge();
  } catch (error) {
    state.connecting = false;
    void refreshStatus();
    pushLog({ kind: "bridge", text: `启动失败：${error.message}`, level: "err" });
    return { ok: false, error: error.message };
  }
  return startTunnel(chosen, source);
}

/**
 * 初次设置引导页的「打通隧道」：用户已经选过连接方式就走 connectAll；
 * 没选过就把设置窗口叫出来、弹出「选择连接方式」让人选（引导页自己开不了 Electron 窗口）。
 */
async function tunnelConnectFromGrid() {
  const saved = settings.all();
  const provider = chosenProvider(saved);
  if (!provider) {
    // 没选过：把设置窗口叫到「选择连接方式」让人选（窗口刚建出来时等加载完再发，见 showSettingsPage）
    showSettingsPage("choose-connection");
    return { ok: false, code: "NO_PROVIDER", error: "还没选择连接方式（快速隧道 / 固定地址 / ngrok），已打开设置窗口让你选" };
  }
  return connectAll(provider, "初次设置引导页");
}

/** 换工作区文件夹（界面「工作区」、命令行、AI 工具共用） */
async function setRoots(roots) {
  state.roots = (Array.isArray(roots) ? roots : []).map(r => String(r).trim()).filter(Boolean);
  if (!state.roots.length) state.roots = [app.isPackaged ? path.join(os.homedir(), "Documents") : process.cwd()];
  const missing = state.roots.filter(r => !fs.existsSync(r));
  settings.save({ roots: state.roots, workspaceConfirmed: true }); // 之前只改内存，重启就丢
  // 运行中直接换（不重启 Bridge、不断隧道）；老版本没有 setRoots 才退回重启
  if (state.app?.guard?.setRoots) state.app.guard.setRoots(state.roots);
  else if (state.app) { await stopBridge("修改工作区"); await startBridge(); }
  void refreshStatus();
  return { ok: true, missing, state: await snapshot() };
}

async function disconnectAll(source) {
  if (source) pushLog({ kind: "bridge", text: `断开连接（来源：${source}）` });
  await stopTunnel(source);
  await stopBridge(source).catch(() => {});
  void refreshStatus();
  return { ok: true, state: await snapshot() };
}

/**
 * 启动时自动跑一遍：起 Bridge → 按设置决定要不要起隧道。
 * 失败只记日志，绝不阻塞界面 —— 用户还得手动点按钮排查。
 * 走完把 startupComplete 置 true：在那之前 ④ 对远程请求回 503（隧道状态还没定下来），不判 403。
 */
async function autoStart() {
  try {
    await autoStartInner();
  } finally {
    state.startupComplete = true;
    // 就绪状态变了：清掉启动期可能算出来的结论，下一个远程请求按真实状态重新判
    resetRemoteGate();
  }
}

async function autoStartInner() {
  const saved = settings.all();
  if (!saved.autoStartBridge) {
    pushLog({ kind: "app", text: "按设置跳过自动启动 Bridge" });
    return;
  }
  try {
    await startBridge();
  } catch (error) {
    pushLog({ kind: "bridge", text: `自动启动 Bridge 失败：${error.message}`, level: "err" });
    return;
  }
  // 用户还没选过连接方式：只把 Bridge 起好，隧道等用户自己选、自己点
  const provider = chosenProvider(saved);
  if (!saved.connectChoiceDone || !provider) {
    pushLog({ kind: "tunnel", text: "等待选择连接方式（快速隧道 / 固定地址 / ngrok），选好后点「一键连接」" });
    return;
  }
  // 「打开软件自动连接」：只有用户自己打开了才会自动连，用的是用户选的类型
  if (saved.autoConnect) {
    pushLog({ kind: "tunnel", text: `自动连接：使用你选的连接方式（${provider}）` });
    await startTunnel(provider, "开机自动");
    return;
  }
  if (saved.tunnel.autoStart) {
    const result = await startTunnel(provider, "开机自动");
    if (result.ok) {
      const status = state.tunnel?.status();
      pushLog({ kind: "tunnel", text: `已自动起隧道：${status?.publicUrl ?? saved.tunnel.hostname}`, level: "ok" });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 自动更新 + 网络检测
 * ------------------------------------------------------------------ */
let updater = null;
let diagCache = { at: 0, result: null, pending: null };

function registerUpdateIpc() {
  ipcMain.handle("net:diagnose", async (_event, opts) => {
    const fresh = Date.now() - diagCache.at < 20_000 && diagCache.result && !opts?.force;
    if (fresh) return { ok: true, cached: true, ...diagCache.result };
    diagCache.pending ??= (async () => {
      const { diagnose } = await import(SRC("core", "net-diagnose.js"));
      const d = await diagnose({ env: process.env, explicitProxy: settings.all().tunnel?.edgeProxy || null });
      diagCache.result = {
        verdict: d.verdict, software: d.software ?? [], fakeIp: Boolean(d.fakeIp), tun: d.tun ? { name: d.tun.name } : null,
        proxy: d.proxy, direct: { ok: Boolean(d.direct?.ok), detail: d.direct?.detail ?? "" },
        viaProxy: d.viaProxy ? { ok: Boolean(d.viaProxy.ok) } : null, bypass: d.bypass ? { iface: d.bypass.iface } : null, at: d.at,
      };
      diagCache.at = Date.now();
      return diagCache.result;
    })().finally(() => { diagCache.pending = null; });
    try { return { ok: true, ...(await diagCache.pending) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("update:state", () => ({ ok: true, state: updater?.state() ?? null }));
  ipcMain.handle("update:check", async () => ({ ok: true, state: await updater?.check({ manual: true }) }));
  ipcMain.handle("update:download", async () => ({ ok: true, state: await updater?.download() }));
  ipcMain.handle("update:install", async () => (updater ? updater.install() : { ok: false, error: "更新模块未就绪" }));
  ipcMain.handle("update:skip", () => (updater ? updater.skip() : { ok: false }));
}

function startUpdater() {
  const { createUpdater } = require("./updater.cjs");
  // 现在这个文件只剩自动更新用：里面只有更新 / 检查接口的地址（apiBase）
  let apiBase = "";
  try { apiBase = JSON.parse(fs.readFileSync(path.join(__dirname, "license-config.json"), "utf8")).apiBase || ""; } catch { /* 没有配置就不启用更新 */ }
  updater = createUpdater({
    app, net, shell, settings, apiBase, dataHome: DATA_HOME,
    onState: (st) => sendPanel("update:state", st),
    log: (text) => pushLog({ kind: "app", text, level: "ok" }),
    onQuit: () => { state.quitting = true; app.quit(); },
  });
  updater.start();
}

/** 写完全部外部 MCP 配置后重载：桥没起就等下次启动生效。 */
async function reloadExternalMcp() {
  const manager = state.app?.externalMcp;
  if (!manager) return false;
  try {
    manager.invalidate();
    await manager.refresh({ force: true });
    return true;
  } catch {
    // 具体原因由外部 MCP 管理器自己的日志给出；这里不回显异常文本，避免把配置内容带进日志
    pushLog({ kind: "memos", text: "MemOS 配置已写入，但外部 MCP 重载失败；下次列工具或重启 Bridge 时会再试" });
    return false;
  }
}

function registerMemosIpc() {
  ipcMain.handle("memos:status", () => ({ ok: true, ...memosStatusNow() }));

  ipcMain.handle("memos:save", async (_event, payload) => {
    const key = typeof payload === "string" ? payload : payload?.key;
    const url = typeof payload === "string" ? "" : payload?.url;
    try {
      const saved = await memosBridge.saveMemosKey({
        dataHome: DATA_HOME,
        key,
        url,
        log: (text) => pushLog({ kind: "memos", text }),
      });
      const reloaded = await reloadExternalMcp();
      const status = memosStatusNow();
      pushLog({ kind: "memos", text: saved.created ? "MemOS 外部 MCP 已创建并开始连接" : "MemOS 外部 MCP 已重载" });
      return { ok: true, reloaded, ...status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("memos:disconnect", async () => {
    try {
      await memosBridge.setMemosEnabled({
        dataHome: DATA_HOME,
        enabled: false,
        log: (text) => pushLog({ kind: "memos", text }),
      });
      const reloaded = await reloadExternalMcp();
      const status = memosStatusNow();
      pushLog({ kind: "memos", text: "MemOS 外部 MCP 已断开" });
      return { ok: true, reloaded, ...status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

/** 4b 曾把 Key 放在 settings.context.memosApiKey：有可用的 memos 条目就迁到外部 MCP 配置，并从设置里清掉。 */
async function migrateLegacyMemosKey() {
  const legacy = memosBridge.readLegacyMemosKey(DATA_HOME);
  if (!legacy) return;
  // 外部 MCP 里已经有 Key 就以它为准，不用设置里的旧值覆盖用户手工配好的条目
  if (memosBridge.memosStatus({ dataHome: DATA_HOME }).configured) {
    try {
      settings.save({});
      pushLog({ kind: "memos", text: "外部 MCP 里已有 memos Key，旧设置里的 MemOS Key 已清理（以外部 MCP 配置为准）" });
    } catch {
      pushLog({ kind: "memos", text: "外部 MCP 里已有 memos Key，但旧设置文件清理失败；下次启动再试" });
    }
    return;
  }
  try {
    await memosBridge.saveMemosKey({
      dataHome: DATA_HOME,
      key: legacy,
      log: (text) => pushLog({ kind: "memos", text }),
    });
  } catch {
    pushLog({ kind: "memos", text: "旧设置里还有 MemOS API Key，但没有可用的 memos 外部 MCP 条目，未迁移；请到设置 → 共享上下文重新填写" });
    return;
  }
  try {
    // settings.save 只会写已知字段，旧的 context.memosApiKey 会随这次写入消失
    settings.save({});
    pushLog({ kind: "memos", text: "已把旧设置里的 MemOS API Key 迁移到外部 MCP 配置（可在设置里查看状态）" });
  } catch {
    pushLog({ kind: "memos", text: "Key 已写入外部 MCP 配置，但旧设置文件清理失败；下次启动再试" });
  }
}

function registerSettingsIpc() {
  ipcMain.handle("settings:get", () => ({ ok: true, settings: settings.all(), file: settings.file }));

  ipcMain.handle("settings:set", async (_event, patch) => {
    try {
      // idleMinutes 只收 5 / 10 / 30 / 0（0 = 永不）：渲染层传坏值也不让自动收摊变成「每分钟都关」
      let next = patch ?? {};
      if (next.idleMinutes !== undefined) {
        const minutes = Number(next.idleMinutes);
        next = { ...next, idleMinutes: [0, 5, 10, 30].includes(minutes) ? minutes : 10 };
      }
      const saved = settings.save(next);
      // 端口变了要重启 Bridge 才生效 —— 这里只存，不自动重启（用户可能正在用）
      return { ok: true, settings: saved, state: await snapshot() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("autostart:get", async () => {
    const enabled = await autostart.isEnabled();
    const raw = await autostart.current();
    return { ok: true, enabled, raw, command: autostart.launchCommand() };
  });

  ipcMain.handle("autostart:set", async (_event, enabled) => {
    // 托盘勾选和设置页共用这一条路（setAutostart 里存设置 + 写系统启动项 + 同步托盘勾选状态）
    const result = await setAutostart(Boolean(enabled));
    return { ...result, state: await snapshot() };
  });
}

/* ------------------------------------------------------------------ *
 * 一键开通固定公网地址（Cloudflare 自动化）
 * ------------------------------------------------------------------ */

/** 建一条隧道名字：固定前缀 + 时间戳，避免和用户已有的重名 */
function suggestTunnelName(hostname) {
  const slug = String(hostname).split(".")[0].replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20) || "bridge";
  return `bridge-${slug}-${Date.now().toString(36)}`;
}

async function cfClient() {
  const { CloudflareClient, discoverCredentials } = await import(SRC("core", "cloudflare-api.js"));
  const saved = settings.all();
  const cred = await discoverCredentials({
    token: saved.cloudflare?.apiToken || undefined,
    accountId: saved.cloudflare?.accountId || undefined,
  });
  if (!cred.token) return { ok: false, error: cred.error, source: null };
  const client = new CloudflareClient(cred);
  // 账号 ID 没在 cert.pem 里的时候，从 zone 列表补一个
  if (!client.accountId) {
    const zones = await client.listZones();
    client.accountId = zones[0]?.accountId ?? null;
  }
  return { ok: true, client, source: cred.source };
}

function registerCloudflareIpc() {
  ipcMain.handle("cf:status", async () => {
    try {
      const result = await cfClient();
      if (!result.ok) return { ok: false, error: result.error };
      const verified = await result.client.verify().catch((error) => ({ error: error.message }));
      const zones = await result.client.listZones().catch(() => []);
      return {
        ok: true,
        source: result.source,
        tokenStatus: verified.status ?? "未知",
        tokenError: verified.error ?? null,
        zones: zones.map((z) => z.name),
        accountId: result.client.accountId,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /**
   * 预览：算清楚会做哪些事，但**什么都不改**。
   * 界面拿这个结果给用户看，确认了才调 cf:provision。
   */
  ipcMain.handle("cf:preview", async (_event, input) => {
    try {
      const result = await cfClient();
      if (!result.ok) return { ok: false, error: result.error };
      const hostname = String(input?.hostname ?? "").trim();
      if (!hostname || !hostname.includes(".")) return { ok: false, error: "域名填得不对（要形如 mcp.你的域名.com）" };
      const saved = settings.all();
      const tunnelName = input?.tunnelName?.trim() || suggestTunnelName(hostname);
      const localPort = state.app?.server?.address()?.port ?? saved.port;
      const preview = await result.client.preview({ hostname, tunnelName, localPort });
      return { ...preview, tunnelName, localPort };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /**
   * 真正执行。**必须显式传 confirm: true** ——
   * 这个操作会在用户的 Cloudflare 账号里建隧道、改 DNS，不能误触发。
   */
  ipcMain.handle("cf:provision", async (_event, input) => {
    try {
      if (input?.confirm !== true) {
        return { ok: false, error: "没有确认。这个操作会在你的 Cloudflare 账号里创建隧道并修改 DNS，需要显式确认。" };
      }
      const result = await cfClient();
      if (!result.ok) return { ok: false, error: result.error };

      const hostname = String(input?.hostname ?? "").trim();
      const saved = settings.all();
      const localPort = state.app?.server?.address()?.port ?? saved.port;

      // 重新算一遍预览，拿到最新的 zone/tunnel/dns 信息（用户看到预览到点确认之间可能过了很久）
      const preview = await result.client.preview({ hostname, tunnelName: input?.tunnelName, localPort });
      if (!preview.ok) return preview;

      pushLog({ kind: "cloudflare", text: `开始开通 ${hostname} → 127.0.0.1:${localPort}`, level: "ok" });
      const provisioned = await result.client.provision({
        hostname,
        tunnelName: preview.tunnel.name,
        localPort,
        zoneId: preview.zone.id,
        tunnelId: preview.tunnel.existing ? preview.tunnel.id : undefined,
        dnsRecordId: preview.dns.existing ? preview.dns.id : undefined,
      });
      for (const line of provisioned.done) pushLog({ kind: "cloudflare", text: line, level: "ok" });

      // 把结果写进设置，并把隧道切到「令牌模式」—— 远端配置已经配好了，
      // 本地不用再维护 config.yml，一条令牌就够
      settings.save({
        tunnel: {
          hostname,
          tunnelId: "",
          credentials: "",
          token: provisioned.token ?? "",
        },
        // 开通好固定地址：自动选它，并打开「打开软件自动连接」；用户之后可随时换成快速隧道或 ngrok
        connectChoice: "cloudflare-named",
        connectChoiceDone: true,
        autoConnect: true,
        autoStartBridge: true,
      });

      // 重启隧道让它用上新配置
      if (state.tunnel) await stopTunnel("主界面按钮");
      const started = await startTunnel("cloudflare-named", "主界面按钮");
      return { ok: true, ...provisioned, tunnelStart: started, state: await snapshot() };
    } catch (error) {
      pushLog({ kind: "cloudflare", text: `开通失败：${error.message}`, level: "err" });
      return { ok: false, error: error.message };
    }
  });
}

/* ------------------------------------------------------------------ *
 * 隧道客户端安装（cloudflared / ngrok）
 * ------------------------------------------------------------------ */

function registerClientIpc() {
  ipcMain.handle("clients:status", async () => {
    try {
      const clients = await tunnelClients();
      return { ok: true, status: await clients.statusAll({ dataHome: DATA_HOME }) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /**
   * 装一个客户端。下载可能几十兆，会往界面推进度事件
   * （事件名 clients:progress，界面按 name 区分是哪个）。
   */
  ipcMain.handle("clients:install", async (_event, name) => {
    try {
      const clients = await tunnelClients();
      const result = await clients.ensure(name, {
        dataHome: DATA_HOME,
        onProgress: (progress) => {
          if (state.panel && !state.panel.isDestroyed()) {
            state.panel.webContents.send("clients:progress", { name, ...progress });
          }
        },
      });
      if (result.ok) {
        pushLog({
          kind: "tunnel",
          text: `${name} ${result.alreadyInstalled ? "已经装好了" : "装好了"}：${result.version ?? ""}`,
          level: "ok",
        });
      } else {
        pushLog({ kind: "tunnel", text: `${name} 安装失败：${result.error}`, level: "err" });
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function sendPanel(channel, payload) {
  if (state.panel && !state.panel.isDestroyed()) state.panel.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ *
 * 托盘 + 任务栏状态（绿色 = 隧道已打通）
 * ------------------------------------------------------------------ */
const ASSET = (name) => path.join(__dirname, "assets", name);
const STATUS_LABEL = { stopped: "未启动", local: "仅本机", connecting: "连接中…", connected: "已连接", error: "连接失败" };
const imageCache = new Map();
function assetImage(name) {
  if (!imageCache.has(name)) imageCache.set(name, nativeImage.createFromPath(ASSET(name)));
  return imageCache.get(name);
}

/**
 * 打开（或聚焦）格子 1 —— 托盘单击 / second-instance / 启动自动开格子都走这里。
 * 没有「格子 1」就按现有命名规则建一个（启动地址 Google），开完把窗口拿到前台。
 */
async function openWindrise() {
  if (!state.profiles) throw new Error("账号管理器还没就绪");
  const result = await openGrid1Flow({
    profiles: state.profiles.profiles,
    createProfile: (input) => state.profiles.create(input),
    openWindow: (id) => state.profiles.openWindow(id),
    focusWindow: (id) => state.profiles.focusWindow(id),
  });
  if (result.kind === "create") pushLog({ kind: "browser", text: `新建「${result.name}」→ ${state.profiles.partitionOf({ id: result.id })}`, level: "ok" });
  else pushLog({ kind: "browser", text: `打开「${result.name}」`, level: "ok" });
  // 初次设置：引导没走过就在格子 1 里开一个引导页标签（新标签页，不是 Electron 窗口）
  if (shouldOpenOnboarding(settings.all(), { opened: true })) {
    try {
      await state.profiles.backend.openOnboardingTab(result.id, { foreground: true });
    } catch (error) {
      pushLog({ kind: "app", text: `打开初次设置引导页失败：${error.message}`, level: "warn" });
    }
  }
  return result;
}

/** 托盘「新建格子」：按命名规则建一个新账号（启动地址 Google），打开并聚焦 */
async function newGrid() {
  if (!state.profiles) throw new Error("账号管理器还没就绪");
  const name = gridNameFor(null, state.profiles.profiles);
  const profile = await state.profiles.create({ name, startUrl: GRID1_START_URL });
  await state.profiles.openWindow(profile.id);
  await state.profiles.focusWindow(profile.id);
  pushLog({ kind: "browser", text: `新建「${profile.name}」→ ${state.profiles.partitionOf(profile)}`, level: "ok" });
  return profile;
}

/** 托盘「所有格子」里的某一格：打开（复用）并聚焦 */
async function openGridById(id) {
  if (!state.profiles) throw new Error("账号管理器还没就绪");
  const result = await state.profiles.openWindow(id);
  await state.profiles.focusWindow(id);
  pushLog({ kind: "browser", text: `打开「${result.profile?.name ?? id}」${result.reused ? "（复用已有窗口）" : ""}`, level: "ok" });
  return result;
}

/** 托盘菜单模板：状态和格子名单每次重建时现取 */
function trayMenuTemplate(status = connectionStatus()) {
  const connected = status.level === "connected";
  const host = status.publicMcpUrl ? publicHost(status.publicMcpUrl) : "";
  const grids = (state.profiles?.profiles ?? []).map((p) => ({ id: p.id, name: p.name }));
  return buildTrayTemplate({
    statusLine: trayStatusLine({ level: status.level, host }),
    grids,
    autostartEnabled: state.autostartEnabled === true,
    copyMcpEnabled: connected,
    openWindrise: () => openWindrise().catch((error) => pushLog({ kind: "app", text: `打开 Windrise 失败：${error.message}`, level: "err" })),
    newGrid: () => newGrid().catch((error) => pushLog({ kind: "app", text: `新建格子失败：${error.message}`, level: "err" })),
    openGrid: (id) => openGridById(id).catch((error) => pushLog({ kind: "app", text: `打开格子失败：${error.message}`, level: "err" })),
    copyMcp: () => {
      const url = publicConnectionUrl(status);
      if (url) clipboard.writeText(url);
    },
    settings: () => showPanel(),
    toggleAutostart: (enabled) => { void setAutostart(Boolean(enabled)); },
    quit: () => { state.quitting = true; app.quit(); },
  });
}

/** 开机自启开关：托盘勾选和设置页 IPC 共用（存设置 + 写系统启动项 + 同步托盘勾选状态） */
async function setAutostart(enabled) {
  const result = await autostart.setEnabled(Boolean(enabled));
  if (result.ok) {
    settings.save({ autoLaunch: Boolean(enabled) });
    state.autostartEnabled = Boolean(enabled);
    pushLog({ kind: "app", text: enabled ? "已开启开机自启" : "已关闭开机自启", level: "ok" });
  } else {
    pushLog({ kind: "app", text: `设置开机自启失败：${result.error}`, level: "err" });
  }
  updateTray();
  return result;
}

function updateTray(status = connectionStatus()) {
  if (!state.tray || state.tray.isDestroyed()) return;
  const level = status.level === "stopped" ? "idle" : status.level;
  state.tray.setImage(assetImage(`tray-${level}.png`));
  state.tray.setToolTip(`${APP_NAME} · ${STATUS_LABEL[status.level]}`);
  try {
    state.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(status)));
  } catch (error) {
    pushLog({ kind: "app", text: `托盘菜单更新失败：${error.message}`, level: "warn" });
  }
}

function createTray() {
  if (state.tray) return state.tray;
  try {
    state.tray = new Tray(assetImage("tray-idle.png"));
    // 单击 / 双击 = 打开 Windrise（格子 1）；右键是菜单（setContextMenu）
    state.tray.on("click", () => openWindrise().catch((error) => pushLog({ kind: "app", text: `打开 Windrise 失败：${error.message}`, level: "err" })));
    state.tray.on("double-click", () => openWindrise().catch((error) => pushLog({ kind: "app", text: `打开 Windrise 失败：${error.message}`, level: "err" })));
    updateTray();
  } catch (error) {
    pushLog({ kind: "app", text: `托盘图标创建失败：${error.message}`, level: "warn" });
  }
  return state.tray;
}

let lastStatusKey = "";
let lastLevel = "stopped";
let refreshing = false;
async function refreshStatus() {
  // 退出中不再刷新 / 不再触发 onConnected
  if (state.quitting) return;
  // 健康检查要跑探针，最坏 3 秒；700ms 的轮询不能层层叠加
  if (refreshing) return;
  refreshing = true;
  try {
    let status;
    try { status = connectionStatus(); } catch { return; }
    /*
     * 「公网不通」时 level 已经是 error，但隧道本身还连着（publicMcpUrl 还在）。
     * 自动重连的 stop + start 会把定时器清掉，这里负责重新起来，直到公网实测成功一次；
     * 否则 failures 永远停在 2，状态卡在「公网不通」出不来。
     * 隧道正在自己重连时不探：重连结果出来再测。
     */
    if (status.publicMcpUrl && !state.connecting && !state.publicCheckTimer && !state.publicCheckReconnecting && !state.tunnel?.status?.()?.reconnecting) startPublicCheck();
    const key = `${status.level}|${status.publicMcpUrl ?? ""}`;
    if (key === lastStatusKey) return;
    const previous = lastLevel;
    lastStatusKey = key;
    lastLevel = status.level;
    updateTray(status);
    const panel = state.panel;
    if (panel && !panel.isDestroyed()) {
      panel.setOverlayIcon(status.level === "stopped" ? null : assetImage(`badge-${status.level === "local" ? "local" : status.level}.png`), `${APP_NAME} · ${STATUS_LABEL[status.level]}`);
      panel.webContents.send("bridge:status", await snapshot());
    }
    // snapshot() 要等健康检查，期间状态可能又变了（隧道刚停 / 刚重连）：重新取一次再决定
    const fresh = connectionStatus();
    if (!state.quitting && fresh.level === "connected" && previous !== "connected") onConnected(fresh);
  } catch {
    // 刷新失败不致命（窗口刚关、页面正在销毁等），下一轮轮询会再来
  } finally {
    refreshing = false;
  }
}

async function onConnected(status) {
  /*
   * 隧道自己重连（睡眠唤醒 / 网卡变化 / 掉线 60 秒）后会再次经过这里：
   * 同一个隧道实例、同一个公网地址 = 只是恢复了，只记一条日志；
   * 不重发 tunnel:connected（界面不会被拽回 Bridge 页）、不弹通知。
   * 地址变了（快速隧道）或换了实例（用户手动重新连接）才走完整流程。
   */
  const tunnel = state.tunnel ?? null;
  const resumed = Boolean(tunnel) && state.lastConnectedTunnel === tunnel && state.lastConnectedUrl === status.publicMcpUrl;
  state.lastConnectedTunnel = tunnel;
  state.lastConnectedUrl = status.publicMcpUrl;
  // 隧道刚打通：④ 之前算出的「没隧道」结论（含启动期的 503 缓存）作废，下一个远程请求重新判
  resetRemoteGate();
  if (resumed) {
    pushLog({ kind: "tunnel", text: `隧道已恢复（地址没变）：${status.publicMcpUrl}`, level: "ok" });
    startPublicCheck();
    return;
  }
  // ② 隧道连上后再查一次（和打通前那道是两套代码）；开发开关关着时才查
  {
    const skipSeal = await devNoLicense();
    if (!skipSeal) {
      const why = sealAfterConnect();
      if (why) { void licenseLost(why, "隧道连上后"); return; }
    }
  }
  const provider = state.tunnel?.status().provider || state.pendingProvider;
  if (provider) settings.save({ tunnel: { lastProvider: provider } });
  pushLog({ kind: "tunnel", text: `已打通：${status.publicMcpUrl}`, level: "ok" });
  // 从此刻起每 30 秒从公网核对一次；头 30 秒失败只记原因，不报警（快速隧道域名生效需要几秒）
  startPublicCheck();
  const panel = state.panel;
  if (panel && !panel.isDestroyed()) panel.webContents.send("tunnel:connected", { publicMcpUrl: status.publicMcpUrl });
  // 面板不在前台时才弹系统通知，避免重复打扰
  if ((!panel || panel.isDestroyed() || !panel.isVisible() || !panel.isFocused()) && Notification.isSupported()) {
    const note = new Notification({ title: "Windrise Bridge 已连接", body: "隧道已打通，可以连接 AI 了", icon: ASSET("icon-256.png"), silent: true });
    note.on("click", () => showPanel());
    note.show();
  }
}

/**
 * 把窗口叫到最前面。Windows 有「前台锁」：安装器 / 别的程序拉起我们时，新窗口常常只在任务栏闪一下、
 * 躲在后面，用户以为软件「最小化了」找不到。这里先临时置顶再取消，并让任务栏图标闪一下。
 */
function bringToFront(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  try { win.setAlwaysOnTop(true); win.moveTop(); } catch { /* 忽略 */ }
  win.focus();
  setTimeout(() => { try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* 忽略 */ } }, 600);
  try { if (!win.isFocused()) win.flashFrame(true); } catch { /* 忽略 */ }
}

function showPanel() {
  const win = state.panel && !state.panel.isDestroyed() ? state.panel : createPanel();
  bringToFront(win);
}

/** 设置窗口能跳的页（与插件 / browseros-profiles 的 SETTINGS_TABS 同一张表） */
const PANEL_GOTO_TABS = new Set(["settings", "account", "bridge", "context", "choose-connection"]);

/** 插件侧边栏 / 引导页点「打开设置」：把主程序窗口叫出来并切到对应页（默认设置页） */
function showSettingsPage(tab = "settings") {
  const target = PANEL_GOTO_TABS.has(tab) ? tab : "settings";
  const existed = Boolean(state.panel && !state.panel.isDestroyed() && !state.panel.webContents.isLoading());
  showPanel();
  const win = state.panel;
  if (!win || win.isDestroyed()) return;
  const go = () => {
    if (!win.isDestroyed()) win.webContents.send("panel:goto", target);
  };
  if (existed) {
    setTimeout(go, 50);
  } else {
    // 窗口刚建出来时渲染页还没挂好监听：等加载完再发，不能靠固定延时赌
    win.webContents.once("did-finish-load", () => setTimeout(go, 50));
  }
}

/* ------------------------------------------------------------------ *
 * 面板窗口
 * ------------------------------------------------------------------ */

/** 右上角系统按钮（最小化/最大化/关闭）的配色：底色透明，图标跟随深浅色；高度和软件顶栏一致 */
function titleOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: "#00000000", symbolColor: dark ? "#d4d4d8" : "#3f3f46", height: 63 };
}

function createPanel() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    title: APP_NAME,
    icon: ASSET("icon-256.png"),
    // 背景色和主题一致 + 等渲染好再显示：避免启动时白屏闪一下（Electron 官方建议）
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
    show: false,
    autoHideMenuBar: true,
    // 不要系统自带的标题栏：软件顶栏就是标题栏（可拖动、双击最大化），右上角保留系统的最小化/最大化/关闭按钮
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 22 } }
      : { titleBarStyle: "hidden", titleBarOverlay: titleOverlay() }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once("ready-to-show", () => {
    // 窗口只在托盘「设置与教程」/ 侧边栏「设置」主动打开时才建，出来就该到前台
    bringToFront(win);
    win.on("focus", () => { try { win.flashFrame(false); } catch { /* 忽略 */ } });
    lastStatusKey = ""; void refreshStatus();
  });
  win.loadFile(path.join(__dirname, "index.html"));
  // 关窗口 = 缩到托盘，Bridge / 隧道继续跑；真正退出走托盘菜单「退出」
  win.on("close", (event) => {
    if (state.quitting || !state.tray || !settings.all().closeToTray) return;
    event.preventDefault();
    win.hide();
    if (!state.trayHinted && Notification.isSupported()) {
      state.trayHinted = true;
      new Notification({ title: APP_NAME, body: process.platform === "darwin" ? "仍在后台运行，点屏幕顶部菜单栏的图标可重新打开" : "仍在后台运行，点右下角托盘图标可重新打开", icon: ASSET("icon-256.png"), silent: true }).show();
    }
  });
  win.on("closed", () => { state.panel = null; });
  state.panel = win;
  return win;
}

/* ------------------------------------------------------------------ *
 * 共享上下文总线（A 方案）
 *
 * 多个窗口「链接」成一组后共用一块本地记忆：一个窗口里的 Agent 学到的东西，
 * 同组其它窗口的 Agent 能直接读到，不用重新踩一遍。
 *
 * 注意：这**不是**共享登录态。窗口之间的 Cookie / localStorage / 存储隔离
 * 完全不动 —— 共享的只是记忆，不是身份。
 * ------------------------------------------------------------------ */

/** 懒加载 ESM 的 ContextBus（主进程是 CJS，只能动态 import）。 */
async function contextBus() {
  if (state.contextBusInstance) return state.contextBusInstance;
  if (!state.contextBusLoading) {
    state.contextBusLoading = (async () => {
      const { ContextBus } = await import(SRC("core", "context-bus.js"));
      const bus = new ContextBus({
        file: path.join(DATA_HOME, "context-bus.json"),
        log: (line) => pushLog({ kind: "context", text: String(line) }),
      });
      await bus.initialize();
      state.contextBusInstance = bus;
      return bus;
    })().catch((error) => {
      state.contextBusLoading = null;
      throw error;
    });
  }
  return state.contextBusLoading;
}

/** 把总线里所有组 + 成员窗口名字组装成界面好渲染的形状。 */
async function contextSnapshot() {
  let bus;
  try {
    bus = await contextBus();
  } catch (error) {
    return { available: false, error: error.message, groups: [], stats: null };
  }
  const [groups, stats] = await Promise.all([bus.listGroups(), bus.stats()]);
  const profiles = await state.profiles.list().catch(() => []);
  const nameOf = new Map(profiles.map(p => [p.id, p.name]));

  const detailed = [];
  for (const group of groups) {
    const items = await bus.listItems({ groupId: group.id, limit: 50 }).catch(() => []);
    detailed.push({
      ...group,
      memberNames: (group.members ?? []).map(id => ({ id, name: nameOf.get(id) ?? id })),
      items: items.map(item => ({
        ...item,
        sourceName: nameOf.get(item.sourceProfileId) ?? item.sourceProfileId ?? "(未知)",
      })),
    });
  }
  return { available: true, groups: detailed, stats, profiles: profiles.map(p => ({ id: p.id, name: p.name, running: p.running })) };
}

function registerContextIpc() {
  const wrap = (fn) => async (_event, payload) => {
    try {
      const bus = await contextBus();
      return { ok: true, result: await fn(bus, payload ?? {}) };
    } catch (error) {
      pushLog({ kind: "context", text: `操作失败：${error.message}`, level: "err" });
      return { ok: false, error: error.message };
    }
  };

  ipcMain.handle("context:snapshot", () => contextSnapshot());
  ipcMain.handle("context:group-create", wrap((bus, p) => bus.createGroup(p)));
  ipcMain.handle("context:group-update", wrap((bus, p) => bus.updateGroup(p.id, p.patch ?? {})));
  ipcMain.handle("context:group-delete", wrap((bus, p) => bus.deleteGroup(p.id)));
  ipcMain.handle("context:link", wrap((bus, p) => bus.link(p.groupId, p.profileIds ?? [])));
  ipcMain.handle("context:unlink", wrap((bus, p) => bus.unlink(p.groupId, p.profileIds ?? [])));
  ipcMain.handle("context:share", wrap((bus, p) => bus.share(p)));
  ipcMain.handle("context:recall", wrap((bus, p) => bus.recall(p)));
  ipcMain.handle("context:forget", wrap((bus, p) => bus.forget(p)));
  ipcMain.handle("context:send", wrap((bus, p) => bus.send(p)));
  ipcMain.handle("context:inbox", wrap((bus, p) => bus.inbox(p)));
  ipcMain.handle("context:mark-read", wrap((bus, p) => bus.markRead(p)));
  ipcMain.handle("context:stats", wrap((bus) => bus.stats()));
  ipcMain.handle("context:prune", wrap((bus) => bus.prune()));
  ipcMain.handle("context:groups-for", wrap((bus, p) => bus.groupsFor(p.profileId)));
  // 「最近活跃窗口」：工具层解析身份时最后会回退到这个值。
  // 注意这只是**便利值，不是鉴权** —— 本地进程本来就能直接读那个 json，
  // 真正的隔离靠浏览器分区，不靠这个字段。
  ipcMain.handle("context:set-active", wrap((bus, p) => bus.setActiveProfile(p.profileId)));
}

/* ------------------------------------------------------------------ *
 * 连接器：每个 AI 一把钥匙，只能操作分给它的窗口
 * ------------------------------------------------------------------ */

/**
 * 口令入口的本机 / 公网地址：地址里不带令牌，客户端靠 Authorization: Bearer <口令> 鉴权。
 * 主身份口令和「改用口令」的连接器都走这一套（连接器的口令藏在请求头里）。
 */
function ownerBearerUrls() {
  const runningPort = state.app?.server?.address?.()?.port ?? null;
  const configuredPort = Number(settings.all().port);
  const port = runningPort ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : null);
  const localUrl = port ? `http://127.0.0.1:${port}/mcp` : null;

  let publicUrl = null;
  const status = connectionStatus();
  if (status.publicMcpUrl) {
    // 主地址长这样：https://xxx/mcp/<主令牌>，去掉令牌那一段就是隧道根地址
    const base = status.publicMcpUrl.replace(/\/mcp\/[^/]+\/?$/, "");
    if (base) publicUrl = `${base}/mcp`;
  }
  return { localUrl, publicUrl };
}

/** 某个连接器的本机 / 公网地址。公网只在隧道打通时才有。 */
function connectorUrls(connector) {
  // 口令模式：地址不带令牌，和主身份口令共用 /mcp 入口
  if (connector?.authMode === "bearer") return ownerBearerUrls();

  const runningPort = state.app?.server?.address?.()?.port ?? null;
  const configuredPort = Number(settings.all().port);
  const port = runningPort ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : null);
  const localUrl = port ? `http://127.0.0.1:${port}/mcp/${connector.token}` : null;

  let publicUrl = null;
  const status = connectionStatus();
  if (status.publicMcpUrl) {
    // 主地址长这样：https://xxx/mcp/<主令牌>，去掉令牌那一段就是隧道根地址
    const base = status.publicMcpUrl.replace(/\/mcp\/[^/]+\/?$/, "");
    if (base) publicUrl = `${base}/mcp/${connector.token}`;
  }
  return { localUrl, publicUrl };
}

/**
 * 连接器变化 → 通知面板重画；新的待批准 → 再弹一条系统通知。
 * 通知里尽量写窗口名字；窗口已经不在了就退回 id。
 */
function wireConnectorEvents(store) {
  store.on("change", () => sendPanel("connectors:changed"));
  /** 同一个连接器的批准通知 1 分钟最多弹一次：申请是远端 AI 发起的，不限流就能刷屏 */
  const lastNotifiedAt = new Map();
  store.on("approval-request", (request) => {
    sendPanel("connectors:changed");
    if (!Notification.isSupported()) return;
    if (Date.now() - (lastNotifiedAt.get(request.connectorId) ?? 0) < 60_000) return;
    lastNotifiedAt.set(request.connectorId, Date.now());
    const profile = state.profiles?.profiles?.find((item) => item.id === request.profileId);
    const windowName = profile?.name || request.profileId;
    const owner = store.list().find((item) => item.id !== request.connectorId && item.profiles.includes(request.profileId));
    const note = new Notification({
      title: APP_NAME,
      // 批准给的是整个窗口（看页面、点击、输入、跳转），不只是触发申请的那一个工具；窗口已归别人时写明会移走
      body: `${request.connectorName} 想长期使用窗口「${windowName}」（能看页面、点击、输入）${owner ? `，它现在归 ${owner.name}，允许会从那边移走` : ""}。到 Windrise 设置里批准`,
      icon: ASSET("icon-256.png"),
      silent: true,
    });
    note.on("click", () => {
      showPanel();
      setTimeout(() => sendPanel("panel:goto", "settings"), 100);
    });
    note.show();
  });
}

function registerConnectorsIpc() {
  const fail = (error) => ({ ok: false, error: error.message });

  ipcMain.handle("connectors:list", () => {
    try {
      return {
        ok: true,
        connectors: state.connectors.list().map((connector) => ({ ...connector, ...connectorUrls(connector) })),
        pending: state.connectors.pending(),
      };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:create", (_event, payload) => {
    try {
      const name = typeof payload === "string" ? payload : payload?.name;
      return { ok: true, connector: state.connectors.create(name) };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:remove", (_event, payload) => {
    try {
      const id = typeof payload === "string" ? payload : payload?.id;
      return { ok: true, removed: state.connectors.remove(id) };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:rename", (_event, payload) => {
    try {
      return { ok: true, connector: state.connectors.rename(payload?.id, payload?.name) };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:grant", (_event, payload) => {
    try {
      return { ok: true, connector: state.connectors.grant(payload?.connectorId, payload?.profileId) };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:revoke", (_event, payload) => {
    try {
      return { ok: true, connector: state.connectors.revoke(payload?.connectorId, payload?.profileId) };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:approve", (_event, payload) => {
    try {
      const requestId = typeof payload === "string" ? payload : payload?.requestId;
      const request = state.connectors.approve(requestId);
      return { ok: Boolean(request), request };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:deny", (_event, payload) => {
    try {
      const requestId = typeof payload === "string" ? payload : payload?.requestId;
      const request = state.connectors.deny(requestId);
      return { ok: Boolean(request), request };
    } catch (error) { return fail(error); }
  });

  /*
   * 改用口令 / 改回路径令牌：store 自己会 emit("change") 让面板重画，
   * 这里再显式发一次，保证即使 store 的实现在这版没发事件，界面也会刷新。
   * key 只随这次返回交给渲染层，不写日志、不进通知。
   */
  ipcMain.handle("connectors:set-bearer", (_event, payload) => {
    try {
      const id = typeof payload === "string" ? payload : payload?.id;
      const result = state.connectors.setBearer(id);
      const connector = result?.connector ?? result;
      sendPanel("connectors:changed");
      return {
        ok: true,
        key: result?.key ?? null,
        connector: { ...connector, ...connectorUrls(connector) },
      };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("connectors:set-path-mode", (_event, payload) => {
    try {
      const id = typeof payload === "string" ? payload : payload?.id;
      const connector = state.connectors.setPathMode(id);
      sendPanel("connectors:changed");
      return { ok: true, connector: { ...connector, ...connectorUrls(connector) } };
    } catch (error) { return fail(error); }
  });
}

/* ------------------------------------------------------------------ *
 * 主身份口令：/mcp 入口的 Authorization: Bearer 模式
 * ------------------------------------------------------------------ */

function registerOwnerAuthIpc() {
  const fail = (error) => ({ ok: false, error: error.message });
  /** Bridge 没启动时 state.app 是空的：口令操作一律回「Bridge 未启动」，界面据此置灰 */
  const auth = () => state.app?.ownerAuth ?? null;

  ipcMain.handle("owner-auth:status", () => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      const result = owner.status();
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:generate", () => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      // key 是口令明文，只在这一条返回值里出现：不 pushLog、不 sendPanel、不发通知
      const result = owner.generate();
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:add-key", (_event, payload) => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      // key 是口令明文，只在这一条返回值里出现：不 pushLog、不 sendPanel、不发通知
      const label = typeof payload === "string" ? payload : payload?.label;
      const result = owner.addKey(label);
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:rotate-key", (_event, payload) => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      // key 是口令明文，只在这一条返回值里出现：不 pushLog、不 sendPanel、不发通知
      const id = typeof payload === "string" ? payload : payload?.id;
      const result = owner.rotateKey(id);
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:revoke-key", (_event, payload) => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      const id = typeof payload === "string" ? payload : payload?.id;
      const result = owner.revokeKey(id);
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:revoke", () => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      const result = owner.revoke();
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  /*
   * 换主路径令牌：旧的 /mcp/<令牌> 地址立即作废。做法是写新令牌，再走一遍「断开 → 一键连接」
   * （和用户手动点的是同一条路，地址一变，公网实测也跟着走新地址）。
   * 新令牌不进日志：日志里只写「已更换」，新地址照常由隧道「已打通」那行给出，磁盘日志会打码。
   */
  ipcMain.handle("owner-auth:rotate-path", async () => {
    try {
      if (!state.app) return { ok: false, error: "Bridge 未启动" };
      if (state.connecting) return { ok: false, error: "正在连接中，等连好了再换" };
      const tunnelStatus = state.tunnel?.status?.() ?? null;
      const wasConnected = Boolean(tunnelStatus?.connected);
      const provider = tunnelStatus?.provider || settings.all().tunnel?.lastProvider || chosenProvider();
      const { rotateRouteToken } = await import(SRC("core", "route-token.js"));
      await rotateRouteToken(DATA_HOME);
      pushLog({ kind: "bridge", text: "主路径令牌已更换，旧地址作废，正在重新连接", level: "ok" });
      await disconnectAll("换主路径令牌");
      const result = wasConnected && provider ? await connectAll(provider, "换主路径令牌") : await startBridge().then(() => ({ ok: true }));
      const owner = state.app?.ownerAuth?.status?.() ?? {};
      if (result?.ok === false) return { ok: false, error: `令牌已换，但重连没成功：${result.error || "原因不明"}，请点「一键连接」`, ...owner, ...ownerBearerUrls() };
      return { ok: true, ...owner, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });

  ipcMain.handle("owner-auth:set-path", (_event, payload) => {
    try {
      const owner = auth();
      if (!owner) return { ok: false, error: "Bridge 未启动" };
      // 没口令时关掉路径令牌会抛错：错误信息原样交给界面
      // 只有明确传 false 才关：参数缺失、写错都按「开」处理，不会误关公网入口
      const result = owner.setPathEnabled(payload?.enabled !== false);
      if (result?.ok === false) return result;
      return { ok: true, ...result, ...ownerBearerUrls() };
    } catch (error) { return fail(error); }
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/**
 * 「按客户端复制配置」的数据：地址取当前公网入口，路径入口开着时把口令从 /mcp/<口令> 里解出来。
 * 生成逻辑在 src/core/client-configs.js（纯函数），这里只负责提供当前连接状态。
 * 返回里**不回传口令本身**（只有 hasToken / pathToken 两个事实），界面据此显示模式说明。
 */
async function clientConfigGroups() {
  const status = connectionStatus();
  if (!status.publicMcpUrl) return { ok: false, error: "隧道还没打通" };
  const pathEnabled = state.app?.ownerAuth ? state.app.ownerAuth.pathEnabled() : true;
  const baseUrl = publicConnectionUrl(status);
  let token = "";
  if (pathEnabled) {
    const match = String(status.publicMcpUrl).match(/\/mcp\/([^/?#]+)/);
    if (match) {
      try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
    }
  }
  try {
    const { buildClientConfigGroups } = await import(SRC("core", "client-configs.js"));
    return {
      ok: true,
      groups: buildClientConfigGroups({ baseUrl, token, pathToken: pathEnabled }),
      pathToken: pathEnabled,
      hasToken: Boolean(String(token || "").trim()),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function registerIpc() {
  ipcMain.handle("bridge:snapshot", () => snapshot());

  ipcMain.handle("client-configs:groups", () => clientConfigGroups());

  ipcMain.handle("bridge:start", async () => {
    try { return { ok: true, state: await startBridge() }; }
    catch (error) {
      pushLog({ kind: "bridge", text: `启动失败：${error.message}`, level: "err" });
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("bridge:stop", async () => {
    try { return { ok: true, state: await stopBridge("主界面按钮") }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("bridge:set-roots", async (_event, roots) => setRoots(roots));

  ipcMain.handle("bridge:set-options", async (_event, options) => {
    state.options = { ...state.options, ...(options || {}) };
    // 之前只改内存：重启就丢，而且对正在运行的 Bridge 不生效
    const patch = {};
    if ("approve" in (options || {})) patch.approveDangerous = Boolean(options.approve);
    if ("readonlyAuto" in (options || {})) patch.autoAllowReadonly = Boolean(options.readonlyAuto);
    if ("jsonResponse" in (options || {})) patch.jsonResponse = Boolean(options.jsonResponse);
    if ("agentCursor" in (options || {})) patch.showAgentCursor = Boolean(options.agentCursor);
    if (Object.keys(patch).length) settings.save(patch);
    if (state.app?.terminal && "approve" in (options || {})) state.app.terminal.autoApproveReadOnly = Boolean(options.approve);
    return { ok: true, state: await snapshot() };
  });

  ipcMain.handle("bridge:list-tools", async () => {
    try {
      const { listTools } = await import(SRC("core", "registry.js"));
      if (state.app) {
        return { ok: true, tools: listTools().map(t => ({ name: t.name, title: t.title, capability: t.capability, source: t.source })) };
      }
      /*
       * 2026-10-25 修：以前这里会临时 boot 一个 Bridge 拿清单再 stop。它和正式 Bridge 共用全局工具表：
       * 启动时盖掉正式的共享上下文工具，stop 时关掉自己的总线（→「共享上下文总线已关闭」），
       * 还把同名的外部 MCP 工具从表里删掉（→ browseros_neo、windows-mcp 时有时无）。
       * 现在：Bridge 正在启动就等它启动完；没在跑就直说，不再临时起第二个。
       */
      if (state.bridgeBooting) {
        await state.bridgeBooting.catch(() => {});
        if (state.app) return { ok: true, tools: listTools().map(t => ({ name: t.name, title: t.title, capability: t.capability, source: t.source })) };
      }
      return { ok: false, error: "Bridge 未启动，启动后再看工具清单" };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /* ---------------- 自定义工具 ---------------- */
  const custom = () => import(SRC("tools", "custom.js"));
  /** 保存后立刻生效：Bridge 在跑就重新注册并通知已连接的 AI 刷新工具清单 */
  async function reloadCustom() {
    if (!state.app) return null;
    const { installCustomTools } = await custom();
    const result = await installCustomTools(DATA_HOME, { cwd: state.roots[0] });
    state.app.server.notifyToolListChanged?.();
    return result;
  }
  ipcMain.handle("tools:custom-list", async () => {
    try {
      const { loadCustomToolSpecs, customToolsFile } = await custom();
      return { ok: true, specs: await loadCustomToolSpecs(DATA_HOME), file: customToolsFile(DATA_HOME) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("tools:custom-save", async (_event, payload) => {
    try {
      const { loadCustomToolSpecs, saveCustomToolSpecs, normalizeSpec, CUSTOM_SOURCE } = await custom();
      const spec = normalizeSpec(payload?.spec || {});
      const original = String(payload?.original || "");
      const specs = await loadCustomToolSpecs(DATA_HOME);
      if (specs.some(x => x.name === spec.name && x.name !== original)) throw new Error(`已经有叫 ${spec.name} 的自定义工具了`);
      const { listTools } = await import(SRC("core", "registry.js"));
      const clash = listTools().find(t => t.name === spec.name && t.source !== CUSTOM_SOURCE);
      if (clash) throw new Error(`${spec.name} 是内置工具的名字，换一个`);
      const index = specs.findIndex(x => x.name === (original || spec.name));
      if (index >= 0) specs[index] = spec; else specs.push(spec);
      await saveCustomToolSpecs(DATA_HOME, specs);
      const reload = await reloadCustom();
      pushLog({ kind: "custom-tools", text: `已保存自定义工具 ${spec.name}${reload ? "（已生效）" : "（启动 Bridge 后生效）"}`, level: "ok" });
      return { ok: true, specs, live: Boolean(reload), errors: reload?.errors ?? [] };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("tools:custom-remove", async (_event, name) => {
    try {
      const { loadCustomToolSpecs, saveCustomToolSpecs } = await custom();
      const specs = (await loadCustomToolSpecs(DATA_HOME)).filter(x => x.name !== name);
      await saveCustomToolSpecs(DATA_HOME, specs);
      await reloadCustom();
      return { ok: true, specs };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("tools:custom-toggle", async (_event, payload) => {
    try {
      const { loadCustomToolSpecs, saveCustomToolSpecs } = await custom();
      const specs = await loadCustomToolSpecs(DATA_HOME);
      const spec = specs.find(x => x.name === payload?.name);
      if (!spec) throw new Error("没有这个工具");
      spec.enabled = Boolean(payload?.enabled);
      await saveCustomToolSpecs(DATA_HOME, specs);
      await reloadCustom();
      return { ok: true, specs };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  /** 试运行：不保存，直接按当前表单执行一次，把结果给界面看 */
  ipcMain.handle("tools:custom-test", async (_event, payload) => {
    try {
      const { normalizeSpec, buildCustomTool } = await custom();
      const tool = buildCustomTool(normalizeSpec(payload?.spec || {}), { cwd: state.roots[0] });
      const started = Date.now();
      const result = await tool.handler(payload?.args || {}, {});
      return { ok: true, isError: Boolean(result.isError), text: String(result.text ?? ""), ms: Date.now() - started };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  /* ---------------- 主题（让 Windows 标题栏、滚动条、右键菜单跟着变深色） ---------------- */
  ipcMain.handle("ui:set-theme", (_event, mode) => {
    if (["system", "light", "dark"].includes(mode)) nativeTheme.themeSource = mode;
    if (state.panel && !state.panel.isDestroyed()) {
      state.panel.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7");
      if (process.platform !== "darwin") { try { state.panel.setTitleBarOverlay(titleOverlay()); } catch { /* 老系统不支持就算了 */ } }
    }
    return { ok: true, dark: nativeTheme.shouldUseDarkColors };
  });

  /* ---------------- 命令审批 ---------------- */
  ipcMain.handle("approvals:list", () => ({ ok: true, items: state.app?.terminal?.listApprovals() ?? [] }));
  ipcMain.handle("approvals:approve", (_event, id) => (state.app ? state.app.terminal.approve(id) : { ok: false, error: "Bridge 未运行" }));
  ipcMain.handle("approvals:reject", (_event, id) => (state.app ? state.app.terminal.reject(id) : { ok: false, error: "Bridge 未运行" }));

  /* ---------------- 激活 ---------------- */
  const act = (fn) => async (_event, ...args) => {
    try { return { ok: true, ...(await fn(await activation(), ...args)) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  };
  ipcMain.handle("license:status", act(async (c) => ({ status: await c.status() })));
  ipcMain.handle("license:activate", act(async (c, code) => {
    const r = await c.activate(code);
    await activationSucceeded({ kindName: r.kindName, addedDays: r.addedDays, again: r.again });
    return r;
  }));
  ipcMain.handle("license:refresh", act(async (c) => { const status = await c.renew({ force: true }); void licenseStatus(); return { status }; }));

  /* 软件内支付宝购买：主界面自己 3 秒轮询；插件引导页走 purchaseForOnboarding 由主程序轮询并推回 */
  ipcMain.handle("license:plans", act(async (c) => ({ plans: (await c.plans())?.plans ?? [] })));
  ipcMain.handle("license:create-order", act(async (c, kind) => c.createOrder(String(kind ?? "").toUpperCase())));
  ipcMain.handle("license:poll-order", act(async (c, orderId) => {
    const result = await c.pollOrder(orderId);
    if (result.activated) await activationSucceeded({ kindName: KIND_NAMES[result.kind] ?? "", addedDays: result.addedDays ?? 0 });
    return result;
  }));

  const EXTERNAL_OK = /^https:\/\/([a-z0-9-]+\.)*(16688\.com\.cn|prodclub\.xyz|ngrok\.com|cloudflare\.com)(\/|$)/i;
  ipcMain.handle("account:open-external", (_event, url) => {
    // 只允许打开白名单里的网站（侧栏推广卡用到的小铺和 prodclub，教程里用到的 ngrok / Cloudflare）
    if (EXTERNAL_OK.test(String(url))) shell.openExternal(String(url));
  });

  /* ---------------- 隧道 ---------------- */
  ipcMain.handle("tunnel:start", async (_event, provider) => startTunnel(provider, "主界面按钮"));
  ipcMain.handle("tunnel:stop", async () => stopTunnel("主界面按钮"));
  ipcMain.handle("bridge:connect", async (_event, provider) => connectAll(provider, "主界面按钮"));
  ipcMain.handle("bridge:disconnect", async () => disconnectAll("主界面按钮"));

  ipcMain.handle("tunnel:probe", async (_event, provider) => {
    const { TunnelManager } = await import(SRC("core", "tunnel.js"));
    const probe = new TunnelManager({ localUrl: "http://127.0.0.1:1/mcp/x", dataHome: DATA_HOME, provider: provider || "cloudflare" });
    return { ok: true, result: await probe.probeClient() };
  });

  /* ---------------- 多开浏览器 ---------------- */
  ipcMain.handle("browser:list", async () => ({
    ok: true,
    profiles: await state.profiles.list(),
    openCount: state.profiles.openCount,
  }));

  ipcMain.handle("browser:create", async (_event, input) => {
    try {
      const profile = await state.profiles.create(input || {});
      pushLog({ kind: "browser", text: `新建窗口「${profile.name}」→ ${state.profiles.partitionOf(profile)}`, level: "ok" });
      return { ok: true, profile, profiles: await state.profiles.list() };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("browser:open", async (_event, payload) => {
    try {
      const { id, url } = payload || {};
      const result = await state.profiles.openWindow(id, { url });
      pushLog({ kind: "browser", text: `打开「${result.profile?.name ?? id}」${result.reused ? "（复用已有窗口）" : ""}`, level: "ok" });
      // 记下「最近活跃窗口」：Agent 调用上下文工具但没显式给 profileId 时，会回退到这个值
      await contextBus().then(bus => bus.setActiveProfile(id)).catch(() => {});
      return { ok: true, reused: result.reused, partition: result.partition, profiles: await state.profiles.list() };
    } catch (error) { return { ok: false, error: error.message, code: error.code ?? null }; }
  });

  ipcMain.handle("browser:quick-open", async (_event, payload) => {
    try {
      const key = typeof payload === "string" ? payload : (payload?.key || "");
      const result = await state.profiles.openQuickSite(key);
      pushLog({ kind: "browser", text: `一键打开「${result.profile.name}」`, level: "ok" });
      await contextBus().then(bus => bus.setActiveProfile(result.profile.id)).catch(() => {});
      return { ok: true, profile: result.profile, profiles: await state.profiles.list() };
    } catch (error) { return { ok: false, error: error.message, code: error.code ?? null }; }
  });

  ipcMain.handle("browser:sites", async () => ({ ok: true, sites: await state.profiles.listSites() }));
  ipcMain.handle("browser:site-add", async (_event, input) => {
    try {
      const site = await state.profiles.addSite(input || {});
      pushLog({ kind: "browser", text: `添加一键打开网站「${site.name}」→ ${site.url}`, level: "ok" });
      return { ok: true, site, sites: await state.profiles.listSites() };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("browser:site-remove", async (_event, key) => {
    try { await state.profiles.removeSite(String(key || "")); return { ok: true, sites: await state.profiles.listSites() }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("browser:close", async (_event, id) => {
    state.profiles.closeWindow(id);
    return { ok: true, profiles: await state.profiles.list() };
  });

  ipcMain.handle("browser:update", async (_event, payload) => {
    try {
      await state.profiles.update(payload?.id, payload?.patch || {});
      return { ok: true, profiles: await state.profiles.list() };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("browser:remove", async (_event, payload) => {
    try {
      const result = await state.profiles.remove(payload?.id, { purge: Boolean(payload?.purge) });
      pushLog({
        kind: "browser",
        text: `移除窗口「${result.profile.name}」${result.purged ? "（已清空该账号数据）" : "（磁盘数据保留）"}`,
        level: "warn",
      });
      return { ok: true, purged: result.purged, profiles: await state.profiles.list() };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("browser:cookies", async (_event, id) => {
    try { return { ok: true, ...(await state.profiles.cookieCount(id)) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("browser:navigate", async (_event, payload) => {
    try { return { ok: true, ...(await state.profiles.navigate(payload?.id, payload?.url)) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  /* ---------------- 系统 ---------------- */
  /**
   * 打开路径或网址。
   *
   * 两者用的 API 不一样：文件/目录用 openPath，网址必须用 openExternal
   * （openPath 拿网址会直接失败）。界面上「去拿令牌」这类按钮走的就是这里。
   */
  ipcMain.handle("sys:open-path", async (_event, target) => {
    const text = String(target || "").trim();
    if (!text) return { ok: false, error: "空的" };
    if (/^https?:\/\//i.test(text)) {
      await shell.openExternal(text);
      return { ok: true, external: true };
    }
    const result = await shell.openPath(text);
    return { ok: result === "", error: result || null };
  });

  /* ---------------- 让其他 AI 操作本软件 ---------------- */
  ipcMain.handle("aiclients:status", async () => {
    try {
      return {
        ok: true,
        cli: aiClients.cliStatus(DATA_HOME),
        clients: aiClients.clientsStatus(),
        config: aiClients.genericConfig(DATA_HOME),
        prompt: aiClients.promptText({
          publicMcpUrl: connectionStatus().publicMcpUrl,
          pathEnabled: state.app?.ownerAuth ? state.app.ownerAuth.pathEnabled() : true,
        }),
      };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("aiclients:install-cli", async () => {
    try {
      const cli = aiClients.installCli(DATA_HOME);
      pushLog({ kind: "app", text: `已安装命令行 windrise → ${cli.file}`, level: "ok" });
      return { ok: true, cli };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("aiclients:install", async (_event, key) => {
    try {
      const result = aiClients.installClient(String(key || ""), DATA_HOME);
      pushLog({ kind: "app", text: `已把本软件写入 ${result.name} 的 MCP 配置：${result.file}`, level: "ok" });
      return { ok: true, ...result, clients: aiClients.clientsStatus() };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle("sys:pick-folder", async (_event, opts) => {
    const result = await dialog.showOpenDialog(state.panel, { title: "选择要让 AI 访问的文件夹", buttonLabel: "添加这个文件夹", defaultPath: typeof opts?.defaultPath === "string" ? opts.defaultPath : undefined, properties: ["openDirectory", "createDirectory"] });
    return { ok: !result.canceled, path: result.filePaths?.[0] || null };
  });

  ipcMain.handle("sys:clipboard", async (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/* 只允许一个实例：再次打开 = 打开（或聚焦）格子 1 —— 托盘化之后没有主窗口可叫前台了 */
if (!process.env.WINDRISE_ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on("second-instance", () => {
  const plan = secondInstancePlan({ profilesReady: state.profilesReady });
  if (plan.action === "open") {
    void openWindrise().catch((error) => pushLog({ kind: "app", text: `打开 Windrise 失败：${error.message}`, level: "err" }));
  } else {
    state.wantGrid1 = true;
  }
});

// 全局兜底 UA：任何没单独设置 UA 的网页（包括网页弹出的子窗口）都不带 Electron 字样、不报过期的 Chrome 版本
try { app.userAgentFallback = require("./browser-profiles.cjs").cleanUserAgent(app.userAgentFallback); } catch {}

app.whenReady().then(async () => {
  /*
   * 任务栏分组：每个 BrowserOS 格子窗口的 AppUserModelID 设成 Windrise 自己的
   * （com.windrise.bridge[.sandbox].grids），任务栏上所有格子合成一组，图标也是 Windrise 的；
   * RelaunchCommand 指向 Windrise 可执行文件 —— 用户把任务栏项固定后，点它 = 启动 Windrise。
   * 开格子后 5 秒内扫一次这个进程的窗口，之后每 30 秒扫一次（用户 Ctrl+N 新开的窗口也能归组）。
   */
  taskbarGrouping = createTaskbarGrouping({
    appId: `${APP_ID}${INSTANCE_LABEL ? ".sandbox" : ""}.grids`,
    relaunchCommand: autostart.plainLaunchCommand(),
    relaunchDisplayName: "Windrise",
    // 任务栏图标资源只认「exe 或 ico,序号」：打包后用自己的 exe，开发时用 build/windrise.ico
    relaunchIcon: app.isPackaged ? `${process.execPath},0` : `${path.join(__dirname, "..", "build", "windrise.ico")},0`,
    log: (text) => pushLog({ kind: "app", text }),
  });

  state.profiles = new BrowserProfileManager({
    dataHome: path.join(DATA_HOME, "browser"),
    // 账号格子摆在哪：给 nearBounds 就找那块屏幕，不给就用主显示器；用的是工作区（不含任务栏）
    getWorkArea: (nearBounds) => {
      try {
        const display = nearBounds
          ? screen.getDisplayMatching({
            x: Number(nearBounds.x ?? nearBounds.left) || 0,
            y: Number(nearBounds.y ?? nearBounds.top) || 0,
            width: Math.max(1, Number(nearBounds.width) || 1),
            height: Math.max(1, Number(nearBounds.height) || 1),
          })
          : screen.getPrimaryDisplay();
        return display.workArea;
      } catch {
        return screen.getPrimaryDisplay().workArea;
      }
    },
    onEvent: (event) => {
      pushLog({ kind: "browser", text: `${event.kind}${event.name ? " " + event.name : ""}${event.id ? " [" + event.id + "]" : ""}` });
      // 新开出来的格子：5 秒后扫一次它的窗口，设任务栏分组
      if (event?.kind === "window-opened" && /^\d{1,10}$/.test(String(event?.pid ?? ""))) taskbarGrouping.watchWindow(String(event.pid));
      // 格子名单变了：托盘「所有格子」子菜单要跟着重建
      if (event?.kind === "profile-created" || event?.kind === "profile-removed") updateTray();
    },
    // 插件侧边栏 / 新标签页的状态：每次推的都是这只格子自己的编号 + 全局只读状态
    getPanelState: (self) => getPanelState(self),
    // 插件里点「管理口令」/ 引导页点「打开设置」：打开主程序设置页，可带要跳到的页
    showSettings: (tab) => showSettingsPage(tab),
    // 引导页动作（初次设置 8 步）
    tunnelConnect: () => tunnelConnectFromGrid(),
    // 引导页「购买」：下单和轮询都在主程序做，二维码 / 状态只推回发起这一单的引导页
    payOrder: (kind, deliver) => purchaseForOnboarding(kind, deliver),
    generateOwnerKey: () => {
      const owner = state.app?.ownerAuth;
      if (!owner) return { ok: false, error: "Bridge 还没启动，先打通隧道或启动 Bridge 后再生成口令" };
      // 新生成一把加进现有口令（不影响已在用的）；key 是口令明文，只随返回值交给
      // browseros-profiles 推回引导页那一次：不 pushLog、不 sendPanel、不进面板状态
      const result = owner.addKey("初次设置生成");
      return { ok: true, key: result.key };
    },
    setToolTier: (tier) => {
      const next = tier === "full" ? "full" : "basic";
      settings.save({ toolTier: next });
      pushLog({ kind: "app", text: `工具档位已切到「${next === "full" ? "完整" : "基础"}」档（重启 Bridge 后生效）` });
      return { ok: true };
    },
    setOnboardingDone: () => {
      settings.save({ onboardingDone: true });
      pushLog({ kind: "app", text: "初次设置引导已完成（侧边栏底部可重新打开）" });
      return { ok: true };
    },
    // 「新装的插件自动装到所有格子」开关：读 / 写设置（默认开）
    getExtAutoSync: () => settings.all().extAutoSync !== false,
    setExtAutoSync: (value) => {
      settings.save({ extAutoSync: Boolean(value) });
      pushLog({ kind: "app", text: `「新装的插件自动装到所有格子」已${value ? "打开" : "关闭"}` });
    },
  });
  await state.profiles.load();
  // 账号管理器就绪：second-instance 如果在就绪前到过，这里补开格子 1
  state.profilesReady = true;
  if (state.wantGrid1) {
    state.wantGrid1 = false;
    void openWindrise().catch((error) => pushLog({ kind: "app", text: `打开 Windrise 失败：${error.message}`, level: "err" }));
  }

  // 连接器存储：设置页和 Bridge 共用这一份。文件读坏了会自动当空表，不影响启动。
  const { ConnectorStore } = await import(SRC("core", "connectors.js"));
  state.connectors = new ConnectorStore({ file: path.join(DATA_HOME, "connectors.json") });
  wireConnectorEvents(state.connectors);

  // 交接审计出口：Bridge 活着就写它自己的 call-log（同一份日志，type=handoff|return|approval）；
  // Bridge 没启动时用同一套 createCallLog 直接写 <数据目录>/logs，保证事件不丢。
  let handoffAuditLog = null;
  const recordHandoffAudit = (event) => {
    const live = state.app?.server?.callLog;
    if (live) {
      void Promise.resolve(live.record({ event })).catch(() => {});
      return;
    }
    handoffAuditLog ??= import(SRC("core", "call-log.js"))
      .then(({ createCallLog }) => createCallLog({ dir: path.join(DATA_HOME, "logs") }))
      .catch(() => null);
    void handoffAuditLog.then((log) => log?.record({ event })).catch(() => {});
  };

  // 浏览器控制服务：让外部 Agent 能操作这些窗口
  state.browserControl = new BrowserControlServer({
    manager: state.profiles,
    // 用户 2026-10-26 定：只有点控制条「接管 / 终止任务」才算人接管，挪鼠标、打字都不算
    autoTakeoverOnInput: false,
    allowEval: ALLOW_EVAL,
    // AI 把空间交给用户：托盘日志 + 系统通知，两样都走现有机制
    onNotify: (note) => {
      pushLog({ kind: "handoff", text: `${note.title}：${note.body}`, level: "warn" });
      if (!Notification.isSupported()) return;
      try {
        new Notification({ title: note.title, body: note.body, icon: ASSET("icon-256.png") }).show();
      } catch (error) {
        pushLog({ kind: "handoff", text: `交接通知没弹出来（已记日志）：${error.message}`, level: "warn" });
      }
    },
    // 控制权交接 / 审批的一等审计事件
    onAudit: (event) => recordHandoffAudit(event),
    // 软件本身也能被控制：命令行 windrise、其他 AI 的 windrise_* 工具都走这里
    appHandler: createAppControl({
      app, state, dialog, APP_NAME, DATA_HOME,
      // app-control 本身不知道是谁触发的（命令行 windrise / 其他 AI 的 windrise_* 工具），统一记这个来源
      connectionStatus,
      publicCheckSnapshot,
      // windrise_status 里的「激活」行：只给摘要，不给激活码 / 设备密钥 / 许可证
      licenseStatus: async () => state.license ?? await licenseStatus(),
      connectAll: (provider) => connectAll(provider, "AI 工具或命令行"),
      stopTunnel: () => stopTunnel("AI 工具或命令行"),
      startBridge, setRoots, pushLog, contextBus,
      showPanel: (tab) => { showPanel(); if (tab && state.panel && !state.panel.isDestroyed()) state.panel.webContents.send("panel:goto", tab); },
    }),
    onLog: (line) => pushLog({ kind: "browser-control", text: line }),
    // 上传文件只能放进用户授权过的目录：这里给的是实时读取（运行中改工作区立即生效，不用重启）
    getWorkspaceRoots: () => (Array.isArray(state.roots) ? [...state.roots] : []),
    // 设置里的「显示 AI 光标和控制条」（默认开）：关掉后覆盖层不画，但防伪造和 TASK_STOPPED 逻辑照常
    getAgentCursorEnabled: () => settings.all().showAgentCursor !== false,
    // AI 空间空闲多久自动收摊（5 / 10 / 30 / 0=永不）：实时读设置，改完不用重启
    getIdleMinutes: () => settings.all().idleMinutes,
    // 内存闸门：系统可用物理内存（字节）。Electron 的 process.getSystemMemoryInfo 给的是 KB，
    // Windows 上的 free 就是「可用物理内存」（GlobalMemoryStatusEx 的 ullAvailPhys）
    getAvailableMemoryBytes: () => {
      try {
        const info = process.getSystemMemoryInfo?.();
        const free = Number(info?.free);
        return Number.isFinite(free) && free > 0 ? free * 1024 : null;
      } catch {
        return null;
      }
    },
  });
  await state.browserControl.start().catch((error) => {
    pushLog({ kind: "browser-control", text: `控制服务启动失败：${error.message}`, level: "err" });
  });

  registerIpc();
  registerContextIpc();
  registerConnectorsIpc();
  registerOwnerAuthIpc();
  registerSettingsIpc();
  registerMemosIpc();
  registerUpdateIpc();
  registerCloudflareIpc();
  registerClientIpc();
  // 托盘化：启动不再弹主窗口。管理窗口只从托盘「设置与教程」或格子侧边栏「设置」打开（showPanel 里按需建）。
  createTray();
  // 每 30 秒扫一遍开着的格子进程，把新窗口（用户 Ctrl+N 开的）也归进 Windrise 任务栏分组
  taskbarGrouping.startLoop(() => {
    try {
      return state.profiles?.backend?.entries?.().map((entry) => entry.handle?.pid).filter((pid) => Number.isInteger(pid)) ?? [];
    } catch {
      return [];
    }
  });
  /*
   * 睡眠唤醒 / 解锁：网卡可能换了、隧道连接可能已经半死，而 cloudflared 自己发现不了
   * （docs/research/bridge-disconnect-2026-10-24.md）。醒来先给隧道 5 秒自己恢复的机会，
   * 然后再过 10 秒从公网实测一次；解锁只实测，不重连。
   * 定时器都 unref，不挡退出。
   */
  powerMonitor.on("resume", () => {
    pushLog({ kind: "app", text: "电脑从睡眠中醒来" });
    const wake = setTimeout(() => {
      const tunnel = state.tunnel;
      try {
        const info = tunnel ? tunnel.status() : null;
        // 一键连接正在启动、没有隧道、或者隧道进程没在跑也没在重启：跳过 noteWake / reconnect，
        // 不和 start() 抢同一个进程；后面那次 10 秒补测照常做。
        const busy = state.connecting || !tunnel || (info?.state !== "running" && !info?.restarting);
        if (!busy && typeof tunnel.noteWake === "function") {
          // noteWake 由 tunnel.js 的另一个任务提供：内部判断要不要换线路
          Promise.resolve(tunnel.noteWake()).catch((error) => pushLog({ kind: "tunnel", text: `唤醒后检查隧道失败：${error.message}`, level: "warn" }));
        } else if (!busy && typeof tunnel.reconnect === "function") {
          Promise.resolve(tunnel.reconnect("电脑刚从睡眠中醒来")).catch((error) => pushLog({ kind: "tunnel", text: `唤醒后重连失败：${error.message}`, level: "warn" }));
        }
      } catch (error) {
        pushLog({ kind: "tunnel", text: `唤醒后检查隧道失败：${error.message}`, level: "warn" });
      }
      // 再过 10 秒（醒来 15 秒后）从公网实测一次：给隧道留出自己恢复的时间
      const check = setTimeout(() => { void checkPublicNow(); }, 10_000);
      check.unref?.();
    }, 5000);
    wake.unref?.();
  });
  powerMonitor.on("unlock-screen", () => { void checkPublicNow(); });
  // 状态轮询：隧道是否打通只能从子进程日志得知，轻量轮询比层层回调可靠（只在变化时才推送）
  setInterval(() => { void refreshStatus(); }, 700).unref?.();
  if (MIGRATION?.from?.length) pushLog({ kind: "app", text: `已把旧数据复制到软件目录：${DATA_HOME}（原数据未删除）`, level: "ok" });
  if (MIGRATION?.error) pushLog({ kind: "app", text: `旧数据迁移失败：${MIGRATION.error}`, level: "err" });
  pushLog({ kind: "app", text: `数据目录：${DATA_HOME}` });
  if (SEEDED) pushLog({ kind: "app", text: "首次运行：已载入预置设置（固定地址等）", level: "ok" });

  // 设置里的根目录和选项要生效（之前这些只存在于内存，重启就没了）
  // MemOS：4b 存在 settings 里的旧 Key 迁到外部 MCP 配置，保证只有一处
  await migrateLegacyMemosKey();
  // 老版本默认「危险命令需确认」且非白名单命令一律卡审批 —— 迁移一次：改成命令自动执行
  if (!settings.all().approvalAutoV2) settings.save({ approveDangerous: false, approvalAutoV2: true });
  // 老版本这个开关没接到桥上、实际一直是 JSON：默认改 SSE 时迁移一次；之后用户手动打开 JSON 会保留
  if (!settings.all().responseModeV2) settings.save({ jsonResponse: false, responseModeV2: true });
  // 还没选过连接方式、但已经配好固定地址的老用户：直接用固定地址并自动连接（之后可随时换别的方式）
  {
    const s0 = settings.all();
    if (!s0.connectChoiceDone && s0.tunnel.hostname && (s0.tunnel.token || s0.tunnel.tunnelId)) {
      settings.save({ connectChoice: "cloudflare-named", connectChoiceDone: true, autoConnect: true, autoStartBridge: true });
    }
  }
  const saved = settings.all();
  if (saved.roots.length) state.roots = saved.roots;
  state.options = {
    approve: saved.approveDangerous,
    readonlyAuto: saved.autoAllowReadonly,
    jsonResponse: saved.jsonResponse,
  };

  pushLog({
    kind: "app",
    text: `后台已就绪（托盘常驻）。浏览器工具${state.browserControl?.info().running ? "已就绪" : "未就绪"}${ALLOW_EVAL ? "（eval 已开启）" : ""}`,
    level: "ok",
  });

  // 开机自启自愈：设置里是开着的，但系统里的启动项丢了 / 指向旧位置 / 还缺 --autostart 标记（老版本写法）就重新写一次
  if (saved.autoLaunch) {
    autostart.isEnabled().then(async (on) => {
      if (!on) return autostart.setEnabled(true);
      // 老版本写的启动命令没有 --autostart：开机自启时会被当成用户手动打开，弹浏览器。补写一次。
      try {
        const now = await autostart.current();
        if (now && now !== autostart.launchCommand()) return autostart.setEnabled(true);
      } catch { /* 读不到就不动 */ }
      return null;
    }).catch(() => {});
  }

  // 托盘「开机启动」勾选状态（读一次，之后 toggle 时更新）
  autostart.isEnabled().then((on) => {
    state.autostartEnabled = Boolean(on);
    updateTray();
  }).catch(() => {});

  // 自动启动：起 Bridge，必要时连隧道。失败只记日志，绝不挡托盘。
  autoStart().catch((error) => pushLog({ kind: "app", text: `自动启动异常：${error.message}`, level: "err" }));

  // 激活：先把本地摘要读出来（面板 / 界面要用），再开始定时巡检（巡检间隔带随机抖动，不好预测）
  licenseStatus().catch(() => {});
  startLicensePatrol();
  // 价目：引导页的购买按钮要显示价格；拿不到就按「暂未开放」处理
  void refreshPayPlans();
  setInterval(() => { void refreshPayPlans(); }, 10 * 60_000).unref?.();

  // 托盘化第 3 步：启动完成后自动打开格子 1（没有格子账号就按命名规则建一个，启动地址 Google）。
  // 开机自启时不自动开格子（openGridOnAutostart 默认关），只留后台 + 托盘，免得一开机就弹浏览器。
  if (shouldOpenGridOnStart(saved, { autostart: autostart.wasAutostart() })) {
    pushLog({ kind: "app", text: "按设置自动打开格子 1" });
    void openWindrise().catch((error) => pushLog({ kind: "app", text: `自动打开格子 1 失败：${error.message}`, level: "err" }));
  } else {
    pushLog({ kind: "app", text: autostart.wasAutostart() ? "开机自启：按设置不自动打开格子（只留托盘）" : "按设置不自动打开格子 1（只留托盘）" });
  }

  try { startUpdater(); } catch (error) { pushLog({ kind: "app", text: `更新模块启动失败：${error.message}`, level: "err" }); }

  app.on("activate", () => showPanel());
});

async function shutdown() {
  taskbarGrouping?.stop();
  state.profiles?.closeAll();
  if (state.browserControl) await state.browserControl.stop().catch(() => {});
  if (state.contextBusInstance) await state.contextBusInstance.dispose().catch(() => {});
  // 先停隧道再清公网实测：退出过程中也不让状态闪回「已连接」
  if (state.tunnel) await state.tunnel.stop().catch(() => {});
  if (state.app) await state.app.stop().catch(() => {});
  stopPublicCheck();
  await appLog.flush().catch(() => {});
}

app.on("before-quit", () => { state.quitting = true; });

/*
 * 退出时一定要先停隧道再走：app.quit() 不会触发 window-all-closed，
 * 之前从托盘「退出」时 cloudflared 会留在后台成孤儿进程（下次启动又起一个，两个抢同一条隧道）。
 */
let shutdownDone = false;
app.on("will-quit", (event) => {
  if (shutdownDone) return;
  event.preventDefault();
  const timer = setTimeout(() => { shutdownDone = true; app.quit(); }, 5000);
  shutdown().catch(() => {}).finally(() => { clearTimeout(timer); shutdownDone = true; app.quit(); });
});
// 兜底：进程无论怎么退出，都把隧道子进程带走
process.on("exit", () => { try { state.tunnel?.child?.kill(); } catch { /* 忽略 */ } });

app.on("window-all-closed", () => {
  // macOS：窗口关了程序照常在菜单栏跑（隧道不断）；其他系统和以前一样，窗口真关了就退出（缩到托盘是隐藏，不会走到这里）
  if (process.platform === "darwin") return;
  app.quit();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    app.quit();
  });
}
